/**
 * @fileoverview Open Topo Data point elevations from the dataset stack
 * `srtm30m,mapzen`: up to 100 points per POST, paced to the public instance's
 * published limits (or freely on a self-hosted instance), retried, and
 * classified per point into a hit or a coverage miss.
 * @module services/opentopodata/opentopodata-client
 */

import type { Context } from '@cyanheads/mcp-ts-core';
import {
  configurationError,
  internalError,
  JsonRpcErrorCode,
  McpError,
  rateLimited,
  serviceUnavailable,
} from '@cyanheads/mcp-ts-core/errors';
import {
  createPacer,
  defaultIsTransient,
  httpErrorFromResponse,
  type Pacer,
  withRetry,
} from '@cyanheads/mcp-ts-core/utils';
import type {
  Dataset,
  LatLon,
  ProviderCallOptions,
  ProviderLookup,
} from '@/services/elevation/types.js';
import { isPlausibleElevation } from '@/services/elevation/units.js';
import {
  discardBody,
  logUpstreamText,
  readBoundedText,
  runTimedAttempt,
  USER_AGENT,
} from '@/services/shared/http-attempt.js';

const PUBLIC_HOST = 'api.opentopodata.org';
const DATASET_STACK = 'srtm30m,mapzen';
const SERVICE = 'Open Topo Data';
const ATTEMPT_TIMEOUT_MS = 15_000;
/** Observed 14.9 KB at 100 locations. */
const MAX_BODY_BYTES = 64 * 1024;
const MAX_ERROR_BODY_BYTES = 4 * 1024;
/** A location echo farther than this from the sent coordinate marks the response mis-shaped. */
const LOCATION_TOLERANCE_DEG = 1e-6;
/** SRTM GL1's ground spacing: 1 arc-second of latitude. */
const SRTM_RESOLUTION_M = 30.9;
const DAILY_REQUEST_LIMIT = 1_000;
/** The longest `Retry-After`, in seconds, reported to a caller: the daily window's length. */
const MAX_RETRY_AFTER_S = 86_400;
/** 400 `error` texts that mean the instance lacks a dataset or caps locations under 100. */
const CONFIG_REJECTION_PREFIXES = ['Dataset', 'No valid dataset', 'Too many locations'];

/** True when `baseUrl` points at the public instance, which gets the published-limit pacers. */
export function isPublicOpenTopoDataInstance(baseUrl: string): boolean {
  return new URL(baseUrl).hostname === PUBLIC_HOST;
}

/**
 * Builds the request pacer for `baseUrl`. Public instance: one request in
 * flight, starts at least 1.1 s apart (a 10% margin under 1 call per second).
 * Self-hosted: 4 in flight, no rate windows. Both close a shared gate on 429.
 */
export function createOpenTopoDataPacer(baseUrl: string): Pacer {
  const cooldown = { baseMs: 2_000, maxMs: 30_000 };
  return isPublicOpenTopoDataInstance(baseUrl)
    ? createPacer({ name: 'opentopodata', maxConcurrent: 1, minStartGapMs: 1_100, cooldown })
    : createPacer({ name: 'opentopodata', maxConcurrent: 4, cooldown });
}

/**
 * Builds the public instance's daily pacer: 1,000 starts in any trailing 24
 * hours, refusing (never queueing) once the window is spent.
 */
export function createOpenTopoDataDailyPacer(): Pacer {
  return createPacer({
    name: 'opentopodata-daily',
    limits: [{ requests: DAILY_REQUEST_LIMIT, perMs: 86_400_000 }],
    maxQueueDepth: 0,
  });
}

/** Constructor options; every seam is injectable for tests. */
export interface OpenTopoDataClientOptions {
  /** Instance base URL; a trailing slash is stripped. */
  baseUrl: string;
  /** Defaults to {@link createOpenTopoDataDailyPacer} on the public instance and to none elsewhere. */
  dailyPacer?: Pacer;
  /** Fetch implementation; tests pass `createFetchMock(...).fetch`. */
  fetch: typeof globalThis.fetch;
  /** Defaults to {@link createOpenTopoDataPacer} for `baseUrl`. */
  pacer?: Pacer;
}

/** A request the daily pacer refused, carried out of the request pacer's task as a value. */
interface DailyLimitRefusal {
  kind: 'daily_limit';
  retryAfter: number;
}

/**
 * Queries Open Topo Data for up to 100 points per call (the sampler chunks).
 *
 * `lookup` resolves to one hit or miss per point, in order. Redirects are not
 * followed. It rejects with:
 * - `ServiceUnavailable`, `reason: 'opentopodata_unavailable'` after the ladder
 *   (5xx, network error, per-attempt timeout, unreadable or mis-shaped 200,
 *   whose problem the message names), or at once, `retryable: false`, for a
 *   2xx other than 200, a redirect from the public instance, or another
 *   status retrying cannot fix;
 * - `RateLimited`, `reason: 'opentopodata_rate_limited'` when 429s outlast the
 *   ladder or carry a `Retry-After` above 8 s (`data.retryAfter` in seconds
 *   when the header was sent and parses to at most a day);
 * - `RateLimited`, `reason: 'opentopodata_daily_limit'`, `retryable: false`,
 *   `data.retryAfter` (seconds) when the daily pacer refuses; nothing is sent;
 * - `ConfigurationError`, `reason: 'opentopodata_config_rejected'` on 401, 403,
 *   404, a redirect from a self-hosted instance, a 400 naming a missing dataset
 *   or a location cap under 100, or a 200 naming a dataset this server did not
 *   request;
 * - `InternalError` on any other 400 (a request this server built wrongly);
 * - the retry deadline or a request-pacer shed, unchanged, for the sampler;
 * - the abort reason, unchanged, when `signal` was aborted.
 */
export class OpenTopoDataClient {
  readonly #dailyPacer: Pacer | undefined;
  readonly #endpoint: string;
  readonly #fetch: typeof globalThis.fetch;
  readonly #pacer: Pacer;
  readonly #publicInstance: boolean;

  constructor(options: OpenTopoDataClientOptions) {
    const baseUrl = options.baseUrl.replace(/\/+$/, '');
    this.#endpoint = `${baseUrl}/v1/${DATASET_STACK}`;
    this.#fetch = options.fetch;
    this.#publicInstance = isPublicOpenTopoDataInstance(baseUrl);
    this.#pacer = options.pacer ?? createOpenTopoDataPacer(baseUrl);
    this.#dailyPacer =
      options.dailyPacer ?? (this.#publicInstance ? createOpenTopoDataDailyPacer() : undefined);
  }

  /** Looks up 1–100 points in one request; coordinates are sent at 6 decimals. */
  async lookup(
    points: readonly LatLon[],
    { budgetMs, ctx, signal }: ProviderCallOptions,
  ): Promise<ProviderLookup[]> {
    try {
      return await withRetry(
        async (attempt) => {
          const outcome = await this.#pacer.run(
            (runSignal) => this.#paced(points, runSignal, attempt.remainingMs, ctx),
            { signal: attempt.signal, maxWaitMs: attempt.remainingMs },
          );
          if (!Array.isArray(outcome)) throw dailyLimitError(outcome.retryAfter);
          return outcome;
        },
        {
          operation: 'OpenTopoDataClient.lookup',
          context: ctx,
          maxRetries: 2,
          baseDelayMs: 1_000,
          maxDelayMs: 8_000,
          deadlineMs: budgetMs,
          signal,
        },
      );
    } catch (error) {
      throw toOpenTopoDataError(error, signal);
    }
  }

  /**
   * Disposes both pacers (teardown only). A lookup queued behind either rejects
   * with `ServiceUnavailable`, `reason: 'opentopodata_unavailable'`,
   * `retryable: false`, and the pacer's `RequestCancelled` as `cause`.
   */
  dispose(): void {
    this.#pacer.dispose();
    this.#dailyPacer?.dispose();
  }

  /**
   * Runs inside the request pacer's task. The daily pacer's refusal is returned
   * as a value rather than thrown. Rethrown as is, the shed keeps
   * `reason: 'pacer_shed'`, which the sampler cannot tell from a request-pacer
   * shed and reports as `sampling_deadline_exceeded`; converted here and thrown,
   * the `opentopodata_daily_limit` error would close the request pacer's 429
   * cooldown gate, though no upstream answered.
   */
  async #paced(
    points: readonly LatLon[],
    signal: AbortSignal,
    remainingMs: number,
    ctx: Context,
  ): Promise<ProviderLookup[] | DailyLimitRefusal> {
    if (!this.#dailyPacer) return this.#attempt(points, signal, remainingMs, ctx);
    try {
      return await this.#dailyPacer.run(() => this.#attempt(points, signal, remainingMs, ctx), {
        signal,
      });
    } catch (error) {
      if (error instanceof McpError && error.data?.reason === 'pacer_shed') {
        const retryAfter = error.data.retryAfter;
        return { kind: 'daily_limit', retryAfter: typeof retryAfter === 'number' ? retryAfter : 0 };
      }
      throw error;
    }
  }

  #attempt(
    points: readonly LatLon[],
    signal: AbortSignal,
    remainingMs: number,
    ctx: Context,
  ): Promise<ProviderLookup[]> {
    const sent = points.map((point) => ({ lat: point.lat.toFixed(6), lon: point.lon.toFixed(6) }));
    const body = JSON.stringify({
      locations: sent.map((point) => `${point.lat},${point.lon}`).join('|'),
      interpolation: 'bilinear',
    });
    const fetchImpl = this.#fetch;

    return runTimedAttempt(
      async (attemptSignal) => {
        const response = await fetchImpl(this.#endpoint, {
          method: 'POST',
          headers: {
            Accept: 'application/json',
            'Content-Type': 'application/json',
            'User-Agent': USER_AGENT,
          },
          body,
          redirect: 'manual',
          signal: attemptSignal,
        });
        const { status } = response;
        if (status === 200) {
          const text = await readBoundedText(response, MAX_BODY_BYTES);
          return parseResults(text, sent, ctx);
        }
        if (status < 300) {
          await discardBody(response);
          throw unexpectedStatus(status, `${SERVICE} answered HTTP ${status} instead of 200.`);
        }
        if (status < 400) {
          await discardBody(response);
          throw this.#publicInstance
            ? unexpectedStatus(
                status,
                `${SERVICE} answered HTTP ${status}, a redirect this server does not follow.`,
              )
            : configRejected(
                status,
                `The ${SERVICE} instance answered HTTP ${status}, a redirect this server does not follow; set OPENTOPODATA_BASE_URL to the URL the instance redirects to.`,
              );
        }
        if (status === 400) throw await classifyBadRequest(response, ctx);
        if (status === 401 || status === 403 || status === 404) {
          await discardBody(response);
          throw configRejected(status);
        }
        const error = await httpErrorFromResponse(response, {
          service: SERVICE,
          captureBody: false,
        });
        await discardBody(response);
        throw error;
      },
      { service: SERVICE, signal, timeoutMs: Math.min(ATTEMPT_TIMEOUT_MS, remainingMs) },
    );
  }
}

/**
 * Parses a 200: `{ status: 'OK', results: [{ dataset, elevation, location: { lat, lng } }] }`,
 * one result per sent location in order, each echoing its coordinate. A null
 * or implausible (below the floor, above the ceiling) elevation is a miss, and
 * its `dataset` is ignored: the upstream names the last dataset whose bounds
 * held the point even when that dataset had no value. A hit naming a dataset
 * this server did not request means a misconfigured instance
 * (`opentopodata_config_rejected`, not retried); anything else is mis-shaped
 * and retried as transient. Upstream text reaches only the process log.
 */
function parseResults(
  text: string | undefined,
  sent: readonly { lat: string; lon: string }[],
  ctx: Context,
): ProviderLookup[] {
  if (text === undefined)
    throw unavailable(`${SERVICE} returned a response larger than ${MAX_BODY_BYTES} bytes.`);
  let parsed: unknown;
  try {
    parsed = JSON.parse(text);
  } catch (error) {
    logUpstreamText(ctx, 'Open Topo Data returned an unparseable 200 body', {
      kind: 'not_json',
      text,
    });
    throw unavailable(`${SERVICE} returned a response that is not JSON.`, error);
  }
  if (!isRecord(parsed) || parsed.status !== 'OK' || !Array.isArray(parsed.results)) {
    logUpstreamText(ctx, 'Open Topo Data returned a 200 without status OK and a results array', {
      kind: 'no_ok_status_or_results',
      text,
    });
    throw unavailable(`${SERVICE} returned a response without an OK status and a results list.`);
  }
  const { results } = parsed;
  if (results.length !== sent.length) {
    throw unavailable(
      `${SERVICE} returned a results list whose length (${results.length}) does not match the number of locations sent (${sent.length}).`,
    );
  }
  return sent.map((location, index): ProviderLookup => {
    const result: unknown = results[index];
    if (!isRecord(result) || !echoesLocation(result.location, location)) {
      throw unavailable(
        `${SERVICE} result ${index} does not match the location sent at that position.`,
      );
    }
    const { dataset, elevation } = result;
    if (elevation === null || (typeof elevation === 'number' && !isPlausibleElevation(elevation))) {
      return { kind: 'miss' };
    }
    if (typeof elevation !== 'number') {
      throw unavailable(`${SERVICE} result ${index} carries a non-numeric elevation.`);
    }
    if (typeof dataset !== 'string') {
      throw unavailable(`${SERVICE} result ${index} does not name the dataset that answered it.`);
    }
    if (dataset !== 'srtm30m' && dataset !== 'mapzen') {
      logUpstreamText(ctx, 'Open Topo Data named a dataset that was not requested', {
        index,
        kind: 'unrequested_dataset',
        text: dataset,
      });
      throw configRejected(
        200,
        `The ${SERVICE} instance answered with a dataset this server did not ask for (result ${index}; it requested ${DATASET_STACK}); check how the instance at OPENTOPODATA_BASE_URL defines those datasets.`,
      );
    }
    const answered: Dataset = dataset;
    return {
      kind: 'hit',
      value: {
        dataset: answered,
        elevation_m: elevation,
        ...(answered === 'srtm30m' && { resolution_m: SRTM_RESOLUTION_M }),
      },
    };
  });
}

function echoesLocation(echo: unknown, sent: { lat: string; lon: string }): boolean {
  if (!isRecord(echo)) return false;
  const { lat, lng } = echo;
  return (
    typeof lat === 'number' &&
    typeof lng === 'number' &&
    Math.abs(lat - Number(sent.lat)) <= LOCATION_TOLERANCE_DEG &&
    Math.abs(lng - Number(sent.lon)) <= LOCATION_TOLERANCE_DEG
  );
}

/**
 * A 400 names either an instance limitation the operator must fix (a missing
 * dataset, a location cap under 100) or a request this server built wrongly.
 * Neither is retried; the upstream text reaches only the process log, never
 * the caller.
 */
async function classifyBadRequest(response: Response, ctx: Context): Promise<McpError> {
  const text = await readBoundedText(response, MAX_ERROR_BODY_BYTES);
  let message: string | undefined;
  if (text !== undefined) {
    try {
      const parsed: unknown = JSON.parse(text);
      if (isRecord(parsed) && typeof parsed.error === 'string') message = parsed.error;
    } catch {
      // An unparseable 400 falls through to the request-built-wrongly branch.
    }
  }
  const instanceLimitation =
    message !== undefined && CONFIG_REJECTION_PREFIXES.some((prefix) => message.startsWith(prefix));
  logUpstreamText(ctx, 'Open Topo Data answered HTTP 400', {
    kind: instanceLimitation ? 'config_rejection' : 'request_rejected',
    text: message ?? text ?? '',
  });
  if (instanceLimitation) return configRejected(400);
  return internalError(
    `${SERVICE} rejected a request this server built (HTTP 400); this is a server bug.`,
    {
      status: 400,
      retryable: false,
    },
  );
}

/**
 * The instance cannot serve this server's requests: it refused them (400, 401,
 * 403, 404), or it answered 200 from a dataset this server did not request.
 * Only the operator can fix either, so neither is retried.
 */
function configRejected(
  status: number,
  message = `The ${SERVICE} instance refused this server's requests with HTTP ${status}; check OPENTOPODATA_BASE_URL and the instance's datasets and location limit.`,
): McpError {
  return configurationError(message, {
    reason: 'opentopodata_config_rejected',
    retryable: false,
    status,
  });
}

function dailyLimitError(retryAfter: number): McpError {
  return rateLimited(
    `This server has sent 1,000 requests to the public ${SERVICE} instance in the past 24 hours; no request was sent.`,
    { reason: 'opentopodata_daily_limit', retryable: false, retryAfter },
  );
}

/**
 * A transient failure inside the ladder; mapped to `opentopodata_unavailable`
 * if it outlasts it. `data.detail` carries the message through `withRetry`'s
 * exhausted-ladder wrapper so the final error can name the problem.
 */
function unavailable(message: string, cause?: unknown): McpError {
  return serviceUnavailable(
    message,
    { reason: 'opentopodata_unavailable', detail: message },
    cause === undefined ? undefined : { cause },
  );
}

/**
 * A status this server does not read as an answer: a 2xx other than 200, or a
 * redirect from the public instance. Retrying cannot change it, so it is not
 * retried; the message is this server's own, never the reason phrase.
 */
function unexpectedStatus(status: number, message: string): McpError {
  return serviceUnavailable(message, {
    reason: 'opentopodata_unavailable',
    retryable: false,
    status,
    detail: message,
  });
}

/**
 * A `Retry-After` header value in whole seconds: delta-seconds as given, an
 * HTTP-date as the seconds left until it (0 once past). Anything else, and any
 * value over a day (a digit run long enough to parse as `Infinity` included),
 * is undefined.
 */
function retryAfterSeconds(value: unknown): number | undefined {
  if (typeof value !== 'string') return;
  const seconds = /^\d+$/.test(value)
    ? Number(value)
    : Math.max(0, Math.ceil((Date.parse(value) - Date.now()) / 1_000));
  return seconds <= MAX_RETRY_AFTER_S ? seconds : undefined;
}

/**
 * Maps the error that ended the retry ladder. Cancellation, the retry deadline,
 * a request-pacer shed, and errors already carrying their final reason (config
 * rejection, daily limit, the built-wrongly 400) pass through; a 429 becomes
 * `opentopodata_rate_limited`; everything else `opentopodata_unavailable`. The
 * final error's data is built fresh, so the wrapper's `operation`, the
 * ladder's `detail`, and any upstream reason phrase or header never reach the
 * caller.
 */
function toOpenTopoDataError(error: unknown, signal: AbortSignal): unknown {
  if (signal.aborted) return error;
  if (error instanceof McpError) {
    const reason = error.data?.reason;
    if (
      reason === 'retry_deadline_exceeded' ||
      reason === 'pacer_shed' ||
      reason === 'opentopodata_config_rejected' ||
      reason === 'opentopodata_daily_limit'
    ) {
      return error;
    }
    if (error.code === JsonRpcErrorCode.InternalError && error.data?.status === 400) return error;
    if (error.code === JsonRpcErrorCode.RateLimited) {
      const retryAfter = retryAfterSeconds(error.data?.retryAfter);
      return rateLimited(
        `${SERVICE} rate-limited this server's requests (HTTP 429) for longer than this call's retries could wait.`,
        {
          reason: 'opentopodata_rate_limited',
          retryable: true,
          ...(retryAfter !== undefined && { retryAfter }),
        },
        { cause: error },
      );
    }
  }
  const data = error instanceof McpError ? error.data : undefined;
  const status = data?.status;
  return serviceUnavailable(
    typeof data?.detail === 'string'
      ? data.detail
      : typeof status === 'number'
        ? `${SERVICE} failed with HTTP ${status}.`
        : `${SERVICE} did not answer.`,
    {
      reason: 'opentopodata_unavailable',
      retryable: defaultIsTransient(error),
      ...(typeof status === 'number' && { status }),
    },
    { cause: error },
  );
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === 'object' && !Array.isArray(value);
}

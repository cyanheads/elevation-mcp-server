/**
 * @fileoverview USGS 3DEP point elevations through the Elevation Point Query
 * Service (EPQS): one point per request, paced, retried, and classified into a
 * hit or a coverage miss.
 * @module services/usgs-epqs/usgs-epqs-client
 */

import type { Context } from '@cyanheads/mcp-ts-core';
import { McpError, serviceUnavailable } from '@cyanheads/mcp-ts-core/errors';
import {
  createPacer,
  defaultIsTransient,
  httpErrorFromResponse,
  type Pacer,
  withRetry,
} from '@cyanheads/mcp-ts-core/utils';
import type {
  ElevationValue,
  LatLon,
  ProviderCallOptions,
  ProviderLookup,
} from '@/services/elevation/types.js';
import { ELEVATION_FLOOR_M, METERS_PER_DEGREE, roundTo } from '@/services/elevation/units.js';
import {
  discardBody,
  readBoundedText,
  runTimedAttempt,
  USER_AGENT,
} from '@/services/shared/http-attempt.js';

const EPQS_URL = 'https://epqs.nationalmap.gov/v1/json';
const SERVICE = 'USGS EPQS';
const ATTEMPT_TIMEOUT_MS = 10_000;
/** Largest observed body is 240 bytes. */
const MAX_BODY_BYTES = 16 * 1024;
const LOG_EXCERPT_CHARS = 200;

/** EPQS requests the production pacer keeps in flight, across every call. */
export const EPQS_MAX_CONCURRENT = 6;

/** EPQS requests the production pacer starts per second, across every call. */
export const EPQS_STARTS_PER_SECOND = 10;

/** Builds the production EPQS pacer: 6 in flight, 10 starts a second, 429 cooldown. */
function createEpqsPacer(): Pacer {
  return createPacer({
    name: 'usgs-epqs',
    maxConcurrent: EPQS_MAX_CONCURRENT,
    limits: [{ requests: EPQS_STARTS_PER_SECOND, perMs: 1_000 }],
    cooldown: { baseMs: 2_000, maxMs: 30_000 },
  });
}

/** Constructor options; every seam is injectable for tests. */
export interface UsgsEpqsClientOptions {
  /** Fetch implementation; tests pass `createFetchMock(...).fetch`. */
  fetch: typeof globalThis.fetch;
  /** Defaults to {@link createEpqsPacer}. */
  pacer?: Pacer;
}

/**
 * Queries EPQS for single points.
 *
 * `lookup` resolves to a hit or a miss. Redirects are not followed. It rejects with:
 * - `ServiceUnavailable`, `data.reason: 'usgs_unavailable'` once the retry
 *   ladder fails (`data.status` when an HTTP status was seen, `data.retryable`
 *   false for a 4xx this server should never have provoked, a redirect, or a
 *   2xx other than 200);
 * - the `withRetry` deadline (`Timeout`, `reason: 'retry_deadline_exceeded'`) or
 *   a pacer shed (`RateLimited`, `reason: 'pacer_shed'`), unchanged, for the
 *   sampler to normalize;
 * - the abort reason, unchanged, when `signal` was aborted.
 */
export class UsgsEpqsClient {
  readonly #fetch: typeof globalThis.fetch;
  readonly #pacer: Pacer;

  constructor(options: UsgsEpqsClientOptions) {
    this.#fetch = options.fetch;
    this.#pacer = options.pacer ?? createEpqsPacer();
  }

  /** Looks up one point; coordinates are sent at 6 decimals. */
  async lookup(
    point: LatLon,
    { budgetMs, ctx, signal }: ProviderCallOptions,
  ): Promise<ProviderLookup> {
    try {
      return await withRetry(
        (attempt) =>
          this.#pacer.run(
            (runSignal) => this.#attempt(point, runSignal, attempt.remainingMs, ctx),
            {
              signal: attempt.signal,
              maxWaitMs: attempt.remainingMs,
            },
          ),
        {
          operation: 'UsgsEpqsClient.lookup',
          context: ctx,
          maxRetries: 2,
          baseDelayMs: 500,
          maxDelayMs: 4_000,
          deadlineMs: budgetMs,
          signal,
        },
      );
    } catch (error) {
      throw toUsgsUnavailable(error, signal);
    }
  }

  /**
   * Disposes the pacer (teardown only). A lookup queued behind it rejects with
   * `ServiceUnavailable`, `reason: 'usgs_unavailable'`, `retryable: false`, and
   * the pacer's `RequestCancelled` as `cause`.
   */
  dispose(): void {
    this.#pacer.dispose();
  }

  #attempt(
    point: LatLon,
    signal: AbortSignal,
    remainingMs: number,
    ctx: Context,
  ): Promise<ProviderLookup> {
    const url = new URL(EPQS_URL);
    url.search = new URLSearchParams({
      x: point.lon.toFixed(6),
      y: point.lat.toFixed(6),
      wkid: '4326',
      units: 'Meters',
      includeDate: 'true',
    }).toString();
    const fetchImpl = this.#fetch;

    return runTimedAttempt(
      async (attemptSignal) => {
        const response = await fetchImpl(url, {
          headers: { Accept: 'application/json', 'User-Agent': USER_AGENT },
          redirect: 'manual',
          signal: attemptSignal,
        });
        if (response.status !== 200) {
          const error = await httpErrorFromResponse(response, {
            service: SERVICE,
            captureBody: false,
          });
          await discardBody(response);
          throw error;
        }
        const body = await readBoundedText(response, MAX_BODY_BYTES);
        return classifyEpqsBody(body, point, ctx);
      },
      { service: SERVICE, signal, timeoutMs: Math.min(ATTEMPT_TIMEOUT_MS, remainingMs) },
    );
  }
}

/**
 * Classifies a 200 body. A hit is a JSON object whose `value` is a finite
 * number or numeric string at or above the plausibility floor; anything else
 * (EPQS's plain-text miss bodies, the no-data sentinel, a body over the
 * ceiling) is a miss. Miss text is logged at debug and never returned.
 */
function classifyEpqsBody(body: string | undefined, point: LatLon, ctx: Context): ProviderLookup {
  if (body === undefined) {
    ctx.log.debug('EPQS body exceeded the read ceiling; treating the point as a miss', {
      lat: point.lat,
      lon: point.lon,
      maxBytes: MAX_BODY_BYTES,
    });
    return { kind: 'miss' };
  }
  const parsed = parseJsonObject(body);
  const elevation = parsed ? readNumeric(parsed.value) : undefined;
  if (parsed === undefined || elevation === undefined || elevation < ELEVATION_FLOOR_M) {
    ctx.log.debug('EPQS returned no value for the point', {
      lat: point.lat,
      lon: point.lon,
      body: body.slice(0, LOG_EXCERPT_CHARS),
    });
    return { kind: 'miss' };
  }

  const resolution =
    typeof parsed.resolution === 'number' ? normalizeResolution(parsed.resolution) : undefined;
  const rasterId = parsed.rasterId;
  const attributes = parsed.attributes;
  const acquisitionDate =
    attributes !== null && typeof attributes === 'object' && 'AcquisitionDate' in attributes
      ? attributes.AcquisitionDate
      : undefined;

  const value: ElevationValue = {
    dataset: 'usgs_3dep',
    elevation_m: elevation,
    ...(resolution !== undefined && { resolution_m: resolution }),
    ...(typeof rasterId === 'number' && Number.isInteger(rasterId) && { raster_id: rasterId }),
    ...(typeof acquisitionDate === 'string' &&
      acquisitionDate !== '' && { acquisition_date: acquisitionDate }),
  };
  return { kind: 'hit', value };
}

/**
 * EPQS reports `resolution` in the raster's native unit: meters for projected
 * lidar rasters (observed 1, 5), degrees for the arc-second seamless rasters.
 * Between the two bands the unit is unknown, so the figure is omitted.
 */
function normalizeResolution(resolution: number): number | undefined {
  if (!Number.isFinite(resolution) || resolution <= 0) return;
  if (resolution >= 0.5) return roundTo(resolution, 1);
  if (resolution < 0.01) return roundTo(resolution * METERS_PER_DEGREE, 1);
  return;
}

function parseJsonObject(text: string): Record<string, unknown> | undefined {
  try {
    const parsed: unknown = JSON.parse(text);
    return parsed !== null && typeof parsed === 'object' && !Array.isArray(parsed)
      ? (parsed as Record<string, unknown>)
      : undefined;
  } catch {
    return;
  }
}

/** A finite number, or a non-blank string that parses to one. */
function readNumeric(value: unknown): number | undefined {
  if (typeof value === 'number') return Number.isFinite(value) ? value : undefined;
  if (typeof value !== 'string' || value.trim() === '') return;
  const parsed = Number(value);
  return Number.isFinite(parsed) ? parsed : undefined;
}

/**
 * Maps the error that ended the retry ladder. Cancellation, the retry deadline,
 * and a pacer shed pass through for the sampler; everything else is
 * `usgs_unavailable`, with this server's own message (no upstream text).
 */
function toUsgsUnavailable(error: unknown, signal: AbortSignal): unknown {
  if (signal.aborted) return error;
  if (error instanceof McpError) {
    const reason = error.data?.reason;
    if (reason === 'retry_deadline_exceeded' || reason === 'pacer_shed') return error;
  }
  const status = error instanceof McpError ? error.data?.status : undefined;
  return serviceUnavailable(
    typeof status === 'number'
      ? `USGS 3DEP (EPQS) failed with HTTP ${status}.`
      : 'USGS 3DEP (EPQS) did not answer.',
    {
      reason: 'usgs_unavailable',
      retryable: defaultIsTransient(error),
      ...(typeof status === 'number' && { status }),
    },
    { cause: error },
  );
}

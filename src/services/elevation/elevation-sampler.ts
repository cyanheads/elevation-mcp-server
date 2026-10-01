/**
 * @fileoverview Samples terrain elevation at a list of points: dedupes,
 * routes each point to USGS 3DEP or Open Topo Data, falls back on coverage
 * misses only, bounds each call's outstanding 3DEP lookups, enforces the
 * per-call budget, and normalizes failures. Also
 * holds the init/accessor/dispose lifecycle for the elevation services.
 * @module services/elevation/elevation-sampler
 */

import type { Context } from '@cyanheads/mcp-ts-core';
import { McpError, timeout } from '@cyanheads/mcp-ts-core/errors';
import type { ServerConfig } from '@/config/server-config.js';
import { OpenTopoDataClient } from '@/services/opentopodata/opentopodata-client.js';
import { EPQS_MAX_CONCURRENT, UsgsEpqsClient } from '@/services/usgs-epqs/usgs-epqs-client.js';
import type { Dataset, ElevationValue, LatLon, Sample, SourceMode } from './types.js';
import { roundTo } from './units.js';

/** One tool call's sampling budget: inside a 60 s client request timeout. */
export const SAMPLING_BUDGET_MS = 45_000;

/** Open Topo Data's per-request location limit. */
export const OPENTOPODATA_CHUNK_SIZE = 100;

/**
 * EPQS lookups one call keeps outstanding, the next submitted as one settles.
 * The EPQS pacer is shared by every call and serves its queue in order, so a
 * call that queued all its lookups at once would hold a later call behind every
 * one of them. Equal to the pacer's in-flight ceiling, so a call running alone
 * still fills every slot.
 */
const EPQS_CALL_WINDOW = EPQS_MAX_CONCURRENT;

/** An upstream provider, named by the `source` value that selects it alone. */
type Provider = Exclude<SourceMode, 'auto'>;

const PROVIDER_NAMES: Readonly<Record<Provider, string>> = {
  usgs_3dep: 'USGS 3DEP',
  opentopodata: 'Open Topo Data',
};

interface Box {
  east: number;
  north: number;
  south: number;
  west: number;
}

/**
 * Conservative USGS 3DEP coverage envelope for `auto` mode: a point outside
 * every box has no 3DEP raster, while a point inside may still miss. Edges
 * inclusive; every edge was checked against live points.
 */
export const COVERAGE_ENVELOPE: readonly Box[] = [
  // North America: CONUS, Alaska east of 180°, Hawaii, Puerto Rico, USVI, Canada, Mexico.
  { south: 5, north: 84, west: -180, east: -50 },
  // Western Aleutians (Attu).
  { south: 50, north: 56, west: 170, east: 180 },
  // Mariana Islands and Wake (Guam, Saipan).
  { south: 10, north: 21, west: 144, east: 167 },
  // American Samoa (Pago Pago).
  { south: -15, north: -10, west: -172, east: -168 },
];

/** True when the point lies inside at least one coverage-envelope box. */
export function insideCoverageEnvelope({ lat, lon }: LatLon): boolean {
  return COVERAGE_ENVELOPE.some(
    (box) => lat >= box.south && lat <= box.north && lon >= box.west && lon <= box.east,
  );
}

/** Constructor options; every seam is injectable for tests. */
export interface ElevationSamplerOptions {
  /** Per-call budget in ms; defaults to {@link SAMPLING_BUDGET_MS}. */
  budgetMs?: number;
  epqs: UsgsEpqsClient;
  /** Clock for the deadline arithmetic; defaults to `Date.now`. */
  now?: () => number;
  openTopoData: OpenTopoDataClient;
}

/**
 * Samples elevations for the tools.
 *
 * `sample(points, mode, ctx)` resolves to one {@link Sample} per input point,
 * in input order. A coverage miss in every queried dataset is a sample with
 * only `lat`/`lon` (no data), never an error. It rejects, aborting any
 * outstanding upstream requests first, with:
 * - `usgs_unavailable`, `opentopodata_unavailable`, `opentopodata_rate_limited`,
 *   `opentopodata_daily_limit`, `opentopodata_config_rejected` from the clients,
 *   unchanged (`data.reason` set);
 * - `Timeout`, `reason: 'sampling_deadline_exceeded'` when the budget ran out
 *   in a retry ladder or a provider queue (cause chained), with `data.provider`
 *   (`usgs_3dep` or `opentopodata`) naming the phase it ran out in;
 * - `InternalError` for an Open Topo Data 400 this server provoked;
 * - the abort reason, unchanged, when `ctx.signal` was aborted.
 */
export class ElevationSampler {
  readonly #budgetMs: number;
  readonly #epqs: UsgsEpqsClient;
  readonly #now: () => number;
  readonly #openTopoData: OpenTopoDataClient;

  constructor(options: ElevationSamplerOptions) {
    this.#epqs = options.epqs;
    this.#openTopoData = options.openTopoData;
    this.#now = options.now ?? Date.now;
    this.#budgetMs = options.budgetMs ?? SAMPLING_BUDGET_MS;
  }

  async sample(points: readonly LatLon[], mode: SourceMode, ctx: Context): Promise<Sample[]> {
    const startedAt = this.#now();
    const deadlineAt = startedAt + this.#budgetMs;
    const remainingMs = () => Math.max(0, deadlineAt - this.#now());

    const { entries, byInput } = dedupe(points);
    const failFast = new AbortController();
    const signal = AbortSignal.any([ctx.signal, failFast.signal]);
    let waitingOn: Provider = 'usgs_3dep';
    const stats = {
      epqsHits: 0,
      epqsMisses: 0,
      outsideEnvelope: 0,
      openTopoDataRequests: 0,
      openTopoDataPoints: 0,
    };

    try {
      // Phase 1: USGS 3DEP. In auto mode only points inside the envelope are queried.
      const epqsEntries: Entry[] = [];
      for (const entry of entries) {
        if (mode === 'opentopodata') {
          entry.needsOpenTopoData = true;
        } else if (mode === 'usgs_3dep' || insideCoverageEnvelope(entry.point)) {
          epqsEntries.push(entry);
        } else {
          stats.outsideEnvelope++;
          entry.needsOpenTopoData = true;
        }
      }
      await forEachWindowed(epqsEntries, EPQS_CALL_WINDOW, async (entry) => {
        const result = await this.#epqs.lookup(entry.point, {
          ctx,
          signal,
          budgetMs: remainingMs(),
        });
        if (result.kind === 'hit') {
          stats.epqsHits++;
          entry.answer = result.value;
        } else {
          stats.epqsMisses++;
          if (mode === 'auto') entry.needsOpenTopoData = true;
        }
      });

      // Phase 2: Open Topo Data for out-of-envelope points and 3DEP misses, in input order.
      const openTopoDataEntries = entries.filter((entry) => entry.needsOpenTopoData);
      if (openTopoDataEntries.length > 0) {
        if (remainingMs() === 0) throw this.#deadlineExceeded(startedAt, waitingOn);
        waitingOn = 'opentopodata';
        const chunks = chunk(openTopoDataEntries, OPENTOPODATA_CHUNK_SIZE);
        stats.openTopoDataRequests = chunks.length;
        stats.openTopoDataPoints = openTopoDataEntries.length;
        await Promise.all(
          chunks.map(async (batch) => {
            const results = await this.#openTopoData.lookup(
              batch.map((entry) => entry.point),
              { ctx, signal, budgetMs: remainingMs() },
            );
            batch.forEach((entry, offset) => {
              const result = results[offset];
              if (result?.kind === 'hit') entry.answer = result.value;
            });
          }),
        );
      }
    } catch (error) {
      failFast.abort();
      if (ctx.signal.aborted) throw error;
      if (isBudgetExpiry(error)) throw this.#deadlineExceeded(startedAt, waitingOn, error);
      throw error;
    }

    ctx.log.info('Elevation sampling complete', {
      mode,
      inputPoints: points.length,
      uniquePoints: entries.length,
      ...stats,
      answersByDataset: countByDataset(entries),
      elapsedMs: this.#now() - startedAt,
    });
    return byInput.map(toSample);
  }

  #deadlineExceeded(startedAt: number, provider: Provider, cause?: unknown): McpError {
    const elapsedMs = this.#now() - startedAt;
    return timeout(
      `Elevation sampling ran out of its ${this.#budgetMs / 1_000} s budget after ${elapsedMs} ms, waiting on ${PROVIDER_NAMES[provider]}.`,
      { reason: 'sampling_deadline_exceeded', budgetMs: this.#budgetMs, elapsedMs, provider },
      cause === undefined ? undefined : { cause },
    );
  }
}

/** One unique (6-decimal) coordinate and what the providers said about it. */
interface Entry {
  answer?: ElevationValue;
  needsOpenTopoData: boolean;
  point: LatLon;
}

/**
 * Rounds coordinates to 6 decimals and dedupes. `entries` holds each unique
 * point once, in first-seen order; `byInput[i]` is the entry for input point i.
 */
function dedupe(points: readonly LatLon[]): { byInput: Entry[]; entries: Entry[] } {
  const entries: Entry[] = [];
  const byKey = new Map<string, Entry>();
  const byInput = points.map((point) => {
    const rounded = { lat: roundTo(point.lat, 6), lon: roundTo(point.lon, 6) };
    const key = `${rounded.lat},${rounded.lon}`;
    let entry = byKey.get(key);
    if (!entry) {
      entry = { point: rounded, needsOpenTopoData: false };
      entries.push(entry);
      byKey.set(key, entry);
    }
    return entry;
  });
  return { entries, byInput };
}

/**
 * Runs `task` over `items` in order with at most `limit` running, starting the
 * next item as one settles. Rejects with the first failure.
 */
async function forEachWindowed<T>(
  items: readonly T[],
  limit: number,
  task: (item: T) => Promise<void>,
): Promise<void> {
  let next = 0;
  const worker = async () => {
    while (next < items.length) await task(items[next++] as T);
  };
  await Promise.all(Array.from({ length: Math.min(limit, items.length) }, worker));
}

function chunk<T>(items: readonly T[], size: number): T[][] {
  const chunks: T[][] = [];
  for (let start = 0; start < items.length; start += size)
    chunks.push(items.slice(start, start + size));
  return chunks;
}

/** A retry-ladder deadline or a request-pacer shed: both mean the call's budget ran out. */
function isBudgetExpiry(error: unknown): boolean {
  if (!(error instanceof McpError)) return false;
  const reason = error.data?.reason;
  return reason === 'retry_deadline_exceeded' || reason === 'pacer_shed';
}

/** Rounds an entry's answer to output precision; a point with no answer carries only its coordinates. */
function toSample({ point, answer }: Entry): Sample {
  if (!answer) return { lat: point.lat, lon: point.lon };
  return {
    lat: point.lat,
    lon: point.lon,
    elevation_m: roundTo(answer.elevation_m, 2),
    dataset: answer.dataset,
    ...(answer.resolution_m !== undefined && { resolution_m: roundTo(answer.resolution_m, 1) }),
    ...(answer.raster_id !== undefined && { raster_id: answer.raster_id }),
    ...(answer.acquisition_date !== undefined && { acquisition_date: answer.acquisition_date }),
  };
}

function countByDataset(entries: readonly Entry[]): Partial<Record<Dataset, number>> {
  const counts: Partial<Record<Dataset, number>> = {};
  for (const { answer } of entries) {
    if (answer) counts[answer.dataset] = (counts[answer.dataset] ?? 0) + 1;
  }
  return counts;
}

// --- Init / accessor / dispose ---

interface ElevationServices {
  epqs: UsgsEpqsClient;
  openTopoData: OpenTopoDataClient;
  sampler: ElevationSampler;
}

let _services: ElevationServices | undefined;

/**
 * Builds both provider clients (with their production pacers) and the sampler.
 * Called from `createApp({ setup })`; `fetch` is the handler-level test seam.
 */
export function initElevationServices(
  config: ServerConfig,
  { fetch = globalThis.fetch }: { fetch?: typeof globalThis.fetch } = {},
): void {
  const epqs = new UsgsEpqsClient({ fetch });
  const openTopoData = new OpenTopoDataClient({ fetch, baseUrl: config.openTopoDataBaseUrl });
  _services = { epqs, openTopoData, sampler: new ElevationSampler({ epqs, openTopoData }) };
}

/** The sampler built by {@link initElevationServices}. */
export function getElevationSampler(): ElevationSampler {
  if (!_services) {
    throw new Error('Elevation services not initialized; call initElevationServices() in setup().');
  }
  return _services.sampler;
}

/** Disposes every pacer. Called from `createApp({ teardown })`. */
export function disposeElevationServices(): void {
  _services?.epqs.dispose();
  _services?.openTopoData.dispose();
  _services = undefined;
}

/**
 * @fileoverview USGS 3DEP ImageServer batch sampling and raster catalog dates.
 * @module services/usgs-epqs/usgs-image-server
 */

import { createPacer } from '@cyanheads/mcp-ts-core/utils';
import type { ElevationValue, LatLon, ProviderCallOptions } from '@/services/elevation/types.js';
import { roundTo } from '@/services/elevation/units.js';
import { discardBody, readBoundedText, USER_AGENT } from '@/services/shared/http-attempt.js';
import { readUsgsValue } from './usgs-value.js';

const IMAGE_SERVER =
  'https://elevation.nationalmap.gov/arcgis/rest/services/3DEPElevation/ImageServer';
const SAMPLE_CHUNK_SIZE = 50;
const SAMPLE_CALL_WINDOW = 2;
const SAMPLE_PHASE_MS = 10_000;
const CATALOG_PHASE_MS = 4_000;
/** Both operations return only requested sample rows or two attributes per raster. */
const MAX_BODY_BYTES = 64 * 1024;

/** Queries the shared USGS ImageServer, with four active requests across calls. */
export class UsgsImageServer {
  readonly #pacer = createPacer({ name: 'usgs-image-server', maxConcurrent: 4 });
  readonly #fetch: typeof globalThis.fetch;

  constructor(fetch: typeof globalThis.fetch) {
    this.#fetch = fetch;
  }

  /** Returns usable elevations indexed by input offset after all submitted requests settle. */
  async sample(
    points: readonly LatLon[],
    options: ProviderCallOptions,
  ): Promise<ReadonlyMap<number, ElevationValue>> {
    const hits = new Map<number, ElevationValue>();
    if (points.length === 0 || options.budgetMs <= 0) return hits;

    await this.#withinPhase(options, SAMPLE_PHASE_MS, async (signal, deadlineAt, stop) => {
      let next = 0;
      const worker = async () => {
        try {
          while (next < points.length && !signal.aborted && Date.now() < deadlineAt) {
            const offset = next;
            next += SAMPLE_CHUNK_SIZE;
            const batch = points.slice(offset, next);
            const body = new URLSearchParams({
              f: 'json',
              geometry: JSON.stringify({
                points: batch.map(({ lon, lat }) => [lon, lat]),
                spatialReference: { wkid: 4326 },
              }),
              geometryType: 'esriGeometryMultipoint',
              interpolation: 'RSP_NearestNeighbor',
              returnFirstValueOnly: 'true',
            });
            const response = await this.#request('getSamples', body, signal, deadlineAt);
            for (const [index, value] of batchHits(response?.samples, batch)) {
              hits.set(offset + index, value);
            }
          }
        } catch (error) {
          if (signal.aborted) return;
          stop.abort(error);
          throw error;
        }
      };

      const workerCount = Math.min(
        SAMPLE_CALL_WINDOW,
        Math.ceil(points.length / SAMPLE_CHUNK_SIZE),
      );
      const outcomes = await Promise.allSettled(Array.from({ length: workerCount }, worker));
      for (const outcome of outcomes) {
        if (outcome.status === 'rejected') throw outcome.reason;
      }
    });
    return hits;
  }

  /** Queries the catalog once and returns UTC dates for the requested raster IDs that have them. */
  async acquisitionDates(
    ids: ReadonlySet<number>,
    options: ProviderCallOptions,
  ): Promise<ReadonlyMap<number, string>> {
    const dates = new Map<number, string>();
    if (ids.size === 0 || options.budgetMs <= 0) return dates;

    await this.#withinPhase(options, CATALOG_PHASE_MS, async (signal, deadlineAt) => {
      const body = new URLSearchParams({
        f: 'json',
        objectIds: [...ids].join(','),
        outFields: 'OBJECTID,AcquisitionDate',
        returnGeometry: 'false',
      });
      const response = await this.#request('query', body, signal, deadlineAt);
      if (!Array.isArray(response?.features)) return;
      const seen = new Set<number>();
      for (const feature of response.features) {
        const attributes = asObject(asObject(feature)?.attributes);
        if (!attributes) continue;
        const id = attributes.OBJECTID;
        if (typeof id !== 'number' || !ids.has(id)) continue;
        if (seen.has(id)) {
          dates.delete(id);
          continue;
        }
        seen.add(id);
        const date = utcDate(attributes.AcquisitionDate);
        if (date !== undefined) dates.set(id, date);
      }
    });
    return dates;
  }

  /** Releases queued work at teardown. */
  dispose(): void {
    this.#pacer.dispose();
  }

  async #withinPhase(
    { budgetMs, ctx, signal }: ProviderCallOptions,
    limitMs: number,
    run: (phaseSignal: AbortSignal, deadlineAt: number, stop: AbortController) => Promise<void>,
  ): Promise<void> {
    signal.throwIfAborted();
    const stop = new AbortController();
    const deadline = new DOMException('USGS ImageServer phase timed out.', 'TimeoutError');
    const durationMs = Math.min(limitMs, budgetMs);
    const deadlineAt = Date.now() + durationMs;
    const timer = setTimeout(() => stop.abort(deadline), durationMs);
    try {
      await run(AbortSignal.any([signal, stop.signal]), deadlineAt, stop);
      signal.throwIfAborted();
    } catch (error) {
      signal.throwIfAborted();
      if (error !== deadline) throw error;
    } finally {
      clearTimeout(timer);
    }
    if (stop.signal.reason === deadline) ctx.log.debug(deadline.message);
  }

  #request(
    operation: 'getSamples' | 'query',
    body: URLSearchParams,
    signal: AbortSignal,
    deadlineAt: number,
  ): Promise<Record<string, unknown> | undefined> {
    return this.#pacer.run(
      async (runSignal) => {
        // A slot can open before an already-due phase timer runs.
        runSignal.throwIfAborted();
        if (Date.now() >= deadlineAt) return;
        let text: string | undefined;
        try {
          const response = await this.#fetch(`${IMAGE_SERVER}/${operation}`, {
            body,
            headers: { Accept: 'application/json', 'User-Agent': USER_AGENT },
            method: 'POST',
            redirect: 'manual',
            signal: runSignal,
          });
          if (response.status !== 200) {
            await discardBody(response);
            return;
          }
          text = await readBoundedText(response, MAX_BODY_BYTES, runSignal);
        } catch (error) {
          runSignal.throwIfAborted();
          if (isNetworkFailure(error)) return;
          throw error;
        }
        if (text === undefined || Date.now() >= deadlineAt) return;
        try {
          const parsed = asObject(JSON.parse(text));
          return parsed && !Object.hasOwn(parsed, 'error') ? parsed : undefined;
        } catch (error) {
          if (error instanceof SyntaxError) return;
          throw error;
        }
      },
      { signal },
    );
  }
}

function batchHits(rows: unknown, batch: readonly LatLon[]): Map<number, ElevationValue> {
  const hits = new Map<number, ElevationValue>();
  if (!Array.isArray(rows)) return hits;
  const seen = new Set<number>();
  for (const raw of rows) {
    const row = asObject(raw);
    if (!row) continue;
    const index = row.locationId;
    if (typeof index !== 'number' || !Number.isInteger(index) || index < 0) continue;
    const point = batch[index];
    if (point === undefined) continue;
    if (seen.has(index)) {
      hits.delete(index);
      continue;
    }
    seen.add(index);
    const location = asObject(row.location);
    if (
      typeof location?.x !== 'number' ||
      typeof location.y !== 'number' ||
      roundTo(location.x, 6) !== point.lon ||
      roundTo(location.y, 6) !== point.lat
    )
      continue;
    const result = readUsgsValue(row);
    if (result.kind === 'hit') hits.set(index, result.value);
  }
  return hits;
}

function asObject(value: unknown): Record<string, unknown> | undefined {
  if (value !== null && typeof value === 'object' && !Array.isArray(value)) {
    return value as Record<string, unknown>;
  }
  return;
}

function utcDate(value: unknown): string | undefined {
  if (typeof value !== 'number' || !Number.isInteger(value)) return;
  const date = new Date(value);
  const year = date.getUTCFullYear();
  if (Number.isNaN(year) || year < 0 || year > 9999) return;
  return date.toISOString().slice(0, 10);
}

function isNetworkFailure(error: unknown): boolean {
  return (
    error instanceof TypeError ||
    (error instanceof DOMException && ['NetworkError', 'TimeoutError'].includes(error.name))
  );
}

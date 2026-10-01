/**
 * @fileoverview Domain types shared by the elevation providers, the sampler, and the tools.
 * @module services/elevation/types
 */

import type { Context } from '@cyanheads/mcp-ts-core';

/** The dataset that produced an elevation value. `usgs_3dep` comes from EPQS; the other two from Open Topo Data. */
export type Dataset = 'usgs_3dep' | 'srtm30m' | 'mapzen';

/** Every dataset id, in attribution order. */
export const DATASETS = ['usgs_3dep', 'srtm30m', 'mapzen'] as const satisfies readonly Dataset[];

/** Caller-selected routing: `auto` (3DEP first, Open Topo Data for the rest), or one provider only. */
export type SourceMode = 'auto' | 'usgs_3dep' | 'opentopodata';

/** Every source mode, in the order the `source` input advertises them. */
export const SOURCE_MODES = [
  'auto',
  'usgs_3dep',
  'opentopodata',
] as const satisfies readonly SourceMode[];

/** A WGS84 coordinate in decimal degrees. */
export interface LatLon {
  lat: number;
  lon: number;
}

/**
 * One provider answer. `elevation_m` is the raw upstream value in meters (not
 * rounded); `resolution_m` is omitted where the raster has no single figure
 * (Mapzen) or its unit is unknown.
 */
export interface ElevationValue {
  acquisition_date?: string;
  dataset: Dataset;
  elevation_m: number;
  raster_id?: number;
  resolution_m?: number;
}

/** A provider's per-point outcome: a value, or a coverage miss (no data, not an error). */
export type ProviderLookup = { kind: 'hit'; value: ElevationValue } | { kind: 'miss' };

/**
 * A sampled point as the sampler returns it, in input order. Coordinates are
 * rounded to 6 decimals, `elevation_m` to 2, `resolution_m` to 1. A point no
 * queried dataset answered carries only `lat` and `lon`.
 */
export interface Sample {
  acquisition_date?: string;
  dataset?: Dataset;
  elevation_m?: number;
  lat: number;
  lon: number;
  raster_id?: number;
  resolution_m?: number;
}

/** What the sampler hands a provider client for one lookup. */
export interface ProviderCallOptions {
  /** Milliseconds left in the call's sampling budget; bounds the retry ladder and queue waits. */
  budgetMs: number;
  /** Request context, for correlated logging. */
  ctx: Context;
  /** Aborts the lookup: the caller's cancellation, or the sampler failing fast. */
  signal: AbortSignal;
}

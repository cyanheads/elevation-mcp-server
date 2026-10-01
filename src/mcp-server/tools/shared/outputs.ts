/**
 * @fileoverview Output schemas shared by the computed tools (profile, grid,
 * line of sight), and the provenance summaries all four tools count from:
 * per-dataset counts and the range of source resolutions behind a result.
 * @module mcp-server/tools/shared/outputs
 */

import { z } from '@cyanheads/mcp-ts-core';
import { DATASETS, type Dataset } from '@/services/elevation/types.js';

/** Count of values each dataset answered. */
export const DatasetsUsedSchema = z
  .object({
    usgs_3dep: z.number().int().describe('Values answered by USGS 3DEP.'),
    srtm30m: z.number().int().describe('Values answered by SRTM via Open Topo Data.'),
    mapzen: z
      .number()
      .int()
      .describe('Values answered by Mapzen terrain tiles via Open Topo Data.'),
  })
  .describe('Number of values each dataset answered.');

export type DatasetsUsed = z.infer<typeof DatasetsUsedSchema>;

/** Smallest and largest source resolution behind a result. */
export const ResolutionRangeSchema = z
  .object({
    min_m: z.number().describe('Finest source resolution in meters.'),
    max_m: z.number().describe('Coarsest source resolution in meters.'),
  })
  .describe(
    'Range of source resolutions over values that report one; absent when none does (all Mapzen).',
  );

export type ResolutionRange = z.infer<typeof ResolutionRangeSchema>;

/** A value carrying optional provenance; `null` is a grid cell without data. */
type Provenanced = { dataset?: Dataset | undefined; resolution_m?: number | undefined } | null;

/** Per-dataset counts and the resolution range over values that report a resolution. */
export function summarizeProvenance(values: Iterable<Provenanced>): {
  datasets_used: DatasetsUsed;
  resolution_m_range?: ResolutionRange;
} {
  const datasets_used: DatasetsUsed = { usgs_3dep: 0, srtm30m: 0, mapzen: 0 };
  let range: ResolutionRange | undefined;
  for (const value of values) {
    if (value?.dataset) datasets_used[value.dataset]++;
    const resolution = value?.resolution_m;
    if (resolution === undefined) continue;
    range = range
      ? { min_m: Math.min(range.min_m, resolution), max_m: Math.max(range.max_m, resolution) }
      : { min_m: resolution, max_m: resolution };
  }
  return { datasets_used, ...(range && { resolution_m_range: range }) };
}

/** Values answered by USGS 3DEP and by Open Topo Data (SRTM plus Mapzen). */
export function providerSplit(used: DatasetsUsed): { openTopoData: number; usgs: number } {
  return { openTopoData: used.srtm30m + used.mapzen, usgs: used.usgs_3dep };
}

/** `usgs_3dep 12, srtm30m 0, mapzen 3`. */
export function formatDatasetsUsed(used: DatasetsUsed): string {
  return DATASETS.map((dataset) => `${dataset} ${used[dataset]}`).join(', ');
}

/** `1–10.3 m`, `30.9 m`, or `varies (Mapzen only)` when no value reports a resolution. */
export function formatResolutionRange(range: ResolutionRange | undefined): string {
  if (!range) return 'varies (Mapzen only)';
  return range.min_m === range.max_m ? `${range.min_m} m` : `${range.min_m}–${range.max_m} m`;
}

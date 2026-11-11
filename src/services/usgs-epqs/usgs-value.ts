/**
 * @fileoverview Shared decoding for elevation values returned by EPQS and the 3DEP ImageServer.
 * @module services/usgs-epqs/usgs-value
 */

import type { ElevationValue } from '@/services/elevation/types.js';
import { isPlausibleElevation, METERS_PER_DEGREE, roundTo } from '@/services/elevation/units.js';

/** Decodes a USGS sample and distinguishes the two reasons a value is unusable. */
export function readUsgsValue(
  row: Record<string, unknown>,
):
  | { kind: 'hit'; value: ElevationValue }
  | { kind: 'no_numeric_value' | 'outside_plausible_range' } {
  const elevation = readNumeric(row.value);
  if (elevation === undefined) return { kind: 'no_numeric_value' };
  if (!isPlausibleElevation(elevation)) return { kind: 'outside_plausible_range' };
  const resolution =
    typeof row.resolution === 'number' ? normalizeResolution(row.resolution) : undefined;
  const rasterId = row.rasterId;
  return {
    kind: 'hit',
    value: {
      dataset: 'usgs_3dep',
      elevation_m: elevation,
      ...(resolution !== undefined && { resolution_m: resolution }),
      ...(typeof rasterId === 'number' && Number.isInteger(rasterId) && { raster_id: rasterId }),
    },
  };
}

/**
 * USGS reports resolution in native units: meters for projected lidar rasters,
 * degrees for seamless arc-second rasters. The unit is unknown between those bands.
 */
function normalizeResolution(resolution: number): number | undefined {
  if (!Number.isFinite(resolution) || resolution <= 0) return;
  if (resolution >= 0.5) return roundTo(resolution, 1);
  if (resolution < 0.01) return roundTo(resolution * METERS_PER_DEGREE, 1);
  return;
}

function readNumeric(value: unknown): number | undefined {
  if (typeof value === 'number') return Number.isFinite(value) ? value : undefined;
  if (typeof value !== 'string' || value.trim() === '') return;
  const parsed = Number(value);
  return Number.isFinite(parsed) ? parsed : undefined;
}

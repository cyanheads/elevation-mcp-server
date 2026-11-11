/**
 * @fileoverview Server-level instructions sent on every `initialize`, built from config.
 * @module mcp-server/server-instructions
 */

import type { ServerConfig } from '@/config/server-config.js';
import { isPublicOpenTopoDataInstance } from '@/services/opentopodata/opentopodata-client.js';

const BASE_INSTRUCTIONS =
  "Terrain elevation and analysis from two keyless sources: USGS 3DEP for the US, its territories, and much of Canada and Mexico at 1–30 m, and Open Topo Data elsewhere: SRTM (about 30 m, land between 60°N and 56°S), then Mapzen terrain tiles (global, including high latitudes and the sea floor). Source auto uses 3DEP where it has data and Open Topo Data for the rest. Every elevation has a dataset (usgs_3dep, srtm30m, or mapzen). Results report available resolutions. Points are {lat, lon} objects in decimal degrees (WGS84); grids take south, west, north, and east edges. Elevations are meters, with feet in summaries. Use elevation_get_points for spot heights: submit 1–1,000 positions; only the first 100 are validated and sampled. Counts and next_offset disclose the unvalidated tail; continue with originalPoints.slice(next_offset) until null, where originalPoints is the array submitted in that call. Each next slice uses the newly submitted array. Use elevation_get_profile for route ascent, descent, and grades, elevation_get_grid for area high and low points, and elevation_check_line_of_sight for terrain clearance. Computed calls batch 3DEP samples and report spacing. Profile and sightline serve at most 250 samples. Check spacing before concluding a sightline is clear. Values below 0 m can be sea-floor depths rather than the water surface: Mapzen's over open water, and USGS 3DEP's where it carries bay bathymetry (San Francisco Bay, Mobile Bay); 3DEP also reports dry land below sea level. Results list sources and height-reference context without datum conversion. Available acquisition dates are UTC raster catalog dates (YYYY-MM-DD).";

const PUBLIC_INSTANCE_SENTENCE =
  "This server uses the public Open Topo Data instance, which allows 1,000 requests of up to 100 points per day from this server's address, so outside 3DEP coverage batch points into few calls.";

/**
 * The public-instance limits sentence is included only when
 * `OPENTOPODATA_BASE_URL` points at the public instance; it would misstate a
 * deployment pointed at its own instance.
 */
export function buildServerInstructions(config: Pick<ServerConfig, 'openTopoDataBaseUrl'>): string {
  return isPublicOpenTopoDataInstance(config.openTopoDataBaseUrl)
    ? `${BASE_INSTRUCTIONS} ${PUBLIC_INSTANCE_SENTENCE}`
    : BASE_INSTRUCTIONS;
}

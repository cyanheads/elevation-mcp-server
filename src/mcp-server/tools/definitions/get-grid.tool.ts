/**
 * @fileoverview `elevation_get_grid`: samples a regular node grid over a
 * bounding box and reports the highest and lowest nodes, the mean, and the
 * relief, plus the elevation matrix with per-cell provenance.
 * @module mcp-server/tools/definitions/get-grid
 */

import { tool, z } from '@cyanheads/mcp-ts-core';
import { JsonRpcErrorCode } from '@cyanheads/mcp-ts-core/errors';
import { agree, countOf } from '@/mcp-server/tools/shared/format.js';
import { blankAsUnset, SourceSchema } from '@/mcp-server/tools/shared/inputs.js';
import {
  DatasetsUsedSchema,
  formatDatasetsUsed,
  formatResolutionRange,
  providerSplit,
  ResolutionRangeSchema,
  summarizeProvenance,
} from '@/mcp-server/tools/shared/outputs.js';
import { attributionFor } from '@/services/elevation/attribution.js';
import { getElevationSampler } from '@/services/elevation/elevation-sampler.js';
import { gridNodes } from '@/services/elevation/geometry.js';
import { DATASETS, type Dataset, type Sample, SOURCE_MODES } from '@/services/elevation/types.js';
import { metersToFeet, roundTo } from '@/services/elevation/units.js';

const MAX_CELLS = 250;

/** One-letter provenance codes for the non-uniform dataset matrix. */
const DATASET_CODES: Readonly<Record<Dataset, string>> = {
  usgs_3dep: 'U',
  srtm30m: 'S',
  mapzen: 'M',
};

const GridPointSchema = z
  .object({
    lat: z.number().describe('Node latitude, decimal degrees.'),
    lon: z.number().describe('Node longitude, decimal degrees.'),
    row: z.number().int().describe('Row index, 0 = north edge.'),
    col: z.number().int().describe('Column index, 0 = west edge.'),
    elevation_m: z.number().describe('Elevation in meters.'),
    elevation_ft: z.number().describe('Elevation in international feet.'),
  })
  .describe('A grid node.');

type GridPoint = z.infer<typeof GridPointSchema>;

const gridDimension = (label: string) =>
  blankAsUnset(z.number().int().min(2).max(25).default(10)).describe(
    `Grid ${label}, edges included (2–25, default 10). rows × cols must be at most 250.`,
  );

export const getGridTool = tool('elevation_get_grid', {
  title: 'Get Elevation Grid',
  description:
    "Sample a regular grid of terrain elevations across a bounding box and report the highest and lowest sampled points, the mean elevation, and the relief, plus the full elevation matrix with each cell's dataset. Values are point samples at grid nodes (box edges included), not cell averages, so a summit between nodes is missed; to refine a candidate high or low point, call again with a smaller box around it. Over open water, Mapzen cells are sea-floor depths. Rows times columns may not exceed 250.",
  annotations: { readOnlyHint: true, idempotentHint: true, openWorldHint: true },
  auth: ['tool:elevation_get_grid:read'],
  input: z.object({
    south: z.number().min(-90).max(90).describe('Southern edge latitude, decimal degrees.'),
    west: z
      .number()
      .min(-180)
      .max(180)
      .describe(
        'Western edge longitude, decimal degrees. Must be less than east; a box crossing longitude 180 must be split into two calls.',
      ),
    north: z
      .number()
      .min(-90)
      .max(90)
      .describe('Northern edge latitude, decimal degrees. Must be greater than south.'),
    east: z.number().min(-180).max(180).describe('Eastern edge longitude, decimal degrees.'),
    rows: gridDimension('rows, north to south'),
    cols: gridDimension('columns, west to east'),
    source: SourceSchema,
  }),
  output: z.object({
    south: z.number().describe('Southern edge latitude, as requested.'),
    west: z.number().describe('Western edge longitude, as requested.'),
    north: z.number().describe('Northern edge latitude, as requested.'),
    east: z.number().describe('Eastern edge longitude, as requested.'),
    rows: z.number().int().describe('Node rows applied.'),
    cols: z.number().int().describe('Node columns applied.'),
    latitudes_deg: z
      .array(z.number().describe('Row latitude, decimal degrees.'))
      .describe('Latitude of each row, north to south; row 0 is the north edge.'),
    longitudes_deg: z
      .array(z.number().describe('Column longitude, decimal degrees.'))
      .describe('Longitude of each column, west to east; column 0 is the west edge.'),
    row_spacing_m: z.number().describe('North-south distance between node rows, meters.'),
    col_spacing_m: z
      .number()
      .describe("East-west distance between node columns at the box's center latitude, meters."),
    elevations_m: z
      .array(
        z
          .array(
            z
              .number()
              .nullable()
              .describe('Elevation in meters, or null where no queried dataset had data.'),
          )
          .describe('One row of nodes, west to east.'),
      )
      .describe('Elevation matrix indexed [row][col], rows north to south, columns west to east.'),
    cell_datasets: z
      .array(
        z
          .array(
            z
              .enum(DATASETS)
              .nullable()
              .describe('Dataset that answered this node, or null where none had data.'),
          )
          .describe('One row of nodes, west to east.'),
      )
      .describe('Provenance matrix with the same [row][col] indexing as elevations_m.'),
    summary: z
      .object({
        highest: GridPointSchema.describe('The highest node (first in row-major order on ties).'),
        lowest: GridPointSchema.describe('The lowest node (first in row-major order on ties).'),
        mean_elevation_m: z.number().describe('Arithmetic mean over nodes with data, meters.'),
        relief_m: z.number().describe('Highest minus lowest elevation, meters.'),
        relief_ft: z.number().describe('Highest minus lowest elevation, international feet.'),
      })
      .describe('Statistics over the nodes with data.'),
    cells_with_data: z.number().int().describe('Nodes with an elevation.'),
    missing_cells: z.number().int().describe('Nodes no queried dataset answered.'),
    datasets_used: DatasetsUsedSchema,
    resolution_m_range: ResolutionRangeSchema.optional(),
    source_mode: z
      .enum(SOURCE_MODES)
      .describe('The source the call used (auto unless the caller chose one).'),
  }),
  enrichment: {
    notice: z
      .string()
      .optional()
      .describe(
        'Guidance on nodes without data, boxes spanning the USGS 3DEP coverage edge, Mapzen sea-floor values, and node spacing against the source resolution.',
      ),
    attribution: z
      .string()
      .describe('Sources to credit for the returned values, one line per dataset that answered.'),
  },
  enrichmentTrailer: { attribution: { label: 'Sources' } },
  errors: [
    {
      reason: 'invalid_bbox',
      code: JsonRpcErrorCode.ValidationError,
      when: 'south is not below north, or west is not below east.',
      recovery:
        'Set south below north and west below east in decimal degrees; for a box crossing longitude 180, call elevation_get_grid twice, once on each side of the antimeridian.',
      severity: 'notice',
    },
    {
      reason: 'too_many_cells',
      code: JsonRpcErrorCode.ValidationError,
      when: 'rows × cols exceeds 250.',
      recovery:
        'Re-call elevation_get_grid with rows × cols at most 250, for example 15 × 15 or 10 × 25, or split the area into several boxes.',
      severity: 'notice',
    },
    {
      reason: 'no_coverage',
      code: JsonRpcErrorCode.NotFound,
      when: 'No grid node returned an elevation.',
      recovery:
        'No grid node returned an elevation. If the call used source usgs_3dep or opentopodata, re-call elevation_get_grid with source auto to query both providers; under auto, no dataset this server queries covers the box, so check a point inside it with elevation_get_points to confirm.',
      severity: 'notice',
    },
    {
      reason: 'usgs_unavailable',
      code: JsonRpcErrorCode.ServiceUnavailable,
      when: 'USGS 3DEP failed: a server error, rate limit, network error, or timeout that outlasted the retries (retryable), or a client error or unexpected status that retrying cannot fix (not retryable).',
      recovery:
        'USGS 3DEP did not answer or rejected the request. If the error is marked retryable, retry elevation_get_grid in a minute; either way, re-call it with source opentopodata to use SRTM and Mapzen data (about 30 m) instead.',
      thrownBy: 'service',
    },
    {
      reason: 'opentopodata_unavailable',
      code: JsonRpcErrorCode.ServiceUnavailable,
      when: 'Open Topo Data failed: a server error, network error, timeout, or unreadable response that outlasted the retries (retryable), or an unexpected status that retrying cannot fix (not retryable).',
      recovery:
        'Open Topo Data did not answer or rejected the request. If the error is marked retryable, retry elevation_get_grid in a minute; either way, re-call it with source usgs_3dep when the box lies inside USGS 3DEP coverage.',
      thrownBy: 'service',
    },
    {
      reason: 'opentopodata_rate_limited',
      code: JsonRpcErrorCode.RateLimited,
      when: 'Open Topo Data kept answering HTTP 429 through the retries, or asked for a wait over 8 s.',
      recovery:
        "Open Topo Data is refusing this server's requests as rate limited. The public instance allows 1 request per second and 1,000 per day per network address, shared with any other client at that address; a self-hosted instance sets its own limits. Retry elevation_get_grid in a few minutes, or re-call it with source usgs_3dep for boxes inside USGS 3DEP coverage.",
      retryable: true,
      severity: 'warning',
      thrownBy: 'service',
    },
    {
      reason: 'opentopodata_daily_limit',
      code: JsonRpcErrorCode.RateLimited,
      when: 'Only on the public Open Topo Data instance: this server has sent it 1,000 requests in the trailing 24 hours, so no request was sent.',
      recovery:
        "This server has used the public Open Topo Data instance's 1,000 requests for the past 24 hours; capacity returns as those requests age out (see retryAfter). Re-call elevation_get_grid with source usgs_3dep for boxes inside USGS 3DEP coverage, or ask the server operator to set OPENTOPODATA_BASE_URL to a self-hosted Open Topo Data instance.",
      retryable: false,
      severity: 'warning',
      thrownBy: 'service',
    },
    {
      reason: 'opentopodata_config_rejected',
      code: JsonRpcErrorCode.ConfigurationError,
      when: 'The Open Topo Data instance answered 401, 403, or 404, a 400 naming a dataset it lacks or a location limit below 100, or a 200 naming a dataset this server did not request.',
      recovery:
        "The Open Topo Data instance at OPENTOPODATA_BASE_URL cannot serve this server's requests (wrong URL, a missing or misconfigured srtm30m or mapzen dataset, or a per-request location limit under 100), which the server operator must fix. Meanwhile re-call elevation_get_grid with source usgs_3dep for boxes inside USGS 3DEP coverage.",
      retryable: false,
      thrownBy: 'service',
    },
    {
      reason: 'sampling_deadline_exceeded',
      code: JsonRpcErrorCode.Timeout,
      when: "The call's 45 s sampling budget ran out (a retry deadline, or a wait in either provider's request queue).",
      recovery:
        'If the budget ran out waiting on USGS 3DEP, re-call elevation_get_grid with fewer rows or columns, since each 3DEP cell is its own upstream request; if it ran out waiting on Open Topo Data, retry in a minute, or re-call it with source usgs_3dep for a box inside USGS 3DEP coverage.',
      thrownBy: 'service',
    },
  ],

  async handler(input, ctx) {
    const { south, west, north, east, rows, cols } = input;
    if (south >= north || west >= east) {
      const problems = [
        ...(south >= north ? [`south (${south}) is not below north (${north})`] : []),
        ...(west >= east ? [`west (${west}) is not below east (${east})`] : []),
      ];
      throw ctx.fail('invalid_bbox', `Invalid bounding box: ${problems.join(' and ')}.`, {
        south,
        west,
        north,
        east,
      });
    }
    const cells = rows * cols;
    if (cells > MAX_CELLS) {
      throw ctx.fail(
        'too_many_cells',
        `rows × cols is ${rows} × ${cols} = ${cells}; the limit is ${MAX_CELLS}.`,
        { rows, cols, cells },
      );
    }

    const grid = gridNodes({ south, west, north, east }, rows, cols);
    const sampled = await getElevationSampler().sample(grid.nodes, input.source, ctx);
    ctx.enrich({ attribution: attributionFor(sampled) });

    const elevations_m: (number | null)[][] = [];
    const cell_datasets: (Dataset | null)[][] = [];
    let highest: GridPoint | undefined;
    let lowest: GridPoint | undefined;
    let sum = 0;
    let withData = 0;
    for (let row = 0; row < rows; row++) {
      const rowSamples = sampled.slice(row * cols, (row + 1) * cols);
      elevations_m.push(rowSamples.map((sample) => sample.elevation_m ?? null));
      cell_datasets.push(rowSamples.map((sample) => sample.dataset ?? null));
      for (const [col, sample] of rowSamples.entries()) {
        const point = toGridPoint(sample, row, col);
        if (!point) continue;
        withData++;
        sum += point.elevation_m;
        if (!highest || point.elevation_m > highest.elevation_m) highest = point;
        if (!lowest || point.elevation_m < lowest.elevation_m) lowest = point;
      }
    }
    if (!highest || !lowest) {
      throw ctx.fail(
        'no_coverage',
        `None of the ${cells} grid nodes returned an elevation (source: ${input.source}).`,
      );
    }

    const relief = roundTo(highest.elevation_m - lowest.elevation_m, 2);
    const result = {
      south,
      west,
      north,
      east,
      rows,
      cols,
      latitudes_deg: grid.latitudes_deg.map((lat) => roundTo(lat, 6)),
      longitudes_deg: grid.longitudes_deg.map((lon) => roundTo(lon, 6)),
      row_spacing_m: roundTo(grid.row_spacing_m, 1),
      col_spacing_m: roundTo(grid.col_spacing_m, 1),
      elevations_m,
      cell_datasets,
      summary: {
        highest,
        lowest,
        mean_elevation_m: roundTo(sum / withData, 2),
        relief_m: relief,
        relief_ft: metersToFeet(relief),
      },
      cells_with_data: withData,
      missing_cells: cells - withData,
      ...summarizeProvenance(sampled),
      source_mode: input.source,
    };

    const fragments: string[] = [];
    const missing = result.missing_cells;
    if (missing > 0) {
      const reroute =
        input.source === 'auto'
          ? ''
          : ` Re-call elevation_get_grid with source auto to query both providers for the ${agree(missing, 'cell', 'cells')} without data.`;
      fragments.push(
        `${missing} of ${countOf(cells, 'cell')} ${agree(missing, 'has', 'have')} no data (null); summary values cover only cells with data.${reroute}`,
      );
    }
    const { usgs, openTopoData } = providerSplit(result.datasets_used);
    if (usgs > 0 && openTopoData > 0) {
      fragments.push(
        `The box spans the USGS 3DEP coverage edge (${countOf(usgs, 'cell')} from USGS 3DEP, ${openTopoData} from Open Topo Data); the highest and lowest points compare values of different resolution and surface model.`,
      );
    }
    const seaFloor = sampled.filter(
      (sample) => sample.dataset === 'mapzen' && (sample.elevation_m ?? 0) < 0,
    ).length;
    if (seaFloor > 0) {
      fragments.push(
        `${countOf(seaFloor, 'cell')} ${agree(seaFloor, 'comes', 'come')} from Mapzen with values below 0 m, which over open water are sea-floor depths; summary.lowest and the mean include them.`,
      );
    }
    const range = result.resolution_m_range;
    const spacing = Math.max(result.row_spacing_m, result.col_spacing_m);
    if (range && spacing > 20 * range.min_m) {
      fragments.push(
        `Nodes are about ${roundTo(spacing, 0)} m apart against a ${range.min_m} m source, so peaks and pits between nodes are missed; re-grid a smaller box around summary.highest to refine it.`,
      );
    }
    if (fragments.length > 0) ctx.enrich.notice(fragments.join(' '));

    return result;
  },

  format: (result) => {
    const summary = result.summary;
    const describeNode = (node: GridPoint) =>
      `${node.elevation_m} m (${node.elevation_ft} ft) at row ${node.row}, col ${node.col} (${node.lat}, ${node.lon})`;
    const matrix = (cells: readonly (readonly (string | number | null)[])[]) =>
      cells.map(
        (row, index) =>
          `| ${result.latitudes_deg[index] ?? '?'} | ${row.map((cell) => cell ?? '–').join(' | ')} |`,
      );
    const header = [
      `| Lat / Lon | ${result.longitudes_deg.join(' | ')} |`,
      `|--:|${result.longitudes_deg.map(() => '--:').join('|')}|`,
    ];
    const datasets = new Set(result.cell_datasets.flat());
    const [onlyDataset] = datasets;
    const provenance =
      datasets.size === 1 && onlyDataset
        ? [`**Cell datasets:** all cells ${onlyDataset}`]
        : [
            '**Cell datasets** (U = usgs_3dep, S = srtm30m, M = mapzen, – = no data):',
            '',
            ...header,
            ...matrix(
              result.cell_datasets.map((row) =>
                row.map((dataset) => (dataset ? DATASET_CODES[dataset] : null)),
              ),
            ),
          ];

    const text = [
      `## Elevation grid: ${result.rows} rows × ${result.cols} cols (source: ${result.source_mode})`,
      '',
      `- **Box:** south ${result.south}, west ${result.west}, north ${result.north}, east ${result.east}`,
      `- **Node spacing:** ${result.row_spacing_m} m between rows (north-south), ${result.col_spacing_m} m between columns (east-west at the center latitude)`,
      `- **Highest:** ${describeNode(summary.highest)}`,
      `- **Lowest:** ${describeNode(summary.lowest)}`,
      `- **Mean:** ${summary.mean_elevation_m} m; **relief:** ${summary.relief_m} m (${summary.relief_ft} ft)`,
      `- **Coverage:** ${result.cells_with_data} of ${result.rows * result.cols} cells with data (${result.missing_cells} missing)`,
      `- **Datasets:** ${formatDatasetsUsed(result.datasets_used)}; resolution ${formatResolutionRange(result.resolution_m_range)}`,
      '',
      '**Elevation (m)**, rows north to south, columns west to east (row 0 = north, col 0 = west):',
      '',
      ...header,
      ...matrix(result.elevations_m),
      '',
      ...provenance,
    ].join('\n');
    return [{ type: 'text', text }];
  },
});

/** A node with data as a summary point; undefined when the node has no data. */
function toGridPoint(sample: Sample, row: number, col: number): GridPoint | undefined {
  if (sample.elevation_m === undefined) return;
  return {
    lat: sample.lat,
    lon: sample.lon,
    row,
    col,
    elevation_m: sample.elevation_m,
    elevation_ft: metersToFeet(sample.elevation_m),
  };
}

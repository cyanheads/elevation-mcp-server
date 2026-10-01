/**
 * @fileoverview Tests for elevation_get_grid: input validation, the three
 * handler reasons on the wire (invalid_bbox, too_many_cells, no_coverage),
 * the required attribution on every success path, each notice fragment,
 * partial and empty results, and format() parity.
 * @module tests/tools/get-grid.tool.test
 */

import { JsonRpcErrorCode } from '@cyanheads/mcp-ts-core/errors';
import { createMockContext, getEnrichment } from '@cyanheads/mcp-ts-core/testing';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { getGridTool } from '@/mcp-server/tools/definitions/get-grid.tool.js';
import { allToolDefinitions } from '@/mcp-server/tools/definitions/index.js';
import { MAPZEN_ATTRIBUTION, NO_DATASET_ATTRIBUTION } from '@/services/elevation/attribution.js';
import { disposeElevationServices } from '@/services/elevation/elevation-sampler.js';
import { epqsHitBody, epqsResponse } from '../fixtures/epqs.js';
import { epqsByPoint, otdByPoint } from '../fixtures/harness.js';
import type { OtdAnswer } from '../fixtures/opentopodata.js';
import {
  at,
  contentText,
  epqsAnswers,
  epqsRequestCount,
  errorOf,
  expectDeclaredError,
  leafStrings,
  mapzen,
  otdAnswers,
  otdRequests,
  runTool,
  srtm,
  structured,
  useUpstreams,
} from '../fixtures/tool-harness.js';

/** A small box near the equator, outside 3DEP coverage: 3 x 3 nodes at these coordinates. */
const BOX = { south: 0, west: 0, north: 0.002, east: 0.004 };
const LATS = [0.002, 0.001, 0] as const;
const LONS = [0, 0.002, 0.004] as const;

/** A 3 x 3 matrix of Open Topo Data answers over BOX, row 0 = north; `undefined` is no data. */
type Matrix = (OtdAnswer | undefined)[][];
const boxOtd = (matrix: Matrix) =>
  otdAnswers(
    Object.fromEntries(
      LATS.flatMap((lat, row) =>
        LONS.flatMap((lon, col) => {
          const answer = matrix[row]?.[col];
          return answer ? [[at(lat, lon), answer]] : [];
        }),
      ),
    ),
  );

const GRID_3X3 = { ...BOX, rows: 3, cols: 3, source: 'opentopodata' };

/** A box in 3DEP territory (Puget Sound); 2 x 2 nodes fall at (47.002, -122), (47.002, -121.998), (47, -122), (47, -121.998). */
const NA_BOX = { south: 47, west: -122, north: 47.002, east: -121.998 };

const run = (input: unknown, context?: Parameters<typeof runTool>[2]) =>
  runTool(getGridTool, input, context);

const flat = (value: number): Matrix => [
  [srtm(value), srtm(value), srtm(value)],
  [srtm(value), srtm(value), srtm(value)],
  [srtm(value), srtm(value), srtm(value)],
];

beforeEach(() => {
  disposeElevationServices();
});
afterEach(() => {
  disposeElevationServices();
});

describe('elevation_get_grid definition', () => {
  it('is registered, read-only, and scoped to its own read scope', () => {
    expect(allToolDefinitions).toContain(getGridTool);
    expect(getGridTool.name).toBe('elevation_get_grid');
    expect(getGridTool.annotations).toMatchObject({ readOnlyHint: true, openWorldHint: true });
    expect(getGridTool.auth).toEqual(['tool:elevation_get_grid:read']);
  });

  it('declares the three handler reasons and the six service reasons, each recovery naming this tool', () => {
    const errors = getGridTool.errors ?? [];
    expect(errors.map((error) => [error.reason, error.code])).toEqual([
      ['invalid_bbox', JsonRpcErrorCode.ValidationError],
      ['too_many_cells', JsonRpcErrorCode.ValidationError],
      ['no_coverage', JsonRpcErrorCode.NotFound],
      ['usgs_unavailable', JsonRpcErrorCode.ServiceUnavailable],
      ['opentopodata_unavailable', JsonRpcErrorCode.ServiceUnavailable],
      ['opentopodata_rate_limited', JsonRpcErrorCode.RateLimited],
      ['opentopodata_daily_limit', JsonRpcErrorCode.RateLimited],
      ['opentopodata_config_rejected', JsonRpcErrorCode.ConfigurationError],
      ['sampling_deadline_exceeded', JsonRpcErrorCode.Timeout],
    ]);
    for (const error of errors) expect(error.recovery).toContain('elevation_get_grid');
  });

  it('requires attribution and makes notice optional', () => {
    const enrichment = (getGridTool.enrichment ?? {}) as Record<
      string,
      { safeParse(value: unknown): { success: boolean } }
    >;
    expect(enrichment.attribution?.safeParse(undefined).success).toBe(false);
    expect(enrichment.notice?.safeParse(undefined).success).toBe(true);
    expect(getGridTool.enrichmentTrailer).toEqual({ attribution: { label: 'Sources' } });
  });
});

describe('input validation', () => {
  const parse = (input: unknown) => getGridTool.input.safeParse(input);

  it('defaults rows and cols to 10 and source to auto', () => {
    expect(parse(BOX).data).toEqual({ ...BOX, rows: 10, cols: 10, source: 'auto' });
  });

  it('reads blank rows, cols, and source as unset', () => {
    expect(parse({ ...BOX, rows: '', cols: '', source: '' }).data).toEqual({
      ...BOX,
      rows: 10,
      cols: 10,
      source: 'auto',
    });
  });

  it.each([
    ['3dep', 'usgs_3dep'],
    ['Open Topo Data', 'opentopodata'],
  ])('reads source %j as %s', (source, expected) => {
    expect(parse({ ...BOX, source }).data?.source).toBe(expected);
  });

  it.each([2, 25])('accepts rows and cols = %i', (n) => {
    expect(parse({ ...BOX, rows: n, cols: n }).success).toBe(true);
  });

  it('accepts the full coordinate range', () => {
    expect(parse({ south: -90, west: -180, north: 90, east: 180 }).success).toBe(true);
  });

  it('leaves south < north and west < east to the handler, so the caller gets this tool recovery', () => {
    expect(parse({ south: 5, west: 5, north: 1, east: 1 }).success).toBe(true);
  });

  it.each([
    ['no edges', {}],
    ['a missing south', { west: 0, north: 1, east: 1 }],
    ['a missing east', { south: 0, west: 0, north: 1 }],
    ['south below -90', { ...BOX, south: -90.1 }],
    ['north above 90', { ...BOX, north: 90.1 }],
    ['west below -180', { ...BOX, west: -180.1 }],
    ['east above 180', { ...BOX, east: 180.1 }],
    ['a blank south', { ...BOX, south: '' }],
    ['a numeric-string edge', { ...BOX, south: '0' }],
    ['a null edge', { ...BOX, north: null }],
    ['a NaN edge', { ...BOX, west: Number.NaN }],
    ['an infinite edge', { ...BOX, east: Number.POSITIVE_INFINITY }],
    ['rows 1', { ...BOX, rows: 1 }],
    ['rows 26', { ...BOX, rows: 26 }],
    ['cols 1', { ...BOX, cols: 1 }],
    ['cols 26', { ...BOX, cols: 26 }],
    ['fractional rows', { ...BOX, rows: 2.5 }],
    ['rows as a numeric string', { ...BOX, rows: '5' }],
    ['rows null', { ...BOX, rows: null }],
    ['an unknown source', { ...BOX, source: 'srtm' }],
    ['a bbox array', { bbox: [0, 0, 1, 1] }],
  ])('rejects %s', (_name, input) => {
    expect(parse(input).success).toBe(false);
  });

  describe('on the wire', () => {
    it.each([
      ['a missing south', { west: 0, north: 1, east: 1 }, 'south'],
      ['latitude 91', { ...BOX, north: 91 }, 'north'],
      ['longitude -181', { ...BOX, west: -181 }, 'west'],
      ['rows 1', { ...BOX, rows: 1 }, 'rows'],
      ['cols 26', { ...BOX, cols: 26 }, 'cols'],
      ['a bad source', { ...BOX, source: 'srtm' }, 'source'],
    ])('returns InvalidParams naming the field for %s', async (_name, input, path) => {
      const http = useUpstreams();
      const result = await run(input);
      expect(result.isError).toBe(true);
      const error = errorOf(result);
      expect(error.code).toBe(JsonRpcErrorCode.InvalidParams);
      expect(error.message).toContain('elevation_get_grid');
      expect(error.data?.reason).toBe('invalid_arguments');
      const issues = (error.data?.issues ?? []) as { path: (string | number)[] }[];
      expect(issues.map((issue) => issue.path.join('.'))).toContain(path);
      expect(http.calls).toHaveLength(0);
    });

    it('applies the 10 x 10 default to blank rows and cols in one Open Topo Data request', async () => {
      const http = useUpstreams({ otd: otdByPoint(() => srtm(100)) });
      const result = await run({ ...BOX, rows: '', cols: '', source: 'opentopodata' });
      expect(result.isError).toBeUndefined();
      expect(structured(result)).toMatchObject({ rows: 10, cols: 10, source_mode: 'opentopodata' });
      expect(structured(result).elevations_m).toHaveLength(10);
      expect(await otdRequests(http)).toHaveLength(1);
    });
  });
});

describe('success results', () => {
  const matrix: Matrix = [
    [srtm(100), srtm(110), srtm(120)],
    [srtm(105), undefined, srtm(130)],
    [srtm(90), srtm(95), srtm(130)],
  ];

  it('returns node coordinates, spacings, the matrices, and the summary for a grid with a gap', async () => {
    useUpstreams({ otd: boxOtd(matrix) });
    const result = await run(GRID_3X3);

    expect(result.isError).toBeUndefined();
    expect(structured(result)).toMatchObject({
      ...BOX,
      rows: 3,
      cols: 3,
      latitudes_deg: [0.002, 0.001, 0],
      longitudes_deg: [0, 0.002, 0.004],
      row_spacing_m: 111.2,
      col_spacing_m: 222.4,
      elevations_m: [
        [100, 110, 120],
        [105, null, 130],
        [90, 95, 130],
      ],
      cell_datasets: [
        ['srtm30m', 'srtm30m', 'srtm30m'],
        ['srtm30m', null, 'srtm30m'],
        ['srtm30m', 'srtm30m', 'srtm30m'],
      ],
      cells_with_data: 8,
      missing_cells: 1,
      datasets_used: { usgs_3dep: 0, srtm30m: 8, mapzen: 0 },
      resolution_m_range: { min_m: 30.9, max_m: 30.9 },
      source_mode: 'opentopodata',
    });
    expect(structured(result).summary).toStrictEqual({
      highest: { lat: 0.001, lon: 0.004, row: 1, col: 2, elevation_m: 130, elevation_ft: 426.5 },
      lowest: { lat: 0, lon: 0, row: 2, col: 0, elevation_m: 90, elevation_ft: 295.3 },
      mean_elevation_m: 110,
      relief_m: 40,
      relief_ft: 131.2,
    });
  });

  it('sends the nodes to Open Topo Data in row-major order, north row first', async () => {
    const http = useUpstreams({ otd: boxOtd(flat(5)) });
    await run(GRID_3X3);
    expect(await otdRequests(http)).toEqual([
      LATS.flatMap((lat) => LONS.map((lon) => at(lat, lon))),
    ]);
  });

  it('breaks highest and lowest ties to the first node in row-major order', async () => {
    useUpstreams({
      otd: boxOtd([
        [srtm(10), srtm(50), srtm(10)],
        [srtm(50), srtm(10), srtm(50)],
        [srtm(10), srtm(50), srtm(10)],
      ]),
    });
    const summary = structured(await run(GRID_3X3)).summary;
    expect(summary.highest).toMatchObject({ row: 0, col: 1 });
    expect(summary.lowest).toMatchObject({ row: 0, col: 0 });
  });

  it('builds the smallest grid, 2 x 2, from the four corners', async () => {
    const http = useUpstreams({ otd: otdByPoint(() => srtm(7)) });
    const result = await run({ ...BOX, rows: 2, cols: 2, source: 'opentopodata' });
    expect(structured(result)).toMatchObject({
      latitudes_deg: [0.002, 0],
      longitudes_deg: [0, 0.004],
      cells_with_data: 4,
      row_spacing_m: 222.4,
      col_spacing_m: 444.8,
    });
    expect(await otdRequests(http)).toEqual([
      [at(0.002, 0), at(0.002, 0.004), at(0, 0), at(0, 0.004)],
    ]);
  });

  it('samples a 250-cell grid (25 x 10) in three Open Topo Data requests', async () => {
    const http = useUpstreams({ otd: otdByPoint(() => srtm(7)) });
    const result = await run({ ...BOX, rows: 25, cols: 10, source: 'opentopodata' });
    expect(result.isError).toBeUndefined();
    expect(structured(result).elevations_m).toHaveLength(25);
    expect(structured(result).elevations_m[0]).toHaveLength(10);
    expect((await otdRequests(http)).map((locations) => locations.length)).toEqual([100, 100, 50]);
  });

  it('reports a cell at 0 m as data', async () => {
    useUpstreams({ otd: boxOtd(flat(0)) });
    const out = structured(await run(GRID_3X3));
    expect(out.cells_with_data).toBe(9);
    expect(out.summary).toMatchObject({ mean_elevation_m: 0, relief_m: 0 });
    expect(out.elevations_m.flat().every((value: number | null) => value === 0)).toBe(true);
  });

  it('computes the mean over cells with data only', async () => {
    useUpstreams({
      otd: boxOtd([
        [srtm(10), srtm(20), undefined],
        [undefined, undefined, undefined],
        [undefined, undefined, srtm(60)],
      ]),
    });
    expect(structured(await run(GRID_3X3)).summary.mean_elevation_m).toBe(30);
  });

  it('rounds the mean to 2 decimals', async () => {
    useUpstreams({
      otd: boxOtd([
        [srtm(1), srtm(1), srtm(2)],
        [undefined, undefined, undefined],
        [undefined, undefined, undefined],
      ]),
    });
    expect(structured(await run(GRID_3X3)).summary.mean_elevation_m).toBe(1.33);
  });

  it('narrows column spacing with the cosine of the center latitude', async () => {
    useUpstreams({ otd: otdByPoint(() => srtm(1)) });
    const equator = structured(
      await run({
        south: -0.5,
        west: 0,
        north: 0.5,
        east: 1,
        rows: 2,
        cols: 2,
        source: 'opentopodata',
      }),
    );
    disposeElevationServices();
    useUpstreams({ otd: otdByPoint(() => srtm(1)) });
    const high = structured(
      await run({
        south: 59.5,
        west: 0,
        north: 60.5,
        east: 1,
        rows: 2,
        cols: 2,
        source: 'opentopodata',
      }),
    );
    expect(high.row_spacing_m).toBe(equator.row_spacing_m);
    expect(high.col_spacing_m / equator.col_spacing_m).toBeCloseTo(0.5, 2);
  });

  it('answers in source usgs_3dep with misses as null cells and nothing sent to Open Topo Data', async () => {
    const http = useUpstreams({
      epqs: epqsAnswers({ [at(47.002, -122)]: { value: 50, resolution: 1 } }),
    });
    const result = await run({ ...NA_BOX, rows: 2, cols: 2, source: 'usgs_3dep' });
    const out = structured(result);
    expect(out.elevations_m).toEqual([
      [50, null],
      [null, null],
    ]);
    expect(out.cell_datasets).toEqual([
      ['usgs_3dep', null],
      [null, null],
    ]);
    expect(out.datasets_used).toEqual({ usgs_3dep: 1, srtm30m: 0, mapzen: 0 });
    expect(await otdRequests(http)).toHaveLength(0);
    expect(epqsRequestCount(http)).toBe(4);
  });

  describe('a box on the 3DEP coverage edge', () => {
    const useMixedBox = () =>
      useUpstreams({
        epqs: epqsAnswers({
          [at(47.002, -122)]: { value: 50, resolution: 1 },
          [at(47, -121.998)]: { value: 52, resolution: 1 },
        }),
        otd: otdAnswers({
          [at(47.002, -121.998)]: srtm(51),
          [at(47, -122)]: mapzen(-3),
        }),
      });

    it('fills 3DEP misses from Open Topo Data and keeps the provenance of every cell', async () => {
      useMixedBox();
      const out = structured(await run({ ...NA_BOX, rows: 2, cols: 2 }));
      expect(out.elevations_m).toEqual([
        [50, 51],
        [-3, 52],
      ]);
      expect(out.cell_datasets).toEqual([
        ['usgs_3dep', 'srtm30m'],
        ['mapzen', 'usgs_3dep'],
      ]);
      expect(out.datasets_used).toEqual({ usgs_3dep: 2, srtm30m: 1, mapzen: 1 });
      expect(out.resolution_m_range).toEqual({ min_m: 1, max_m: 30.9 });
      expect(out.source_mode).toBe('auto');
      expect(out.summary.lowest).toMatchObject({ row: 1, col: 0, elevation_m: -3 });
    });

    it('prints the provenance matrix with U, S, M codes and a legend naming each dataset', async () => {
      useMixedBox();
      const text = contentText(await run({ ...NA_BOX, rows: 2, cols: 2 }));
      expect(text).toContain(
        '**Cell datasets** (U = usgs_3dep, S = srtm30m, M = mapzen, – = no data):',
      );
      expect(text).toContain('| 47.002 | U | S |');
      expect(text).toContain('| 47 | M | U |');
      expect(text).not.toContain('all cells');
    });
  });

  it('prints one dataset id for a uniform grid instead of a matrix', async () => {
    useUpstreams({ otd: boxOtd(flat(9)) });
    const text = contentText(await run(GRID_3X3));
    expect(text).toContain('**Cell datasets:** all cells srtm30m');
    expect(text).not.toContain('U = usgs_3dep');
  });

  it('prints one dataset id for an all-Mapzen grid, with no resolution range', async () => {
    useUpstreams({ otd: otdByPoint(() => mapzen(9)) });
    const result = await run(GRID_3X3);
    expect(structured(result)).not.toHaveProperty('resolution_m_range');
    expect(contentText(result)).toContain('all cells mapzen');
    expect(contentText(result)).toContain('resolution varies (Mapzen only)');
  });

  it('lists a grid with some missing cells as non-uniform, with a dash for no data', async () => {
    useUpstreams({ otd: boxOtd(matrix) });
    const text = contentText(await run(GRID_3X3));
    expect(text).toContain('| 0.001 | 105 | – | 130 |');
    expect(text).toContain('| 0.001 | S | – | S |');
  });
});

describe('invalid_bbox on the wire', () => {
  it.each([
    [
      'south above north',
      { south: 1, west: 0, north: 0, east: 1 },
      'south (1) is not below north (0)',
    ],
    [
      'south equal to north',
      { south: 1, west: 0, north: 1, east: 1 },
      'south (1) is not below north (1)',
    ],
    ['west above east', { south: 0, west: 5, north: 1, east: 4 }, 'west (5) is not below east (4)'],
    [
      'west equal to east',
      { south: 0, west: 5, north: 1, east: 5 },
      'west (5) is not below east (5)',
    ],
    [
      'a box crossing the antimeridian',
      { south: 0, west: 170, north: 1, east: -170 },
      'west (170) is not below east (-170)',
    ],
    [
      'both edges inverted',
      { south: 2, west: 4, north: 1, east: 3 },
      'south (2) is not below north (1) and west (4) is not below east (3)',
    ],
  ])('rejects %s, naming the edges and sending nothing upstream', async (_name, box, problem) => {
    const http = useUpstreams();
    const result = await run({ ...box, rows: 3, cols: 3 });
    const error = expectDeclaredError(
      getGridTool,
      result,
      'invalid_bbox',
      JsonRpcErrorCode.ValidationError,
    );
    expect(error.data).toMatchObject(box);
    expect(error.message).toBe(`Invalid bounding box: ${problem}.`);
    expect(http.calls).toHaveLength(0);
  });
});

describe('too_many_cells on the wire', () => {
  it('rejects 25 x 11, stating the product and the limit', async () => {
    const http = useUpstreams();
    const result = await run({ ...BOX, rows: 25, cols: 11 });
    const error = expectDeclaredError(
      getGridTool,
      result,
      'too_many_cells',
      JsonRpcErrorCode.ValidationError,
    );
    expect(error.message).toBe('rows × cols is 25 × 11 = 275; the limit is 250.');
    expect(error.data).toMatchObject({ rows: 25, cols: 11, cells: 275 });
    expect(http.calls).toHaveLength(0);
  });

  it('rejects the 25 x 25 maximum of both dimensions', async () => {
    useUpstreams();
    const error = expectDeclaredError(
      getGridTool,
      await run({ ...BOX, rows: 25, cols: 25 }),
      'too_many_cells',
      JsonRpcErrorCode.ValidationError,
    );
    expect(error.data).toMatchObject({ cells: 625 });
  });

  it('allows exactly 250 cells', async () => {
    useUpstreams({ otd: otdByPoint(() => srtm(1)) });
    const result = await run({ ...BOX, rows: 10, cols: 25, source: 'opentopodata' });
    expect(result.isError).toBeUndefined();
  });

  it('reports an invalid box before the cell limit when both apply', async () => {
    useUpstreams();
    const result = await run({ south: 2, west: 0, north: 1, east: 1, rows: 25, cols: 25 });
    expect(errorOf(result).data?.reason).toBe('invalid_bbox');
  });
});

describe('no_coverage on the wire', () => {
  it('fails when no node returns an elevation, naming the node count and source', async () => {
    useUpstreams({ otd: otdAnswers({}) });
    const result = await run(GRID_3X3);
    const error = expectDeclaredError(
      getGridTool,
      result,
      'no_coverage',
      JsonRpcErrorCode.NotFound,
    );
    expect(error.message).toBe(
      'None of the 9 grid nodes returned an elevation (source: opentopodata).',
    );
  });

  it('names the applied source when the call used usgs_3dep', async () => {
    useUpstreams();
    const result = await run({ ...NA_BOX, rows: 2, cols: 2, source: 'epqs' });
    expect(errorOf(result).message).toContain('(source: usgs_3dep)');
  });

  it('writes the attribution before failing', async () => {
    useUpstreams({ otd: otdAnswers({}) });
    const ctx = createMockContext({ errors: getGridTool.errors });
    await expect(getGridTool.handler(getGridTool.input.parse(GRID_3X3), ctx)).rejects.toMatchObject(
      { data: { reason: 'no_coverage' } },
    );
    expect(getEnrichment(ctx)).toMatchObject({ attribution: NO_DATASET_ATTRIBUTION });
  });
});

describe('attribution on every success path', () => {
  const USGS = 'USGS 3D Elevation Program (3DEP)';
  const SRTM = 'SRTM GL1 v3 via Open Topo Data';
  const MAPZEN = 'Mapzen terrain tiles via Open Topo Data:';
  const naBox = { ...NA_BOX, rows: 2, cols: 2 };

  it.each([
    [
      '3DEP only',
      { epqs: epqsAnswers({ [at(47.002, -122)]: { value: 5 } }) },
      { ...naBox, source: 'usgs_3dep' },
      [USGS],
      [SRTM, MAPZEN],
    ],
    ['SRTM only', { otd: boxOtd(flat(5)) }, GRID_3X3, [SRTM], [USGS, MAPZEN]],
    [
      'Mapzen only',
      { otd: otdByPoint(() => mapzen(5)) },
      GRID_3X3,
      [MAPZEN, MAPZEN_ATTRIBUTION],
      [USGS, SRTM],
    ],
    [
      'SRTM and Mapzen',
      { otd: boxOtd([[srtm(5), mapzen(6), undefined], [], []]) },
      GRID_3X3,
      [SRTM, MAPZEN],
      [USGS],
    ],
  ] as const)(
    'carries it, in structuredContent and content[], for %s',
    async (_name, upstreams, input, contains, excludes) => {
      useUpstreams(upstreams);
      const result = await run(input);
      expect(result.isError).toBeUndefined();
      const attribution = structured(result).attribution as string;
      const text = contentText(result);
      for (const expected of contains) {
        expect(attribution).toContain(expected);
        expect(text).toContain(expected);
      }
      for (const excluded of excludes) {
        expect(attribution).not.toContain(excluded);
        expect(text).not.toContain(excluded);
      }
      expect(text).toContain('**Sources:**');
    },
  );

  it('lists the datasets in the order 3DEP, SRTM, Mapzen when all three answered', async () => {
    useUpstreams({
      epqs: epqsAnswers({ [at(47.002, -122)]: { value: 5, resolution: 1 } }),
      otd: otdAnswers({ [at(47.002, -121.998)]: srtm(6), [at(47, -122)]: mapzen(7) }),
    });
    const attribution = structured(await run(naBox)).attribution as string;
    expect(attribution.indexOf(USGS)).toBeGreaterThanOrEqual(0);
    expect(attribution.indexOf(USGS)).toBeLessThan(attribution.indexOf(SRTM));
    expect(attribution.indexOf(SRTM)).toBeLessThan(attribution.indexOf(MAPZEN));
  });

  it('also carries it when the call has a notice', async () => {
    useUpstreams({ otd: boxOtd([[srtm(5), undefined, undefined], [], []]) });
    const result = await run(GRID_3X3);
    expect(structured(result).notice).toBeTypeOf('string');
    expect(structured(result).attribution).toContain(SRTM);
  });

  describe('zero-result and under-cap pages', () => {
    it('a grid with no data at all is a no_coverage failure, not an empty page', async () => {
      useUpstreams({ otd: otdAnswers({}) });
      const result = await run(GRID_3X3);
      expect(result.isError).toBe(true);
      expect(errorOf(result).data?.reason).toBe('no_coverage');
      expect(structured(result)).not.toHaveProperty('elevations_m');
    });

    it('the thinnest success page, one cell with data, still carries its attribution', async () => {
      useUpstreams({ otd: boxOtd([[], [], [undefined, undefined, srtm(33)]]) });
      const result = await run(GRID_3X3);
      expect(result.isError).toBeUndefined();
      expect(structured(result)).toMatchObject({ cells_with_data: 1, missing_cells: 8 });
      expect(structured(result).summary.highest).toEqual(structured(result).summary.lowest);
      expect(structured(result).summary.relief_m).toBe(0);
      expect(structured(result).attribution).toContain(SRTM);
    });

    it('an under-cap page (9 of 250 cells) validates against the output and enrichment schemas', async () => {
      useUpstreams({ otd: boxOtd(flat(5)) });
      const result = await run(GRID_3X3);
      expect(result.isError).toBeUndefined();
      expect(getGridTool.output.safeParse(structured(result)).success).toBe(true);
    });
  });
});

describe('notices', () => {
  it('omits the notice when nothing needs saying', async () => {
    useUpstreams({ otd: boxOtd(flat(5)) });
    const result = await run(GRID_3X3);
    expect(structured(result)).not.toHaveProperty('notice');
    expect(contentText(result)).not.toContain('\n> ');
  });

  it.each([
    [
      [
        [srtm(1), srtm(1), srtm(1)],
        [srtm(1), undefined, srtm(1)],
        [srtm(1), srtm(1), srtm(1)],
      ],
      '1 of 9 cells has no data (null); summary values cover only cells with data.' +
        ' Re-call elevation_get_grid with source auto to query both providers for the cell without data.',
    ],
    [
      [
        [srtm(1), undefined, undefined],
        [srtm(1), srtm(1), srtm(1)],
        [srtm(1), srtm(1), srtm(1)],
      ],
      '2 of 9 cells have no data (null); summary values cover only cells with data.' +
        ' Re-call elevation_get_grid with source auto to query both providers for the cells without data.',
    ],
  ] as const)('counts cells without data and agrees in number (%#)', async (matrix, expected) => {
    useUpstreams({ otd: boxOtd(matrix as unknown as Matrix) });
    const result = await run(GRID_3X3);
    expect(structured(result).notice).toContain(expected);
    expect(contentText(result)).toContain(`> ${expected}`);
  });

  it.each([
    [
      1,
      '1 cell comes from Mapzen with values below 0 m, which over open water are sea-floor depths; summary.lowest and the mean include them.',
    ],
    [
      2,
      '2 cells come from Mapzen with values below 0 m, which over open water are sea-floor depths; summary.lowest and the mean include them.',
    ],
  ])('flags %i Mapzen sea-floor cell(s) and agrees in number', async (count, expected) => {
    const cells = [mapzen(-40), mapzen(-41)].slice(0, count);
    useUpstreams({
      otd: boxOtd([
        [...cells, ...Array.from({ length: 3 - count }, () => srtm(2))],
        [srtm(2), srtm(2), srtm(2)],
        [srtm(2), srtm(2), srtm(2)],
      ]),
    });
    const result = await run(GRID_3X3);
    expect(structured(result).notice).toContain(expected);
  });

  it.each([
    ['Mapzen at exactly 0 m', mapzen(0)],
    ['Mapzen above sea level', mapzen(9)],
    ['SRTM below 0 m', srtm(-77)],
  ])('has no sea-floor note for %s', async (_name, answer) => {
    useUpstreams({ otd: otdByPoint(() => answer) });
    expect(structured(await run(GRID_3X3))).not.toHaveProperty('notice');
  });

  it('has no sea-floor note for a 3DEP value below 0 m', async () => {
    useUpstreams({
      epqs: epqsByPoint(() => epqsResponse(epqsHitBody({ value: '-84.7', resolution: 30.9 }))),
    });
    const result = await run({ ...NA_BOX, rows: 2, cols: 2, source: 'usgs_3dep' });
    expect(structured(result).notice ?? '').not.toContain('Mapzen');
  });

  it('flags a box that spans the 3DEP coverage edge, with counts', async () => {
    useUpstreams({
      epqs: epqsAnswers({ [at(47.002, -122)]: { value: 50, resolution: 30.9 } }),
      otd: otdByPoint(() => srtm(52)),
    });
    const result = await run({ ...NA_BOX, rows: 2, cols: 2 });
    expect(structured(result).notice).toContain(
      'The box spans the USGS 3DEP coverage edge (1 cell from USGS 3DEP, 3 from Open Topo Data); the highest and lowest points compare values of different resolution and surface model.',
    );
  });

  it('has no coverage-edge note when one provider answered every cell', async () => {
    useUpstreams({ otd: boxOtd(flat(5)) });
    expect(structured(await run(GRID_3X3)).notice ?? '').not.toContain('coverage edge');
  });

  describe('node spacing against the source resolution', () => {
    const wide = { south: 0, west: 0, north: 1, east: 1, rows: 3, cols: 3, source: 'opentopodata' };

    it('warns when nodes are more than 20 times the finest source resolution apart', async () => {
      useUpstreams({ otd: otdByPoint(() => srtm(100)) });
      const result = await run(wide);
      expect(structured(result).row_spacing_m).toBe(55_597.5);
      expect(structured(result).notice).toContain(
        'Nodes are about 55598 m apart against a 30.9 m source, so peaks and pits between nodes are missed; re-grid a smaller box around summary.highest to refine it.',
      );
    });

    it.each([
      [0.0055, true],
      [0.0056, false],
    ])(
      'uses the larger spacing against the 20 x resolution threshold (north %d, quiet: %s)',
      async (north, quiet) => {
        useUpstreams({ otd: otdByPoint(() => srtm(100)) });
        const result = await run({
          south: 0,
          west: 0,
          north,
          east: 0.0001,
          rows: 2,
          cols: 2,
          source: 'opentopodata',
        });
        const { row_spacing_m } = structured(result);
        expect(row_spacing_m > 20 * 30.9).toBe(!quiet);
        if (quiet) expect(structured(result)).not.toHaveProperty('notice');
        else
          expect(structured(result).notice).toContain(
            'Nodes are about 623 m apart against a 30.9 m source',
          );
      },
    );

    it('triggers on column spacing when it is the larger', async () => {
      useUpstreams({ otd: otdByPoint(() => srtm(100)) });
      const result = await run({
        south: 0,
        west: 0,
        north: 0.0001,
        east: 0.0056,
        rows: 2,
        cols: 2,
        source: 'opentopodata',
      });
      expect(structured(result).col_spacing_m).toBeGreaterThan(20 * 30.9);
      expect(structured(result).notice).toContain('Nodes are about 623 m apart');
    });

    it('is silent when no cell reports a resolution (all Mapzen)', async () => {
      useUpstreams({ otd: otdByPoint(() => mapzen(100)) });
      expect(structured(await run(wide))).not.toHaveProperty('notice');
    });
  });

  it('joins matching fragments with a space, in the design order', async () => {
    useUpstreams({
      epqs: epqsAnswers({ [at(47.002, -122)]: { value: 50, resolution: 1 } }),
      otd: otdAnswers({ [at(47.002, -121.998)]: srtm(51), [at(47, -122)]: mapzen(-3) }),
    });
    expect(structured(await run({ ...NA_BOX, rows: 2, cols: 2 })).notice).toBe(
      '1 of 4 cells has no data (null); summary values cover only cells with data. ' +
        'The box spans the USGS 3DEP coverage edge (1 cell from USGS 3DEP, 2 from Open Topo Data); the highest and lowest points compare values of different resolution and surface model. ' +
        '1 cell comes from Mapzen with values below 0 m, which over open water are sea-floor depths; summary.lowest and the mean include them. ' +
        'Nodes are about 222 m apart against a 1 m source, so peaks and pits between nodes are missed; re-grid a smaller box around summary.highest to refine it.',
    );
  });
});

describe('format()', () => {
  const sampleOutput = () =>
    getGridTool.output.parse({
      south: 47,
      west: -122,
      north: 47.002,
      east: -121.998,
      rows: 2,
      cols: 2,
      latitudes_deg: [47.002, 47],
      longitudes_deg: [-122, -121.998],
      row_spacing_m: 222.4,
      col_spacing_m: 151.7,
      elevations_m: [
        [50, null],
        [-3, 52],
      ],
      cell_datasets: [
        ['usgs_3dep', null],
        ['mapzen', 'srtm30m'],
      ],
      summary: {
        highest: { lat: 47, lon: -121.998, row: 1, col: 1, elevation_m: 52, elevation_ft: 170.6 },
        lowest: { lat: 47, lon: -122, row: 1, col: 0, elevation_m: -3, elevation_ft: -9.8 },
        mean_elevation_m: 33,
        relief_m: 55,
        relief_ft: 180.4,
      },
      cells_with_data: 3,
      missing_cells: 1,
      datasets_used: { usgs_3dep: 1, srtm30m: 1, mapzen: 1 },
      resolution_m_range: { min_m: 1, max_m: 30.9 },
      source_mode: 'auto',
    });

  const textOf = (output: ReturnType<typeof sampleOutput>) => {
    const [block] = getGridTool.format?.(output) ?? [];
    return block?.type === 'text' ? block.text : '';
  };

  it('prints every output value', () => {
    const output = sampleOutput();
    const text = textOf(output);
    for (const leaf of leafStrings(output)) expect(text).toContain(leaf);
  });

  it('prints the elevation matrix with longitudes across, latitudes down, and a dash for null', () => {
    const lines = textOf(sampleOutput()).split('\n');
    const start = lines.indexOf('| Lat / Lon | -122 | -121.998 |');
    expect(start).toBeGreaterThan(0);
    expect(lines.slice(start, start + 4)).toEqual([
      '| Lat / Lon | -122 | -121.998 |',
      '|--:|--:|--:|',
      '| 47.002 | 50 | – |',
      '| 47 | -3 | 52 |',
    ]);
  });

  it('prints the provenance matrix with codes and the legend for a mixed grid', () => {
    const text = textOf(sampleOutput());
    expect(text).toContain(
      '**Cell datasets** (U = usgs_3dep, S = srtm30m, M = mapzen, – = no data):',
    );
    expect(text).toContain('| 47.002 | U | – |');
    expect(text).toContain('| 47 | M | S |');
  });

  it('prints a uniform grid as one line and a grid with only misses as a dash matrix', () => {
    const output = sampleOutput();
    const uniform = {
      ...output,
      cell_datasets: [
        ['srtm30m', 'srtm30m'],
        ['srtm30m', 'srtm30m'],
      ] satisfies typeof output.cell_datasets,
    };
    expect(textOf(uniform)).toContain('**Cell datasets:** all cells srtm30m');
    const uniformWithGap = {
      ...uniform,
      cell_datasets: [
        ['srtm30m', null],
        ['srtm30m', 'srtm30m'],
      ] satisfies typeof output.cell_datasets,
    };
    expect(textOf(uniformWithGap)).toContain('| 47.002 | S | – |');
  });

  it('heads the output with the grid size and source, and lists the summary', () => {
    const text = textOf(sampleOutput());
    expect(text).toContain('## Elevation grid: 2 rows × 2 cols (source: auto)');
    expect(text).toContain('- **Highest:** 52 m (170.6 ft) at row 1, col 1 (47, -121.998)');
    expect(text).toContain('- **Lowest:** -3 m (-9.8 ft) at row 1, col 0 (47, -122)');
    expect(text).toContain('- **Mean:** 33 m; **relief:** 55 m (180.4 ft)');
    expect(text).toContain('- **Coverage:** 3 of 4 cells with data (1 missing)');
    expect(text).toContain('resolution 1–30.9 m');
  });

  it('is the text content[] carries for a live result, plus the notice and Sources trailer', async () => {
    useUpstreams({
      epqs: epqsAnswers({ [at(47.002, -122)]: { value: 50, resolution: 1 } }),
      otd: otdAnswers({ [at(47.002, -121.998)]: srtm(51), [at(47, -122)]: mapzen(-3) }),
    });
    const result = await run({ ...NA_BOX, rows: 2, cols: 2 });
    const { attribution, notice, ...rest } = structured(result);
    const text = contentText(result);
    expect(text.startsWith(textOf(getGridTool.output.parse(rest)))).toBe(true);
    expect(text).toContain(`> ${notice}`);
    expect(text).toContain(`**Sources:** ${attribution}`);
  });

  it('carries every structuredContent value in content[] for a live partial result', async () => {
    useUpstreams({
      otd: boxOtd([
        [srtm(100), srtm(110), srtm(120)],
        [srtm(105), undefined, srtm(130)],
        [srtm(90), mapzen(-4), srtm(130)],
      ]),
    });
    const result = await run(GRID_3X3);
    const { attribution: _attribution, notice: _notice, ...rest } = structured(result);
    const text = contentText(result);
    for (const leaf of leafStrings(rest)) expect(text).toContain(leaf);
  });

  describe('upstream text', () => {
    const hostile =
      '6/5/2021\r\n| injected | row |\r\n# Heading\n[link](https://evil.test) <b>x</b>';

    it('never reaches either surface: the grid carries no upstream-authored text', async () => {
      useUpstreams({
        epqs: epqsByPoint(() =>
          epqsResponse(epqsHitBody({ acquisitionDate: hostile, resolution: 1 })),
        ),
      });
      const result = await run({ ...NA_BOX, rows: 2, cols: 2, source: 'usgs_3dep' });
      expect(result.isError).toBeUndefined();
      const everything = JSON.stringify(result.structuredContent) + contentText(result);
      expect(everything).not.toContain('injected');
      expect(everything).not.toContain('evil.test');
      expect(everything).not.toContain('acquisition');
    });

    it('keeps one matrix row per grid row when upstream text carries line breaks', async () => {
      useUpstreams({
        epqs: epqsByPoint((point) =>
          epqsResponse(epqsHitBody({ acquisitionDate: `a\r\nb\nc\r${point.lat}`, value: '10' })),
        ),
      });
      const result = await run({ ...NA_BOX, rows: 2, cols: 2, source: 'usgs_3dep' });
      const lines = contentText(result).split('\n');
      expect(lines.filter((line) => /^\| 47(\.002)? \|/.test(line))).toHaveLength(2);
      expect(lines.some((line) => line.includes('\r'))).toBe(false);
    });
  });
});

describe('reroute sentence on missing-data notices', () => {
  const euBox = { south: 47, west: 10, north: 47.002, east: 10.004, rows: 2, cols: 2 };
  it.each([
    ['auto', false],
    ['opentopodata', true],
  ])('under source %s the reroute sentence is present: %s', async (source, present) => {
    useUpstreams({ otd: otdAnswers({ [at(47.002, 10)]: srtm(1) }) });
    const result = await run({ ...euBox, source });
    const notice = structured(result).notice as string;
    expect(notice).toContain('have no data (null)');
    expect(notice.includes('with source auto to query both providers')).toBe(present);
  });
});

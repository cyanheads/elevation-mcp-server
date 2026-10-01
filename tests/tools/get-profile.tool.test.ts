/**
 * @fileoverview Tests for elevation_get_profile: input validation, the two
 * handler reasons on the wire (degenerate_path, no_coverage), the required
 * attribution on every success path, each notice fragment, partial and empty
 * results, and format() parity.
 * @module tests/tools/get-profile.tool.test
 */

import { JsonRpcErrorCode } from '@cyanheads/mcp-ts-core/errors';
import { createMockContext, getEnrichment } from '@cyanheads/mcp-ts-core/testing';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { getProfileTool } from '@/mcp-server/tools/definitions/get-profile.tool.js';
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

const START = { lat: 47, lon: -122 };
const END = { lat: 47.002, lon: -122 };
/** A 222 m meridian route in 3DEP territory; 5 samples fall at these latitudes. */
const ROUTE = [START, END];
const ROUTE_LATS = [47, 47.0005, 47.001, 47.0015, 47.002] as const;

/** Open Topo Data answers for the 5 samples of ROUTE; `undefined` is no data. */
const routeOtd = (values: (OtdAnswer | undefined)[]) =>
  otdAnswers(
    Object.fromEntries(
      ROUTE_LATS.flatMap((lat, i) => {
        const value = values[i];
        return value ? [[at(lat, -122), value]] : [];
      }),
    ),
  );

const run = (input: unknown, context?: Parameters<typeof runTool>[2]) =>
  runTool(getProfileTool, input, context);

/** A profile over the 5-sample route from Open Topo Data answers. */
const runRoute = (values: (OtdAnswer | undefined)[], extra: Record<string, unknown> = {}) => {
  const http = useUpstreams({ otd: routeOtd(values) });
  return run({ path: ROUTE, samples: 5, source: 'opentopodata', ...extra }).then((result) => ({
    http,
    result,
  }));
};

beforeEach(() => {
  disposeElevationServices();
});
afterEach(() => {
  disposeElevationServices();
});

describe('elevation_get_profile definition', () => {
  it('is registered, read-only, and scoped to its own read scope', () => {
    expect(allToolDefinitions).toContain(getProfileTool);
    expect(getProfileTool.name).toBe('elevation_get_profile');
    expect(getProfileTool.annotations).toMatchObject({ readOnlyHint: true, openWorldHint: true });
    expect(getProfileTool.auth).toEqual(['tool:elevation_get_profile:read']);
  });

  it('declares the two handler reasons and the six service reasons, each recovery naming this tool', () => {
    const errors = getProfileTool.errors ?? [];
    expect(errors.map((error) => [error.reason, error.code])).toEqual([
      ['degenerate_path', JsonRpcErrorCode.ValidationError],
      ['no_coverage', JsonRpcErrorCode.NotFound],
      ['usgs_unavailable', JsonRpcErrorCode.ServiceUnavailable],
      ['opentopodata_unavailable', JsonRpcErrorCode.ServiceUnavailable],
      ['opentopodata_rate_limited', JsonRpcErrorCode.RateLimited],
      ['opentopodata_daily_limit', JsonRpcErrorCode.RateLimited],
      ['opentopodata_config_rejected', JsonRpcErrorCode.ConfigurationError],
      ['sampling_deadline_exceeded', JsonRpcErrorCode.Timeout],
    ]);
    for (const error of errors.filter((entry) => entry.reason !== 'degenerate_path')) {
      expect(error.recovery).toContain('elevation_get_profile');
    }
  });

  it('requires attribution and makes notice optional', () => {
    const enrichment = (getProfileTool.enrichment ?? {}) as Record<
      string,
      { safeParse(value: unknown): { success: boolean } }
    >;
    expect(enrichment.attribution?.safeParse(undefined).success).toBe(false);
    expect(enrichment.notice?.safeParse(undefined).success).toBe(true);
    expect(getProfileTool.enrichmentTrailer).toEqual({ attribution: { label: 'Sources' } });
  });
});

describe('input validation', () => {
  const parse = (input: unknown) => getProfileTool.input.safeParse(input);

  it('defaults samples to 100 and source to auto', () => {
    expect(parse({ path: ROUTE }).data).toEqual({ path: ROUTE, samples: 100, source: 'auto' });
  });

  it('reads blank samples and source as unset', () => {
    expect(parse({ path: ROUTE, samples: '', source: '' }).data).toEqual({
      path: ROUTE,
      samples: 100,
      source: 'auto',
    });
  });

  it('accepts coordinate key aliases and strips extra keys on vertices', () => {
    const parsed = parse({
      path: [
        { latitude: 1, lng: 2, name: 'start' },
        { lat: 3, longitude: 4, elevation: 9 },
      ],
    });
    expect(parsed.data?.path).toStrictEqual([
      { lat: 1, lon: 2 },
      { lat: 3, lon: 4 },
    ]);
  });

  it.each([
    ['3dep', 'usgs_3dep'],
    ['Open Topo Data', 'opentopodata'],
  ])('reads source %j as %s', (source, expected) => {
    expect(parse({ path: ROUTE, source }).data?.source).toBe(expected);
  });

  it.each([2, 250])('accepts samples = %i', (samples) => {
    expect(parse({ path: ROUTE, samples }).data?.samples).toBe(samples);
  });

  it('accepts 2 and 1,000 vertices', () => {
    expect(parse({ path: ROUTE }).success).toBe(true);
    expect(parse({ path: Array.from({ length: 1_000 }, () => START) }).success).toBe(true);
  });

  it.each([
    ['no path', {}],
    ['an empty path', { path: [] }],
    ['a single vertex', { path: [START] }],
    ['1,001 vertices', { path: Array.from({ length: 1_001 }, () => START) }],
    ['a bare vertex instead of a list', { path: START }],
    ['path as a string', { path: '47,-122;47.002,-122' }],
    ['path as null', { path: null }],
    [
      'tuples',
      {
        path: [
          [47, -122],
          [47.002, -122],
        ],
      },
    ],
    ['a "lat,lon" string vertex', { path: ['47,-122', '47.002,-122'] }],
    ['numeric strings', { path: [{ lat: '47', lon: '-122' }, END] }],
    ['latitude 91', { path: [{ lat: 91, lon: 0 }, END] }],
    ['longitude -181', { path: [{ lat: 0, lon: -181 }, END] }],
    ['samples 1', { path: ROUTE, samples: 1 }],
    ['samples 251', { path: ROUTE, samples: 251 }],
    ['samples 0', { path: ROUTE, samples: 0 }],
    ['samples 2.5', { path: ROUTE, samples: 2.5 }],
    ['samples as a numeric string', { path: ROUTE, samples: '25' }],
    ['samples null', { path: ROUTE, samples: null }],
    ['an unknown source', { path: ROUTE, source: 'srtm' }],
  ])('rejects %s', (_name, input) => {
    expect(parse(input).success).toBe(false);
  });

  it('fails an oversize valid-shaped path with exactly one maxItems issue', () => {
    const result = parse({ path: Array.from({ length: 10_000 }, () => START) });
    expect(result.error?.issues).toHaveLength(1);
    expect(result.error?.issues[0]?.code).toBe('too_big');
  });

  describe('on the wire', () => {
    it.each([
      ['an empty path', { path: [] }, 'path'],
      ['one vertex', { path: [START] }, 'path'],
      ['1,001 vertices', { path: Array.from({ length: 1_001 }, () => START) }, 'path'],
      ['out-of-range latitude', { path: [{ lat: 91, lon: 0 }, END] }, 'path.0.lat'],
      ['a misspelled key', { path: [START, { lat: 1, lan: 2 }] }, 'path.1.lon'],
      ['samples 1', { path: ROUTE, samples: 1 }, 'samples'],
      ['samples 251', { path: ROUTE, samples: 251 }, 'samples'],
      ['a bad source', { path: ROUTE, source: 'srtm' }, 'source'],
    ])('returns InvalidParams naming the field for %s', async (_name, input, path) => {
      const http = useUpstreams();
      const result = await run(input);
      expect(result.isError).toBe(true);
      const error = errorOf(result);
      expect(error.code).toBe(JsonRpcErrorCode.InvalidParams);
      expect(error.message).toContain('elevation_get_profile');
      expect(error.data?.reason).toBe('invalid_arguments');
      const issues = (error.data?.issues ?? []) as { path: (string | number)[] }[];
      expect(issues.map((issue) => issue.path.join('.'))).toContain(path);
      expect(http.calls).toHaveLength(0);
    });

    it('applies the default of 100 samples to blank inputs', async () => {
      const http = useUpstreams({ otd: otdByPoint(() => srtm(100)) });
      // Outside 3DEP coverage, so auto sends all 100 samples to Open Topo Data in one request.
      const result = await run({
        path: [
          { lat: 47, lon: 10 },
          { lat: 47.002, lon: 10 },
        ],
        samples: '',
        source: '',
      });
      expect(result.isError).toBeUndefined();
      expect(structured(result).samples).toHaveLength(100);
      expect(structured(result).source_mode).toBe('auto');
      expect(await otdRequests(http)).toHaveLength(1);
    });
  });
});

describe('success results', () => {
  it('summarizes a route with a gap: ascent, descent, grades, extremes, and provenance', async () => {
    const { result } = await runRoute([srtm(100), undefined, srtm(110), srtm(105), srtm(110)]);

    expect(result.isError).toBeUndefined();
    const out = structured(result);
    expect(out.samples).toStrictEqual([
      {
        distance_m: 0,
        lat: 47,
        lon: -122,
        elevation_m: 100,
        dataset: 'srtm30m',
        resolution_m: 30.9,
      },
      { distance_m: 55.6, lat: 47.0005, lon: -122 },
      {
        distance_m: 111.2,
        lat: 47.001,
        lon: -122,
        elevation_m: 110,
        grade_pct: 9,
        dataset: 'srtm30m',
        resolution_m: 30.9,
      },
      {
        distance_m: 166.8,
        lat: 47.0015,
        lon: -122,
        elevation_m: 105,
        grade_pct: -9,
        dataset: 'srtm30m',
        resolution_m: 30.9,
      },
      {
        distance_m: 222.4,
        lat: 47.002,
        lon: -122,
        elevation_m: 110,
        grade_pct: 9,
        dataset: 'srtm30m',
        resolution_m: 30.9,
      },
    ]);
    expect(out.summary).toStrictEqual({
      total_distance_m: 222.4,
      start_elevation_m: 100,
      end_elevation_m: 110,
      net_change_m: 10,
      ascent_m: 15,
      descent_m: 5,
      ascent_ft: 49.2,
      descent_ft: 16.4,
      min_elevation_m: 100,
      max_elevation_m: 110,
      min_elevation_ft: 328.1,
      max_elevation_ft: 360.9,
      highest_point: { lat: 47.001, lon: -122, distance_m: 111.2, elevation_m: 110 },
      lowest_point: { lat: 47, lon: -122, distance_m: 0, elevation_m: 100 },
      max_grade_pct: 9,
      max_grade_distance_m: 111.2,
      min_grade_pct: -9,
      min_grade_distance_m: 166.8,
    });
    expect(out).toMatchObject({
      sample_interval_m: 55.6,
      vertices: 2,
      samples_with_data: 4,
      missing_samples: 1,
      datasets_used: { usgs_3dep: 0, srtm30m: 4, mapzen: 0 },
      resolution_m_range: { min_m: 30.9, max_m: 30.9 },
      source_mode: 'opentopodata',
    });
  });

  it('samples the first and last vertex exactly and sends the sample locations in route order', async () => {
    const { http } = await runRoute([srtm(1), srtm(2), srtm(3), srtm(4), srtm(5)]);
    expect(await otdRequests(http)).toEqual([ROUTE_LATS.map((lat) => at(lat, -122))]);
  });

  it('defaults to 100 samples in one Open Topo Data request', async () => {
    const http = useUpstreams({ otd: otdByPoint(() => srtm(100)) });
    const result = await run({ path: ROUTE, source: 'opentopodata' });
    expect(structured(result).samples).toHaveLength(100);
    expect(structured(result).samples_with_data).toBe(100);
    expect(await otdRequests(http)).toHaveLength(1);
  });

  it('takes only the endpoints for 2 samples', async () => {
    useUpstreams({ otd: routeOtd([srtm(100), undefined, undefined, undefined, srtm(130)]) });
    const result = await run({ path: ROUTE, samples: 2, source: 'opentopodata' });
    const out = structured(result);
    expect(out.samples).toHaveLength(2);
    expect(out.samples[0]).not.toHaveProperty('grade_pct');
    expect(out.samples[1].grade_pct).toBeCloseTo((100 * 30) / 222.4, 0);
    expect(out.sample_interval_m).toBe(out.summary.total_distance_m);
    expect(out.summary.max_grade_pct).toBe(out.summary.min_grade_pct);
    expect(out.summary).toMatchObject({ ascent_m: 30, descent_m: 0, net_change_m: 30 });
  });

  it('reports a flat route as zero grade, ascent, and descent', async () => {
    const { result } = await runRoute([srtm(40), srtm(40), srtm(40), srtm(40), srtm(40)]);
    expect(structured(result).summary).toMatchObject({
      ascent_m: 0,
      descent_m: 0,
      net_change_m: 0,
      max_grade_pct: 0,
      min_grade_pct: 0,
    });
  });

  it('reports a negative max_grade_pct on a route that only descends', async () => {
    const { result } = await runRoute([srtm(50), srtm(48), srtm(45), srtm(41), srtm(40)]);
    const summary = structured(result).summary;
    expect(summary.ascent_m).toBe(0);
    expect(summary.descent_m).toBe(10);
    expect(summary.net_change_m).toBe(-10);
    expect(summary.max_grade_pct).toBeLessThan(0);
    expect(summary.min_grade_pct).toBeLessThan(summary.max_grade_pct);
  });

  it('drops consecutive duplicate vertices and counts the rest', async () => {
    useUpstreams({ otd: routeOtd([srtm(1), srtm(2), srtm(3), srtm(4), srtm(5)]) });
    const result = await run({
      path: [START, START, END, END],
      samples: 5,
      source: 'opentopodata',
    });
    expect(structured(result)).toMatchObject({ vertices: 2, samples_with_data: 5 });
  });

  it('measures a multi-vertex route along its segments', async () => {
    useUpstreams({ otd: otdByPoint(() => srtm(10)) });
    const result = await run({
      path: [
        { lat: 0, lon: 0 },
        { lat: 0, lon: 1 },
        { lat: 1, lon: 1 },
      ],
      samples: 10,
      source: 'opentopodata',
    });
    expect(structured(result).vertices).toBe(3);
    expect(structured(result).summary.total_distance_m).toBeCloseTo(222_390.2, 1);
    expect(structured(result).samples.at(-1)).toMatchObject({ lat: 1, lon: 1 });
  });

  it('reports a sample at 0 m as data', async () => {
    const { result } = await runRoute([srtm(0), srtm(0), srtm(0), srtm(0), srtm(0)]);
    expect(structured(result).samples_with_data).toBe(5);
    expect(structured(result).summary.start_elevation_m).toBe(0);
  });

  it('keeps a lone sample with data: no ascent, descent, or grades', async () => {
    const { result } = await runRoute([undefined, undefined, srtm(70), undefined, undefined]);
    const out = structured(result);
    expect(result.isError).toBeUndefined();
    expect(out.summary).toMatchObject({
      start_elevation_m: 70,
      end_elevation_m: 70,
      net_change_m: 0,
      ascent_m: 0,
      descent_m: 0,
    });
    expect(out.summary).not.toHaveProperty('max_grade_pct');
    expect(out.summary).not.toHaveProperty('min_grade_pct');
    expect(out.samples.every((sample: Record<string, unknown>) => !('grade_pct' in sample))).toBe(
      true,
    );
    expect(out).toMatchObject({ samples_with_data: 1, missing_samples: 4 });
  });

  it('answers in source usgs_3dep with misses left as gaps and nothing sent to Open Topo Data', async () => {
    const http = useUpstreams({
      epqs: epqsAnswers({
        [at(47, -122)]: { value: 50, resolution: 1 },
        [at(47.002, -122)]: { value: 58, resolution: 1 },
      }),
    });
    const result = await run({ path: ROUTE, samples: 5, source: 'usgs_3dep' });
    const out = structured(result);
    expect(out.samples_with_data).toBe(2);
    expect(out.datasets_used).toEqual({ usgs_3dep: 2, srtm30m: 0, mapzen: 0 });
    expect(out.resolution_m_range).toEqual({ min_m: 1, max_m: 1 });
    expect(await otdRequests(http)).toHaveLength(0);
    expect(epqsRequestCount(http)).toBe(5);
  });

  it('fills 3DEP misses from Open Topo Data in auto and reports both datasets', async () => {
    useUpstreams({
      epqs: epqsAnswers({
        [at(47, -122)]: { value: 50, resolution: 1 },
        [at(47.0005, -122)]: { value: 52, resolution: 1 },
      }),
      otd: routeOtd([undefined, undefined, srtm(54), srtm(56), srtm(58)]),
    });
    const result = await run({ path: ROUTE, samples: 5 });
    const out = structured(result);
    expect(out.datasets_used).toEqual({ usgs_3dep: 2, srtm30m: 3, mapzen: 0 });
    expect(out.resolution_m_range).toEqual({ min_m: 1, max_m: 30.9 });
    expect(out.samples.map((sample: { dataset: string }) => sample.dataset)).toEqual([
      'usgs_3dep',
      'usgs_3dep',
      'srtm30m',
      'srtm30m',
      'srtm30m',
    ]);
    expect(out.source_mode).toBe('auto');
  });

  it('leaves Mapzen samples with no resolution and keeps the range to those that report one', async () => {
    const { result } = await runRoute([mapzen(10), mapzen(12), mapzen(14), mapzen(16), mapzen(18)]);
    const out = structured(result);
    expect(out).not.toHaveProperty('resolution_m_range');
    expect(out.samples[0]).not.toHaveProperty('resolution_m');
    expect(out.datasets_used).toEqual({ usgs_3dep: 0, srtm30m: 0, mapzen: 5 });
  });
});

describe('degenerate_path on the wire', () => {
  it('rejects a path whose vertices are all the same point, sending nothing upstream', async () => {
    const http = useUpstreams();
    const result = await run({ path: [START, START, START] });
    const error = expectDeclaredError(
      getProfileTool,
      result,
      'degenerate_path',
      JsonRpcErrorCode.ValidationError,
    );
    expect(error.data).toMatchObject({ vertices: 1, total_distance_m: 0 });
    expect(error.message).toContain('1 distinct vertex and is 0 m long');
    expect(http.calls).toHaveLength(0);
  });

  it('rejects a path whose two vertices differ only below the 6-decimal grid', async () => {
    useUpstreams();
    const error = expectDeclaredError(
      getProfileTool,
      await run({ path: [START, { lat: 47.0000001, lon: -122 }] }),
      'degenerate_path',
      JsonRpcErrorCode.ValidationError,
    );
    expect(error.data).toMatchObject({ vertices: 1, total_distance_m: 0 });
  });

  it('rejects distinct vertices under 1 m apart and reports their length', async () => {
    const http = useUpstreams();
    const error = expectDeclaredError(
      getProfileTool,
      await run({ path: [START, { lat: 47.000005, lon: -122 }] }),
      'degenerate_path',
      JsonRpcErrorCode.ValidationError,
    );
    expect(error.data).toMatchObject({ vertices: 2, total_distance_m: 0.56 });
    expect(error.message).toContain('2 distinct vertices and is 0.56 m long');
    expect(http.calls).toHaveLength(0);
  });

  it('accepts a route just over 1 m', async () => {
    useUpstreams({ otd: otdByPoint(() => srtm(5)) });
    const result = await run({
      path: [START, { lat: 47.00001, lon: -122 }],
      samples: 3,
      source: 'opentopodata',
    });
    expect(result.isError).toBeUndefined();
  });
});

describe('no_coverage on the wire', () => {
  it('fails when no sample returns an elevation, naming the sample count and source', async () => {
    useUpstreams({ otd: otdAnswers({}) });
    const result = await run({ path: ROUTE, samples: 5, source: 'opentopodata' });
    const error = expectDeclaredError(
      getProfileTool,
      result,
      'no_coverage',
      JsonRpcErrorCode.NotFound,
    );
    expect(error.message).toBe(
      'None of the 5 samples along the route returned an elevation (source: opentopodata).',
    );
  });

  it('names the applied source when the call used usgs_3dep', async () => {
    useUpstreams();
    const result = await run({ path: ROUTE, samples: 3, source: '3dep' });
    expect(errorOf(result).message).toContain('(source: usgs_3dep)');
  });

  it('writes the attribution before failing, so the handler never loses the credit line', async () => {
    useUpstreams({ otd: otdAnswers({}) });
    const ctx = createMockContext({ errors: getProfileTool.errors });
    await expect(
      getProfileTool.handler(
        getProfileTool.input.parse({ path: ROUTE, samples: 3, source: 'opentopodata' }),
        ctx,
      ),
    ).rejects.toMatchObject({ data: { reason: 'no_coverage' } });
    expect(getEnrichment(ctx)).toMatchObject({ attribution: NO_DATASET_ATTRIBUTION });
  });
});

describe('attribution on every success path', () => {
  const USGS = 'USGS 3D Elevation Program (3DEP)';
  const SRTM = 'SRTM GL1 v3 via Open Topo Data';
  const MAPZEN = 'Mapzen terrain tiles via Open Topo Data:';

  it.each([
    [
      '3DEP only',
      { epqs: epqsAnswers({ [at(47, -122)]: { value: 5 } }) },
      'usgs_3dep',
      [USGS],
      [SRTM, MAPZEN],
    ],
    [
      'SRTM only',
      { otd: routeOtd([srtm(5), srtm(6), srtm(7), srtm(8), srtm(9)]) },
      'opentopodata',
      [SRTM],
      [USGS, MAPZEN],
    ],
    [
      'Mapzen only',
      { otd: routeOtd([mapzen(5), mapzen(6), mapzen(7), mapzen(8), mapzen(9)]) },
      'opentopodata',
      [MAPZEN, MAPZEN_ATTRIBUTION],
      [USGS, SRTM],
    ],
    [
      'SRTM and Mapzen',
      { otd: routeOtd([srtm(5), mapzen(6), undefined, undefined, undefined]) },
      'opentopodata',
      [SRTM, MAPZEN],
      [USGS],
    ],
  ] as const)(
    'carries it, in structuredContent and content[], for %s',
    async (_name, upstreams, source, contains, excludes) => {
      useUpstreams(upstreams);
      const result = await run({ path: ROUTE, samples: 5, source });
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
      epqs: epqsAnswers({ [at(47, -122)]: { value: 5, resolution: 1 } }),
      otd: routeOtd([undefined, srtm(6), mapzen(7), undefined, undefined]),
    });
    const result = await run({ path: ROUTE, samples: 5 });
    const attribution = structured(result).attribution as string;
    expect(attribution.indexOf(USGS)).toBeGreaterThanOrEqual(0);
    expect(attribution.indexOf(USGS)).toBeLessThan(attribution.indexOf(SRTM));
    expect(attribution.indexOf(SRTM)).toBeLessThan(attribution.indexOf(MAPZEN));
  });

  it('also carries it when the call has a notice', async () => {
    const { result } = await runRoute([srtm(5), undefined, undefined, undefined, undefined]);
    expect(structured(result).notice).toBeTypeOf('string');
    expect(structured(result).attribution).toContain(SRTM);
  });

  describe('zero-result and under-cap pages', () => {
    it('a route with no data at all is a no_coverage failure, not an empty page', async () => {
      useUpstreams({ otd: otdAnswers({}) });
      const result = await run({ path: ROUTE, samples: 5, source: 'opentopodata' });
      expect(result.isError).toBe(true);
      expect(errorOf(result).data?.reason).toBe('no_coverage');
      expect(structured(result)).not.toHaveProperty('samples');
    });

    it('the thinnest success page, one sample with data, still carries its attribution', async () => {
      const { result } = await runRoute([undefined, undefined, undefined, undefined, srtm(33)]);
      expect(result.isError).toBeUndefined();
      expect(structured(result).samples_with_data).toBe(1);
      expect(structured(result).attribution).toContain(SRTM);
    });

    it('an under-cap page (5 of 250 samples) validates against the output and enrichment schemas', async () => {
      const { result } = await runRoute([srtm(1), srtm(2), srtm(3), srtm(4), srtm(5)]);
      expect(result.isError).toBeUndefined();
      expect(structured(result).samples).toHaveLength(5);
      expect(getProfileTool.output.safeParse(structured(result)).success).toBe(true);
    });

    it('the 250-sample cap page returns every sample', async () => {
      useUpstreams({ otd: otdByPoint(() => srtm(10)) });
      const result = await run({ path: ROUTE, samples: 250, source: 'opentopodata' });
      expect(structured(result).samples).toHaveLength(250);
      expect(structured(result).attribution).toContain(SRTM);
    });
  });
});

describe('notices', () => {
  it('omits the notice when nothing needs saying', async () => {
    const { result } = await runRoute([srtm(1), srtm(2), srtm(3), srtm(4), srtm(5)]);
    expect(structured(result)).not.toHaveProperty('notice');
    expect(contentText(result)).not.toContain('\n> ');
  });

  it.each([
    [
      [srtm(1), undefined, srtm(3), srtm(4), srtm(5)],
      '1 of 5 samples has no data; ascent, descent, and grades bridge those gaps and may be understated.' +
        ' Re-call elevation_get_profile with source auto to query both providers for the sample without data.',
    ],
    [
      [srtm(1), undefined, undefined, srtm(4), srtm(5)],
      '2 of 5 samples have no data; ascent, descent, and grades bridge those gaps and may be understated.' +
        ' Re-call elevation_get_profile with source auto to query both providers for the samples without data.',
    ],
  ])('counts samples without data and agrees in number (%#)', async (values, expected) => {
    const { result } = await runRoute(values);
    expect(structured(result).notice).toContain(expected);
    expect(contentText(result)).toContain(`> ${expected}`);
  });

  it('flags a route that crosses the 3DEP coverage edge, with counts', async () => {
    useUpstreams({
      epqs: epqsAnswers({ [at(47, -122)]: { value: 50, resolution: 1 } }),
      otd: routeOtd([undefined, srtm(52), srtm(54), srtm(56), srtm(58)]),
    });
    const result = await run({ path: ROUTE, samples: 5 });
    expect(structured(result).notice).toContain(
      'The route crosses the USGS 3DEP coverage edge (1 sample from USGS 3DEP, 4 from Open Topo Data), so ascent and descent mix 1–30 m lidar-derived values with 30 m SRTM-class values; re-call elevation_get_profile with source opentopodata for a profile from one provider. ' +
        'Samples are 55.6 m apart against a 1 m source; raise samples (up to 250) or split the route to capture more relief.',
    );
  });

  it('has no coverage-edge note when one provider answered every sample', async () => {
    const { result } = await runRoute([srtm(1), srtm(2), srtm(3), srtm(4), srtm(5)]);
    expect(structured(result).notice ?? '').not.toContain('coverage edge');
  });

  it.each([
    [
      [mapzen(-40), srtm(2), srtm(3), srtm(4), srtm(5)],
      '1 sample comes from Mapzen with values below 0 m, which over open water are sea-floor depths; ascent, descent, and the lowest point include them.',
    ],
    [
      [mapzen(-40), mapzen(-41), srtm(3), srtm(4), srtm(5)],
      '2 samples come from Mapzen with values below 0 m, which over open water are sea-floor depths; ascent, descent, and the lowest point include them.',
    ],
  ])('flags Mapzen sea-floor samples and agrees in number (%#)', async (values, expected) => {
    const { result } = await runRoute(values);
    expect(structured(result).notice).toContain(expected);
  });

  it.each([
    ['Mapzen at exactly 0 m', mapzen(0)],
    ['Mapzen above sea level', mapzen(9)],
    ['SRTM below 0 m', srtm(-77)],
  ])('has no sea-floor note for %s', async (_name, answer) => {
    const { result } = await runRoute([answer, answer, answer, answer, answer]);
    expect(structured(result)).not.toHaveProperty('notice');
  });

  it('has no sea-floor note for a 3DEP value below 0 m', async () => {
    useUpstreams({
      epqs: epqsByPoint(() => epqsResponse(epqsHitBody({ value: '-84.7', resolution: 1 }))),
    });
    const result = await run({ path: ROUTE, samples: 3 });
    expect(structured(result).notice ?? '').not.toContain('Mapzen');
  });

  describe('sample spacing against the source resolution', () => {
    /** A meridian route at longitude 10 (outside 3DEP coverage), `degrees` of latitude long. */
    const longRoute = (degrees: number) => [
      { lat: 47, lon: 10 },
      { lat: 47 + degrees, lon: 10 },
    ];

    it('says samples are closer than the source resolution when the interval is under it', async () => {
      useUpstreams({ otd: otdByPoint(() => srtm(100)) });
      const result = await run({ path: longRoute(0.0009), samples: 100 });
      expect(structured(result).sample_interval_m).toBe(1);
      expect(structured(result).notice).toContain(
        'Samples are 1 m apart, closer than the 30.9 m source resolution, so extra samples add no detail; re-call elevation_get_profile with fewer samples for a faster result.',
      );
    });

    it('says samples are far apart against a fine source when under the cap', async () => {
      useUpstreams({ otd: otdByPoint(() => srtm(100)) });
      const result = await run({ path: longRoute(3), samples: 100 });
      expect(structured(result).sample_interval_m).toBe(3369.5);
      expect(structured(result).notice).toContain(
        'Samples are 3369.5 m apart against a 30.9 m source; raise samples (up to 250) or split the route to capture more relief.',
      );
    });

    it('does not suggest raising samples when already at the 250 cap', async () => {
      useUpstreams({ otd: otdByPoint(() => srtm(100)) });
      const result = await run({ path: longRoute(3), samples: 250 });
      expect(structured(result).sample_interval_m).toBeGreaterThan(20 * 30.9);
      expect(structured(result)).not.toHaveProperty('notice');
    });

    it('stays quiet when the interval is within 20 times the source resolution', async () => {
      useUpstreams({ otd: otdByPoint(() => srtm(100)) });
      const result = await run({ path: longRoute(0.1), samples: 100 });
      expect(structured(result).sample_interval_m).toBeLessThan(20 * 30.9);
      expect(structured(result)).not.toHaveProperty('notice');
    });

    it('stays quiet for an interval of 30 m or less even against a 1 m source', async () => {
      useUpstreams({
        epqs: epqsByPoint(() => epqsResponse(epqsHitBody({ value: '40', resolution: 1 }))),
      });
      const result = await run({ path: ROUTE, samples: 10, source: 'usgs_3dep' });
      expect(structured(result).resolution_m_range).toEqual({ min_m: 1, max_m: 1 });
      expect(structured(result).sample_interval_m).toBeGreaterThan(20);
      expect(structured(result).sample_interval_m).toBeLessThan(30);
      expect(structured(result)).not.toHaveProperty('notice');
    });

    it('suggests more samples against a 1 m source once the interval passes 30 m', async () => {
      useUpstreams({
        epqs: epqsByPoint(() => epqsResponse(epqsHitBody({ value: '40', resolution: 1 }))),
      });
      const result = await run({ path: ROUTE, samples: 5, source: 'usgs_3dep' });
      expect(structured(result).sample_interval_m).toBe(55.6);
      expect(structured(result).notice).toContain(
        'Samples are 55.6 m apart against a 1 m source; raise samples (up to 250) or split the route to capture more relief.',
      );
    });

    it('is silent about spacing when no sample reports a resolution (all Mapzen)', async () => {
      useUpstreams({ otd: otdByPoint(() => mapzen(100)) });
      const result = await run({ path: longRoute(3), samples: 100 });
      expect(structured(result)).not.toHaveProperty('notice');
    });
  });

  it('joins matching fragments with a space, in the design order', async () => {
    useUpstreams({
      epqs: epqsAnswers({ [at(47, -122)]: { value: 50, resolution: 1 } }),
      otd: routeOtd([undefined, srtm(52), mapzen(-8), undefined, undefined]),
    });
    const result = await run({ path: ROUTE, samples: 5 });
    expect(structured(result).notice).toBe(
      '2 of 5 samples have no data; ascent, descent, and grades bridge those gaps and may be understated. ' +
        'The route crosses the USGS 3DEP coverage edge (1 sample from USGS 3DEP, 2 from Open Topo Data), so ascent and descent mix 1–30 m lidar-derived values with 30 m SRTM-class values; re-call elevation_get_profile with source opentopodata for a profile from one provider. ' +
        '1 sample comes from Mapzen with values below 0 m, which over open water are sea-floor depths; ascent, descent, and the lowest point include them. ' +
        'Samples are 55.6 m apart against a 1 m source; raise samples (up to 250) or split the route to capture more relief.',
    );
  });
});

describe('format()', () => {
  const sampleOutput = () =>
    getProfileTool.output.parse({
      samples: [
        {
          distance_m: 0,
          lat: 47,
          lon: -122,
          elevation_m: 100,
          dataset: 'usgs_3dep',
          resolution_m: 1,
        },
        { distance_m: 55.6, lat: 47.0005, lon: -122 },
        {
          distance_m: 111.2,
          lat: 47.001,
          lon: -122,
          elevation_m: -8,
          grade_pct: -0.1,
          dataset: 'mapzen',
        },
        {
          distance_m: 166.8,
          lat: 47.0015,
          lon: -122,
          elevation_m: 90,
          grade_pct: 1.8,
          dataset: 'srtm30m',
          resolution_m: 30.9,
        },
      ],
      summary: {
        total_distance_m: 166.8,
        start_elevation_m: 100,
        end_elevation_m: 90,
        net_change_m: -10,
        ascent_m: 98,
        descent_m: 108,
        ascent_ft: 321.5,
        descent_ft: 354.3,
        min_elevation_m: -8,
        max_elevation_m: 100,
        min_elevation_ft: -26.2,
        max_elevation_ft: 328.1,
        highest_point: { lat: 47, lon: -122, distance_m: 0, elevation_m: 100 },
        lowest_point: { lat: 47.001, lon: -122, distance_m: 111.2, elevation_m: -8 },
        max_grade_pct: 1.8,
        max_grade_distance_m: 166.8,
        min_grade_pct: -0.1,
        min_grade_distance_m: 111.2,
      },
      sample_interval_m: 55.6,
      vertices: 2,
      samples_with_data: 3,
      missing_samples: 1,
      datasets_used: { usgs_3dep: 1, srtm30m: 1, mapzen: 1 },
      resolution_m_range: { min_m: 1, max_m: 30.9 },
      source_mode: 'auto',
    });

  const textOf = (output: ReturnType<typeof sampleOutput>) => {
    const [block] = getProfileTool.format?.(output) ?? [];
    return block?.type === 'text' ? block.text : '';
  };

  it('prints every output value', () => {
    const output = sampleOutput();
    const text = textOf(output);
    for (const leaf of leafStrings(output)) expect(text).toContain(leaf);
  });

  it('renders no data, varies, and the em dash placeholders in the table', () => {
    const rows = textOf(sampleOutput())
      .split('\n')
      .filter((line) => /^\| \d+ /.test(line));
    expect(rows).toEqual([
      '| 1 | 0 | 47, -122 | 100 | — | usgs_3dep | 1 |',
      '| 2 | 55.6 | 47.0005, -122 | no data | — | no data | — |',
      '| 3 | 111.2 | 47.001, -122 | -8 | -0.1 | mapzen | varies |',
      '| 4 | 166.8 | 47.0015, -122 | 90 | 1.8 | srtm30m | 30.9 |',
    ]);
  });

  it('heads the table with Dist (m) and prints distance_m as structuredContent carries it', () => {
    const text = textOf(sampleOutput());
    expect(text).toContain(
      '| # | Dist (m) | Lat, Lon | Elev (m) | Grade (%) | Dataset | Res (m) |',
    );
  });

  it('places each extreme grade at its sample distance', () => {
    const text = textOf(sampleOutput());
    expect(text).toContain('**Grades:** max 1.8% at 166.8 m; min -0.1% at 111.2 m');
    expect(text).toContain('(net -10 m)');
    expect(text).toContain('resolution 1–30.9 m');
  });

  it('labels each extreme grade at the sample profileStats chose when two grades round alike', async () => {
    /** Grades 10.018 / 10.036 / -10.018 / -10.036 %: each pair rounds to ±10.0, and the steeper one comes second. */
    const { result } = await runRoute([srtm(0), srtm(5.57), srtm(11.15), srtm(5.58), srtm(0)]);
    const out = structured(result);
    expect(out.samples.map((sample: { grade_pct?: number }) => sample.grade_pct)).toEqual([
      undefined,
      10,
      10,
      -10,
      -10,
    ]);
    expect(out.summary).toMatchObject({
      max_grade_pct: 10,
      max_grade_distance_m: 111.2,
      min_grade_pct: -10,
      min_grade_distance_m: 222.4,
    });
    expect(contentText(result)).toContain('**Grades:** max 10% at 111.2 m; min -10% at 222.4 m');
  });

  it('says grades are not available with fewer than 2 samples with data', () => {
    const sparse = getProfileTool.output.parse({
      samples: [{ distance_m: 0, lat: 47, lon: -122, elevation_m: 5, dataset: 'mapzen' }],
      summary: {
        total_distance_m: 10,
        start_elevation_m: 5,
        end_elevation_m: 5,
        net_change_m: 0,
        ascent_m: 0,
        descent_m: 0,
        ascent_ft: 0,
        descent_ft: 0,
        min_elevation_m: 5,
        max_elevation_m: 5,
        min_elevation_ft: 16.4,
        max_elevation_ft: 16.4,
        highest_point: { lat: 47, lon: -122, distance_m: 0, elevation_m: 5 },
        lowest_point: { lat: 47, lon: -122, distance_m: 0, elevation_m: 5 },
      },
      sample_interval_m: 10,
      vertices: 2,
      samples_with_data: 1,
      missing_samples: 0,
      datasets_used: { usgs_3dep: 0, srtm30m: 0, mapzen: 1 },
      source_mode: 'opentopodata',
    });
    const text = textOf(sparse);
    expect(text).toContain('not available (fewer than 2 samples with data)');
    expect(text).toContain('resolution varies (Mapzen only)');
  });

  it('is the text content[] carries for a live result, plus the notice and Sources trailer', async () => {
    useUpstreams({
      epqs: epqsAnswers({ [at(47, -122)]: { value: 50, resolution: 1 } }),
      otd: routeOtd([undefined, srtm(52), mapzen(-8), srtm(55), srtm(58)]),
    });
    const result = await run({ path: ROUTE, samples: 5 });
    const out = structured(result);
    const { attribution, notice, ...rest } = out;
    const text = contentText(result);
    expect(text.startsWith(textOf(getProfileTool.output.parse(rest)))).toBe(true);
    expect(text).toContain(`> ${notice}`);
    expect(text).toContain(`**Sources:** ${attribution}`);
  });

  it('carries every structuredContent value in content[] for a live partial result', async () => {
    const { result } = await runRoute([srtm(100), undefined, srtm(110), srtm(105), srtm(110)]);
    const { attribution: _attribution, notice: _notice, ...rest } = structured(result);
    const text = contentText(result);
    for (const leaf of leafStrings(rest)) expect(text).toContain(leaf);
  });

  it('prints one table row per sample', async () => {
    useUpstreams({ otd: otdByPoint(() => srtm(100)) });
    const result = await run({ path: ROUTE, samples: 100, source: 'opentopodata' });
    const rows = contentText(result)
      .split('\n')
      .filter((line) => /^\| \d+ /.test(line));
    expect(rows).toHaveLength(100);
  });

  describe('upstream text', () => {
    const hostile =
      '6/5/2021\r\n| injected | row |\r\n# Heading\n[link](https://evil.test) <b>x</b>';

    it('never reaches either surface: the profile carries no upstream-authored text', async () => {
      useUpstreams({
        epqs: epqsByPoint(() =>
          epqsResponse(epqsHitBody({ acquisitionDate: hostile, resolution: 1 })),
        ),
      });
      const result = await run({ path: ROUTE, samples: 3, source: 'usgs_3dep' });
      expect(result.isError).toBeUndefined();
      const everything = JSON.stringify(result.structuredContent) + contentText(result);
      expect(everything).not.toContain('injected');
      expect(everything).not.toContain('evil.test');
      expect(everything).not.toContain('acquisition');
    });

    it('keeps one table row per sample and no stray lines when upstream text carries line breaks', async () => {
      useUpstreams({
        epqs: epqsByPoint((point) =>
          epqsResponse(epqsHitBody({ acquisitionDate: `a\r\nb\nc\r${point.lat}`, value: '10' })),
        ),
      });
      const result = await run({ path: ROUTE, samples: 3, source: 'usgs_3dep' });
      const lines = contentText(result).split('\n');
      expect(lines.filter((line) => /^\| \d+ /.test(line))).toHaveLength(3);
      expect(lines.some((line) => line.includes('\r'))).toBe(false);
    });
  });
});

describe('reroute sentence on missing-data notices', () => {
  const euRoute = [
    { lat: 47, lon: 10 },
    { lat: 47.002, lon: 10 },
  ];
  it.each([
    ['auto', false],
    ['opentopodata', true],
  ])('under source %s the reroute sentence is present: %s', async (source, present) => {
    useUpstreams({ otd: otdAnswers({ [at(47, 10)]: srtm(1), [at(47.002, 10)]: srtm(2) }) });
    const result = await run({ path: euRoute, samples: 5, source });
    const notice = structured(result).notice as string;
    expect(notice).toContain('have no data');
    expect(notice.includes('with source auto to query both providers')).toBe(present);
  });
});

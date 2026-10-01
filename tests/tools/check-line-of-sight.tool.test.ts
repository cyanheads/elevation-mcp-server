/**
 * @fileoverview Tests for elevation_check_line_of_sight: input validation,
 * the two handler reasons on the wire (same_endpoints, endpoint_no_data), the
 * three verdicts with their limiting point and first obstruction, earth
 * models, the sea-surface rule, the required attribution on every success
 * path, each notice fragment, and format() parity.
 * @module tests/tools/check-line-of-sight.tool.test
 */

import { JsonRpcErrorCode } from '@cyanheads/mcp-ts-core/errors';
import { createMockContext, getEnrichment } from '@cyanheads/mcp-ts-core/testing';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { checkLineOfSightTool } from '@/mcp-server/tools/definitions/check-line-of-sight.tool.js';
import { allToolDefinitions } from '@/mcp-server/tools/definitions/index.js';
import { MAPZEN_ATTRIBUTION, NO_DATASET_ATTRIBUTION } from '@/services/elevation/attribution.js';
import { disposeElevationServices } from '@/services/elevation/elevation-sampler.js';
import { METERS_PER_DEGREE, roundTo } from '@/services/elevation/units.js';
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

/** Longitude of the point `meters` east of (0, 0) on the equator, at the sampler's 6-decimal precision. */
const lonAt = (meters: number) => roundTo(meters / METERS_PER_DEGREE, 6);

/** Terrain answers along an equatorial line, keyed by distance in meters from the observer. */
const lineOtd = (answers: [number, OtdAnswer | undefined][]) =>
  otdAnswers(
    Object.fromEntries(
      answers.flatMap(([meters, answer]) => (answer ? [[at(0, lonAt(meters)), answer]] : [])),
    ),
  );

/** An equatorial line `meters` long from (0, 0), sampled from Open Topo Data. */
const equator = (meters: number, extra: Record<string, unknown> = {}) => ({
  observer: { lat: 0, lon: 0 },
  target: { lat: 0, lon: meters / METERS_PER_DEGREE },
  source: 'opentopodata',
  ...extra,
});

/** A 222 m meridian line in 3DEP territory; 3 samples fall at these latitudes. */
const NA_LINE = {
  observer: { lat: 47, lon: -122 },
  target: { lat: 47.002, lon: -122 },
};

const run = (input: unknown, context?: Parameters<typeof runTool>[2]) =>
  runTool(checkLineOfSightTool, input, context);

/** A flat-earth, zero-height 1 km line with 10 m endpoints and the given interior terrain. */
const kilometer = (interior: (number | undefined)[], extra: Record<string, unknown> = {}) => {
  const spacing = 1_000 / (interior.length + 1);
  const answers: [number, OtdAnswer | undefined][] = [
    [0, srtm(10)],
    ...interior.map((elevation, i): [number, OtdAnswer | undefined] => [
      (i + 1) * spacing,
      elevation === undefined ? undefined : srtm(elevation),
    ]),
    [1_000, srtm(10)],
  ];
  const http = useUpstreams({ otd: lineOtd(answers) });
  return run(
    equator(1_000, {
      earth_model: 'flat',
      observer_height_m: 0,
      samples: interior.length + 2,
      ...extra,
    }),
  ).then((result) => ({ http, result }));
};

beforeEach(() => {
  disposeElevationServices();
});
afterEach(() => {
  disposeElevationServices();
});

describe('elevation_check_line_of_sight definition', () => {
  it('is registered, read-only, and scoped to its own read scope', () => {
    expect(allToolDefinitions).toContain(checkLineOfSightTool);
    expect(checkLineOfSightTool.name).toBe('elevation_check_line_of_sight');
    expect(checkLineOfSightTool.annotations).toMatchObject({
      readOnlyHint: true,
      openWorldHint: true,
    });
    expect(checkLineOfSightTool.auth).toEqual(['tool:elevation_check_line_of_sight:read']);
  });

  it('declares the two handler reasons and the six service reasons, each recovery naming this tool', () => {
    const errors = checkLineOfSightTool.errors ?? [];
    expect(errors.map((error) => [error.reason, error.code])).toEqual([
      ['same_endpoints', JsonRpcErrorCode.ValidationError],
      ['endpoint_no_data', JsonRpcErrorCode.NotFound],
      ['usgs_unavailable', JsonRpcErrorCode.ServiceUnavailable],
      ['opentopodata_unavailable', JsonRpcErrorCode.ServiceUnavailable],
      ['opentopodata_rate_limited', JsonRpcErrorCode.RateLimited],
      ['opentopodata_daily_limit', JsonRpcErrorCode.RateLimited],
      ['opentopodata_config_rejected', JsonRpcErrorCode.ConfigurationError],
      ['sampling_deadline_exceeded', JsonRpcErrorCode.Timeout],
    ]);
    for (const error of errors.filter((entry) => entry.reason !== 'same_endpoints')) {
      expect(error.recovery).toContain('elevation_check_line_of_sight');
    }
  });

  it('requires attribution and makes notice optional', () => {
    const enrichment = (checkLineOfSightTool.enrichment ?? {}) as Record<
      string,
      { safeParse(value: unknown): { success: boolean } }
    >;
    expect(enrichment.attribution?.safeParse(undefined).success).toBe(false);
    expect(enrichment.notice?.safeParse(undefined).success).toBe(true);
    expect(checkLineOfSightTool.enrichmentTrailer).toEqual({
      attribution: { label: 'Sources' },
    });
  });
});

describe('input validation', () => {
  const parse = (input: unknown) => checkLineOfSightTool.input.safeParse(input);
  const base = { observer: { lat: 1, lon: 2 }, target: { lat: 3, lon: 4 } };

  it('applies the documented defaults', () => {
    expect(parse(base).data).toEqual({
      ...base,
      observer_height_m: 1.7,
      target_height_m: 0,
      earth_model: 'optical',
      samples: 100,
      source: 'auto',
    });
  });

  it('reads blank optional inputs as unset', () => {
    expect(
      parse({
        ...base,
        observer_height_m: '',
        target_height_m: '',
        earth_model: '',
        samples: '',
        source: '',
      }).data,
    ).toEqual({
      ...base,
      observer_height_m: 1.7,
      target_height_m: 0,
      earth_model: 'optical',
      samples: 100,
      source: 'auto',
    });
  });

  it.each([
    ['radio', 'radio'],
    [' Radio ', 'radio'],
    ['FLAT', 'flat'],
    ['Geometric', 'geometric'],
  ])('normalizes earth_model %j to %s', (value, expected) => {
    expect(parse({ ...base, earth_model: value }).data?.earth_model).toBe(expected);
  });

  it('accepts coordinate key aliases and strips extra keys on both endpoints', () => {
    const parsed = parse({
      observer: { latitude: 1, lng: 2, name: 'tower' },
      target: { lat: 3, longitude: 4, elevation: 9 },
    });
    expect(parsed.data?.observer).toStrictEqual({ lat: 1, lon: 2 });
    expect(parsed.data?.target).toStrictEqual({ lat: 3, lon: 4 });
  });

  it.each([
    [0, 0],
    [10_000, 10_000],
  ])('accepts heights of %d and %d', (observer_height_m, target_height_m) => {
    expect(parse({ ...base, observer_height_m, target_height_m }).success).toBe(true);
  });

  it.each([3, 250])('accepts samples = %i', (samples) => {
    expect(parse({ ...base, samples }).data?.samples).toBe(samples);
  });

  it.each([
    ['no observer', { target: base.target }],
    ['no target', { observer: base.observer }],
    ['an observer tuple', { ...base, observer: [1, 2] }],
    ['an observer "lat,lon" string', { ...base, observer: '1,2' }],
    ['a null target', { ...base, target: null }],
    ['latitude 91', { ...base, observer: { lat: 91, lon: 0 } }],
    ['longitude 181', { ...base, target: { lat: 0, lon: 181 } }],
    ['a negative observer height', { ...base, observer_height_m: -0.1 }],
    ['an observer height over 10,000', { ...base, observer_height_m: 10_000.1 }],
    ['a negative target height', { ...base, target_height_m: -1 }],
    ['a target height over 10,000', { ...base, target_height_m: 10_001 }],
    ['a height as a numeric string', { ...base, observer_height_m: '5' }],
    ['an unknown earth model', { ...base, earth_model: 'curved' }],
    ['a numeric earth model', { ...base, earth_model: 1 }],
    ['samples 2', { ...base, samples: 2 }],
    ['samples 251', { ...base, samples: 251 }],
    ['samples 3.5', { ...base, samples: 3.5 }],
    ['samples as a numeric string', { ...base, samples: '10' }],
    ['an unknown source', { ...base, source: 'srtm' }],
  ])('rejects %s', (_name, input) => {
    expect(parse(input).success).toBe(false);
  });

  describe('on the wire', () => {
    it.each([
      ['a missing target', { observer: base.observer }, 'target'],
      ['out-of-range latitude', { ...base, observer: { lat: 91, lon: 0 } }, 'observer.lat'],
      ['a misspelled key', { ...base, target: { lat: 1, lan: 2 } }, 'target.lon'],
      ['a negative height', { ...base, observer_height_m: -5 }, 'observer_height_m'],
      ['an unknown earth model', { ...base, earth_model: 'curved' }, 'earth_model'],
      ['samples 2', { ...base, samples: 2 }, 'samples'],
      ['a bad source', { ...base, source: 'srtm' }, 'source'],
    ])('returns InvalidParams naming the field for %s', async (_name, input, path) => {
      const http = useUpstreams();
      const result = await run(input);
      expect(result.isError).toBe(true);
      const error = errorOf(result);
      expect(error.code).toBe(JsonRpcErrorCode.InvalidParams);
      expect(error.message).toContain('elevation_check_line_of_sight');
      expect(error.data?.reason).toBe('invalid_arguments');
      const issues = (error.data?.issues ?? []) as { path: (string | number)[] }[];
      expect(issues.map((issue) => issue.path.join('.'))).toContain(path);
      expect(http.calls).toHaveLength(0);
    });

    it('applies the defaults to blank optional inputs', async () => {
      const http = useUpstreams({ otd: otdByPoint(() => srtm(0)) });
      const result = await run({
        ...equator(1_000),
        observer_height_m: '',
        target_height_m: '',
        earth_model: '',
        samples: '',
      });
      expect(result.isError).toBeUndefined();
      expect(structured(result)).toMatchObject({ samples: 100, earth_model: 'optical' });
      expect(structured(result).observer.height_above_ground_m).toBe(1.7);
      expect(structured(result).target.height_above_ground_m).toBe(0);
      expect((await otdRequests(http))[0]).toHaveLength(100);
    });
  });
});

describe('verdicts', () => {
  it('is clear with 5 m over a 5 m midpoint on a flat 1 km line, reporting every field', async () => {
    const { result } = await kilometer([5]);

    expect(result.isError).toBeUndefined();
    const out = structured(result);
    const midLon = lonAt(500);
    const endpoint = (lon: number) => ({
      lat: 0,
      lon,
      ground_elevation_m: 10,
      surface_elevation_m: 10,
      height_above_ground_m: 0,
      sightline_elevation_m: 10,
      dataset: 'srtm30m',
      resolution_m: 30.9,
    });
    expect(out).toMatchObject({
      verdict: 'clear',
      distance_m: 1_000,
      observer: endpoint(0),
      target: endpoint(lonAt(1_000)),
      min_clearance_m: 5,
      min_clearance_ft: 16.4,
      limiting_point: {
        lat: 0,
        lon: midLon,
        distance_from_observer_m: 500,
        terrain_elevation_m: 5,
        surface_elevation_m: 5,
        curvature_bulge_m: 0,
        sightline_elevation_m: 10,
        clearance_m: 5,
        dataset: 'srtm30m',
        resolution_m: 30.9,
      },
      obstructed_samples: 0,
      earth_model: 'flat',
      sample_interval_m: 500,
      samples: 3,
      samples_with_data: 3,
      missing_samples: 0,
      datasets_used: { usgs_3dep: 0, srtm30m: 3, mapzen: 0 },
      source_mode: 'opentopodata',
    });
    expect(out).not.toHaveProperty('first_obstruction');
    expect(out).not.toHaveProperty('refraction_coefficient');
    expect(out).not.toHaveProperty('effective_earth_radius_m');
    expect(out).not.toHaveProperty('notice');
  });

  it('is blocked at a clearance of exactly 0, with the first obstruction at the limiting point', async () => {
    const { result } = await kilometer([10]);
    const out = structured(result);
    expect(out.verdict).toBe('blocked');
    expect(out.min_clearance_m).toBe(0);
    expect(out.obstructed_samples).toBe(1);
    expect(out.first_obstruction).toEqual(out.limiting_point);
  });

  it('is blocked when terrain is above the sightline, with a negative clearance', async () => {
    const { result } = await kilometer([30]);
    const out = structured(result);
    expect(out.verdict).toBe('blocked');
    expect(out.min_clearance_m).toBe(-20);
    expect(out.min_clearance_ft).toBe(-65.6);
  });

  it('keeps the first obstruction nearest the observer apart from the deepest limiting point', async () => {
    const { result } = await kilometer([4, 12, 25, 12]);
    const out = structured(result);
    expect(out.verdict).toBe('blocked');
    expect(out.first_obstruction).toMatchObject({
      distance_from_observer_m: 400,
      clearance_m: -2,
      terrain_elevation_m: 12,
    });
    expect(out.limiting_point).toMatchObject({
      distance_from_observer_m: 600,
      clearance_m: -15,
      terrain_elevation_m: 25,
    });
    expect(out.obstructed_samples).toBe(3);
    expect(out.min_clearance_m).toBe(-15);
  });

  it('reads an obstruction with another interior sample missing as blocked, not indeterminate', async () => {
    const { result } = await kilometer([undefined, 50, 5]);
    const out = structured(result);
    expect(out.verdict).toBe('blocked');
    expect(out).toMatchObject({ samples_with_data: 4, missing_samples: 1 });
    expect(out.notice ?? '').not.toContain('no data and no sample with data blocks');
  });

  it('is indeterminate when an interior sample has no data and none that has data blocks', async () => {
    const { result } = await kilometer([5, undefined, 5]);
    const out = structured(result);
    expect(out.verdict).toBe('indeterminate');
    expect(out).toMatchObject({ samples_with_data: 4, missing_samples: 1, min_clearance_m: 5 });
    expect(out).not.toHaveProperty('first_obstruction');
    expect(out.limiting_point).toBeDefined();
  });

  it('is indeterminate with no minimum clearance when every interior sample is missing', async () => {
    const { result } = await kilometer([undefined]);
    const out = structured(result);
    expect(out.verdict).toBe('indeterminate');
    expect(out).not.toHaveProperty('min_clearance_m');
    expect(out).not.toHaveProperty('min_clearance_ft');
    expect(out).not.toHaveProperty('limiting_point');
    expect(out).toMatchObject({ obstructed_samples: 0, samples_with_data: 2, missing_samples: 1 });
    expect(contentText(result)).toContain(
      '**Minimum clearance:** not measured (no sample between the endpoints has data)',
    );
  });

  it('raises the sightline by the observer and target heights', async () => {
    useUpstreams({
      otd: lineOtd([
        [0, srtm(100)],
        [500, srtm(100)],
        [1_000, srtm(100)],
      ]),
    });
    const result = await run(
      equator(1_000, {
        earth_model: 'flat',
        observer_height_m: 20,
        target_height_m: 40,
        samples: 3,
      }),
    );
    const out = structured(result);
    expect(out.observer).toMatchObject({
      ground_elevation_m: 100,
      height_above_ground_m: 20,
      sightline_elevation_m: 120,
    });
    expect(out.target).toMatchObject({ height_above_ground_m: 40, sightline_elevation_m: 140 });
    expect(out.limiting_point).toMatchObject({ sightline_elevation_m: 130, clearance_m: 30 });
    expect(out.verdict).toBe('clear');
  });

  it('defaults to an observer at 1.7 m and a target on the ground', async () => {
    useUpstreams({
      otd: lineOtd([
        [0, srtm(100)],
        [500, srtm(100)],
        [1_000, srtm(100)],
      ]),
    });
    const out = structured(await run(equator(1_000, { earth_model: 'flat', samples: 3 })));
    expect(out.observer).toMatchObject({
      height_above_ground_m: 1.7,
      sightline_elevation_m: 101.7,
    });
    expect(out.target).toMatchObject({ height_above_ground_m: 0, sightline_elevation_m: 100 });
  });

  it('reports the 100-sample default in one Open Topo Data request', async () => {
    const http = useUpstreams({ otd: otdByPoint(() => srtm(0)) });
    const result = await run(equator(1_000));
    expect(structured(result).samples).toBe(100);
    expect(await otdRequests(http)).toHaveLength(1);
  });
});

describe('earth models on a 50 km line', () => {
  const level = lineOtd([
    [0, srtm(0)],
    [25_000, srtm(0)],
    [50_000, srtm(0)],
  ]);
  const fifty = (earth_model: string) =>
    useUpstreams({ otd: level }) &&
    run(equator(50_000, { earth_model, observer_height_m: 0, samples: 3 }));

  it.each([
    ['geometric', 49.05, 0, 6_371_008.8],
    ['optical', 42.67, 0.13, 7_322_998.6],
    ['radio', 36.79, 0.25, 8_494_678.4],
  ] as const)(
    '%s: midpoint bulge %d m, kappa %d, effective radius %d m',
    async (model, bulge, kappa, radius) => {
      const out = structured(await fifty(model));
      expect(out.verdict).toBe('blocked');
      expect(out.limiting_point.curvature_bulge_m).toBe(bulge);
      expect(out.limiting_point.clearance_m).toBe(-bulge);
      expect(out.earth_model).toBe(model);
      expect(out.refraction_coefficient).toBe(kappa);
      expect(out.effective_earth_radius_m).toBe(radius);
    },
  );

  it('flat: no bulge and no refraction fields, so level ground at sightline height just blocks', async () => {
    const out = structured(await fifty('flat'));
    expect(out.limiting_point).toMatchObject({ curvature_bulge_m: 0, clearance_m: 0 });
    expect(out.verdict).toBe('blocked');
    expect(out).not.toHaveProperty('refraction_coefficient');
    expect(out).not.toHaveProperty('effective_earth_radius_m');
  });

  it('defaults to optical', async () => {
    useUpstreams({ otd: level });
    const out = structured(await run(equator(50_000, { observer_height_m: 0, samples: 3 })));
    expect(out.earth_model).toBe('optical');
    expect(out.limiting_point.curvature_bulge_m).toBe(42.67);
  });

  it('lets a taller observer clear the bulge', async () => {
    useUpstreams({ otd: level });
    const out = structured(
      await run(equator(50_000, { earth_model: 'optical', observer_height_m: 100, samples: 3 })),
    );
    expect(out.verdict).toBe('clear');
    expect(out.limiting_point.clearance_m).toBeCloseTo(50 - 42.67, 1);
  });
});

describe('sea-surface case', () => {
  const sea = (midpoint: OtdAnswer) =>
    useUpstreams({
      otd: lineOtd([
        [0, mapzen(0)],
        [25_000, midpoint],
        [50_000, mapzen(0)],
      ]),
    });
  const fiftyKm = () => run(equator(50_000, { observer_height_m: 1.7, samples: 3 }));

  it('reads blocked: clearance is measured to 0 m, not to the -50 m sea floor', async () => {
    sea(mapzen(-50));
    const result = await fiftyKm();
    const out = structured(result);
    expect(out.verdict).toBe('blocked');
    expect(out.min_clearance_m).toBe(-41.82);
    expect(out.limiting_point).toMatchObject({
      distance_from_observer_m: 25_000,
      terrain_elevation_m: -50,
      surface_elevation_m: 0,
      curvature_bulge_m: 42.67,
      sightline_elevation_m: 0.85,
      clearance_m: -41.82,
      dataset: 'mapzen',
    });
    expect(out.first_obstruction).toEqual(out.limiting_point);
    expect(out.obstructed_samples).toBe(1);
    expect(structured(result).notice).toBe(
      '1 sample lies over open water, where Mapzen reports sea-floor depth, so clearance there is measured to the sea surface at 0 m.',
    );
    expect(out.attribution).toContain(MAPZEN_ATTRIBUTION);
  });

  it('would read clear against the same -50 m if the midpoint were SRTM land', async () => {
    sea(srtm(-50));
    const out = structured(await fiftyKm());
    expect(out.verdict).toBe('clear');
    expect(out.limiting_point).toMatchObject({ surface_elevation_m: -50, clearance_m: 8.18 });
    expect(out).not.toHaveProperty('notice');
  });

  it('measures an endpoint at -20 m from the sea surface and reports ground and surface apart', async () => {
    useUpstreams({
      otd: lineOtd([
        [0, mapzen(-20)],
        [500, mapzen(-30)],
        [1_000, mapzen(-10)],
      ]),
    });
    const out = structured(
      await run(
        equator(1_000, {
          earth_model: 'flat',
          observer_height_m: 2,
          target_height_m: 3,
          samples: 3,
        }),
      ),
    );
    expect(out.observer).toMatchObject({
      ground_elevation_m: -20,
      surface_elevation_m: 0,
      sightline_elevation_m: 2,
    });
    expect(out.target).toMatchObject({
      ground_elevation_m: -10,
      surface_elevation_m: 0,
      sightline_elevation_m: 3,
    });
    expect(out.notice).toContain('3 samples lie over open water');
  });

  it.each([
    ['Mapzen at exactly 0 m', mapzen(0)],
    ['Mapzen above sea level', mapzen(9)],
    ['SRTM below 0 m', srtm(-77)],
  ])('has no sea-surface note for %s', async (_name, answer) => {
    useUpstreams({ otd: otdByPoint(() => answer) });
    const result = await run(equator(1_000, { earth_model: 'flat', samples: 3 }));
    expect(structured(result).notice ?? '').not.toContain('open water');
  });
});

describe('same_endpoints on the wire', () => {
  it('rejects identical points and sends nothing upstream', async () => {
    const http = useUpstreams();
    const result = await run({ observer: { lat: 47, lon: -122 }, target: { lat: 47, lon: -122 } });
    const error = expectDeclaredError(
      checkLineOfSightTool,
      result,
      'same_endpoints',
      JsonRpcErrorCode.ValidationError,
    );
    expect(error.data).toMatchObject({ distance_m: 0 });
    expect(error.message).toBe(
      'Observer and target are 0 m apart; a sightline needs at least 1 m.',
    );
    expect(http.calls).toHaveLength(0);
  });

  it('rejects points under 1 m apart and reports their distance', async () => {
    const http = useUpstreams();
    const result = await run({
      observer: { lat: 0, lon: 0 },
      target: { lat: 0, lon: 0.000005 },
    });
    const error = expectDeclaredError(
      checkLineOfSightTool,
      result,
      'same_endpoints',
      JsonRpcErrorCode.ValidationError,
    );
    expect(error.data).toMatchObject({ distance_m: 0.56 });
    expect(error.message).toContain('0.56 m apart');
    expect(http.calls).toHaveLength(0);
  });

  it('accepts points just over 1 m apart', async () => {
    useUpstreams({ otd: otdByPoint(() => srtm(5)) });
    const result = await run({
      observer: { lat: 0, lon: 0 },
      target: { lat: 0, lon: 0.00001 },
      source: 'opentopodata',
      samples: 3,
    });
    expect(result.isError).toBeUndefined();
  });
});

describe('endpoint_no_data on the wire', () => {
  const failing = (answers: [number, OtdAnswer | undefined][]) => {
    useUpstreams({ otd: lineOtd(answers) });
    return run(equator(1_000, { samples: 3 }));
  };

  it('names a missing observer', async () => {
    const result = await failing([
      [500, srtm(5)],
      [1_000, srtm(10)],
    ]);
    const error = expectDeclaredError(
      checkLineOfSightTool,
      result,
      'endpoint_no_data',
      JsonRpcErrorCode.NotFound,
    );
    expect(error.data).toMatchObject({ observer_missing: true, target_missing: false });
    expect(error.message).toBe(
      'The observer has no elevation data in any queried dataset (source: opentopodata), so the sightline height there is unknown.',
    );
  });

  it('names a missing target', async () => {
    const result = await failing([
      [0, srtm(10)],
      [500, srtm(5)],
    ]);
    const error = expectDeclaredError(
      checkLineOfSightTool,
      result,
      'endpoint_no_data',
      JsonRpcErrorCode.NotFound,
    );
    expect(error.data).toMatchObject({ observer_missing: false, target_missing: true });
    expect(error.message).toContain('The target has no elevation data');
  });

  it('names both endpoints when neither has data', async () => {
    const result = await failing([[500, srtm(5)]]);
    const error = expectDeclaredError(
      checkLineOfSightTool,
      result,
      'endpoint_no_data',
      JsonRpcErrorCode.NotFound,
    );
    expect(error.data).toMatchObject({ observer_missing: true, target_missing: true });
    expect(error.message).toContain('Neither the observer nor the target has elevation data');
  });

  it('applies when the interior has data but an endpoint does not, under usgs_3dep', async () => {
    const http = useUpstreams({
      epqs: epqsAnswers({ [at(47.001, -122)]: { value: 40 } }),
    });
    const result = await run({ ...NA_LINE, samples: 3, source: 'usgs_3dep' });
    expect(errorOf(result).data?.reason).toBe('endpoint_no_data');
    expect(errorOf(result).message).toContain('(source: usgs_3dep)');
    expect(await otdRequests(http)).toHaveLength(0);
  });

  it('writes the attribution before failing', async () => {
    useUpstreams({ otd: lineOtd([[500, srtm(5)]]) });
    const ctx = createMockContext({ errors: checkLineOfSightTool.errors });
    await expect(
      checkLineOfSightTool.handler(
        checkLineOfSightTool.input.parse(equator(1_000, { samples: 3 })),
        ctx,
      ),
    ).rejects.toMatchObject({ data: { reason: 'endpoint_no_data' } });
    expect(getEnrichment(ctx).attribution).toContain('SRTM GL1 v3');
  });

  it('writes the no-dataset attribution when nothing answered at all', async () => {
    useUpstreams({ otd: otdAnswers({}) });
    const ctx = createMockContext({ errors: checkLineOfSightTool.errors });
    await expect(
      checkLineOfSightTool.handler(
        checkLineOfSightTool.input.parse(equator(1_000, { samples: 3 })),
        ctx,
      ),
    ).rejects.toMatchObject({ data: { reason: 'endpoint_no_data' } });
    expect(getEnrichment(ctx)).toMatchObject({ attribution: NO_DATASET_ATTRIBUTION });
  });
});

describe('attribution on every success path', () => {
  const USGS = 'USGS 3D Elevation Program (3DEP)';
  const SRTM = 'SRTM GL1 v3 via Open Topo Data';
  const MAPZEN = 'Mapzen terrain tiles via Open Topo Data:';
  const flatLine = (elevation: OtdAnswer) => ({
    otd: lineOtd([
      [0, elevation],
      [500, elevation],
      [1_000, elevation],
    ]),
  });

  it.each([
    [
      '3DEP only',
      {
        epqs: epqsAnswers({
          [at(47, -122)]: { value: 5 },
          [at(47.001, -122)]: { value: 5 },
          [at(47.002, -122)]: { value: 5 },
        }),
      },
      { ...NA_LINE, samples: 3, source: 'usgs_3dep' },
      [USGS],
      [SRTM, MAPZEN],
    ],
    ['SRTM only', flatLine(srtm(5)), equator(1_000, { samples: 3 }), [SRTM], [USGS, MAPZEN]],
    [
      'Mapzen only',
      flatLine(mapzen(5)),
      equator(1_000, { samples: 3 }),
      [MAPZEN, MAPZEN_ATTRIBUTION],
      [USGS, SRTM],
    ],
    [
      'SRTM and Mapzen',
      {
        otd: lineOtd([
          [0, srtm(5)],
          [500, mapzen(2)],
          [1_000, mapzen(5)],
        ]),
      },
      equator(1_000, { samples: 3 }),
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
      epqs: epqsAnswers({ [at(47, -122)]: { value: 5, resolution: 1 } }),
      otd: otdAnswers({ [at(47.001, -122)]: srtm(6), [at(47.002, -122)]: mapzen(7) }),
    });
    const attribution = structured(await run({ ...NA_LINE, samples: 3 })).attribution as string;
    expect(attribution.indexOf(USGS)).toBeGreaterThanOrEqual(0);
    expect(attribution.indexOf(USGS)).toBeLessThan(attribution.indexOf(SRTM));
    expect(attribution.indexOf(SRTM)).toBeLessThan(attribution.indexOf(MAPZEN));
  });

  it('also carries it when the call has a notice', async () => {
    const { result } = await kilometer([undefined]);
    expect(structured(result).notice).toBeTypeOf('string');
    expect(structured(result).attribution).toContain(SRTM);
  });

  describe('zero-result and under-cap pages', () => {
    it('a line whose endpoints have no data is an endpoint_no_data failure, not an empty page', async () => {
      useUpstreams({ otd: otdAnswers({}) });
      const result = await run(equator(1_000, { samples: 3 }));
      expect(result.isError).toBe(true);
      expect(errorOf(result).data?.reason).toBe('endpoint_no_data');
      expect(structured(result)).not.toHaveProperty('verdict');
    });

    it('the thinnest success page, endpoints only (3 samples, interior missing), carries its attribution', async () => {
      const { result } = await kilometer([undefined]);
      expect(result.isError).toBeUndefined();
      expect(structured(result)).toMatchObject({ samples: 3, samples_with_data: 2 });
      expect(structured(result).attribution).toContain(SRTM);
    });

    it('an under-cap page (3 of 250 samples) validates against the output and enrichment schemas', async () => {
      const { result } = await kilometer([5]);
      expect(result.isError).toBeUndefined();
      expect(checkLineOfSightTool.output.safeParse(structured(result)).success).toBe(true);
    });

    it('the 250-sample cap page returns a complete result', async () => {
      useUpstreams({ otd: otdByPoint(() => srtm(0)) });
      const result = await run(equator(1_000, { samples: 250 }));
      expect(structured(result).samples).toBe(250);
      expect(structured(result).samples_with_data).toBe(250);
      expect(structured(result).attribution).toContain(SRTM);
    });
  });
});

describe('notices', () => {
  it('omits the notice when nothing needs saying', async () => {
    const { result } = await kilometer([5]);
    expect(structured(result)).not.toHaveProperty('notice');
    expect(contentText(result)).not.toContain('\n> ');
  });

  it.each([
    [
      [5, undefined, 5],
      '1 interior sample has no data and no sample with data blocks the line, so the sightline cannot be confirmed clear; check the gap with elevation_get_profile on the same two points, or re-call elevation_check_line_of_sight with source auto to query both providers.',
    ],
    [
      [undefined, undefined, 5],
      '2 interior samples have no data and no sample with data blocks the line, so the sightline cannot be confirmed clear; check the gap with elevation_get_profile on the same two points, or re-call elevation_check_line_of_sight with source auto to query both providers.',
    ],
  ])(
    'flags an indeterminate verdict, counting interior samples without data (%#)',
    async (interior, expected) => {
      const { result } = await kilometer(interior);
      expect(structured(result).verdict).toBe('indeterminate');
      expect(structured(result).notice).toBe(expected);
      expect(contentText(result)).toContain(`> ${expected}`);
    },
  );

  it('does not count the endpoints as interior samples', async () => {
    const { result } = await kilometer([undefined]);
    expect(structured(result).notice).toContain('1 interior sample has no data');
  });

  it('warns when a clear verdict has under 2 m of clearance, naming the distance', async () => {
    const { result } = await kilometer([9]);
    expect(structured(result)).toMatchObject({ verdict: 'clear', min_clearance_m: 1 });
    expect(structured(result).notice).toBe(
      'Minimum clearance is under 2 m at 500 m from the observer; DEM vertical error, vegetation, and structures can close a margin that small.',
    );
  });

  it.each([
    ['2 m', 8, false],
    ['just under 2 m', 8.01, true],
  ])(
    'treats a clearance of %s against the 2 m threshold (warns: %s)',
    async (_name, terrain, warns) => {
      const { result } = await kilometer([terrain]);
      expect(structured(result).verdict).toBe('clear');
      expect(structured(result).notice !== undefined).toBe(warns);
    },
  );

  it('does not add the thin-margin note to a blocked verdict', async () => {
    const { result } = await kilometer([10]);
    expect(structured(result).verdict).toBe('blocked');
    expect(structured(result)).not.toHaveProperty('notice');
  });

  it('flags a line that crosses the 3DEP coverage edge, with counts', async () => {
    useUpstreams({
      epqs: epqsAnswers({
        [at(47, -122)]: { value: 50, resolution: 1 },
        [at(47.002, -122)]: { value: 60, resolution: 1 },
      }),
      otd: otdAnswers({ [at(47.001, -122)]: srtm(30) }),
    });
    const result = await run({ ...NA_LINE, samples: 3, earth_model: 'flat', observer_height_m: 0 });
    expect(structured(result).notice).toBe(
      'The line crosses the USGS 3DEP coverage edge (2 samples from USGS 3DEP, 1 from Open Topo Data); clearances compare terrain of different resolution and surface model.',
    );
  });

  it('has no coverage-edge note when one provider answered every sample', async () => {
    const { result } = await kilometer([5]);
    expect(structured(result).notice ?? '').not.toContain('coverage edge');
  });

  it.each([
    [1, [mapzen(-40), srtm(30)], '1 sample lies over open water'],
    [2, [mapzen(-40), mapzen(-41)], '2 samples lie over open water'],
  ])('flags %i sea-floor sample(s) and agrees in number', async (_count, interior, expected) => {
    useUpstreams({
      otd: lineOtd([
        [0, srtm(10)],
        [1_000 / 3, interior[0]],
        [2_000 / 3, interior[1]],
        [1_000, srtm(10)],
      ]),
    });
    const result = await run(
      equator(1_000, { earth_model: 'flat', observer_height_m: 0, samples: 4 }),
    );
    expect(structured(result).notice).toContain(expected);
  });

  it('joins an indeterminate, an edge, and a sea-surface fragment in the design order', async () => {
    useUpstreams({
      epqs: epqsAnswers({ [at(47, -122)]: { value: 50, resolution: 1 } }),
      otd: otdAnswers({ [at(47.002, -122)]: mapzen(-5) }),
    });
    const result = await run({ ...NA_LINE, samples: 3 });
    expect(structured(result).verdict).toBe('indeterminate');
    expect(structured(result).notice).toBe(
      '1 interior sample has no data and no sample with data blocks the line, so the sightline cannot be confirmed clear; check the gap with elevation_get_profile on the same two points. ' +
        'The line crosses the USGS 3DEP coverage edge (1 sample from USGS 3DEP, 1 from Open Topo Data); clearances compare terrain of different resolution and surface model. ' +
        '1 sample lies over open water, where Mapzen reports sea-floor depth, so clearance there is measured to the sea surface at 0 m.',
    );
  });

  it('joins a thin-margin, an edge, and a sea-surface fragment in the design order', async () => {
    useUpstreams({
      epqs: epqsAnswers({ [at(47, -122)]: { value: 50, resolution: 1 } }),
      otd: otdAnswers({ [at(47.001, -122)]: srtm(25), [at(47.002, -122)]: mapzen(-5) }),
    });
    const result = await run({ ...NA_LINE, samples: 3, observer_height_m: 1.7 });
    expect(structured(result).verdict).toBe('clear');
    expect(structured(result).notice).toBe(
      'Minimum clearance is under 2 m at 111.2 m from the observer; DEM vertical error, vegetation, and structures can close a margin that small. ' +
        'The line crosses the USGS 3DEP coverage edge (1 sample from USGS 3DEP, 2 from Open Topo Data); clearances compare terrain of different resolution and surface model. ' +
        '1 sample lies over open water, where Mapzen reports sea-floor depth, so clearance there is measured to the sea surface at 0 m.',
    );
  });
});

describe('source modes', () => {
  it('usgs_3dep sends nothing to Open Topo Data', async () => {
    const http = useUpstreams({
      epqs: epqsByPoint(() => epqsResponse(epqsHitBody({ value: '20', resolution: 1 }))),
    });
    const result = await run({ ...NA_LINE, samples: 3, source: '3dep', earth_model: 'flat' });
    expect(structured(result).source_mode).toBe('usgs_3dep');
    expect(structured(result).datasets_used).toEqual({ usgs_3dep: 3, srtm30m: 0, mapzen: 0 });
    expect(await otdRequests(http)).toHaveLength(0);
    expect(epqsRequestCount(http)).toBe(3);
  });

  it('opentopodata sends nothing to 3DEP', async () => {
    const http = useUpstreams({ otd: otdByPoint(() => srtm(20)) });
    const result = await run({ ...NA_LINE, samples: 3, source: 'Open Topo Data' });
    expect(structured(result).source_mode).toBe('opentopodata');
    expect(epqsRequestCount(http)).toBe(0);
  });

  it('auto routes a line outside 3DEP coverage to Open Topo Data alone', async () => {
    const http = useUpstreams({ otd: otdByPoint(() => srtm(20)) });
    const result = await run({
      observer: { lat: 47, lon: 10 },
      target: { lat: 47.002, lon: 10 },
      samples: 3,
    });
    expect(structured(result).source_mode).toBe('auto');
    expect(epqsRequestCount(http)).toBe(0);
  });

  it('reports each endpoint with its own dataset and resolution, and Mapzen with no resolution', async () => {
    useUpstreams({
      epqs: epqsAnswers({ [at(47, -122)]: { value: 50, resolution: 1 } }),
      otd: otdAnswers({ [at(47.001, -122)]: srtm(30), [at(47.002, -122)]: mapzen(60) }),
    });
    const out = structured(await run({ ...NA_LINE, samples: 3 }));
    expect(out.observer).toMatchObject({ dataset: 'usgs_3dep', resolution_m: 1 });
    expect(out.target).toMatchObject({ dataset: 'mapzen' });
    expect(out.target).not.toHaveProperty('resolution_m');
    expect(out.limiting_point).toMatchObject({ dataset: 'srtm30m', resolution_m: 30.9 });
  });
});

describe('format()', () => {
  const point = {
    lat: 0,
    lon: 0.004497,
    distance_from_observer_m: 500,
    terrain_elevation_m: 25,
    surface_elevation_m: 25,
    curvature_bulge_m: 0.31,
    sightline_elevation_m: 12.5,
    clearance_m: -12.81,
    dataset: 'mapzen' as const,
  };
  const endpoint = (lon: number, dataset: 'usgs_3dep' | 'mapzen') => ({
    lat: 0,
    lon,
    ground_elevation_m: 10,
    surface_elevation_m: 10,
    height_above_ground_m: 2,
    sightline_elevation_m: 12,
    dataset,
    ...(dataset === 'usgs_3dep' && { resolution_m: 1 }),
  });
  const blocked = () =>
    checkLineOfSightTool.output.parse({
      verdict: 'blocked',
      distance_m: 1000,
      observer: endpoint(0, 'usgs_3dep'),
      target: endpoint(0.008993, 'mapzen'),
      min_clearance_m: -12.81,
      min_clearance_ft: -42,
      limiting_point: point,
      first_obstruction: { ...point, distance_from_observer_m: 400, lon: 0.003597 },
      obstructed_samples: 3,
      earth_model: 'radio',
      refraction_coefficient: 0.25,
      effective_earth_radius_m: 8494678.4,
      sample_interval_m: 100,
      samples: 11,
      samples_with_data: 10,
      missing_samples: 1,
      datasets_used: { usgs_3dep: 4, srtm30m: 0, mapzen: 6 },
      source_mode: 'auto',
    });

  const textOf = (output: ReturnType<typeof blocked>) => {
    const [block] = checkLineOfSightTool.format?.(output) ?? [];
    return block?.type === 'text' ? block.text : '';
  };

  it('prints every output value', () => {
    const output = blocked();
    const text = textOf(output);
    for (const leaf of leafStrings(output)) expect(text).toContain(leaf);
  });

  it('heads with the verdict and lists observer, target, distance, clearance, and both terrain points', () => {
    const text = textOf(blocked());
    expect(text).toContain('## Line of sight: blocked');
    expect(text).toContain('- **Observer:** 0, 0; ground 10 m');
    expect(text).toContain('- **Target:** 0, 0.008993; ground 10 m');
    expect(text).toContain('- **Distance:** 1000 m (1 km)');
    expect(text).toContain('- **Minimum clearance:** -12.81 m (-42 ft)');
    expect(text).toContain('- **Limiting point:** 0, 0.004497 at 500 m from the observer');
    expect(text).toContain('- **First obstruction:** 0, 0.003597 at 400 m from the observer');
    expect(text).toContain('- **Obstructed samples:** 3');
  });

  it('shows resolution for 3DEP and "varies" for Mapzen', () => {
    const text = textOf(blocked());
    expect(text).toContain('(usgs_3dep, resolution 1 m)');
    expect(text).toContain('(mapzen, resolution varies)');
  });

  it('states the earth model with its refraction coefficient and effective radius', () => {
    expect(textOf(blocked())).toContain(
      '- **Earth model:** radio (refraction coefficient 0.25, effective earth radius 8494678.4 m)',
    );
  });

  it('prints (no curvature) for the flat model and omits the first obstruction when clear', () => {
    const {
      first_obstruction: _drop,
      refraction_coefficient: _k,
      effective_earth_radius_m: _r,
      ...rest
    } = blocked();
    const clear = checkLineOfSightTool.output.parse({
      ...rest,
      verdict: 'clear',
      earth_model: 'flat',
    });
    const text = textOf(clear);
    expect(text).toContain('## Line of sight: clear');
    expect(text).toContain('- **Earth model:** flat (no curvature)');
    expect(text).not.toContain('First obstruction');
  });

  it('says the clearance is not measured when no interior sample has data', () => {
    const {
      min_clearance_m: _m,
      min_clearance_ft: _f,
      limiting_point: _l,
      first_obstruction: _o,
      ...rest
    } = blocked();
    const text = textOf(
      checkLineOfSightTool.output.parse({
        ...rest,
        verdict: 'indeterminate',
        obstructed_samples: 0,
      }),
    );
    expect(text).toContain('not measured (no sample between the endpoints has data)');
    expect(text).not.toContain('Limiting point');
  });

  it('is the text content[] carries for a live result, plus the notice and Sources trailer', async () => {
    useUpstreams({
      epqs: epqsAnswers({ [at(47, -122)]: { value: 50, resolution: 1 } }),
      otd: otdAnswers({ [at(47.001, -122)]: srtm(25), [at(47.002, -122)]: mapzen(-5) }),
    });
    const result = await run({ ...NA_LINE, samples: 3 });
    const { attribution, notice, ...rest } = structured(result);
    const text = contentText(result);
    expect(text.startsWith(textOf(checkLineOfSightTool.output.parse(rest)))).toBe(true);
    expect(text).toContain(`> ${notice}`);
    expect(text).toContain(`**Sources:** ${attribution}`);
  });

  it('carries every structuredContent value in content[] for live blocked and indeterminate results', async () => {
    const blockedRun = await kilometer([4, 12, 25, 12]);
    const gapRun = await kilometer([5, undefined, 5]);
    for (const { result } of [blockedRun, gapRun]) {
      const { attribution: _attribution, notice: _notice, ...rest } = structured(result);
      const text = contentText(result);
      for (const leaf of leafStrings(rest)) expect(text).toContain(leaf);
    }
  });

  describe('upstream text', () => {
    const hostile =
      '6/5/2021\r\n| injected | row |\r\n# Heading\n[link](https://evil.test) <b>x</b>';

    it('never reaches either surface: the result carries no upstream-authored text', async () => {
      useUpstreams({
        epqs: epqsByPoint(() =>
          epqsResponse(epqsHitBody({ acquisitionDate: hostile, resolution: 1 })),
        ),
      });
      const result = await run({ ...NA_LINE, samples: 3, source: 'usgs_3dep' });
      expect(result.isError).toBeUndefined();
      const everything = JSON.stringify(result.structuredContent) + contentText(result);
      expect(everything).not.toContain('injected');
      expect(everything).not.toContain('evil.test');
      expect(everything).not.toContain('acquisition');
    });

    it('keeps the verdict heading on one line and one line per field when upstream text carries line breaks', async () => {
      useUpstreams({
        epqs: epqsByPoint((point) =>
          epqsResponse(epqsHitBody({ acquisitionDate: `a\r\nb\nc\r${point.lat}`, value: '10' })),
        ),
      });
      const result = await run({ ...NA_LINE, samples: 3, source: 'usgs_3dep' });
      const lines = contentText(result).split('\n');
      expect(lines[0]).toMatch(/^## Line of sight: (clear|blocked|indeterminate)$/);
      expect(lines.some((line) => line.includes('\r'))).toBe(false);
      expect(lines.filter((line) => line.startsWith('- **Observer:**'))).toHaveLength(1);
    });
  });
});

describe('reroute clause on the indeterminate notice', () => {
  it.each([
    ['auto', false],
    ['opentopodata', true],
  ])('under source %s the clause is present: %s', async (source, present) => {
    useUpstreams({ otd: otdAnswers({ [at(47, 10)]: srtm(5), [at(47.002, 10)]: srtm(5) }) });
    const result = await run({
      observer: { lat: 47, lon: 10 },
      target: { lat: 47.002, lon: 10 },
      samples: 3,
      source,
    });
    expect(structured(result).verdict).toBe('indeterminate');
    const notice = structured(result).notice as string;
    expect(
      notice.includes(
        ', or re-call elevation_check_line_of_sight with source auto to query both providers',
      ),
    ).toBe(present);
  });
});

/**
 * @fileoverview Tests for ElevationSampler: rounding and dedupe fan-back, the
 * coverage envelope, source routing, fallback on a coverage miss only,
 * chunking at 100, the sampling budget, fail-fast, cancellation, and the
 * service lifecycle.
 * @module tests/services/elevation-sampler.test
 */

import { JsonRpcErrorCode, McpError } from '@cyanheads/mcp-ts-core/errors';
import {
  createFetchMock,
  createMockContext,
  type MockContextLogger,
} from '@cyanheads/mcp-ts-core/testing';
import { createPacer } from '@cyanheads/mcp-ts-core/utils';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import {
  COVERAGE_ENVELOPE,
  disposeElevationServices,
  ElevationSampler,
  getElevationSampler,
  initElevationServices,
  insideCoverageEnvelope,
  OPENTOPODATA_CHUNK_SIZE,
  SAMPLING_BUDGET_MS,
} from '@/services/elevation/elevation-sampler.js';
import type { LatLon, SourceMode } from '@/services/elevation/types.js';
import { OpenTopoDataClient } from '@/services/opentopodata/opentopodata-client.js';
import { UsgsEpqsClient } from '@/services/usgs-epqs/usgs-epqs-client.js';
import { UsgsImageServer } from '@/services/usgs-epqs/usgs-image-server.js';
import {
  EPQS_MISS_TEXTS,
  EPQS_ORIGIN,
  EPQS_RESOLUTION_ONE_ARCSEC,
  epqsHitBody,
  epqsResponse,
} from '../fixtures/epqs.js';
import {
  epqsByPoint,
  epqsRoute,
  hangUntilAborted,
  otdByPoint,
  otdRoute,
  permissivePacer,
  rejectionWithFakeTimers,
  settleWithFakeTimers,
} from '../fixtures/harness.js';
import {
  OTD_PUBLIC_BASE_URL,
  OTD_SELF_HOSTED_BASE_URL,
  otdResponse,
  parseSentLocations,
} from '../fixtures/opentopodata.js';
import {
  CATALOG_URL,
  catalogResponse,
  catalogRoute,
  defaultCatalogResponse,
  IMAGE_SAMPLE_URL,
  imageSampleRow,
  imageSamplesRoute,
  parseImageSamplePoints,
} from '../fixtures/usgs-image-server.js';

const SEATTLE: LatLon = { lat: 47.6062, lon: -122.3321 };
const LONDON: LatLon = { lat: 51.5074, lon: -0.1278 };
const SYDNEY: LatLon = { lat: -33.8688, lon: 151.2093 };

type EpqsResponder = (request: Request) => Response | Promise<Response>;
type OtdResponder = (request: Request) => Response | Promise<Response>;

const unexpected: EpqsResponder = () => new Response('unexpected upstream call', { status: 418 });

interface HarnessOptions {
  budgetMs?: number;
  catalog?: EpqsResponder;
  epqs?: EpqsResponder;
  imageSamples?: EpqsResponder;
  now?: () => number;
  otd?: OtdResponder;
}

function harness({
  budgetMs,
  catalog = defaultCatalogResponse,
  epqs = unexpected,
  imageSamples = () =>
    Response.json({ samples: [imageSampleRow(SEATTLE, 0, { value: '52.377716064' })] }),
  now,
  otd = unexpected,
}: HarnessOptions = {}) {
  const http = createFetchMock([
    epqsRoute(epqs),
    imageSamplesRoute(imageSamples),
    catalogRoute(catalog),
    otdRoute(OTD_PUBLIC_BASE_URL, otd),
  ]);
  const epqsClient = new UsgsEpqsClient({ fetch: http.fetch, pacer: permissivePacer('epqs') });
  const openTopoData = new OpenTopoDataClient({
    baseUrl: OTD_PUBLIC_BASE_URL,
    fetch: http.fetch,
    pacer: permissivePacer('otd'),
    dailyPacer: permissivePacer('otd-daily'),
  });
  const sampler = new ElevationSampler({
    epqs: epqsClient,
    imageServer: new UsgsImageServer(http.fetch),
    openTopoData,
    ...(budgetMs !== undefined && { budgetMs }),
    ...(now !== undefined && { now }),
  });
  const callsTo = (upstream: 'epqs' | 'otd' | 'batch' | 'catalog') =>
    http.calls.filter(({ request }) => {
      if (upstream === 'batch') return request.url === IMAGE_SAMPLE_URL;
      if (upstream === 'catalog') return request.url === CATALOG_URL;
      return (
        new URL(request.url).origin === (upstream === 'epqs' ? EPQS_ORIGIN : OTD_PUBLIC_BASE_URL)
      );
    });
  const otdLocations = async () =>
    Promise.all(callsTo('otd').map(async (call) => parseSentLocations(await call.request.text())));
  return { callsTo, http, otdLocations, sampler };
}

function mcpData(error: unknown): Record<string, unknown> {
  expect(error).toBeInstanceOf(McpError);
  return (error as McpError).data ?? {};
}

describe('constants', () => {
  it('uses a 45 s budget and 100-point Open Topo Data chunks', () => {
    expect(SAMPLING_BUDGET_MS).toBe(45_000);
    expect(OPENTOPODATA_CHUNK_SIZE).toBe(100);
  });
});

describe('coverage envelope', () => {
  it('lists the four documented boxes', () => {
    expect(COVERAGE_ENVELOPE).toEqual([
      { south: 5, north: 84, west: -180, east: -50 },
      { south: 50, north: 56, west: 170, east: 180 },
      { south: 10, north: 21, west: 144, east: 167 },
      { south: -15, north: -10, west: -172, east: -168 },
    ]);
  });

  it.each([
    ['Seattle', 47.6062, -122.3321],
    ['Utqiagvik', 71.2906, -156.7886],
    ['Honolulu', 21.3069, -157.8583],
    ['San Juan', 18.4655, -66.1057],
    ['St. Thomas', 18.3358, -64.8963],
    ['Vancouver', 49.2827, -123.1207],
    ['Yellowknife', 62.454, -114.3718],
    ['Whitehorse', 60.7212, -135.0568],
    ['Ottawa', 45.4215, -75.6972],
    ['Mexico City', 19.4326, -99.1332],
    ['Oaxaca', 17.0732, -96.7266],
    ['Attu', 52.8833, 172.9],
    ['Guam', 13.4443, 144.7937],
    ['Saipan', 15.1778, 145.7545],
    ['Pago Pago', -14.2756, -170.702],
    ['open Pacific inside the North America box', 30, -140],
    ['Havana (inside the box, though EPQS misses it)', 23.1136, -82.3666],
  ])('puts %s inside', (_name, lat, lon) => {
    expect(insideCoverageEnvelope({ lat, lon })).toBe(true);
  });

  it.each([
    ['London', 51.5074, -0.1278],
    ['Tromsø', 69.6492, 18.9553],
    ['Sydney', -33.8688, 151.2093],
    ['Tokyo', 35.6762, 139.6503],
    ['Cape Town', -33.9249, 18.4241],
    ['McMurdo', -77.846, 166.668],
    ['40°N 180°', 40, 180],
    ['the South Pole', -90, 0],
    ['Reykjavik (east of -50 longitude)', 64.1466, -21.9426],
  ])('puts %s outside', (_name, lat, lon) => {
    expect(insideCoverageEnvelope({ lat, lon })).toBe(false);
  });

  it.each([
    ['south edge of North America', 5, -100, true],
    ['just south of North America', 4.99, -100, false],
    ['north edge of North America', 84, -100, true],
    ['just north of North America', 84.01, -100, false],
    ['east edge of North America', 47, -50, true],
    ['just east of North America', 47, -49.99, false],
    ['west edge of North America', 47, -180, true],
    ['Western Aleutians west edge', 53, 170, true],
    ['Western Aleutians east edge at the antimeridian', 53, 180, true],
    ['Western Aleutians south edge', 50, 175, true],
    ['just south of the Western Aleutians', 49.99, 175, false],
    ['just north of the Western Aleutians', 56.01, 175, false],
    ['Marianas south-west corner', 10, 144, true],
    ['Marianas north-east corner', 21, 167, true],
    ['just east of the Marianas', 20, 167.01, false],
    ['American Samoa south-west corner', -15, -172, true],
    ['American Samoa north-east corner', -10, -168, true],
    ['just south of American Samoa', -15.01, -170, false],
    ['just north of American Samoa', -9.99, -170, false],
  ])('treats the %s as edge-inclusive (%s)', (_name, lat, lon, inside) => {
    expect(insideCoverageEnvelope({ lat, lon })).toBe(inside);
  });
});

describe('ElevationSampler.sample: output shape', () => {
  it('uses EPQS for point mode and dedupes rounded positions before lookup', async () => {
    const { callsTo, sampler } = harness({ epqs: () => epqsResponse(epqsHitBody()) });
    const samples = await sampler.sample(
      [SEATTLE, { lat: SEATTLE.lat + 0.0000001, lon: SEATTLE.lon }],
      'usgs_3dep',
      createMockContext(),
    );
    expect(samples.map((sample) => sample.elevation_m)).toEqual([52.38, 52.38]);
    expect(callsTo('epqs')).toHaveLength(1);
  });

  it('uses a catalog epoch rather than the ambiguous EPQS date text', async () => {
    const { sampler } = harness({ epqs: () => epqsResponse(epqsHitBody()) });
    const samples = await sampler.sample([SEATTLE], 'usgs_3dep', createMockContext());
    expect(samples[0]?.acquisition_date).toBe('2021-07-09');
  });

  it('takes computed elevations from ImageServer even when EPQS cannot answer', async () => {
    const { callsTo, sampler } = harness();
    const samples = await sampler.sample([SEATTLE], 'usgs_3dep', createMockContext(), 'computed');
    expect(samples).toEqual([{ ...SEATTLE, dataset: 'usgs_3dep', elevation_m: 52.38 }]);
    expect(callsTo('epqs')).toHaveLength(0);
  });

  it('rounds coordinates to 6 decimals, elevation to 2, resolution to 1, and carries 3DEP extras', async () => {
    const { sampler } = harness({
      epqs: epqsByPoint(() =>
        epqsResponse(
          epqsHitBody({
            value: '52.377716064',
            resolution: EPQS_RESOLUTION_ONE_ARCSEC,
            rasterId: 102575,
            acquisitionDate: '6/5/2021',
          }),
        ),
      ),
    });
    const samples = await sampler.sample(
      [{ lat: 47.60620049, lon: -122.33209951 }],
      'auto',
      createMockContext(),
    );
    expect(samples).toStrictEqual([
      {
        lat: 47.6062,
        lon: -122.3321,
        elevation_m: 52.38,
        dataset: 'usgs_3dep',
        resolution_m: 30.9,
        raster_id: 102575,
        acquisition_date: '2021-07-09',
      },
    ]);
  });

  it('sends the rounded coordinates upstream', async () => {
    const { callsTo, sampler } = harness({
      epqs: epqsByPoint(() => epqsResponse(epqsHitBody())),
    });
    await sampler.sample([{ lat: 47.60620049, lon: -122.33209951 }], 'auto', createMockContext());
    const params = new URL(callsTo('epqs')[0]!.request.url).searchParams;
    expect(params.get('y')).toBe('47.606200');
    expect(params.get('x')).toBe('-122.332100');
  });

  it('answers a point no dataset covers with only lat and lon, never an error', async () => {
    const { sampler } = harness({
      epqs: () => epqsResponse(EPQS_MISS_TEXTS.callFailed),
      otd: otdByPoint(() => ({ dataset: 'mapzen', elevation: null })),
    });
    const samples = await sampler.sample([SEATTLE], 'auto', createMockContext());
    expect(samples).toStrictEqual([{ lat: 47.6062, lon: -122.3321 }]);
  });

  it('never reports a negative zero coordinate', async () => {
    const { sampler } = harness({ otd: otdByPoint() });
    const [sample] = await sampler.sample(
      [{ lat: -1e-7, lon: -4e-7 }],
      'opentopodata',
      createMockContext(),
    );
    expect(Object.is(sample?.lat, 0)).toBe(true);
    expect(Object.is(sample?.lon, 0)).toBe(true);
  });

  it('returns an empty list for no points and sends nothing', async () => {
    const { http, sampler } = harness();
    await expect(sampler.sample([], 'auto', createMockContext())).resolves.toEqual([]);
    expect(http.calls).toHaveLength(0);
  });

  it('rounds an Open Topo Data value: whole meters, 30.9 m for SRTM, no resolution for Mapzen', async () => {
    const { sampler } = harness({
      otd: otdByPoint((point) =>
        point.lat > 0
          ? { dataset: 'srtm30m', elevation: 59 }
          : { dataset: 'mapzen', elevation: -4389 },
      ),
    });
    const samples = await sampler.sample(
      [SEATTLE, { lat: -30, lon: -140 }],
      'opentopodata',
      createMockContext(),
    );
    expect(samples).toStrictEqual([
      { lat: 47.6062, lon: -122.3321, elevation_m: 59, dataset: 'srtm30m', resolution_m: 30.9 },
      { lat: -30, lon: -140, elevation_m: -4389, dataset: 'mapzen' },
    ]);
  });
});

const usgsColumn = (count: number, lon = -105): LatLon[] =>
  Array.from({ length: count }, (_, index) => ({ lat: 40 + index / 1000, lon }));

describe('ElevationSampler.sample: computed ImageServer phase', () => {
  beforeEach(() => vi.useFakeTimers());
  afterEach(() => vi.useRealTimers());

  it('sends consecutive chunks of up to 50 deduped positions with explicit nearest-neighbor sampling', async () => {
    const batches: LatLon[][] = [];
    const points = usgsColumn(101);
    const { callsTo, sampler } = harness({
      imageSamples: async (request) => {
        expect(request.headers.get('user-agent')).toBe('elevation-mcp-server');
        const fields = new URLSearchParams(await request.clone().text());
        expect(Object.fromEntries(fields)).toMatchObject({
          f: 'json',
          geometryType: 'esriGeometryMultipoint',
          interpolation: 'RSP_NearestNeighbor',
          returnFirstValueOnly: 'true',
        });
        expect(fields.has('outFields')).toBe(false);
        expect(JSON.parse(fields.get('geometry')!)).toHaveProperty('spatialReference', {
          wkid: 4326,
        });
        const batch = await parseImageSamplePoints(request);
        batches.push(batch);
        return Response.json({
          samples: batch
            .map((point, id) => imageSampleRow(point, id, { value: point.lat }))
            .reverse(),
        });
      },
    });
    const samples = await sampler.sample(
      [...points, points[0]!],
      'usgs_3dep',
      createMockContext(),
      'computed',
    );
    expect(batches).toEqual([points.slice(0, 50), points.slice(50, 100), points.slice(100)]);
    expect(samples).toHaveLength(102);
    expect(samples[50]).toMatchObject({ ...points[50], elevation_m: 40.05 });
    expect(samples[101]).toEqual(samples[0]);
    expect(callsTo('epqs')).toHaveLength(0);
    expect(callsTo('catalog')).toHaveLength(0);
  });

  it('keeps reordered valid hits and asks EPQS to confirm ambiguous, malformed, and missing offsets', async () => {
    const points = usgsColumn(7);
    const { callsTo, otdLocations, sampler } = harness({
      imageSamples: () =>
        Response.json({
          samples: [
            imageSampleRow(points[4]!, 4, {
              value: '-14.12',
              rasterId: 8857,
              resolution: 0.0000308642,
            }),
            imageSampleRow(points[2]!, 2, { value: '71' }),
            imageSampleRow(points[2]!, 2, { value: '72' }),
            imageSampleRow(points[0]!, 0, { value: '22.789', rasterId: 103728, resolution: 1 }),
            imageSampleRow(points[0]!, 3, { value: '73' }),
            imageSampleRow(points[5]!, 5, { value: '-1000000' }),
            imageSampleRow(points[0]!, 200, { value: '100' }),
            imageSampleRow(points[6]!, 6.1, { value: '99' }),
          ],
        }),
      epqs: epqsByPoint((point) =>
        point.lat === points[3]!.lat
          ? epqsResponse(EPQS_MISS_TEXTS.callFailed)
          : epqsResponse(epqsHitBody({ value: '96' })),
      ),
      otd: otdByPoint(),
    });
    const samples = await sampler.sample(points, 'auto', createMockContext(), 'computed');
    expect(samples.map(({ elevation_m }) => elevation_m)).toEqual([
      22.79, 96, 96, 100, -14.12, 96, 96,
    ]);
    expect(samples[4]).toMatchObject({ dataset: 'usgs_3dep', raster_id: 8857, resolution_m: 3.4 });
    expect(samples[0]).toMatchObject({ dataset: 'usgs_3dep', raster_id: 103728, resolution_m: 1 });
    expect(
      callsTo('epqs').map(({ request }) => Number(new URL(request.url).searchParams.get('y'))),
    ).toEqual([points[1]!.lat, points[2]!.lat, points[3]!.lat, points[5]!.lat, points[6]!.lat]);
    expect(await otdLocations()).toEqual([[points[3]]]);
  });

  it('resolves only the unfinished chunks after aborting and settling a timed-out body read', async () => {
    const points = usgsColumn(101);
    let cancelled = false;
    const { callsTo, sampler } = harness({
      imageSamples: async (request) => {
        const batch = await parseImageSamplePoints(request);
        if (batch[0]?.lat === points[0]?.lat) {
          return Response.json({
            samples: batch.map((point, id) => imageSampleRow(point, id, { value: 123 })),
          });
        }
        return new Response(
          new ReadableStream({
            cancel: () => {
              cancelled = true;
            },
          }),
        );
      },
      epqs: () => {
        expect(cancelled).toBe(true);
        return epqsResponse(epqsHitBody({ value: '456' }));
      },
    });
    const result = sampler.sample(points, 'usgs_3dep', createMockContext(), 'computed');
    await vi.advanceTimersByTimeAsync(9_999);
    expect(callsTo('batch')).toHaveLength(3);
    expect(callsTo('epqs')).toHaveLength(0);
    await vi.advanceTimersByTimeAsync(1);
    const samples = await result;
    expect(samples.map(({ elevation_m }) => elevation_m)).toEqual([
      ...Array(50).fill(123),
      ...Array(51).fill(456),
    ]);
    expect(callsTo('epqs')).toHaveLength(51);
  });

  it('charges queue time to the phase and keeps at most four requests active across calls', async () => {
    let active = 0;
    let highWater = 0;
    const { callsTo, sampler } = harness({
      imageSamples: (request) => {
        highWater = Math.max(highWater, ++active);
        return hangUntilAborted(request).finally(() => {
          active--;
        });
      },
      epqs: () => epqsResponse(epqsHitBody()),
    });
    const calls = [-104, -105, -106].map((lon) =>
      sampler.sample(usgsColumn(101, lon), 'usgs_3dep', createMockContext(), 'computed'),
    );
    await vi.advanceTimersByTimeAsync(9_999);
    expect(highWater).toBe(4);
    expect(callsTo('batch')).toHaveLength(4);
    expect(callsTo('epqs')).toHaveLength(0);
    await vi.advanceTimersByTimeAsync(1);
    const results = await Promise.all(calls);
    expect(results.map((samples) => samples.length)).toEqual([101, 101, 101]);
    expect(callsTo('batch')).toHaveLength(4);
    expect(callsTo('epqs')).toHaveLength(303);
    expect(active).toBe(0);
  });

  it('rejects with the sampling deadline when the batch used all remaining time', async () => {
    const { callsTo, sampler } = harness({ budgetMs: 500, imageSamples: hangUntilAborted });
    const error = await rejectionWithFakeTimers(
      sampler.sample([SEATTLE], 'auto', createMockContext(), 'computed'),
    );
    expect(mcpData(error)).toMatchObject({
      reason: 'sampling_deadline_exceeded',
      provider: 'usgs_3dep',
    });
    expect(callsTo('batch')).toHaveLength(1);
    expect(callsTo('epqs')).toHaveLength(0);
    expect(callsTo('otd')).toHaveLength(0);
  });

  it('includes catalog queue time in its four-second best-effort deadline', async () => {
    const { callsTo, sampler } = harness({
      imageSamples: hangUntilAborted,
      epqs: () => epqsResponse(epqsHitBody()),
    });
    const hold = new AbortController();
    const ctx = createMockContext({ signal: hold.signal });
    const blocked = Promise.allSettled([
      sampler.sample(usgsColumn(51), 'usgs_3dep', ctx, 'computed'),
      sampler.sample(usgsColumn(51, -106), 'usgs_3dep', ctx, 'computed'),
    ]);
    const result = sampler.sample([SEATTLE], 'usgs_3dep', createMockContext());
    await vi.advanceTimersByTimeAsync(4000);
    expect(await result).toEqual([
      {
        ...SEATTLE,
        dataset: 'usgs_3dep',
        elevation_m: 52.38,
        raster_id: 102575,
        resolution_m: 1,
      },
    ]);
    expect(callsTo('batch')).toHaveLength(4);
    expect(callsTo('catalog')).toHaveLength(0);
    hold.abort();
    expect((await blocked).map(({ status }) => status)).toEqual(['rejected', 'rejected']);
  });

  it('does not query USGS when source is Open Topo Data or all auto points are outside coverage', async () => {
    const { callsTo, sampler } = harness({ otd: otdByPoint() });
    await sampler.sample([SEATTLE], 'opentopodata', createMockContext(), 'computed');
    await sampler.sample([LONDON], 'auto', createMockContext(), 'computed');
    expect(callsTo('batch')).toHaveLength(0);
    expect(callsTo('epqs')).toHaveLength(0);
    expect(callsTo('catalog')).toHaveLength(0);
    expect(callsTo('otd')).toHaveLength(2);
  });
});

describe('ElevationSampler.sample: raster dates and ImageServer recovery', () => {
  it('queries distinct positive raster IDs once, matches unordered rows, and omits ambiguous and invalid dates', async () => {
    const rasterIds = [103728, 8857, 103728, 8, 9, 10, 11, 12, 13, 14, -1, null];
    const points = usgsColumn(rasterIds.length);
    const { callsTo, sampler } = harness({
      epqs: epqsByPoint((point) =>
        epqsResponse(
          epqsHitBody({
            rasterId: rasterIds[points.findIndex(({ lat }) => lat === point.lat)]!,
          }),
        ),
      ),
      catalog: () =>
        catalogResponse([
          { id: 8857, epoch: 1199923200000 },
          { id: 12, epoch: 0.5 },
          { id: 103728, epoch: 1625788800000 },
          { id: 8, epoch: 0 },
          { id: 8, epoch: 1 },
          { id: 9 },
          { id: 10, epoch: '0' },
          { id: 11, epoch: 8640000000000001 },
          { id: 13, epoch: 253402300800000 },
          { id: -1, epoch: 0 },
        ]),
    });
    const samples = await sampler.sample(points, 'usgs_3dep', createMockContext());
    expect(samples.map(({ acquisition_date }) => acquisition_date)).toEqual([
      '2021-07-09',
      '2008-01-10',
      '2021-07-09',
      ...Array(9).fill(undefined),
    ]);
    const [catalog] = callsTo('catalog');
    expect(callsTo('catalog')).toHaveLength(1);
    expect(Object.fromEntries(new URLSearchParams(await catalog!.request.text()))).toEqual({
      f: 'json',
      objectIds: '103728,8857,8,9,10,11,12,13,14',
      outFields: 'OBJECTID,AcquisitionDate',
      returnGeometry: 'false',
    });
    expect(samples.every(({ elevation_m }) => elevation_m === 52.38)).toBe(true);
  });

  const unusableResponses: [string, EpqsResponder][] = [
    ...[403, 404, 422, 429, 503].map((status): [string, EpqsResponder] => [
      `HTTP ${status}`,
      () => new Response('upstream text', { status }),
    ]),
    ['network error', () => Promise.reject(new TypeError('fetch failed'))],
    [
      'ArcGIS error envelope',
      () => Response.json({ error: { code: 400, message: 'upstream text' } }),
    ],
    ['empty rows', () => Response.json({ samples: [], features: [] })],
    ['wrong shape', () => Response.json({ samples: {}, features: {} })],
    ['malformed JSON', () => new Response('{')],
    ['oversized response', () => new Response('x'.repeat(65 * 1024))],
  ];

  it.each(unusableResponses)(
    'falls back through EPQS and omits catalog dates on %s',
    async (_label, respond) => {
      const { callsTo, sampler } = harness({
        epqs: () => epqsResponse(epqsHitBody()),
        imageSamples: respond,
        catalog: respond,
      });
      const computed = await sampler.sample([SEATTLE], 'auto', createMockContext(), 'computed');
      expect(computed[0]).toMatchObject({ dataset: 'usgs_3dep', elevation_m: 52.38 });
      expect(callsTo('batch')).toHaveLength(1);
      expect(callsTo('epqs')).toHaveLength(1);
      expect(callsTo('catalog')).toHaveLength(0);
      const points = await sampler.sample([SEATTLE], 'auto', createMockContext());
      expect(points).toEqual(computed);
      expect(callsTo('catalog')).toHaveLength(1);
      expect(callsTo('otd')).toHaveLength(0);
    },
  );

  it.each(['computed', 'points'] as const)(
    'propagates caller abort and stops the ImageServer request in %s mode',
    async (purpose) => {
      const caller = new AbortController();
      const started = Promise.withResolvers<AbortSignal>();
      let stopped = false;
      const responder: EpqsResponder = (request) => {
        started.resolve(request.signal);
        return hangUntilAborted(request).finally(() => {
          stopped = true;
        });
      };
      const { callsTo, sampler } = harness({
        catalog: responder,
        imageSamples: responder,
        epqs: () => epqsResponse(epqsHitBody()),
      });
      const result = sampler.sample(
        [SEATTLE],
        'auto',
        createMockContext({ signal: caller.signal }),
        purpose,
      );
      const cancellation = new Error('cancel sampling');
      const rejects = expect(result).rejects.toBe(cancellation);
      const upstream = await started.promise;
      caller.abort(cancellation);
      await rejects;
      expect(upstream.aborted).toBe(true);
      expect(stopped).toBe(true);
      expect(callsTo('epqs')).toHaveLength(purpose === 'computed' ? 0 : 1);
      expect(callsTo('otd')).toHaveLength(0);
    },
  );

  it.each([500, 4000])(
    'stops reading the catalog at %d ms and preserves elevations',
    async (budgetMs) => {
      vi.useFakeTimers();
      try {
        const cancelled = vi.fn();
        const { callsTo, sampler } = harness({
          budgetMs: budgetMs === 4000 ? 45_000 : budgetMs,
          epqs: () => epqsResponse(epqsHitBody()),
          catalog: () => new Response(new ReadableStream({ cancel: cancelled })),
        });
        const result = sampler.sample([SEATTLE], 'usgs_3dep', createMockContext());
        await vi.advanceTimersByTimeAsync(budgetMs - 1);
        expect(cancelled).not.toHaveBeenCalled();
        await vi.advanceTimersByTimeAsync(1);
        expect((await result)[0]).toMatchObject({ dataset: 'usgs_3dep', elevation_m: 52.38 });
        expect((await result)[0]).not.toHaveProperty('acquisition_date');
        expect(callsTo('catalog')).toHaveLength(1);
        expect(cancelled).toHaveBeenCalledOnce();
      } finally {
        vi.useRealTimers();
      }
    },
  );

  it('skips catalog after elevation sampling uses the remaining budget or supplies no raster ID', async () => {
    let clock = 0;
    const expired = harness({
      now: () => clock,
      epqs: () => {
        clock = 45_000;
        return epqsResponse(epqsHitBody());
      },
    });
    const noId = harness({ epqs: () => epqsResponse(epqsHitBody({ rasterId: null })) });
    for (const { callsTo, sampler } of [expired, noId]) {
      const [sample] = await sampler.sample([SEATTLE], 'usgs_3dep', createMockContext());
      expect(sample).toMatchObject({ elevation_m: 52.38 });
      expect(sample).not.toHaveProperty('acquisition_date');
      expect(callsTo('catalog')).toHaveLength(0);
    }
  });

  it.each(['computed', 'points'] as const)(
    'propagates unexpected ImageServer errors in %s mode',
    async (purpose) => {
      const bug = new Error('programmer error');
      const responder = () => {
        throw bug;
      };
      const { callsTo, sampler } = harness({
        catalog: responder,
        imageSamples: responder,
        epqs: () => epqsResponse(epqsHitBody()),
      });
      await expect(sampler.sample([SEATTLE], 'auto', createMockContext(), purpose)).rejects.toBe(
        bug,
      );
      expect(callsTo('epqs')).toHaveLength(purpose === 'computed' ? 0 : 1);
      expect(callsTo('otd')).toHaveLength(0);
    },
  );
});

describe('ElevationSampler.sample: dedupe', () => {
  it('queries a coordinate once (after 6-decimal rounding) and answers every position', async () => {
    const { callsTo, sampler } = harness({
      epqs: epqsByPoint((point) => epqsResponse(epqsHitBody({ value: String(point.lat) }))),
    });
    const other = { lat: 40, lon: -105 };
    const samples = await sampler.sample(
      [SEATTLE, other, { lat: 47.60620004, lon: -122.33209996 }, SEATTLE],
      'usgs_3dep',
      createMockContext(),
    );

    expect(callsTo('epqs')).toHaveLength(2);
    expect(samples).toHaveLength(4);
    expect(samples.map((s) => s.elevation_m)).toEqual([47.61, 40, 47.61, 47.61]);
    expect(samples.map((s) => s.lat)).toEqual([47.6062, 40, 47.6062, 47.6062]);
    expect(samples[0]).toEqual(samples[2]);
  });

  it('fans a deduped Open Topo Data answer back to every input position, in input order', async () => {
    const { otdLocations, sampler } = harness({
      otd: otdByPoint((point) => ({ dataset: 'srtm30m', elevation: point.lat })),
    });
    const a = { lat: 10, lon: 10 };
    const b = { lat: 20, lon: 20 };
    const samples = await sampler.sample([a, b, a, b, a], 'opentopodata', createMockContext());

    const [sent] = await otdLocations();
    expect(sent).toEqual([a, b]);
    expect(samples.map((s) => s.elevation_m)).toEqual([10, 20, 10, 20, 10]);
  });

  it('dedupes before chunking: 150 inputs over 100 unique points make one request', async () => {
    const points = Array.from({ length: 150 }, (_v, i) => ({ lat: (i % 100) / 10, lon: 5 }));
    const { callsTo, sampler } = harness({ otd: otdByPoint() });
    const samples = await sampler.sample(points, 'opentopodata', createMockContext());
    expect(callsTo('otd')).toHaveLength(1);
    expect(samples).toHaveLength(150);
  });
});

describe('ElevationSampler.sample: routing', () => {
  describe('auto', () => {
    it('answers inside the envelope from 3DEP alone and sends no Open Topo Data request', async () => {
      const { callsTo, sampler } = harness({ epqs: () => epqsResponse(epqsHitBody()) });
      const samples = await sampler.sample([SEATTLE], 'auto', createMockContext());
      expect(samples[0]?.dataset).toBe('usgs_3dep');
      expect(callsTo('epqs')).toHaveLength(1);
      expect(callsTo('otd')).toHaveLength(0);
    });

    it('skips 3DEP outside the envelope and goes straight to Open Topo Data', async () => {
      const { callsTo, sampler } = harness({ otd: otdByPoint() });
      const samples = await sampler.sample([LONDON, SYDNEY], 'auto', createMockContext());
      expect(callsTo('epqs')).toHaveLength(0);
      expect(callsTo('otd')).toHaveLength(1);
      expect(samples.map((s) => s.dataset)).toEqual(['srtm30m', 'srtm30m']);
    });

    it('falls back to Open Topo Data for a 3DEP coverage miss, and only for that point', async () => {
      const { callsTo, otdLocations, sampler } = harness({
        epqs: epqsByPoint((point) =>
          point.lat === SEATTLE.lat
            ? epqsResponse(epqsHitBody())
            : epqsResponse(EPQS_MISS_TEXTS.invalidParameters),
        ),
        otd: otdByPoint(() => ({ dataset: 'mapzen', elevation: -4389 })),
      });
      const openPacific = { lat: 30, lon: -140 };
      const samples = await sampler.sample([SEATTLE, openPacific], 'auto', createMockContext());

      expect(callsTo('epqs')).toHaveLength(2);
      expect(await otdLocations()).toEqual([[openPacific]]);
      expect(samples.map((s) => s.dataset)).toEqual(['usgs_3dep', 'mapzen']);
    });

    it('batches 3DEP misses and out-of-envelope points into one Open Topo Data request, in input order', async () => {
      const { otdLocations, sampler } = harness({
        epqs: epqsByPoint((point) =>
          point.lon === -140
            ? epqsResponse(EPQS_MISS_TEXTS.transformationUnavailable)
            : epqsResponse(epqsHitBody()),
        ),
        otd: otdByPoint((point) => ({ dataset: 'mapzen', elevation: point.lat })),
      });
      const points = [
        LONDON, // outside the envelope
        SEATTLE, // 3DEP hit
        { lat: 30, lon: -140 }, // 3DEP miss
        SYDNEY, // outside the envelope
        { lat: 40, lon: -105 }, // 3DEP hit
      ];
      const samples = await sampler.sample(points, 'auto', createMockContext());

      const requests = await otdLocations();
      expect(requests).toHaveLength(1);
      expect(requests[0]).toEqual([
        { lat: 51.5074, lon: -0.1278 },
        { lat: 30, lon: -140 },
        { lat: -33.8688, lon: 151.2093 },
      ]);
      expect(samples.map((s) => s.dataset)).toEqual([
        'mapzen',
        'usgs_3dep',
        'mapzen',
        'mapzen',
        'usgs_3dep',
      ]);
      expect(samples.map((s) => s.lat)).toEqual([51.5074, 47.6062, 30, -33.8688, 40]);
    });

    it('treats a miss from both providers as no data', async () => {
      const { sampler } = harness({
        epqs: () => epqsResponse(EPQS_MISS_TEXTS.emptyGeometry),
        otd: otdByPoint(() => ({ dataset: 'mapzen', elevation: null })),
      });
      const samples = await sampler.sample([SEATTLE, LONDON], 'auto', createMockContext());
      expect(samples).toStrictEqual([
        { lat: 47.6062, lon: -122.3321 },
        { lat: 51.5074, lon: -0.1278 },
      ]);
    });
  });

  describe('usgs_3dep', () => {
    it('queries 3DEP for every point, outside the envelope too, and never calls Open Topo Data', async () => {
      const { callsTo, sampler } = harness({
        epqs: epqsByPoint((point) =>
          point.lat === LONDON.lat
            ? epqsResponse(EPQS_MISS_TEXTS.invalidParameters)
            : epqsResponse(epqsHitBody()),
        ),
      });
      const samples = await sampler.sample(
        [SEATTLE, LONDON, SYDNEY],
        'usgs_3dep',
        createMockContext(),
      );

      expect(callsTo('epqs')).toHaveLength(3);
      expect(callsTo('otd')).toHaveLength(0);
      expect(samples.map((s) => s.dataset)).toEqual(['usgs_3dep', undefined, 'usgs_3dep']);
      expect(samples[1]).toStrictEqual({ lat: 51.5074, lon: -0.1278 });
    });
  });

  describe('opentopodata', () => {
    it('sends every point, in-envelope too, to Open Topo Data and never calls 3DEP', async () => {
      const { callsTo, otdLocations, sampler } = harness({ otd: otdByPoint() });
      await sampler.sample([SEATTLE, LONDON], 'opentopodata', createMockContext());
      expect(callsTo('epqs')).toHaveLength(0);
      expect(await otdLocations()).toEqual([[SEATTLE, LONDON]]);
    });
  });
});

describe('ElevationSampler.sample: failures never fall back', () => {
  beforeEach(() => {
    vi.useFakeTimers();
  });
  afterEach(() => {
    vi.useRealTimers();
  });

  it('fails an auto call with usgs_unavailable on a 3DEP outage, without asking Open Topo Data', async () => {
    const { callsTo, sampler } = harness({
      epqs: () => epqsResponse('', 503),
      otd: otdByPoint(),
    });
    const error = await rejectionWithFakeTimers(
      sampler.sample([SEATTLE], 'auto', createMockContext()),
    );

    expect(mcpData(error)).toMatchObject({
      reason: 'usgs_unavailable',
      retryable: true,
      status: 503,
    });
    expect(callsTo('otd')).toHaveLength(0);
  });

  it('fails an auto call with usgs_unavailable on a 3DEP 403, unretried', async () => {
    const { callsTo, sampler } = harness({
      epqs: () => epqsResponse('{"message":"Missing Authentication Token"}', 403),
      otd: otdByPoint(),
    });
    const error = await rejectionWithFakeTimers(
      sampler.sample([SEATTLE], 'auto', createMockContext()),
    );
    expect(mcpData(error)).toMatchObject({ reason: 'usgs_unavailable', retryable: false });
    expect(callsTo('epqs')).toHaveLength(1);
    expect(callsTo('otd')).toHaveLength(0);
  });

  it('fails with the Open Topo Data reason, returning no partial result, when the fallback outage hits', async () => {
    const { sampler } = harness({
      epqs: epqsByPoint((point) =>
        point.lat === SEATTLE.lat
          ? epqsResponse(epqsHitBody())
          : epqsResponse(EPQS_MISS_TEXTS.callFailed),
      ),
      otd: () => otdResponse('{"error":"down"}', 503),
    });
    const result = await settleWithFakeTimers(
      sampler.sample([SEATTLE, { lat: 30, lon: -140 }], 'auto', createMockContext()),
    );
    expect(result.status).toBe('rejected');
    expect(mcpData((result as PromiseRejectedResult).reason)).toMatchObject({
      reason: 'opentopodata_unavailable',
      status: 503,
    });
  });

  it('passes an Open Topo Data configuration rejection through unchanged', async () => {
    const { sampler } = harness({ otd: () => otdResponse('{"message":"Forbidden"}', 403) });
    const error = await rejectionWithFakeTimers(
      sampler.sample([LONDON], 'opentopodata', createMockContext()),
    );
    expect((error as McpError).code).toBe(JsonRpcErrorCode.ConfigurationError);
    expect(mcpData(error)).toMatchObject({ reason: 'opentopodata_config_rejected', status: 403 });
  });

  it('passes the Open Topo Data 429 and daily-limit reasons through unchanged', async () => {
    const limited = harness({ otd: () => otdResponse('{}', 429, { 'retry-after': '30' }) });
    const rateLimited = await rejectionWithFakeTimers(
      limited.sampler.sample([LONDON], 'opentopodata', createMockContext()),
    );
    expect(mcpData(rateLimited)).toMatchObject({ reason: 'opentopodata_rate_limited' });

    const http = createFetchMock([otdRoute(OTD_PUBLIC_BASE_URL, otdByPoint())]);
    const sampler = new ElevationSampler({
      epqs: new UsgsEpqsClient({ fetch: http.fetch, pacer: permissivePacer() }),
      imageServer: new UsgsImageServer(http.fetch),
      openTopoData: new OpenTopoDataClient({
        baseUrl: OTD_PUBLIC_BASE_URL,
        fetch: http.fetch,
        pacer: permissivePacer(),
        dailyPacer: createPacer({
          name: 'zero-left',
          limits: [{ requests: 1, perMs: 86_400_000 }],
          maxQueueDepth: 0,
        }),
      }),
    });
    await sampler.sample([LONDON], 'opentopodata', createMockContext());
    const daily = await rejectionWithFakeTimers(
      sampler.sample([SYDNEY], 'opentopodata', createMockContext()),
    );
    expect((daily as McpError).code).toBe(JsonRpcErrorCode.RateLimited);
    expect(mcpData(daily)).toMatchObject({ reason: 'opentopodata_daily_limit', retryable: false });
  });

  it('passes the InternalError for a 400 this server provoked through, with no reason', async () => {
    const { sampler } = harness({
      otd: () => otdResponse('{"error":"Invalid JSON.","status":"INVALID_REQUEST"}', 400),
    });
    const error = await rejectionWithFakeTimers(
      sampler.sample([LONDON], 'opentopodata', createMockContext()),
    );
    expect((error as McpError).code).toBe(JsonRpcErrorCode.InternalError);
    expect(mcpData(error)).toEqual({ status: 400, retryable: false });
  });
});

describe('ElevationSampler.sample: chunking at 100', () => {
  const grid = (count: number) =>
    Array.from({ length: count }, (_v, i) => ({ lat: -60 + i * 0.1, lon: 100 + i * 0.1 }));

  it.each([
    [1, [1]],
    [100, [100]],
    [101, [100, 1]],
    [250, [100, 100, 50]],
  ])('sends %i unique points as chunks %j', async (count, sizes) => {
    const { otdLocations, sampler } = harness({
      otd: otdByPoint((point) => ({ dataset: 'srtm30m', elevation: point.lat })),
    });
    const points = grid(count);
    const samples = await sampler.sample(points, 'opentopodata', createMockContext());

    const requests = await otdLocations();
    expect(requests.map((request) => request.length)).toEqual(sizes);
    // Chunks are consecutive slices of the input order.
    expect(requests.flat().map((p) => p.lat)).toEqual(points.map((p) => Number(p.lat.toFixed(6))));
    expect(samples).toHaveLength(count);
    expect(samples.map((s) => s.lat)).toEqual(points.map((p) => Number(p.lat.toFixed(6))));
    expect(samples.map((s) => s.elevation_m)).toEqual(
      points.map((p) => Number(p.lat.toFixed(6))).map((lat) => Math.round(lat * 100) / 100),
    );
  });

  it('chunks only the points that need Open Topo Data in auto mode', async () => {
    const outside = Array.from({ length: 120 }, (_v, i) => ({ lat: -60 + i * 0.1, lon: 100 }));
    const { callsTo, otdLocations, sampler } = harness({
      epqs: () => epqsResponse(epqsHitBody()),
      otd: otdByPoint(),
    });
    await sampler.sample([SEATTLE, ...outside], 'auto', createMockContext());
    expect(callsTo('epqs')).toHaveLength(1);
    expect((await otdLocations()).map((request) => request.length)).toEqual([100, 20]);
  });

  it('fails the whole call and aborts the sibling chunk when one chunk fails', async () => {
    const signals: AbortSignal[] = [];
    let requests = 0;
    const { sampler } = harness({
      otd: (request) => {
        const index = requests++;
        signals.push(request.signal);
        return index === 0
          ? hangUntilAborted(request)
          : otdResponse('{"message":"Forbidden"}', 403);
      },
    });
    const error = await sampler
      .sample(grid(150), 'opentopodata', createMockContext())
      .catch((e: unknown) => e);

    expect(mcpData(error)).toMatchObject({ reason: 'opentopodata_config_rejected' });
    expect(signals).toHaveLength(2);
    expect(signals[0]?.aborted).toBe(true);
  });
});

describe('ElevationSampler.sample: fail fast', () => {
  it('aborts outstanding 3DEP requests on the first failure and rejects with that failure', async () => {
    const hung: AbortSignal[] = [];
    const ctx = createMockContext();
    const { sampler } = harness({
      epqs: epqsByPoint((point, request) => {
        if (point.lat === 40) return epqsResponse('{"message":"Forbidden"}', 403);
        hung.push(request.signal);
        return hangUntilAborted(request);
      }),
    });
    const error = await sampler
      .sample([SEATTLE, { lat: 40, lon: -105 }, { lat: 41, lon: -105 }], 'usgs_3dep', ctx)
      .catch((e: unknown) => e);

    expect(mcpData(error)).toMatchObject({ reason: 'usgs_unavailable', status: 403 });
    expect(hung).toHaveLength(2);
    expect(hung.every((signal) => signal.aborted)).toBe(true);
    expect(ctx.signal.aborted).toBe(false);
  });
});

describe('ElevationSampler.sample: 3DEP lookups per call', () => {
  /** `count` distinct points inside the 3DEP envelope, on the meridian `lon`. */
  const column = (count: number, lon = -105): LatLon[] =>
    Array.from({ length: count }, (_, i) => ({ lat: 40 + i / 1_000, lon }));

  it('keeps at most 6 lookups of one call outstanding, starting the next as one settles', async () => {
    let inFlight = 0;
    let peak = 0;
    const { callsTo, sampler } = harness({
      epqs: async () => {
        inFlight++;
        peak = Math.max(peak, inFlight);
        await new Promise((resolve) => setTimeout(resolve, 5));
        inFlight--;
        return epqsResponse(epqsHitBody());
      },
    });
    const samples = await sampler.sample(column(20), 'usgs_3dep', createMockContext());

    expect(peak).toBe(6);
    expect(callsTo('epqs')).toHaveLength(20);
    expect(samples.every((sample) => sample.dataset === 'usgs_3dep')).toBe(true);
  });

  it('sends no further lookup once one fails', async () => {
    const { callsTo, sampler } = harness({
      epqs: epqsByPoint((point, request) =>
        point.lat === 40 ? epqsResponse('{"message":"Forbidden"}', 403) : hangUntilAborted(request),
      ),
    });
    const error = await sampler
      .sample(column(20), 'usgs_3dep', createMockContext())
      .catch((e: unknown) => e);

    expect(mcpData(error)).toMatchObject({ reason: 'usgs_unavailable', status: 403 });
    expect(callsTo('epqs')).toHaveLength(6);
  });

  describe('on the production pacer', () => {
    beforeEach(() => {
      vi.useFakeTimers();
    });
    afterEach(() => {
      vi.useRealTimers();
    });

    it('answers a 1-point call started 100 ms after a 250-point call in under 2 s', async () => {
      const http = createFetchMock([
        catalogRoute(defaultCatalogResponse),
        epqsRoute(async () => {
          await new Promise((resolve) => setTimeout(resolve, 200));
          return epqsResponse(epqsHitBody());
        }),
      ]);
      const epqs = new UsgsEpqsClient({ fetch: http.fetch });
      const sampler = new ElevationSampler({
        epqs,
        imageServer: new UsgsImageServer(http.fetch),
        openTopoData: new OpenTopoDataClient({
          baseUrl: OTD_PUBLIC_BASE_URL,
          fetch: http.fetch,
          pacer: permissivePacer(),
          dailyPacer: permissivePacer(),
        }),
      });
      try {
        const large = sampler.sample(column(250), 'usgs_3dep', createMockContext());
        large.catch(() => undefined);
        await vi.advanceTimersByTimeAsync(100);

        const startedAt = Date.now();
        const small = await settleWithFakeTimers(
          sampler.sample([SEATTLE], 'usgs_3dep', createMockContext()),
          { stepMs: 50 },
        );
        expect(small.status).toBe('fulfilled');
        expect(Date.now() - startedAt).toBeLessThan(2_000);

        const rest = await settleWithFakeTimers(large, { stepMs: 50 });
        if (rest.status === 'rejected') throw rest.reason;
        expect(rest.value.filter((sample) => sample.dataset === 'usgs_3dep')).toHaveLength(250);
        expect(http.calls.filter(({ request }) => request.method === 'GET')).toHaveLength(251);
      } finally {
        epqs.dispose();
      }
    });

    it('answers the first of two simultaneous 250-point calls and refuses the second at once, sending nothing', async () => {
      const http = createFetchMock([
        catalogRoute(defaultCatalogResponse),
        epqsRoute(async () => {
          await new Promise((resolve) => setTimeout(resolve, 200));
          return epqsResponse(epqsHitBody());
        }),
      ]);
      const epqs = new UsgsEpqsClient({ fetch: http.fetch });
      const sampler = new ElevationSampler({
        epqs,
        imageServer: new UsgsImageServer(http.fetch),
        openTopoData: new OpenTopoDataClient({
          baseUrl: OTD_PUBLIC_BASE_URL,
          fetch: http.fetch,
          pacer: permissivePacer(),
          dailyPacer: permissivePacer(),
        }),
      });
      try {
        const first = sampler.sample(column(250), 'usgs_3dep', createMockContext());
        first.catch(() => undefined);

        const startedAt = Date.now();
        const second = await settleWithFakeTimers(
          sampler.sample(column(250, -104), 'usgs_3dep', createMockContext()),
          { stepMs: 50 },
        );
        expect(second.status).toBe('rejected');
        expect(Date.now() - startedAt).toBeLessThan(1_000);
        const error = (second as PromiseRejectedResult).reason;
        expect((error as McpError).code).toBe(JsonRpcErrorCode.Timeout);
        expect(mcpData(error)).toMatchObject({
          reason: 'sampling_deadline_exceeded',
          provider: 'usgs_3dep',
          retryAfter: 25,
        });

        const rest = await settleWithFakeTimers(first, { stepMs: 50 });
        if (rest.status === 'rejected') throw rest.reason;
        expect(rest.value.filter((sample) => sample.dataset === 'usgs_3dep')).toHaveLength(250);
        expect(http.calls.filter(({ request }) => request.method === 'GET')).toHaveLength(250);
        expect(
          http.calls
            .filter(({ request }) => request.method === 'GET')
            .every((call) => new URL(call.request.url).searchParams.get('x') === '-105.000000'),
        ).toBe(true);
      } finally {
        epqs.dispose();
      }
    });
  });

  describe('admission against the lookups other calls have queued', () => {
    /** Starts a call whose lookups hang until it is cancelled, and waits for its first window. */
    async function holdInFlight(sampler: ElevationSampler, count: number, sent: () => number) {
      const controller = new AbortController();
      const call = sampler.sample(
        column(count),
        'usgs_3dep',
        createMockContext({ signal: controller.signal }),
      );
      call.catch(() => undefined);
      await vi.waitFor(() => expect(sent()).toBe(6));
      return () => controller.abort(new Error('test done'));
    }

    it("refuses a call whose lookups would carry the queue past an in-flight call's deadline, sending nothing", async () => {
      let clock = 0;
      const { callsTo, sampler } = harness({ now: () => clock, epqs: hangUntilAborted });
      const release = await holdInFlight(sampler, 100, () => callsTo('epqs').length);
      try {
        clock = 30_000;
        // 100 queued plus 60 more at 10 a second end at 46 s: past the in-flight
        // call's 45 s deadline, though inside this call's own (75 s).
        const error = await sampler
          .sample(column(60, -104), 'usgs_3dep', createMockContext())
          .catch((e: unknown) => e);

        expect((error as McpError).code).toBe(JsonRpcErrorCode.Timeout);
        expect(mcpData(error)).toEqual({
          reason: 'sampling_deadline_exceeded',
          budgetMs: 45_000,
          elapsedMs: 0,
          provider: 'usgs_3dep',
          retryAfter: 10,
        });
        expect((error as McpError).message).toContain('this call sent no EPQS requests');
        await new Promise((resolve) => setTimeout(resolve, 20));
        expect(callsTo('epqs')).toHaveLength(6);
      } finally {
        release();
      }
    });

    it('admits a call whose lookups drain before every in-flight deadline', async () => {
      let clock = 0;
      const { callsTo, sampler } = harness({ now: () => clock, epqs: hangUntilAborted });
      const release = await holdInFlight(sampler, 100, () => callsTo('epqs').length);
      const controller = new AbortController();
      try {
        clock = 30_000;
        // 100 queued plus 50 more end at exactly 45 s, the in-flight call's deadline.
        const admitted = sampler.sample(
          column(50, -104),
          'usgs_3dep',
          createMockContext({ signal: controller.signal }),
        );
        admitted.catch(() => undefined);
        await vi.waitFor(() => expect(callsTo('epqs')).toHaveLength(12));
      } finally {
        controller.abort(new Error('test done'));
        release();
      }
    });

    it('always admits a call when no other call has lookups queued, even past its own budget', async () => {
      const { callsTo, sampler } = harness({
        budgetMs: 5_000,
        epqs: () => epqsResponse(epqsHitBody()),
      });
      // 250 lookups project to 25 s at 10 a second, over this call's 5 s budget.
      const samples = await sampler.sample(column(250), 'usgs_3dep', createMockContext());

      expect(samples.filter((sample) => sample.dataset === 'usgs_3dep')).toHaveLength(250);
      expect(callsTo('epqs')).toHaveLength(250);
    });

    it('releases a finished or failed call, so the next heavy call is admitted', async () => {
      const { sampler } = harness({
        epqs: epqsByPoint((point) =>
          point.lon === -103
            ? epqsResponse('{"message":"Forbidden"}', 403)
            : epqsResponse(epqsHitBody()),
        ),
      });
      const answered = await sampler.sample(column(250), 'usgs_3dep', createMockContext());
      expect(answered).toHaveLength(250);

      const failed = await sampler
        .sample(column(250, -103), 'usgs_3dep', createMockContext())
        .catch((e: unknown) => e);
      expect(mcpData(failed)).toMatchObject({ reason: 'usgs_unavailable', status: 403 });

      const after = await sampler.sample(column(250, -104), 'usgs_3dep', createMockContext());
      expect(after.filter((sample) => sample.dataset === 'usgs_3dep')).toHaveLength(250);
    });
  });
});

describe('ElevationSampler.sample: sampling budget', () => {
  beforeEach(() => {
    vi.useFakeTimers();
  });
  afterEach(() => {
    vi.useRealTimers();
  });

  it('fails sampling_deadline_exceeded, with the retry deadline as cause, when the ladder runs out of budget', async () => {
    const { sampler } = harness({ budgetMs: 800, epqs: () => epqsResponse('', 500) });
    const error = await rejectionWithFakeTimers(
      sampler.sample([SEATTLE], 'usgs_3dep', createMockContext()),
    );

    expect((error as McpError).code).toBe(JsonRpcErrorCode.Timeout);
    expect(mcpData(error)).toMatchObject({
      reason: 'sampling_deadline_exceeded',
      budgetMs: 800,
      provider: 'usgs_3dep',
    });
    expect(mcpData(error).elapsedMs).toBeTypeOf('number');
    expect((error as McpError).message).toMatch(
      /ran out of its 0\.8 s budget after \d+ ms, waiting on USGS 3DEP\.$/,
    );
    expect(mcpData((error as McpError).cause)).toMatchObject({ reason: 'retry_deadline_exceeded' });
  });

  it('uses the 45 s default budget', async () => {
    const { sampler } = harness({ otd: hangUntilAborted });
    const startedAt = Date.now();
    const error = await rejectionWithFakeTimers(
      sampler.sample([LONDON], 'opentopodata', createMockContext()),
    );

    expect(mcpData(error)).toMatchObject({
      reason: 'sampling_deadline_exceeded',
      budgetMs: 45_000,
      provider: 'opentopodata',
    });
    expect((error as McpError).message).toContain('45 s budget');
    expect((error as McpError).message).toMatch(/, waiting on Open Topo Data\.$/);
    expect(mcpData(error).elapsedMs as number).toBeGreaterThanOrEqual(45_000);
    expect(Date.now() - startedAt).toBeGreaterThanOrEqual(45_000);
  });

  it('aborts the hung upstream request when the budget expires', async () => {
    let signal: AbortSignal | undefined;
    const { sampler } = harness({
      budgetMs: 2_000,
      epqs: (request) => {
        signal = request.signal;
        return hangUntilAborted(request);
      },
    });
    await rejectionWithFakeTimers(sampler.sample([SEATTLE], 'usgs_3dep', createMockContext()));
    expect(signal?.aborted).toBe(true);
  });

  it('hands Open Topo Data only the budget left after 3DEP', async () => {
    const { sampler } = harness({
      budgetMs: 5_000,
      now: () => Date.now(),
      epqs: async () => {
        await new Promise((resolve) => setTimeout(resolve, 3_000));
        return epqsResponse(EPQS_MISS_TEXTS.callFailed);
      },
      otd: hangUntilAborted,
    });
    const error = await rejectionWithFakeTimers(
      sampler.sample([SEATTLE], 'auto', createMockContext()),
    );

    expect(mcpData(error)).toMatchObject({
      reason: 'sampling_deadline_exceeded',
      budgetMs: 5_000,
      provider: 'opentopodata',
    });
    expect((error as McpError).message).toContain('waiting on Open Topo Data');
    // 3 s spent on 3DEP leaves 2 s for Open Topo Data; a fresh 5 s would end near 8 s.
    expect(mcpData(error).elapsedMs as number).toBeGreaterThanOrEqual(5_000);
    expect(mcpData(error).elapsedMs as number).toBeLessThan(5_600);
  });

  it('fails before the Open Topo Data phase when 3DEP spent the whole budget, sending nothing', async () => {
    let clock = 1_000;
    const { callsTo, sampler } = harness({
      budgetMs: 45_000,
      now: () => clock,
      epqs: () => {
        clock += 50_000;
        return epqsResponse(EPQS_MISS_TEXTS.callFailed);
      },
      otd: otdByPoint(),
    });
    const error = await sampler
      .sample([SEATTLE], 'auto', createMockContext())
      .catch((e: unknown) => e);

    expect((error as McpError).code).toBe(JsonRpcErrorCode.Timeout);
    expect(mcpData(error)).toEqual({
      reason: 'sampling_deadline_exceeded',
      budgetMs: 45_000,
      elapsedMs: 50_000,
      provider: 'usgs_3dep',
    });
    expect((error as McpError).message).toContain('waiting on USGS 3DEP');
    expect((error as McpError).cause).toBeUndefined();
    expect(callsTo('otd')).toHaveLength(0);
  });

  it('maps a 3DEP pacer shed (a wait beyond the budget) to sampling_deadline_exceeded with the shed as cause', async () => {
    const pacer = createPacer({ name: 'epqs-shed', maxConcurrent: 1, maxQueueDepth: 0 });
    const http = createFetchMock([epqsRoute(() => epqsResponse(epqsHitBody()))]);
    const sampler = new ElevationSampler({
      epqs: new UsgsEpqsClient({ fetch: http.fetch, pacer }),
      imageServer: new UsgsImageServer(http.fetch),
      openTopoData: new OpenTopoDataClient({
        baseUrl: OTD_PUBLIC_BASE_URL,
        fetch: http.fetch,
        pacer: permissivePacer(),
        dailyPacer: permissivePacer(),
      }),
    });
    const release = Promise.withResolvers<void>();
    const busy = pacer.run(() => release.promise);
    try {
      const error = await sampler
        .sample([SEATTLE], 'usgs_3dep', createMockContext())
        .catch((e: unknown) => e);
      expect(mcpData(error)).toMatchObject({
        reason: 'sampling_deadline_exceeded',
        provider: 'usgs_3dep',
      });
      expect(mcpData((error as McpError).cause)).toMatchObject({ reason: 'pacer_shed' });
    } finally {
      release.resolve();
      await busy;
    }
  });

  it('maps an Open Topo Data request-pacer shed to sampling_deadline_exceeded', async () => {
    const pacer = createPacer({ name: 'otd-gap', maxConcurrent: 1, minStartGapMs: 60_000 });
    const http = createFetchMock([otdRoute(OTD_PUBLIC_BASE_URL, otdByPoint())]);
    const sampler = new ElevationSampler({
      budgetMs: 1_000,
      epqs: new UsgsEpqsClient({ fetch: http.fetch, pacer: permissivePacer() }),
      imageServer: new UsgsImageServer(http.fetch),
      openTopoData: new OpenTopoDataClient({
        baseUrl: OTD_PUBLIC_BASE_URL,
        fetch: http.fetch,
        pacer,
        dailyPacer: permissivePacer(),
      }),
    });
    await sampler.sample([LONDON], 'opentopodata', createMockContext());
    const error = await sampler
      .sample([SYDNEY], 'opentopodata', createMockContext())
      .catch((e: unknown) => e);

    expect(mcpData(error)).toMatchObject({
      reason: 'sampling_deadline_exceeded',
      budgetMs: 1_000,
      provider: 'opentopodata',
    });
    expect(mcpData((error as McpError).cause)).toMatchObject({ reason: 'pacer_shed' });
    expect(http.calls).toHaveLength(1);
  });
});

describe('ElevationSampler.sample: cancellation', () => {
  it('rethrows the abort reason unchanged when cancelled during a 3DEP request', async () => {
    const reason = new Error('client cancelled');
    const controller = new AbortController();
    const { sampler } = harness({
      epqs: () =>
        new Promise<Response>((_resolve, reject) => {
          controller.signal.addEventListener('abort', () => reject(reason));
        }),
    });
    const pending = sampler.sample(
      [SEATTLE],
      'usgs_3dep',
      createMockContext({ signal: controller.signal }),
    );
    await new Promise((resolve) => setTimeout(resolve, 10));
    controller.abort(reason);
    await expect(pending).rejects.toBe(reason);
  });

  it('rethrows the abort reason unchanged when cancelled during an Open Topo Data request', async () => {
    const reason = new Error('client cancelled');
    const controller = new AbortController();
    const { sampler } = harness({
      otd: () =>
        new Promise<Response>((_resolve, reject) => {
          controller.signal.addEventListener('abort', () => reject(reason));
        }),
    });
    const pending = sampler.sample(
      [LONDON],
      'opentopodata',
      createMockContext({ signal: controller.signal }),
    );
    await new Promise((resolve) => setTimeout(resolve, 10));
    controller.abort(reason);
    await expect(pending).rejects.toBe(reason);
  });

  it.each(['auto', 'usgs_3dep', 'opentopodata'] as const satisfies readonly SourceMode[])(
    'sends nothing when the signal is already aborted (%s)',
    async (mode) => {
      const reason = new Error('already cancelled');
      const controller = new AbortController();
      controller.abort(reason);
      const { http, sampler } = harness({
        epqs: () => epqsResponse(epqsHitBody()),
        otd: otdByPoint(),
      });
      await expect(
        sampler.sample([SEATTLE], mode, createMockContext({ signal: controller.signal })),
      ).rejects.toBe(reason);
      expect(http.calls).toHaveLength(0);
    },
  );
});

describe('ElevationSampler.sample: logging', () => {
  it('logs one info record with the call statistics', async () => {
    const { sampler } = harness({
      epqs: epqsByPoint((point) =>
        point.lat === SEATTLE.lat
          ? epqsResponse(epqsHitBody())
          : epqsResponse(EPQS_MISS_TEXTS.callFailed),
      ),
      otd: otdByPoint(() => ({ dataset: 'mapzen', elevation: -4389 })),
    });
    const ctx = createMockContext();
    await sampler.sample([SEATTLE, SEATTLE, { lat: 30, lon: -140 }, LONDON], 'auto', ctx);

    const infos = (ctx.log as MockContextLogger).calls.filter((call) => call.level === 'info');
    expect(infos).toHaveLength(1);
    expect(infos[0]?.data).toMatchObject({
      mode: 'auto',
      inputPoints: 4,
      uniquePoints: 3,
      epqsHits: 1,
      epqsMisses: 1,
      outsideEnvelope: 1,
      openTopoDataRequests: 1,
      openTopoDataPoints: 2,
      answersByDataset: { usgs_3dep: 1, mapzen: 2 },
    });
    expect(infos[0]?.data).toHaveProperty('elapsedMs', expect.any(Number));
  });
});

describe('elevation services lifecycle', () => {
  afterEach(() => {
    disposeElevationServices();
  });

  it('refuses the sampler before initialization', () => {
    disposeElevationServices();
    expect(() => getElevationSampler()).toThrow(/not initialized/);
  });

  it('builds a sampler over the injected fetch and the configured base URL', async () => {
    const http = createFetchMock([
      otdRoute(
        OTD_SELF_HOSTED_BASE_URL,
        otdByPoint(() => ({ dataset: 'srtm30m', elevation: 7 })),
      ),
    ]);
    initElevationServices({ openTopoDataBaseUrl: OTD_SELF_HOSTED_BASE_URL }, { fetch: http.fetch });

    const samples = await getElevationSampler().sample(
      [LONDON],
      'opentopodata',
      createMockContext(),
    );
    expect(samples).toStrictEqual([
      { lat: 51.5074, lon: -0.1278, elevation_m: 7, dataset: 'srtm30m', resolution_m: 30.9 },
    ]);
    expect(new URL(http.calls[0]!.request.url).origin).toBe(OTD_SELF_HOSTED_BASE_URL);
  });

  it('routes 3DEP through the injected fetch too', async () => {
    const http = createFetchMock([
      epqsRoute(() => epqsResponse(epqsHitBody())),
      catalogRoute(defaultCatalogResponse),
    ]);
    initElevationServices({ openTopoDataBaseUrl: OTD_SELF_HOSTED_BASE_URL }, { fetch: http.fetch });
    const samples = await getElevationSampler().sample([SEATTLE], 'auto', createMockContext());
    expect(samples[0]?.dataset).toBe('usgs_3dep');
  });

  it('forgets the sampler on dispose, and dispose is safe to repeat', () => {
    initElevationServices(
      { openTopoDataBaseUrl: OTD_SELF_HOSTED_BASE_URL },
      { fetch: createFetchMock().fetch },
    );
    expect(getElevationSampler()).toBeInstanceOf(ElevationSampler);
    disposeElevationServices();
    expect(() => getElevationSampler()).toThrow(/not initialized/);
    expect(() => disposeElevationServices()).not.toThrow();
  });

  it('replaces the sampler when initialized again', () => {
    const fetchImpl = createFetchMock().fetch;
    initElevationServices({ openTopoDataBaseUrl: OTD_SELF_HOSTED_BASE_URL }, { fetch: fetchImpl });
    const first = getElevationSampler();
    initElevationServices({ openTopoDataBaseUrl: OTD_SELF_HOSTED_BASE_URL }, { fetch: fetchImpl });
    expect(getElevationSampler()).not.toBe(first);
  });
});

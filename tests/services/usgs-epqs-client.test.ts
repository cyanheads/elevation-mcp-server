/**
 * @fileoverview Tests for UsgsEpqsClient: the request allowlist, 200 hit/miss
 * classification, resolution normalization, the status accept-list, the body
 * ceiling, pacing, retry, and `usgs_unavailable`.
 * @module tests/services/usgs-epqs-client.test
 */

import { JsonRpcErrorCode, McpError } from '@cyanheads/mcp-ts-core/errors';
import {
  createFetchMock,
  createMockContext,
  type MockContextLogger,
} from '@cyanheads/mcp-ts-core/testing';
import { createPacer } from '@cyanheads/mcp-ts-core/utils';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { UsgsEpqsClient } from '@/services/usgs-epqs/usgs-epqs-client.js';
import {
  EPQS_BAD_REQUEST_BODY,
  EPQS_FORBIDDEN_BODY,
  EPQS_HIT_NUMERIC_VALUE,
  EPQS_HIT_SEATTLE,
  EPQS_MISS_SPATIAL_REFERENCE,
  EPQS_MISS_TEXTS,
  EPQS_ORIGIN,
  EPQS_PATH,
  EPQS_RESOLUTION_NINTH_ARCSEC,
  EPQS_RESOLUTION_ONE_ARCSEC,
  EPQS_RESOLUTION_THIRD_ARCSEC,
  EPQS_SENTINEL_BODY,
  epqsHitBody,
  epqsOversizedBody,
  epqsResponse,
} from '../fixtures/epqs.js';
import {
  epqsRoute,
  hangUntilAborted,
  permissivePacer,
  providerOptions,
  rejectionWithFakeTimers,
  sequence,
  settleWithFakeTimers,
} from '../fixtures/harness.js';

const POINT = { lat: 47.6062, lon: -122.3321 };

function setup(respond: Parameters<typeof epqsRoute>[0]) {
  const http = createFetchMock([epqsRoute(respond)]);
  const client = new UsgsEpqsClient({ fetch: http.fetch, pacer: permissivePacer() });
  return { client, http };
}

function mcpData(error: unknown): Record<string, unknown> {
  expect(error).toBeInstanceOf(McpError);
  return (error as McpError).data ?? {};
}

describe('UsgsEpqsClient request', () => {
  it('sends exactly the five allowlisted parameters, in meters, to the EPQS endpoint', async () => {
    const { client, http } = setup(() => epqsResponse(EPQS_HIT_SEATTLE));
    await client.lookup(POINT, providerOptions());

    expect(http.calls).toHaveLength(1);
    const request = http.calls[0]!.request;
    const url = new URL(request.url);
    expect(request.method).toBe('GET');
    expect(url.origin).toBe(EPQS_ORIGIN);
    expect(url.pathname).toBe(EPQS_PATH);
    expect(Object.fromEntries(url.searchParams)).toEqual({
      x: '-122.332100',
      y: '47.606200',
      wkid: '4326',
      units: 'Meters',
      includeDate: 'true',
    });
    expect([...url.searchParams.keys()].sort()).toEqual(['includeDate', 'units', 'wkid', 'x', 'y']);
  });

  it('sends x as longitude and y as latitude, printed to 6 decimals', async () => {
    const { client, http } = setup(() => epqsResponse(EPQS_HIT_SEATTLE));
    await client.lookup({ lat: -33.8, lon: 151.25 }, providerOptions());
    const params = new URL(http.calls[0]!.request.url).searchParams;
    expect(params.get('x')).toBe('151.250000');
    expect(params.get('y')).toBe('-33.800000');
  });

  it('identifies itself and asks for JSON', async () => {
    const { client, http } = setup(() => epqsResponse(EPQS_HIT_SEATTLE));
    await client.lookup(POINT, providerOptions());
    const headers = http.calls[0]!.request.headers;
    expect(headers.get('user-agent')).toBe('elevation-mcp-server');
    expect(headers.get('accept')).toBe('application/json');
  });
});

describe('UsgsEpqsClient 200 classification', () => {
  it('reads a hit with a string value: elevation, raster, resolution, acquisition date', async () => {
    const { client } = setup(() => epqsResponse(EPQS_HIT_SEATTLE));
    await expect(client.lookup(POINT, providerOptions())).resolves.toEqual({
      kind: 'hit',
      value: {
        dataset: 'usgs_3dep',
        elevation_m: 52.377716064,
        resolution_m: 1,
        raster_id: 102575,
        acquisition_date: '6/5/2021',
      },
    });
  });

  it('accepts a numeric value (the Feet-shaped body)', async () => {
    const { client } = setup(() => epqsResponse(EPQS_HIT_NUMERIC_VALUE));
    const result = await client.lookup(POINT, providerOptions());
    expect(result).toMatchObject({ kind: 'hit', value: { elevation_m: 171.84290597141376 } });
  });

  it('keeps a negative elevation above the floor (Death Valley)', async () => {
    const { client } = setup(() => epqsResponse(epqsHitBody({ value: '-84.7' })));
    const result = await client.lookup(POINT, providerOptions());
    expect(result).toMatchObject({ kind: 'hit', value: { elevation_m: -84.7 } });
  });

  it('passes an acquisition date with a zero month or day through verbatim', async () => {
    const { client } = setup(() => epqsResponse(epqsHitBody({ acquisitionDate: '0/5/2013' })));
    const result = await client.lookup(POINT, providerOptions());
    expect(result).toMatchObject({ kind: 'hit', value: { acquisition_date: '0/5/2013' } });
  });

  it('omits fields the body lacks instead of inventing them', async () => {
    const body = epqsHitBody({ rasterId: null, resolution: null, acquisitionDate: null });
    const { client } = setup(() => epqsResponse(body));
    await expect(client.lookup(POINT, providerOptions())).resolves.toStrictEqual({
      kind: 'hit',
      value: { dataset: 'usgs_3dep', elevation_m: 52.377716064 },
    });
  });

  it('drops a non-integer raster id, a blank acquisition date, and a non-numeric resolution', async () => {
    const body = JSON.stringify({
      value: '10.5',
      rasterId: 1.5,
      resolution: '1',
      attributes: { AcquisitionDate: '' },
    });
    const { client } = setup(() => epqsResponse(body));
    await expect(client.lookup(POINT, providerOptions())).resolves.toStrictEqual({
      kind: 'hit',
      value: { dataset: 'usgs_3dep', elevation_m: 10.5 },
    });
  });

  it('ignores a non-string acquisition date and a non-object attributes member', async () => {
    const { client } = setup(
      sequence(
        () =>
          epqsResponse(JSON.stringify({ value: '1', attributes: { AcquisitionDate: 20210605 } })),
        () => epqsResponse(JSON.stringify({ value: '1', attributes: 'x' })),
        () => epqsResponse(JSON.stringify({ value: '1', attributes: null })),
      ),
    );
    for (let i = 0; i < 3; i++) {
      await expect(client.lookup(POINT, providerOptions())).resolves.toStrictEqual({
        kind: 'hit',
        value: { dataset: 'usgs_3dep', elevation_m: 1 },
      });
    }
  });

  describe('coverage misses (HTTP 200 without a usable value)', () => {
    it.each([
      ['invalid or missing input parameters', EPQS_MISS_TEXTS.invalidParameters],
      ['call failed', EPQS_MISS_TEXTS.callFailed],
      ['transformation unavailable', EPQS_MISS_TEXTS.transformationUnavailable],
      ['empty geometry', EPQS_MISS_TEXTS.emptyGeometry],
      ['spatialReference invalid', EPQS_MISS_SPATIAL_REFERENCE],
    ])('treats the plain-text body "%s" as a miss, not an error', async (_name, text) => {
      const { client, http } = setup(() => epqsResponse(text));
      await expect(client.lookup(POINT, providerOptions())).resolves.toStrictEqual({
        kind: 'miss',
      });
      expect(http.calls).toHaveLength(1);
    });

    it.each([
      ['the -1000000 sentinel as a string', EPQS_SENTINEL_BODY],
      ['the -1000000 sentinel as a number', epqsHitBody({ value: -1000000 })],
      ['a value just under the -12,000 m floor', epqsHitBody({ value: '-12000.01' })],
      ['JSON with no value member', epqsHitBody({ value: null })],
      ['a null value', '{"value":null}'],
      ['an empty-string value', '{"value":""}'],
      ['a whitespace value', '{"value":"  "}'],
      ['a non-numeric string value', '{"value":"n/a"}'],
      ['a boolean value', '{"value":true}'],
      ['a JSON array', '[1,2,3]'],
      ['a JSON null', 'null'],
      ['a JSON string', '"52.3"'],
      ['an empty body', ''],
    ])('treats %s as a miss', async (_name, body) => {
      const { client } = setup(() => epqsResponse(body));
      await expect(client.lookup(POINT, providerOptions())).resolves.toStrictEqual({
        kind: 'miss',
      });
    });

    it('treats a value exactly at the -12,000 m floor as a hit', async () => {
      const { client } = setup(() => epqsResponse(epqsHitBody({ value: '-12000' })));
      const result = await client.lookup(POINT, providerOptions());
      expect(result).toMatchObject({ kind: 'hit', value: { elevation_m: -12000 } });
    });

    it('logs the miss text at debug, truncated, and never returns it', async () => {
      const long = `${EPQS_MISS_TEXTS.callFailed} ${'z'.repeat(400)}`;
      const { client } = setup(() => epqsResponse(long));
      const ctx = createMockContext();
      const result = await client.lookup(POINT, providerOptions({ ctx }));

      expect(JSON.stringify(result)).not.toContain('Failed cloud operation');
      const calls = (ctx.log as MockContextLogger).calls.filter((call) => call.level === 'debug');
      const missLog = calls.find((call) => call.msg.includes('no value'));
      expect(missLog).toBeDefined();
      const logged = String((missLog?.data as { body?: string } | undefined)?.body);
      expect(logged).toHaveLength(200);
      expect(logged.startsWith('Call failed.')).toBe(true);
    });
  });

  describe('resolution normalization', () => {
    it.each([
      ['1 m lidar (meters as given)', 1, 1],
      ['5 m lidar (meters as given)', 5, 5],
      ['the 0.5 boundary reads as meters', 0.5, 0.5],
      ['1/9 arc-second reads as degrees', EPQS_RESOLUTION_NINTH_ARCSEC, 3.4],
      ['1/3 arc-second reads as degrees', EPQS_RESOLUTION_THIRD_ARCSEC, 10.3],
      ['1 arc-second reads as degrees', EPQS_RESOLUTION_ONE_ARCSEC, 30.9],
    ])('%s', async (_name, resolution, expected) => {
      const { client } = setup(() => epqsResponse(epqsHitBody({ resolution })));
      const result = await client.lookup(POINT, providerOptions());
      expect(result).toMatchObject({ kind: 'hit', value: { resolution_m: expected } });
    });

    it.each([
      ['0.01 (between the bands)', 0.01],
      ['0.1 (between the bands)', 0.1],
      ['0.49 (between the bands)', 0.49],
      ['0 (unusable)', 0],
      ['a negative figure', -1],
    ])('omits the resolution for %s', async (_name, resolution) => {
      const { client } = setup(() => epqsResponse(epqsHitBody({ resolution })));
      const result = await client.lookup(POINT, providerOptions());
      expect(result).toMatchObject({ kind: 'hit' });
      expect(result.kind === 'hit' && 'resolution_m' in result.value).toBe(false);
    });
  });
});

describe('UsgsEpqsClient body ceiling (16 KiB)', () => {
  const CEILING = 16 * 1024;

  /** A JSON hit body of exactly `bytes` bytes (ASCII). */
  function bodyOfSize(bytes: number): string {
    const base = JSON.stringify({ value: '5', pad: '' });
    return JSON.stringify({ value: '5', pad: 'x'.repeat(bytes - base.length) });
  }

  it('reads a body of exactly the ceiling', async () => {
    const body = bodyOfSize(CEILING);
    expect(new TextEncoder().encode(body).byteLength).toBe(CEILING);
    const { client } = setup(() => epqsResponse(body));
    const result = await client.lookup(POINT, providerOptions());
    expect(result).toMatchObject({ kind: 'hit', value: { elevation_m: 5 } });
  });

  it('treats a body one byte over the ceiling as a miss', async () => {
    const body = bodyOfSize(CEILING + 1);
    const { client } = setup(() => epqsResponse(body));
    await expect(client.lookup(POINT, providerOptions())).resolves.toStrictEqual({ kind: 'miss' });
  });

  it('cancels the stream once past the ceiling instead of reading it all', async () => {
    let cancelled = false;
    let pulled = 0;
    const chunk = new TextEncoder().encode('x'.repeat(4096));
    const stream = new ReadableStream<Uint8Array>({
      pull(controller) {
        pulled++;
        controller.enqueue(chunk);
      },
      cancel() {
        cancelled = true;
      },
    });
    const { client } = setup(() => new Response(stream, { status: 200 }));
    await expect(client.lookup(POINT, providerOptions())).resolves.toStrictEqual({ kind: 'miss' });
    expect(cancelled).toBe(true);
    expect(pulled).toBeLessThan(20);
  });

  it('treats an over-ceiling JSON hit as a miss and logs the ceiling', async () => {
    const { client } = setup(() => epqsResponse(epqsOversizedBody()));
    const ctx = createMockContext();
    await expect(client.lookup(POINT, providerOptions({ ctx }))).resolves.toStrictEqual({
      kind: 'miss',
    });
    const logged = (ctx.log as MockContextLogger).calls.find((call) =>
      call.msg.includes('read ceiling'),
    );
    expect(logged?.data).toMatchObject({ maxBytes: CEILING });
  });
});

describe('UsgsEpqsClient non-200 statuses', () => {
  it('fails a 400 with the leading-space JSON body as usgs_unavailable, unretried, without upstream text', async () => {
    const { client, http } = setup(() => epqsResponse(EPQS_BAD_REQUEST_BODY, 400));
    const error = await client.lookup(POINT, providerOptions()).catch((e: unknown) => e);

    expect(http.calls).toHaveLength(1);
    expect(error).toBeInstanceOf(McpError);
    expect((error as McpError).code).toBe(JsonRpcErrorCode.ServiceUnavailable);
    expect(mcpData(error)).toMatchObject({
      reason: 'usgs_unavailable',
      retryable: false,
      status: 400,
    });
    expect((error as McpError).message).toBe('USGS 3DEP (EPQS) failed with HTTP 400.');
    expect(JSON.stringify(mcpData(error))).not.toContain('missing parameters');
  });

  it('fails a 403 (wrong path or missing gateway token) as usgs_unavailable, unretried', async () => {
    const { client, http } = setup(() => epqsResponse(EPQS_FORBIDDEN_BODY, 403));
    const error = await client.lookup(POINT, providerOptions()).catch((e: unknown) => e);
    expect(http.calls).toHaveLength(1);
    expect(mcpData(error)).toMatchObject({
      reason: 'usgs_unavailable',
      retryable: false,
      status: 403,
    });
    expect(JSON.stringify(error instanceof McpError ? error.message : '')).not.toContain(
      'Authentication Token',
    );
  });

  it('fails a non-200 success status (202) as usgs_unavailable, unretried', async () => {
    const { client, http } = setup(() => epqsResponse('{"value":"5"}', 202));
    const error = await client.lookup(POINT, providerOptions()).catch((e: unknown) => e);
    expect(http.calls).toHaveLength(1);
    expect(mcpData(error)).toMatchObject({ reason: 'usgs_unavailable', retryable: false });
  });

  it.each([301, 302, 303, 307, 308])(
    'does not follow a %i: usgs_unavailable, unretried, Location never named',
    async (status) => {
      const { client, http } = setup(
        () =>
          new Response(null, {
            status,
            headers: { location: 'https://elsewhere.example.test/v1/json?steer=agent' },
          }),
      );
      const error = await client.lookup(POINT, providerOptions()).catch((e: unknown) => e);

      expect(http.calls).toHaveLength(1);
      expect(http.calls[0]!.request.redirect).toBe('manual');
      expect((error as McpError).message).toBe(`USGS 3DEP (EPQS) failed with HTTP ${status}.`);
      expect(mcpData(error)).toStrictEqual({
        reason: 'usgs_unavailable',
        retryable: false,
        status,
      });
    },
  );

  it('does not retry a 501 (the upstream declares the method absent)', async () => {
    const { client, http } = setup(() => epqsResponse('', 501));
    const error = await client.lookup(POINT, providerOptions()).catch((e: unknown) => e);
    expect(http.calls).toHaveLength(1);
    expect(mcpData(error)).toMatchObject({
      reason: 'usgs_unavailable',
      retryable: false,
      status: 501,
    });
  });
});

describe('UsgsEpqsClient retry ladder', () => {
  beforeEach(() => {
    vi.useFakeTimers();
  });
  afterEach(() => {
    vi.useRealTimers();
  });

  it.each([500, 502, 503, 504, 408, 429])(
    'retries HTTP %i twice, then fails retryable usgs_unavailable with the status',
    async (status) => {
      const { client, http } = setup(() => epqsResponse('upstream trouble', status));
      const error = await rejectionWithFakeTimers(client.lookup(POINT, providerOptions()));

      expect(http.calls).toHaveLength(3);
      expect((error as McpError).code).toBe(JsonRpcErrorCode.ServiceUnavailable);
      expect(mcpData(error)).toMatchObject({ reason: 'usgs_unavailable', retryable: true, status });
      expect((error as McpError).cause).toBeInstanceOf(McpError);
      expect((error as McpError).message).not.toContain('upstream trouble');
    },
  );

  it('recovers when a later attempt succeeds', async () => {
    const { client, http } = setup(
      sequence(
        () => epqsResponse('', 500),
        () => epqsResponse('', 503),
        () => epqsResponse(EPQS_HIT_SEATTLE),
      ),
    );
    const startedAt = Date.now();
    const result = await settleWithFakeTimers(client.lookup(POINT, providerOptions()));

    expect(result).toMatchObject({ status: 'fulfilled', value: { kind: 'hit' } });
    expect(http.calls).toHaveLength(3);
    // 500 ms then 1,000 ms backoff, each with 25% jitter, plus up to one 250 ms drive step.
    const elapsed = Date.now() - startedAt;
    expect(elapsed).toBeGreaterThanOrEqual(1_100);
    expect(elapsed).toBeLessThanOrEqual(2_200);
  });

  it('honors a Retry-After within the 4 s cap, then fails with the 429 status', async () => {
    const { client, http } = setup(() => epqsResponse('', 429, { 'retry-after': '1' }));
    const startedAt = Date.now();
    const error = await rejectionWithFakeTimers(client.lookup(POINT, providerOptions()));

    expect(http.calls).toHaveLength(3);
    expect(mcpData(error)).toMatchObject({ reason: 'usgs_unavailable', status: 429 });
    expect(Date.now() - startedAt).toBeGreaterThanOrEqual(2_000);
  });

  it('fails fast on a Retry-After above the 4 s cap', async () => {
    const { client, http } = setup(() => epqsResponse('', 429, { 'retry-after': '30' }));
    const error = await rejectionWithFakeTimers(client.lookup(POINT, providerOptions()));

    expect(http.calls).toHaveLength(1);
    expect(mcpData(error)).toMatchObject({
      reason: 'usgs_unavailable',
      retryable: true,
      status: 429,
    });
  });

  it('retries a network failure, then reports usgs_unavailable with no status and the cause chained', async () => {
    const networkError = new TypeError('fetch failed');
    const { client, http } = setup(() => Promise.reject(networkError));
    const error = await rejectionWithFakeTimers(client.lookup(POINT, providerOptions()));

    expect(http.calls).toHaveLength(3);
    expect(mcpData(error)).toMatchObject({ reason: 'usgs_unavailable', retryable: true });
    expect(mcpData(error)).not.toHaveProperty('status');
    expect((error as McpError).message).toBe('USGS 3DEP (EPQS) did not answer.');
    expect((error as McpError).cause).toBeInstanceOf(McpError);
  });

  it('times each attempt out at 10 s and fails retryable usgs_unavailable after three attempts', async () => {
    const { client, http } = setup(hangUntilAborted);
    const startedAt = Date.now();
    const error = await rejectionWithFakeTimers(client.lookup(POINT, providerOptions()));

    expect(http.calls).toHaveLength(3);
    expect(mcpData(error)).toMatchObject({ reason: 'usgs_unavailable', retryable: true });
    expect(mcpData(error)).not.toHaveProperty('status');
    expect(Date.now() - startedAt).toBeGreaterThanOrEqual(30_000);
  });

  it('shortens the attempt timer to the remaining budget and passes the retry deadline through unchanged', async () => {
    const { client } = setup(hangUntilAborted);
    const error = await rejectionWithFakeTimers(
      client.lookup(POINT, providerOptions({ budgetMs: 3_000 })),
    );

    expect((error as McpError).code).toBe(JsonRpcErrorCode.Timeout);
    expect(mcpData(error)).toMatchObject({ reason: 'retry_deadline_exceeded', deadlineMs: 3_000 });
  });

  it('passes a backoff that would outlast the budget through as the retry deadline', async () => {
    const { client, http } = setup(() => epqsResponse('', 500));
    const error = await rejectionWithFakeTimers(
      client.lookup(POINT, providerOptions({ budgetMs: 800 })),
    );

    // First backoff (375-625 ms) fits; the second (750-1,250 ms) cannot.
    expect(http.calls.length).toBeLessThanOrEqual(2);
    expect(mcpData(error)).toMatchObject({ reason: 'retry_deadline_exceeded' });
  });
});

describe('UsgsEpqsClient cancellation', () => {
  it('rethrows the abort reason unchanged, not usgs_unavailable', async () => {
    const reason = new Error('caller went away');
    const controller = new AbortController();
    const { client } = setup(
      () =>
        new Promise<Response>((_resolve, reject) => {
          controller.signal.addEventListener('abort', () => reject(reason));
        }),
    );
    const pending = client.lookup(POINT, providerOptions({ signal: controller.signal }));
    await new Promise((resolve) => setTimeout(resolve, 10));
    controller.abort(reason);
    await expect(pending).rejects.toBe(reason);
  });

  it('rejects at once with the reason when the signal is already aborted', async () => {
    const reason = new Error('already cancelled');
    const controller = new AbortController();
    controller.abort(reason);
    const { client, http } = setup(() => epqsResponse(EPQS_HIT_SEATTLE));
    await expect(client.lookup(POINT, providerOptions({ signal: controller.signal }))).rejects.toBe(
      reason,
    );
    expect(http.calls).toHaveLength(0);
  });
});

describe('UsgsEpqsClient pacing', () => {
  afterEach(() => {
    vi.useRealTimers();
  });

  it('keeps at most 6 requests in flight under the default pacer', async () => {
    let inFlight = 0;
    let peak = 0;
    const releases: (() => void)[] = [];
    const http = createFetchMock([
      epqsRoute(
        () =>
          new Promise<Response>((resolve) => {
            inFlight++;
            peak = Math.max(peak, inFlight);
            releases.push(() => {
              inFlight--;
              resolve(epqsResponse(EPQS_HIT_SEATTLE));
            });
          }),
      ),
    ]);
    const client = new UsgsEpqsClient({ fetch: http.fetch });
    try {
      const lookups = Array.from({ length: 8 }, () => client.lookup(POINT, providerOptions()));
      await vi.waitFor(() => expect(inFlight).toBe(6));
      expect(http.calls).toHaveLength(6);
      const releaseAll = () => {
        while (releases.length > 0) releases.shift()?.();
      };
      releaseAll();
      await vi.waitFor(() => expect(http.calls).toHaveLength(8));
      releaseAll();
      await Promise.all(lookups);
      expect(peak).toBe(6);
      expect(http.calls).toHaveLength(8);
    } finally {
      client.dispose();
    }
  });

  it('starts at most 10 requests in a second under the default pacer', async () => {
    vi.useFakeTimers();
    const starts: number[] = [];
    const http = createFetchMock([
      epqsRoute(() => {
        starts.push(Date.now());
        return epqsResponse(EPQS_HIT_SEATTLE);
      }),
    ]);
    const client = new UsgsEpqsClient({ fetch: http.fetch });
    try {
      const t0 = Date.now();
      const result = await settleWithFakeTimers(
        Promise.all(Array.from({ length: 12 }, () => client.lookup(POINT, providerOptions()))),
        { stepMs: 50 },
      );
      expect(result.status).toBe('fulfilled');
      expect(starts).toHaveLength(12);
      expect(starts.slice(0, 10).every((start) => start - t0 < 100)).toBe(true);
      expect(starts.slice(10).every((start) => start - t0 >= 1_000)).toBe(true);
    } finally {
      client.dispose();
    }
  });

  it('runs lookups through an injected pacer (one at a time here)', async () => {
    let inFlight = 0;
    let peak = 0;
    const http = createFetchMock([
      epqsRoute(async () => {
        inFlight++;
        peak = Math.max(peak, inFlight);
        await new Promise((resolve) => setTimeout(resolve, 5));
        inFlight--;
        return epqsResponse(EPQS_HIT_SEATTLE);
      }),
    ]);
    const client = new UsgsEpqsClient({
      fetch: http.fetch,
      pacer: createPacer({ name: 'one-at-a-time', maxConcurrent: 1 }),
    });
    await Promise.all(Array.from({ length: 4 }, () => client.lookup(POINT, providerOptions())));
    expect(peak).toBe(1);
    expect(http.calls).toHaveLength(4);
  });

  it('passes a pacer shed through unchanged for the sampler to normalize', async () => {
    const pacer = createPacer({ name: 'shedding', maxConcurrent: 1, maxQueueDepth: 0 });
    const http = createFetchMock([epqsRoute(() => epqsResponse(EPQS_HIT_SEATTLE))]);
    const client = new UsgsEpqsClient({ fetch: http.fetch, pacer });

    const release = Promise.withResolvers<void>();
    const busy = pacer.run(() => release.promise);
    try {
      const error = await client.lookup(POINT, providerOptions()).catch((e: unknown) => e);
      expect((error as McpError).code).toBe(JsonRpcErrorCode.RateLimited);
      expect(mcpData(error)).toMatchObject({ reason: 'pacer_shed' });
      expect(http.calls).toHaveLength(0);
    } finally {
      release.resolve();
      await busy;
    }
  });

  it('rejects lookups queued behind a disposed pacer without sending them', async () => {
    const http = createFetchMock([epqsRoute(() => new Promise<Response>(() => undefined))]);
    const client = new UsgsEpqsClient({
      fetch: http.fetch,
      pacer: createPacer({ name: 'disposed', maxConcurrent: 1 }),
    });
    const inFlight = client.lookup(POINT, providerOptions());
    inFlight.catch(() => undefined);
    await vi.waitFor(() => expect(http.calls).toHaveLength(1));
    const queued = client.lookup(POINT, providerOptions());
    const settled = queued.catch((e: unknown) => e);
    client.dispose();

    const error = await settled;
    expect(error).toBeInstanceOf(McpError);
    expect((error as McpError).cause).toMatchObject({ code: JsonRpcErrorCode.RequestCancelled });
    expect(http.calls).toHaveLength(1);
  });
});

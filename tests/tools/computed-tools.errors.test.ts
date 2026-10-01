/**
 * @fileoverview The six service failure reasons on the wire for the three
 * computed tools (profile, grid, line of sight): non-2xx, malformed body,
 * timeout, rate limit, daily limit, config rejection, provoked 400, and
 * cancellation, each with the declared envelope and no upstream text leaking.
 * @module tests/tools/computed-tools.errors.test
 */

import { JsonRpcErrorCode } from '@cyanheads/mcp-ts-core/errors';
import { createMockContext } from '@cyanheads/mcp-ts-core/testing';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { checkLineOfSightTool } from '@/mcp-server/tools/definitions/check-line-of-sight.tool.js';
import { getGridTool } from '@/mcp-server/tools/definitions/get-grid.tool.js';
import { getProfileTool } from '@/mcp-server/tools/definitions/get-profile.tool.js';
import {
  disposeElevationServices,
  getElevationSampler,
} from '@/services/elevation/elevation-sampler.js';
import { epqsResponse } from '../fixtures/epqs.js';
import { hangUntilAborted, otdByPoint, settleWithFakeTimers } from '../fixtures/harness.js';
import {
  OTD_429_BODY,
  OTD_500_BODY,
  OTD_PUBLIC_BASE_URL,
  otdOkBody,
  otdResponse,
  parseSentLocations,
} from '../fixtures/opentopodata.js';
import {
  errorOf,
  expectDeclaredError,
  runTool,
  srtm,
  type ToolDefinition,
  type ToolResult,
  useUpstreams,
} from '../fixtures/tool-harness.js';

/** A call over 3DEP territory (the Puget Sound lowlands) that sends one request per node to either provider. */
const SPECS: {
  input: (source: string) => Record<string, unknown>;
  label: string;
  tool: ToolDefinition;
}[] = [
  {
    label: 'elevation_get_profile',
    tool: getProfileTool,
    input: (source) => ({
      path: [
        { lat: 47, lon: -122 },
        { lat: 47.002, lon: -122 },
      ],
      samples: 3,
      source,
    }),
  },
  {
    label: 'elevation_get_grid',
    tool: getGridTool,
    input: (source) => ({
      south: 47,
      west: -122,
      north: 47.002,
      east: -121.998,
      rows: 2,
      cols: 2,
      source,
    }),
  },
  {
    label: 'elevation_check_line_of_sight',
    tool: checkLineOfSightTool,
    input: (source) => ({
      observer: { lat: 47, lon: -122 },
      target: { lat: 47.002, lon: -122 },
      samples: 3,
      source,
    }),
  },
];

beforeEach(() => {
  disposeElevationServices();
});
afterEach(() => {
  disposeElevationServices();
  vi.useRealTimers();
});

describe.each(SPECS)('$label service failures on the wire', ({ tool, input }) => {
  const run = (source: string, context?: Parameters<typeof runTool>[2]) =>
    runTool(tool, input(source), context);

  const settled = async (promise: Promise<ToolResult>) => {
    const result = await settleWithFakeTimers(promise);
    return (result as PromiseFulfilledResult<ToolResult>).value;
  };

  it('usgs_unavailable: EPQS keeps failing (retryable), with no upstream text in the error', async () => {
    vi.useFakeTimers();
    useUpstreams({ epqs: () => epqsResponse('Service Unavailable body', 503) });
    const error = expectDeclaredError(
      tool,
      await settled(run('usgs_3dep')),
      'usgs_unavailable',
      JsonRpcErrorCode.ServiceUnavailable,
    );
    expect(error.data).toMatchObject({ retryable: true, status: 503 });
    expect(JSON.stringify(error)).not.toContain('Service Unavailable body');
  });

  it('usgs_unavailable: an EPQS 4xx is not retryable', async () => {
    useUpstreams({ epqs: () => epqsResponse('{"message":"Missing Authentication Token"}', 403) });
    const error = expectDeclaredError(
      tool,
      await run('usgs_3dep'),
      'usgs_unavailable',
      JsonRpcErrorCode.ServiceUnavailable,
    );
    expect(error.data).toMatchObject({ retryable: false, status: 403 });
    expect(JSON.stringify(error)).not.toContain('Authentication Token');
  });

  it('opentopodata_unavailable: a 500 (retryable), with no upstream text in the error', async () => {
    vi.useFakeTimers();
    useUpstreams({ otd: () => otdResponse(OTD_500_BODY, 500) });
    const error = expectDeclaredError(
      tool,
      await settled(run('opentopodata')),
      'opentopodata_unavailable',
      JsonRpcErrorCode.ServiceUnavailable,
    );
    expect(error.data).toMatchObject({ retryable: true, status: 500 });
    expect(JSON.stringify(error)).not.toContain('Internal server error');
  });

  it('opentopodata_unavailable: a 200 body with the wrong number of results', async () => {
    vi.useFakeTimers();
    useUpstreams({ otd: () => otdResponse('{"status":"OK","results":[]}') });
    expectDeclaredError(
      tool,
      await settled(run('opentopodata')),
      'opentopodata_unavailable',
      JsonRpcErrorCode.ServiceUnavailable,
    );
  });

  it('opentopodata_unavailable: a 200 body that is not JSON', async () => {
    vi.useFakeTimers();
    useUpstreams({ otd: () => otdResponse('<html>gateway</html>') });
    const error = expectDeclaredError(
      tool,
      await settled(run('opentopodata')),
      'opentopodata_unavailable',
      JsonRpcErrorCode.ServiceUnavailable,
    );
    expect(JSON.stringify(error)).not.toContain('gateway');
  });

  it('opentopodata_unavailable: a dataset name that was not requested, never echoed', async () => {
    vi.useFakeTimers();
    useUpstreams({
      otd: async (request) => {
        const points = parseSentLocations(await request.text());
        return otdResponse(
          otdOkBody(
            points,
            points.map(() => ({ dataset: 'mapzen\r\n# Injected', elevation: 5 })),
          ),
        );
      },
    });
    const result = await settled(run('opentopodata'));
    const error = expectDeclaredError(
      tool,
      result,
      'opentopodata_unavailable',
      JsonRpcErrorCode.ServiceUnavailable,
    );
    expect(JSON.stringify(error)).not.toContain('Injected');
    expect(JSON.stringify(result.content)).not.toContain('Injected');
    expect(error.message).toBe(
      'The Open Topo Data instance answered with a dataset this server did not ask for (result 0; it requested srtm30m,mapzen).',
    );
    expect(error.data).not.toHaveProperty('detail');
    expect(error.data).not.toHaveProperty('operation');
  });

  it('opentopodata_rate_limited: a 429 with a long Retry-After, carrying retryAfter in seconds', async () => {
    useUpstreams({ otd: () => otdResponse(OTD_429_BODY, 429, { 'retry-after': '30' }) });
    const error = expectDeclaredError(
      tool,
      await run('opentopodata'),
      'opentopodata_rate_limited',
      JsonRpcErrorCode.RateLimited,
    );
    expect(error.data).toMatchObject({ retryable: true, retryAfter: 30 });
    expect(JSON.stringify(error)).not.toContain('Rate limit exceeded.');
  });

  it('opentopodata_daily_limit: the public instance window spent, nothing sent, not retryable', async () => {
    vi.useFakeTimers();
    const http = useUpstreams({ baseUrl: OTD_PUBLIC_BASE_URL, otd: otdByPoint() });
    const sampler = getElevationSampler();
    const ctx = createMockContext();
    for (let i = 0; i < 1_000; i++) {
      await vi.advanceTimersByTimeAsync(1_100);
      await sampler.sample([{ lat: -50 + i * 0.001, lon: 100 }], 'opentopodata', ctx);
    }
    expect(http.calls).toHaveLength(1_000);

    await vi.advanceTimersByTimeAsync(1_100);
    const error = expectDeclaredError(
      tool,
      await run('opentopodata'),
      'opentopodata_daily_limit',
      JsonRpcErrorCode.RateLimited,
    );
    expect(error.data).toMatchObject({ retryable: false });
    expect(error.data?.retryAfter).toBeGreaterThan(80_000);
    expect(http.calls).toHaveLength(1_000);
  }, 60_000);

  it.each([401, 403, 404])(
    'opentopodata_config_rejected: the instance answers HTTP %i',
    async (status) => {
      useUpstreams({ otd: () => otdResponse('{"error":"nope"}', status) });
      const error = expectDeclaredError(
        tool,
        await run('opentopodata'),
        'opentopodata_config_rejected',
        JsonRpcErrorCode.ConfigurationError,
      );
      expect(error.data).toMatchObject({ retryable: false, status });
    },
  );

  it('opentopodata_config_rejected: a 400 naming a dataset the instance lacks', async () => {
    useUpstreams({
      otd: () =>
        otdResponse(
          '{"error":"Dataset \'mapzen\' not in config.","status":"INVALID_REQUEST"}',
          400,
        ),
    });
    const error = expectDeclaredError(
      tool,
      await run('opentopodata'),
      'opentopodata_config_rejected',
      JsonRpcErrorCode.ConfigurationError,
    );
    expect(JSON.stringify(error)).not.toContain("'mapzen' not in config");
  });

  it('sampling_deadline_exceeded: the 45 s budget runs out', async () => {
    vi.useFakeTimers();
    useUpstreams({ otd: hangUntilAborted });
    const error = expectDeclaredError(
      tool,
      await settled(run('opentopodata')),
      'sampling_deadline_exceeded',
      JsonRpcErrorCode.Timeout,
    );
    expect(error.data).toMatchObject({ budgetMs: 45_000 });
    expect(error.data?.elapsedMs).toBeGreaterThanOrEqual(45_000);
  });

  it('a 400 this server provoked is an InternalError with no declared reason', async () => {
    useUpstreams({
      otd: () => otdResponse('{"error":"Invalid JSON.","status":"INVALID_REQUEST"}', 400),
    });
    const result = await run('opentopodata');
    expect(result.isError).toBe(true);
    const error = errorOf(result);
    expect(error.code).toBe(JsonRpcErrorCode.InternalError);
    expect(error.data).not.toHaveProperty('reason');
    expect(JSON.stringify(error)).not.toContain('Invalid JSON');
  });

  it('a cancelled call settles as RequestCancelled, not as a provider failure', async () => {
    const controller = new AbortController();
    controller.abort(new Error('client cancelled'));
    useUpstreams({ otd: otdByPoint(() => srtm(10)) });
    const result = await run('opentopodata', { context: { signal: controller.signal } });
    expect(result.isError).toBe(true);
    expect(errorOf(result).code).toBe(JsonRpcErrorCode.RequestCancelled);
  });

  it('a 3DEP outage does not fall back to Open Topo Data', async () => {
    const http = useUpstreams({ epqs: () => epqsResponse('', 403), otd: otdByPoint() });
    const result = await run('auto');
    expect(errorOf(result).data?.reason).toBe('usgs_unavailable');
    expect(http.calls.every((call) => call.request.method === 'GET')).toBe(true);
  });

  it('an upstream failure returns no partial result and no attribution', async () => {
    useUpstreams({ epqs: () => epqsResponse('', 403) });
    const result = await run('usgs_3dep');
    expect(result.isError).toBe(true);
    expect(result.structuredContent).not.toHaveProperty('attribution');
    expect(result.structuredContent).not.toHaveProperty('samples');
  });
});

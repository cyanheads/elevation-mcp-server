/**
 * @fileoverview Harness shared by the tool tests: wires the sampler singleton
 * to a fetch mock, runs a tool through `runToolContract`, reads the result
 * surfaces, asserts the declared-error envelope, and builds upstream answers
 * keyed by coordinate.
 * @module tests/fixtures/tool-harness
 */

import {
  createFetchMock,
  type FetchMockHarness,
  runToolContract,
} from '@cyanheads/mcp-ts-core/testing';
import { expect } from 'vitest';
import { initElevationServices } from '@/services/elevation/elevation-sampler.js';
import type { LatLon } from '@/services/elevation/types.js';
import { EPQS_MISS_TEXTS, epqsHitBody, epqsResponse } from './epqs.js';
import { epqsByPoint, epqsRoute, otdByPoint, otdRoute } from './harness.js';
import { OTD_SELF_HOSTED_BASE_URL, type OtdAnswer } from './opentopodata.js';

export type ToolDefinition = Parameters<typeof runToolContract>[0];
export type ToolResult = Awaited<ReturnType<typeof runToolContract>>;
export type ToolContext = Parameters<typeof runToolContract>[2];

export interface Upstreams {
  baseUrl?: string;
  epqs?: Parameters<typeof epqsRoute>[0];
  otd?: Parameters<typeof otdRoute>[1];
}

/** Wires the sampler singleton to a fetch mock, as `createApp({ setup })` does with real fetch. */
export function useUpstreams({
  baseUrl = OTD_SELF_HOSTED_BASE_URL,
  epqs = () => epqsResponse(EPQS_MISS_TEXTS.callFailed),
  otd = otdByPoint(),
}: Upstreams = {}): FetchMockHarness {
  const http = createFetchMock([epqsRoute(epqs), otdRoute(baseUrl, otd)]);
  initElevationServices({ openTopoDataBaseUrl: baseUrl }, { fetch: http.fetch });
  return http;
}

/** Runs a tool through the production parse, handler, format, enrichment, and error envelope. */
export const runTool = (tool: ToolDefinition, input: unknown, context?: ToolContext) =>
  runToolContract(tool, input as never, context);

export const structured = (result: ToolResult) =>
  (result.structuredContent ?? {}) as Record<string, any>;

export const contentText = (result: ToolResult) =>
  result.content.map((block) => (block.type === 'text' ? block.text : '')).join('');

export const errorOf = (result: ToolResult) =>
  (
    result.structuredContent as {
      error: { code: number; data?: Record<string, any>; message: string };
    }
  ).error;

/**
 * Asserts the envelope a client receives for a declared reason: error flag,
 * code, reason, recovery hint (the definition's own text), the text twin, and
 * that no success-only field leaked into the error.
 */
export function expectDeclaredError(
  tool: ToolDefinition,
  result: ToolResult,
  reason: string,
  code: number,
) {
  const recovery = tool.errors?.find((entry) => entry.reason === reason)?.recovery;
  expect(recovery, `${tool.name} declares ${reason}`).toBeTypeOf('string');
  expect(result.isError).toBe(true);
  const error = errorOf(result);
  expect(error.code).toBe(code);
  expect(error.data?.reason).toBe(reason);
  expect(error.data?.recovery?.hint).toBe(recovery);
  const text = contentText(result);
  expect(text).toContain(`Error: ${error.message}`);
  expect(text).toContain(`Recovery: ${recovery}`);
  expect(text).toContain(`reason ${reason}`);
  expect(structured(result)).not.toHaveProperty('attribution');
  return error;
}

/**
 * Every scalar in a structured value as the string `format()` is expected to
 * print: numbers and strings (nulls and booleans are skipped).
 */
export function leafStrings(value: unknown): string[] {
  if (value === null || value === undefined || typeof value === 'boolean') return [];
  if (Array.isArray(value)) return value.flatMap(leafStrings);
  if (typeof value === 'object') return Object.values(value).flatMap(leafStrings);
  return [String(value)];
}

/** A coordinate key at 6 decimals, the precision the sampler rounds to. */
export const at = (lat: number, lon: number) => `${lat.toFixed(6)},${lon.toFixed(6)}`;
export const keyOf = (point: LatLon) => at(point.lat, point.lon);

export const srtm = (elevation: number | null): OtdAnswer =>
  elevation === null ? { dataset: 'mapzen', elevation: null } : { dataset: 'srtm30m', elevation };
export const mapzen = (elevation: number | null): OtdAnswer => ({ dataset: 'mapzen', elevation });

/**
 * An Open Topo Data responder keyed by coordinate: points not in the table
 * have no data (a null Mapzen elevation).
 */
export const otdAnswers = (table: Record<string, OtdAnswer>) =>
  otdByPoint((point) => table[keyOf(point)] ?? mapzen(null));

/** A USGS 3DEP answer: a value in meters and an optional raster resolution in meters. */
export interface EpqsAnswer {
  resolution?: number;
  value: number;
}

/** An EPQS responder keyed by coordinate: points not in the table are a coverage miss. */
export const epqsAnswers = (table: Record<string, EpqsAnswer>) =>
  epqsByPoint((point) => {
    const answer = table[keyOf(point)];
    return answer
      ? epqsResponse(
          epqsHitBody({
            value: String(answer.value),
            ...(answer.resolution !== undefined && { resolution: answer.resolution }),
          }),
        )
      : epqsResponse(EPQS_MISS_TEXTS.invalidParameters);
  });

/** The Open Topo Data requests a fetch mock has seen, with the locations each sent. */
export async function otdRequests(http: FetchMockHarness) {
  return Promise.all(
    http.calls
      .filter((call) => call.request.method === 'POST')
      .map(async (call) => {
        const { locations } = JSON.parse(await call.request.clone().text()) as {
          locations: string;
        };
        return locations.split('|');
      }),
  );
}

export const epqsRequestCount = (http: FetchMockHarness) =>
  http.calls.filter((call) => call.request.method === 'GET').length;

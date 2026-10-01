/**
 * @fileoverview Test harness shared by the service and tool tests: upstream
 * routes for `createFetchMock`, response sequencing, permissive pacers, and a
 * fake-timer driver for retry ladders.
 * @module tests/fixtures/harness
 */

import {
  createMockContext,
  type FetchMockResponder,
  type FetchMockRoute,
} from '@cyanheads/mcp-ts-core/testing';
import { createPacer, type Pacer } from '@cyanheads/mcp-ts-core/utils';
import { vi } from 'vitest';
import type { LatLon, ProviderCallOptions } from '@/services/elevation/types.js';
import { EPQS_ORIGIN, EPQS_PATH } from './epqs.js';
import {
  OTD_PATH,
  type OtdAnswer,
  otdOkBody,
  otdResponse,
  parseSentLocations,
} from './opentopodata.js';

/** A pacer with no limits: every task starts at once. */
export function permissivePacer(name = 'test'): Pacer {
  return createPacer({ name });
}

/** Provider call options with a fresh mock context, a live signal, and the full budget. */
export function providerOptions(overrides: Partial<ProviderCallOptions> = {}): ProviderCallOptions {
  return {
    ctx: createMockContext(),
    signal: new AbortController().signal,
    budgetMs: 45_000,
    ...overrides,
  };
}

/** Route matching the EPQS endpoint by origin and path. */
export function epqsRoute(respond: FetchMockResponder): FetchMockRoute {
  return {
    method: 'GET',
    match: (request) => {
      const url = new URL(request.url);
      return url.origin === EPQS_ORIGIN && url.pathname === EPQS_PATH;
    },
    respond,
  };
}

/** Route matching an Open Topo Data instance's dataset-stack endpoint by origin and path. */
export function otdRoute(baseUrl: string, respond: FetchMockResponder): FetchMockRoute {
  const origin = new URL(baseUrl).origin;
  return {
    method: 'POST',
    match: (request) => {
      const url = new URL(request.url);
      return url.origin === origin && decodeURIComponent(url.pathname) === OTD_PATH;
    },
    respond,
  };
}

/** EPQS responder keyed by the point in the query string (`y` is latitude, `x` longitude). */
export function epqsByPoint(
  answer: (point: LatLon, request: Request) => Response | Promise<Response>,
): (request: Request) => Response | Promise<Response> {
  return (request) => {
    const params = new URL(request.url).searchParams;
    return answer({ lat: Number(params.get('y')), lon: Number(params.get('x')) }, request);
  };
}

/** Open Topo Data responder: answers every sent location with `answer(point)`, echoing coordinates as the upstream does. */
export function otdByPoint(
  answer: (point: LatLon) => OtdAnswer = () => ({ dataset: 'srtm30m', elevation: 100 }),
): (request: Request) => Promise<Response> {
  return async (request) => {
    const points = parseSentLocations(await request.text());
    return otdResponse(otdOkBody(points, points.map(answer)));
  };
}

/**
 * A responder that serves `makers` in order, repeating the last one. Each
 * maker builds a fresh Response (a body can be read once).
 */
export function sequence(
  ...makers: ((request: Request) => Response | Promise<Response>)[]
): (request: Request) => Response | Promise<Response> {
  let index = 0;
  return (request) => {
    const maker = makers[Math.min(index, makers.length - 1)];
    index++;
    if (!maker) throw new Error('sequence() needs at least one response.');
    return maker(request);
  };
}

/** A responder that never answers; it rejects with the request's abort reason once aborted. */
export function hangUntilAborted(request: Request): Promise<Response> {
  return new Promise<Response>((_resolve, reject) => {
    const abort = () => reject(request.signal.reason);
    if (request.signal.aborted) abort();
    else request.signal.addEventListener('abort', abort, { once: true });
  });
}

/**
 * Drives a promise to settlement under `vi.useFakeTimers()`, advancing the
 * fake clock in small steps so retry backoffs, attempt timers, and pacer
 * waits fire in order. Stepping (rather than running every timer) keeps a
 * far-future deadline timer from firing while an attempt is still reading.
 */
export async function settleWithFakeTimers<T>(
  promise: Promise<T>,
  { maxMs = 180_000, stepMs = 250 }: { maxMs?: number; stepMs?: number } = {},
): Promise<PromiseSettledResult<T>> {
  let settled: PromiseSettledResult<T> | undefined;
  promise.then(
    (value) => {
      settled = { status: 'fulfilled', value };
    },
    (reason: unknown) => {
      settled = { status: 'rejected', reason };
    },
  );
  for (let elapsed = 0; settled === undefined && elapsed <= maxMs; elapsed += stepMs) {
    await vi.advanceTimersByTimeAsync(stepMs);
  }
  if (settled === undefined) throw new Error(`Promise did not settle within ${maxMs} fake ms.`);
  return settled;
}

/** Settles with fake timers and returns the rejection; fails the test if the promise resolved. */
export async function rejectionWithFakeTimers(
  promise: Promise<unknown>,
  options?: { maxMs?: number; stepMs?: number },
): Promise<unknown> {
  const result = await settleWithFakeTimers(promise, options);
  if (result.status === 'fulfilled') throw new Error('Expected the promise to reject.');
  return result.reason;
}

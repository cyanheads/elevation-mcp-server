/**
 * @fileoverview Plain-fetch helpers shared by the provider clients: one upstream
 * attempt under a per-attempt timer, and a body read under a byte ceiling.
 * @module services/shared/http-attempt
 */

import { McpError, serviceUnavailable, timeout } from '@cyanheads/mcp-ts-core/errors';

/** `User-Agent` sent on every upstream request. */
export const USER_AGENT = 'elevation-mcp-server';

/** Options for {@link runTimedAttempt}. */
export interface TimedAttemptOptions {
  /** Provider name for error messages. */
  service: string;
  /** The retry attempt's signal: caller cancellation plus the retry deadline. */
  signal: AbortSignal;
  /** Per-attempt ceiling covering the fetch and the body read. */
  timeoutMs: number;
}

/**
 * Runs one upstream attempt (fetch, body read, classification) under a
 * per-attempt timer combined with the retry attempt's signal.
 *
 * - An abort of `signal` (caller cancellation or the retry deadline) rethrows
 *   unchanged, so `withRetry` classifies it.
 * - The per-attempt timer firing becomes a transient `Timeout`.
 * - An `McpError` thrown by `attempt` passes through.
 * - Anything else (a network failure) becomes a transient `ServiceUnavailable`.
 */
export async function runTimedAttempt<T>(
  attempt: (signal: AbortSignal) => Promise<T>,
  { service, signal, timeoutMs }: TimedAttemptOptions,
): Promise<T> {
  const timer = new AbortController();
  const handle = setTimeout(
    () => timer.abort(new DOMException(`${service} attempt timed out.`, 'TimeoutError')),
    timeoutMs,
  );
  try {
    return await attempt(AbortSignal.any([signal, timer.signal]));
  } catch (error) {
    if (signal.aborted) throw error;
    if (timer.signal.aborted) {
      throw timeout(
        `${service} did not answer within ${timeoutMs} ms.`,
        { timeoutMs },
        { cause: error },
      );
    }
    if (error instanceof McpError) throw error;
    throw serviceUnavailable(`${service} request failed before a response arrived.`, undefined, {
      cause: error,
    });
  } finally {
    clearTimeout(handle);
  }
}

/**
 * Reads a response body as UTF-8 text, stopping at `maxBytes`. Returns
 * `undefined` when the body exceeds the ceiling; the stream is cancelled then.
 */
export async function readBoundedText(
  response: Response,
  maxBytes: number,
): Promise<string | undefined> {
  if (!response.body) return '';
  const reader = response.body.getReader();
  const decoder = new TextDecoder();
  let received = 0;
  let text = '';
  for (;;) {
    const { done, value } = await reader.read();
    if (done) return text + decoder.decode();
    received += value.byteLength;
    if (received > maxBytes) {
      await reader.cancel();
      return;
    }
    text += decoder.decode(value, { stream: true });
  }
}

/** Releases an unread response body so the connection can be reused. */
export async function discardBody(response: Response): Promise<void> {
  await response.body?.cancel();
}

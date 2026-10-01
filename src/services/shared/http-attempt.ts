/**
 * @fileoverview Plain-fetch helpers shared by the provider clients: one upstream
 * attempt under a per-attempt timer, a body read under a byte ceiling, and the
 * debug log of upstream-authored text, kept out of the client's log stream.
 * @module services/shared/http-attempt
 */

import type { Context } from '@cyanheads/mcp-ts-core';
import { McpError, serviceUnavailable, timeout } from '@cyanheads/mcp-ts-core/errors';
import { logger, withExtra } from '@cyanheads/mcp-ts-core/utils';

/** `User-Agent` sent on every upstream request. */
export const USER_AGENT = 'elevation-mcp-server';

/** Characters of upstream text the process log keeps. */
const LOG_EXCERPT_CHARS = 200;

/** What {@link logUpstreamText} records: a label for the text, the text, and any other fields. */
export interface UpstreamTextRecord {
  /** Label for what the text was (for example `not_json`); logged on both sinks. */
  kind: string;
  /** The upstream-authored text: a miss body, an error body, or a dataset name. */
  text: string;
  [field: string]: unknown;
}

/**
 * Logs upstream-authored text at debug without sending it to the client.
 * `ctx.log` also reaches the client as `notifications/message`, so it gets only
 * the fields, `kind`, and the text's length in UTF-8 bytes. The first 200
 * characters go to the process-only `logger`, correlated to the request
 * through `ctx`.
 */
export function logUpstreamText(
  ctx: Context,
  message: string,
  { text, ...fields }: UpstreamTextRecord,
): void {
  const summary = { ...fields, bytes: new TextEncoder().encode(text).byteLength };
  ctx.log.debug(message, summary);
  logger.debug(message, withExtra(ctx, { ...summary, excerpt: text.slice(0, LOG_EXCERPT_CHARS) }));
}

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

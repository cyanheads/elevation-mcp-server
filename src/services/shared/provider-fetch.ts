/**
 * @fileoverview Provider-owned HTTP transport: exclude Node HTTP/2 without changing the process dispatcher.
 * @module services/shared/provider-fetch
 */

/** One setup-owned transport, shared by both elevation providers. */
export interface ProviderTransport {
  close(): Promise<void>;
  fetch: typeof globalThis.fetch;
}

/** Bun keeps native fetch; Node owns an HTTP/1.1-only dispatcher until teardown. */
export async function createProviderTransport(): Promise<ProviderTransport> {
  if (process.versions.bun) return { fetch: globalThis.fetch, close: async () => {} };
  const { Agent } = await import('undici');
  const dispatcher = new Agent({ allowH2: false });
  return {
    fetch: (input, init) => {
      /** Node's fetch types bundle a different Undici version; dispatch() is the shared runtime boundary. */
      const options: RequestInit = {
        ...init,
        dispatcher: dispatcher as unknown as NonNullable<RequestInit['dispatcher']>,
      };
      return globalThis.fetch(input, options);
    },
    close: () => dispatcher.close(),
  };
}

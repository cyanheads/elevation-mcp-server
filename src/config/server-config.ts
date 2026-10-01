/**
 * @fileoverview Server-specific configuration: the Open Topo Data base URL.
 * @module config/server-config
 */

import { z } from '@cyanheads/mcp-ts-core';
import { parseEnvConfig } from '@cyanheads/mcp-ts-core/config';

/** The public Open Topo Data instance, used when `OPENTOPODATA_BASE_URL` is unset. */
export const PUBLIC_OPENTOPODATA_BASE_URL = 'https://api.opentopodata.org';

const ServerConfigSchema = z.object({
  openTopoDataBaseUrl: z
    .preprocess(
      (value) => (typeof value === 'string' && value.trim() === '' ? undefined : value),
      z.url({ protocol: /^https?$/ }).default(PUBLIC_OPENTOPODATA_BASE_URL),
    )
    .describe(
      'Base URL of the Open Topo Data instance. Any URL other than the public instance is treated as a self-hosted instance.',
    ),
});

export type ServerConfig = z.infer<typeof ServerConfigSchema>;

let _config: ServerConfig | undefined;

/** Parses the server's env vars once, on first use. */
export function getServerConfig(): ServerConfig {
  _config ??= parseEnvConfig(ServerConfigSchema, {
    openTopoDataBaseUrl: 'OPENTOPODATA_BASE_URL',
  });
  return _config;
}

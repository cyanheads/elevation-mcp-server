/**
 * @fileoverview Tests for the server config: OPENTOPODATA_BASE_URL defaults,
 * blank handling, validation, and one-time parsing.
 * @module tests/config/server-config.test
 */

import { JsonRpcErrorCode, McpError } from '@cyanheads/mcp-ts-core/errors';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

const VAR = 'OPENTOPODATA_BASE_URL';
const PUBLIC = 'https://api.opentopodata.org';

/** A fresh module copy, so the config cache starts empty. */
async function freshConfigModule() {
  vi.resetModules();
  return import('@/config/server-config.js');
}

describe('getServerConfig', () => {
  beforeEach(() => {
    vi.unstubAllEnvs();
  });
  afterEach(() => {
    vi.unstubAllEnvs();
    vi.resetModules();
  });

  it('exports the public instance URL', async () => {
    const { PUBLIC_OPENTOPODATA_BASE_URL } = await freshConfigModule();
    expect(PUBLIC_OPENTOPODATA_BASE_URL).toBe(PUBLIC);
  });

  it('defaults to the public instance when the variable is unset', async () => {
    vi.stubEnv(VAR, undefined);
    const { getServerConfig } = await freshConfigModule();
    expect(getServerConfig()).toEqual({ openTopoDataBaseUrl: PUBLIC });
  });

  it.each([
    ['an empty string', ''],
    ['whitespace only', '   '],
    ['a tab and newline', '\t\n'],
    ['an unsubstituted host placeholder', `$${'{user_config.OPENTOPODATA_BASE_URL}'}`],
  ])('reads %s as unset', async (_name, value) => {
    vi.stubEnv(VAR, value);
    const { getServerConfig } = await freshConfigModule();
    expect(getServerConfig().openTopoDataBaseUrl).toBe(PUBLIC);
  });

  it.each([
    'https://topo.example.test',
    'http://localhost:5000',
    'https://gateway.example.test/topo/',
    'http://192.168.1.20:5000',
  ])('accepts the operator URL %s as given', async (url) => {
    vi.stubEnv(VAR, url);
    const { getServerConfig } = await freshConfigModule();
    expect(getServerConfig().openTopoDataBaseUrl).toBe(url);
  });

  it.each([
    ['a scheme that is not http(s)', 'ftp://topo.example.test'],
    ['a bare host', 'topo.example.test'],
    ['text that is not a URL', 'not a url'],
    ['a file URL', 'file:///etc/hosts'],
  ])('rejects %s with a ConfigurationError naming the variable', async (_name, value) => {
    vi.stubEnv(VAR, value);
    const { getServerConfig } = await freshConfigModule();
    let thrown: unknown;
    try {
      getServerConfig();
    } catch (error) {
      thrown = error;
    }
    expect(thrown).toBeInstanceOf(McpError);
    expect((thrown as McpError).code).toBe(JsonRpcErrorCode.ConfigurationError);
    expect((thrown as McpError).message).toContain(VAR);
  });

  it('parses once and keeps the first result', async () => {
    vi.stubEnv(VAR, 'https://first.example.test');
    const { getServerConfig } = await freshConfigModule();
    const first = getServerConfig();
    vi.stubEnv(VAR, 'https://second.example.test');
    expect(getServerConfig()).toBe(first);
    expect(getServerConfig().openTopoDataBaseUrl).toBe('https://first.example.test');
  });
});

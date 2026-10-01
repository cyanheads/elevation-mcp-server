#!/usr/bin/env node
/**
 * @fileoverview elevation-mcp-server MCP server entry point.
 * @module index
 */

import { createApp } from '@cyanheads/mcp-ts-core';
import { getServerConfig } from './config/server-config.js';
import { buildServerInstructions } from './mcp-server/server-instructions.js';
import { allToolDefinitions } from './mcp-server/tools/definitions/index.js';
import {
  disposeElevationServices,
  initElevationServices,
} from './services/elevation/elevation-sampler.js';

/**
 * The instructions are built from config before `createApp()` loads `.env`,
 * so load it here first. Variables already set are never overridden; a
 * missing file is the normal case.
 */
try {
  process.loadEnvFile();
} catch (error) {
  if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error;
}

const config = getServerConfig();

await createApp({
  name: 'elevation-mcp-server',
  title: 'elevation-mcp-server',
  tools: allToolDefinitions,
  instructions: buildServerInstructions(config),
  setup() {
    initElevationServices(config);
  },
  teardown() {
    disposeElevationServices();
  },
});

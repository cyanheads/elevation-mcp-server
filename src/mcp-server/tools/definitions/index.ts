/**
 * @fileoverview Every tool definition this server registers.
 * @module mcp-server/tools/definitions
 */

import { checkLineOfSightTool } from './check-line-of-sight.tool.js';
import { getGridTool } from './get-grid.tool.js';
import { getPointsTool } from './get-points.tool.js';
import { getProfileTool } from './get-profile.tool.js';

export const allToolDefinitions = [
  getPointsTool,
  getProfileTool,
  getGridTool,
  checkLineOfSightTool,
];

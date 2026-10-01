/**
 * @fileoverview Contract text shared by all four tools that must hold on every
 * deployment: `tools/list` advertises each `when`, so the Open Topo Data limit
 * texts must be true on a public and a self-hosted instance alike, the
 * config-rejection text must cover every answer that maps to it, and the
 * deadline recovery must cover a budget spent waiting on either provider.
 * @module tests/tools/error-contracts.test
 */

import { describe, expect, it } from 'vitest';
import { checkLineOfSightTool } from '@/mcp-server/tools/definitions/check-line-of-sight.tool.js';
import { getGridTool } from '@/mcp-server/tools/definitions/get-grid.tool.js';
import { getPointsTool } from '@/mcp-server/tools/definitions/get-points.tool.js';
import { getProfileTool } from '@/mcp-server/tools/definitions/get-profile.tool.js';
import type { ToolDefinition } from '../fixtures/tool-harness.js';

const TOOLS: ToolDefinition[] = [getPointsTool, getProfileTool, getGridTool, checkLineOfSightTool];

const entry = (tool: ToolDefinition, reason: string) => {
  const found = tool.errors?.find((error) => error.reason === reason);
  expect(found, `${tool.name} declares ${reason}`).toBeDefined();
  return found as NonNullable<typeof found>;
};

describe.each(TOOLS.map((tool) => ({ name: tool.name, tool })))(
  '$name error contract',
  ({ name, tool }) => {
    it('opentopodata_rate_limited recovery holds for a public and a self-hosted instance', () => {
      const { recovery } = entry(tool, 'opentopodata_rate_limited');
      expect(recovery).toContain(
        "Open Topo Data is refusing this server's requests as rate limited.",
      );
      expect(recovery, 'a single 429 asking for a long wait fails fast').not.toContain('kept');
      expect(recovery).toContain(
        'The public instance allows 1 request per second and 1,000 per day',
      );
      expect(recovery).toContain('a self-hosted instance sets its own limits');
      expect(recovery).not.toContain("refusing requests from this server's network address");
      expect(recovery).toContain(`Retry ${name} in a few minutes`);
    });

    it('opentopodata_daily_limit is scoped to the public instance in its advertised when', () => {
      expect(entry(tool, 'opentopodata_daily_limit').when).toMatch(
        /^Only on the public Open Topo Data instance: /,
      );
    });

    it('opentopodata_config_rejected covers a 200 naming a dataset this server did not request', () => {
      const { when, recovery } = entry(tool, 'opentopodata_config_rejected');
      expect(when).toContain('or a 200 naming a dataset this server did not request');
      expect(recovery).toContain('cannot serve this server');
      expect(recovery).toContain('a missing or misconfigured srtm30m or mapzen dataset');
    });

    it('sampling_deadline_exceeded recovery covers a budget spent waiting on either provider', () => {
      const { recovery } = entry(tool, 'sampling_deadline_exceeded');
      expect(recovery).toContain('waiting on USGS 3DEP');
      expect(recovery).toContain('waiting on Open Topo Data, retry in a minute');
      expect(recovery).toContain(`re-call ${name} with fewer`);
      expect(recovery).toContain('source usgs_3dep');
    });
  },
);

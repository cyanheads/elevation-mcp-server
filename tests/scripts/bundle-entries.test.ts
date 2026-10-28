/**
 * @fileoverview Bundle pruning preserves runtime modules named skills while removing package-root agent docs.
 * @module tests/scripts/bundle-entries
 */
import { describe, expect, it } from 'vitest';
import { filterAgentDocEntries } from '../../scripts/clean-mcpb.js';
import { checkBundleEntries } from '../../scripts/lint-packaging.js';

describe('bundle agent-document selection', () => {
  it('preserves SDK skill runtime files and the published server skill tree', () => {
    const entries = [
      'node_modules/@modelcontextprotocol/server/dist/ext/skills/index.js',
      'node_modules/@modelcontextprotocol/server/dist/ext/skills/index.d.ts',
      'node_modules/parent/node_modules/@modelcontextprotocol/server/dist/ext/skills/index.js',
      'node_modules/runtime/dist/skills/loader.js',
      'skills/terrain-analysis/SKILL.md',
    ];
    expect(filterAgentDocEntries(entries)).toEqual([]);
    expect(checkBundleEntries(entries, 'fixture.mcpb')).toEqual([]);
  });

  it('strips package-root docs in scoped, unscoped, and nested dependencies', () => {
    const entries = [
      'node_modules/@cyanheads/mcp-ts-core/framework-skills/add-tool/SKILL.md',
      'node_modules/package/skills/usage/SKILL.md',
      'node_modules/package/.claude/skills/usage/SKILL.md',
      'node_modules/package/.agents/skills/usage/SKILL.md',
      'node_modules/package/SKILL.md',
      'node_modules/parent/node_modules/@scope/package/skills/usage/SKILL.md',
      'node_modules/@scope/parent/node_modules/package/framework-skills/usage/SKILL.md',
    ];
    expect(filterAgentDocEntries(entries)).toEqual(entries);
    const problems = checkBundleEntries(entries, 'fixture.mcpb');
    expect(problems).toHaveLength(1);
    expect(problems[0]).toContain('7 node_modules agent-doc entries');
  });
});

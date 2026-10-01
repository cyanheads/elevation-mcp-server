# elevation-mcp-server - Directory Structure

Generated on: 2026-10-01 13:28:31

```text
elevation-mcp-server/
├── .claude-plugin/
│   └── plugin.json
├── .codex-plugin/
│   ├── mcp.json
│   └── plugin.json
├── .github/
│   ├── ISSUE_TEMPLATE/
│   │   ├── bug_report.yml
│   │   ├── config.yml
│   │   └── feature_request.yml
│   ├── workflows/
│   │   └── codeql.yml
│   ├── CODE_OF_CONDUCT.md
│   ├── CONTRIBUTING.md
│   ├── FUNDING.yml
│   └── SECURITY.md
├── .vscode/
│   ├── extensions.json
│   └── settings.json
├── changelog/
│   ├── 0.1.x/
│   └── template.md
├── docs/
│   └── design.md
├── framework-skills/
│   ├── add-app-tool/
│   │   └── SKILL.md
│   ├── add-prompt/
│   │   └── SKILL.md
│   ├── add-resource/
│   │   └── SKILL.md
│   ├── add-service/
│   │   └── SKILL.md
│   ├── add-test/
│   │   └── SKILL.md
│   ├── add-tool/
│   │   └── SKILL.md
│   ├── api-auth/
│   │   └── SKILL.md
│   ├── api-canvas/
│   │   └── SKILL.md
│   ├── api-config/
│   │   └── SKILL.md
│   ├── api-context/
│   │   └── SKILL.md
│   ├── api-errors/
│   │   └── SKILL.md
│   ├── api-linter/
│   │   └── SKILL.md
│   ├── api-mirror/
│   │   └── SKILL.md
│   ├── api-services/
│   │   ├── references/
│   │   │   ├── graph.md
│   │   │   ├── llm.md
│   │   │   └── speech.md
│   │   └── SKILL.md
│   ├── api-telemetry/
│   │   └── SKILL.md
│   ├── api-testing/
│   │   └── SKILL.md
│   ├── api-utils/
│   │   ├── references/
│   │   │   ├── formatting.md
│   │   │   ├── parsing.md
│   │   │   └── security.md
│   │   └── SKILL.md
│   ├── api-workers/
│   │   └── SKILL.md
│   ├── code-simplifier/
│   │   └── SKILL.md
│   ├── design-mcp-server/
│   │   └── SKILL.md
│   ├── field-test/
│   │   └── SKILL.md
│   ├── git-wrapup/
│   │   └── SKILL.md
│   ├── maintenance/
│   │   └── SKILL.md
│   ├── orchestrations/
│   │   ├── workflows/
│   │   │   ├── field-test-fix.md
│   │   │   ├── fix-wrapup-release.md
│   │   │   ├── greenfield-build.md
│   │   │   └── maintenance-release.md
│   │   └── SKILL.md
│   ├── polish-docs-meta/
│   │   ├── references/
│   │   │   ├── agent-protocol.md
│   │   │   ├── package-meta.md
│   │   │   ├── readme.md
│   │   │   └── server-json.md
│   │   └── SKILL.md
│   ├── release-and-publish/
│   │   └── SKILL.md
│   ├── release-pr-review/
│   │   └── SKILL.md
│   ├── report-issue-framework/
│   │   └── SKILL.md
│   ├── report-issue-local/
│   │   └── SKILL.md
│   ├── security-pass/
│   │   └── SKILL.md
│   ├── setup/
│   │   └── SKILL.md
│   ├── techniques/
│   │   ├── references/
│   │   │   └── outline-on-overflow.md
│   │   └── SKILL.md
│   └── tool-defs-analysis/
│       └── SKILL.md
├── scripts/
│   ├── build-changelog.ts
│   ├── build.ts
│   ├── check-dependency-specifiers.ts
│   ├── check-docs-sync.ts
│   ├── check-framework-antipatterns.ts
│   ├── check-skill-versions.ts
│   ├── check-skills-sync.ts
│   ├── clean-mcpb.ts
│   ├── clean.ts
│   ├── devcheck.ts
│   ├── install-otel.ts
│   ├── lint-mcp.ts
│   ├── lint-packaging.ts
│   ├── list-skills.ts
│   ├── release-github.ts
│   └── tree.ts
├── src/
│   ├── config/
│   │   └── server-config.ts
│   ├── mcp-server/
│   │   ├── tools/
│   │   │   ├── definitions/
│   │   │   │   ├── check-line-of-sight.tool.ts
│   │   │   │   ├── get-grid.tool.ts
│   │   │   │   ├── get-points.tool.ts
│   │   │   │   ├── get-profile.tool.ts
│   │   │   │   └── index.ts
│   │   │   └── shared/
│   │   │       ├── format.ts
│   │   │       ├── inputs.ts
│   │   │       └── outputs.ts
│   │   └── server-instructions.ts
│   ├── services/
│   │   ├── elevation/
│   │   │   ├── attribution.ts
│   │   │   ├── elevation-sampler.ts
│   │   │   ├── geometry.ts
│   │   │   ├── types.ts
│   │   │   └── units.ts
│   │   ├── opentopodata/
│   │   │   └── opentopodata-client.ts
│   │   ├── shared/
│   │   │   └── http-attempt.ts
│   │   └── usgs-epqs/
│   │       └── usgs-epqs-client.ts
│   └── index.ts
├── tests/
│   ├── config/
│   │   ├── server-config.test.ts
│   │   └── server-instructions.test.ts
│   ├── fixtures/
│   │   ├── epqs.ts
│   │   ├── harness.ts
│   │   ├── opentopodata.ts
│   │   └── tool-harness.ts
│   ├── services/
│   │   ├── attribution.test.ts
│   │   ├── elevation-sampler.test.ts
│   │   ├── geometry.test.ts
│   │   ├── opentopodata-client.test.ts
│   │   ├── units.test.ts
│   │   └── usgs-epqs-client.test.ts
│   ├── shared/
│   │   ├── format.test.ts
│   │   └── inputs.test.ts
│   └── tools/
│       ├── check-line-of-sight.tool.test.ts
│       ├── computed-tools.errors.test.ts
│       ├── error-contracts.test.ts
│       ├── get-grid.tool.test.ts
│       ├── get-points.tool.test.ts
│       └── get-profile.tool.test.ts
├── .dockerignore
├── .env.example
├── .gitattributes
├── .gitignore
├── .mcpbignore
├── AGENTS.md
├── biome.json
├── bun.lock
├── bunfig.toml
├── CHANGELOG.md
├── CLAUDE.md
├── devcheck.config.json
├── Dockerfile
├── LICENSE
├── manifest.json
├── package.json
├── README.md
├── server.json
├── tsconfig.build.json
├── tsconfig.json
└── vitest.config.ts
```

_Note: This tree excludes files and directories matched by .gitignore and default patterns._

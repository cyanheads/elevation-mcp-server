<div align="center">
  <h1>@cyanheads/elevation-mcp-server</h1>
  <p><b>Look up elevation worldwide, profile route ascent/descent, grid areas, check terrain line of sight via MCP. STDIO or Streamable HTTP.</b>
  <div>4 Tools</div>
  </p>
</div>

<div align="center">

[![Version](https://img.shields.io/badge/Version-0.1.1-blue.svg?style=flat-square)](./CHANGELOG.md) [![License](https://img.shields.io/badge/License-Apache%202.0-orange.svg?style=flat-square)](./LICENSE) [![Docker](https://img.shields.io/badge/Docker-ghcr.io-2496ED?style=flat-square&logo=docker&logoColor=white)](https://github.com/users/cyanheads/packages/container/package/elevation-mcp-server) [![MCP SDK](https://img.shields.io/badge/MCP%20SDK-^2.1.0-green.svg?style=flat-square)](https://modelcontextprotocol.io/) [![npm](https://img.shields.io/npm/v/@cyanheads/elevation-mcp-server?style=flat-square&logo=npm&logoColor=white)](https://www.npmjs.com/package/@cyanheads/elevation-mcp-server) [![TypeScript](https://img.shields.io/badge/TypeScript-^7.0.2-3178C6.svg?style=flat-square)](https://www.typescriptlang.org/) [![Bun](https://img.shields.io/badge/Bun-v1.4.2-blueviolet.svg?style=flat-square)](https://bun.sh/)

</div>

<div align="center">

[![Install in Claude Desktop](https://img.shields.io/badge/Install_in-Claude_Desktop-D97757?style=for-the-badge&logo=anthropic&logoColor=white)](https://github.com/cyanheads/elevation-mcp-server/releases/latest/download/elevation-mcp-server.mcpb) [![Install in Cursor](https://cursor.com/deeplink/mcp-install-dark.svg)](https://cursor.com/en/install-mcp?name=elevation-mcp-server&config=eyJjb21tYW5kIjoibnB4IiwiYXJncyI6WyIteSIsIkBjeWFuaGVhZHMvZWxldmF0aW9uLW1jcC1zZXJ2ZXIiXX0=) [![Install in VS Code](https://img.shields.io/badge/VS_Code-Install_Server-0098FF?style=for-the-badge&logo=visualstudiocode&logoColor=white)](https://vscode.dev/redirect?url=vscode:mcp/install?%7B%22name%22%3A%22elevation-mcp-server%22%2C%22command%22%3A%22npx%22%2C%22args%22%3A%5B%22-y%22%2C%22%40cyanheads%2Felevation-mcp-server%22%5D%7D)

[![Framework](https://img.shields.io/badge/Built%20on-@cyanheads/mcp--ts--core-67E8F9?style=flat-square)](https://www.npmjs.com/package/@cyanheads/mcp-ts-core)

</div>

<div align="center">

**Public Hosted Server:** [https://elevation.caseyjhand.com/mcp](https://elevation.caseyjhand.com/mcp)

</div>

---

## Overview

Ground elevation and terrain analysis from two keyless sources: USGS 3DEP across the US and its territories (plus much of Canada and Mexico), and Open Topo Data everywhere else, which answers from SRTM GL1 v3 and, where SRTM has no tile, Mapzen terrain tiles. Look up spot heights, measure a route's ascent, descent, and grades, find an area's high and low points, and check whether terrain blocks a sightline. Runs as a stdio process, a local Streamable HTTP server, or the public hosted endpoint above.

### Tools

| Tool | Description |
|:---|:---|
| `elevation_get_points` | Ground elevation at 1–100 coordinates, in meters and feet, with the dataset and resolution behind each value |
| `elevation_get_profile` | Sample a route at evenly spaced points and summarize distance, ascent, descent, elevation range, and steepest grades |
| `elevation_get_grid` | Sample a node grid over a bounding box and report its highest and lowest points, mean elevation, and relief |
| `elevation_check_line_of_sight` | Decide whether terrain blocks the sightline between two points, with earth curvature and refraction, and check first Fresnel zone clearance for radio links |

## Capability reference

### `elevation_get_points` <sub>tool</sub>

- `points`: 1–100 `{lat, lon}` objects in decimal degrees (WGS84)
- Each point comes back `ok` or `no_data` (a miss never fails the call), with `elevation_m` / `elevation_ft`, `dataset`, and `resolution_m` (omitted for `mapzen`); 3DEP answers add `raster_id` and `acquisition_date`. `points_with_data` counts the hits

---

### `elevation_get_profile` <sub>tool</sub>

- `path`: 2–1,000 vertices in travel order (consecutive duplicates dropped); `samples`: 2–250 evenly spaced points along it, endpoints included (default 100)
- `summary` carries `total_distance_m`, `ascent_m` / `descent_m` (and feet), start, end, min, and max elevation, `highest_point` / `lowest_point`, and `max_grade_pct` / `min_grade_pct` with where each occurs; ascent depends on the reported `sample_interval_m`. Fails as `degenerate_path` (under 1 m of route) or `no_coverage` (no sample has data)
- `include_samples` (default `true`) returns `samples[]` (distance, position, elevation, grade, dataset, and resolution per sample); `false` omits it and the sample table, and the rest of the result is unchanged

---

### `elevation_get_grid` <sub>tool</sub>

- `south`, `west`, `north`, `east` edges in decimal degrees (a box can't cross longitude 180); `rows` and `cols` 2–25 each (default 10), with `rows × cols` at most 250
- `elevations_m` and `cell_datasets` matrices indexed `[row][col]` (row 0 north, column 0 west, `null` without data), plus `summary.highest`, `summary.lowest`, `mean_elevation_m`, and `relief_m`. Fails as `invalid_bbox`, `too_many_cells`, or `no_coverage`
- Nodes are point samples with the edges included, not cell averages

---

### `elevation_check_line_of_sight` <sub>tool</sub>

- `observer` and `target` points, at most 1,000 km apart; `observer_height_m` (default 1.7) and `target_height_m` (default 0), each 0–10,000 m above ground; `earth_model` `flat`, `geometric`, `optical` (default, κ 0.13), or `radio` (κ 0.25); `samples` 3–250 (default 100); optional `water_surface_m` (-500 to 9,000) and `frequency_mhz` (30–300,000)
- `verdict` is `clear`, `blocked`, or `indeterminate` (samples without data leave the line unconfirmed), with `min_clearance_m` / `min_clearance_ft`, the `limiting_point`, and the `first_obstruction` when blocked. Fails as `same_endpoints` (under 1 m apart), `sightline_too_long` (over 1,000 km apart), or `endpoint_no_data`
- `frequency_mhz` adds `fresnel`: a `sufficient`, `insufficient`, or `indeterminate` verdict against the 60% free-space bar of the first Fresnel zone, `min_clearance_ratio` (clearance over zone radius), and the sample that limits it, which is often not `limiting_point`
- Terrain only: buildings and vegetation count only as far as the elevation source captures them. Where Mapzen reports sea-floor depth, clearance is measured to the sea surface; USGS 3DEP values below 0 m (bay floor in some bays, or dry land) count as received unless `water_surface_m` sets a water level, which then applies to every sample

---

### Failures shared by every tool

| Reason | Code | When |
|:---|:---|:---|
| `usgs_unavailable` | `ServiceUnavailable` | USGS 3DEP did not answer or rejected the request; `data.retryable` says whether retrying can help |
| `opentopodata_unavailable` | `ServiceUnavailable` | Open Topo Data did not answer, rejected the request, or sent an unusable response; `data.retryable` as above |
| `opentopodata_rate_limited` | `RateLimited` | Open Topo Data kept answering HTTP 429, or asked for a wait over 8 s; `data.retryAfter` in seconds when it sent one of at most a day |
| `opentopodata_daily_limit` | `RateLimited` | Public instance only: this server already sent 1,000 requests in the trailing 24 hours, so none was sent; `data.retryAfter` is the seconds until a slot frees |
| `opentopodata_config_rejected` | `ConfigurationError` | The instance at `OPENTOPODATA_BASE_URL` answered 401, 403, or 404, redirected (self-hosted only; never followed), lacks `srtm30m` or `mapzen`, caps locations below 100, or answered from a dataset this server didn't request; the operator must fix it |
| `sampling_deadline_exceeded` | `Timeout` | The 45 s sampling budget ran out (`data.provider` names the provider it was waiting on), or other calls' queued USGS 3DEP lookups left no time for this call's, so it sent none and `data.retryAfter` is the seconds until they drain |

A coverage miss is never an error: that point has no data. Any provider failure fails the whole call with no partial result.

## Features

Built on [`@cyanheads/mcp-ts-core`](https://github.com/cyanheads/mcp-ts-core): stdio and Streamable HTTP transports, pluggable auth (`none` / `jwt` / `oauth`), swappable storage (`in-memory`, `filesystem`, `Supabase`, `Cloudflare KV/R2/D1`), structured logging with optional OpenTelemetry tracing.

Elevation-specific:

- `source` on every tool: `auto` (default) queries USGS 3DEP inside its coverage and sends 3DEP misses and everything outside it to Open Topo Data; `usgs_3dep` and `opentopodata` pin one provider. Only a coverage miss falls back, never an outage
- Open Topo Data answers from SRTM GL1 v3 (about 30 m, land between 60°N and 56°S), then Mapzen terrain tiles where SRTM has no tile: high latitudes, Antarctica, and ocean bathymetry
- Per-call caps of 100 points or 250 samples or grid cells, inside a 45 s sampling budget; each 3DEP point is its own request (6 concurrent, 10 per second), while Open Topo Data takes 100 points per request
- The public Open Topo Data instance is paced under its published limits: one request at a time, starts at least 1.1 s apart, at most 1,000 in any trailing 24 hours per server process
- Profiles, grids, and sightlines are computed locally from point samples, with great-circle distances and resampling and earth curvature with standard refraction

Agent-friendly output:

- Provenance on every value: each point, profile sample, grid cell, and sightline point names its `dataset` (`usgs_3dep`, `srtm30m`, `mapzen`) and, except for Mapzen, its `resolution_m` (`resolution_m_range` on profiles and grids); computed results add `datasets_used` counts, and a `Sources:` line credits every dataset that answered
- Absent stays absent: a point or sample without data omits its elevation and a grid cell is `null`, never 0; summaries report how many values had data
- Notices flag what changes interpretation: results mixing 3DEP and Open Topo Data, Mapzen values below 0 m (sea-floor depths), 3DEP values below 0 m on a sightline, sample spacing coarser or finer than the source, thin clearance margins, and a clear radio path short of 60% Fresnel clearance

## Getting started

### Public Hosted Instance

A public instance is available at `https://elevation.caseyjhand.com/mcp` — no installation required. Point any MCP client at it via Streamable HTTP:

```json
{
  "mcpServers": {
    "elevation-mcp-server": {
      "type": "streamable-http",
      "url": "https://elevation.caseyjhand.com/mcp"
    }
  }
}
```

Every caller of the hosted instance shares one Open Topo Data allowance of 1,000 requests a day. Under the default `auto` source it goes to the points USGS 3DEP doesn't answer; 3DEP covers the US and its territories, plus much of Canada and Mexico. For sustained use, run your own instance.

### Self-Hosted / Local

Add the following to your MCP client configuration file.

```json
{
  "mcpServers": {
    "elevation-mcp-server": {
      "type": "stdio",
      "command": "bunx",
      "args": ["@cyanheads/elevation-mcp-server@latest"],
      "env": {
        "MCP_TRANSPORT_TYPE": "stdio",
        "MCP_LOG_LEVEL": "info"
      }
    }
  }
}
```

Or with npx (no Bun required):

```json
{
  "mcpServers": {
    "elevation-mcp-server": {
      "type": "stdio",
      "command": "npx",
      "args": ["-y", "@cyanheads/elevation-mcp-server@latest"],
      "env": {
        "MCP_TRANSPORT_TYPE": "stdio",
        "MCP_LOG_LEVEL": "info"
      }
    }
  }
}
```

Or with Docker:

```json
{
  "mcpServers": {
    "elevation-mcp-server": {
      "type": "stdio",
      "command": "docker",
      "args": ["run", "-i", "--rm", "-e", "MCP_TRANSPORT_TYPE=stdio", "ghcr.io/cyanheads/elevation-mcp-server:latest"]
    }
  }
}
```

For Streamable HTTP, set the transport and start the server:

```sh
MCP_TRANSPORT_TYPE=http MCP_HTTP_PORT=3010 bun run start:http
# Server listens at http://localhost:3010/mcp
```

### Prerequisites

- [Bun v1.4.0](https://bun.sh/) or higher (or Node.js v24+).
- No API key: USGS 3DEP and Open Topo Data are both keyless.
- Optional: a self-hosted [Open Topo Data](https://www.opentopodata.org/) instance with the `srtm30m` and `mapzen` datasets, for heavy or hosted use (see [Configuration](#configuration)).

### Installation

1. **Clone the repository:**

```sh
git clone https://github.com/cyanheads/elevation-mcp-server.git
```

2. **Navigate into the directory:**

```sh
cd elevation-mcp-server
```

3. **Install dependencies:**

```sh
bun install
```

4. **Configure environment:**

```sh
cp .env.example .env
# optionally set OPENTOPODATA_BASE_URL to a self-hosted Open Topo Data instance
```

## Configuration

| Variable | Description | Default |
|:---|:---|:---|
| `OPENTOPODATA_BASE_URL` | Open Topo Data instance used outside USGS 3DEP coverage, as an `http` or `https` URL. Unset or blank means the public instance; any other URL is treated as a self-hosted instance. | `https://api.opentopodata.org` |
| `MCP_TRANSPORT_TYPE` | Transport: `stdio` or `http`. | `stdio` |
| `MCP_HTTP_PORT` | HTTP server port. | `3010` |
| `MCP_SESSION_MODE` | HTTP session mode: `stateless`, `stateful`, or `auto`. `.env.example` and the Docker image set `stateless`. | `auto` |
| `MCP_AUTH_MODE` | Authentication: `none`, `jwt`, or `oauth`. Under `jwt` or `oauth`, each tool requires the scope `tool:<tool_name>:read`. | `none` |
| `MCP_LOG_LEVEL` | Log level (`debug`, `info`, `warning`, `error`, etc.). | `info` |
| `LOGS_DIR` | Directory for log files (Node.js only). | `<app-root>/logs` |
| `OTEL_ENABLED` | Enable [OpenTelemetry](https://github.com/cyanheads/mcp-ts-core/tree/main/docs/telemetry). | `false` |

Any `OPENTOPODATA_BASE_URL` other than the public instance is treated as self-hosted (Open Topo Data is MIT-licensed and runs in Docker): 4 concurrent requests, no rate windows. It must serve datasets named `srtm30m` and `mapzen` and accept at least 100 locations per request, or calls fail with `opentopodata_config_rejected`.

See [`.env.example`](./.env.example) for every server setting and the common framework overrides.

## Known limitations

- **Open Topo Data's public limits.** The public instance allows 100 locations per request, 1 request per second, and 1,000 requests per day per IP address. Each server process paces itself under them, but its count is process-local and resets on restart. Several processes on one machine (a stdio server per client session), or other clients on the same address, also draw on the upstream's count, so the upstream can refuse first (`opentopodata_rate_limited`).
- **Shared deployments.** A deployment serving many users sends all their requests from one address, so on the public instance they share one 1,000-a-day allowance: about 1,000 point lookups, or 333 full 250-sample calls, and as few as 111 when retries spend requests too. Once it is spent, every call that needs Open Topo Data fails with `opentopodata_daily_limit` for up to 24 hours, including an `auto` call with a single 3DEP miss, so global answers on such a deployment are best-effort; pointing `OPENTOPODATA_BASE_URL` at its own instance (loaded with `srtm30m` and `mapzen`) removes the cap. The server has no caller identity to ration by, so one caller's heavy calls slow USGS 3DEP and can spend the public day for everyone.
- **Global resolution.** SRTM is a 30 m radar surface model. Mapzen's 1 arc-second grid is interpolated in places from coarser sources (GMTED2010 at 7.5 arc-seconds over parts of the high latitudes, ETOPO1 at about 1.8 km over the open ocean). Outside 3DEP coverage, profile ascent is underestimated and line of sight misses terrain narrower than the source's true resolution.
- **Whole-meter values.** Open Topo Data's datasets are integer rasters, and the upstream rounds the interpolated result to the nearest meter, so ascent and descent over gentle terrain include 1 m quantization steps.
- **Water.** SRTM reports water inside a land tile as 0 m. Beyond SRTM's tiles, Mapzen reports sea-floor depth, and points, profiles, and grids include it. 3DEP values over water depend on the raster: a hydro-flattened surface, sea level, or bathymetry. Line of sight measures clearance to 0 m over Mapzen values below 0, but uses 3DEP values below 0 m as received, since nothing in a USGS answer tells bay floor from dry land below sea level; its notice flags them, and `water_surface_m` measures a line over water to the water instead.
- **Mixed models.** 3DEP is a bare-earth DEM referenced to NAVD 88 in the conterminous US (local datums in some territories). SRTM is a radar surface model that partly includes canopy and buildings, referenced to EGM96. Mapzen blends both by region. Differences of a meter or more between datasets at the same point are expected; per-value provenance shows which applies.
- **Sampling.** Features narrower than the sample spacing are missed: a ridge between line-of-sight samples, a summit between grid nodes (re-grid a smaller box around `summary.highest` to refine it), short climbs between profile samples. Spacing is always reported.
- **USGS 3DEP throughput.** The point query service has no published limit and no batch endpoint: about 10 points per second at this server's pacing, hence the 250-sample cap and 45 s budget. A call whose lookups would push the queue past a running call's budget is refused at once with `sampling_deadline_exceeded` and `data.retryAfter`, so two 250-sample calls at once run in turn: the second can be retried after about 25 s.
- **Acquisition dates** from USGS are passed through raw in M/D/YYYY form, which sometimes carries a zero month or day; any other form is omitted.
- **Antimeridian.** A grid box cannot cross longitude 180, so split it into two calls. Paths and sightlines crossing it work.
- **Line of sight** is limited to 1,000 km, where the parabolic curvature approximation overstates the midpoint rise by up to about 10 m. Its Fresnel check covers the first zone against the 60% bar at the chosen earth model, at the sample positions only, with no diffraction loss or worst-case k factor.

## Running the server

### Local development

- **Build and run the production version**:

  ```sh
  # One-time build
  bun run rebuild

  # Run the built server
  bun run start:http
  # or
  bun run start:stdio
  ```

- **Run checks and tests**:
  ```sh
  bun run devcheck  # Lints, formats, type-checks, and more
  bun run test      # Runs the test suite
  ```

## Project structure

| Directory | Purpose |
|:---|:---|
| `src/index.ts` | `createApp()` entry point: registers the four tools, builds the server instructions from config, and starts and disposes the elevation services. |
| `src/config` | `OPENTOPODATA_BASE_URL` parsing and validation with Zod. |
| `src/mcp-server/tools/definitions` | Tool definitions (`*.tool.ts`). |
| `src/mcp-server/tools/shared` | Input schemas, output schemas, and `format()` helpers shared by the four tools. |
| `src/services/elevation` | `ElevationSampler` (routing, 3DEP coverage envelope, per-call budget), geometry, attribution, and unit helpers. |
| `src/services/usgs-epqs` | USGS Elevation Point Query Service client. |
| `src/services/opentopodata` | Open Topo Data client and its request pacers. |
| `src/services/shared` | Timed fetch attempts and bounded body reads shared by both clients. |
| `docs/design.md` | Design: tool contracts, computation, services, decisions, and limitations. |
| `tests/` | Unit and tool tests against a mocked upstream. |

## Development guide

See [`CLAUDE.md`](./CLAUDE.md) for development guidelines and architectural rules. The short version:

- Handlers throw, framework catches — no `try/catch` in tool logic
- Use `ctx.log` for logging, `ctx.state` for storage
- Register new tools in `allToolDefinitions` in `src/mcp-server/tools/definitions/index.ts`
- Wrap external API calls: validate raw → normalize to domain type → return output schema; never fabricate missing fields

## Data sources and attribution

| Dataset | `dataset` id | Served by | Terms |
|:---|:---|:---|:---|
| USGS 3D Elevation Program (3DEP) | `usgs_3dep` | USGS Elevation Point Query Service | Public domain (U.S. federal government work). Credit the U.S. Geological Survey, 3D Elevation Program. |
| SRTM GL1 v3 | `srtm30m` | Open Topo Data | Public domain (NASA/USGS). |
| Mapzen terrain tiles v1.1 | `mapzen` | Open Topo Data | Requires the multi-source attribution below. |

Every successful result's `Sources:` line credits each dataset that answered, and a response that used any Mapzen value carries the full Mapzen attribution there. The public Open Topo Data instance publishes no terms beyond its usage limits; its server software is MIT-licensed and self-hostable.

Mapzen terrain tiles attribution, verbatim from the tilezen/joerd attribution document:

- ArcticDEM terrain data DEM(s) were created from DigitalGlobe, Inc., imagery and funded under National Science Foundation awards 1043681, 1559691, and 1542736;
- Australia terrain data © Commonwealth of Australia (Geoscience Australia) 2017;
- Austria terrain data © offene Daten Österreichs – Digitales Geländemodell (DGM) Österreich;
- Canada terrain data contains information licensed under the Open Government Licence – Canada;
- Europe terrain data produced using Copernicus data and information funded by the European Union - EU-DEM layers;
- Global ETOPO1 terrain data U.S. National Oceanic and Atmospheric Administration
- Mexico terrain data source: INEGI, Continental relief, 2016;
- New Zealand terrain data Copyright 2011 Crown copyright (c) Land Information New Zealand and the New Zealand Government (All rights reserved);
- Norway terrain data © Kartverket;
- United Kingdom terrain data © Environment Agency copyright and/or database right 2015. All rights reserved;
- United States 3DEP (formerly NED) and global GMTED2010 and SRTM terrain data courtesy of the U.S. Geological Survey.

This server is independent of the U.S. Geological Survey and of Open Topo Data, and is not endorsed by either.

## Contributing

Issues are welcome. Run checks and tests before submitting:

```sh
bun run devcheck
bun run test
```

## License

This project is licensed under the Apache 2.0 License. See the [LICENSE](./LICENSE) file for details.

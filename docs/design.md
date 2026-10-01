# elevation-mcp-server — Design

## MCP Surface

### Tools

| Name | Description | Key Inputs | Annotations |
|:-----|:------------|:-----------|:------------|
| `elevation_get_points` | Look up ground elevation at 1–100 coordinates, in meters and feet, with the dataset and resolution behind every point. | `points`, `source` | `readOnlyHint: true`, `openWorldHint: true` |
| `elevation_get_profile` | Resample a route at evenly spaced points and summarize it: distance, ascent, descent, min/max elevation, steepest grades, plus the per-sample profile unless `include_samples` is false. | `path`, `samples`, `include_samples`, `source` | `readOnlyHint: true`, `openWorldHint: true` |
| `elevation_get_grid` | Sample a regular node grid over a bounding box; report the highest and lowest sampled points, mean, and relief. | `south`, `west`, `north`, `east`, `rows`, `cols`, `source` | `readOnlyHint: true`, `openWorldHint: true` |
| `elevation_check_line_of_sight` | Decide whether terrain blocks the sightline between an observer and a target, with earth curvature and refraction; report the minimum clearance and the limiting terrain point. | `observer`, `target`, `observer_height_m`, `target_height_m`, `earth_model`, `samples`, `source` | `readOnlyHint: true`, `openWorldHint: true` |

Auth scopes, for deployments running `MCP_AUTH_MODE=jwt|oauth`: `tool:<tool_name>:read` on each tool.

### Resources

None. Every capability is a tool; no data here is a stable, addressable record worth injecting as context (see Design Decisions).

### Prompts

None.

## Overview

`elevation-mcp-server` computes over terrain height: point elevations, route profiles with ascent and descent, area grids with high and low points, and terrain line-of-sight. Both upstreams are point-query services, so the profile, grid, and line-of-sight results are built in this server by sampling points and applying geometry.

Two keyless sources answer the point queries:

- **USGS 3DEP** through the Elevation Point Query Service (EPQS): the 3D Elevation Program's seamless DEM. Live probes show it answers across the US and its territories (1 m and 5 m lidar-derived rasters, 1/9 and 1/3 arc-second seamless rasters) and across much of Canada and Mexico at 1 arc-second (about 30 m). One point per request.
- **Open Topo Data**: the public instance at `api.opentopodata.org`, or an operator's self-hosted instance. The server requests the dataset stack `srtm30m,mapzen`, so each point is answered by SRTM GL1 v3 (1 arc-second, about 30 m, land between 60°N and 56°S) and, where SRTM has no tile, by Mapzen terrain tiles v1.1 (a global 1 arc-second assembly of many sources, covering high latitudes, Antarctica, and ocean bathymetry). Up to 100 points per request.

Audience: outdoor and route planners, drone and aviation dispatchers, civil engineers, hydrologists, radio and telecom planners, and agents doing spatial reasoning over terrain.

## Requirements

- Read-only and keyless. No caller or operator credentials.
- Every elevation the server returns names the dataset that produced it (`usgs_3dep`, `srtm30m`, or `mapzen`): per point, per profile sample, per grid cell, per line-of-sight endpoint and limiting point. It also gives that dataset's resolution wherever the dataset has a single one; Mapzen's varies by region, so it is omitted.
- `source: 'auto'` (default) tries USGS 3DEP first and falls back to Open Topo Data only for points 3DEP does not cover. Availability failures do not fall back (Design Decisions §4).
- Elevations in meters; feet alongside wherever a single value or a summary is reported. Distances in meters, grades in percent. Every numeric output field carries its unit in its name.
- Per-call caps: 100 points; 250 samples or grid cells. One tool call finishes inside a 45 s sampling budget.
- Upstream etiquette:
  - EPQS: paced at 6 concurrent requests and 10 request starts per second. It publishes no limit; the pacing is sized from measured latency (see API Reference).
  - Open Topo Data's public instance: paced under its published limits. At most 100 locations per request, one request in flight, starts at least 1.1 s apart, and at most 1,000 requests in any trailing 24 hours per server process.
  - A call sends at most 3 Open Topo Data requests (250 points ÷ 100).
  - A self-hosted instance (`OPENTOPODATA_BASE_URL`) gets 4 concurrent requests and no rate windows.
- Deployment: stdio and Streamable HTTP. No tool asks the caller for input mid-call, so no session-mode requirement. Workers-compatible in principle (no Tier 3 primitives), not a target.
- Terms and attribution:
  - **USGS 3DEP** data is a US federal government work, public domain (17 USC §105). Credit "U.S. Geological Survey, 3D Elevation Program" as a courtesy.
  - **Open Topo Data's public API** publishes no terms of service beyond its limits (100 locations per request, 1 call per second, 1,000 calls per day, per IP). The server software is MIT-licensed and self-hostable. Its maintainer points heavier users to self-hosting or to proxying through their own server, and offers whitelisting by email for research and small projects. An open-source server calling it on a user's behalf within those limits is within its intended use.
  - **SRTM GL1 v3** (`srtm30m`) is public domain (NASA/USGS).
  - **Mapzen terrain tiles** (`mapzen`) require the multi-source attribution in the tilezen/joerd attribution document. The server returns it verbatim whenever a Mapzen value is in the result (Shared output conventions § Enrichment; text under API Reference).
  - Hosting is permitted. A hosted instance on the public Open Topo Data instance shares one IP's daily allowance across all users (Known Limitations).

## User Goals

1. Look up ground elevation at one or many exact coordinates, with the resolution and provenance of each value → `elevation_get_points`.
2. Measure a route's total ascent, total descent, elevation range, and steepest grades → `elevation_get_profile`.
3. Survey an area's terrain: elevation grid, highest and lowest points, relief → `elevation_get_grid`.
4. Decide whether terrain blocks the view (or a radio path) between two points, and where → `elevation_check_line_of_sight`.
5. Identify local high and low points within a region → `elevation_get_grid` (`summary.highest` / `summary.lowest`), refined by re-gridding a smaller box.

## Tools — detail

### Shared input conventions

These schemas live once in `src/mcp-server/tools/shared/inputs.ts` and are reused by every tool.

**Point object** (`PointSchema`), used by `points[]`, `path[]`, `observer`, `target`:

| Field | Type | Notes |
|:------|:-----|:------|
| `lat` | `number`, −90…90 | Decimal degrees, WGS84. |
| `lon` | `number`, −180…180 | Decimal degrees, WGS84. |

- Wrapped in `z.preprocess(normalizePointKeys, z.object({...}))`. When `lat` is absent and `latitude` is present, it is moved to `lat`; when `lon` is absent and exactly one of `longitude` / `lng` / `long` is present, it is moved to `lon`. These mappings are one-to-one and meaning-preserving. `toJSONSchema` emits only the inner object, so the advertised schema stays `{lat, lon}`.
- The nested object is **not** strict: extra keys (a `name` or `elevation` carried over from another tool's output) are stripped. `lat` and `lon` stay required, so a misspelled coordinate key still fails by name.
- Rejected, not normalized: `[lat, lon]` tuples and `"lat,lon"` strings. GeoJSON orders coordinates `[lon, lat]`, so the order cannot be inferred with certainty. Out-of-range values (for example `lon: 200`) are rejected too, not wrapped, since a swapped lat/lon pair produces the same symptom.
- Numeric strings (`"47.6"`) are rejected by the schema. Form clients send numbers for `number` fields, and LLM callers send numbers.

**`source`** (`SourceSchema`), on every tool:

| Value | Meaning |
|:------|:--------|
| `auto` (default) | USGS 3DEP for points inside the 3DEP coverage envelope (Services § Coverage envelope); Open Topo Data for points outside it and for 3DEP misses. |
| `usgs_3dep` | USGS 3DEP only. A point 3DEP cannot answer returns no data. The envelope is not applied: every point is queried. |
| `opentopodata` | Open Topo Data only (SRTM, then Mapzen where SRTM has no tile). Use for values from one provider across the 3DEP coverage edge, or when 3DEP is down. |

- `.describe('Elevation source: auto (default) uses USGS 3DEP where it has data and Open Topo Data (SRTM, with Mapzen terrain tiles where SRTM has no data) for the rest; usgs_3dep uses 3DEP only; opentopodata uses Open Topo Data only. Case is ignored and spaces or hyphens read as underscores, so USGS-3DEP and open topo data are accepted; 3dep, usgs, and epqs are also aliases for usgs_3dep.')`
- `z.preprocess(normalizeSource, z.enum(['auto','usgs_3dep','opentopodata']).default('auto'))`. `normalizeSource` maps `''` to `undefined` (so the default applies), then trims, lowercases, and replaces `-` and spaces with `_`, then applies the alias table `3dep → usgs_3dep`, `usgs → usgs_3dep`, `epqs → usgs_3dep`, `open_topo_data → opentopodata`. Each alias names exactly one source (Design Decisions §30). The table is a `Map`, so a name inherited from `Object.prototype` (`constructor`, `__proto__`) matches nothing and reaches the enum as the string it is.

**Optional numeric, boolean, and enum inputs** (`samples`, `include_samples`, `rows`, `cols`, heights, `earth_model`) use the `blankAsUnset` wrapper (`z.preprocess(v => v === '' ? undefined : v, schema)`) so a form client's blank reaches the default. No optional field carries `.min(1)` to catch a blank.

**Bounded arrays** (`points`, `path`) use `boundedArray(item, min, max)` = `z.preprocess((v, ctx) => { if (Array.isArray(v) && v.length > max) ctx.addIssue({ code: 'too_big', origin: 'array', maximum: max, inclusive: true }); return v; }, z.array(item).min(min).max(max))`. An oversized list fails with its one `too_big` issue and no element issues, never one issue per bad field of a 10,000-item paste: an issue raised in the preprocess step stops the pipe before the array parses any element. Zod's own `.max()` check runs only after every element has been parsed, and slicing to `max + 1` first still left about 200 issues for a 10,000-point invalid paste. The inner `.max(max)` never fires but stays, so `tools/list` still advertises `items`, `minItems`, and `maxItems`. `points` first wraps a bare point object into a one-element array.

**No date or free-text inputs.** Every input is a number, a point object, or an enum, so no tool validates a date or sanitizes caller text.

### Shared output conventions

- **Provenance**: `dataset` is `'usgs_3dep' | 'srtm30m' | 'mapzen'` on every value with data. `usgs_3dep` comes from EPQS; `srtm30m` and `mapzen` come from Open Topo Data. `resolution_m` is the answering raster's ground spacing in meters:
  - `usgs_3dep`: from EPQS's `resolution` (Services § EPQS resolution normalization).
  - `srtm30m`: 30.9 (1 arc-second of latitude).
  - `mapzen`: omitted. Its 1 arc-second grid is interpolated in places from much coarser sources (about 1.8 km over the open ocean), so no single figure is true.
- **Rounding**: coordinates 6 decimals; `elevation_m` 2 decimals; `elevation_ft` 1 decimal (international foot, m / 0.3048); distances 1 decimal; grades and clearances 1 decimal (clearance 2); `resolution_m` 1 decimal. EPQS returns 9 decimals, which is far below any DEM's vertical accuracy. Open Topo Data's datasets are integer rasters, so its values arrive as whole meters.
- **Absent stays absent**: a point or sample with no data omits `elevation_m` / `dataset` / `resolution_m` (grid cells use `null` to keep matrix positions). No value is coerced to 0.
- **Water**: Mapzen values below 0 m are reported as received, not treated as no data. Over open water they are sea-floor depths, not the water surface. Each tool's notices flag them, and line of sight measures clearance over them to the sea surface (Computation § Line of sight).
- **Upstream-authored text in output**: exactly one field carries it.
  - `acquisition_date` (`elevation_get_points`): EPQS `attributes.AcquisitionDate`, kept only when it has the `M/D/YYYY` form (`^\d{1,2}/\d{1,2}/\d{4}$`) and then passed through verbatim; a value in any other form is omitted (Design Decisions §48). Live values include a zero month or day (`0/5/2013`, `4/0/2017`), which the form admits, so the server checks the form but does not parse the date.
  - `dataset` is not upstream text: the Open Topo Data client checks the response's `dataset` against the two names it requested and fails the response otherwise (Services § `OpenTopoDataClient`).
  - `format()` renders `acquisition_date` only in an inline slot (a table cell), through `inlineText()`: line breaks flattened, one space each, where a CRLF pair, a lone CR, and a lone LF each count as one break (as do NEL, U+2028, and U+2029); C0/C1 control characters and bidi controls (U+061C, U+200E, U+200F, U+202A–U+202E, U+2066–U+2069) stripped; `\`, `[`, `]`, `<`, `>`, and `|` backslash-escaped so link, image, HTML, and table syntax stay inert. This is a second layer behind the form check. `structuredContent` keeps it exactly as received.
  - No upstream error text reaches either surface or the client's log stream. EPQS miss bodies, both providers' error bodies, and a dataset name Open Topo Data was not asked for are replaced by this server's own messages. `ctx.log`, which the client also receives as `notifications/message`, records only their byte length and kind at `debug`; their first 200 characters go to the process log alone (Design Decisions §47). Nor do HTTP reason phrases, raw header text, or redirect targets reach the caller: a failure names an unexpected status by number only. `format()` prints no URLs.
- **Failure scope**: a coverage miss degrades to no data for that point or sample. Any availability, limit, configuration, or deadline failure from either provider fails the whole call with one of the declared reasons. It aborts outstanding requests and returns no partial result (Design Decisions §23).
- **Enrichment**: every tool declares the same two fields, `notice` first, then `attribution`:
  - `notice: z.string().optional()` (kind `notice`): the fragments listed per tool. All conditions are evaluated, and matching fragments are joined with a space in the order listed.
  - `attribution: z.string()`, **required**, rendered with `enrichmentTrailer: { attribution: { label: 'Sources' } }`. The handler writes it with `ctx.enrich({ attribution: attributionFor(samples) })` immediately after the sampler resolves, before any `ctx.fail` check or notice branch, so every success path carries it. `attributionFor()` (`src/services/elevation/attribution.ts`) joins one line per dataset that answered at least one value, in this order:
    - `usgs_3dep`: `USGS 3D Elevation Program (3DEP), courtesy of the U.S. Geological Survey (public domain).`
    - `srtm30m`: `SRTM GL1 v3 via Open Topo Data, courtesy of the U.S. Geological Survey and NASA (public domain).`
    - `mapzen`: `Mapzen terrain tiles via Open Topo Data:` followed by the required attribution block (API Reference § Open Topo Data), verbatim, as one paragraph.
    - When no dataset answered: `No dataset returned elevation data.`
  - No tool truncates a list or caps a display, so no `truncated` / `shown` / `cap` fields exist.

### `elevation_get_points`

**Description:** "Look up ground elevation at up to 100 coordinates in one call, in meters and feet, with the dataset and resolution behind every point. Inside USGS 3DEP coverage (the US and its territories, plus much of Canada and Mexico) values come from 3DEP at 1–30 m resolution. Elsewhere they come from Open Topo Data: SRTM at about 30 m on land between 60°N and 56°S, and Mapzen terrain tiles beyond SRTM's coverage and over the ocean, where values below 0 m are sea-floor depths. A point with no data in any queried dataset returns status no_data instead of failing the call."

| Param | Type | Maps to | Notes |
|:------|:-----|:--------|:------|
| `points` | `boundedArray(PointSchema, 1, 100)` | EPQS `x`/`y`; Open Topo Data `locations` | `.describe('1–100 points as {lat, lon} objects in decimal degrees (WGS84). latitude, longitude, and lng keys are also accepted.')`. Preprocess also wraps a single bare point object into a one-element array (certain). Duplicate coordinates (after 6-decimal rounding) are queried once and answered at every position. |
| `source` | `SourceSchema` | routing | See Shared input conventions. |

**Output:**

| Field | Type | Notes |
|:------|:-----|:------|
| `points[]` | array, same order and length as input | One entry per input point. |
| `points[].lat`, `points[].lon` | number | Echo of the input, 6 decimals. |
| `points[].status` | `'ok' \| 'no_data'` | `no_data` when no queried dataset had a value. |
| `points[].elevation_m` | number, optional | Absent on `no_data`. |
| `points[].elevation_ft` | number, optional | Absent on `no_data`. |
| `points[].dataset` | `'usgs_3dep' \| 'srtm30m' \| 'mapzen'`, optional | Which dataset answered. Absent on `no_data`. |
| `points[].resolution_m` | number, optional | Approximate ground spacing of the answering raster. Absent on `no_data` and for `mapzen`. |
| `points[].raster_id` | number, optional | EPQS `rasterId` (3DEP answers only). |
| `points[].acquisition_date` | string, optional | EPQS acquisition date, verbatim, in M/D/YYYY form (3DEP answers only, when EPQS returns one in that form). Upstream-authored. |
| `points_with_data` | number | Count of `ok` points. |
| `source_mode` | `'auto' \| 'usgs_3dep' \| 'opentopodata'` | Echo of the applied `source` (default `auto`). |

`format()`: a heading line with `points_with_data / total` and `source_mode`, then a table `| # | Lat, Lon | Status | Elevation (m / ft) | Dataset | Resolution (m) | Raster | Acquired |`. A missing elevation, dataset, or resolution shows `no data`, a Mapzen resolution shows `varies`, and the 3DEP-only Raster and Acquired cells show `—` when absent. The Status column carries `status` (`format-parity` requires every output field in the text). The `Sources:` line comes from the `attribution` enrichment trailer.

**Notice fragments:**

| Condition | Fragment |
|:----------|:---------|
| `source_mode = usgs_3dep` and any `no_data` | `{n} point(s) have no USGS 3DEP data; re-call elevation_get_points with source auto to fill them from Open Topo Data.` |
| `source_mode = auto` and any `no_data` | `{n} point(s) returned no elevation from any queried dataset; the Open Topo Data instance this server uses has no coverage there.` |
| `source_mode = opentopodata` and any `no_data` | `{n} point(s) returned no elevation from any queried dataset; the Open Topo Data instance this server uses has no coverage there. Re-call elevation_get_points with source auto to query both providers for the point(s) without data.` |
| Any `mapzen` point below 0 m | `{n} point(s) come from Mapzen with values below 0 m; over open water these are sea-floor depths, not the water surface.` |
| `usgs_3dep` and an Open Topo Data dataset both answered | `Values come from USGS 3DEP ({a} points, lidar-derived bare earth at 1–30 m) and Open Topo Data ({b} points, SRTM and Mapzen at about 30 m); compare elevations across the two with care, or re-call elevation_get_points with source opentopodata to take every value from Open Topo Data.` |

**Error contract:**

| reason | code | when | recovery | flags |
|:-------|:-----|:-----|:---------|:------|
| `usgs_unavailable` | `ServiceUnavailable` | `USGS 3DEP failed: a server error, rate limit, network error, or timeout that outlasted the retries (retryable), or a client error or unexpected status that retrying cannot fix (not retryable).` | `USGS 3DEP did not answer or rejected the request. If the error is marked retryable, retry elevation_get_points in a minute; either way, re-call it with source opentopodata to use SRTM and Mapzen data (about 30 m) instead.` | `thrownBy: 'service'`; no contract `retryable`, since the client sets `data.retryable` per failure (true for 5xx, 408, 429, timeouts, network errors; false for other 4xx, 501, an unexpected status, and a disposed pacer) |
| `opentopodata_unavailable` | `ServiceUnavailable` | `Open Topo Data failed: a server error, network error, timeout, or unreadable response that outlasted the retries (retryable), or an unexpected status that retrying cannot fix (not retryable).` | `Open Topo Data did not answer or rejected the request. If the error is marked retryable, retry elevation_get_points in a minute; either way, re-call it with source usgs_3dep when the points lie inside USGS 3DEP coverage.` | `thrownBy: 'service'`; no contract `retryable`, for the same reason (false for an unexpected status such as 405 or 501, and a disposed pacer) |
| `opentopodata_rate_limited` | `RateLimited` | Open Topo Data kept answering HTTP 429 through the retries, or asked for a wait over 8 s. `data.retryAfter` is the upstream's `Retry-After` in seconds, when it sent a parseable one of at most a day. | `Open Topo Data is refusing this server's requests as rate limited. The public instance allows 1 request per second and 1,000 per day per network address, shared with any other client at that address; a self-hosted instance sets its own limits. Retry elevation_get_points in a few minutes, or re-call it with source usgs_3dep for points inside USGS 3DEP coverage.` | `retryable: true`, `severity: 'warning'`, `thrownBy: 'service'` |
| `opentopodata_daily_limit` | `RateLimited` | `Only on the public Open Topo Data instance: this server has sent it 1,000 requests in the trailing 24 hours, so no request was sent.` `data.retryAfter` is the seconds until a request slot frees. | `This server has used the public Open Topo Data instance's 1,000 requests for the past 24 hours; capacity returns as those requests age out (see retryAfter). Re-call elevation_get_points with source usgs_3dep for points inside USGS 3DEP coverage, or ask the server operator to set OPENTOPODATA_BASE_URL to a self-hosted Open Topo Data instance.` | `retryable: false`, `severity: 'warning'`, `thrownBy: 'service'` |
| `opentopodata_config_rejected` | `ConfigurationError` | `The Open Topo Data instance answered 401, 403, or 404, a redirect from a self-hosted instance, a 400 naming a dataset it lacks or a location limit below 100, or a 200 naming a dataset this server did not request.` | `The Open Topo Data instance at OPENTOPODATA_BASE_URL cannot serve this server's requests (a wrong or redirecting URL, a missing or misconfigured srtm30m or mapzen dataset, or a per-request location limit under 100), which the server operator must fix. Meanwhile re-call elevation_get_points with source usgs_3dep for points inside USGS 3DEP coverage.` | `retryable: false`, `thrownBy: 'service'` |
| `sampling_deadline_exceeded` | `Timeout` | The call's 45 s sampling budget ran out (a retry deadline, or a wait in either provider's request queue), or the USGS 3DEP lookups other calls had queued, plus this call's, would not drain within the calls' budgets, so it sent none and `data.retryAfter` gives the seconds until the queued lookups drain. The message and `data.provider` (`usgs_3dep` or `opentopodata`) name the provider it ran out waiting on (Design Decisions §45 for the refusal). | `If the budget ran out waiting on USGS 3DEP, re-call elevation_get_points with fewer points, since each 3DEP point is its own upstream request, or, when the error carries retryAfter (other calls held 3DEP), retry it after that many seconds; if it ran out waiting on Open Topo Data, retry in a minute, or re-call it with source usgs_3dep for points inside USGS 3DEP coverage.` | `thrownBy: 'service'` |

No caller-input reasons: input shape is enforced by the schema, and a miss is a result, not an error.

### `elevation_get_profile`

**Description:** "Sample terrain elevation at evenly spaced points along a route (a polyline of 2–1,000 vertices) and summarize it. Returns total distance, cumulative ascent and descent, start, end, minimum, and maximum elevation, and the steepest climb and descent grades, plus the per-sample profile with each sample's dataset unless include_samples is false. Ascent and descent are summed between samples, so they depend on the sample spacing reported in the result: denser sampling captures more small climbs, down to the source's resolution. Over open water, Mapzen samples are sea-floor depths. Each USGS 3DEP sample is a separate upstream request, so up to 250 samples take roughly 10–30 seconds."

| Param | Type | Maps to | Notes |
|:------|:-----|:--------|:------|
| `path` | `boundedArray(PointSchema, 2, 1000)` | geometry | `.describe('Route vertices in travel order, 2–1,000 {lat, lon} objects in decimal degrees (WGS84). Consecutive duplicate vertices are ignored.')` |
| `samples` | `blankAsUnset(z.number().int().min(2).max(250).default(100))` | sample count | `.describe('Number of evenly spaced samples along the route, endpoints included (2–250, default 100). More samples catch more relief and take longer; spacing finer than the source resolution adds no detail. For a large count where only the summary matters, set include_samples to false.')` |
| `include_samples` | `blankAsUnset(z.boolean().default(true))` | output shape | `.describe('Return the per-sample profile (default true). false omits samples and the sample table; the summary, spacing, coverage counts, datasets, notices, and attribution are unchanged, still computed from every sample.')`. Changes only what is returned: every sample is still requested and fed to the summary and notices (Design Decisions §36). |
| `source` | `SourceSchema` | routing | |

**Output:**

| Field | Type | Notes |
|:------|:-----|:------|
| `samples[]` | array, length = `samples`, optional | In route order. Absent when `include_samples` is false. |
| `samples[].distance_m` | number | Cumulative distance along the route from the first vertex. |
| `samples[].lat`, `samples[].lon` | number | Sample location. |
| `samples[].elevation_m` | number, optional | Absent when no dataset had data. |
| `samples[].grade_pct` | number, optional | Grade from the previous sample with data to this one; absent on the first sample with data and on samples without data. |
| `samples[].dataset` | enum, optional | Provenance per sample. |
| `samples[].resolution_m` | number, optional | Absent for `mapzen`. |
| `summary.total_distance_m` | number | Route length. |
| `summary.start_elevation_m`, `summary.end_elevation_m` | number | First and last sample with data (always present: a call with no sample with data fails with `no_coverage`). |
| `summary.net_change_m` | number | End minus start. |
| `summary.ascent_m`, `summary.descent_m`, `summary.ascent_ft`, `summary.descent_ft` | number | Descent reported positive. 0 when fewer than 2 samples have data. |
| `summary.min_elevation_m`, `summary.max_elevation_m`, `summary.min_elevation_ft`, `summary.max_elevation_ft` | number | Over samples with data. |
| `summary.highest_point`, `summary.lowest_point` | `{ lat, lon, distance_m, elevation_m }` | First occurrence on ties. |
| `summary.max_grade_pct`, `summary.min_grade_pct` | number, optional | Largest and smallest grade: the steepest climb and the steepest descent (negative) on a route that does both. On a route that only descends, `max_grade_pct` is the gentlest descent, so it is negative too. Absent with fewer than 2 samples with data. |
| `summary.max_grade_distance_m`, `summary.min_grade_distance_m` | number, optional | `distance_m` of the sample each extreme grade leads to (the grade runs from the previous sample with data), first on ties of the unrounded grade. Present with its grade. |
| `sample_interval_m` | number | `total_distance_m / (samples − 1)`. |
| `vertices` | number | Vertices after dropping consecutive duplicates. |
| `samples_with_data`, `missing_samples` | number | |
| `datasets_used` | `{ usgs_3dep: number, srtm30m: number, mapzen: number }` | Sample counts per dataset. |
| `resolution_m_range` | `{ min_m: number, max_m: number }`, optional | Over samples that report a resolution; absent when none does (all Mapzen). |
| `source_mode` | enum | Applied `source`. |

`format()`: a summary block (distance in km and m, ascent and descent in m and ft, range, net change, grades with their distances, highest and lowest points, interval, data coverage, datasets), then a table `| # | Dist (m) | Lat, Lon | Elev (m) | Grade (%) | Dataset | Res (m) |` with every sample. The table prints `distance_m` exactly as `structuredContent` carries it, so the two surfaces agree value for value. The sample count in the Sampling and Coverage lines is `samples_with_data + missing_samples`, so it holds without `samples[]`; when `samples[]` is absent the table is replaced by the line `Per-sample rows omitted (include_samples: false).`

**Notice fragments:**

| Condition | Fragment |
|:----------|:---------|
| `missing_samples > 0` | `{k} of {n} samples have no data; ascent, descent, and grades bridge those gaps and may be understated.` When `source_mode ≠ auto`, followed by `Re-call elevation_get_profile with source auto to query both providers for the sample(s) without data.` |
| `usgs_3dep` and an Open Topo Data dataset both used | `The route crosses the USGS 3DEP coverage edge ({a} samples from USGS 3DEP, {b} from Open Topo Data), so ascent and descent mix 1–30 m lidar-derived values with 30 m SRTM-class values; re-call elevation_get_profile with source opentopodata for a profile from one provider.` |
| Any `mapzen` sample below 0 m | `{k} samples come from Mapzen with values below 0 m, which over open water are sea-floor depths; ascent, descent, and the lowest point include them.` |
| `resolution_m_range` present and `sample_interval_m < resolution_m_range.max_m` | `Samples are {i} m apart, closer than the {r} m source resolution, so extra samples add no detail; re-call elevation_get_profile with fewer samples for a faster result.` |
| `samples < 250` and `resolution_m_range` present and `sample_interval_m > 20 × resolution_m_range.min_m` and `sample_interval_m > 30` | `Samples are {i} m apart against a {r} m source; raise samples (up to 250) or split the route to capture more relief.` |

**Error contract:** the five service reasons from `elevation_get_points` with this tool's own deadline recovery, plus two handler reasons.

| reason | code | when | recovery | flags |
|:-------|:-----|:-----|:---------|:------|
| `degenerate_path` | `ValidationError` | After dropping consecutive duplicates, fewer than 2 vertices remain, or the route length is under 1 m. | `The path has no usable length because its vertices are the same point or under 1 m apart. Supply vertices spanning at least 1 m, or use elevation_get_points for a single location.` | `severity: 'notice'` |
| `no_coverage` | `NotFound` | No sample returned an elevation. | `No sample along the route returned an elevation. If the call used source usgs_3dep or opentopodata, re-call elevation_get_profile with source auto to query both providers; under auto, no dataset this server queries covers the route, so check one vertex with elevation_get_points to confirm.` | `severity: 'notice'` |
| `sampling_deadline_exceeded` | `Timeout` | 45 s budget spent, or refused with `data.retryAfter` while other calls held 3DEP (as `elevation_get_points`). | `If the budget ran out waiting on USGS 3DEP, re-call elevation_get_profile with fewer samples or a shorter route, since each 3DEP sample is its own upstream request, or, when the error carries retryAfter (other calls held 3DEP), retry it after that many seconds; if it ran out waiting on Open Topo Data, retry in a minute, or re-call it with source usgs_3dep for a route inside USGS 3DEP coverage.` | `thrownBy: 'service'` |
| `usgs_unavailable`, `opentopodata_unavailable`, `opentopodata_rate_limited`, `opentopodata_daily_limit`, `opentopodata_config_rejected` | as `elevation_get_points` | | Same recovery strings, with `elevation_get_points` replaced by `elevation_get_profile`. | as `elevation_get_points` |

### `elevation_get_grid`

**Description:** "Sample a regular grid of terrain elevations across a bounding box and report the highest and lowest sampled points, the mean elevation, and the relief, plus the full elevation matrix with each cell's dataset. Values are point samples at grid nodes (box edges included), not cell averages, so a summit between nodes is missed; to refine a candidate high or low point, call again with a smaller box around it. Over open water, Mapzen cells are sea-floor depths. Rows times columns may not exceed 250."

| Param | Type | Maps to | Notes |
|:------|:-----|:--------|:------|
| `south` | `number`, −90…90 | geometry | `.describe('Southern edge latitude, decimal degrees.')` |
| `west` | `number`, −180…180 | geometry | `.describe('Western edge longitude, decimal degrees. Must be less than east; a box crossing longitude 180 must be split into two calls.')` |
| `north` | `number`, −90…90 | geometry | `.describe('Northern edge latitude, decimal degrees. Must be greater than south.')` |
| `east` | `number`, −180…180 | geometry | `.describe('Eastern edge longitude, decimal degrees.')` |
| `rows` | `blankAsUnset(z.number().int().min(2).max(25).default(10))` | node rows | `.describe('Grid rows, north to south, edges included (2–25, default 10). rows × cols must be at most 250.')` |
| `cols` | `blankAsUnset(z.number().int().min(2).max(25).default(10))` | node columns | `.describe('Grid columns, west to east, edges included (2–25, default 10). rows × cols must be at most 250.')` |
| `source` | `SourceSchema` | routing | |

Flat edge parameters instead of a `bbox` array: bbox arrays come in incompatible orders (`[west, south, east, north]` in GeoJSON, `[south, west, north, east]` elsewhere), so named edges remove the ambiguity.

**Output:**

| Field | Type | Notes |
|:------|:-----|:------|
| `south`, `west`, `north`, `east` | number | Echo. |
| `rows`, `cols` | number | Applied values. |
| `latitudes_deg` | `number[]` (length `rows`) | Row 0 is `north`. |
| `longitudes_deg` | `number[]` (length `cols`) | Column 0 is `west`. |
| `row_spacing_m`, `col_spacing_m` | number | North-south node spacing; east-west spacing at the box's center latitude. |
| `elevations_m` | `(number \| null)[][]` | `[row][col]`, rows north→south, columns west→east; `null` = no data. |
| `cell_datasets` | `('usgs_3dep' \| 'srtm30m' \| 'mapzen' \| null)[][]` | Same indexing; provenance per cell. |
| `summary.highest`, `summary.lowest` | `{ lat, lon, row, col, elevation_m, elevation_ft }` | First in row-major order on ties. |
| `summary.mean_elevation_m` | number | Arithmetic mean over cells with data. |
| `summary.relief_m`, `summary.relief_ft` | number | Highest minus lowest. |
| `cells_with_data`, `missing_cells` | number | |
| `datasets_used` | `{ usgs_3dep: number, srtm30m: number, mapzen: number }` | |
| `resolution_m_range` | `{ min_m, max_m }`, optional | Absent when no cell reports a resolution. |
| `source_mode` | enum | |

`format()`: summary block, then the elevation matrix as a markdown table (header row of longitudes, first column of latitudes, values in m, `–` for null). Then provenance: `all cells usgs_3dep` / `all cells srtm30m` / `all cells mapzen` (the dataset id, as `cell_datasets` carries it) when uniform, otherwise a second matrix of `U` / `S` / `M` / `–` codes with a legend naming each id.

**Notice fragments:**

| Condition | Fragment |
|:----------|:---------|
| `missing_cells > 0` | `{k} of {n} cells have no data (null); summary values cover only cells with data.` When `source_mode ≠ auto`, followed by `Re-call elevation_get_grid with source auto to query both providers for the cell(s) without data.` |
| `usgs_3dep` and an Open Topo Data dataset both used | `The box spans the USGS 3DEP coverage edge ({a} cells from USGS 3DEP, {b} from Open Topo Data); the highest and lowest points compare values of different resolution and surface model.` |
| Any `mapzen` cell below 0 m | `{k} cells come from Mapzen with values below 0 m, which over open water are sea-floor depths; summary.lowest and the mean include them.` |
| `resolution_m_range` present and `row_spacing_m` or `col_spacing_m` > 20 × `resolution_m_range.min_m` | `Nodes are about {s} m apart against a {r} m source, so peaks and pits between nodes are missed; re-grid a smaller box around summary.highest to refine it.` |

**Error contract:**

| reason | code | when | recovery | flags |
|:-------|:-----|:-----|:---------|:------|
| `invalid_bbox` | `ValidationError` | `south >= north` or `west >= east`. | `Set south below north and west below east in decimal degrees; for a box crossing longitude 180, call elevation_get_grid twice, once on each side of the antimeridian.` | `severity: 'notice'` |
| `too_many_cells` | `ValidationError` | `rows × cols > 250`. The thrown message states the product: `rows × cols is {rows} × {cols} = {n}; the limit is 250.` | `Re-call elevation_get_grid with rows × cols at most 250, for example 15 × 15 or 10 × 25, or split the area into several boxes.` | `severity: 'notice'` |
| `no_coverage` | `NotFound` | No cell returned an elevation. | `No grid node returned an elevation. If the call used source usgs_3dep or opentopodata, re-call elevation_get_grid with source auto to query both providers; under auto, no dataset this server queries covers the box, so check a point inside it with elevation_get_points to confirm.` | `severity: 'notice'` |
| `sampling_deadline_exceeded` | `Timeout` | 45 s budget spent, or refused with `data.retryAfter` while other calls held 3DEP (as `elevation_get_points`). | `If the budget ran out waiting on USGS 3DEP, re-call elevation_get_grid with fewer rows or columns, since each 3DEP cell is its own upstream request, or, when the error carries retryAfter (other calls held 3DEP), retry it after that many seconds; if it ran out waiting on Open Topo Data, retry in a minute, or re-call it with source usgs_3dep for a box inside USGS 3DEP coverage.` | `thrownBy: 'service'` |
| `usgs_unavailable`, `opentopodata_unavailable`, `opentopodata_rate_limited`, `opentopodata_daily_limit`, `opentopodata_config_rejected` | as `elevation_get_points` | | Same recovery strings, naming `elevation_get_grid`. | as `elevation_get_points` |

The 250-cell product limit is enforced in the handler (`ctx.fail('too_many_cells', …)`), not the schema, so the caller gets this tool's recovery rather than a generic argument rejection; the per-dimension 2–25 bounds stay in the schema because they are structural.

### `elevation_check_line_of_sight`

**Description:** "Check whether terrain blocks the straight sightline between an observer and a target, each at a height above the ground, accounting for earth curvature and atmospheric refraction. Returns a verdict of clear, blocked, or indeterminate (when samples along the line have no data), the minimum clearance and the terrain point that limits it, and the first obstruction from the observer when blocked. Over open water, clearance is measured to the sea surface. Models terrain only: buildings and vegetation are not modeled beyond what the elevation source itself captures, and a ridge narrower than the reported sample spacing can be missed. To see the terrain between the points, call elevation_get_profile on the same two points."

| Param | Type | Maps to | Notes |
|:------|:-----|:--------|:------|
| `observer` | `PointSchema` | endpoint A | `.describe('Observer location as {lat, lon} in decimal degrees (WGS84).')` |
| `target` | `PointSchema` | endpoint B | `.describe('Target location as {lat, lon} in decimal degrees (WGS84).')` |
| `observer_height_m` | `blankAsUnset(z.number().min(0).max(10000).default(1.7))` | eye or antenna height | `.describe('Observer eye or antenna height above ground, meters (default 1.7, standing eye height).')` |
| `target_height_m` | `blankAsUnset(z.number().min(0).max(10000).default(0))` | target height | `.describe('Target height above ground, meters (default 0, the ground itself). Set it for a tower, building top, or second antenna.')` |
| `earth_model` | `z.preprocess(normalizeEarthModel, z.enum(['flat','geometric','optical','radio']).default('optical'))`; `normalizeEarthModel` maps `''` to `undefined`, then trims and lowercases | refraction coefficient κ | `.describe('Earth model: flat ignores curvature; geometric applies curvature without refraction; optical applies standard visible-light refraction (coefficient 0.13, default); radio applies the standard 4/3-earth radio refraction (coefficient 0.25).')` |
| `samples` | `blankAsUnset(z.number().int().min(3).max(250).default(100))` | sample count | `.describe('Evenly spaced terrain samples along the line, endpoints included (3–250, default 100). Spacing is reported; a ridge narrower than it can be missed.')` |
| `source` | `SourceSchema` | routing | |

**Output:**

| Field | Type | Notes |
|:------|:-----|:------|
| `verdict` | `'clear' \| 'blocked' \| 'indeterminate'` | See Computation § Line of sight. |
| `distance_m` | number | Great-circle distance observer→target. |
| `observer`, `target` | `{ lat, lon, ground_elevation_m, surface_elevation_m, height_above_ground_m, sightline_elevation_m, dataset, resolution_m? }` | `ground_elevation_m` as received; `surface_elevation_m` is the ground, or 0 where a Mapzen value below 0 marks open water; `sightline_elevation_m` = surface + height. |
| `min_clearance_m`, `min_clearance_ft` | number, optional | Smallest clearance over interior samples with data (negative = surface above the sightline). Absent when no interior sample has data. |
| `limiting_point` | `{ lat, lon, distance_from_observer_m, terrain_elevation_m, surface_elevation_m, curvature_bulge_m, sightline_elevation_m, clearance_m, dataset, resolution_m? }`, optional | The interior sample with the minimum clearance. |
| `first_obstruction` | same shape, optional | Present when `verdict = blocked`: the interior sample nearest the observer with clearance ≤ 0. |
| `obstructed_samples` | number | Interior samples with clearance ≤ 0. |
| `earth_model` | enum | Applied value. |
| `refraction_coefficient` | number, optional | κ; absent for `flat`. |
| `effective_earth_radius_m` | number, optional | `R / (1 − κ)`; absent for `flat`. |
| `sample_interval_m` | number | `distance_m / (samples − 1)`. |
| `samples`, `samples_with_data`, `missing_samples` | number | Endpoints included. |
| `datasets_used` | `{ usgs_3dep, srtm30m, mapzen }` | Per-sample counts; every returned location (endpoints, limiting point, first obstruction) carries its own `dataset`. |
| `source_mode` | enum | |

`format()`: the verdict as a heading, then observer and target lines, distance, minimum clearance (m and ft) with the limiting point, the first obstruction when blocked, the earth model with κ and effective radius, sampling and coverage, and datasets.

**Notice fragments:**

| Condition | Fragment |
|:----------|:---------|
| `verdict = indeterminate` (the bracketed clause only when `source_mode ≠ auto`) | `{k} interior samples have no data and no sample with data blocks the line, so the sightline cannot be confirmed clear; check the gap with elevation_get_profile on the same two points[, or re-call elevation_check_line_of_sight with source auto to query both providers].` |
| `verdict = clear` and `min_clearance_m < 2` | `Minimum clearance is under 2 m at {d} m from the observer; DEM vertical error, vegetation, and structures can close a margin that small.` |
| `usgs_3dep` and an Open Topo Data dataset both used | `The line crosses the USGS 3DEP coverage edge ({a} samples from USGS 3DEP, {b} from Open Topo Data); clearances compare terrain of different resolution and surface model.` |
| Sea-surface rule applied to any sample | `{k} samples lie over open water, where Mapzen reports sea-floor depth, so clearance there is measured to the sea surface at 0 m.` |

**Error contract:**

| reason | code | when | recovery | flags |
|:-------|:-----|:-----|:---------|:------|
| `same_endpoints` | `ValidationError` | Observer and target are under 1 m apart. | `Observer and target are the same point or under 1 m apart. Move one so the two points are at least a meter apart, or use elevation_get_points for a single location.` | `severity: 'notice'` |
| `sightline_too_long` | `ValidationError` | Observer and target are more than 1,000 km apart. Checked before any upstream request; the message gives the distance in km. | `Observer and target are more than 1,000 km apart, past the longest sightline this tool evaluates. Re-call elevation_check_line_of_sight with points under 1,000 km apart, or call elevation_get_profile on the same two points for the terrain along a longer route.` | `severity: 'notice'` |
| `endpoint_no_data` | `NotFound` | The observer's or target's own sample has no data, so its sightline height is unknown. Dynamic message names which endpoint. | `The observer or target has no elevation data in any queried dataset. If the call used source usgs_3dep or opentopodata, re-call elevation_check_line_of_sight with source auto to query both providers; under auto, no dataset this server queries covers that endpoint, so check it with elevation_get_points to confirm.` | `severity: 'notice'` |
| `sampling_deadline_exceeded` | `Timeout` | 45 s budget spent, or refused with `data.retryAfter` while other calls held 3DEP (as `elevation_get_points`). | `If the budget ran out waiting on USGS 3DEP, re-call elevation_check_line_of_sight with fewer samples, since each 3DEP sample is its own upstream request, or, when the error carries retryAfter (other calls held 3DEP), retry it after that many seconds; if it ran out waiting on Open Topo Data, retry in a minute, or re-call it with source usgs_3dep for a line inside USGS 3DEP coverage.` | `thrownBy: 'service'` |
| `usgs_unavailable`, `opentopodata_unavailable`, `opentopodata_rate_limited`, `opentopodata_daily_limit`, `opentopodata_config_rejected` | as `elevation_get_points` | | Same recovery strings, naming `elevation_check_line_of_sight`. | as `elevation_get_points` |

## Computation

Pure functions in `src/services/elevation/geometry.ts`, no I/O, unit-tested against golden values.

**Constants:** mean earth radius `R = 6,371,008.8 m` (IUGG); meters per degree of latitude `M = π·R / 180 ≈ 111,195 m`; international foot `0.3048 m`; plausibility floor `−12,000 m` (below the deepest ocean point, about −10,935 m) and ceiling `9,000 m` (above Everest, 8,849 m).

**Distance:** haversine on `R`.

**Path resampling** (`elevation_get_profile`):

1. Drop consecutive duplicate vertices (equal after 6-decimal rounding). Fewer than 2 left → `degenerate_path`.
2. Segment lengths `d_k = haversine(v_k, v_{k+1})`; cumulative `c_0 = 0, c_{k+1} = c_k + d_k`; route length `L = c_last`. `L < 1 m` → `degenerate_path`.
3. For `i = 0 … n−1` (n = `samples`): target distance `s_i = i·L/(n−1)`; find segment k with `c_k ≤ s_i ≤ c_{k+1}`; fraction `f = (s_i − c_k)/d_k`; point = spherical linear interpolation on the segment's great circle: with unit vectors `a`, `b` and angle `δ = d_k/R`, `p = (sin((1−f)δ)·a + sin(fδ)·b) / sin δ` (use `a` when `δ < 1e−12`). Convert back to lat/lon; normalize lon to [−180, 180]. Sample 0 is the first vertex and sample n−1 the last; intermediate vertices are not forced into the sample set.
4. `sample_interval_m = L/(n−1)`.

**Profile statistics:** over samples with data, in route order, taking consecutive pairs `(p, q)` of samples **with data** (gaps bridged): `Δe = e_q − e_p`, `Δd = s_q − s_p`. `ascent = Σ max(Δe, 0)`, `descent = Σ max(−Δe, 0)`, `grade_pct(q) = 100·Δe/Δd`. `max_grade_pct = max grade`, `min_grade_pct = min grade`. `net_change = e_last − e_first`. No smoothing and no hysteresis threshold: the sums are the raw sampled values (Design Decisions §16).

**Grid nodes** (`elevation_get_grid`): `lat_r = north − r·(north − south)/(rows − 1)` for `r = 0…rows−1`; `lon_c = west + c·(east − west)/(cols − 1)` for `c = 0…cols−1`. `row_spacing_m = (north − south)/(rows − 1)·M`; `col_spacing_m = (east − west)/(cols − 1)·M·cos(center_lat)`. Row-major order for ties and for the sampler's request order.

**Line of sight** (`elevation_check_line_of_sight`):

1. `D = haversine(A, B)`; `D < 1 m` → `same_endpoints`; `D > 1,000 km` → `sightline_too_long` (Design Decisions §44).
2. Samples `i = 0…n−1` at `d_i = i·D/(n−1)` on the great circle A→B (same slerp). `e_i` = terrain elevation at sample i, as received.
3. `e_0` or `e_{n−1}` missing → `endpoint_no_data`.
4. Surface: `s_i = 0` when sample i's dataset is `mapzen` and `e_i < 0` (open water, Design Decisions §25), otherwise `s_i = e_i`. Reported as `surface_elevation_m`.
5. Sightline endpoints: `z_A = s_0 + h_obs`, `z_B = s_{n−1} + h_tgt`; sightline at sample i: `z_i = z_A + (z_B − z_A)·d_i/D`.
6. Earth model → refraction coefficient κ: `flat` (no curvature term), `geometric` κ = 0, `optical` κ = 0.13, `radio` κ = 0.25. Effective radius `R_eff = R/(1 − κ)`.
7. Curvature bulge (surface rise relative to the straight chord): `b_i = d_i·(D − d_i)/(2·R_eff)`, `b_i = 0` for `flat`. The parabolic approximation holds for `D ≪ R`; at the 1,000 km bound it overstates the midpoint bulge by about 10 m (Design Decisions §44).
8. Clearance at interior samples (`1 ≤ i ≤ n−2`) with data: `c_i = z_i − (s_i + b_i)`.
9. Verdict: `blocked` if any interior `c_i ≤ 0`; `clear` if every interior sample has data and every `c_i > 0`; otherwise `indeterminate`.
10. `limiting_point` = argmin `c_i` (first on ties); `first_obstruction` = smallest i with `c_i ≤ 0`.

Golden values for tests (midpoint of a 50 km line, `d = D − d = 25 km`): `b = 49.05 m` geometric, `42.67 m` optical, `36.79 m` radio. Sea-surface case: a 50 km line between two 0 m `mapzen` endpoints over a −50 m `mapzen` sea floor, observer 1.7 m, target 0 m, `optical`: the midpoint surface is 0 m, so `c ≈ 0.85 − 42.67 < 0` and the verdict is `blocked` (against the sea floor it would read clear).

**Per-call sample caps and upstream call budget** (before retries; each EPQS point and each Open Topo Data request retries at most 2 times on transient errors):

| Tool | Max samples | EPQS requests (`auto`) | Open Topo Data requests | Typical wall time |
|:-----|:------------|:-----------------------|:------------------------|:------------------|
| `elevation_get_points` | 100 points | ≤ unique points inside the 3DEP envelope (≤ 100) | ≤ 1 | 1–10 s |
| `elevation_get_profile` | 250 samples | ≤ 250 | ≤ 3 | 10–30 s all 3DEP; 3–5 s all Open Topo Data |
| `elevation_get_grid` | 250 cells | ≤ 250 | ≤ 3 | as profile |
| `elevation_check_line_of_sight` | 250 samples | ≤ 250 | ≤ 3 | as profile |

`source: usgs_3dep` sends no Open Topo Data requests; `source: opentopodata` sends no EPQS requests and ⌈unique points / 100⌉ Open Topo Data requests. Measured EPQS throughput is about 10–11 points/s at 6 concurrent requests, so the 250 cap keeps a typical call well inside the 45 s budget, which itself sits inside a 60 s client request timeout. On the public Open Topo Data instance, 3 requests take about 2.2 s of start gaps plus 0.2–0.6 s each. Its 1,000 daily requests per server process count every attempt, retries included: they cover 333 full-size calls when no request retries and as few as 111 when every request retries twice, or at most 1,000 single-request calls.

## Services

| Service | Wraps | Used By |
|:--------|:------|:--------|
| `UsgsEpqsClient` (`src/services/usgs-epqs/usgs-epqs-client.ts`) | `GET https://epqs.nationalmap.gov/v1/json` | `ElevationSampler` |
| `OpenTopoDataClient` (`src/services/opentopodata/opentopodata-client.ts`) | `POST {OPENTOPODATA_BASE_URL}/v1/srtm30m,mapzen` | `ElevationSampler` |
| `ElevationSampler` (`src/services/elevation/elevation-sampler.ts`) | Routing, coverage envelope, dedupe, 3DEP admission and per-call window, chunking, deadline, provenance, error normalization | All four tools |
| `geometry` (`src/services/elevation/geometry.ts`) | Pure math (Computation) | Profile, grid, line-of-sight tools |
| `attributionFor` (`src/services/elevation/attribution.ts`) | Attribution text per dataset, including the Mapzen block | All four tools |

Init/accessor pattern: `initElevationServices(getServerConfig())` in `createApp({ setup })` builds both clients, their pacers (the EPQS pacer; the Open Topo Data request pacer, plus the daily pacer on the public instance), and the sampler. `getElevationSampler()` runs at request time. `disposeElevationServices()` in `createApp({ teardown })` disposes every pacer. Both clients send `User-Agent: elevation-mcp-server`.

### `ElevationSampler`

`sample(points: LatLon[], mode: SourceMode, ctx: Context): Promise<Sample[]>`, where a `Sample` is `{ lat, lon, elevation_m?, dataset?, resolution_m?, raster_id?, acquisition_date? }`, returned in input order.

1. Round coordinates to 6 decimals; deduplicate. Answers fan back out to every input position.
2. Budget: `deadlineAt = now() + budgetMs` (45,000 ms) from sampler entry. An internal `AbortController` is linked to `ctx.signal`; the first fatal error aborts the remaining work.
3. Routing per unique point:
   - `auto`: inside the coverage envelope → EPQS. EPQS miss, or outside the envelope → collected for Open Topo Data.
   - `usgs_3dep`: every point → EPQS; misses become no-data samples.
   - `opentopodata`: every point → Open Topo Data.
4. Phase 1 runs EPQS lookups through the EPQS pacer, at most 6 of the call's outstanding at once, the next submitted as one settles (Design Decisions §42). Before its first lookup, the call is admitted against the EPQS lookups other calls have outstanding, process-wide: the sampler tracks each call in phase 1 by its outstanding lookups and deadline, and admits the call when those lookups plus its own, drained at the pacer's 10 starts a second, finish by the earliest of those deadlines and its own. A call with no other call in phase 1 is always admitted. A refused call sends nothing and fails at once as `Timeout`, `reason: 'sampling_deadline_exceeded'`, `data.provider: 'usgs_3dep'`, `data.retryAfter` the seconds the other calls' outstanding lookups take to drain (Design Decisions §45). Phase 2 sends the remaining points to Open Topo Data in chunks of 100, in row-major or route order, through its pacers. Phases are sequential so a call never spends an Open Topo Data request on a point 3DEP could have answered.
5. **Fallback rule:** only a coverage miss (EPQS 200 with a non-value body) falls back. An EPQS availability failure fails the call with `usgs_unavailable`, and an Open Topo Data failure fails it with its own reason. Neither source substitutes for the other on an outage (Design Decisions §4).
6. Error normalization: a `withRetry` deadline expiry (`reason: 'retry_deadline_exceeded'`) or a shed from the EPQS pacer or the Open Topo Data request pacer (`reason: 'pacer_shed'`) becomes `Timeout` with `reason: 'sampling_deadline_exceeded'` (cause chained). Its `data.provider` and message name the phase the budget ran out in: `usgs_3dep` through phase 1 and the check that budget remains for phase 2, `opentopodata` from then on (Design Decisions §40). The daily pacer's shed never reaches the sampler as a shed: the client rethrows it as `opentopodata_daily_limit`. A cancelled `ctx.signal` rethrows unchanged.
7. Logs one `info` record per call: unique points, EPQS hits, misses, out-of-envelope count, Open Topo Data requests and points sent, answers per dataset, elapsed ms.

**Coverage envelope** (`auto` mode only). It is conservative: a point outside every box has no 3DEP raster, while a point inside may still miss.

| Box | Lat | Lon | Covers (verified points) |
|:----|:----|:----|:-------------------------|
| North America | 5 … 84 | −180 … −50 | CONUS, Alaska incl. Aleutians east of 180°, Hawaii, Puerto Rico, USVI, Canada, Mexico (Seattle, Utqiagvik, Honolulu, San Juan, St. Thomas, Vancouver, Yellowknife, Whitehorse, Ottawa, Mexico City, Oaxaca) |
| Western Aleutians | 50 … 56 | 170 … 180 | Attu |
| Mariana Islands and Wake | 10 … 21 | 144 … 167 | Guam, Saipan |
| American Samoa | −15 … −10 | −172 … −168 | Pago Pago |

### `UsgsEpqsClient`

- Request: `GET https://epqs.nationalmap.gov/v1/json?x={lon}&y={lat}&wkid=4326&units=Meters&includeDate=true`. These five parameters are the complete allowlist. EPQS silently ignores unknown parameters and silently answers in meters for an unrecognized `units` value, so no other key is ever sent and `units=Meters` is always explicit (the published spec claims the default is Feet; the live default is Meters).
- Plain-fetch boundary with an injected `fetch` (Test Boundary): per-attempt `AbortController` timer of `min(10,000 ms, remaining budget)`, combined with the retry attempt's signal. Requests set `redirect: 'manual'`, so a redirect is answered as itself rather than followed (Design Decisions §46). Accept-list: **200** is parsed (below); every other status → `httpErrorFromResponse(response, { service: 'USGS EPQS', captureBody: false })`, so 429 / 408 / 5xx carry their transient codes and any `Retry-After` into `withRetry`, and a 3xx or a 2xx other than 200 is not retried.
- Body read under a **16 KiB** ceiling (largest observed 240 bytes): a streaming reader stops and cancels the stream past the ceiling.
- 200 classification:
  - **Hit**: the body parses as a JSON object whose `value` is a finite number or a numeric string, and the value lies within the plausibility range: the −12,000 m floor (which excludes the historical `-1000000` no-data sentinel) to the 9,000 m ceiling (Design Decisions §49). Read `value` (string for Meters, number for Feet; both accepted), `rasterId`, `resolution`, and `attributes.AcquisitionDate` (kept only in `M/D/YYYY` form). `dataset` is `usgs_3dep`.
  - **Miss**: anything else on a 200. That covers plain-text bodies such as `Invalid or missing input parameters.`, `Call failed. [Failed cloud operation: …]`, `Transformation is unavailable for the current image.`, and `The operation was attempted on an empty geometry.`; JSON with no usable value; the sentinel or any other value outside the plausibility range; and a body over the read ceiling. The text is never returned: `ctx.log` records its byte length and kind (`not_a_json_object`, `no_numeric_value`, `outside_plausible_range`) at `debug`, and only the process log gets its first 200 characters.
- **EPQS resolution normalization**: `resolution ≥ 0.5` → meters as given (observed 1, 5); `resolution < 0.01` → degrees, `resolution_m ≈ resolution × 111,195` (observed 1/9″ → 3.4 m, 1/3″ → 10.3 m, 1″ → 30.9 m); between → omitted (unit unknown).
- Resilience: `withRetry(fn, { maxRetries: 2, baseDelayMs: 500, maxDelayMs: 4,000, deadlineMs: remaining, signal })` around fetch + read + classify. Inside it, the EPQS pacer: `createPacer({ name: 'usgs-epqs', maxConcurrent: 6, limits: [{ requests: 10, perMs: 1,000 }], cooldown: { baseMs: 2,000, maxMs: 30,000 } })`, run with `{ signal, maxWaitMs: remaining }`. One pacer per process, shared across concurrent calls; each call keeps at most 6 lookups in it (`ElevationSampler` step 4).
- After the ladder fails: `ServiceUnavailable`, `reason: 'usgs_unavailable'`, `data.status` when an HTTP status was seen, cause chained, with this server's own message naming the status by number. `retryable` is true for 5xx / 429 / timeouts / network errors. It is false for other 4xx, which indicate a request this server built wrongly or an upstream contract change, and for a 3xx or a 2xx other than 200.

### `OpenTopoDataClient`

- Request: `POST {baseUrl}/v1/srtm30m,mapzen`, headers `Content-Type: application/json` and `Accept: application/json`. Body exactly `{"locations":"{lat},{lon}|{lat},{lon}|…","interpolation":"bilinear"}`, each coordinate printed to 6 decimals, latitude first, at most 100 locations (the sampler chunks).
  - The upstream reads each JSON value through Python `str()`. So `locations` must be this pipe-delimited string: an array would arrive as its Python repr and fail to parse.
  - `nodata_value` is never sent: JSON `null` would arrive as the string `None`, and the upstream default (`null`) is what the client wants.
  - `interpolation` is sent explicitly so a self-hosted instance cannot differ from the documented default.
  - Unknown keys are silently ignored upstream (verified), so the body is built from these two keys only.
- Dataset stack: for each point the upstream queries `srtm30m`, then `mapzen`, returns the first non-null value, and names the dataset that answered.
- Plain-fetch boundary with an injected `fetch`, per-attempt timer `min(15,000 ms, remaining)`, `redirect: 'manual'` (Design Decisions §46). Accept-list and mapping (bodies are `{"status","error"}` JSON, verified live and in the upstream source):

  | Status | Handling |
  |:-------|:---------|
  | 200 | Parse (below). A hit naming a dataset this server did not request → `ConfigurationError`, `reason: 'opentopodata_config_rejected'`, `data.status` 200: only a misconfigured instance answers that way, so it is not retried. Unreadable, over the ceiling, `status` other than `OK`, or otherwise mis-shaped → `ServiceUnavailable`, `reason: 'opentopodata_unavailable'` (transient, retried). Either way the error's message names the problem (a dataset this server did not ask for, a hit that names no dataset, a results count that does not match, a location echo that does not match, a non-numeric elevation, a body that is not JSON or is over the ceiling), never the upstream's own text (Design Decisions §38). |
  | 2xx other than 200 | `ServiceUnavailable`, `reason: 'opentopodata_unavailable'`, `retryable: false`, `data.status`, message `Open Topo Data answered HTTP {status} instead of 200.` Not retried. |
  | 3xx | Not followed. Public instance: `opentopodata_unavailable` as for a 2xx, message `Open Topo Data answered HTTP {status}, a redirect this server does not follow.` Self-hosted instance: `ConfigurationError`, `reason: 'opentopodata_config_rejected'`, `data.status`, with a message telling the operator to set `OPENTOPODATA_BASE_URL` to the URL the instance redirects to. Not retried; the `Location` is never read. |
  | 400 | Read `error` (under 4 KiB). Text beginning `Dataset`, `Datasets`, `No valid dataset`, or `Too many locations` → `ConfigurationError`, `reason: 'opentopodata_config_rejected'`: the instance lacks a dataset or caps locations under 100. Any other 400 (`Unable to parse location …`, `Invalid JSON.`) → `InternalError`: this server built a request the upstream rejected. Neither is retried. |
  | 401, 403, 404 | `ConfigurationError`, `reason: 'opentopodata_config_rejected'`: wrong base URL, or an instance behind authentication. Not retried. |
  | 429 | `httpErrorFromResponse(…, { service: 'Open Topo Data', captureBody: false })` → `RateLimited`, carrying `Retry-After` when sent; retried within the budget (a `Retry-After` above 8 s fails fast), while the request pacer's cooldown holds back other calls. After the ladder: `RateLimited`, `reason: 'opentopodata_rate_limited'`, with `data.retryAfter` in whole seconds (a number) when the header was sent and parses: delta-seconds as given, an HTTP-date as the seconds left until it. An unparseable header, or one over a day, is omitted (Design Decisions §39). |
  | 5xx | `httpErrorFromResponse(…)` (`ServiceUnavailable`, `Timeout` for 504), retried; after the ladder `opentopodata_unavailable`. |
  | anything else | `httpErrorFromResponse(…)`, then mapped to `opentopodata_unavailable` with this server's own message naming the status by number. Only the 400 classification's `InternalError` passes through as is. |

  The 429 branch is designed from the published limits. The public instance's limit response was not reproduced, since that requires exceeding the limits; verify its status and body when one is first observed.
- Body read under a **64 KiB** ceiling for 200 responses (observed 14.9 KB at 100 locations, about 149 bytes per result); error bodies under 4 KiB.
- 200 parse: `{ status: 'OK', results: [{ dataset, elevation, location: { lat, lng } }] }`. `results.length` must equal the request length, and each `location.lat` / `location.lng` must match the sent coordinate at that index within 1e−6; otherwise the response is mis-shaped. Parse by key; the upstream sorts keys.
  - `elevation` a number within the plausibility range (the −12,000 m floor to the 9,000 m ceiling) → hit. `dataset` must be `srtm30m` or `mapzen`: any other name is a configuration rejection, and a missing or non-string `dataset` is mis-shaped. `resolution_m` is 30.9 for `srtm30m` and omitted for `mapzen`.
  - `elevation: null`, or a number outside the plausibility range → miss. `dataset` is then ignored: the upstream still names the last dataset whose bounds held the point, even though that dataset had no value.
- Upstream text in the logs: an unparseable or not-`OK` 200 body, an unrequested dataset name, and a 400's `error` text reach `ctx.log` only as a byte length and a kind (`not_json`, `no_ok_status_or_results`, `unrequested_dataset`, `config_rejection`, `request_rejected`) at `debug`; only the process log gets the first 200 characters (Design Decisions §47).
- Resilience: `withRetry(fn, { maxRetries: 2, baseDelayMs: 1,000, maxDelayMs: 8,000, deadlineMs: remaining, signal })` around pacing + fetch + read + classify.
  - **Public instance** (base URL host `api.opentopodata.org`), two pacers:
    - Request pacer: `createPacer({ name: 'opentopodata', maxConcurrent: 1, minStartGapMs: 1_100, cooldown: { baseMs: 2_000, maxMs: 30_000 } })`, run with `{ signal, maxWaitMs: remaining }`.
    - Daily pacer, inside the request pacer's task and around the fetch: `createPacer({ name: 'opentopodata-daily', limits: [{ requests: 1_000, perMs: 86_400_000 }], maxQueueDepth: 0 })`, run with `{ signal }`. Its shed is caught at that run site and returned from the request pacer's task as a value; once that task returns, the client throws `RateLimited`, `reason: 'opentopodata_daily_limit'`, `retryable: false`, `data.retryAfter` from the shed, so it neither retries nor reads as a deadline (Design Decisions §31).
    - The 1.1 s gap leaves a 10% margin under the published 1 call per second for clock and network jitter. A trailing 24-hour window is never looser than a calendar-day count.
  - **Any other base URL** is the operator's instance: one pacer `createPacer({ name: 'opentopodata', maxConcurrent: 4, cooldown: { baseMs: 2_000, maxMs: 30_000 } })`, run with `{ signal, maxWaitMs: remaining }`, and no daily pacer.

### Test Boundary

Every seam is a constructor option, never an env var:

- `new UsgsEpqsClient({ fetch, pacer? })` and `new OpenTopoDataClient({ fetch, baseUrl, pacer?, dailyPacer? })`: `fetch` is any fetch-compatible function; tests pass `createFetchMock(routes)` from `@cyanheads/mcp-ts-core/testing`. `pacer` defaults to the production pacer for the base URL; tests pass a permissive one. `dailyPacer` defaults to the production daily pacer on the public instance and to none otherwise; a test passes a one-request window to force `opentopodata_daily_limit`.
- `new ElevationSampler({ epqs, openTopoData, now?, budgetMs? })`: `now` (default `Date.now`) drives the deadline arithmetic; `budgetMs` (default 45,000) lets a test force `sampling_deadline_exceeded` in milliseconds.
- `initElevationServices(config, { fetch? })` threads an injected `fetch` through for handler-level tests.
- No file source: nothing is read from disk.
- Fixtures recorded from the live probes (API Reference):
  - EPQS: a hit with a string value; the Feet variant with a numeric value; each of the four miss texts; the 400 JSON body; an over-ceiling body.
  - Open Topo Data: a 200 mixing `srtm30m`, `mapzen` above and below 0 m, and a null; a 200 naming a dataset that was not requested; a 200 with `status` other than `OK`; a length-mismatched 200; the 400 bodies for too many locations, an unknown dataset, and an unparseable location; a 404; a 429 with and without `Retry-After`; a 500 `SERVER_ERROR`.
- Geometry tests use golden values: haversine on public reference coordinates, the curvature bulge values and the sea-surface case under Computation, resampling of a two-vertex path, grid node coordinates, and the three verdicts.

## Config

| Env Var | Required | Description |
|:--------|:---------|:------------|
| `OPENTOPODATA_BASE_URL` | No | Base URL of the Open Topo Data instance. Default `https://api.opentopodata.org`, the public instance, paced to its published limits. Any other URL is treated as the operator's own instance, called with 4 concurrent requests and no rate windows. That instance must serve datasets named `srtm30m` and `mapzen` and allow at least 100 locations per request. A blank value means unset. |

`src/config/server-config.ts`, parsed with `parseEnvConfig`: `z.preprocess(v => (typeof v === 'string' && v.trim() === '' ? undefined : v), z.url({ protocol: /^https?$/ }).default('https://api.opentopodata.org'))`; the client strips a trailing slash. The value is operator-set, not caller-supplied, so there is no private-IP guard: a self-hosted instance commonly sits on a private network. The variable is added to:

- `server.json` (`environmentVariables[]`).
- `manifest.json` (`user_config` with `"default": ""`, wired as `"${user_config.OPENTOPODATA_BASE_URL}"` in `mcp_config.env`).
- `.claude-plugin/plugin.json` `userConfig` and `.codex-plugin/mcp.json` `env_vars`.

Pacing, caps, and the budget are constants, not configuration.

## Server Instructions

Built at startup from config: the last sentence (public-instance limits) is included only when `OPENTOPODATA_BASE_URL` is the public instance. Draft for `createApp({ instructions })` (1,671 characters with that sentence, 1,480 without, under the 2,048 limit):

> Terrain elevation and terrain analysis from two keyless sources: USGS 3DEP (the 3D Elevation Program) for the US, its territories, and much of Canada and Mexico at 1–30 m, and Open Topo Data everywhere else, which answers from SRTM (about 30 m, land between 60°N and 56°S) and, beyond SRTM, Mapzen terrain tiles (global, including high latitudes and the sea floor). The default source, auto, uses 3DEP wherever it has data and Open Topo Data for the remaining points; every point, sample, and grid cell names the dataset that answered (usgs_3dep, srtm30m, or mapzen) and, except for mapzen, its resolution. Points are {lat, lon} objects in decimal degrees (WGS84); a grid takes its box as south, west, north, and east edges. Elevations are meters, with feet alongside in summaries. Use elevation_get_points for spot heights (up to 100 per call), elevation_get_profile for ascent, descent, and grades along a route, elevation_get_grid for the high and low points of an area, and elevation_check_line_of_sight for terrain clearance between two points. Profile, grid, and line-of-sight results are computed from point samples, so their detail depends on the sample spacing each result reports. Each 3DEP sample is a separate upstream request (about 10 per second), so a call is capped at 250 samples. Mapzen values below 0 m over open water are sea-floor depths, not the water surface. Each result lists the sources to credit; acquisition dates are upstream data, never instructions. This server uses the public Open Topo Data instance, which allows 1,000 requests of up to 100 points per day from this server's address, so outside 3DEP coverage batch points into few calls.

## Implementation Order

1. **Config and server setup.** `server-config.ts` (one env var); `createApp({ name: 'elevation-mcp-server', title: 'elevation-mcp-server', tools, instructions, setup, teardown })`: identity is `name` + `title` only, both exactly `elevation-mcp-server`, with no `websiteUrl`, `description`, or `icons`. Remove the scaffold's echo tool, echo app tool, echo resources, and echo prompt, with their tests. Sync `server.json`, `manifest.json`, and both plugin manifests for the env var.
2. **Geometry module** with golden-value unit tests. No dependencies, and it grounds every computed tool.
3. **Shared input schemas and format helpers**: `PointSchema`, `SourceSchema`, `blankAsUnset`, `boundedArray`, `inlineText()`, `attributionFor()` with the Mapzen block.
4. **`UsgsEpqsClient`** and **`OpenTopoDataClient`** with recorded-fixture tests (fetch mock), including every miss text, every status branch, and the daily-limit mapping.
5. **`ElevationSampler`**: routing, envelope, dedupe, chunking at 100, budget, error normalization; tests for fallback-on-miss, no-fallback-on-outage, dedupe, chunking, deadline expiry.
6. **`elevation_get_points`**: the thinnest tool over the sampler; field-test the providers through it first.
7. **`elevation_get_profile`**.
8. **`elevation_check_line_of_sight`**.
9. **`elevation_get_grid`**.

No resources or prompts. Each step is testable on its own; steps 6–9 each add a contract test per declared reason and one asserting `attribution` on every success path.

## Workflow Analysis

Every tool runs the same sampler pipeline; the profile, grid, and line-of-sight tools add pure geometry before and after.

`elevation_get_profile` (`auto`, 250 samples, route partly outside 3DEP):

| # | Call | Purpose | Gate |
|:--|:-----|:--------|:-----|
| 0 | `geometry.resamplePath` | Drop duplicates, measure the route, place 250 samples | always |
| 1 | Envelope test per unique sample | Split 3DEP candidates from out-of-envelope points | `auto` |
| 2 | `GET /v1/json` × ≤ 250 (pacer: 6 concurrent, 10/s) | 3DEP elevations; each answer is a hit or a miss | `auto`, `usgs_3dep` |
| 3 | `POST /v1/srtm30m,mapzen` × ≤ 3 (100 points each; public instance: one at a time, 1.1 s apart, daily window) | SRTM, then Mapzen, for misses and out-of-envelope points | `auto` with remaining points; `opentopodata` |
| 4 | `geometry.profileStats`, `attributionFor` | Ascent, descent, grades, extremes over samples with data; sources to credit | always |
| — | fail fast | Abort outstanding requests on the first availability, limit, or configuration failure, or on budget expiry | on error |

`elevation_check_line_of_sight` follows the same rows with `geometry.lineOfSight` in place of steps 0 and 4. `elevation_get_grid` uses `geometry.gridNodes` in step 0 and grid statistics in step 4. `elevation_get_points` skips the geometry.

A typical cross-tool chain: resolve a trailhead and a summit to coordinates (any geocoder), run `elevation_get_profile` on the trail's vertices for gain and grade, then `elevation_check_line_of_sight` from the summit to a distant lookout. For an area, `elevation_get_grid` locates the highest node, and a second `elevation_get_grid` on a small box around it refines the summit.

## Design Decisions

1. **The point tool is batch and global** (`elevation_get_points`, 1–100 points, any coverage). An earlier sketch had a single-point, US-focused `elevation_get_point` and left global and batch lookups to a separate server. A user who installs only this server needs both, Open Topo Data takes 100 points per request, and per-point provenance makes the mixed-source case legible.
2. **`elevation_check_los` → `elevation_check_line_of_sight`.** "los" reads ambiguously out of context; the noun is inherently three words.
3. **Line-of-sight verdict is tri-state** (`clear | blocked | indeterminate`) instead of `clear: boolean`. With interior samples missing, "clear" cannot be asserted, though "blocked" still can.
4. **Fallback on coverage, never on availability.** An EPQS miss is a fact about coverage, so SRTM answering it changes nothing about meaning. An EPQS outage is different: silently substituting 30 m SRTM for 1 m lidar changes what the number means. It would also move a busy server's whole load onto the public Open Topo Data instance's 1,000 daily requests. The caller can choose `source: opentopodata` explicitly.
5. **A conservative coverage envelope pre-filters `auto` mode.** A bounding-box test cannot prove a point *is* covered (EPQS misses open ocean inside the US envelope), but it can prove a point is *not*: outside every box, no 3DEP raster exists. Skipping EPQS there saves a request per point (a 250-sample European profile would otherwise make 250 wasted EPQS calls). Every box edge was checked against live points. `usgs_3dep` mode ignores the envelope so an explicit request always reaches EPQS.
6. **EPQS coverage is wider than "US only."** Live probes answered across Canada (including north of 60°) and Mexico at 1 arc-second; the dataset label stays `usgs_3dep` because the data is 3DEP's seamless product.
7. **Always send `units=Meters`; parse string or number; compute feet locally.** The OpenAPI spec says the default is Feet and `value` is a number. Live, the default is Meters with `value` a string, and Feet returns a number.
8. **Open Topo Data replaces Open-Elevation as the global source.** The public Open-Elevation instance meters coordinates: 500 a month per IP without a key, every coordinate counted, 250 m SRTM only, nothing above 60°N. One 250-sample profile would spend half a keyless month. Open Topo Data's public instance allows 1,000 requests of up to 100 points a day and serves 30 m SRTM plus Mapzen's global coverage. It publishes no terms beyond its limits and is MIT-licensed and self-hostable for heavier use.
9. **Request the dataset stack `srtm30m,mapzen`.** SRTM first keeps land values on one consistent 30 m radar model wherever it exists. Mapzen then answers the high latitudes, Antarctica, and the ocean that SRTM lacks, so a no-data point all but disappears on the public instance.
10. **Resolution is normalized to meters, and omitted for Mapzen.** EPQS reports `resolution` in the raster's native unit: meters for projected lidar rasters, degrees for the arc-second seamless rasters. Mapzen's 1 arc-second grid is interpolated in places from sources as coarse as 1.8 km, so any single figure would overstate its detail.
11. **Per-sample feet omitted from profile samples and grid cells.** A 250-sample profile carrying both units roughly doubles its payload. Summaries, extremes, clearances, and point lookups carry both units.
12. **Rounding** to 2 decimals (m), 1 decimal (ft); EPQS's 9 decimals are false precision.
13. **No reference tool.** The vocabulary is three source modes, three dataset ids, and four earth models, carried by enums, parameter descriptions, and the server instructions. Recovery strings route to concrete calls (`elevation_get_points` on one point, a re-call with another `source`), so a reference tool would add selection load without unlocking anything.
14. **No resources or prompts.** Nothing is a stable addressable record; the workflows are single tool calls.
15. **Sample count, not interval, is the sampling knob.** Count is what drives upstream cost and latency; the resulting interval is echoed, and notices flag spacing that is too coarse or finer than the source.
16. **No smoothing or hysteresis on ascent and descent.** Any threshold is an arbitrary parameter that changes the totals; raw sums over the reported samples are reproducible, and spacing is disclosed.
17. **Nested point objects strip unknown keys** so points carried over from other tools' outputs are accepted; `lat`/`lon` stay required.
18. **Coordinate tuples and "lat,lon" strings are rejected**, as is any out-of-range value. The order is ambiguous against GeoJSON's `[lon, lat]`.
19. **Grid uses edge-inclusive nodes, row 0 north**, matching raster convention; edges included so a box's corners are sampled.
20. **Plain `fetch` with an injected implementation for both providers**, not `fetchWithTimeout`. It gives a constructor seam for tests. Open Topo Data's 400 bodies must be read to tell an operator configuration fault from a request this server built wrongly, and its 429 must reach `withRetry` with `Retry-After` intact.
21. **One plausibility floor, −12,000 m, for both providers.** It sits below the deepest ocean point, so it never clips a real sea-floor depth from Mapzen, and it catches the historical `-1000000` EPQS sentinel and an integer raster's `-32768` without hard-coding either.
22. **Within-call dedupe** of coordinates rounded to 6 decimals: it saves EPQS requests and public Open Topo Data requests on repeated points (closed loops, repeated waypoints).
23. **Any provider failure fails the whole call; no partial results.** Outages are correlated across points. In the computed tools an error gap would also be indistinguishable from a coverage gap, which ascent, grid statistics, and clearances bridge silently. A miss degrades; a failure fails.
24. **`dataset` is the one per-value provenance field.** It names the provider too (`usgs_3dep` from EPQS; `srtm30m` and `mapzen` from Open Topo Data), so a separate per-sample `source` would repeat it on every one of up to 250 samples.
25. **Mapzen bathymetry is reported as received; line of sight clears the sea surface over it.** A sea-floor depth is real data and is labeled; treating it as no data would discard the ocean answers Mapzen exists to give. For a sightline, though, the water surface is what blocks: measured to a sea floor 50 m down, a 50 km sea path would read clear while curvature puts the water about 40 m above the line. Mapzen values below 0 are almost always under water: inside SRTM's latitude band Mapzen answers only where SRTM has no tile, which is the ocean, and land below sea level beyond that band is negligible. 3DEP and SRTM values below 0 stay as received (Death Valley, the Dead Sea).
26. **Two pacers for the public Open Topo Data instance; none of its windows for a self-hosted one.** The published limits are two budgets (1 call per second, 1,000 per day), and the framework's idiom is one pacer per upstream budget. The daily pacer refuses rather than queues (`maxQueueDepth: 0`), so a spent day fails fast with its own reason instead of looking like a deadline; the request pacer's sheds still map to `sampling_deadline_exceeded`. A self-hosted base URL is the operator's capacity, and capping it at the public allowance would defeat the reason to self-host.
27. **Attribution is a required enrichment field.** Mapzen's terrain tiles carry a required multi-source attribution. As enrichment it reaches `structuredContent` and `content[]` alike. Composing it from the datasets that answered keeps it to one short line unless Mapzen was used.
28. **POST with a JSON body; Open Topo Data's `samples` parameter is not used.** POST keeps 100 points out of the URL. Sample placement stays in `geometry.ts` so both providers answer the same points and 3DEP-first routing works sample by sample.
29. **Server instructions are built from config.** The public-instance limits sentence would misstate a deployment pointed at its own instance.
30. **`srtm` is not a `source` alias.** The `opentopodata` source answers from Mapzen wherever SRTM has no tile, so mapping `srtm` to it would not preserve the caller's meaning; the enum rejection lists the valid values instead.
31. **The daily-limit refusal leaves the request pacer's task as a value, not a throw.** Both ways of throwing it from inside that task go wrong. Rethrown as is, the daily pacer's shed carries `reason: 'pacer_shed'`: the request pacer's cooldown gate ignores it (framework 0.13.10 `noteRateLimit` skips sheds), but `withRetry` does not retry a shed and the client passes it through, so the sampler, which cannot tell it from the request pacer's own shed, reports `sampling_deadline_exceeded` instead of the daily limit. Converted to `opentopodata_daily_limit` and thrown there, it is a `RateLimited` with a non-shed reason, so it closes the gate (up to the 30 s cap, since its `retryAfter` is hours) and every later call waits out a cooldown no upstream asked for before failing the same way. Returned as a value, it becomes `opentopodata_daily_limit` outside the pacer.
32. **Deferred:** first-Fresnel-zone clearance for radio links (`frequency_mhz`), viewshed rasters, contour generation, returning the terrain profile from line-of-sight (call `elevation_get_profile` on the same two points), and a cross-call elevation cache.
33. **Profile start, end, and net change are required output fields.** A profile with no sample with data fails with `no_coverage`, so every successful result has a first and last sample with data. Optional fields would advertise an absence that cannot occur.
34. **Geometry reports degenerate inputs as values, not throws.** `resamplePath` returns `kind: 'degenerate'` and `lineOfSight` returns `kind: 'endpoint_no_data'`; each tool maps that to its own declared reason with `ctx.fail`, so `data.reason` and the tool-specific recovery reach the wire, and the geometry stays a pure function that tests can call directly.
35. **The extreme grades carry their own distances** (`max_grade_distance_m`, `min_grade_distance_m`), taken from the sample index `profileStats` chose. Locating them by matching the rounded `grade_pct` against the samples labels the first match, which is the wrong sample when two grades round alike and the steeper one comes second.
36. **`include_samples` (default `true`) trims the profile's output, never its sampling.** At the 250-sample cap the per-sample rows are most of a profile response (about 52 KB, counting `samples[]` and the text table), while the summary they feed is a small fraction of it. Lowering `samples` shrinks the payload only by coarsening ascent and descent, which the summary exists to avoid. The default stays `true` so existing callers keep their output and so `elevation_check_line_of_sight`'s pointer to `elevation_get_profile` "to see the terrain between the points" still gets the rows. The summary, counts, and notices are computed from every sample either way, so the two results differ only by `samples[]` and the table.
37. **Line-of-sight output objects state their shared facts once.** `observer`/`target` share one schema, as do `limiting_point`/`first_obstruction`. Their per-field describes are short labels, since units are in the field names. The facts the fields share (coordinate units, the sea-surface rule, the sightline and clearance formulas, Mapzen's missing resolution) are written once in the describe at the first use site, and `target` and `first_obstruction` point to their twin. Repeating those facts on every field of every use cost about 860 B of the tool's `tools/list` entry.
38. **A bad 200 names its problem; a dataset this server did not request is a configuration rejection.** `withRetry` rewraps an exhausted error with a `(failed after N attempts)` suffix and an internal `operation` field, so the client builds the final `opentopodata_unavailable` error fresh. A fresh error saying only "did not answer" would read as an outage when the instance answered every time with something unusable, so the parse failure carries its message in `data.detail` through the wrapper, and the final error takes it as its message while its data stays `{ reason, retryable, status? }`. A hit naming a dataset this server did not request is not retried at all: only a misconfigured instance answers that way, and a retry cannot change it, so it maps to `opentopodata_config_rejected` with `status: 200`, beside the 400 naming a dataset the instance lacks, and its recovery sends the caller to the operator rather than back to retry. A hit with no dataset name stays mis-shaped and retried. Messages are this server's own and never quote the upstream, so a dataset name the instance sent is not echoed.
39. **`retryAfter` is a number of seconds on both rate-limit reasons.** `opentopodata_daily_limit` always carried seconds as a number, while `opentopodata_rate_limited` passed the raw `Retry-After` header through as a string, which can also be an HTTP-date. One unit and type lets a caller wait on either without parsing. The conversion follows RFC 9110's two forms as the framework's retry delay does; an unparseable header is dropped rather than passed on. So is a value over a day (86,400 s, the daily window's length): no limit this server knows of asks for longer, and a long enough digit run parses to `Infinity`, which JSON serializes as `null`.
40. **The deadline names the provider it ran out waiting on.** Too many 3DEP requests and a slow or queued Open Topo Data instance need opposite remedies: fewer samples for the first, which would not help the second. The sampler knows which phase it was in, so the message and `data.provider` say so, and each tool's `sampling_deadline_exceeded` recovery covers both cases, since a recovery string is static per reason.
41. **Open Topo Data limit texts hold on both kinds of instance.** `tools/list` advertises every reason's `when` on every deployment, and the rate-limited recovery reaches callers of a self-hosted instance too. The rate-limited recovery states the public instance's limits as the public instance's and notes that a self-hosted instance sets its own; the daily-limit `when` opens by scoping itself to the public instance, the only place its pacer exists. The rate-limited message and recovery also hold for both ways the reason is reached: 429s through every retry, or one 429 whose `Retry-After` is longer than the call can wait, which fails on the first answer. Neither says the instance "kept" refusing.
42. **Each call keeps at most 6 EPQS lookups outstanding.** The EPQS pacer is one per process and serves its queue in arrival order. A call that queued every lookup at once would put a 1-point call arriving 100 ms after a 250-sample call behind all 250 (about 25 s at 10 starts a second), and with about 450 lookups queued the pacer's projected-wait check would refuse newcomers outright, so a caller's `sampling_deadline_exceeded` would come from someone else's load. The sampler instead submits a call's lookups through a window equal to the pacer's in-flight ceiling, the next as one settles, so calls interleave in the queue: a short call waits behind at most one window of each running call, and a call running alone still fills every slot. The cost is that concurrent heavy calls share the rate rather than finishing in turn: two 250-sample calls at once would each take about twice as long and both run out of the budget, which the admission check (§45) prevents by refusing the second. The pacer stays process-wide and first-in, first-out; fairness between callers rather than calls needs a caller identity, which a stateless deployment without auth does not have (Known Limitations).
43. **The public Open Topo Data day is shared, not split per caller.** One daily pacer serves every call in the process, and a stateless deployment has no caller key to divide the 1,000 requests by. A per-call share would not help, since a caller can make more calls, and a fixed per-caller share would cut a single local user's day to a fraction. A hosted deployment protects the day with its own Open Topo Data instance (Known Limitations).
44. **A sightline is at most 1,000 km long** (`sightline_too_long`, checked before any upstream request). The curvature bulge is the parabola `d·(D − d)/(2·R_eff)`, which overstates the true arc height above the chord at the midpoint by `D⁴/(384·R_eff³)`: about 10 m on a 1,000 km line with κ = 0 (6.6 m optical, 4.3 m radio), against a bulge of about 19.6 km. The error grows with D⁴, and near the antipode the formula breaks down: antipodal endpoints would read `blocked` with a clearance of about −6,800 km. The longest photographed terrestrial sightline is about 440 km, so the bound excludes no real sightline, and `elevation_get_profile` still covers a longer route's terrain.
45. **A call's 3DEP lookups are admitted only if the process-wide queue can drain them in time.** With each call's lookups interleaved (§42), every call in its 3DEP phase shares the pacer's 10 starts a second, so two 250-sample calls at once would each run at about 5 a second, need about 50 s, and both fail at 45 s after spending all 500 requests. Since the pacer starts lookups at one fixed rate whatever their order, the lookups already outstanding plus a new call's finish at a time the sampler can project before sending anything: their count at 10 a second. The sampler admits the call only when that projection ends by the earliest deadline among the calls in their 3DEP phase and the new one; otherwise the call fails at once as `sampling_deadline_exceeded`, having sent nothing, so the call already running keeps its pace and finishes. A call that finds no other call in its 3DEP phase is always admitted: nothing else delays it, and the per-call caps keep a lone call's projection (at most 25 s) inside its budget. The check is deliberately simple: it holds the whole drain to the earliest deadline, so a heavy call arriving while another is still running is refused even when interleaving would let both finish, and the two then run in turn, the first at full speed. `data.retryAfter` is the time the other calls' outstanding lookups take to drain rather than the combined projection: that projected finish does not move while they run, so a retry is admitted once they finish, and the combined figure would add this call's own lookups to the wait. The recovery names both remedies, fewer samples or a retry after `retryAfter`, and serves the deadline path as well. The projection counts lookups, not retries or latency, so an admitted call can still run out of budget on a slow upstream, which the deadline path reports.
46. **Only HTTP 200 is an answer, and redirects are not followed.** Neither upstream redirects on the routes this server uses, so a redirect means the upstream moved or something on the path is answering for it, and following it would send the request, and act on the answer, from wherever the `Location` points. Both clients fetch with `redirect: 'manual'`, and a 3xx fails without being retried, its message naming the status and never the `Location`: `usgs_unavailable` for EPQS and `opentopodata_unavailable` for the public Open Topo Data instance, while a self-hosted instance's redirect is `opentopodata_config_rejected`, since its operator fixes it by setting `OPENTOPODATA_BASE_URL` to the URL it redirects to. A 2xx other than 200 is not an answer either: its body is not read, and it fails as the provider's unavailable reason, not retried, in this server's words. The framework's `httpErrorFromResponse` turns a 2xx into an `InternalError` whose message and data carry the upstream's reason phrase and raw `Retry-After`, so the Open Topo Data client handles every 2xx and 3xx itself, and of the `InternalError`s that reach its final mapping only the 400 classification's own passes through as built.
47. **Upstream text stays out of `ctx.log`.** `ctx.log` writes to the process log and also sends every record to the client as `notifications/message`, and the client receives debug records until it sets a level with `logging/setLevel`, whatever `MCP_LOG_LEVEL` says. Debug records quoting an EPQS miss body, an unusable Open Topo Data 200, a 400's `error` text, or an unrequested dataset name would therefore hand the client the upstream text the error messages are written to withhold. `logUpstreamText()` (`src/services/shared/http-attempt.ts`) splits each such record. `ctx.log` gets its fields, a `kind` label, and the text's length in UTF-8 bytes. The framework's process-only `logger` gets the same plus the text's first 200 characters, correlated to the request through `ctx`, for an operator tracing a miss.
48. **`acquisition_date` is kept only in `M/D/YYYY` form.** It is the one upstream-authored field in any output. Unbounded, an EPQS body could carry about 16 KiB of prose per point into `structuredContent` verbatim and into `content[]`, where `inlineText()` neutralizes markup but not instruction-shaped prose, emphasis, or bare URLs. Every observed value matches `^\d{1,2}/\d{1,2}/\d{4}$`, the zero-month and zero-day dates (`0/5/2013`, `4/0/2017`) included, so checking that form rather than parsing a date keeps every real value and admits at most ten characters of digits and slashes. A value in any other form is omitted and the hit kept; `inlineText()` stays as a second layer.
49. **A plausibility ceiling, 9,000 m, beside the floor.** It sits above the highest summit (Everest, 8,849 m) and applies to both providers as the floor does (§21): an EPQS value above it is a miss, and so is an Open Topo Data value, whose `dataset` is then ignored. Without it any finite upstream number was a hit. A value of 1.8e306 or more rounds to `Infinity`, which fails the output schema as an unclassified error, smaller ones overflow in a profile's ascent or a grid's mean, and finite absurd values such as 1e9 m would be reported as terrain.

## Known Limitations

- **Open Topo Data's public limits.** The public instance allows 100 locations per request, 1 request per second, and 1,000 requests per day per IP. Each server process paces itself under them, but its count is process-local. It resets on restart. Several processes on one machine (a stdio server per client session), or other clients on the same address, also draw on the upstream's count, so the upstream can refuse first (`opentopodata_rate_limited`). The public instance's limit response has not been observed.
- **Hosted global coverage.** A hosted deployment sends every user's requests from one address, so on the public instance its whole user base shares 1,000 requests a day: about 1,000 point lookups, or 333 full 250-sample calls, and as few as 111 when retries spend requests too. One caller can spend the shared day in about 18 minutes at the 1.1 s gap. For up to 24 h after, every call that needs Open Topo Data fails with `opentopodata_daily_limit`, including an `auto` call inside 3DEP coverage with a single 3DEP miss. A hosted deployment therefore needs its own Open Topo Data instance (`OPENTOPODATA_BASE_URL`; MIT-licensed, Docker, loaded with the `srtm30m` and `mapzen` datasets). Without its own instance, global answers on a hosted deployment are best-effort.
- **No per-caller limits in the server.** A stateless deployment without auth has no caller identity, so the server paces each upstream for the whole process and cannot ration one caller against another: a caller sending many heavy calls at once slows USGS 3DEP for every caller, gets other callers' heavy calls refused until its lookups drain, and can spend the public Open Topo Data day.
- **Global resolution.** SRTM is a 30 m radar surface model. Mapzen's 1 arc-second grid is interpolated in places from coarser sources (GMTED2010 at 7.5 arc-seconds over parts of the high latitudes, ETOPO1 at about 1.8 km over the open ocean). So outside 3DEP coverage, profile ascent is underestimated and line of sight misses terrain narrower than the source's true resolution.
- **Whole-meter values.** Open Topo Data's datasets are integer rasters, and the upstream rounds the bilinear result to the nearest meter. Ascent and descent over gentle terrain from Open Topo Data therefore include 1 m quantization steps.
- **Water.**
  - SRTM reports water inside a land tile as 0 m (Puget Sound returns 0).
  - Beyond SRTM tiles, Mapzen reports sea-floor depth (open Pacific −4,389 m), and points, profiles, and grids include it.
  - 3DEP values over water depend on the raster: hydro-flattened surfaces (Puget Sound −0.36 m), sea level (Gulf coast 0.00 m), or bathymetric values (San Francisco Bay −18 m).
  - Line of sight measures clearance to 0 m over Mapzen values below 0, but uses 3DEP bathymetric values as received.
- **Mixed models.** 3DEP is a bare-earth DEM referenced to NAVD 88 in CONUS (local datums in some territories). SRTM is a radar surface model (partly includes canopy and buildings) referenced to EGM96. Mapzen blends both kinds by region. Differences of a meter or more between datasets at the same point are expected (Seattle: 3DEP 52.38 m, SRTM 59 m); provenance shows which applies.
- **Sampling.** Features narrower than the sample spacing are missed: a ridge between line-of-sight samples, a summit between grid nodes, short climbs between profile samples. Spacing is always reported.
- **EPQS throughput.** No published limit and no batch endpoint: about 10 points per second at the pacer's settings, with a p90 latency of 1–2 s, hence the 250-sample cap and 45 s budget. Concurrent calls interleave on one pacer (Design Decisions §42): a short call is answered after at most one window of each running call. A call whose lookups would carry the queued 3DEP lookups past a running call's budget is refused at once with `sampling_deadline_exceeded` and `data.retryAfter`, so two 250-sample calls at once run in turn: the first finishes, and the second can be retried after about 25 s (Design Decisions §45).
- **EPQS miss signaling.** EPQS reports a miss as HTTP 200 with one of several plain-text bodies whose wording varies between identical requests. If an EPQS backend fault ever returned miss text for covered points, `auto` mode would route those points to Open Topo Data; per-sample provenance would show it.
- **Acquisition dates** from EPQS are passed through raw when they have the `M/D/YYYY` form, and sometimes carry a zero month or day; a value in any other form is omitted.
- **Antimeridian.** A grid box cannot cross longitude 180 (split it). Paths and sightlines crossing it are handled by great-circle math.
- **Line of sight** models terrain only, with no Fresnel-zone, building, or vegetation clearance. Observer and target must be at most 1,000 km apart (`sightline_too_long`); within that, the curvature term is the standard parabolic approximation, which overstates the midpoint bulge by at most about 10 m.

## API Reference

All shapes below were verified live on 2026-10-01. Example coordinates are public reference locations.

### USGS EPQS

- Endpoint: `GET https://epqs.nationalmap.gov/v1/json` (OpenAPI page at `https://epqs.nationalmap.gov/v1/docs`). Served through API Gateway and CloudFront over HTTP/2, `content-type: application/json` on every response, CORS `*`. No auth, no published rate limit, no batch endpoint.
- Parameters: `x` (lon), `y` (lat), `wkid` (4326 or 102100; default 4326), `units` (`Meters` | `Feet`, case-insensitive; live default Meters), `includeDate` (adds `attributes.AcquisitionDate`).
- Hit (200):

  ```json
  {"location":{"x":-122.3321,"y":47.6062,"spatialReference":{"wkid":4326,"latestWkid":4326}},"locationId":0,"value":"52.377716064","rasterId":102575,"resolution":1,"attributes":{"AcquisitionDate":"6/5/2021"}}
  ```

  `units=Feet` returns `"value":171.84290597141376` (a number). `resolution` observed: `1`, `5` (meters); `0.0000308642` (1/9″), `0.0000925926` (1/3″), `0.0002777777796234786` (1″) (degrees). `AcquisitionDate` observed malformed: `0/5/2013`, `0/3/2014`, `4/0/2017`.
- Miss (200, plain text despite the JSON content type), wording varies between identical requests: `Invalid or missing input parameters.` · `Call failed.  [Failed cloud operation: Open, Path: /vsimem/_…aux.xml]` · `Transformation is unavailable for the current image.` · `The operation was attempted on an empty geometry.` (latitude 95). `'spatialReference' parameter is invalid.` for an unknown `wkid`.
- Errors: missing `x` → **400** ` {"errorMessage" : "[BadRequest] missing parameters"}` (with a leading space); wrong path or POST → **403** `{"message":"Missing Authentication Token"}`.
- Unknown parameters: silently ignored (`unitz=Feet` → meters; `units=Furlongs` → meters).
- Coverage verified: CONUS lidar at 1 m (Seattle, Death Valley −84.7 m, Mt. Whitney 4416.2 m); Alaska at 5 m (Anchorage, Denali 6147.0 m, Utqiagvik, Attu); Hawaii, Puerto Rico, USVI at 1 m; Guam 1/9″; Saipan and Pago Pago 1/3″; Canada (Vancouver and Toronto 1/3″; Ottawa, Yellowknife, Whitehorse 1″); Mexico (Tijuana 1/9″; Mexico City 2,251 m and Oaxaca 1″). Misses: open Pacific and Atlantic, offshore Hawaii, London, Havana, Nassau.
- Latency: single requests 0.06–2.2 s. 24 points at 6 concurrent: 2.2 s wall, p50 0.20 s, p90 1.23 s. 40 points at 10 concurrent: 4.5 s wall, p50 0.70 s, p90 2.27 s; all 200. Body size 160–240 bytes.

### Open Topo Data (public instance)

- Endpoint: `POST https://api.opentopodata.org/v1/{datasets}` (also `GET …?locations=lat,lon|lat,lon`). API docs at `https://www.opentopodata.org/api/`. Behind Cloudflare, `content-type: application/json`, response header `x-opentopodata-version: 1.9.0`, no rate-limit or quota headers, no auth.
- Public limits (home page): max 100 locations per request, max 1 call per second, max 1,000 calls per day. The maintainer's GitHub replies say the limits are per IP. Those replies also suggest self-hosting or proxying through your own server for more, and offer whitelisting by email for research and small projects. The API docs page calls the public instance available for testing. No other terms are published; the software is MIT-licensed.
- Datasets used:
  - `srtm30m`: SRTM GL1 v3, 1 arc-second, coverage "Latitudes -60 to 60". Water inside a tile is 0 m; a location with no tile returns null.
  - `mapzen`: Mapzen terrain tiles v1.1 (downloaded from AWS in May 2020), 1 arc-second, global including bathymetry, parts interpolated from lower-resolution sources.
- Request (POST, JSON): `{"locations":"47.6062,-122.3321|30,-140","interpolation":"bilinear"}`. The upstream reads each JSON value through Python `str()`; unknown keys and parameters are ignored (`interpolaton=nearest&datset=srtm90m` returned the same value as without them).
- 200, keys sorted, whole-meter values as floats, location echoed as parsed:

  ```json
  {"results":[{"dataset":"srtm30m","elevation":59.0,"location":{"lat":47.6062,"lng":-122.3321}},{"dataset":"mapzen","elevation":-4389.0,"location":{"lat":30.0,"lng":-140.0}}],"status":"OK"}
  ```

  With `srtm30m,mapzen`: Seattle `srtm30m` 59; London `srtm30m` 18; Death Valley `srtm30m` −77; Puget Sound inside an SRTM tile `srtm30m` 0; Tromsø (69.65°N) `mapzen` 9; open Pacific (30°N 140°W) `mapzen` −4,389; 40°N 180° `mapzen` −5,241; 89.9°N `mapzen` −4,168; McMurdo `mapzen` 8; South Pole `mapzen` 2,801. No null on the public instance.
- A null `elevation` still carries a `dataset` (the last dataset whose bounds held the point), per the upstream source (`backend.get_elevation`).
- 100 locations by POST: 200, 14.9 KB, 0.54 s, all integer values. Single requests 0.2–0.5 s.
- Errors, `{"error","status":"INVALID_REQUEST"}` with HTTP **400**:
  - `Too many locations provided (101), the limit is 100.`
  - `Unable to parse location '95,10' in position 1. Latitude must be between -90 and 90. Provide locations in lat,lon order.`
  - `Dataset 'mapzenx' not in config.`
  - Server errors (from the source): HTTP **500** `{"status":"SERVER_ERROR","error":…}`. The limit response (429 or otherwise) was not reproduced.
- Mapzen required attribution (tilezen/joerd `docs/attribution.md`), carried verbatim by `attributionFor()` and the README:

  ```text
  * ArcticDEM terrain data DEM(s) were created from DigitalGlobe, Inc., imagery and
    funded under National Science Foundation awards 1043681, 1559691, and 1542736;
  * Australia terrain data © Commonwealth of Australia (Geoscience Australia) 2017;
  * Austria terrain data © offene Daten Österreichs – Digitales Geländemodell (DGM)
    Österreich;
  * Canada terrain data contains information licensed under the Open Government
    Licence – Canada;
  * Europe terrain data produced using Copernicus data and information funded by the
    European Union - EU-DEM layers;
  * Global ETOPO1 terrain data U.S. National Oceanic and Atmospheric Administration
  * Mexico terrain data source: INEGI, Continental relief, 2016;
  * New Zealand terrain data Copyright 2011 Crown copyright (c) Land Information New
    Zealand and the New Zealand Government (All rights reserved);
  * Norway terrain data © Kartverket;
  * United Kingdom terrain data © Environment Agency copyright and/or database right
    2015. All rights reserved;
  * United States 3DEP (formerly NED) and global GMTED2010 and SRTM terrain data
    courtesy of the U.S. Geological Survey.
  ```

### Not applicable

- No pagination: EPQS answers one point per request and Open Topo Data every requested point (up to 100) in one response.
- No faceted or filtered search exists on either upstream, so there are no facet counts to verify.

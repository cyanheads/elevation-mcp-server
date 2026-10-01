/**
 * @fileoverview `elevation_get_profile`: resamples a route at evenly spaced
 * points, samples terrain at each, and summarizes distance, ascent, descent,
 * elevation range, and grades.
 * @module mcp-server/tools/definitions/get-profile
 */

import { tool, z } from '@cyanheads/mcp-ts-core';
import { JsonRpcErrorCode } from '@cyanheads/mcp-ts-core/errors';
import { agree, countOf, signed } from '@/mcp-server/tools/shared/format.js';
import {
  blankAsUnset,
  boundedArray,
  PointSchema,
  SourceSchema,
} from '@/mcp-server/tools/shared/inputs.js';
import {
  DatasetsUsedSchema,
  formatDatasetsUsed,
  formatResolutionRange,
  providerSplit,
  ResolutionRangeSchema,
  summarizeProvenance,
} from '@/mcp-server/tools/shared/outputs.js';
import { attributionFor } from '@/services/elevation/attribution.js';
import { getElevationSampler } from '@/services/elevation/elevation-sampler.js';
import { profileStats, resamplePath } from '@/services/elevation/geometry.js';
import {
  DATASETS,
  type Sample,
  SOURCE_MODES,
  type SourceMode,
} from '@/services/elevation/types.js';
import { metersToFeet, roundTo } from '@/services/elevation/units.js';

const MAX_SAMPLES = 250;

const ProfileSampleSchema = z
  .object({
    distance_m: z
      .number()
      .describe('Cumulative distance along the route from the first vertex, meters.'),
    lat: z.number().describe('Sample latitude, decimal degrees.'),
    lon: z.number().describe('Sample longitude, decimal degrees.'),
    elevation_m: z
      .number()
      .optional()
      .describe('Terrain elevation in meters. Absent when no queried dataset had data.'),
    grade_pct: z
      .number()
      .optional()
      .describe(
        'Grade in percent from the previous sample with data to this one (negative downhill). Absent on the first sample with data and on samples without data.',
      ),
    dataset: z
      .enum(DATASETS)
      .optional()
      .describe('Dataset that answered this sample. Absent when no dataset had data.'),
    resolution_m: z
      .number()
      .optional()
      .describe(
        'Approximate ground spacing of the answering raster, meters. Absent without data and for mapzen.',
      ),
  })
  .describe('One sample along the route, in route order.');

const RoutePointSchema = z
  .object({
    lat: z.number().describe('Latitude, decimal degrees.'),
    lon: z.number().describe('Longitude, decimal degrees.'),
    distance_m: z.number().describe('Distance along the route from the first vertex, meters.'),
    elevation_m: z.number().describe('Elevation in meters.'),
  })
  .describe('A sample along the route.');

type ProfileSample = z.infer<typeof ProfileSampleSchema>;

/** A sampled location with its distance along the route. */
type LocatedSample = Sample & { distance_m: number };

/** Narrows a located sample to one with an elevation. */
const withElevation = (sample: LocatedSample | undefined) =>
  sample?.elevation_m === undefined ? undefined : { ...sample, elevation_m: sample.elevation_m };

const toRoutePoint = (sample: LocatedSample & { elevation_m: number }) => ({
  lat: sample.lat,
  lon: sample.lon,
  distance_m: roundTo(sample.distance_m, 1),
  elevation_m: sample.elevation_m,
});

export const getProfileTool = tool('elevation_get_profile', {
  title: 'Get Route Elevation Profile',
  description:
    "Sample terrain elevation at evenly spaced points along a route (a polyline of 2–1,000 vertices) and summarize it. Returns total distance, cumulative ascent and descent, start, end, minimum, and maximum elevation, and the steepest climb and descent grades, plus the per-sample profile with each sample's dataset unless include_samples is false. Ascent and descent are summed between samples, so they depend on the sample spacing reported in the result: denser sampling captures more small climbs, down to the source's resolution. Over open water, Mapzen samples are sea-floor depths. Each USGS 3DEP sample is a separate upstream request, so up to 250 samples take roughly 10–30 seconds.",
  annotations: { readOnlyHint: true, idempotentHint: true, openWorldHint: true },
  auth: ['tool:elevation_get_profile:read'],
  input: z.object({
    path: boundedArray(PointSchema, 2, 1_000).describe(
      'Route vertices in travel order, 2–1,000 {lat, lon} objects in decimal degrees (WGS84). Consecutive duplicate vertices are ignored.',
    ),
    samples: blankAsUnset(z.number().int().min(2).max(MAX_SAMPLES).default(100)).describe(
      'Number of evenly spaced samples along the route, endpoints included (2–250, default 100). More samples catch more relief and take longer; spacing finer than the source resolution adds no detail. For a large count where only the summary matters, set include_samples to false.',
    ),
    include_samples: blankAsUnset(z.boolean().default(true)).describe(
      'Return the per-sample profile (default true). false omits samples and the sample table; the summary, spacing, coverage counts, datasets, notices, and attribution are unchanged, still computed from every sample.',
    ),
    source: SourceSchema,
  }),
  output: z.object({
    samples: z
      .array(ProfileSampleSchema)
      .optional()
      .describe(
        'Every sample in route order, endpoints included. Absent when include_samples is false.',
      ),
    summary: z
      .object({
        total_distance_m: z
          .number()
          .describe('Route length along its great-circle segments, meters.'),
        start_elevation_m: z.number().describe('Elevation of the first sample with data, meters.'),
        end_elevation_m: z.number().describe('Elevation of the last sample with data, meters.'),
        net_change_m: z.number().describe('End minus start elevation, meters.'),
        ascent_m: z.number().describe('Cumulative climb between samples with data, meters.'),
        descent_m: z
          .number()
          .describe('Cumulative drop between samples with data, meters, reported positive.'),
        ascent_ft: z.number().describe('Cumulative climb, international feet.'),
        descent_ft: z.number().describe('Cumulative drop, international feet, reported positive.'),
        min_elevation_m: z.number().describe('Lowest sampled elevation, meters.'),
        max_elevation_m: z.number().describe('Highest sampled elevation, meters.'),
        min_elevation_ft: z.number().describe('Lowest sampled elevation, international feet.'),
        max_elevation_ft: z.number().describe('Highest sampled elevation, international feet.'),
        highest_point: RoutePointSchema.describe('The highest sample (first occurrence on ties).'),
        lowest_point: RoutePointSchema.describe('The lowest sample (first occurrence on ties).'),
        max_grade_pct: z
          .number()
          .optional()
          .describe(
            'Largest grade in percent: the steepest climb, or the gentlest descent (negative) on a route that only descends. Absent with fewer than 2 samples with data.',
          ),
        max_grade_distance_m: z
          .number()
          .optional()
          .describe(
            'Distance along the route of the sample max_grade_pct leads to (first on ties), meters; the grade runs from the previous sample with data. Present with max_grade_pct.',
          ),
        min_grade_pct: z
          .number()
          .optional()
          .describe(
            'Smallest grade in percent: the steepest descent (negative), or the gentlest climb on a route that only climbs. Absent with fewer than 2 samples with data.',
          ),
        min_grade_distance_m: z
          .number()
          .optional()
          .describe(
            'Distance along the route of the sample min_grade_pct leads to (first on ties), meters; the grade runs from the previous sample with data. Present with min_grade_pct.',
          ),
      })
      .describe('Route statistics over the samples with data, bridging samples without data.'),
    sample_interval_m: z
      .number()
      .describe('Distance between consecutive samples, meters: route length / (samples − 1).'),
    vertices: z.number().int().describe('Route vertices after dropping consecutive duplicates.'),
    samples_with_data: z.number().int().describe('Samples with an elevation.'),
    missing_samples: z.number().int().describe('Samples no queried dataset answered.'),
    datasets_used: DatasetsUsedSchema,
    resolution_m_range: ResolutionRangeSchema.optional(),
    source_mode: z
      .enum(SOURCE_MODES)
      .describe('The source the call used (auto unless the caller chose one).'),
  }),
  enrichment: {
    notice: z
      .string()
      .optional()
      .describe(
        'Guidance on samples without data, routes crossing the USGS 3DEP coverage edge, Mapzen sea-floor values, and sample spacing against the source resolution.',
      ),
    attribution: z
      .string()
      .describe('Sources to credit for the returned values, one line per dataset that answered.'),
  },
  enrichmentTrailer: { attribution: { label: 'Sources' } },
  errors: [
    {
      reason: 'degenerate_path',
      code: JsonRpcErrorCode.ValidationError,
      when: 'After dropping consecutive duplicate vertices, fewer than 2 vertices remain, or the route is under 1 m long.',
      recovery:
        'The path has no usable length because its vertices are the same point or under 1 m apart. Supply vertices spanning at least 1 m, or use elevation_get_points for a single location.',
      severity: 'notice',
    },
    {
      reason: 'no_coverage',
      code: JsonRpcErrorCode.NotFound,
      when: 'No sample along the route returned an elevation.',
      recovery:
        'No sample along the route returned an elevation. If the call used source usgs_3dep or opentopodata, re-call elevation_get_profile with source auto to query both providers; under auto, no dataset this server queries covers the route, so check one vertex with elevation_get_points to confirm.',
      severity: 'notice',
    },
    {
      reason: 'usgs_unavailable',
      code: JsonRpcErrorCode.ServiceUnavailable,
      when: 'USGS 3DEP failed: a server error, rate limit, network error, or timeout that outlasted the retries (retryable), or a client error or unexpected status that retrying cannot fix (not retryable).',
      recovery:
        'USGS 3DEP did not answer or rejected the request. If the error is marked retryable, retry elevation_get_profile in a minute; either way, re-call it with source opentopodata to use SRTM and Mapzen data (about 30 m) instead.',
      thrownBy: 'service',
    },
    {
      reason: 'opentopodata_unavailable',
      code: JsonRpcErrorCode.ServiceUnavailable,
      when: 'Open Topo Data failed: a server error, network error, timeout, or unreadable response that outlasted the retries (retryable), or an unexpected status that retrying cannot fix (not retryable).',
      recovery:
        'Open Topo Data did not answer or rejected the request. If the error is marked retryable, retry elevation_get_profile in a minute; either way, re-call it with source usgs_3dep when the route lies inside USGS 3DEP coverage.',
      thrownBy: 'service',
    },
    {
      reason: 'opentopodata_rate_limited',
      code: JsonRpcErrorCode.RateLimited,
      when: 'Open Topo Data kept answering HTTP 429 through the retries, or asked for a wait over 8 s.',
      recovery:
        "Open Topo Data is refusing requests from this server's network address; its public instance allows 1 request per second and 1,000 per day per address, shared with any other client there. Retry elevation_get_profile in a few minutes, or re-call it with source usgs_3dep for routes inside USGS 3DEP coverage.",
      retryable: true,
      severity: 'warning',
      thrownBy: 'service',
    },
    {
      reason: 'opentopodata_daily_limit',
      code: JsonRpcErrorCode.RateLimited,
      when: 'This server has sent 1,000 requests to the public Open Topo Data instance in the trailing 24 hours, so no request was sent.',
      recovery:
        "This server has used the public Open Topo Data instance's 1,000 requests for the past 24 hours; capacity returns as those requests age out (see retryAfter). Re-call elevation_get_profile with source usgs_3dep for routes inside USGS 3DEP coverage, or ask the server operator to set OPENTOPODATA_BASE_URL to a self-hosted Open Topo Data instance.",
      retryable: false,
      severity: 'warning',
      thrownBy: 'service',
    },
    {
      reason: 'opentopodata_config_rejected',
      code: JsonRpcErrorCode.ConfigurationError,
      when: 'The Open Topo Data instance answered 401, 403, or 404, or a 400 naming a dataset it lacks or a location limit below 100.',
      recovery:
        "The Open Topo Data instance at OPENTOPODATA_BASE_URL refused this server's requests (wrong URL, missing srtm30m or mapzen dataset, or a per-request location limit under 100), which the server operator must fix. Meanwhile re-call elevation_get_profile with source usgs_3dep for routes inside USGS 3DEP coverage.",
      retryable: false,
      thrownBy: 'service',
    },
    {
      reason: 'sampling_deadline_exceeded',
      code: JsonRpcErrorCode.Timeout,
      when: "The call's 45 s sampling budget ran out (a retry deadline, or a wait in either provider's request queue).",
      recovery:
        'Re-call elevation_get_profile with fewer samples (each USGS 3DEP sample is its own upstream request), or split the route into shorter sections.',
      thrownBy: 'service',
    },
  ],

  async handler(input, ctx) {
    const route = resamplePath(input.path, input.samples);
    if (route.kind === 'degenerate') {
      throw ctx.fail(
        'degenerate_path',
        `After dropping consecutive duplicate vertices the path has ${countOf(route.vertices, 'distinct vertex', 'distinct vertices')} and is ${roundTo(route.total_distance_m, 2)} m long; a profile needs at least 2 distinct vertices and 1 m of length.`,
        { vertices: route.vertices, total_distance_m: roundTo(route.total_distance_m, 2) },
      );
    }

    const sampled = await getElevationSampler().sample(route.samples, input.source, ctx);
    ctx.enrich({ attribution: attributionFor(sampled) });

    const located: LocatedSample[] = sampled.map((sample, index) => ({
      ...sample,
      distance_m: route.samples[index]?.distance_m ?? 0,
    }));
    const stats = profileStats(located);
    const at = (index: number | undefined) =>
      index === undefined ? undefined : withElevation(located[index]);
    const first = at(stats.first_index);
    const last = at(stats.last_index);
    const highest = at(stats.highest_index);
    const lowest = at(stats.lowest_index);
    if (!first || !last || !highest || !lowest) {
      throw ctx.fail(
        'no_coverage',
        `None of the ${located.length} samples along the route returned an elevation (source: ${input.source}).`,
      );
    }

    const samples = located.map((sample, index): ProfileSample => {
      const grade = stats.grades_pct[index];
      return {
        distance_m: roundTo(sample.distance_m, 1),
        lat: sample.lat,
        lon: sample.lon,
        ...(sample.elevation_m !== undefined && { elevation_m: sample.elevation_m }),
        ...(grade !== undefined && { grade_pct: roundTo(grade, 1) }),
        ...(sample.dataset !== undefined && { dataset: sample.dataset }),
        ...(sample.resolution_m !== undefined && { resolution_m: sample.resolution_m }),
      };
    });
    const ascent = roundTo(stats.ascent_m, 2);
    const descent = roundTo(stats.descent_m, 2);
    const samplesWithData = samples.filter((sample) => sample.elevation_m !== undefined).length;
    const provenance = summarizeProvenance(sampled);

    const result = {
      ...(input.include_samples && { samples }),
      summary: {
        total_distance_m: roundTo(route.total_distance_m, 1),
        start_elevation_m: first.elevation_m,
        end_elevation_m: last.elevation_m,
        net_change_m: roundTo(last.elevation_m - first.elevation_m, 2),
        ascent_m: ascent,
        descent_m: descent,
        ascent_ft: metersToFeet(ascent),
        descent_ft: metersToFeet(descent),
        min_elevation_m: lowest.elevation_m,
        max_elevation_m: highest.elevation_m,
        min_elevation_ft: metersToFeet(lowest.elevation_m),
        max_elevation_ft: metersToFeet(highest.elevation_m),
        highest_point: toRoutePoint(highest),
        lowest_point: toRoutePoint(lowest),
        ...(stats.max_grade_pct !== undefined && {
          max_grade_pct: roundTo(stats.max_grade_pct, 1),
          max_grade_distance_m: roundTo(located[stats.max_grade_index ?? 0]?.distance_m ?? 0, 1),
        }),
        ...(stats.min_grade_pct !== undefined && {
          min_grade_pct: roundTo(stats.min_grade_pct, 1),
          min_grade_distance_m: roundTo(located[stats.min_grade_index ?? 0]?.distance_m ?? 0, 1),
        }),
      },
      sample_interval_m: roundTo(route.sample_interval_m, 1),
      vertices: route.vertices,
      samples_with_data: samplesWithData,
      missing_samples: samples.length - samplesWithData,
      ...provenance,
      source_mode: input.source,
    };

    const notice = buildNotice(result, samples, input.samples);
    if (notice) ctx.enrich.notice(notice);
    return result;
  },

  format: (result) => {
    const summary = result.summary;
    const describeGrade = (label: string, grade: number, at: number | undefined) =>
      `${label} ${grade}%${at === undefined ? '' : ` at ${at} m`}`;
    const grades =
      summary.max_grade_pct === undefined || summary.min_grade_pct === undefined
        ? 'not available (fewer than 2 samples with data)'
        : `${describeGrade('max', summary.max_grade_pct, summary.max_grade_distance_m)}; ${describeGrade('min', summary.min_grade_pct, summary.min_grade_distance_m)}`;
    const describePoint = (point: z.infer<typeof RoutePointSchema>) =>
      `${point.elevation_m} m at ${point.distance_m} m along the route (${point.lat}, ${point.lon})`;

    const table = result.samples
      ? [
          '| # | Dist (m) | Lat, Lon | Elev (m) | Grade (%) | Dataset | Res (m) |',
          '|--:|--:|:--|--:|--:|:--|--:|',
          ...result.samples.map((sample, index) => {
            const resolution =
              sample.resolution_m !== undefined
                ? String(sample.resolution_m)
                : sample.dataset === 'mapzen'
                  ? 'varies'
                  : '—';
            return `| ${index + 1} | ${sample.distance_m} | ${sample.lat}, ${sample.lon} | ${sample.elevation_m ?? 'no data'} | ${sample.grade_pct ?? '—'} | ${sample.dataset ?? 'no data'} | ${resolution} |`;
          }),
        ]
      : ['Per-sample rows omitted (include_samples: false).'];
    const sampleCount = result.samples_with_data + result.missing_samples;
    const text = [
      `## Route profile: ${summary.total_distance_m} m (${roundTo(summary.total_distance_m / 1_000, 2)} km)`,
      '',
      `- **Ascent / descent:** ${summary.ascent_m} m / ${summary.descent_m} m (${summary.ascent_ft} ft / ${summary.descent_ft} ft)`,
      `- **Start → end:** ${summary.start_elevation_m} m → ${summary.end_elevation_m} m (net ${signed(summary.net_change_m)} m)`,
      `- **Elevation range:** ${summary.min_elevation_m} to ${summary.max_elevation_m} m (${summary.min_elevation_ft} to ${summary.max_elevation_ft} ft)`,
      `- **Highest point:** ${describePoint(summary.highest_point)}`,
      `- **Lowest point:** ${describePoint(summary.lowest_point)}`,
      `- **Grades:** ${grades}`,
      `- **Sampling:** ${sampleCount} samples, ${result.sample_interval_m} m apart, over ${result.vertices} route vertices`,
      `- **Coverage:** ${result.samples_with_data} of ${sampleCount} samples with data (${result.missing_samples} missing)`,
      `- **Datasets:** ${formatDatasetsUsed(result.datasets_used)}; resolution ${formatResolutionRange(result.resolution_m_range)} (source: ${result.source_mode})`,
      '',
      ...table,
    ].join('\n');
    return [{ type: 'text', text }];
  },
});

interface NoticeInput {
  datasets_used: z.infer<typeof DatasetsUsedSchema>;
  missing_samples: number;
  resolution_m_range?: z.infer<typeof ResolutionRangeSchema>;
  sample_interval_m: number;
  source_mode: SourceMode;
}

/**
 * Joins the notice fragments that apply, in the design's listed order. Reads
 * the full sample list, which the result omits under `include_samples: false`.
 */
function buildNotice(
  result: NoticeInput,
  samples: readonly ProfileSample[],
  requestedSamples: number,
): string | undefined {
  const fragments: string[] = [];
  const total = samples.length;
  const missing = result.missing_samples;
  if (missing > 0) {
    const reroute =
      result.source_mode === 'auto'
        ? ''
        : ` Re-call elevation_get_profile with source auto to query both providers for the ${agree(missing, 'sample', 'samples')} without data.`;
    fragments.push(
      `${missing} of ${countOf(total, 'sample')} ${agree(missing, 'has', 'have')} no data; ascent, descent, and grades bridge those gaps and may be understated.${reroute}`,
    );
  }
  const { usgs, openTopoData } = providerSplit(result.datasets_used);
  if (usgs > 0 && openTopoData > 0) {
    fragments.push(
      `The route crosses the USGS 3DEP coverage edge (${countOf(usgs, 'sample')} from USGS 3DEP, ${openTopoData} from Open Topo Data), so ascent and descent mix 1–30 m lidar-derived values with 30 m SRTM-class values; re-call elevation_get_profile with source opentopodata for a profile from one provider.`,
    );
  }
  const seaFloor = samples.filter(
    (sample) => sample.dataset === 'mapzen' && (sample.elevation_m ?? 0) < 0,
  ).length;
  if (seaFloor > 0) {
    fragments.push(
      `${countOf(seaFloor, 'sample')} ${agree(seaFloor, 'comes', 'come')} from Mapzen with values below 0 m, which over open water are sea-floor depths; ascent, descent, and the lowest point include them.`,
    );
  }
  const range = result.resolution_m_range;
  const interval = result.sample_interval_m;
  if (range && interval < range.max_m) {
    fragments.push(
      `Samples are ${interval} m apart, closer than the ${range.max_m} m source resolution, so extra samples add no detail; re-call elevation_get_profile with fewer samples for a faster result.`,
    );
  }
  if (range && requestedSamples < MAX_SAMPLES && interval > 20 * range.min_m && interval > 30) {
    fragments.push(
      `Samples are ${interval} m apart against a ${range.min_m} m source; raise samples (up to ${MAX_SAMPLES}) or split the route to capture more relief.`,
    );
  }
  return fragments.length > 0 ? fragments.join(' ') : undefined;
}

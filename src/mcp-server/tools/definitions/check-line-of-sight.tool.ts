/**
 * @fileoverview `elevation_check_line_of_sight`: decides whether terrain
 * blocks the sightline between an observer and a target, with earth
 * curvature and refraction, and reports the limiting terrain point.
 * @module mcp-server/tools/definitions/check-line-of-sight
 */

import { tool, z } from '@cyanheads/mcp-ts-core';
import { JsonRpcErrorCode } from '@cyanheads/mcp-ts-core/errors';
import { agree, countOf } from '@/mcp-server/tools/shared/format.js';
import { blankAsUnset, PointSchema, SourceSchema } from '@/mcp-server/tools/shared/inputs.js';
import {
  DatasetsUsedSchema,
  formatDatasetsUsed,
  providerSplit,
  summarizeProvenance,
} from '@/mcp-server/tools/shared/outputs.js';
import { attributionFor } from '@/services/elevation/attribution.js';
import { getElevationSampler } from '@/services/elevation/elevation-sampler.js';
import {
  type ClearancePoint,
  EARTH_MODELS,
  effectiveEarthRadius,
  FRESNEL_CLEARANCE_FRACTION,
  FRESNEL_VERDICTS,
  type FresnelClearance,
  fresnelClearance,
  lineOfSight,
  MAX_SIGHTLINE_LENGTH_M,
  refractionCoefficient,
  resamplePath,
  type SightlineEndpoint,
  type SightlineSample,
} from '@/services/elevation/geometry.js';
import { DATASETS, type Sample, SOURCE_MODES } from '@/services/elevation/types.js';
import { METERS_PER_FOOT, roundTo } from '@/services/elevation/units.js';

/** Clearance under which a `clear` verdict carries a margin notice, meters. */
const THIN_MARGIN_M = 2;

/** Blank → unset (so the default applies); otherwise trim and lowercase. */
function normalizeEarthModel(value: unknown): unknown {
  if (value === '') return;
  return typeof value === 'string' ? value.trim().toLowerCase() : value;
}

/** Field labels only; the facts they share are stated once on `observer` at its use site. */
const EndpointSchema = z.object({
  lat: z.number().describe('Latitude.'),
  lon: z.number().describe('Longitude.'),
  ground_elevation_m: z.number().describe('Ground elevation.'),
  surface_elevation_m: z.number().describe('Surface elevation.'),
  height_above_ground_m: z.number().describe('Requested height above the surface.'),
  sightline_elevation_m: z.number().describe('Sightline elevation.'),
  dataset: z.enum(DATASETS).describe('Answering dataset.'),
  resolution_m: z.number().optional().describe('Raster resolution.'),
});

/** Field labels only; the facts they share are stated once on `limiting_point` at its use site. */
const TerrainPointSchema = z.object({
  lat: z.number().describe('Latitude.'),
  lon: z.number().describe('Longitude.'),
  distance_from_observer_m: z.number().describe('Distance from the observer.'),
  terrain_elevation_m: z.number().describe('Terrain elevation.'),
  surface_elevation_m: z.number().describe('Surface elevation.'),
  curvature_bulge_m: z.number().describe('Curvature bulge.'),
  sightline_elevation_m: z.number().describe('Sightline elevation.'),
  clearance_m: z.number().describe('Clearance.'),
  dataset: z.enum(DATASETS).describe('Answering dataset.'),
  resolution_m: z.number().optional().describe('Raster resolution.'),
});

type TerrainPoint = z.infer<typeof TerrainPointSchema>;

export const checkLineOfSightTool = tool('elevation_check_line_of_sight', {
  title: 'Check Terrain Line of Sight',
  description:
    'Check whether terrain blocks the straight sightline between an observer and a target, each at a height above the ground, accounting for earth curvature and atmospheric refraction. Returns a verdict of clear, blocked, or indeterminate (when samples along the line have no data), the minimum clearance and the terrain point that limits it, and the first obstruction from the observer when blocked. With frequency_mhz, it also reports first Fresnel zone clearance against the 60% free-space bar. Where Mapzen reports sea-floor depth over open water, clearance is measured to the sea surface; USGS 3DEP values below 0 m (bay floor in some bays, or dry land) count as received unless water_surface_m sets a water level. Models terrain only: buildings and vegetation are not modeled beyond what the elevation source itself captures, and a ridge narrower than the reported sample spacing can be missed. To see the terrain between the points, call elevation_get_profile on the same two points.',
  annotations: { readOnlyHint: true, idempotentHint: true, openWorldHint: true },
  auth: ['tool:elevation_check_line_of_sight:read'],
  input: z.object({
    observer: PointSchema.describe('Observer location as {lat, lon} in decimal degrees (WGS84).'),
    target: PointSchema.describe('Target location as {lat, lon} in decimal degrees (WGS84).'),
    observer_height_m: blankAsUnset(z.number().min(0).max(10_000).default(1.7)).describe(
      'Observer eye or antenna height above ground, meters (default 1.7, standing eye height).',
    ),
    target_height_m: blankAsUnset(z.number().min(0).max(10_000).default(0)).describe(
      'Target height above ground, meters (default 0, the ground itself). Set it for a tower, building top, or second antenna.',
    ),
    earth_model: z
      .preprocess(normalizeEarthModel, z.enum(EARTH_MODELS).default('optical'))
      .describe(
        'Earth model: flat ignores curvature; geometric applies curvature without refraction; optical applies standard visible-light refraction (coefficient 0.13, default); radio applies the standard 4/3-earth radio refraction (coefficient 0.25).',
      ),
    samples: blankAsUnset(z.number().int().min(3).max(250).default(100)).describe(
      'Evenly spaced terrain samples along the line, endpoints included (3–250, default 100). Spacing is reported; a ridge narrower than it can be missed.',
    ),
    water_surface_m: blankAsUnset(z.number().min(-500).max(9_000).optional()).describe(
      "Water level in meters (-500 to 9,000). When set, each sample's surface, endpoints included, is the higher of its elevation and this level, replacing the default that lifts only Mapzen sea-floor values to 0 m. Set it where the line crosses water: 0 where USGS 3DEP reports a bay floor, or a lake or tide level.",
    ),
    frequency_mhz: blankAsUnset(z.number().min(30).max(300_000).optional()).describe(
      'Radio frequency in MHz (30–300,000; 5800 for 5.8 GHz). When set, the result adds first Fresnel zone clearance against the 60% free-space bar; pair it with earth_model radio.',
    ),
    source: SourceSchema,
  }),
  output: z.object({
    verdict: z
      .enum(['clear', 'blocked', 'indeterminate'])
      .describe(
        'blocked when terrain reaches the sightline at any sample; clear when every sample between the endpoints has data and lies below it; indeterminate when samples without data leave the line unconfirmed.',
      ),
    distance_m: z.number().describe('Great-circle distance from observer to target, meters.'),
    observer: EndpointSchema.describe(
      "The observer's end of the sightline, in decimal degrees and meters. Ground elevation is as the dataset reports it; surface is the higher of the ground and water_surface_m when set, otherwise the ground, or 0 where a Mapzen value below 0 marks open water; sightline = surface + height. resolution_m is absent for mapzen.",
    ),
    target: EndpointSchema.describe("The target's end of the sightline; fields as on observer."),
    min_clearance_m: z
      .number()
      .optional()
      .describe(
        'Smallest clearance over samples between the endpoints, meters (negative means terrain above the sightline). Absent when none of them has data.',
      ),
    min_clearance_ft: z
      .number()
      .optional()
      .describe('Smallest clearance in international feet. Absent with min_clearance_m.'),
    limiting_point: TerrainPointSchema.optional().describe(
      'The sample between the endpoints with the smallest clearance (first on ties); absent when none of them has data. Units, surface, and resolution_m as on observer, with terrain in place of its ground; bulge is the rise of the curved surface above the straight observer-target chord (0 for flat); clearance = sightline − (surface + bulge), and 0 or below means blocked.',
    ),
    first_obstruction: TerrainPointSchema.optional().describe(
      'The obstructing sample nearest the observer; present only when the verdict is blocked. Fields as on limiting_point.',
    ),
    obstructed_samples: z
      .number()
      .int()
      .describe('Samples between the endpoints with clearance 0 or below.'),
    fresnel: z
      .object({
        frequency_mhz: z.number().describe('Frequency evaluated.'),
        verdict: z
          .enum(FRESNEL_VERDICTS)
          .describe(
            'sufficient when every sample between the endpoints has data and clears at least 0.6 of the zone radius; insufficient when any sample with data clears less, terrain blocking the line included; indeterminate when samples without data leave it unconfirmed.',
          ),
        min_clearance_ratio: z
          .number()
          .optional()
          .describe(
            'Smallest clearance_m / zone radius over samples between the endpoints. Absent when none of them has data.',
          ),
        limiting_point: TerrainPointSchema.extend({
          fresnel_radius_m: z.number().describe('Zone radius.'),
        })
          .optional()
          .describe(
            'The sample with the smallest ratio (first on ties), often not limiting_point; absent with min_clearance_ratio. Fields as on limiting_point, plus the zone radius there.',
          ),
      })
      .optional()
      .describe(
        'First Fresnel zone clearance; present only when frequency_mhz is set. Zone radius = √(λ·d₁·d₂/D) m, with λ = 299.792458 / frequency_mhz, d₁ and d₂ the distances to each end, and D the line length.',
      ),
    earth_model: z.enum(EARTH_MODELS).describe('The earth model applied.'),
    refraction_coefficient: z
      .number()
      .optional()
      .describe('Refraction coefficient applied. Absent for the flat model.'),
    effective_earth_radius_m: z
      .number()
      .optional()
      .describe(
        'Earth radius divided by (1 − refraction coefficient), meters. Absent for the flat model.',
      ),
    sample_interval_m: z.number().describe('Distance between consecutive samples, meters.'),
    samples: z.number().int().describe('Samples along the line, endpoints included.'),
    samples_with_data: z.number().int().describe('Samples with an elevation, endpoints included.'),
    missing_samples: z.number().int().describe('Samples no queried dataset answered.'),
    datasets_used: DatasetsUsedSchema,
    source_mode: z
      .enum(SOURCE_MODES)
      .describe('The source the call used (auto unless the caller chose one).'),
  }),
  enrichment: {
    notice: z
      .string()
      .optional()
      .describe(
        'Guidance on unconfirmed sightlines, thin clearance margins, a clear line short of 60% first Fresnel zone clearance, lines crossing the USGS 3DEP coverage edge, samples over open water or below water_surface_m, and USGS 3DEP values below 0 m.',
      ),
    attribution: z
      .string()
      .describe('Sources to credit for the returned values, one line per dataset that answered.'),
  },
  enrichmentTrailer: { attribution: { label: 'Sources' } },
  errors: [
    {
      reason: 'same_endpoints',
      code: JsonRpcErrorCode.ValidationError,
      when: 'Observer and target are under 1 m apart.',
      recovery:
        'Observer and target are the same point or under 1 m apart. Move one so the two points are at least a meter apart, or use elevation_get_points for a single location.',
      severity: 'notice',
    },
    {
      reason: 'sightline_too_long',
      code: JsonRpcErrorCode.ValidationError,
      when: 'Observer and target are more than 1,000 km apart.',
      recovery:
        'Observer and target are more than 1,000 km apart, past the longest sightline this tool evaluates. Re-call elevation_check_line_of_sight with points under 1,000 km apart, or call elevation_get_profile on the same two points for the terrain along a longer route.',
      severity: 'notice',
    },
    {
      reason: 'endpoint_no_data',
      code: JsonRpcErrorCode.NotFound,
      when: "The observer's or target's own sample has no data, so its sightline height is unknown.",
      recovery:
        'The observer or target has no elevation data in any queried dataset. If the call used source usgs_3dep or opentopodata, re-call elevation_check_line_of_sight with source auto to query both providers; under auto, no dataset this server queries covers that endpoint, so check it with elevation_get_points to confirm.',
      severity: 'notice',
    },
    {
      reason: 'usgs_unavailable',
      code: JsonRpcErrorCode.ServiceUnavailable,
      when: 'USGS 3DEP failed: a server error, rate limit, network error, or timeout that outlasted the retries (retryable), or a client error or unexpected status that retrying cannot fix (not retryable).',
      recovery:
        'USGS 3DEP did not answer or rejected the request. If the error is marked retryable, retry elevation_check_line_of_sight in a minute; either way, re-call it with source opentopodata to use SRTM and Mapzen data (about 30 m) instead.',
      thrownBy: 'service',
    },
    {
      reason: 'opentopodata_unavailable',
      code: JsonRpcErrorCode.ServiceUnavailable,
      when: 'Open Topo Data failed: a server error, network error, timeout, or unreadable response that outlasted the retries (retryable), or an unexpected status that retrying cannot fix (not retryable).',
      recovery:
        'Open Topo Data did not answer or rejected the request. If the error is marked retryable, retry elevation_check_line_of_sight in a minute; either way, re-call it with source usgs_3dep when both points lie inside USGS 3DEP coverage.',
      thrownBy: 'service',
    },
    {
      reason: 'opentopodata_rate_limited',
      code: JsonRpcErrorCode.RateLimited,
      when: 'Open Topo Data kept answering HTTP 429 through the retries, or asked for a wait over 8 s.',
      recovery:
        "Open Topo Data is refusing this server's requests as rate limited. The public instance allows 1 request per second and 1,000 per day per network address, shared with any other client at that address; a self-hosted instance sets its own limits. Retry elevation_check_line_of_sight in a few minutes, or re-call it with source usgs_3dep for lines inside USGS 3DEP coverage.",
      retryable: true,
      severity: 'warning',
      thrownBy: 'service',
    },
    {
      reason: 'opentopodata_daily_limit',
      code: JsonRpcErrorCode.RateLimited,
      when: 'Only on the public Open Topo Data instance: this server has sent it 1,000 requests in the trailing 24 hours, so no request was sent.',
      recovery:
        "This server has used the public Open Topo Data instance's 1,000 requests for the past 24 hours; capacity returns as those requests age out (see retryAfter). Re-call elevation_check_line_of_sight with source usgs_3dep for lines inside USGS 3DEP coverage, or ask the server operator to set OPENTOPODATA_BASE_URL to a self-hosted Open Topo Data instance.",
      retryable: false,
      severity: 'warning',
      thrownBy: 'service',
    },
    {
      reason: 'opentopodata_config_rejected',
      code: JsonRpcErrorCode.ConfigurationError,
      when: 'The Open Topo Data instance answered 401, 403, or 404, a redirect from a self-hosted instance, a 400 naming a dataset it lacks or a location limit below 100, or a 200 naming a dataset this server did not request.',
      recovery:
        "The Open Topo Data instance at OPENTOPODATA_BASE_URL cannot serve this server's requests (a wrong or redirecting URL, a missing or misconfigured srtm30m or mapzen dataset, or a per-request location limit under 100), which the server operator must fix. Meanwhile re-call elevation_check_line_of_sight with source usgs_3dep for lines inside USGS 3DEP coverage.",
      retryable: false,
      thrownBy: 'service',
    },
    {
      reason: 'sampling_deadline_exceeded',
      code: JsonRpcErrorCode.Timeout,
      when: "The call's 45 s sampling budget ran out (a retry deadline, or a wait in either provider's request queue), or the USGS 3DEP lookups other calls had queued, plus this call's, would not drain within the calls' budgets, so it sent none and data.retryAfter gives the seconds until the queued lookups drain.",
      recovery:
        'If the budget ran out waiting on USGS 3DEP, re-call elevation_check_line_of_sight with fewer samples, since each 3DEP sample is its own upstream request, or, when the error carries retryAfter (other calls held 3DEP), retry it after that many seconds; if it ran out waiting on Open Topo Data, retry in a minute, or re-call it with source usgs_3dep for a line inside USGS 3DEP coverage.',
      thrownBy: 'service',
    },
  ],

  async handler(input, ctx) {
    const line = resamplePath([input.observer, input.target], input.samples);
    if (line.kind === 'degenerate') {
      throw ctx.fail(
        'same_endpoints',
        `Observer and target are ${roundTo(line.total_distance_m, 2)} m apart; a sightline needs at least 1 m.`,
        { distance_m: roundTo(line.total_distance_m, 2) },
      );
    }
    if (line.total_distance_m > MAX_SIGHTLINE_LENGTH_M) {
      throw ctx.fail(
        'sightline_too_long',
        `Observer and target are ${roundTo(line.total_distance_m / 1_000, 3)} km apart; a sightline can be at most 1,000 km.`,
        { distance_m: roundTo(line.total_distance_m, 1) },
      );
    }

    const sampled = await getElevationSampler().sample(line.samples, input.source, ctx);
    ctx.enrich({ attribution: attributionFor(sampled) });

    const los = lineOfSight({
      distance_m: line.total_distance_m,
      earth_model: input.earth_model,
      observer_height_m: input.observer_height_m,
      target_height_m: input.target_height_m,
      water_surface_m: input.water_surface_m,
      samples: sampled.map((sample, index) =>
        toSightlineSample(sample, line.samples[index]?.distance_m ?? 0),
      ),
    });
    if (los.kind === 'endpoint_no_data') {
      const which =
        los.observer_missing && los.target_missing
          ? 'Neither the observer nor the target has'
          : los.observer_missing
            ? 'The observer has no'
            : 'The target has no';
      throw ctx.fail(
        'endpoint_no_data',
        `${which} elevation data in any queried dataset (source: ${input.source}), so the sightline height there is unknown.`,
        { observer_missing: los.observer_missing, target_missing: los.target_missing },
      );
    }

    const samplesWithData = sampled.filter((sample) => sample.elevation_m !== undefined).length;
    const kappa = refractionCoefficient(input.earth_model);
    const radius = effectiveEarthRadius(input.earth_model);
    const fresnel =
      input.frequency_mhz === undefined
        ? undefined
        : toFresnelResult(
            fresnelClearance({
              clearances: los.clearances,
              distance_m: line.total_distance_m,
              frequency_mhz: input.frequency_mhz,
              missing_interior: los.missing_interior,
            }),
            input.frequency_mhz,
          );
    const result = {
      verdict: los.verdict,
      distance_m: roundTo(line.total_distance_m, 1),
      observer: toEndpointResult(los.observer, input.observer_height_m),
      target: toEndpointResult(los.target, input.target_height_m),
      ...(los.limiting && {
        min_clearance_m: roundKeepingSide(los.limiting.clearance_m, 2, 0, 'above'),
        min_clearance_ft: roundKeepingSide(
          los.limiting.clearance_m / METERS_PER_FOOT,
          1,
          0,
          'above',
        ),
        limiting_point: toTerrainPoint(los.limiting),
      }),
      ...(los.first_obstruction && { first_obstruction: toTerrainPoint(los.first_obstruction) }),
      obstructed_samples: los.obstructed_samples,
      ...(fresnel && { fresnel }),
      earth_model: input.earth_model,
      ...(kappa !== undefined && { refraction_coefficient: kappa }),
      ...(radius !== undefined && { effective_earth_radius_m: roundTo(radius, 1) }),
      sample_interval_m: roundTo(line.sample_interval_m, 1),
      samples: sampled.length,
      samples_with_data: samplesWithData,
      missing_samples: sampled.length - samplesWithData,
      datasets_used: summarizeProvenance(sampled).datasets_used,
      source_mode: input.source,
    };

    const fragments: string[] = [];
    if (los.verdict === 'indeterminate') {
      const reroute =
        input.source === 'auto'
          ? ''
          : ', or re-call elevation_check_line_of_sight with source auto to query both providers';
      fragments.push(
        `${countOf(los.missing_interior, 'interior sample')} ${agree(los.missing_interior, 'has', 'have')} no data and no sample with data blocks the line, so the sightline cannot be confirmed clear; check the gap with elevation_get_profile on the same two points${reroute}.`,
      );
    }
    if (los.verdict === 'clear' && los.limiting && los.limiting.clearance_m < THIN_MARGIN_M) {
      fragments.push(
        `Minimum clearance is under ${THIN_MARGIN_M} m at ${roundTo(los.limiting.distance_m, 1)} m from the observer; DEM vertical error, vegetation, and structures can close a margin that small.`,
      );
    }
    if (los.verdict === 'clear' && fresnel?.verdict === 'insufficient' && fresnel.limiting_point) {
      fragments.push(
        `The sightline clears the terrain but not 60% of the first Fresnel zone at ${fresnel.frequency_mhz} MHz: at ${fresnel.limiting_point.distance_from_observer_m} m from the observer it clears ${fresnel.min_clearance_ratio} of the zone's ${fresnel.limiting_point.fresnel_radius_m} m radius, so expect diffraction loss.`,
      );
    }
    const { usgs, openTopoData } = providerSplit(result.datasets_used);
    if (usgs > 0 && openTopoData > 0) {
      fragments.push(
        `The line crosses the USGS 3DEP coverage edge (${countOf(usgs, 'sample')} from USGS 3DEP, ${openTopoData} from Open Topo Data); clearances compare terrain of different resolution and surface model.`,
      );
    }
    const raised = los.sea_surface_samples;
    if (raised > 0) {
      const samplesLie = `${countOf(raised, 'sample')} ${agree(raised, 'lies', 'lie')}`;
      fragments.push(
        input.water_surface_m === undefined
          ? `${samplesLie} over open water, where Mapzen reports sea-floor depth, so clearance there is measured to the sea surface at 0 m.`
          : `${samplesLie} below the ${input.water_surface_m} m water surface set by water_surface_m, so clearance there is measured to it.`,
      );
    }
    const belowZero = los.usgs_below_zero_samples;
    if (input.water_surface_m === undefined && belowZero > 0) {
      fragments.push(
        `${countOf(belowZero, 'USGS 3DEP sample')} ${agree(belowZero, 'lies', 'lie')} below 0 m and ${agree(belowZero, 'is', 'are')} measured as received: bay-floor bathymetry where 3DEP carries it, or land or water below sea level. If the line crosses water, re-call elevation_check_line_of_sight with water_surface_m set to the water level.`,
      );
    }
    if (fragments.length > 0) ctx.enrich.notice(fragments.join(' '));

    return result;
  },

  format: (result) => {
    const describeEndpoint = (label: string, endpoint: z.infer<typeof EndpointSchema>) =>
      `- **${label}:** ${endpoint.lat}, ${endpoint.lon}; ground ${endpoint.ground_elevation_m} m, surface ${endpoint.surface_elevation_m} m, height ${endpoint.height_above_ground_m} m above it, sightline ${endpoint.sightline_elevation_m} m (${endpoint.dataset}, resolution ${endpoint.resolution_m === undefined ? 'varies' : `${endpoint.resolution_m} m`})`;
    const describePoint = (label: string, point: TerrainPoint, extra = '') =>
      `- **${label}:** ${point.lat}, ${point.lon} at ${point.distance_from_observer_m} m from the observer; terrain ${point.terrain_elevation_m} m, surface ${point.surface_elevation_m} m, curvature bulge ${point.curvature_bulge_m} m, sightline ${point.sightline_elevation_m} m, clearance ${point.clearance_m} m${extra} (${point.dataset}, resolution ${point.resolution_m === undefined ? 'varies' : `${point.resolution_m} m`})`;

    const lines = [
      `## Line of sight: ${result.verdict}`,
      '',
      describeEndpoint('Observer', result.observer),
      describeEndpoint('Target', result.target),
      `- **Distance:** ${result.distance_m} m (${roundTo(result.distance_m / 1_000, 2)} km)`,
      result.min_clearance_m === undefined
        ? '- **Minimum clearance:** not measured (no sample between the endpoints has data)'
        : `- **Minimum clearance:** ${result.min_clearance_m} m (${result.min_clearance_ft} ft)`,
    ];
    if (result.limiting_point) lines.push(describePoint('Limiting point', result.limiting_point));
    if (result.first_obstruction) {
      lines.push(describePoint('First obstruction', result.first_obstruction));
    }
    lines.push(`- **Obstructed samples:** ${result.obstructed_samples}`);
    const { fresnel } = result;
    if (fresnel) {
      lines.push(
        `- **Fresnel zone at ${fresnel.frequency_mhz} MHz:** ${fresnel.verdict} against the 60% free-space bar; ${
          fresnel.min_clearance_ratio === undefined
            ? 'clearance ratio not measured (no sample between the endpoints has data)'
            : `minimum clearance ratio ${fresnel.min_clearance_ratio}`
        }`,
      );
      if (fresnel.limiting_point) {
        lines.push(
          describePoint(
            'Fresnel limiting point',
            fresnel.limiting_point,
            `, first Fresnel zone radius ${fresnel.limiting_point.fresnel_radius_m} m`,
          ),
        );
      }
    }
    lines.push(
      `- **Earth model:** ${result.earth_model}${
        result.refraction_coefficient === undefined
          ? ' (no curvature)'
          : ` (refraction coefficient ${result.refraction_coefficient}, effective earth radius ${result.effective_earth_radius_m ?? 'n/a'} m)`
      }`,
      `- **Sampling:** ${result.samples} samples, ${result.sample_interval_m} m apart; ${result.samples_with_data} with data, ${result.missing_samples} missing`,
      `- **Datasets:** ${formatDatasetsUsed(result.datasets_used)} (source: ${result.source_mode})`,
    );
    return [{ type: 'text', text: lines.join('\n') }];
  },
});

/** A sampler result as a sightline sample: elevation and dataset travel together. */
function toSightlineSample(sample: Sample, distance_m: number): SightlineSample {
  const base = {
    lat: sample.lat,
    lon: sample.lon,
    distance_m,
    ...(sample.resolution_m !== undefined && { resolution_m: sample.resolution_m }),
  };
  return sample.elevation_m !== undefined && sample.dataset !== undefined
    ? { ...base, elevation_m: sample.elevation_m, dataset: sample.dataset }
    : base;
}

function toEndpointResult(endpoint: SightlineEndpoint, height_m: number) {
  return {
    lat: endpoint.lat,
    lon: endpoint.lon,
    ground_elevation_m: endpoint.ground_elevation_m,
    surface_elevation_m: endpoint.surface_elevation_m,
    height_above_ground_m: height_m,
    sightline_elevation_m: roundTo(endpoint.sightline_elevation_m, 2),
    dataset: endpoint.dataset,
    ...(endpoint.resolution_m !== undefined && { resolution_m: endpoint.resolution_m }),
  };
}

/**
 * `value` rounded to `decimals` for display, except that a value strictly on
 * `side` of a verdict's `bar` never rounds onto or past it: it shows at least
 * one step beyond the bar on that side. `side` is the side the bar itself does
 * not belong to: above for the 0 m clearance bar (0 is blocked), below for the
 * Fresnel ratio bar (the bar is sufficient). Values on the bar's own side round
 * as usual.
 */
function roundKeepingSide(
  value: number,
  decimals: number,
  bar: number,
  side: 'above' | 'below',
): number {
  const rounded = roundTo(value, decimals);
  const step = 10 ** -decimals;
  if (side === 'above' && value > bar) return Math.max(rounded, roundTo(bar + step, decimals));
  if (side === 'below' && value < bar) return Math.min(rounded, roundTo(bar - step, decimals));
  return rounded;
}

/** The output's `fresnel` object: ratio and radius to 2 decimals, the verdict from unrounded ratios. */
function toFresnelResult(fresnel: FresnelClearance, frequency_mhz: number) {
  return {
    frequency_mhz,
    verdict: fresnel.verdict,
    ...(fresnel.limiting && {
      min_clearance_ratio: roundKeepingSide(
        fresnel.limiting.clearance_ratio,
        2,
        FRESNEL_CLEARANCE_FRACTION,
        'below',
      ),
      limiting_point: {
        ...toTerrainPoint(fresnel.limiting),
        fresnel_radius_m: roundTo(fresnel.limiting.fresnel_radius_m, 2),
      },
    }),
  };
}

function toTerrainPoint(point: ClearancePoint): TerrainPoint {
  return {
    lat: point.lat,
    lon: point.lon,
    distance_from_observer_m: roundTo(point.distance_m, 1),
    terrain_elevation_m: point.terrain_elevation_m,
    surface_elevation_m: point.surface_elevation_m,
    curvature_bulge_m: roundTo(point.curvature_bulge_m, 2),
    sightline_elevation_m: roundTo(point.sightline_elevation_m, 2),
    clearance_m: roundKeepingSide(point.clearance_m, 2, 0, 'above'),
    dataset: point.dataset,
    ...(point.resolution_m !== undefined && { resolution_m: point.resolution_m }),
  };
}

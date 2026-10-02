/**
 * @fileoverview Pure terrain geometry for the computed tools: great-circle
 * distance and interpolation, path resampling, profile statistics, grid
 * nodes, terrain line of sight with earth curvature and refraction, and first
 * Fresnel zone clearance. No I/O; every function is deterministic.
 * @module services/elevation/geometry
 */

import type { Dataset, LatLon } from './types.js';
import { EARTH_RADIUS_M, METERS_PER_DEGREE, roundTo, SPEED_OF_LIGHT_M_PER_US } from './units.js';

const toRadians = (degrees: number) => (degrees * Math.PI) / 180;
const toDegrees = (radians: number) => (radians * 180) / Math.PI;

/** Great-circle distance in meters between two points (haversine on the mean sphere). */
export function haversineDistance(a: LatLon, b: LatLon): number {
  const phiA = toRadians(a.lat);
  const phiB = toRadians(b.lat);
  const sinHalfDeltaPhi = Math.sin((phiB - phiA) / 2);
  const sinHalfDeltaLambda = Math.sin(toRadians(b.lon - a.lon) / 2);
  const h =
    sinHalfDeltaPhi * sinHalfDeltaPhi +
    Math.cos(phiA) * Math.cos(phiB) * sinHalfDeltaLambda * sinHalfDeltaLambda;
  return 2 * EARTH_RADIUS_M * Math.asin(Math.min(1, Math.sqrt(h)));
}

type Vector = readonly [number, number, number];

function toVector({ lat, lon }: LatLon): Vector {
  const phi = toRadians(lat);
  const lambda = toRadians(lon);
  return [Math.cos(phi) * Math.cos(lambda), Math.cos(phi) * Math.sin(lambda), Math.sin(phi)];
}

function toLatLon([x, y, z]: Vector): LatLon {
  return { lat: toDegrees(Math.atan2(z, Math.hypot(x, y))), lon: toDegrees(Math.atan2(y, x)) };
}

/**
 * The point `fraction` (0–1) of the way from `a` to `b` along their great
 * circle (spherical linear interpolation). Longitude comes back in
 * [−180, 180]. Returns `a` or `b` exactly at the ends and `a` when the two
 * points coincide.
 */
export function interpolateGreatCircle(a: LatLon, b: LatLon, fraction: number): LatLon {
  if (fraction <= 0) return { lat: a.lat, lon: a.lon };
  if (fraction >= 1) return { lat: b.lat, lon: b.lon };
  const delta = haversineDistance(a, b) / EARTH_RADIUS_M;
  if (delta < 1e-12) return { lat: a.lat, lon: a.lon };
  const va = toVector(a);
  const vb = toVector(b);
  const sinDelta = Math.sin(delta);
  const wa = Math.sin((1 - fraction) * delta) / sinDelta;
  const wb = Math.sin(fraction * delta) / sinDelta;
  return toLatLon([wa * va[0] + wb * vb[0], wa * va[1] + wb * vb[1], wa * va[2] + wb * vb[2]]);
}

/** Drops each vertex equal to its predecessor after rounding both coordinates to 6 decimals. */
export function dropConsecutiveDuplicates(path: readonly LatLon[]): LatLon[] {
  const kept: LatLon[] = [];
  for (const vertex of path) {
    const previous = kept.at(-1);
    if (
      previous &&
      roundTo(previous.lat, 6) === roundTo(vertex.lat, 6) &&
      roundTo(previous.lon, 6) === roundTo(vertex.lon, 6)
    ) {
      continue;
    }
    kept.push({ lat: vertex.lat, lon: vertex.lon });
  }
  return kept;
}

/** A resampled location and its cumulative distance in meters from the first vertex. */
export interface PathSample extends LatLon {
  distance_m: number;
}

/**
 * The outcome of {@link resamplePath}. `degenerate` means fewer than 2
 * distinct vertices remain after dropping consecutive duplicates, or the
 * route is under 1 m long.
 */
export type PathResampling =
  | { kind: 'degenerate'; total_distance_m: number; vertices: number }
  | {
      kind: 'ok';
      sample_interval_m: number;
      /** `count` samples in route order; the first is the first vertex, the last the last vertex. */
      samples: PathSample[];
      total_distance_m: number;
      vertices: number;
    };

/** Shortest route, in meters, that can be resampled. */
export const MIN_PATH_LENGTH_M = 1;

/**
 * Places `count` (≥ 2) evenly spaced samples along a polyline, endpoints
 * included: sample i sits at distance i·L/(count−1) on the great circle of
 * the segment containing it. Intermediate vertices are not forced into the
 * sample set. Distances are unrounded.
 */
export function resamplePath(path: readonly LatLon[], count: number): PathResampling {
  const vertices = dropConsecutiveDuplicates(path);
  const cumulative = [0];
  for (let k = 0; k + 1 < vertices.length; k++) {
    cumulative.push(
      (cumulative[k] ?? 0) + haversineDistance(vertices[k] as LatLon, vertices[k + 1] as LatLon),
    );
  }
  const total = cumulative.at(-1) ?? 0;
  const first = vertices[0];
  const last = vertices.at(-1);
  if (vertices.length < 2 || total < MIN_PATH_LENGTH_M || !first || !last) {
    return { kind: 'degenerate', total_distance_m: total, vertices: vertices.length };
  }

  const interval = total / (count - 1);
  const samples: PathSample[] = [{ lat: first.lat, lon: first.lon, distance_m: 0 }];
  let segment = 0;
  for (let i = 1; i < count - 1; i++) {
    const target = i * interval;
    while (segment < vertices.length - 2 && (cumulative[segment + 1] ?? total) < target) segment++;
    const start = cumulative[segment] ?? 0;
    const length = (cumulative[segment + 1] ?? total) - start;
    const point =
      length > 0
        ? interpolateGreatCircle(
            vertices[segment] as LatLon,
            vertices[segment + 1] as LatLon,
            (target - start) / length,
          )
        : (vertices[segment] as LatLon);
    samples.push({ lat: point.lat, lon: point.lon, distance_m: target });
  }
  samples.push({ lat: last.lat, lon: last.lon, distance_m: total });

  return {
    kind: 'ok',
    sample_interval_m: interval,
    samples,
    total_distance_m: total,
    vertices: vertices.length,
  };
}

/** A profile sample as {@link profileStats} reads it. */
export interface ProfileInput {
  distance_m: number;
  elevation_m?: number | undefined;
}

/**
 * Route statistics over the samples with data, in route order, bridging
 * gaps: each consecutive pair (p, q) of samples with data contributes
 * Δe = e_q − e_p to ascent (when positive) or descent (when negative, summed
 * as a positive number), and grade 100·Δe/Δd to sample q. Raw sums, no
 * smoothing. Index fields name positions in the input; ties resolve to the
 * first occurrence. Undefined fields mean too few samples with data.
 */
export interface ProfileStats {
  ascent_m: number;
  descent_m: number;
  /** Index of the first sample with data. */
  first_index?: number;
  /** Index-aligned: grade in percent from the previous sample with data; undefined on the first sample with data and on samples without data. */
  grades_pct: (number | undefined)[];
  /** Index of the first sample holding the maximum elevation. */
  highest_index?: number;
  /** Index of the last sample with data. */
  last_index?: number;
  /** Index of the first sample holding the minimum elevation. */
  lowest_index?: number;
  /** Index of the sample carrying {@link ProfileStats.max_grade_pct} (first on ties). */
  max_grade_index?: number;
  /** Steepest climb, percent; undefined with fewer than 2 samples with data. */
  max_grade_pct?: number;
  /** Index of the sample carrying {@link ProfileStats.min_grade_pct} (first on ties). */
  min_grade_index?: number;
  /** Steepest descent (most negative grade), percent; undefined with fewer than 2 samples with data. */
  min_grade_pct?: number;
}

/** Computes {@link ProfileStats} over samples in route order. */
export function profileStats(samples: readonly ProfileInput[]): ProfileStats {
  const stats: ProfileStats = {
    ascent_m: 0,
    descent_m: 0,
    grades_pct: samples.map(() => undefined),
  };
  let previous: { distance_m: number; elevation_m: number } | undefined;
  let highest = Number.NEGATIVE_INFINITY;
  let lowest = Number.POSITIVE_INFINITY;
  samples.forEach((sample, index) => {
    const elevation = sample.elevation_m;
    if (elevation === undefined) return;
    stats.first_index ??= index;
    stats.last_index = index;
    if (elevation > highest) {
      highest = elevation;
      stats.highest_index = index;
    }
    if (elevation < lowest) {
      lowest = elevation;
      stats.lowest_index = index;
    }
    if (previous) {
      const deltaElevation = elevation - previous.elevation_m;
      const grade = (100 * deltaElevation) / (sample.distance_m - previous.distance_m);
      stats.grades_pct[index] = grade;
      if (deltaElevation > 0) stats.ascent_m += deltaElevation;
      else stats.descent_m -= deltaElevation;
      if (stats.max_grade_pct === undefined || grade > stats.max_grade_pct) {
        stats.max_grade_pct = grade;
        stats.max_grade_index = index;
      }
      if (stats.min_grade_pct === undefined || grade < stats.min_grade_pct) {
        stats.min_grade_pct = grade;
        stats.min_grade_index = index;
      }
    }
    previous = { distance_m: sample.distance_m, elevation_m: elevation };
  });
  return stats;
}

/** A bounding box in decimal degrees; `south < north` and `west < east`. */
export interface GridBox {
  east: number;
  north: number;
  south: number;
  west: number;
}

/** Grid node placement from {@link gridNodes}. */
export interface GridNodes {
  /** East-west node spacing in meters at the box's center latitude. */
  col_spacing_m: number;
  /** Row latitudes, north to south; row 0 is `north`, the last is `south`. */
  latitudes_deg: number[];
  /** Column longitudes, west to east; column 0 is `west`, the last is `east`. */
  longitudes_deg: number[];
  /** Every node in row-major order (row 0 west to east, then row 1, …). */
  nodes: LatLon[];
  /** North-south node spacing in meters. */
  row_spacing_m: number;
}

/** Evenly spaced, edge-inclusive grid nodes over a box: `rows` and `cols` are each ≥ 2. */
export function gridNodes(box: GridBox, rows: number, cols: number): GridNodes {
  const latStep = (box.north - box.south) / (rows - 1);
  const lonStep = (box.east - box.west) / (cols - 1);
  const latitudes_deg = Array.from({ length: rows }, (_, r) =>
    r === rows - 1 ? box.south : box.north - r * latStep,
  );
  const longitudes_deg = Array.from({ length: cols }, (_, c) =>
    c === cols - 1 ? box.east : box.west + c * lonStep,
  );
  const centerLat = (box.north + box.south) / 2;
  return {
    col_spacing_m: lonStep * METERS_PER_DEGREE * Math.cos(toRadians(centerLat)),
    latitudes_deg,
    longitudes_deg,
    nodes: latitudes_deg.flatMap((lat) => longitudes_deg.map((lon) => ({ lat, lon }))),
    row_spacing_m: latStep * METERS_PER_DEGREE,
  };
}

/** How the line of sight treats the earth's surface. */
export type EarthModel = 'flat' | 'geometric' | 'optical' | 'radio';

/** Every earth model, in the order the input advertises them. */
export const EARTH_MODELS = [
  'flat',
  'geometric',
  'optical',
  'radio',
] as const satisfies readonly EarthModel[];

/** Every first Fresnel zone verdict, in the order the output advertises them; none reads as the geometric verdict's clear or blocked. */
export const FRESNEL_VERDICTS = ['sufficient', 'insufficient', 'indeterminate'] as const;

/** Refraction coefficient κ per curved model: none, standard visible light, standard 4/3-earth radio. */
export const REFRACTION_COEFFICIENTS: Readonly<Record<Exclude<EarthModel, 'flat'>, number>> = {
  geometric: 0,
  optical: 0.13,
  radio: 0.25,
};

/** κ for the model; undefined for `flat`. */
export function refractionCoefficient(model: EarthModel): number | undefined {
  return model === 'flat' ? undefined : REFRACTION_COEFFICIENTS[model];
}

/** Effective earth radius R/(1 − κ) in meters; undefined for `flat`. */
export function effectiveEarthRadius(model: EarthModel): number | undefined {
  const kappa = refractionCoefficient(model);
  return kappa === undefined ? undefined : EARTH_RADIUS_M / (1 - kappa);
}

/**
 * Longest sightline, in meters, that line of sight evaluates. At this length
 * the parabolic {@link curvatureBulge} overstates the true arc height above the
 * chord by about 10 m at the midpoint (D⁴/(384·R³) with κ = 0, less with
 * refraction), against a bulge of about 19.6 km; past it the error grows with
 * D⁴, and near the antipode the bulge is meaningless.
 */
export const MAX_SIGHTLINE_LENGTH_M = 1_000_000;

/**
 * How far the curved surface rises above the straight chord between the
 * endpoints, in meters, at `distance_m` along a line `total_m` long:
 * d·(D − d) / (2·R_eff). 0 for `flat`. The parabolic approximation holds for
 * lines much shorter than the earth's radius.
 */
export function curvatureBulge(distance_m: number, total_m: number, model: EarthModel): number {
  const radius = effectiveEarthRadius(model);
  return radius === undefined ? 0 : (distance_m * (total_m - distance_m)) / (2 * radius);
}

/**
 * The surface a sightline must clear. With a caller-set `water_surface_m`,
 * the higher of the elevation and that level, whatever the dataset. Without
 * one, 0 m over a Mapzen value below 0 m (open water, where Mapzen reports the
 * sea floor), otherwise the elevation as received.
 */
export function surfaceElevation(
  elevation_m: number,
  dataset: Dataset | undefined,
  water_surface_m?: number,
): number {
  if (water_surface_m !== undefined) return Math.max(elevation_m, water_surface_m);
  return dataset === 'mapzen' && elevation_m < 0 ? 0 : elevation_m;
}

/**
 * A terrain sample on the sightline, observer at index 0 and target at the
 * last index. A sample with data carries its elevation and dataset together;
 * one without carries neither.
 */
export type SightlineSample = LatLon & {
  distance_m: number;
  resolution_m?: number | undefined;
} & ({ dataset: Dataset; elevation_m: number } | { dataset?: undefined; elevation_m?: undefined });

/** A sightline sample with data. */
type KnownSample = Extract<SightlineSample, { elevation_m: number }>;

/** Where a measured sample sits and which dataset answered it. */
interface SampleLocation extends LatLon {
  dataset: Dataset;
  resolution_m?: number | undefined;
}

/** One interior sample with data, measured against the sightline (unrounded). */
export interface ClearancePoint extends SampleLocation {
  /** Sightline height minus (surface + curvature bulge); ≤ 0 means obstructed. */
  clearance_m: number;
  curvature_bulge_m: number;
  distance_m: number;
  index: number;
  sightline_elevation_m: number;
  surface_elevation_m: number;
  terrain_elevation_m: number;
}

/** One endpoint's ground, surface, and sightline height (unrounded). */
export interface SightlineEndpoint extends SampleLocation {
  ground_elevation_m: number;
  sightline_elevation_m: number;
  surface_elevation_m: number;
}

/** Line-of-sight inputs: samples from {@link resamplePath} on `[observer, target]`, with elevations. */
export interface LineOfSightInput {
  /** Great-circle distance observer → target, meters. */
  distance_m: number;
  earth_model: EarthModel;
  observer_height_m: number;
  /** At least 3 samples, endpoints included. */
  samples: readonly SightlineSample[];
  target_height_m: number;
  /** Water level every sample's surface is raised to, in place of the Mapzen 0 m rule ({@link surfaceElevation}). */
  water_surface_m?: number | undefined;
}

/** Terrain line-of-sight verdict and its supporting measurements. */
export type LineOfSightResult =
  | { kind: 'endpoint_no_data'; observer_missing: boolean; target_missing: boolean }
  | {
      kind: 'evaluated';
      /** Every interior sample with data, in order from the observer. */
      clearances: ClearancePoint[];
      /** Interior sample nearest the observer with clearance ≤ 0; present when blocked. */
      first_obstruction?: ClearancePoint;
      /** Interior sample with the smallest clearance (first on ties); absent when no interior sample has data. */
      limiting?: ClearancePoint;
      /** Interior samples without data. */
      missing_interior: number;
      obstructed_samples: number;
      observer: SightlineEndpoint;
      /**
       * Samples (endpoints included) whose surface was raised above the value
       * received: to 0 m over a Mapzen sea floor, or to `water_surface_m` when set.
       */
      sea_surface_samples: number;
      target: SightlineEndpoint;
      /** USGS 3DEP samples (endpoints included) with a value below 0 m. */
      usgs_below_zero_samples: number;
      verdict: 'blocked' | 'clear' | 'indeterminate';
    };

/**
 * Decides whether terrain blocks the straight sightline from the observer
 * (sample 0, raised `observer_height_m` above its surface) to the target (the
 * last sample, raised `target_height_m`). Interior sample i with data has
 * clearance z_i − (s_i + b_i), where z_i interpolates the sightline linearly
 * in distance, s_i is {@link surfaceElevation} (with `water_surface_m` when
 * set), and b_i is {@link curvatureBulge}. Verdict: `blocked` when any
 * interior clearance is ≤ 0; `clear` when every interior sample has data and
 * clears; otherwise `indeterminate`.
 */
export function lineOfSight(input: LineOfSightInput): LineOfSightResult {
  const { samples, distance_m: total, water_surface_m } = input;
  const observerSample = samples[0];
  const targetSample = samples.at(-1);
  if (observerSample?.elevation_m === undefined || targetSample?.elevation_m === undefined) {
    return {
      kind: 'endpoint_no_data',
      observer_missing: observerSample?.elevation_m === undefined,
      target_missing: targetSample?.elevation_m === undefined,
    };
  }

  const observer = toEndpoint(observerSample, input.observer_height_m, water_surface_m);
  const target = toEndpoint(targetSample, input.target_height_m, water_surface_m);
  let seaSurfaceSamples = 0;
  let usgsBelowZeroSamples = 0;
  let missingInterior = 0;
  const clearances: ClearancePoint[] = [];

  samples.forEach((sample, index) => {
    if (sample.elevation_m === undefined) {
      if (index > 0 && index < samples.length - 1) missingInterior++;
      return;
    }
    const surface = surfaceElevation(sample.elevation_m, sample.dataset, water_surface_m);
    if (surface !== sample.elevation_m) seaSurfaceSamples++;
    if (sample.dataset === 'usgs_3dep' && sample.elevation_m < 0) usgsBelowZeroSamples++;
    if (index === 0 || index === samples.length - 1) return;
    const bulge = curvatureBulge(sample.distance_m, total, input.earth_model);
    const sightline =
      observer.sightline_elevation_m +
      ((target.sightline_elevation_m - observer.sightline_elevation_m) * sample.distance_m) / total;
    clearances.push({
      ...location(sample),
      clearance_m: sightline - (surface + bulge),
      curvature_bulge_m: bulge,
      distance_m: sample.distance_m,
      index,
      sightline_elevation_m: sightline,
      surface_elevation_m: surface,
      terrain_elevation_m: sample.elevation_m,
    });
  });

  const limiting = clearances.reduce<ClearancePoint | undefined>(
    (lowest, point) =>
      lowest === undefined || point.clearance_m < lowest.clearance_m ? point : lowest,
    undefined,
  );
  const obstructed = clearances.filter((point) => point.clearance_m <= 0);
  const firstObstruction = obstructed[0];
  const verdict = firstObstruction ? 'blocked' : missingInterior > 0 ? 'indeterminate' : 'clear';

  return {
    kind: 'evaluated',
    clearances,
    ...(firstObstruction && { first_obstruction: firstObstruction }),
    ...(limiting && { limiting }),
    missing_interior: missingInterior,
    obstructed_samples: obstructed.length,
    observer,
    sea_surface_samples: seaSurfaceSamples,
    target,
    usgs_below_zero_samples: usgsBelowZeroSamples,
    verdict,
  };
}

/**
 * Share of the first Fresnel zone radius a link must clear for free-space
 * propagation (ITU-R P.530-19 §2.2.2; P.526-16 §2.3 starts the diffraction
 * zone there).
 */
export const FRESNEL_CLEARANCE_FRACTION = 0.6;

/**
 * First Fresnel zone radius in meters at `distance_m` along a link `total_m`
 * long: √(λ·d₁·d₂/D) with λ = c/f (ITU-R P.526-16 §2.1, n = 1). 0 at either end.
 */
export function firstFresnelRadius(
  distance_m: number,
  total_m: number,
  frequency_mhz: number,
): number {
  const wavelength_m = SPEED_OF_LIGHT_M_PER_US / frequency_mhz;
  return Math.sqrt((wavelength_m * distance_m * (total_m - distance_m)) / total_m);
}

/** An interior sample measured against the first Fresnel zone (unrounded). */
export interface FresnelPoint extends ClearancePoint {
  /** `clearance_m / fresnel_radius_m`; negative where terrain blocks the line. */
  clearance_ratio: number;
  fresnel_radius_m: number;
}

/** First Fresnel zone inputs: a line of sight's interior clearances and its length. */
export interface FresnelInput {
  /** Every interior sample with data, as {@link lineOfSight} returns them. */
  clearances: readonly ClearancePoint[];
  /** Line length D, meters. */
  distance_m: number;
  frequency_mhz: number;
  /** Interior samples without data. */
  missing_interior: number;
}

/** First Fresnel zone verdict and the sample that limits it. */
export interface FresnelClearance {
  /** Interior sample with the smallest ratio (first on ties); absent when no interior sample has data. */
  limiting?: FresnelPoint;
  verdict: (typeof FRESNEL_VERDICTS)[number];
}

/**
 * Measures each interior clearance against the first Fresnel zone radius at
 * its position. Verdict: `insufficient` when any sample with data clears less
 * than {@link FRESNEL_CLEARANCE_FRACTION} of its radius (a terrain obstruction
 * always does); `sufficient` when every interior sample has data and clears at
 * least that; otherwise `indeterminate`.
 */
export function fresnelClearance(input: FresnelInput): FresnelClearance {
  let limiting: FresnelPoint | undefined;
  for (const point of input.clearances) {
    const fresnel_radius_m = firstFresnelRadius(
      point.distance_m,
      input.distance_m,
      input.frequency_mhz,
    );
    const clearance_ratio = point.clearance_m / fresnel_radius_m;
    if (limiting === undefined || clearance_ratio < limiting.clearance_ratio) {
      limiting = { ...point, clearance_ratio, fresnel_radius_m };
    }
  }
  const verdict =
    limiting !== undefined && limiting.clearance_ratio < FRESNEL_CLEARANCE_FRACTION
      ? 'insufficient'
      : limiting === undefined || input.missing_interior > 0
        ? 'indeterminate'
        : 'sufficient';
  return { ...(limiting && { limiting }), verdict };
}

function location(sample: KnownSample): SampleLocation {
  return {
    lat: sample.lat,
    lon: sample.lon,
    dataset: sample.dataset,
    ...(sample.resolution_m !== undefined && { resolution_m: sample.resolution_m }),
  };
}

function toEndpoint(
  sample: KnownSample,
  height_m: number,
  water_surface_m: number | undefined,
): SightlineEndpoint {
  const surface = surfaceElevation(sample.elevation_m, sample.dataset, water_surface_m);
  return {
    ...location(sample),
    ground_elevation_m: sample.elevation_m,
    sightline_elevation_m: surface + height_m,
    surface_elevation_m: surface,
  };
}

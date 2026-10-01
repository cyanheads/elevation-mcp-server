/**
 * @fileoverview Tests for the pure geometry module against the golden values
 * in docs/design.md § Computation: haversine on public reference coordinates,
 * path resampling, profile statistics with gaps bridged, grid nodes, the
 * curvature bulge, the sea-surface rule, and the three line-of-sight verdicts.
 * @module tests/services/geometry.test
 */

import { describe, expect, it } from 'vitest';
import {
  curvatureBulge,
  dropConsecutiveDuplicates,
  EARTH_MODELS,
  type EarthModel,
  effectiveEarthRadius,
  gridNodes,
  haversineDistance,
  interpolateGreatCircle,
  lineOfSight,
  MIN_PATH_LENGTH_M,
  profileStats,
  REFRACTION_COEFFICIENTS,
  refractionCoefficient,
  resamplePath,
  type SightlineSample,
  surfaceElevation,
} from '@/services/elevation/geometry.js';
import type { LatLon } from '@/services/elevation/types.js';
import { EARTH_RADIUS_M, METERS_PER_DEGREE } from '@/services/elevation/units.js';

const SPACE_NEEDLE: LatLon = { lat: 47.6205, lon: -122.3493 };
const MOUNT_RAINIER: LatLon = { lat: 46.8523, lon: -121.7603 };

describe('haversineDistance', () => {
  it('measures 1 degree of latitude as pi * R / 180', () => {
    const distance = haversineDistance({ lat: 0, lon: 0 }, { lat: 1, lon: 0 });
    expect(distance).toBeCloseTo(111_195.08, 2);
    expect(distance).toBeCloseTo(METERS_PER_DEGREE, 6);
  });

  it('measures 1 degree of longitude at the equator the same', () => {
    expect(haversineDistance({ lat: 0, lon: 0 }, { lat: 0, lon: 1 })).toBeCloseTo(111_195.08, 2);
  });

  it('measures the Space Needle to Mount Rainier', () => {
    expect(haversineDistance(SPACE_NEEDLE, MOUNT_RAINIER)).toBeCloseTo(96_301.15, 1);
  });

  it('shrinks a degree of longitude with the cosine of latitude', () => {
    const at60 = haversineDistance({ lat: 60, lon: 0 }, { lat: 60, lon: 1 });
    const alongParallel = METERS_PER_DEGREE * Math.cos((60 * Math.PI) / 180);
    expect(Math.abs(at60 - alongParallel)).toBeLessThan(1);
  });

  it('is symmetric and zero for identical points', () => {
    expect(haversineDistance(SPACE_NEEDLE, MOUNT_RAINIER)).toBe(
      haversineDistance(MOUNT_RAINIER, SPACE_NEEDLE),
    );
    expect(haversineDistance(SPACE_NEEDLE, SPACE_NEEDLE)).toBe(0);
  });

  it('takes the short way across the antimeridian', () => {
    expect(haversineDistance({ lat: 0, lon: 179.5 }, { lat: 0, lon: -179.5 })).toBeCloseTo(
      METERS_PER_DEGREE,
      2,
    );
  });

  it('measures half the circumference between antipodes without returning NaN', () => {
    const distance = haversineDistance({ lat: 0, lon: 0 }, { lat: 0, lon: 180 });
    expect(distance).toBeCloseTo(Math.PI * EARTH_RADIUS_M, 0);
    expect(haversineDistance({ lat: 90, lon: 0 }, { lat: -90, lon: 0 })).toBeCloseTo(
      Math.PI * EARTH_RADIUS_M,
      0,
    );
  });

  it('stays finite and tiny for points a micro-degree apart', () => {
    const distance = haversineDistance({ lat: 47, lon: -122 }, { lat: 47.000001, lon: -122 });
    expect(distance).toBeGreaterThan(0.1);
    expect(distance).toBeLessThan(0.12);
  });
});

describe('interpolateGreatCircle', () => {
  const a: LatLon = { lat: 0, lon: 0 };
  const b: LatLon = { lat: 0, lon: 1 };

  it('returns the endpoints exactly at fraction 0 and 1', () => {
    expect(interpolateGreatCircle(SPACE_NEEDLE, MOUNT_RAINIER, 0)).toStrictEqual(SPACE_NEEDLE);
    expect(interpolateGreatCircle(SPACE_NEEDLE, MOUNT_RAINIER, 1)).toStrictEqual(MOUNT_RAINIER);
  });

  it('clamps a fraction outside 0..1 to the endpoints', () => {
    expect(interpolateGreatCircle(a, b, -0.5)).toStrictEqual(a);
    expect(interpolateGreatCircle(a, b, 1.5)).toStrictEqual(b);
  });

  it('places the midpoint of an equatorial segment halfway', () => {
    const mid = interpolateGreatCircle(a, b, 0.5);
    expect(mid.lat).toBeCloseTo(0, 12);
    expect(mid.lon).toBeCloseTo(0.5, 12);
  });

  it('puts the point at the requested fraction of the distance', () => {
    const point = interpolateGreatCircle(SPACE_NEEDLE, MOUNT_RAINIER, 0.3);
    const total = haversineDistance(SPACE_NEEDLE, MOUNT_RAINIER);
    expect(haversineDistance(SPACE_NEEDLE, point)).toBeCloseTo(0.3 * total, 4);
    expect(haversineDistance(point, MOUNT_RAINIER)).toBeCloseTo(0.7 * total, 4);
  });

  it('returns the first point when the two coincide', () => {
    expect(interpolateGreatCircle(SPACE_NEEDLE, SPACE_NEEDLE, 0.5)).toStrictEqual(SPACE_NEEDLE);
  });

  it('keeps longitude in [-180, 180] across the antimeridian', () => {
    const mid = interpolateGreatCircle({ lat: 0, lon: 179.5 }, { lat: 0, lon: -179.5 }, 0.5);
    expect(Math.abs(mid.lon)).toBeCloseTo(180, 9);
    const nearSide = interpolateGreatCircle({ lat: 0, lon: 179.5 }, { lat: 0, lon: -179.5 }, 0.25);
    expect(nearSide.lon).toBeCloseTo(179.75, 9);
    const farSide = interpolateGreatCircle({ lat: 0, lon: 179.5 }, { lat: 0, lon: -179.5 }, 0.75);
    expect(farSide.lon).toBeCloseTo(-179.75, 9);
  });

  it('follows the great circle over the pole, not the parallel', () => {
    const mid = interpolateGreatCircle({ lat: 80, lon: 0 }, { lat: 80, lon: 180 }, 0.5);
    expect(mid.lat).toBeCloseTo(90, 9);
  });
});

describe('dropConsecutiveDuplicates', () => {
  it('drops a vertex equal to its predecessor', () => {
    expect(
      dropConsecutiveDuplicates([
        { lat: 1, lon: 2 },
        { lat: 1, lon: 2 },
        { lat: 3, lon: 4 },
      ]),
    ).toStrictEqual([
      { lat: 1, lon: 2 },
      { lat: 3, lon: 4 },
    ]);
  });

  it('compares after rounding to 6 decimals', () => {
    const kept = dropConsecutiveDuplicates([
      { lat: 1.0000001, lon: 2 },
      { lat: 1.0000004, lon: 2.0000004 },
      { lat: 1.000001, lon: 2 },
    ]);
    expect(kept).toHaveLength(2);
    expect(kept[1]).toStrictEqual({ lat: 1.000001, lon: 2 });
  });

  it('keeps a repeated vertex that is not consecutive', () => {
    const a = { lat: 1, lon: 1 };
    const b = { lat: 2, lon: 2 };
    expect(dropConsecutiveDuplicates([a, b, a])).toHaveLength(3);
  });

  it('collapses a run of identical vertices to one', () => {
    const a = { lat: 1, lon: 1 };
    expect(dropConsecutiveDuplicates([a, a, a, a])).toStrictEqual([a]);
  });

  it('returns an empty list for an empty path and does not touch its input', () => {
    expect(dropConsecutiveDuplicates([])).toStrictEqual([]);
    const input = [
      { lat: 1, lon: 1 },
      { lat: 1, lon: 1 },
    ];
    dropConsecutiveDuplicates(input);
    expect(input).toHaveLength(2);
  });

  it('returns copies, not the caller objects', () => {
    const vertex = { lat: 1, lon: 1 };
    expect(dropConsecutiveDuplicates([vertex])[0]).not.toBe(vertex);
  });
});

describe('resamplePath', () => {
  it('samples a two-vertex path at even fractions, dropping a duplicate vertex', () => {
    const result = resamplePath(
      [
        { lat: 0, lon: 0 },
        { lat: 0, lon: 0 },
        { lat: 0, lon: 1 },
      ],
      5,
    );
    if (result.kind !== 'ok') throw new Error('expected an ok resampling');
    expect(result.vertices).toBe(2);
    expect(result.total_distance_m).toBeCloseTo(111_195.08, 2);
    expect(result.sample_interval_m).toBeCloseTo(27_798.77, 2);
    expect(result.samples.map((sample) => sample.lon)).toEqual([
      0,
      expect.closeTo(0.25, 12),
      expect.closeTo(0.5, 12),
      expect.closeTo(0.75, 12),
      1,
    ]);
    expect(result.samples.every((sample) => sample.lat === 0)).toBe(true);
    result.samples.forEach((sample, index) => {
      expect(sample.distance_m).toBeCloseTo(index * result.sample_interval_m, 6);
    });
  });

  it('makes the first and last samples exactly the first and last vertices', () => {
    const result = resamplePath([SPACE_NEEDLE, MOUNT_RAINIER], 7);
    if (result.kind !== 'ok') throw new Error('expected an ok resampling');
    expect(result.samples).toHaveLength(7);
    expect(result.samples[0]).toStrictEqual({ ...SPACE_NEEDLE, distance_m: 0 });
    expect(result.samples.at(-1)).toStrictEqual({
      ...MOUNT_RAINIER,
      distance_m: result.total_distance_m,
    });
  });

  it('returns just the endpoints for 2 samples', () => {
    const result = resamplePath([SPACE_NEEDLE, MOUNT_RAINIER], 2);
    if (result.kind !== 'ok') throw new Error('expected an ok resampling');
    expect(result.samples).toHaveLength(2);
    expect(result.sample_interval_m).toBeCloseTo(result.total_distance_m, 6);
  });

  it('places the samples evenly in distance along the route', () => {
    const result = resamplePath([SPACE_NEEDLE, MOUNT_RAINIER], 11);
    if (result.kind !== 'ok') throw new Error('expected an ok resampling');
    for (let i = 1; i < result.samples.length; i++) {
      const previous = result.samples[i - 1] as LatLon;
      const current = result.samples[i] as LatLon;
      expect(haversineDistance(previous, current)).toBeCloseTo(result.sample_interval_m, 3);
    }
  });

  it('measures a multi-vertex route along its segments and does not force vertices in', () => {
    const corner: LatLon = { lat: 0, lon: 1 };
    const path: LatLon[] = [{ lat: 0, lon: 0 }, corner, { lat: 1, lon: 1 }];
    const result = resamplePath(path, 4);
    if (result.kind !== 'ok') throw new Error('expected an ok resampling');
    expect(result.vertices).toBe(3);
    expect(result.total_distance_m).toBeCloseTo(2 * METERS_PER_DEGREE, 2);
    expect(result.sample_interval_m).toBeCloseTo((2 * METERS_PER_DEGREE) / 3, 2);
    const [, second, third] = result.samples;
    expect(second?.lat).toBeCloseTo(0, 9);
    expect(second?.lon).toBeCloseTo(2 / 3, 9);
    expect(third?.lon).toBeCloseTo(1, 9);
    expect(third?.lat).toBeCloseTo(1 / 3, 9);
    for (const sample of result.samples)
      expect(sample).not.toStrictEqual({ ...corner, distance_m: sample.distance_m });
  });

  it('puts a sample exactly on an interior vertex when the spacing lands there', () => {
    const result = resamplePath(
      [
        { lat: 0, lon: 0 },
        { lat: 0, lon: 1 },
        { lat: 0, lon: 2 },
      ],
      3,
    );
    if (result.kind !== 'ok') throw new Error('expected an ok resampling');
    expect(result.samples[1]?.lon).toBeCloseTo(1, 9);
  });

  it('interpolates across the antimeridian onto longitude 180', () => {
    const result = resamplePath(
      [
        { lat: 0, lon: 179.5 },
        { lat: 0, lon: -179.5 },
      ],
      3,
    );
    if (result.kind !== 'ok') throw new Error('expected an ok resampling');
    expect(Math.abs(result.samples[1]?.lon ?? 0)).toBeCloseTo(180, 9);
  });

  it('keeps cumulative distance non-decreasing over a 1,000-vertex route', () => {
    const path = Array.from({ length: 1_000 }, (_v, i) => ({
      lat: 40 + Math.sin(i / 20) * 0.5,
      lon: -105 + i * 0.001,
    }));
    const result = resamplePath(path, 250);
    if (result.kind !== 'ok') throw new Error('expected an ok resampling');
    expect(result.samples).toHaveLength(250);
    for (let i = 1; i < result.samples.length; i++) {
      expect(result.samples[i]?.distance_m).toBeGreaterThan(result.samples[i - 1]?.distance_m ?? 0);
    }
  });

  describe('degenerate paths', () => {
    it('reports a path whose vertices are all the same point', () => {
      const result = resamplePath(
        [
          { lat: 47, lon: -122 },
          { lat: 47, lon: -122 },
          { lat: 47, lon: -122 },
        ],
        5,
      );
      expect(result).toStrictEqual({ kind: 'degenerate', total_distance_m: 0, vertices: 1 });
    });

    it('reports a second vertex under the 6-decimal grid as a duplicate', () => {
      const result = resamplePath(
        [
          { lat: 0, lon: 0 },
          { lat: 0, lon: 1e-7 },
          { lat: 0, lon: 4e-7 },
        ],
        3,
      );
      expect(result).toStrictEqual({ kind: 'degenerate', total_distance_m: 0, vertices: 1 });
    });

    it('reports distinct vertices under 1 m apart with their length', () => {
      const result = resamplePath(
        [
          { lat: 0, lon: 0 },
          { lat: 0, lon: 0.000005 },
        ],
        3,
      );
      expect(result.kind).toBe('degenerate');
      if (result.kind !== 'degenerate') return;
      expect(result.vertices).toBe(2);
      expect(result.total_distance_m).toBeCloseTo(0.556, 3);
      expect(result.total_distance_m).toBeLessThan(MIN_PATH_LENGTH_M);
    });

    it('accepts a route just over 1 m', () => {
      const result = resamplePath(
        [
          { lat: 0, lon: 0 },
          { lat: 0, lon: 0.00001 },
        ],
        3,
      );
      expect(result.kind).toBe('ok');
    });

    it('reports an empty path and a single vertex', () => {
      expect(resamplePath([], 3)).toStrictEqual({
        kind: 'degenerate',
        total_distance_m: 0,
        vertices: 0,
      });
      expect(resamplePath([{ lat: 1, lon: 1 }], 3)).toStrictEqual({
        kind: 'degenerate',
        total_distance_m: 0,
        vertices: 1,
      });
    });
  });
});

describe('profileStats', () => {
  it('bridges gaps: ascent, descent, grades, and extremes over [100, -, 110, 105, 110]', () => {
    const stats = profileStats([
      { distance_m: 0, elevation_m: 100 },
      { distance_m: 50 },
      { distance_m: 100, elevation_m: 110 },
      { distance_m: 150, elevation_m: 105 },
      { distance_m: 200, elevation_m: 110 },
    ]);
    expect(stats.ascent_m).toBe(15);
    expect(stats.descent_m).toBe(5);
    expect(stats.grades_pct).toEqual([undefined, undefined, 10, -10, 10]);
    expect(stats.first_index).toBe(0);
    expect(stats.last_index).toBe(4);
    expect(stats.highest_index).toBe(2);
    expect(stats.lowest_index).toBe(0);
    expect(stats.max_grade_pct).toBe(10);
    expect(stats.min_grade_pct).toBe(-10);
    expect(stats.max_grade_index).toBe(2);
    expect(stats.min_grade_index).toBe(3);
  });

  it('indexes the steepest grades by their unrounded values', () => {
    const stats = profileStats([
      { distance_m: 0, elevation_m: 0 },
      { distance_m: 100, elevation_m: 10.02 },
      { distance_m: 200, elevation_m: 20.06 },
      { distance_m: 300, elevation_m: 10.04 },
      { distance_m: 400, elevation_m: 0 },
    ]);
    expect(stats.max_grade_index).toBe(2);
    expect(stats.min_grade_index).toBe(4);
  });

  it('computes each bridged grade over the distance between samples with data', () => {
    const stats = profileStats([
      { distance_m: 0, elevation_m: 100 },
      { distance_m: 100 },
      { distance_m: 200 },
      { distance_m: 400, elevation_m: 120 },
    ]);
    expect(stats.grades_pct).toEqual([undefined, undefined, undefined, 5]);
    expect(stats.ascent_m).toBe(20);
  });

  it('returns zeroed stats and no indices for an empty profile', () => {
    expect(profileStats([])).toStrictEqual({ ascent_m: 0, descent_m: 0, grades_pct: [] });
  });

  it('returns no indices when no sample has data', () => {
    const stats = profileStats([{ distance_m: 0 }, { distance_m: 10 }]);
    expect(stats).toStrictEqual({ ascent_m: 0, descent_m: 0, grades_pct: [undefined, undefined] });
  });

  it('has indices but no grades with one sample with data', () => {
    const stats = profileStats([{ distance_m: 0 }, { distance_m: 10, elevation_m: 42 }]);
    expect(stats.first_index).toBe(1);
    expect(stats.last_index).toBe(1);
    expect(stats.highest_index).toBe(1);
    expect(stats.lowest_index).toBe(1);
    expect(stats.ascent_m).toBe(0);
    expect(stats.descent_m).toBe(0);
    expect(stats).not.toHaveProperty('max_grade_pct');
    expect(stats).not.toHaveProperty('min_grade_pct');
  });

  it('reports a negative maximum grade on a route that only descends', () => {
    const stats = profileStats([
      { distance_m: 0, elevation_m: 100 },
      { distance_m: 100, elevation_m: 90 },
      { distance_m: 200, elevation_m: 70 },
    ]);
    expect(stats.ascent_m).toBe(0);
    expect(stats.descent_m).toBe(30);
    expect(stats.max_grade_pct).toBe(-10);
    expect(stats.min_grade_pct).toBe(-20);
  });

  it('reports a flat route as zero grades, ascent, and descent', () => {
    const stats = profileStats([
      { distance_m: 0, elevation_m: 5 },
      { distance_m: 10, elevation_m: 5 },
      { distance_m: 20, elevation_m: 5 },
    ]);
    expect(stats.grades_pct).toEqual([undefined, 0, 0]);
    expect(stats.max_grade_pct).toBe(0);
    expect(stats.min_grade_pct).toBe(0);
    expect(stats.ascent_m).toBe(0);
    expect(stats.descent_m).toBe(0);
  });

  it('breaks ties to the first occurrence', () => {
    const stats = profileStats([
      { distance_m: 0, elevation_m: 10 },
      { distance_m: 1, elevation_m: 50 },
      { distance_m: 2, elevation_m: 10 },
      { distance_m: 3, elevation_m: 50 },
    ]);
    expect(stats.highest_index).toBe(1);
    expect(stats.lowest_index).toBe(0);
    expect(stats.max_grade_index).toBe(1);
    expect(stats.min_grade_index).toBe(2);
  });

  it('treats an elevation of 0 as data', () => {
    const stats = profileStats([
      { distance_m: 0, elevation_m: 0 },
      { distance_m: 10, elevation_m: 5 },
    ]);
    expect(stats.first_index).toBe(0);
    expect(stats.lowest_index).toBe(0);
    expect(stats.grades_pct).toEqual([undefined, 50]);
  });

  it('sums raw sampled changes with no smoothing', () => {
    const stats = profileStats(
      [10, 11, 10, 11, 10, 11].map((elevation_m, i) => ({ distance_m: i * 10, elevation_m })),
    );
    expect(stats.ascent_m).toBe(3);
    expect(stats.descent_m).toBe(2);
  });

  it('handles negative elevations', () => {
    const stats = profileStats([
      { distance_m: 0, elevation_m: -50 },
      { distance_m: 10, elevation_m: -80 },
    ]);
    expect(stats.descent_m).toBe(30);
    expect(stats.lowest_index).toBe(1);
    expect(stats.highest_index).toBe(0);
  });
});

describe('gridNodes', () => {
  const grid = gridNodes({ south: 0, west: 0, north: 1, east: 2 }, 3, 3);

  it('places rows north to south and columns west to east, edges included', () => {
    expect(grid.latitudes_deg).toEqual([1, 0.5, 0]);
    expect(grid.longitudes_deg).toEqual([0, 1, 2]);
  });

  it('lists nodes in row-major order', () => {
    expect(grid.nodes).toHaveLength(9);
    expect(grid.nodes.slice(0, 4)).toEqual([
      { lat: 1, lon: 0 },
      { lat: 1, lon: 1 },
      { lat: 1, lon: 2 },
      { lat: 0.5, lon: 0 },
    ]);
    expect(grid.nodes.at(-1)).toEqual({ lat: 0, lon: 2 });
  });

  it('spaces rows by latitude and columns by longitude at the center latitude', () => {
    expect(grid.row_spacing_m).toBeCloseTo(55_597.54, 2);
    expect(grid.col_spacing_m).toBeCloseTo(111_190.85, 2);
    expect(grid.col_spacing_m).toBeCloseTo(METERS_PER_DEGREE * Math.cos((0.5 * Math.PI) / 180), 6);
  });

  it('builds a 2 x 2 grid from the four corners', () => {
    const corners = gridNodes({ south: 10, west: -20, north: 12, east: -18 }, 2, 2);
    expect(corners.nodes).toEqual([
      { lat: 12, lon: -20 },
      { lat: 12, lon: -18 },
      { lat: 10, lon: -20 },
      { lat: 10, lon: -18 },
    ]);
    expect(corners.row_spacing_m).toBeCloseTo(2 * METERS_PER_DEGREE, 6);
  });

  it('ends exactly on the south and east edges, free of accumulated rounding', () => {
    const edges = gridNodes({ south: 47.1, west: -122.3, north: 47.7, east: -121.7 }, 25, 25);
    expect(edges.latitudes_deg[0]).toBe(47.7);
    expect(edges.latitudes_deg.at(-1)).toBe(47.1);
    expect(edges.longitudes_deg[0]).toBe(-122.3);
    expect(edges.longitudes_deg.at(-1)).toBe(-121.7);
  });

  it('narrows column spacing toward the poles', () => {
    const equator = gridNodes({ south: -0.5, west: 0, north: 0.5, east: 1 }, 2, 2);
    const high = gridNodes({ south: 59.5, west: 0, north: 60.5, east: 1 }, 2, 2);
    expect(high.col_spacing_m / equator.col_spacing_m).toBeCloseTo(0.5, 3);
    expect(high.row_spacing_m).toBeCloseTo(equator.row_spacing_m, 6);
  });

  it('keeps a 250-cell grid in row-major order of the right size', () => {
    const big = gridNodes({ south: 0, west: 0, north: 1, east: 1 }, 10, 25);
    expect(big.nodes).toHaveLength(250);
    expect(big.nodes[25]).toEqual({ lat: big.latitudes_deg[1], lon: 0 });
  });
});

describe('earth models', () => {
  it('lists the four models in advertised order', () => {
    expect([...EARTH_MODELS]).toEqual(['flat', 'geometric', 'optical', 'radio']);
  });

  it('assigns the refraction coefficients', () => {
    expect(REFRACTION_COEFFICIENTS).toEqual({ geometric: 0, optical: 0.13, radio: 0.25 });
    expect(refractionCoefficient('geometric')).toBe(0);
    expect(refractionCoefficient('optical')).toBe(0.13);
    expect(refractionCoefficient('radio')).toBe(0.25);
    expect(refractionCoefficient('flat')).toBeUndefined();
  });

  it('derives the effective earth radius as R / (1 - kappa)', () => {
    expect(effectiveEarthRadius('geometric')).toBe(EARTH_RADIUS_M);
    expect(effectiveEarthRadius('optical')).toBeCloseTo(7_322_998.62, 2);
    expect(effectiveEarthRadius('radio')).toBeCloseTo(8_494_678.4, 1);
    expect(effectiveEarthRadius('flat')).toBeUndefined();
  });

  describe('curvatureBulge at the midpoint of a 50 km line', () => {
    it.each([
      ['geometric', 49.05],
      ['optical', 42.67],
      ['radio', 36.79],
    ] as const)('is %s: %d m', (model, expected) => {
      expect(curvatureBulge(25_000, 50_000, model)).toBeCloseTo(expected, 2);
    });

    it('matches the unrounded golden values', () => {
      expect(curvatureBulge(25_000, 50_000, 'geometric')).toBeCloseTo(49.0503, 4);
      expect(curvatureBulge(25_000, 50_000, 'optical')).toBeCloseTo(42.6738, 4);
      expect(curvatureBulge(25_000, 50_000, 'radio')).toBeCloseTo(36.7877, 4);
    });

    it('is 0 for the flat model', () => {
      expect(curvatureBulge(25_000, 50_000, 'flat')).toBe(0);
    });
  });

  it.each<EarthModel>(['geometric', 'optical', 'radio'])(
    'has no bulge at either end and the same bulge at mirrored points (%s)',
    (model) => {
      expect(curvatureBulge(0, 50_000, model)).toBe(0);
      expect(curvatureBulge(50_000, 50_000, model)).toBe(0);
      expect(curvatureBulge(10_000, 50_000, model)).toBeCloseTo(
        curvatureBulge(40_000, 50_000, model),
        9,
      );
    },
  );

  it('orders the bulge flat < radio < optical < geometric', () => {
    const bulge = (model: EarthModel) => curvatureBulge(25_000, 50_000, model);
    expect(bulge('flat')).toBeLessThan(bulge('radio'));
    expect(bulge('radio')).toBeLessThan(bulge('optical'));
    expect(bulge('optical')).toBeLessThan(bulge('geometric'));
  });
});

describe('surfaceElevation', () => {
  it('measures to the sea surface (0 m) over a Mapzen value below 0', () => {
    expect(surfaceElevation(-50, 'mapzen')).toBe(0);
    expect(surfaceElevation(-0.5, 'mapzen')).toBe(0);
  });

  it('keeps a Mapzen value at or above 0', () => {
    expect(surfaceElevation(0, 'mapzen')).toBe(0);
    expect(surfaceElevation(9, 'mapzen')).toBe(9);
  });

  it.each([
    ['srtm30m', -77],
    ['usgs_3dep', -84.7],
  ] as const)('keeps a %s value below 0 as measured land', (dataset, elevation) => {
    expect(surfaceElevation(elevation, dataset)).toBe(elevation);
  });

  it('keeps a value with no dataset', () => {
    expect(surfaceElevation(-5, undefined)).toBe(-5);
  });
});

describe('lineOfSight', () => {
  const sample = (
    distance_m: number,
    elevation_m: number | undefined,
    dataset: 'usgs_3dep' | 'srtm30m' | 'mapzen' = 'srtm30m',
    resolution_m?: number,
  ): SightlineSample => ({
    lat: 0,
    lon: distance_m / METERS_PER_DEGREE,
    distance_m,
    ...(resolution_m !== undefined && { resolution_m }),
    ...(elevation_m !== undefined ? { dataset, elevation_m } : {}),
  });

  /** Flat model, heights 0, 10 m endpoints on a 1 km line, one interior sample. */
  const flatKilometer = (midpoint: number | undefined) =>
    lineOfSight({
      distance_m: 1_000,
      earth_model: 'flat',
      observer_height_m: 0,
      target_height_m: 0,
      samples: [sample(0, 10), sample(500, midpoint), sample(1_000, 10)],
    });

  describe('verdicts', () => {
    it('is clear with 5 m of clearance over a 5 m midpoint', () => {
      const result = flatKilometer(5);
      if (result.kind !== 'evaluated') throw new Error('expected an evaluated result');
      expect(result.verdict).toBe('clear');
      expect(result.limiting?.clearance_m).toBe(5);
      expect(result.obstructed_samples).toBe(0);
      expect(result).not.toHaveProperty('first_obstruction');
    });

    it('is blocked at a clearance of exactly 0', () => {
      const result = flatKilometer(10);
      if (result.kind !== 'evaluated') throw new Error('expected an evaluated result');
      expect(result.verdict).toBe('blocked');
      expect(result.limiting?.clearance_m).toBe(0);
      expect(result.first_obstruction?.index).toBe(1);
      expect(result.obstructed_samples).toBe(1);
    });

    it('is blocked when the terrain is above the sightline', () => {
      const result = flatKilometer(30);
      if (result.kind !== 'evaluated') throw new Error('expected an evaluated result');
      expect(result.verdict).toBe('blocked');
      expect(result.limiting?.clearance_m).toBe(-20);
    });

    it('is indeterminate when the only interior sample has no data', () => {
      const result = flatKilometer(undefined);
      if (result.kind !== 'evaluated') throw new Error('expected an evaluated result');
      expect(result.verdict).toBe('indeterminate');
      expect(result.missing_interior).toBe(1);
      expect(result.clearances).toEqual([]);
      expect(result).not.toHaveProperty('limiting');
      expect(result).not.toHaveProperty('first_obstruction');
    });

    it('is still blocked when one interior sample is missing and another obstructs', () => {
      const result = lineOfSight({
        distance_m: 1_000,
        earth_model: 'flat',
        observer_height_m: 0,
        target_height_m: 0,
        samples: [sample(0, 10), sample(250, undefined), sample(500, 50), sample(1_000, 10)],
      });
      if (result.kind !== 'evaluated') throw new Error('expected an evaluated result');
      expect(result.verdict).toBe('blocked');
      expect(result.missing_interior).toBe(1);
    });

    it('is indeterminate when the interior samples with data all clear but one is missing', () => {
      const result = lineOfSight({
        distance_m: 1_000,
        earth_model: 'flat',
        observer_height_m: 0,
        target_height_m: 0,
        samples: [sample(0, 10), sample(250, 0), sample(500, undefined), sample(1_000, 10)],
      });
      if (result.kind !== 'evaluated') throw new Error('expected an evaluated result');
      expect(result.verdict).toBe('indeterminate');
      expect(result.limiting?.index).toBe(1);
    });
  });

  describe('endpoints without data', () => {
    const run = (observer: number | undefined, target: number | undefined) =>
      lineOfSight({
        distance_m: 1_000,
        earth_model: 'flat',
        observer_height_m: 0,
        target_height_m: 0,
        samples: [sample(0, observer), sample(500, 0), sample(1_000, target)],
      });

    it('reports a missing observer', () => {
      expect(run(undefined, 10)).toStrictEqual({
        kind: 'endpoint_no_data',
        observer_missing: true,
        target_missing: false,
      });
    });

    it('reports a missing target', () => {
      expect(run(10, undefined)).toStrictEqual({
        kind: 'endpoint_no_data',
        observer_missing: false,
        target_missing: true,
      });
    });

    it('reports both missing', () => {
      expect(run(undefined, undefined)).toStrictEqual({
        kind: 'endpoint_no_data',
        observer_missing: true,
        target_missing: true,
      });
    });

    it('treats an endpoint at 0 m as data', () => {
      expect(run(0, 0).kind).toBe('evaluated');
    });
  });

  describe('sea-surface case', () => {
    const fiftyKm = (midpointDataset: 'mapzen' | 'srtm30m') =>
      lineOfSight({
        distance_m: 50_000,
        earth_model: 'optical',
        observer_height_m: 1.7,
        target_height_m: 0,
        samples: [
          sample(0, 0, 'mapzen'),
          sample(25_000, -50, midpointDataset),
          sample(50_000, 0, 'mapzen'),
        ],
      });

    it('reads blocked: clearance is measured to 0 m, not to the -50 m sea floor', () => {
      const result = fiftyKm('mapzen');
      if (result.kind !== 'evaluated') throw new Error('expected an evaluated result');
      expect(result.verdict).toBe('blocked');
      expect(result.limiting?.clearance_m).toBeCloseTo(-41.8238, 4);
      expect(result.limiting?.surface_elevation_m).toBe(0);
      expect(result.limiting?.terrain_elevation_m).toBe(-50);
      expect(result.limiting?.sightline_elevation_m).toBeCloseTo(0.85, 9);
      expect(result.limiting?.curvature_bulge_m).toBeCloseTo(42.6738, 4);
      expect(result.sea_surface_samples).toBe(1);
    });

    it('would read clear against the sea floor if the midpoint were land', () => {
      const result = fiftyKm('srtm30m');
      if (result.kind !== 'evaluated') throw new Error('expected an evaluated result');
      expect(result.verdict).toBe('clear');
      expect(result.limiting?.clearance_m).toBeCloseTo(8.1762, 4);
      expect(result.limiting?.surface_elevation_m).toBe(-50);
      expect(result.sea_surface_samples).toBe(0);
    });

    it('counts endpoints in sea_surface_samples and lifts their sightline to 0 m', () => {
      const result = lineOfSight({
        distance_m: 1_000,
        earth_model: 'flat',
        observer_height_m: 2,
        target_height_m: 3,
        samples: [
          sample(0, -20, 'mapzen'),
          sample(500, -30, 'mapzen'),
          sample(1_000, -10, 'mapzen'),
        ],
      });
      if (result.kind !== 'evaluated') throw new Error('expected an evaluated result');
      expect(result.sea_surface_samples).toBe(3);
      expect(result.observer.ground_elevation_m).toBe(-20);
      expect(result.observer.surface_elevation_m).toBe(0);
      expect(result.observer.sightline_elevation_m).toBe(2);
      expect(result.target.ground_elevation_m).toBe(-10);
      expect(result.target.surface_elevation_m).toBe(0);
      expect(result.target.sightline_elevation_m).toBe(3);
    });
  });

  describe('curvature at the midpoint of a 50 km line', () => {
    const midpointOver = (model: EarthModel) => {
      const result = lineOfSight({
        distance_m: 50_000,
        earth_model: model,
        observer_height_m: 0,
        target_height_m: 0,
        samples: [sample(0, 0), sample(25_000, 0), sample(50_000, 0)],
      });
      if (result.kind !== 'evaluated') throw new Error('expected an evaluated result');
      return result;
    };

    it.each([
      ['geometric', 49.05],
      ['optical', 42.67],
      ['radio', 36.79],
    ] as const)('puts the %s bulge at %d m and the clearance at its negative', (model, bulge) => {
      const result = midpointOver(model);
      expect(result.limiting?.curvature_bulge_m).toBeCloseTo(bulge, 2);
      expect(result.limiting?.clearance_m).toBeCloseTo(-bulge, 2);
      expect(result.verdict).toBe('blocked');
    });

    it('applies no curvature for flat: level ground at the sightline height still blocks, by 0', () => {
      const result = midpointOver('flat');
      expect(result.limiting?.curvature_bulge_m).toBe(0);
      expect(result.limiting?.clearance_m).toBe(0);
      expect(result.verdict).toBe('blocked');
    });
  });

  describe('heights and sloping sightlines', () => {
    it('raises the sightline by the observer and target heights', () => {
      const result = lineOfSight({
        distance_m: 1_000,
        earth_model: 'flat',
        observer_height_m: 20,
        target_height_m: 40,
        samples: [sample(0, 100), sample(500, 100), sample(1_000, 100)],
      });
      if (result.kind !== 'evaluated') throw new Error('expected an evaluated result');
      expect(result.observer.sightline_elevation_m).toBe(120);
      expect(result.target.sightline_elevation_m).toBe(140);
      expect(result.limiting?.sightline_elevation_m).toBe(130);
      expect(result.limiting?.clearance_m).toBe(30);
    });

    it('interpolates the sightline linearly in distance between unequal endpoints', () => {
      const result = lineOfSight({
        distance_m: 1_000,
        earth_model: 'flat',
        observer_height_m: 0,
        target_height_m: 0,
        samples: [sample(0, 0), sample(250, 0), sample(500, 0), sample(750, 0), sample(1_000, 100)],
      });
      if (result.kind !== 'evaluated') throw new Error('expected an evaluated result');
      expect(result.clearances.map((point) => point.sightline_elevation_m)).toEqual([25, 50, 75]);
      expect(result.clearances.map((point) => point.clearance_m)).toEqual([25, 50, 75]);
    });

    it('keeps endpoint ground, surface, and sightline apart', () => {
      const result = flatKilometer(0);
      if (result.kind !== 'evaluated') throw new Error('expected an evaluated result');
      expect(result.observer).toMatchObject({
        ground_elevation_m: 10,
        surface_elevation_m: 10,
        sightline_elevation_m: 10,
        dataset: 'srtm30m',
      });
    });
  });

  describe('limiting point and first obstruction', () => {
    const rugged = lineOfSight({
      distance_m: 1_000,
      earth_model: 'flat',
      observer_height_m: 0,
      target_height_m: 0,
      samples: [
        sample(0, 10),
        sample(200, 4),
        sample(400, 12),
        sample(600, 25),
        sample(800, 12),
        sample(1_000, 10),
      ],
    });
    if (rugged.kind !== 'evaluated') throw new Error('expected an evaluated result');

    it('takes the first obstruction nearest the observer and the limiting point at the deepest', () => {
      expect(rugged.verdict).toBe('blocked');
      expect(rugged.first_obstruction?.index).toBe(2);
      expect(rugged.first_obstruction?.clearance_m).toBe(-2);
      expect(rugged.limiting?.index).toBe(3);
      expect(rugged.limiting?.clearance_m).toBe(-15);
      expect(rugged.obstructed_samples).toBe(3);
    });

    it('lists a clearance for every interior sample with data, in order', () => {
      expect(rugged.clearances.map((point) => point.index)).toEqual([1, 2, 3, 4]);
      expect(rugged.clearances.map((point) => point.distance_m)).toEqual([200, 400, 600, 800]);
    });

    it('resolves a clearance tie to the first sample', () => {
      const tied = lineOfSight({
        distance_m: 1_000,
        earth_model: 'flat',
        observer_height_m: 0,
        target_height_m: 0,
        samples: [
          sample(0, 10),
          sample(200, 8),
          sample(400, 5),
          sample(600, 8),
          sample(800, 5),
          sample(1_000, 10),
        ],
      });
      if (tied.kind !== 'evaluated') throw new Error('expected an evaluated result');
      expect(tied.limiting?.clearance_m).toBe(2);
      expect(tied.limiting?.index).toBe(1);
    });

    it('carries each location with its dataset and resolution', () => {
      const result = lineOfSight({
        distance_m: 1_000,
        earth_model: 'flat',
        observer_height_m: 0,
        target_height_m: 0,
        samples: [
          sample(0, 10, 'usgs_3dep', 1),
          sample(500, 5, 'srtm30m', 30.9),
          sample(1_000, 10, 'mapzen'),
        ],
      });
      if (result.kind !== 'evaluated') throw new Error('expected an evaluated result');
      expect(result.observer).toMatchObject({ dataset: 'usgs_3dep', resolution_m: 1 });
      expect(result.limiting).toMatchObject({ dataset: 'srtm30m', resolution_m: 30.9 });
      expect(result.target.dataset).toBe('mapzen');
      expect(result.target).not.toHaveProperty('resolution_m');
    });

    it('counts missing interior samples without data', () => {
      const result = lineOfSight({
        distance_m: 1_000,
        earth_model: 'flat',
        observer_height_m: 0,
        target_height_m: 0,
        samples: [
          sample(0, 10),
          sample(250, undefined),
          sample(500, undefined),
          sample(750, 0),
          sample(1_000, 10),
        ],
      });
      if (result.kind !== 'evaluated') throw new Error('expected an evaluated result');
      expect(result.missing_interior).toBe(2);
      expect(result.clearances).toHaveLength(1);
    });
  });
});

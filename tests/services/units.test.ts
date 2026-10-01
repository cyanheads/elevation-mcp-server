/**
 * @fileoverview Tests for the shared units: constants, rounding, and the foot conversion.
 * @module tests/services/units.test
 */

import { describe, expect, it } from 'vitest';
import {
  EARTH_RADIUS_M,
  ELEVATION_FLOOR_M,
  METERS_PER_DEGREE,
  METERS_PER_FOOT,
  metersToFeet,
  roundTo,
} from '@/services/elevation/units.js';

describe('constants', () => {
  it('uses the IUGG mean radius and the international foot', () => {
    expect(EARTH_RADIUS_M).toBe(6_371_008.8);
    expect(METERS_PER_FOOT).toBe(0.3048);
  });

  it('derives about 111,195 m per degree of latitude from the radius', () => {
    expect(METERS_PER_DEGREE).toBeCloseTo(111_195.08, 1);
    expect(METERS_PER_DEGREE).toBeCloseTo((Math.PI * EARTH_RADIUS_M) / 180, 6);
  });

  it('puts the plausibility floor below the deepest ocean point and above the no-data sentinels', () => {
    expect(ELEVATION_FLOOR_M).toBe(-12_000);
    expect(ELEVATION_FLOOR_M).toBeLessThan(-10_935);
    expect(ELEVATION_FLOOR_M).toBeGreaterThan(-32_768);
    expect(ELEVATION_FLOOR_M).toBeGreaterThan(-1_000_000);
  });
});

describe('roundTo', () => {
  it.each([
    [52.377716064, 2, 52.38],
    [52.377716064, 6, 52.377716],
    [30.94, 1, 30.9],
    [-4389, 2, -4389],
    [47.60620049, 6, 47.6062],
    [0.5, 0, 1],
    [-0.4, 0, 0],
  ])('roundTo(%d, %d) = %d', (value, decimals, expected) => {
    expect(roundTo(value, decimals)).toBe(expected);
  });

  it('never returns negative zero', () => {
    expect(Object.is(roundTo(-0.0000001, 6), 0)).toBe(true);
    expect(Object.is(roundTo(-0, 2), 0)).toBe(true);
    expect(Object.is(roundTo(-0.4, 0), 0)).toBe(true);
  });
});

describe('metersToFeet', () => {
  it.each([
    [0, 0],
    [1, 3.3],
    [100, 328.1],
    [52.38, 171.9],
    [4416.2, 14488.8],
    [-84.7, -277.9],
    [-4389, -14399.6],
  ])('%d m = %d ft (international foot, 1 decimal)', (meters, feet) => {
    expect(metersToFeet(meters)).toBe(feet);
  });
});

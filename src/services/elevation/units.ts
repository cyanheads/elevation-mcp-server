/**
 * @fileoverview Physical constants, the plausible elevation range, unit
 * conversion, and rounding shared by the elevation services, the geometry
 * module, and the tools.
 * @module services/elevation/units
 */

/** Mean earth radius in meters (IUGG). */
export const EARTH_RADIUS_M = 6_371_008.8;

/** Meters per degree of latitude on the mean sphere (π·R/180, about 111,195 m). */
export const METERS_PER_DEGREE = (Math.PI * EARTH_RADIUS_M) / 180;

/** One international foot in meters. */
export const METERS_PER_FOOT = 0.3048;

/** Speed of light in meters per microsecond, so a wavelength in meters is this over a frequency in MHz. */
export const SPEED_OF_LIGHT_M_PER_US = 299.792458;

/**
 * Plausibility floor in meters. Below the deepest ocean point (about −10,935 m),
 * so it never clips a real sea-floor depth, and above the provider no-data
 * sentinels (EPQS `-1000000`, integer rasters' `-32768`).
 */
export const ELEVATION_FLOOR_M = -12_000;

/**
 * Plausibility ceiling in meters. Above the highest summit (Everest, 8,849 m),
 * and far below the values whose rounding or summing overflows to `Infinity`.
 */
export const ELEVATION_CEILING_M = 9_000;

/** True when a provider value lies between the plausibility floor and ceiling, inclusive. */
export function isPlausibleElevation(value: number): boolean {
  return value >= ELEVATION_FLOOR_M && value <= ELEVATION_CEILING_M;
}

/** Rounds to a fixed number of decimals, returning a number (never `-0`). */
export function roundTo(value: number, decimals: number): number {
  const factor = 10 ** decimals;
  const rounded = Math.round(value * factor) / factor;
  return rounded === 0 ? 0 : rounded;
}

/** Converts meters to international feet, rounded to 1 decimal. */
export function metersToFeet(meters: number): number {
  return roundTo(meters / METERS_PER_FOOT, 1);
}

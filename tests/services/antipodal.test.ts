/**
 * @fileoverview Independent near-antipodal route regression tests.
 * @module tests/services/antipodal.test
 */
import { expect, it } from 'vitest';
import { interpolateGreatCircle, resamplePath } from '@/services/elevation/geometry.js';

it('preserves exact interpolation endpoints while endpoint-only antipodal routes are now rejected', () => {
  const start = { lat: 30, lon: 10 };
  const end = { lat: -30, lon: -170 };
  expect(interpolateGreatCircle(start, end, 0)).toEqual(start);
  expect(interpolateGreatCircle(start, end, 1)).toEqual(end);
  expect(resamplePath([start, end], 2).kind).toBe('antipodal');
});

it('rejects ambiguous segments even when samples skip their interiors, using submitted indices', () => {
  const a = { lat: 30, lon: 10 };
  const b = { lat: -30, lon: -170 };
  for (const count of [2, 3, 5]) {
    expect(resamplePath([a, a, b, a], count)).toMatchObject({
      kind: 'antipodal',
      start_index: 0,
      end_index: 2,
    });
  }
});

it.each([
  [
    { lat: 0, lon: 0 },
    { lat: 0, lon: 0.0000004 },
    { lat: 0, lon: 180 },
  ],
  [
    { lat: 0, lon: 180 },
    { lat: 0, lon: 179.9999996 },
    { lat: 0, lon: 0 },
  ],
])('checks segments created by rounding duplicate removal: %j', (...path) => {
  expect(resamplePath(path, 5)).toMatchObject({ kind: 'antipodal', start_index: 0, end_index: 2 });
});

it.each([
  { lat: -30, lon: -169.999 },
  { lat: -29.999, lon: -170 },
  { lat: -30, lon: -169.999999 },
])('keeps the unique shorter arc near %j', (end) => {
  const start = { lat: 30, lon: 10 };
  const vector = ({ lat, lon }: { lat: number; lon: number }) => {
    const p = (lat * Math.PI) / 180;
    const l = (lon * Math.PI) / 180;
    return [Math.cos(p) * Math.cos(l), Math.cos(p) * Math.sin(l), Math.sin(p)] as const;
  };
  const distance = (point: { lat: number; lon: number }) => {
    const [x, y, z] = vector(start);
    const [u, v, w] = vector(point);
    return (
      6371008.8 *
      Math.atan2(Math.hypot(y * w - z * v, z * u - x * w, x * v - y * u), x * u + y * v + z * w)
    );
  };
  const route = resamplePath([start, end], 5);
  expect(route.kind).toBe('ok');
  if (route.kind !== 'ok') throw new Error('expected unique arc');
  for (const sample of route.samples) {
    const rounded = { lat: Number(sample.lat.toFixed(6)), lon: Number(sample.lon.toFixed(6)) };
    expect(Math.abs(distance(rounded) - Number(sample.distance_m.toFixed(1)))).toBeLessThanOrEqual(
      0.2,
    );
  }
});

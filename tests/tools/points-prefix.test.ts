/**
 * @fileoverview Bounded point progress through the production tool contract.
 * @module tests/tools/points-prefix.test
 */
import { afterEach, expect, it } from 'vitest';
import { getPointsTool } from '@/mcp-server/tools/definitions/get-points.tool.js';
import { disposeElevationServices } from '@/services/elevation/elevation-sampler.js';
import { otdByPoint } from '../fixtures/harness.js';
import { contentText, runTool, structured, useUpstreams } from '../fixtures/tool-harness.js';

afterEach(() => disposeElevationServices());

it('follows printed continuation across distinct boundaries without mutating input or retaining results', async () => {
  const http = useUpstreams({
    otd: otdByPoint(({ lat, lon }) => ({ dataset: 'srtm30m', elevation: lat + lon })),
  });
  const original = Array.from({ length: 201 }, (_, index) => ({
    latitude: index / 100,
    lng: index / 100,
    metadata: { label: `position-${index}` },
  }));
  const before = structuredClone(original);
  let rest = original;
  for (const count of [201, 101, 1]) {
    const result = await runTool(getPointsTool, { points: rest, source: 'opentopodata' });
    expect(result.isError).toBeUndefined();
    const output = structured(result);
    const processed = Math.min(count, 100);
    expect(output).toMatchObject({
      requested_points: count,
      processed_points: processed,
      remaining_points: count - processed,
      next_offset: count > 100 ? 100 : null,
    });
    expect(output.points).toEqual(
      rest.slice(0, processed).map(({ latitude, lng }) => ({
        lat: latitude,
        lon: lng,
        status: 'ok',
        elevation_m: Math.round((latitude + lng) * 100) / 100,
        elevation_ft: Math.round(((latitude + lng) / 0.3048) * 10) / 10,
        dataset: 'srtm30m',
        resolution_m: 30.9,
      })),
    );
    const text = contentText(result);
    if (output.next_offset !== null) {
      const printed = text.match(/Continue with originalPoints\.slice\((\d+)\)/);
      expect(printed?.[1]).toBe(String(processed));
      rest = rest.slice(Number(printed?.[1]));
    } else expect(text).toContain('next_offset: null (exhausted)');
    output.points[0].lat = 89;
  }
  expect(http.calls).toHaveLength(3);
  expect(original).toEqual(before);
  const repeated = await runTool(getPointsTool, { points: original[0], source: 'opentopodata' });
  expect(structured(repeated).points[0].lat).toBe(0);
  expect(structured(repeated).requested_points).toBe(1);
});

it('counts duplicate coverage misses as positions and exhausts sliced continuations', async () => {
  const http = useUpstreams();
  const original = Array.from({ length: 201 }, () => ({ lat: 0, lon: 0 }));
  let rest = original;
  for (const count of [201, 101, 1]) {
    const result = await runTool(getPointsTool, { points: rest, source: 'usgs_3dep' });
    expect(result.isError).toBeUndefined();
    const output = structured(result);
    expect(output.requested_points).toBe(count);
    expect(output.points_with_data).toBe(0);
    expect(output.points).toHaveLength(Math.min(count, 100));
    expect(output.points.every((point: { status: string }) => point.status === 'no_data')).toBe(
      true,
    );
    if (output.next_offset === null) {
      expect(output.remaining_points).toBe(0);
      expect(contentText(result)).toContain('null (exhausted)');
    } else rest = rest.slice(output.next_offset);
  }
  expect(http.calls).toHaveLength(3);
  expect(original).toHaveLength(201);
});

it.each([1, 100, 101, 1000])('returns progress for %i positions', async (count) => {
  const http = useUpstreams();
  const points = Array.from({ length: count }, () => ({ latitude: 0, lng: 0 }));
  const result = await runTool(getPointsTool, { points, source: 'opentopodata' });
  expect(result.isError).toBeUndefined();
  const processed = Math.min(count, 100);
  expect(structured(result)).toMatchObject({
    requested_points: count,
    processed_points: processed,
    remaining_points: count - processed,
    next_offset: count > 100 ? 100 : null,
  });
  expect(structured(result).points).toHaveLength(processed);
  expect(contentText(result).split('\n')[1]).toBe(
    `Requested: ${count}; processed: ${processed}; remaining: ${count - processed}; next_offset: ${count > 100 ? 100 : 'null (exhausted)'}. Sampling cap: 100 positions.`,
  );
  expect(http.calls).toHaveLength(1);
});

it('validates an unserved tail only after slicing, and continues to exhaustion', async () => {
  useUpstreams();
  const original: unknown[] = Array.from({ length: 201 }, () => ({ lat: 0, lon: 0 }));
  original[200] = { lat: 'invalid' };
  let rest = original;
  for (const remaining of [101, 1]) {
    const result = await runTool(getPointsTool, { points: rest, source: 'opentopodata' });
    expect(result.isError).toBeUndefined();
    expect(structured(result).remaining_points).toBe(remaining);
    expect(contentText(result)).toContain('unvalidated');
    rest = rest.slice(structured(result).next_offset);
  }
  const invalid = await runTool(getPointsTool, { points: rest });
  expect(invalid.isError).toBe(true);
  expect(original[200]).toEqual({ lat: 'invalid' });
});

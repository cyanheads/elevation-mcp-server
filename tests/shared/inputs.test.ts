/**
 * @fileoverview Tests for the shared tool inputs: PointSchema, SourceSchema,
 * blankAsUnset, and boundedArray.
 * @module tests/shared/inputs.test
 */

import { z } from '@cyanheads/mcp-ts-core';
import { describe, expect, it } from 'vitest';
import {
  blankAsUnset,
  boundedArray,
  PointSchema,
  SourceSchema,
} from '@/mcp-server/tools/shared/inputs.js';

describe('PointSchema', () => {
  it('parses {lat, lon}', () => {
    expect(PointSchema.parse({ lat: 47.6062, lon: -122.3321 })).toEqual({
      lat: 47.6062,
      lon: -122.3321,
    });
  });

  it.each([[{ lat: 90, lon: 180 }], [{ lat: -90, lon: -180 }], [{ lat: 0, lon: 0 }]])(
    'accepts the boundary %j',
    (point) => {
      expect(PointSchema.parse(point)).toEqual(point);
    },
  );

  it('strips extra keys carried over from another tool output', () => {
    const parsed = PointSchema.parse({
      lat: 47.6,
      lon: -122.3,
      name: 'Pike Place',
      elevation_m: 52.4,
      dataset: 'usgs_3dep',
    });
    expect(parsed).toStrictEqual({ lat: 47.6, lon: -122.3 });
  });

  describe('key aliases', () => {
    it('maps latitude to lat', () => {
      expect(PointSchema.parse({ latitude: 47.6, lon: -122.3 })).toEqual({
        lat: 47.6,
        lon: -122.3,
      });
    });

    it.each(['longitude', 'lng', 'long'])('maps %s to lon', (key) => {
      expect(PointSchema.parse({ lat: 47.6, [key]: -122.3 })).toEqual({ lat: 47.6, lon: -122.3 });
    });

    it('accepts both aliases at once', () => {
      expect(PointSchema.parse({ latitude: 1, lng: 2 })).toEqual({ lat: 1, lon: 2 });
    });

    it('keeps lat and lon when an alias is sent alongside, and drops the alias', () => {
      expect(PointSchema.parse({ lat: 1, latitude: 99, lon: 2, lng: 99 })).toStrictEqual({
        lat: 1,
        lon: 2,
      });
    });

    it('does not guess between two longitude aliases', () => {
      const result = PointSchema.safeParse({ lat: 1, lng: 2, longitude: 3 });
      expect(result.success).toBe(false);
      expect(result.error?.issues[0]?.path).toEqual(['lon']);
    });

    it('names the missing key when a coordinate key is misspelled', () => {
      const lat = PointSchema.safeParse({ lt: 1, lon: 2 });
      expect(lat.success).toBe(false);
      expect(lat.error?.issues.map((issue) => issue.path)).toEqual([['lat']]);

      const lon = PointSchema.safeParse({ lat: 1, lan: 2 });
      expect(lon.error?.issues.map((issue) => issue.path)).toEqual([['lon']]);
    });
  });

  describe('rejections', () => {
    it.each([
      ['a [lat, lon] tuple', [47.6, -122.3]],
      ['a "lat,lon" string', '47.6,-122.3'],
      ['numeric strings', { lat: '47.6', lon: '-122.3' }],
      ['a null', null],
      ['undefined', undefined],
      ['a number', 47.6],
      ['a missing lon', { lat: 47.6 }],
      ['a missing lat', { lon: -122.3 }],
      ['an empty object', {}],
      ['a null coordinate', { lat: null, lon: 0 }],
      ['an infinite coordinate', { lat: Number.POSITIVE_INFINITY, lon: 0 }],
      ['a NaN coordinate', { lat: Number.NaN, lon: 0 }],
    ])('rejects %s', (_name, value) => {
      expect(PointSchema.safeParse(value).success).toBe(false);
    });

    it.each([
      ['lat above 90', { lat: 90.0001, lon: 0 }],
      ['lat below -90', { lat: -90.0001, lon: 0 }],
      ['lon above 180', { lat: 0, lon: 200 }],
      ['lon below -180', { lat: 0, lon: -180.0001 }],
    ])('rejects %s instead of wrapping it', (_name, value) => {
      const result = PointSchema.safeParse(value);
      expect(result.success).toBe(false);
    });
  });

  it('advertises only {lat, lon}, with no aliases', () => {
    const schema = z.toJSONSchema(PointSchema, { io: 'input' }) as {
      properties: Record<string, unknown>;
      required: string[];
    };
    expect(Object.keys(schema.properties)).toEqual(['lat', 'lon']);
    expect(schema.required).toEqual(['lat', 'lon']);
  });
});

describe('SourceSchema', () => {
  it.each([undefined, ''])('defaults %j to auto', (value) => {
    expect(SourceSchema.parse(value)).toBe('auto');
  });

  it.each(['auto', 'usgs_3dep', 'opentopodata'])('accepts %s', (value) => {
    expect(SourceSchema.parse(value)).toBe(value);
  });

  it.each([
    ['AUTO', 'auto'],
    ['  auto  ', 'auto'],
    ['USGS_3DEP', 'usgs_3dep'],
    ['usgs-3dep', 'usgs_3dep'],
    ['usgs 3dep', 'usgs_3dep'],
    ['Usgs-3Dep', 'usgs_3dep'],
    ['OpenTopoData', 'opentopodata'],
    ['Open Topo Data', 'opentopodata'],
    ['open-topo-data', 'opentopodata'],
    ['open_topo_data', 'opentopodata'],
  ])('normalizes %j to %s', (value, expected) => {
    expect(SourceSchema.parse(value)).toBe(expected);
  });

  it.each([
    ['3dep', 'usgs_3dep'],
    ['usgs', 'usgs_3dep'],
    ['epqs', 'usgs_3dep'],
    ['3DEP', 'usgs_3dep'],
    [' EPQS ', 'usgs_3dep'],
  ])('maps the alias %j to %s', (value, expected) => {
    expect(SourceSchema.parse(value)).toBe(expected);
  });

  it.each(['srtm', 'mapzen', 'opentopo', 'open_elevation', 'both', 'USGS_3DEP_ONLY'])(
    'rejects %j and lists the valid values',
    (value) => {
      const result = SourceSchema.safeParse(value);
      expect(result.success).toBe(false);
      const message = result.error?.issues[0]?.message ?? '';
      for (const valid of ['auto', 'usgs_3dep', 'opentopodata']) expect(message).toContain(valid);
    },
  );

  it.each([5, true, null, {}, []])('rejects the non-string %j', (value) => {
    expect(SourceSchema.safeParse(value).success).toBe(false);
  });

  it('advertises the three values and the auto default', () => {
    const schema = z.toJSONSchema(SourceSchema, { io: 'input' }) as {
      default: string;
      description: string;
      enum: string[];
    };
    expect(schema.enum).toEqual(['auto', 'usgs_3dep', 'opentopodata']);
    expect(schema.default).toBe('auto');
    expect(schema.description).toContain('3dep, usgs, and epqs are also aliases for usgs_3dep');
  });
});

describe('blankAsUnset', () => {
  const samples = blankAsUnset(z.number().int().min(2).max(250).default(100));

  it.each([undefined, ''])('lets the default apply for %j', (value) => {
    expect(samples.parse(value)).toBe(100);
  });

  it('passes a real value through', () => {
    expect(samples.parse(25)).toBe(25);
  });

  it('does not treat 0, false, or whitespace as blank', () => {
    expect(blankAsUnset(z.number().default(7)).parse(0)).toBe(0);
    expect(samples.safeParse('  ').success).toBe(false);
    expect(samples.safeParse(false).success).toBe(false);
  });

  it('still enforces the wrapped schema', () => {
    expect(samples.safeParse(1).success).toBe(false);
    expect(samples.safeParse(251).success).toBe(false);
    expect(samples.safeParse(10.5).success).toBe(false);
    expect(samples.safeParse('25').success).toBe(false);
  });

  it('works for an optional enum', () => {
    const model = blankAsUnset(z.enum(['flat', 'optical']).default('optical'));
    expect(model.parse('')).toBe('optical');
    expect(model.parse('flat')).toBe('flat');
  });

  it('advertises only the wrapped schema', () => {
    const schema = z.toJSONSchema(samples, { io: 'input' }) as Record<string, unknown>;
    expect(schema).toMatchObject({ type: 'integer', minimum: 2, maximum: 250, default: 100 });
  });
});

describe('boundedArray', () => {
  const list = boundedArray(z.number(), 1, 3);

  it('accepts min..max items', () => {
    expect(list.parse([1])).toEqual([1]);
    expect(list.parse([1, 2, 3])).toEqual([1, 2, 3]);
  });

  it('rejects an empty list and one over the maximum', () => {
    expect(list.safeParse([]).error?.issues[0]?.code).toBe('too_small');
    expect(list.safeParse([1, 2, 3, 4]).error?.issues[0]?.code).toBe('too_big');
  });

  it.each([
    ['a string', 'abc'],
    ['an object', { 0: 1 }],
    ['null', null],
    ['undefined', undefined],
  ])('rejects %s as not an array', (_name, value) => {
    const result = list.safeParse(value);
    expect(result.success).toBe(false);
    expect(result.error?.issues[0]?.code).toBe('invalid_type');
  });

  it('fails a huge valid list with exactly one maxItems issue', () => {
    const result = list.safeParse(Array.from({ length: 10_000 }, () => 1));
    expect(result.error?.issues).toHaveLength(1);
    expect(result.error?.issues[0]?.code).toBe('too_big');
  });

  it('does not modify the caller array', () => {
    const input = [1, 2, 3, 4, 5];
    list.safeParse(input);
    expect(input).toEqual([1, 2, 3, 4, 5]);
  });

  it('reports item errors by index', () => {
    const result = list.safeParse([1, 'x', 3]);
    expect(result.error?.issues[0]?.path).toEqual([1]);
  });

  it('fails a huge invalid list with exactly one maxItems issue', () => {
    const points = boundedArray(PointSchema, 1, 100);
    const result = points.safeParse(Array.from({ length: 10_000 }, () => ({ lat: 'x' })));
    expect(result.error?.issues).toHaveLength(1);
    expect(result.error?.issues[0]?.code).toBe('too_big');
  });
});

/**
 * @fileoverview Input schemas shared by every elevation tool: the point
 * object, the `source` selector, and the form-client and bounded-array wrappers.
 * @module mcp-server/tools/shared/inputs
 */

import { z } from '@cyanheads/mcp-ts-core';
import { createCounter, logger, requestContextService } from '@cyanheads/mcp-ts-core/utils';
import { getServerConfig } from '@/config/server-config.js';
import { SOURCE_MODES, type SourceMode } from '@/services/elevation/types.js';

type ScalarField = {
  kind: 'number' | 'boolean';
  tool: 'elevation_get_profile' | 'elevation_get_grid' | 'elevation_check_line_of_sight';
  field: string;
};

const scalarRewrites = createCounter(
  'elevation.optional_scalar_rewrites',
  'Optional scalar argument rewrites during parsing',
  '{rewrites}',
);

/** Applies the wrapped default to blank input and repairs explicitly marked scalars. JSON Schema advertises only the wrapped schema. */
export const blankAsUnset = <T extends z.ZodType>(schema: T, scalar?: ScalarField) =>
  z.preprocess((value) => {
    if (value === '') return;
    if (!scalar || typeof value !== 'string' || !getServerConfig().repairOptionalScalars) {
      return value;
    }
    const text = value.trim();
    let candidate: number | boolean;
    if (scalar.kind === 'number') {
      candidate = Number(text);
      if (!Number.isFinite(candidate) || String(candidate) !== text || text.includes('e')) {
        return value;
      }
    } else {
      if (text !== 'true' && text !== 'false') return value;
      candidate = text === 'true';
    }
    if (!schema.safeParse(candidate).success) return value;

    const { tool, field } = scalar;
    scalarRewrites.add(1, { tool, field });
    logger.info(
      'Rewrote optional scalar argument',
      requestContextService.createRequestContext({
        operation: tool,
        additionalContext: { tool, field },
      }),
    );
    return candidate;
  }, schema);

/**
 * An array of `min`–`max` items. An oversized array fails on its length alone:
 * the preprocess step raises the `too_big` issue itself, which stops the pipe
 * before any element is parsed, so a 10,000-item paste yields one issue rather
 * than one per bad field. The inner `.max(max)` never fires; it stays so
 * `toJSONSchema` still advertises `items`, `minItems`, and `maxItems`.
 */
export const boundedArray = <T extends z.ZodType>(item: T, min: number, max: number) =>
  z.preprocess((value, ctx) => {
    if (Array.isArray(value) && value.length > max) {
      ctx.addIssue({ code: 'too_big', origin: 'array', maximum: max, inclusive: true });
    }
    return value;
  }, z.array(item).min(min).max(max));

const LONGITUDE_ALIASES = ['longitude', 'lng', 'long'] as const;

/**
 * Moves `latitude` to `lat` when `lat` is absent, and exactly one of
 * `longitude` / `lng` / `long` to `lon` when `lon` is absent. One-to-one and
 * meaning-preserving; anything else is left for the schema to judge.
 */
function normalizePointKeys(value: unknown): unknown {
  if (value === null || typeof value !== 'object' || Array.isArray(value)) return value;
  const point: Record<string, unknown> = { ...value };
  if (point.lat === undefined && point.latitude !== undefined) {
    point.lat = point.latitude;
    delete point.latitude;
  }
  if (point.lon === undefined) {
    const present = LONGITUDE_ALIASES.filter((key) => point[key] !== undefined);
    const [alias] = present;
    if (present.length === 1 && alias) {
      point.lon = point[alias];
      delete point[alias];
    }
  }
  return point;
}

/**
 * A WGS84 point. Not strict: extra keys carried over from another tool's
 * output (a name, an elevation) are stripped, while `lat`/`lon` stay required.
 * This schema takes numeric coordinates. MCP tool argument repair also accepts
 * unambiguous numeric strings for canonical coordinate keys.
 */
export const PointSchema = z.preprocess(
  normalizePointKeys,
  z
    .object({
      lat: z.number().min(-90).max(90).describe('Latitude in decimal degrees (WGS84), -90 to 90.'),
      lon: z
        .number()
        .min(-180)
        .max(180)
        .describe('Longitude in decimal degrees (WGS84), -180 to 180.'),
    })
    .describe('A point as {lat, lon} in decimal degrees (WGS84).'),
);

/** A `Map`, so a caller's `constructor` or `__proto__` matches nothing and stays a string. */
const SOURCE_ALIASES: ReadonlyMap<string, SourceMode> = new Map([
  ['3dep', 'usgs_3dep'],
  ['usgs', 'usgs_3dep'],
  ['epqs', 'usgs_3dep'],
  ['open_topo_data', 'opentopodata'],
]);

/**
 * Blank → unset (so the default applies); otherwise trim, lowercase, turn
 * hyphens and spaces into underscores, then apply the alias table. Each alias
 * names exactly one source; `srtm` deliberately is not one.
 */
function normalizeSource(value: unknown): unknown {
  if (value === '') return;
  if (typeof value !== 'string') return value;
  const key = value.trim().toLowerCase().replace(/[-\s]/g, '_');
  return SOURCE_ALIASES.get(key) ?? key;
}

/** The `source` input every tool takes; defaults to `auto`. */
export const SourceSchema = z
  .preprocess(normalizeSource, z.enum(SOURCE_MODES).default('auto'))
  .describe(
    'Elevation source: auto (default) uses USGS 3DEP where it has data and Open Topo Data (SRTM, with Mapzen terrain tiles where SRTM has no data) for the rest; usgs_3dep uses 3DEP only; opentopodata uses Open Topo Data only. Case is ignored and spaces or hyphens read as underscores, so USGS-3DEP and open topo data are accepted; 3dep, usgs, and epqs are also aliases for usgs_3dep.',
  );

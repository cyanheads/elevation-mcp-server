/**
 * @fileoverview Vertical-reference parity across the four production tool contracts.
 * @module tests/tools/vertical-reference.test
 */
import { afterEach, expect, it } from 'vitest';
import { checkLineOfSightTool } from '@/mcp-server/tools/definitions/check-line-of-sight.tool.js';
import { getGridTool } from '@/mcp-server/tools/definitions/get-grid.tool.js';
import { getPointsTool } from '@/mcp-server/tools/definitions/get-points.tool.js';
import { getProfileTool } from '@/mcp-server/tools/definitions/get-profile.tool.js';
import { disposeElevationServices } from '@/services/elevation/elevation-sampler.js';
import { otdByPoint } from '../fixtures/harness.js';
import { contentText, runTool, structured, useUpstreams } from '../fixtures/tool-harness.js';

afterEach(() => disposeElevationServices());
const a = { lat: 0, lon: 0 };
const b = { lat: 0, lon: 0.001 };
const cases = [
  { tool: getPointsTool, input: { points: [a] } },
  { tool: getProfileTool, input: { path: [a, b], samples: 3 } },
  { tool: getGridTool, input: { south: 0, west: 0, north: 0.001, east: 0.001, rows: 2, cols: 2 } },
  { tool: checkLineOfSightTool, input: { observer: a, target: b, samples: 3 } },
];

it.each(cases)(
  '$tool.name renders the height reference on both surfaces',
  async ({ tool, input }) => {
    useUpstreams({ baseUrl: 'https://api.opentopodata.org' });
    const result = await runTool(tool, { ...input, source: 'opentopodata' });
    expect(result.isError).toBeUndefined();
    const reference = structured(result).vertical_reference;
    expect(reference).toContain('srtm30m');
    expect(reference).toContain('EGM96');
    expect(reference).toContain('without transformation');
    expect(contentText(result)).toContain(reference);
  },
);

it('does not infer a self-hosted raster reference from its dataset alias', async () => {
  useUpstreams();
  const result = await runTool(getPointsTool, { points: [a], source: 'opentopodata' });
  expect(structured(result).vertical_reference).toContain('self-hosted');
  expect(structured(result).vertical_reference).toContain('unverified');
  expect(structured(result).vertical_reference).not.toContain('EGM96');
  expect(structured(result).points[0].elevation_m).toBe(100);
});

it('establishes no reference when every point has no data', async () => {
  useUpstreams({ otd: otdByPoint(() => ({ dataset: 'mapzen', elevation: null })) });
  const result = await runTool(getPointsTool, { points: [a], source: 'opentopodata' });
  expect(result.isError).toBeUndefined();
  expect(structured(result).vertical_reference).toContain('No height reference was established');
  expect(contentText(result)).toContain(structured(result).vertical_reference);
});

/**
 * @fileoverview ImageServer routes and captured response shapes for fetch-mock tests.
 * @module tests/fixtures/usgs-image-server
 */

import type { FetchMockResponder, FetchMockRoute } from '@cyanheads/mcp-ts-core/testing';
import type { LatLon } from '@/services/elevation/types.js';
import { EPQS_ORIGIN, EPQS_PATH } from './epqs.js';

const IMAGE_SERVER =
  'https://elevation.nationalmap.gov/arcgis/rest/services/3DEPElevation/ImageServer';
export const IMAGE_SAMPLE_URL = `${IMAGE_SERVER}/getSamples`;
export const CATALOG_URL = `${IMAGE_SERVER}/query`;

/** Matches the batch sampling endpoint only. */
export function imageSamplesRoute(respond: FetchMockResponder): FetchMockRoute {
  return { method: 'POST', match: IMAGE_SAMPLE_URL, respond };
}

/** Matches the raster catalog endpoint only. */
export function catalogRoute(respond: FetchMockResponder): FetchMockRoute {
  return { method: 'POST', match: CATALOG_URL, respond };
}

/** Produces a catalog response, using the observed numeric date representation. */
export function catalogResponse(features: readonly { id: number; epoch?: unknown }[]): Response {
  return Response.json({
    features: features.map(({ id, epoch }) => ({
      attributes: { OBJECTID: id, AcquisitionDate: epoch },
    })),
  });
}

/** Default test catalog for the raster ID in epqsHitBody(). */
export const defaultCatalogResponse = () => catalogResponse([{ id: 102575, epoch: 1625788800000 }]);

/** Reads the submitted WGS84 points in input order. */
export async function parseImageSamplePoints(request: Request): Promise<LatLon[]> {
  const form = new URLSearchParams(await request.text());
  const { points } = JSON.parse(form.get('geometry') ?? '') as { points: [number, number][] };
  return points.map(([lon, lat]) => ({ lon, lat }));
}

/** Creates a getSamples row with the requested coordinate and zero-based input offset. */
export function imageSampleRow(
  { lat, lon }: LatLon,
  locationId: number,
  fields: { value: string | number; rasterId?: number; resolution?: number },
) {
  return { location: { x: lon, y: lat }, locationId, ...fields };
}

/** Adapts coordinate-based terrain fixtures to both USGS wire shapes. */
export function imageSamplesFromEpqs(epqs: FetchMockResponder): FetchMockResponder {
  return async (request) => {
    const points = await parseImageSamplePoints(request);
    const rows = await Promise.all(
      points.map(async (point, index) => {
        const url = new URL(EPQS_PATH, EPQS_ORIGIN);
        url.searchParams.set('x', point.lon.toFixed(6));
        url.searchParams.set('y', point.lat.toFixed(6));
        const response =
          typeof epqs === 'function'
            ? await epqs(new Request(url, { signal: request.signal }))
            : epqs.clone();
        if (!response.ok) return;
        try {
          const body = (await response.json()) as Parameters<typeof imageSampleRow>[2];
          if (body?.value !== undefined) {
            return imageSampleRow(point, index, {
              value: body.value,
              ...(body.rasterId !== undefined && { rasterId: body.rasterId }),
              ...(body.resolution !== undefined && { resolution: body.resolution }),
            });
          }
        } catch (error) {
          if (!(error instanceof SyntaxError)) throw error;
        }
        return;
      }),
    );
    return Response.json({ samples: rows.filter((row) => row !== undefined) });
  };
}

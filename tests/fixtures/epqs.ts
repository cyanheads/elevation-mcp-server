/**
 * @fileoverview Recorded USGS EPQS response bodies (docs/design.md § API Reference)
 * and Response builders, shared by every test that drives the EPQS client.
 * @module tests/fixtures/epqs
 */

export const EPQS_ORIGIN = 'https://epqs.nationalmap.gov';
export const EPQS_PATH = '/v1/json';

/** Builds a 200 hit body in the shape EPQS returns (value is a string for units=Meters). */
export function epqsHitBody(
  fields: {
    acquisitionDate?: string | null;
    lat?: number;
    lon?: number;
    rasterId?: number | null;
    resolution?: number | null;
    value?: string | number | null;
  } = {},
): string {
  const {
    acquisitionDate = '6/5/2021',
    lat = 47.6062,
    lon = -122.3321,
    rasterId = 102575,
    resolution = 1,
    value = '52.377716064',
  } = fields;
  return JSON.stringify({
    location: { x: lon, y: lat, spatialReference: { wkid: 4326, latestWkid: 4326 } },
    locationId: 0,
    ...(value !== null && { value }),
    ...(rasterId !== null && { rasterId }),
    ...(resolution !== null && { resolution }),
    ...(acquisitionDate !== null && { attributes: { AcquisitionDate: acquisitionDate } }),
  });
}

/** Seattle, 1 m lidar raster, string value. */
export const EPQS_HIT_SEATTLE = epqsHitBody();

/** The Feet variant: numeric value (the client always requests Meters, but accepts both). */
export const EPQS_HIT_NUMERIC_VALUE = epqsHitBody({ value: 171.84290597141376 });

/** Resolution in degrees: 1/9 arc-second (Guam), 1/3 arc-second, 1 arc-second. */
export const EPQS_RESOLUTION_NINTH_ARCSEC = 0.0000308642;
export const EPQS_RESOLUTION_THIRD_ARCSEC = 0.0000925926;
export const EPQS_RESOLUTION_ONE_ARCSEC = 0.0002777777796234786;

/** The four miss texts EPQS answers with on HTTP 200 (wording varies between identical requests). */
export const EPQS_MISS_TEXTS = {
  invalidParameters: 'Invalid or missing input parameters.',
  callFailed: 'Call failed.  [Failed cloud operation: Open, Path: /vsimem/_a1b2c3_aux.xml]',
  transformationUnavailable: 'Transformation is unavailable for the current image.',
  emptyGeometry: 'The operation was attempted on an empty geometry.',
} as const;

/** Also a 200 plain-text body: an unknown `wkid`. */
export const EPQS_MISS_SPATIAL_REFERENCE = "'spatialReference' parameter is invalid.";

/** The historical no-data sentinel, as a hit-shaped body. */
export const EPQS_SENTINEL_BODY = epqsHitBody({ value: '-1000000', rasterId: -1 });

/** 400 body for a missing parameter, with its leading space. */
export const EPQS_BAD_REQUEST_BODY = ' {"errorMessage" : "[BadRequest] missing parameters"}';

/** 403 body for a wrong path. */
export const EPQS_FORBIDDEN_BODY = '{"message":"Missing Authentication Token"}';

/** A JSON hit padded past the 16 KiB read ceiling. */
export function epqsOversizedBody(): string {
  return JSON.stringify({
    ...JSON.parse(EPQS_HIT_SEATTLE),
    padding: 'x'.repeat(17 * 1024),
  });
}

/** An EPQS-style response: JSON content type even for plain-text bodies, as the live service sends. */
export function epqsResponse(
  body: string,
  status = 200,
  headers: Record<string, string> = {},
): Response {
  return new Response(body, {
    status,
    headers: { 'content-type': 'application/json', ...headers },
  });
}

/**
 * @fileoverview Recorded Open Topo Data response bodies (docs/design.md § API
 * Reference) and Response builders, shared by every test that drives the Open
 * Topo Data client. The public instance's 404 and 429 bodies were never
 * observed; those two are stand-ins shaped like the instance's other errors.
 * @module tests/fixtures/opentopodata
 */

export const OTD_PUBLIC_BASE_URL = 'https://api.opentopodata.org';
export const OTD_SELF_HOSTED_BASE_URL = 'https://topo.example.test';
export const OTD_PATH = '/v1/srtm30m,mapzen';

/** What the upstream answers for one location. `null` is a null elevation. */
export type OtdAnswer =
  | { dataset: string; elevation: number | null }
  | { dataset?: undefined; elevation: null };

/** Parses the `locations` string a request sent into `{lat, lon}` pairs. */
export function parseSentLocations(body: string): { lat: number; lon: number }[] {
  const { locations } = JSON.parse(body) as { locations: string };
  return locations.split('|').map((pair) => {
    const [lat, lon] = pair.split(',').map(Number);
    return { lat: lat as number, lon: lon as number };
  });
}

/**
 * Builds a 200 body for `points`, one answer per point, echoing each location
 * as the upstream does (`lat`/`lng`, parsed floats).
 */
export function otdOkBody(
  points: readonly { lat: number; lon: number }[],
  answers: readonly OtdAnswer[],
): string {
  return JSON.stringify({
    results: points.map((point, index) => ({
      dataset: answers[index]?.dataset ?? 'mapzen',
      elevation: answers[index]?.elevation ?? null,
      location: { lat: point.lat, lng: point.lon },
    })),
    status: 'OK',
  });
}

/** Seattle (SRTM 59 m), open Pacific (Mapzen −4,389 m), and Tromsø (Mapzen 9 m): the recorded stack. */
export const OTD_MIXED_POINTS = [
  { lat: 47.6062, lon: -122.3321 },
  { lat: 30, lon: -140 },
  { lat: 69.65, lon: 18.96 },
] as const;
export const OTD_MIXED_ANSWERS: readonly OtdAnswer[] = [
  { dataset: 'srtm30m', elevation: 59 },
  { dataset: 'mapzen', elevation: -4389 },
  { dataset: 'mapzen', elevation: 9 },
];

/** A null elevation still names the last dataset whose bounds held the point. */
export const OTD_NULL_ANSWER: OtdAnswer = { dataset: 'mapzen', elevation: null };

export const OTD_400_TOO_MANY_LOCATIONS =
  '{"error":"Too many locations provided (101), the limit is 100.","status":"INVALID_REQUEST"}';
export const OTD_400_UNKNOWN_DATASET =
  '{"error":"Dataset \'mapzenx\' not in config.","status":"INVALID_REQUEST"}';
export const OTD_400_NO_VALID_DATASET =
  '{"error":"No valid dataset provided.","status":"INVALID_REQUEST"}';
export const OTD_400_UNPARSEABLE_LOCATION =
  '{"error":"Unable to parse location \'95,10\' in position 1. Latitude must be between -90 and 90. Provide locations in lat,lon order.","status":"INVALID_REQUEST"}';
export const OTD_400_INVALID_JSON = '{"error":"Invalid JSON.","status":"INVALID_REQUEST"}';
export const OTD_404_BODY = '{"error":"Not found.","status":"INVALID_REQUEST"}';
export const OTD_429_BODY = '{"error":"Rate limit exceeded.","status":"INVALID_REQUEST"}';
export const OTD_500_BODY = '{"error":"Internal server error.","status":"SERVER_ERROR"}';

/** A JSON response, as the upstream sends every body. */
export function otdResponse(
  body: string,
  status = 200,
  headers: Record<string, string> = {},
): Response {
  return new Response(body, {
    status,
    headers: { 'content-type': 'application/json', ...headers },
  });
}

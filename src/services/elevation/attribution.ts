/**
 * @fileoverview Source attribution for elevation results: one line per dataset
 * that answered, including Mapzen's required multi-source attribution.
 * @module services/elevation/attribution
 */

import { DATASETS, type Dataset } from './types.js';

/** Mapzen terrain tiles' required attribution (tilezen/joerd `docs/attribution.md`), verbatim. */
export const MAPZEN_ATTRIBUTION = `* ArcticDEM terrain data DEM(s) were created from DigitalGlobe, Inc., imagery and
  funded under National Science Foundation awards 1043681, 1559691, and 1542736;
* Australia terrain data © Commonwealth of Australia (Geoscience Australia) 2017;
* Austria terrain data © offene Daten Österreichs – Digitales Geländemodell (DGM)
  Österreich;
* Canada terrain data contains information licensed under the Open Government
  Licence – Canada;
* Europe terrain data produced using Copernicus data and information funded by the
  European Union - EU-DEM layers;
* Global ETOPO1 terrain data U.S. National Oceanic and Atmospheric Administration
* Mexico terrain data source: INEGI, Continental relief, 2016;
* New Zealand terrain data Copyright 2011 Crown copyright (c) Land Information New
  Zealand and the New Zealand Government (All rights reserved);
* Norway terrain data © Kartverket;
* United Kingdom terrain data © Environment Agency copyright and/or database right
  2015. All rights reserved;
* United States 3DEP (formerly NED) and global GMTED2010 and SRTM terrain data
  courtesy of the U.S. Geological Survey.`;

const ATTRIBUTION_LINES: Record<Dataset, string> = {
  usgs_3dep:
    'USGS 3D Elevation Program (3DEP), courtesy of the U.S. Geological Survey (public domain).',
  srtm30m:
    'SRTM GL1 v3 via Open Topo Data, courtesy of the U.S. Geological Survey and NASA (public domain).',
  mapzen: `Mapzen terrain tiles via Open Topo Data:\n${MAPZEN_ATTRIBUTION}`,
};

/** Returned when no dataset answered any value. */
export const NO_DATASET_ATTRIBUTION = 'No dataset returned elevation data.';

/**
 * Credits every dataset that answered at least one value, one line each in
 * the order usgs_3dep, srtm30m, mapzen. Accepts samples, grid cells, or any
 * value carrying an optional `dataset`.
 */
export function attributionFor(values: Iterable<{ dataset?: Dataset | undefined } | null>): string {
  const answered = new Set<Dataset>();
  for (const value of values) {
    if (value?.dataset) answered.add(value.dataset);
  }
  const lines = DATASETS.filter((dataset) => answered.has(dataset)).map(
    (dataset) => ATTRIBUTION_LINES[dataset],
  );
  return lines.length > 0 ? lines.join('\n') : NO_DATASET_ATTRIBUTION;
}

/** Height-reference context for answering datasets; dataset aliases never establish a custom raster's datum. */
export function verticalReferenceFor(
  values: Iterable<{ dataset?: Dataset | undefined } | null>,
  publicOpenTopoData: boolean,
): string {
  const answered = new Set(Array.from(values, (value) => value?.dataset));
  const lines = DATASETS.filter((dataset) => answered.has(dataset)).map((dataset) => {
    if (dataset === 'usgs_3dep')
      return 'usgs_3dep: NAVD88 is typical in the conterminous US; the exact returned raster reference is unverified and can vary elsewhere.';
    if (!publicOpenTopoData)
      return `${dataset}: self-hosted Open Topo Data height reference is unverified (unknown/variable); dataset names do not establish the raster datum.`;
    return dataset === 'srtm30m'
      ? 'srtm30m: public SRTM heights use EGM96.'
      : 'mapzen: height reference is unknown/variable across its source rasters.';
  });
  if (lines.length === 0)
    return 'No height reference was established because no dataset returned elevation data. Heights are returned without transformation.';
  if (lines.length > 1) lines.push('Mixed datasets are not normalized to a common vertical datum.');
  lines.push('Heights are returned without transformation.');
  return lines.join(' ');
}

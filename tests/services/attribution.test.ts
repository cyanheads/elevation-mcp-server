/**
 * @fileoverview Tests for attributionFor and the Mapzen attribution block.
 * @module tests/services/attribution.test
 */

import { describe, expect, it } from 'vitest';
import {
  attributionFor,
  MAPZEN_ATTRIBUTION,
  NO_DATASET_ATTRIBUTION,
} from '@/services/elevation/attribution.js';
import type { Dataset } from '@/services/elevation/types.js';

const USGS_LINE =
  'USGS 3D Elevation Program (3DEP), courtesy of the U.S. Geological Survey (public domain).';
const SRTM_LINE =
  'SRTM GL1 v3 via Open Topo Data, courtesy of the U.S. Geological Survey and NASA (public domain).';

/** The block as tilezen/joerd `docs/attribution.md` publishes it (docs/design.md § API Reference). */
const MAPZEN_BLOCK = [
  '* ArcticDEM terrain data DEM(s) were created from DigitalGlobe, Inc., imagery and',
  '  funded under National Science Foundation awards 1043681, 1559691, and 1542736;',
  '* Australia terrain data © Commonwealth of Australia (Geoscience Australia) 2017;',
  '* Austria terrain data © offene Daten Österreichs – Digitales Geländemodell (DGM)',
  '  Österreich;',
  '* Canada terrain data contains information licensed under the Open Government',
  '  Licence – Canada;',
  '* Europe terrain data produced using Copernicus data and information funded by the',
  '  European Union - EU-DEM layers;',
  '* Global ETOPO1 terrain data U.S. National Oceanic and Atmospheric Administration',
  '* Mexico terrain data source: INEGI, Continental relief, 2016;',
  '* New Zealand terrain data Copyright 2011 Crown copyright (c) Land Information New',
  '  Zealand and the New Zealand Government (All rights reserved);',
  '* Norway terrain data © Kartverket;',
  '* United Kingdom terrain data © Environment Agency copyright and/or database right',
  '  2015. All rights reserved;',
  '* United States 3DEP (formerly NED) and global GMTED2010 and SRTM terrain data',
  '  courtesy of the U.S. Geological Survey.',
].join('\n');

const answered = (...datasets: (Dataset | undefined)[]) =>
  datasets.map((dataset) => (dataset === undefined ? {} : { dataset }));

describe('MAPZEN_ATTRIBUTION', () => {
  it('is the published multi-source block, verbatim', () => {
    expect(MAPZEN_ATTRIBUTION).toBe(MAPZEN_BLOCK);
  });

  it('credits all eleven sources', () => {
    expect(MAPZEN_ATTRIBUTION.match(/^\* /gm)).toHaveLength(11);
    for (const source of [
      'ArcticDEM',
      'Australia',
      'Austria',
      'Canada',
      'Europe',
      'ETOPO1',
      'Mexico',
      'New Zealand',
      'Norway',
      'United Kingdom',
      'GMTED2010',
    ]) {
      expect(MAPZEN_ATTRIBUTION).toContain(source);
    }
  });
});

describe('attributionFor', () => {
  it('credits 3DEP alone', () => {
    expect(attributionFor(answered('usgs_3dep'))).toBe(USGS_LINE);
  });

  it('credits SRTM alone', () => {
    expect(attributionFor(answered('srtm30m'))).toBe(SRTM_LINE);
  });

  it('credits Mapzen with the full block as one paragraph under a heading line', () => {
    expect(attributionFor(answered('mapzen'))).toBe(
      `Mapzen terrain tiles via Open Topo Data:\n${MAPZEN_BLOCK}`,
    );
  });

  it('joins one line per dataset in the order 3DEP, SRTM, Mapzen whatever order the values arrive in', () => {
    const expected = `${USGS_LINE}\n${SRTM_LINE}\nMapzen terrain tiles via Open Topo Data:\n${MAPZEN_BLOCK}`;
    expect(attributionFor(answered('mapzen', 'srtm30m', 'usgs_3dep'))).toBe(expected);
    expect(attributionFor(answered('usgs_3dep', 'mapzen', 'srtm30m'))).toBe(expected);
  });

  it('lists a dataset once however many values it answered', () => {
    const text = attributionFor(answered('srtm30m', 'srtm30m', 'usgs_3dep', 'srtm30m'));
    expect(text).toBe(`${USGS_LINE}\n${SRTM_LINE}`);
  });

  it('omits Mapzen when no value came from it', () => {
    expect(attributionFor(answered('usgs_3dep', 'srtm30m'))).not.toContain('Mapzen');
  });

  it('ignores values with no dataset and null grid cells', () => {
    expect(attributionFor([null, {}, { dataset: undefined }, { dataset: 'srtm30m' }, null])).toBe(
      SRTM_LINE,
    );
  });

  it.each([
    ['an empty list', []],
    ['values without a dataset', answered(undefined, undefined)],
    ['only null cells', [null, null]],
  ])('reports that no dataset answered for %s', (_name, values) => {
    expect(attributionFor(values)).toBe(NO_DATASET_ATTRIBUTION);
    expect(NO_DATASET_ATTRIBUTION).toBe('No dataset returned elevation data.');
  });

  it('accepts any iterable, not just arrays', () => {
    function* cells() {
      yield { dataset: 'usgs_3dep' as const };
      yield null;
    }
    expect(attributionFor(cells())).toBe(USGS_LINE);
    expect(attributionFor(new Set([{ dataset: 'srtm30m' as const }]))).toBe(SRTM_LINE);
  });
});

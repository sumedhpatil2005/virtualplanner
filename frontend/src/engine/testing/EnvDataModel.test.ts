import { describe, expect, it } from 'vitest';
import { classLine, clipBbox, envDataStatus, hasMapToggle, istDate, legendOf, lineFootprint, mergeCatalogue, rampCss, renderWidth, seriesPath } from '../../components/environment/envDataModel';
import type { EnvironmentLayer } from '../../lib/coordinationApi';
import type { EnvDataLayer } from '../../lib/envDataApi';

const coord = (id: string, domain: string, status: 'available' | 'not_imported'): EnvironmentLayer => ({
  id, domain, name: id, status, status_label: status, status_source: '', source: '', licence: '', data_date: null, limitations: '', recommended_sources: [],
});
const env = (id: string, group: string, status: EnvDataLayer['status'], extra: Partial<EnvDataLayer> = {}): EnvDataLayer => ({
  id, group, name: id, kind: 'raster', status, status_reason: status === 'available' ? '' : 'reason', source: 'S', publisher: 'P', licence: 'CC BY 4.0',
  licence_url: null, attribution: '', data_date: '2021', vintage_note: '', data_class: 'derived', suitability: 'screening', limitations: '', legend: null,
  variants: [], covers: [], bounds: [73.7, 18.4, 74.05, 18.7], processing: null, ...extra,
});

describe('environment data catalogue merge', () => {
  it('replaces a not-imported coordination row it covers, keeps available OSM rows, groups by domain', () => {
    const g = mergeCatalogue(
      [coord('land_cover', 'vegetation', 'not_imported'), coord('osm_trees', 'vegetation', 'available'), coord('noise', 'noise', 'not_imported')],
      [env('landcover_worldcover2021', 'vegetation', 'available', { covers: ['land_cover'] }), env('s2_builtup_change', 'other', 'rejected')],
    );
    const veg = g.find(x => x.id === 'vegetation')!;
    expect(veg.rows.map(r => r.layer.id).sort()).toEqual(['landcover_worldcover2021', 'osm_trees']);
    expect(veg.superseded).toEqual(['land_cover']);
    expect(veg.available).toBe(2);
    expect(g.find(x => x.id === 'noise')!.rows).toHaveLength(1);           // nothing covers noise: stays Not imported
    expect(g.find(x => x.id === 'other')!.rows[0].layer.id).toBe('s2_builtup_change');
  });
  it('never supersedes when the covering dataset is the only thing missing', () => {
    const g = mergeCatalogue([coord('soil', 'soil', 'not_imported')], [env('soil_soilgrids', 'ground', 'missing', { covers: ['soil'] })]);
    const ground = g.find(x => x.id === 'ground')!;
    expect(ground.rows.map(r => r.layer.id)).toEqual(['soil_soilgrids']);
    expect(ground.available).toBe(0);
    expect(envDataStatus(ground.rows[0].layer as EnvDataLayer)).toEqual({ status: 'not_imported' });
  });
  it('blocked/rejected/missing rows have no map toggle; available renderers do', () => {
    expect(hasMapToggle(env('a', 'water', 'blocked', { kind: 'none' }))).toBe(false);
    expect(hasMapToggle(env('a', 'water', 'rejected'))).toBe(false);
    expect(hasMapToggle(env('a', 'water', 'missing'))).toBe(false);
    expect(hasMapToggle(env('a', 'water', 'available'))).toBe(true);
    expect(hasMapToggle(env('a', 'water', 'available', { kind: 'series' }))).toBe(false);
  });
  it('status carries source/date/licence and the variant date; class line never says engineering for screening data', () => {
    const l = env('s2_ndvi', 'vegetation', 'available', { variants: [{ id: '2019', label: '2019-11-26', data_date: '2019-11-26 (scene date, UTC)', available: true }] });
    expect(envDataStatus(l, '2019')).toEqual({ status: 'available', source: 'P', date: '2019-11-26 (scene date, UTC)', licence: 'CC BY 4.0', url: undefined });
    expect(classLine(l)).toBe('Derived · screening only');
    expect(classLine({ data_class: 'observed', suitability: 'screening' })).toBe('Observed · screening only');
  });
  it('variant legend overrides the layer legend', () => {
    const ramp = { type: 'ramp' as const, unit: '%', label: 'Sand', stops: [{ value: 25, color: '#000000' }, { value: 40, color: '#ffffff' }] };
    const l = env('soil', 'ground', 'available', { legend: { type: 'categorical', items: [] }, variants: [{ id: 'sand', label: 'Sand', legend: ramp, available: true }] });
    expect(legendOf(l, 'sand')).toBe(ramp);
    expect(legendOf(l, null)).toEqual({ type: 'categorical', items: [] });
    expect(rampCss(ramp.stops)).toBe('linear-gradient(90deg, #000000 0.0%, #ffffff 100.0%)');
  });
});

describe('environment data geometry helpers', () => {
  it('clips the view to the layer bounds or reports no overlap', () => {
    expect(clipBbox([73, 18, 74, 19], [73.7, 18.4, 74.05, 18.7])).toEqual([73.7, 18.4, 74, 18.7]);
    expect(clipBbox([70, 10, 71, 11], [73.7, 18.4, 74.05, 18.7])).toBeNull();
    expect(clipBbox([1, 2, 3, 4], null)).toEqual([1, 2, 3, 4]);
    expect(renderWidth([0, 0, 10, 10], [0, 0, 5, 10], 1440)).toBe(720);
    expect(renderWidth([0, 0, 1, 1], [0, 0, 1, 1], 4000)).toBe(1600);
  });
  it('builds a closed footprint polygon of about the right width', () => {
    const g = lineFootprint([[73.85, 18.52], [73.86, 18.52]], 20)!;
    const ring = g.coordinates[0];
    expect(ring[0]).toEqual(ring[ring.length - 1]);
    const dLat = Math.abs(ring[0][1] - ring[ring.length - 2][1]);
    expect(dLat * 110540).toBeCloseTo(20, 1);
    expect(lineFootprint([[73.85, 18.52]], 20)).toBeNull();
    expect(lineFootprint([[73.85, 18.52], [73.86, 18.52]], 0)).toBeNull();
  });
  it('series path spans the box and includes zero in the range', () => {
    const { d, min, max } = seriesPath([10, 20, 15], 100, 50);
    expect(min).toBe(0);
    expect(max).toBe(20);
    expect(d.startsWith('M2.0,')).toBe(true);
    expect(d.split('L')).toHaveLength(3);
    expect(seriesPath([], 10, 10).d).toBe('');
    expect(istDate('2024-01-01T05:30:00+05:30')).toBe('2024-01-01 IST');
    expect(istDate(null)).toBe('unknown');
  });
});

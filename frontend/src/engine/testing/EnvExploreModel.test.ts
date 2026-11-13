import { describe, expect, it } from 'vitest';
import { groupCatalogue, dataStatusOf, MAP_TOGGLES } from '../../components/environment/envCatalogue';
import { cityStats, groupLayers, searchObjects, summarise, lineLengthKm } from '../../components/explore/exploreModel';
import type { EnvironmentLayer } from '../../lib/coordinationApi';
import type { CityObject } from '../objects/types';

const row = (id: string, domain: string, status: 'available' | 'not_imported', extra: Partial<EnvironmentLayer> = {}): EnvironmentLayer => ({
  id, domain, name: id, status, status_label: status, status_source: '', source: '', licence: '', data_date: null, limitations: '', recommended_sources: [], ...extra,
});

describe('environment catalogue grouping', () => {
  it('puts every row in one group, unmapped domains in Other, available first', () => {
    const g = groupCatalogue([row('b', 'water', 'not_imported'), row('a', 'flood', 'available'), row('x', 'mystery', 'not_imported'), row('m', 'metro', 'available')]);
    const total = g.reduce((n, x) => n + x.layers.length, 0);
    expect(total).toBe(4);
    const water = g.find(x => x.id === 'water')!;
    expect(water.layers.map(l => l.id)).toEqual(['a', 'b']);
    expect(water.available).toBe(1);
    expect(g.find(x => x.id === 'other')!.layers[0].id).toBe('x');
    expect(g.map(x => x.label)).toEqual(expect.arrayContaining(['Water & flooding', 'Ground & geology', 'Air', 'Noise', 'Heat', 'Vegetation', 'Heritage & protected']));
  });
  it('not imported is never available; available keeps source/date/licence', () => {
    expect(dataStatusOf(row('a', 'air', 'not_imported', { source: 'x' }))).toEqual({ status: 'not_imported' });
    expect(dataStatusOf(row('w', 'water', 'available', { source: 'OSM', licence: 'ODbL', data_date: '2026-11-02T00:00:00Z' }))).toEqual({ status: 'available', source: 'OSM', date: '2026-11-02', licence: 'ODbL' });
  });
  it('only layers with a renderer get a map toggle', () => {
    expect(Object.keys(MAP_TOGGLES).sort()).toEqual(['osm_heritage', 'osm_metro', 'osm_railway', 'osm_water']);
  });
});

const road = (id: string, name: string, osmId: number, coords: number[][], scenarioId = 'base') =>
  ({ id, type: 'road', name, layerId: 'roads', scenarioId, coordinates: coords, laneCount: 2, width: 7, speedLimit: 40, isOneWay: false, osmProvenance: { osmId } } as unknown as CityObject);

describe('explore model', () => {
  const objs = [
    road('r1', 'FC Road', 1111, [[73.84, 18.52, 0], [73.85, 18.52, 0]]),
    road('r2', 'FC Road', 2222, [[73.85, 18.52, 0], [73.86, 18.52, 0]]),
    road('r3', 'JM Road', 3333, [[73.84, 18.53, 0], [73.84, 18.54, 0]], 'alt1'),
    { id: 'b1', type: 'building', name: 'Library', layerId: 'buildings', scenarioId: 'base', coordinates: [], height: 12, valueCertainty: { height: 'hypothetical' } } as unknown as CityObject,
    { id: 'j1', type: 'junction', name: '', layerId: 'junctions', scenarioId: 'base', coordinates: [73.85, 18.52, 0], hasSignals: true, signalTiming: 90, connectedRoads: ['r1', 'r2'] } as unknown as CityObject,
  ];
  it('searches by name (one hit per name) and by OSM id', () => {
    expect(searchObjects(objs, 'fc road').map(o => o.id)).toEqual(['r1']);
    expect(searchObjects(objs, '2222').map(o => o.id)).toEqual(['r2']);
    expect(searchObjects(objs, 'way/3333').map(o => o.id)).toEqual(['r3']);
    expect(searchObjects(objs, 'x')).toEqual([]);
  });
  it('computes stats from loaded data', () => {
    const s = cityStats(objs);
    expect(s.roads).toBe(3);
    expect(s.buildings).toBe(1);
    expect(s.junctions).toBe(1);
    expect(s.proposals).toBe(1);
    // 0.01° of longitude at 18.52°N ≈ 1.055 km
    expect(lineLengthKm([[73.84, 18.52], [73.85, 18.52]])).toBeCloseTo(1.055, 2);
    expect(s.roadKm).toBeGreaterThan(3.2);
  });
  it('summary attaches certainty only where recorded', () => {
    const b = summarise(objs[3]);
    expect(b.rows.find(r => r.label === 'Height')).toEqual({ label: 'Height', value: '12 m', certainty: 'hypothetical' });
    const r = summarise(objs[0]);
    expect(r.source).toBe('OpenStreetMap id 1111');
    expect(r.rows.every(x => x.certainty === undefined)).toBe(true);
  });
  it('groups the layer registry into the explore tree', () => {
    const g = groupLayers([{ id: 'satellite', name: 's', category: 'base', visible: true }, { id: 'roads', name: 'r', category: 'infrastructure', visible: true }, { id: 'demand_zones', name: 'z', category: 'infrastructure', visible: true }, { id: 'new_thing', name: 'n', category: 'utilities', visible: false }]);
    expect(g.map(x => x.id)).toEqual(['base', 'transport', 'utilities', 'landuse']);
    expect(g.find(x => x.id === 'utilities')!.layers[0].id).toBe('new_thing');
  });
});

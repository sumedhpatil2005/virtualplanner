import { describe, it, expect } from 'vitest';
import type { RoadObject, FlyoverObject } from '../objects/types';
import { StudyAreaExplorer, suggestedRangeM, STUDY_RANGE_MAX_M, type DrivableObject } from '../simulation/StudyAreaExplorer';
import { TrafficNetworkBuilder } from '../simulation/TrafficNetworkBuilder';

// Local metric frame around Pune: (x, y) in metres east/north of the origin
const LNG0 = 73.8;
const LAT0 = 18.5;
const M_LAT = 1 / 111320;
const M_LNG = 1 / (111320 * Math.cos((LAT0 * Math.PI) / 180));
const pt = (x: number, y: number, z = 0): [number, number, number] => [LNG0 + x * M_LNG, LAT0 + y * M_LAT, z];

const road = (id: string, points: [number, number, number][], extra: Partial<RoadObject> = {}): RoadObject => ({
  id,
  type: 'road',
  name: id,
  layerId: 'roads',
  scenarioId: 'base',
  coordinates: points,
  roadClass: 'local',
  width: 8,
  laneCount: 2,
  laneWidth: 3.5,
  hasDivider: false,
  dividerWidth: 0,
  hasFootpath: false,
  footpathWidth: 0,
  speedLimit: 40,
  isOneWay: false,
  trafficCapacity: 1500,
  connectedJunctions: [],
  createdAt: '',
  updatedAt: '',
  ...extra,
});

const flyover = (id: string, points: [number, number, number][]): FlyoverObject => ({
  id,
  type: 'flyover',
  name: id,
  layerId: 'roads',
  scenarioId: 'base',
  coordinates: points,
  roadClass: 'highway',
  width: 12,
  laneCount: 2,
  laneWidth: 3.5,
  hasDivider: true,
  dividerWidth: 2,
  hasFootpath: false,
  footpathWidth: 0,
  speedLimit: 80,
  isOneWay: false,
  elevation: 6,
  pierSpacing: 30,
  createdAt: '',
  updatedAt: '',
});

/** A street grid of `n`×`n` blocks, `spacing` m apart, one road object per block edge (like OSM ways). */
function grid(n: number, spacing: number, originX = 0, prefix = 'g'): RoadObject[] {
  const roads: RoadObject[] = [];
  for (let i = 0; i <= n; i++) {
    for (let j = 0; j < n; j++) {
      roads.push(road(`${prefix}_h_${i}_${j}`, [pt(originX + j * spacing, i * spacing), pt(originX + (j + 1) * spacing, i * spacing)]));
      roads.push(road(`${prefix}_v_${i}_${j}`, [pt(originX + i * spacing, j * spacing), pt(originX + i * spacing, (j + 1) * spacing)]));
    }
  }
  return roads;
}

const roadIdsOf = (area: { segments: { roadId: string }[] }) => new Set(area.segments.map(s => s.roadId));

describe('StudyAreaExplorer', () => {
  it('grows by network distance and marks where the area is cut', () => {
    const roads = grid(6, 100);
    const explorer = new StudyAreaExplorer();
    // Centre horizontal block edge on row 3
    const area = explorer.explore(roads, 1, { seedRoadIds: ['g_h_3_2'], rangeMeters: 150, direction: 'both' });
    const ids = roadIdsOf(area);

    expect(ids.has('g_h_3_2')).toBe(true);
    expect(ids.has('g_h_3_1')).toBe(true); // continues west, starts 0 m from the seed
    expect(ids.has('g_v_2_3')).toBe(true); // side street at the seed's west end
    expect(ids.has('g_h_3_0')).toBe(true); // starts 100 m away, inside 150 m
    expect(ids.has('g_h_0_0')).toBe(false); // far corner
    expect(area.segments.find(s => s.roadId === 'g_h_3_2')!.role).toBe('seed');
    expect(area.boundary.length).toBeGreaterThan(0);
    expect(area.boundary.every(b => b.kind === 'entry_exit')).toBe(true); // two-way streets
    expect(area.junctions.some(j => j.kind === 'crossroads')).toBe(true);
    expect(area.problems).toEqual([]); // a complete grid has alternatives and no faults
  });

  it('separates downstream from upstream on one-way roads', () => {
    const roads = [
      road('a', [pt(0, 0), pt(200, 0)], { isOneWay: true }),
      road('b', [pt(200, 0), pt(400, 0)], { isOneWay: true }),
      road('c', [pt(400, 0), pt(600, 0)], { isOneWay: true }),
    ];
    const explorer = new StudyAreaExplorer();
    const down = explorer.explore(roads, 1, { seedRoadIds: ['b'], rangeMeters: 1000, direction: 'downstream' });
    expect([...roadIdsOf(down)].sort()).toEqual(['b', 'c']);
    const up = explorer.explore(roads, 1, { seedRoadIds: ['b'], rangeMeters: 1000, direction: 'upstream' });
    expect([...roadIdsOf(up)].sort()).toEqual(['a', 'b']);

    const both = explorer.explore(roads, 1, { seedRoadIds: ['b'], rangeMeters: 1000, direction: 'both' });
    expect(both.segments.find(s => s.roadId === 'a')!.role).toBe('upstream');
    expect(both.segments.find(s => s.roadId === 'c')!.role).toBe('downstream');
    // The chain stops at both ends with no road beyond: each end leads nowhere
    expect(both.problems.filter(p => p.kind === 'open_end')).toHaveLength(2);
  });

  it('reports one-way traps on imported roads', () => {
    const osm = { osmProvenance: { osmId: 1, originalTags: {}, layer: 0, bridge: false, tunnel: false, roundabout: false } } as Partial<RoadObject>;
    const roads = [
      road('osm_a', [pt(0, 0), pt(200, 0)], { isOneWay: true, ...osm }),
      road('osm_b', [pt(200, 0), pt(400, 0)], { isOneWay: true, ...osm }),
    ];
    const area = new StudyAreaExplorer().explore(roads, 1, { seedRoadIds: ['osm_b'], rangeMeters: 1000, direction: 'both' });
    const kinds = area.problems.map(p => p.kind);
    expect(kinds).toContain('one_way_trap');
    expect(kinds).toContain('one_way_source');
  });

  it('reports a flyover crossing without ramps as a grade separation and an unconnected road', () => {
    const roads: DrivableObject[] = [
      road('street', [pt(0, 0), pt(400, 0)]),
      flyover('fly', [pt(200, -150, 7), pt(200, 150, 7)]),
    ];
    const area = new StudyAreaExplorer().explore(roads, 1, { seedRoadIds: ['street'], rangeMeters: 500, direction: 'both' });

    expect(roadIdsOf(area).has('fly')).toBe(false);
    expect(area.gradeSeparations).toHaveLength(1);
    expect(area.gradeSeparations[0].roadIds[0]).toBe('fly'); // the flyover is on top
    const isolated = area.problems.find(p => p.kind === 'isolated');
    expect(isolated?.title).toContain('fly');
  });

  it('joins a built road that stops just short of another', () => {
    const roads = [
      road('main', [pt(0, 0), pt(400, 0)]),
      road('side', [pt(200, 200), pt(200, 12)]), // ends 12 m short of main
    ];
    const area = new StudyAreaExplorer().explore(roads, 1, { seedRoadIds: ['main'], rangeMeters: 500, direction: 'both' });
    expect(area.problems.some(p => p.kind === 'near_miss')).toBe(false);
    // The gap is bridged: main and side meet at a T-junction
    expect(area.junctions.some(j => j.kind === 't_junction')).toBe(true);
    expect(area.segments.some(s => s.roadId === 'side')).toBe(true);
  });

  it('still reports a gap wider than auto-joining reaches', () => {
    const roads = [
      road('osm_main', [pt(0, 0), pt(400, 0)], { osmProvenance: { osmId: 1, originalTags: {}, layer: 0, bridge: false, tunnel: false, roundabout: false }, sourceCoordinates: [pt(0, 0), pt(500, 0)] } as Partial<RoadObject>),
      road('osm_side', [pt(200, 200), pt(200, 12)], { osmProvenance: { osmId: 2, originalTags: {}, layer: 0, bridge: false, tunnel: false, roundabout: false }, sourceCoordinates: [pt(200, 300), pt(200, 12)] } as Partial<RoadObject>),
    ];
    // Edited OSM roads that stop short of each other are not joined automatically
    const area = new StudyAreaExplorer().explore(roads, 1, { seedRoadIds: ['osm_main'], rangeMeters: 500, direction: 'both' });
    const miss = area.problems.find(p => p.kind === 'near_miss');
    expect(miss).toBeDefined();
    expect(miss!.title).toMatch(/1[12] m short of "osm_main"/);
  });

  it('warns when the seed road has no alternative route within range', () => {
    const chain = [road('w', [pt(0, 0), pt(300, 0)]), road('mid', [pt(300, 0), pt(600, 0)]), road('e', [pt(600, 0), pt(900, 0)])];
    const explorer = new StudyAreaExplorer();
    const area = explorer.explore(chain, 1, { seedRoadIds: ['mid'], rangeMeters: 500, direction: 'both' });
    expect(area.problems.some(p => p.kind === 'no_alternative')).toBe(true);

    const gridArea = new StudyAreaExplorer().explore(grid(4, 100), 1, { seedRoadIds: ['g_h_2_1'], rangeMeters: 400, direction: 'both' });
    expect(gridArea.problems.some(p => p.kind === 'no_alternative')).toBe(false);
  });

  it('compiles only nearby roads and reuses the build until the network changes', () => {
    const near = grid(4, 100);
    const far = grid(4, 100, 20000, 'far'); // 20 km east
    const roads = [...near, ...far];
    const explorer = new StudyAreaExplorer();

    const first = explorer.explore(roads, 1, { seedRoadIds: ['g_h_2_1'], rangeMeters: 300, direction: 'both' });
    expect(first.stats.compiledRoads).toBeLessThanOrEqual(near.length);
    expect(first.stats.totalRoads).toBe(roads.length);
    expect(first.stats.reusedBuild).toBe(false);

    const smaller = explorer.explore(roads, 1, { seedRoadIds: ['g_h_2_1'], rangeMeters: 150, direction: 'both' });
    expect(smaller.stats.reusedBuild).toBe(true);

    const changed = explorer.explore(roads, 2, { seedRoadIds: ['g_h_2_1'], rangeMeters: 150, direction: 'both' });
    expect(changed.stats.reusedBuild).toBe(false);
  });

  it('snaps a click to the nearest road', () => {
    const roads = grid(2, 100);
    const explorer = new StudyAreaExplorer();
    const [lng, lat] = pt(50, 8);
    expect(explorer.nearestRoad(roads, 1, lng, lat, 20)).toBe('g_h_0_0');
    const [lng2, lat2] = pt(50, 50);
    expect(explorer.nearestRoad(roads, 1, lng2, lat2, 20)).toBeNull();
  });

  it('rejects seeds that are not in the network', () => {
    expect(() => new StudyAreaExplorer().explore(grid(1, 100), 1, { seedRoadIds: ['nope'], rangeMeters: 300, direction: 'both' }))
      .toThrow(/not part of the active scenario/);
  });

  it('suggests 2.5× the seed length, within limits', () => {
    expect(suggestedRangeM(400)).toBe(1000);
    expect(suggestedRangeM(10)).toBe(300);
    expect(suggestedRangeM(10000)).toBe(STUDY_RANGE_MAX_M);
  });

  it('maps a 5 km area of a dense city quickly', () => {
    const roads = grid(50, 100); // 5,100 block edges over 5 km × 5 km
    const explorer = new StudyAreaExplorer();
    const start = performance.now();
    const area = explorer.explore(roads, 1, { seedRoadIds: ['g_h_25_25'], rangeMeters: 5000, direction: 'both' });
    const ms = performance.now() - start;
    console.log(`[StudyArea] ${area.stats.compiledRoads} roads compiled, ${area.segments.length} stretches in ${ms.toFixed(0)} ms`);
    expect(area.stats.roads).toBe(roads.length);
    expect(ms).toBeLessThan(3000);
  });
});

describe('TrafficNetworkBuilder grade separations', () => {
  it('records where roads cross at different heights', () => {
    const { gradeSeparations } = new TrafficNetworkBuilder().build([
      road('low', [pt(0, 0), pt(200, 0)]),
      road('high', [pt(100, -100, 8), pt(100, 100, 8)]),
    ]);
    expect(gradeSeparations).toHaveLength(1);
    expect(gradeSeparations[0].roadIds).toEqual(['high', 'low']);
    expect(gradeSeparations[0].upperZ).toBe(8);
  });
});

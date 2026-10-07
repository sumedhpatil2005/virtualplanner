import { describe, it, expect, vi } from 'vitest';
import type { Area, RoadObject } from '../objects/types';
import { StudyAreaExplorer, type DrivableObject } from '../simulation/StudyAreaExplorer';
import { TrafficNetworkBuilder } from '../simulation/TrafficNetworkBuilder';
import { TrafficMicroSim, STEP_S } from '../simulation/TrafficMicroSim';
import { roadCoveredAreas, uncoveredBoxes, STUDY_AREA_ROADS_PREFIX } from '../simulation/osmCoverage';
import { SimulationMode } from '../simulation/SimulationMode';

/**
 * Study areas built from imported OpenStreetMap roads mixed with hand-built
 * ones: OSM joins, the no-alternative check, routing near the area edge, and
 * loading OSM roads where the project holds none.
 */

// Local metric frame: (x, y) metres east/north of an origin in Pune
const LAT0 = 18.5;
const M_LAT = 1 / 111320;
const M_LNG = 1 / (111320 * Math.cos((LAT0 * Math.PI) / 180));
const pt = (x: number, y: number, z = 0): [number, number, number] => [73.8 + x * M_LNG, LAT0 + y * M_LAT, z];

let osmIds = 1;

const road = (id: string, points: [number, number][], opts: { oneWay?: boolean; osm?: { layer?: number; bridge?: boolean } } = {}): RoadObject => ({
  id, type: 'road', name: id, layerId: 'roads', scenarioId: 'base',
  coordinates: points.map(p => pt(...p)),
  roadClass: 'local', width: 8, laneCount: 2, laneWidth: 3.5,
  hasDivider: false, dividerWidth: 0, hasFootpath: false, footpathWidth: 0,
  speedLimit: 40, isOneWay: opts.oneWay ?? false, trafficCapacity: 1500,
  connectedJunctions: [], createdAt: '', updatedAt: '',
  ...(opts.osm && {
    osmProvenance: { osmId: osmIds++, originalTags: { highway: 'residential' }, layer: opts.osm.layer ?? 0, bridge: !!opts.osm.bridge, tunnel: false, roundabout: false },
  }),
});

/** Street grid, `n`×`n` blocks `spacing` m apart from (x0, y0), one road per block edge like OSM ways. */
function grid(n: number, spacing: number, x0 = 0, y0 = 0, prefix = 'g'): RoadObject[] {
  const roads: RoadObject[] = [];
  for (let i = 0; i <= n; i++) {
    for (let j = 0; j < n; j++) {
      roads.push(road(`${prefix}_h_${i}_${j}`, [[x0 + j * spacing, y0 + i * spacing], [x0 + (j + 1) * spacing, y0 + i * spacing]], { osm: {} }));
      roads.push(road(`${prefix}_v_${i}_${j}`, [[x0 + i * spacing, y0 + j * spacing], [x0 + i * spacing, y0 + (j + 1) * spacing]], { osm: {} }));
    }
  }
  return roads;
}

const explore = (roads: DrivableObject[], seed: string, range: number) =>
  new StudyAreaExplorer().explore(roads, 1, { seedRoadIds: [seed], rangeMeters: range, direction: 'both' });

const noAlternative = (roads: DrivableObject[], seed: string, range: number) =>
  explore(roads, seed, range).problems.find(p => p.kind === 'no_alternative');

describe('OSM layers in the road graph', () => {
  // The approach road carries on north past the bridge head, which is a node in its middle
  const approachW = road('approach_w', [[-200, 0], [0, 0], [0, 200]], { osm: {} });
  const bridge = road('bridge', [[0, 0], [300, 0]], { osm: { layer: 1, bridge: true } });
  const approachE = road('approach_e', [[300, 0], [500, 0]], { osm: {} });
  const under = road('under', [[150, -100], [150, 100]], { osm: {} });

  it('joins a bridge to the roads it shares its end nodes with', () => {
    const { network } = new TrafficNetworkBuilder().build([approachW, bridge, approachE, under]);
    const roadsAt = (x: number) => {
      const [lng, lat] = pt(x, 0);
      const node = [...network.nodes.values()].find(n => Math.hypot(n.coordinates[0] - lng, n.coordinates[1] - lat) < 1e-7)!;
      return new Set([...node.incomingSegments, ...node.outgoingSegments].map(id => network.edges.get(id)!.roadId));
    };
    expect(roadsAt(0)).toEqual(new Set(['approach_w', 'bridge'])); // three arms: west, north and the bridge
    const [lng0, lat0] = pt(0, 0);
    const head = [...network.nodes.values()].find(n => Math.hypot(n.coordinates[0] - lng0, n.coordinates[1] - lat0) < 1e-7)!;
    expect(head.outgoingSegments).toHaveLength(3);
    expect(roadsAt(300)).toEqual(new Set(['bridge', 'approach_e']));
  });

  it('keeps a road on another layer separate where it only crosses underneath', () => {
    const { network, gradeSeparations } = new TrafficNetworkBuilder().build([approachW, bridge, approachE, under]);
    expect(gradeSeparations).toHaveLength(1);
    expect(gradeSeparations[0].roadIds).toEqual(['bridge', 'under']);
    const underNodes = [...network.edges.values()].filter(e => e.roadId === 'under').flatMap(e => [e.fromNodeId, e.toNodeId]);
    const bridgeNodes = new Set([...network.edges.values()].filter(e => e.roadId === 'bridge').flatMap(e => [e.fromNodeId, e.toNodeId]));
    expect(underNodes.some(n => bridgeNodes.has(n))).toBe(false);
  });
});

describe('No alternative route', () => {
  it('is not reported for a side street that only the selected road serves', () => {
    // 8×8 grid cut by the range, so traffic enters and leaves at the area edge
    const roads: DrivableObject[] = grid(8, 100).filter(r => r.id !== 'g_h_4_3');
    roads.push(
      // The selected road, with a cul-de-sac hanging off its middle
      road('seed', [[300, 400], [400, 400]]),
      road('cul', [[350, 400], [350, 450], [380, 450]]),
    );
    const area = explore(roads, 'seed', 250);
    expect(area.stats.entries).toBeGreaterThan(0);
    expect(area.problems.find(p => p.kind === 'no_alternative')).toBeUndefined();
  });

  it('is reported when the selected road is the only link between two parts of the network', () => {
    // Two neighbourhoods joined only by one bridge
    const roads: DrivableObject[] = [...grid(4, 100, -400, 0, 'w'), ...grid(4, 100, 200, 0, 'e'), road('bridge', [[0, 200], [200, 200]])];
    const problem = noAlternative(roads, 'bridge', 350);
    expect(problem).toBeDefined();
    expect(problem!.detail).toMatch(/entry-to-exit routes/);
  });

  it('follows one-way streets: a parallel route going the other way is no alternative', () => {
    const corridor = (altOneWay: boolean): DrivableObject[] => [
      road('ww', [[-1000, 0], [-500, 0]]),
      road('w', [[-500, 0], [300, 0]]),
      road('mid', [[300, 0], [600, 0]]),
      road('e', [[600, 0], [900, 0]]),
      road('ee', [[900, 0], [1400, 0]]),
      // Parallel route, eastbound only when one-way
      road('alt_n', [[300, 0], [300, 100]], { oneWay: altOneWay }),
      road('alt_top', [[300, 100], [600, 100]], { oneWay: altOneWay }),
      road('alt_s', [[600, 100], [600, 0]], { oneWay: altOneWay }),
    ];
    expect(noAlternative(corridor(true), 'mid', 250)).toBeDefined();
    expect(noAlternative(corridor(false), 'mid', 250)).toBeUndefined();
  });
});

describe('Near misses', () => {
  it('trusts OSM where two imported roads stop short of each other', () => {
    const area = explore([road('osm_main', [[0, 0], [400, 0]], { osm: {} }), road('osm_drive', [[200, 200], [200, 12]], { osm: {} })], 'osm_main', 500);
    expect(area.problems.some(p => p.kind === 'near_miss')).toBe(false);
  });

  it('joins a built road that stops short of an OSM road', () => {
    const area = explore([road('osm_main', [[0, 0], [400, 0]], { osm: {} }), road('new_link', [[200, 200], [200, 12]])], 'osm_main', 500);
    expect(area.problems.some(p => p.kind === 'near_miss')).toBe(false);
    expect(area.segments.some(s => s.roadId === 'new_link')).toBe(true);
  });

  it('joins an OSM road that stops short of a built road (one that replaced its old link)', () => {
    const area = explore([road('osm_stub', [[200, 200], [200, 12]], { osm: {} }), road('new_main', [[0, 0], [400, 0]])], 'new_main', 500);
    expect(area.problems.some(p => p.kind === 'near_miss')).toBe(false);
    expect(area.segments.some(s => s.roadId === 'osm_stub')).toBe(true);
  });
});

describe('Traffic near the area edge', () => {
  it('sends traffic only to exits it can reach, so no trip is unroutable', () => {
    const roads = [
      road('ww', [[-1000, 0], [-500, 0]]),
      road('w', [[-500, 0], [300, 0]]),
      road('mid', [[300, 0], [900, 0]]),
      road('e', [[900, 0], [1200, 0]]),
      road('ee', [[1200, 0], [1700, 0]]),
      // A one-way turn into a street that runs out of range: traffic entering there cannot get back
      road('in', [[300, 0], [300, -150]], { oneWay: true }),
      road('q1', [[300, -150], [300, -400]]),
      road('q2', [[300, -400], [300, -900]]),
    ];
    const area = explore(roads, 'mid', 250);
    const sim = new TrafficMicroSim(area, new Map(roads.map(r => [r.id, r])), { demandLevel: 0.5, seed: 3 });
    for (let i = 0; i < 600 / STEP_S; i++) sim.step();
    const m = sim.getMetrics();
    expect(m.unroutable).toBe(0);
    expect(m.completedTrips).toBeGreaterThan(0);
    // The cut-off street's entry generates nothing; the two ends of the corridor do
    expect(m.entries).toBe(2);
  });
});

describe('OSM road coverage', () => {
  const square = (id: string, x0: number, y0: number, x1: number, y1: number): Area => {
    const [minLng, minLat] = pt(x0, y0);
    const [maxLng, maxLat] = pt(x1, y1);
    return {
      id, name: id, createdAt: '',
      polygonCoordinates: [[minLng, minLat, 0], [maxLng, minLat, 0], [maxLng, maxLat, 0], [minLng, maxLat, 0], [minLng, minLat, 0]],
      minLat, maxLat, minLon: minLng, maxLon: maxLng,
    };
  };
  const seedBox = (() => {
    const [minLng, minLat] = pt(0, 0);
    const [maxLng, maxLat] = pt(100, 0);
    return { minLng, minLat, maxLng, maxLat };
  })();
  const osmRoad = road('osm_1', [[0, 0], [100, 0]], { osm: {} });

  it('counts an Area as covered when imported OSM roads lie inside it', () => {
    const withRoads = square('area_a', -3000, -3000, 3000, 3000);
    const buildingsOnly = square('area_b', 5000, 5000, 9000, 9000);
    const loaded = square(`${STUDY_AREA_ROADS_PREFIX}x`, 20000, 20000, 21000, 21000);
    expect(roadCoveredAreas([withRoads, buildingsOnly, loaded], [osmRoad]).map(a => a.id)).toEqual(['area_a', `${STUDY_AREA_ROADS_PREFIX}x`]);
  });

  it('needs nothing when the range lies inside imported roads', () => {
    expect(uncoveredBoxes(seedBox, 2000, [square('area_a', -3000, -3000, 3000, 3000)])).toEqual([]);
  });

  it('asks only for the part of the range outside imported roads', () => {
    // Imported roads cover everything west of x = 1000
    const missing = uncoveredBoxes(seedBox, 2000, [square('area_a', -3000, -3000, 1000, 3000)]);
    expect(missing).toHaveLength(1);
    const [westEdge] = pt(700, 0);
    const [eastEdge] = pt(2000, 0);
    expect(missing[0].minLng).toBeGreaterThan(westEdge);
    expect(missing[0].maxLng).toBeGreaterThanOrEqual(eastEdge);
  });

  it('asks for the whole range where nothing is imported', () => {
    const missing = uncoveredBoxes(seedBox, 2000, []);
    const [west] = pt(-1900, 0);
    expect(Math.min(...missing.map(b => b.minLng))).toBeLessThan(west);
  });

  it('asks for thin strips on both sides separately, not one box over the imported middle', () => {
    // Imported roads cover a band from y = -1800 to 1800: strips remain north and south
    const missing = uncoveredBoxes(seedBox, 2000, [square('area_a', -3000, -1800, 3000, 1800)]);
    expect(missing.length).toBeGreaterThanOrEqual(2);
    const [, midLatSouth] = pt(0, -1000);
    const [, midLatNorth] = pt(0, 1000);
    expect(missing.every(b => b.maxLat < midLatSouth || b.minLat > midLatNorth)).toBe(true);
  });
});

describe('Simulation mode checks the roads around a study area against OSM', () => {
  const flush = async () => {
    for (let i = 0; i < 5; i++) await new Promise(r => setTimeout(r, 0));
  };
  type Box = { minLng: number; minLat: number; maxLng: number; maxLat: number };

  it('checks each map tile in range once, and only the new ones when the range grows', async () => {
    const roads: DrivableObject[] = [road('built', [[0, 0], [300, 0]])];
    const load = vi.fn(async (_boxes: Box[]) => 12);
    const mode = new SimulationMode(() => roads, { load });
    mode.enter();
    mode.selectRoad('built', false);
    await flush();
    expect(load).toHaveBeenCalledTimes(1);
    const first = load.mock.calls[0][0].length;
    expect(first).toBeGreaterThan(1);
    expect(mode.getState().osmRoads).toEqual({ status: 'idle', added: 12, error: null });

    mode.setRange(500); // inside the tiles already checked
    await flush();
    expect(load).toHaveBeenCalledTimes(1);

    mode.setRange(4000); // reaches past them: only the tiles not yet checked
    await flush();
    expect(load).toHaveBeenCalledTimes(2);
    const second: Box[] = load.mock.calls[1][0];
    const key = (b: Box) => [b.minLng, b.minLat].join();
    const firstKeys = new Set(load.mock.calls[0][0].map(key));
    expect(second.every(b => !firstKeys.has(key(b)))).toBe(true);
    mode.dispose();
  });

  it('checks places already holding imported roads too, as an earlier import may be incomplete', async () => {
    const roads: DrivableObject[] = [road('built', [[0, 0], [300, 0]]), road('osm_near', [[0, 0], [0, 300]], { osm: {} })];
    const load = vi.fn(async () => 0);
    const mode = new SimulationMode(() => roads, { load });
    mode.enter();
    mode.selectRoad('built', false);
    await flush();
    expect(load).toHaveBeenCalledTimes(1);
    mode.dispose();
  });

  it('does not ask again in the same session for the same range', async () => {
    const roads: DrivableObject[] = [road('built', [[0, 0], [300, 0]])];
    const load = vi.fn(async () => 0);
    const mode = new SimulationMode(() => roads, { load });
    mode.enter();
    mode.selectRoad('built', false);
    await flush();
    mode.setDirection('downstream'); // re-maps the same range
    await flush();
    expect(load).toHaveBeenCalledTimes(1);
    expect(mode.getState().osmRoads.added).toBe(0);
    mode.dispose();
  });

  it('reports a failed load and tries again only when asked', async () => {
    const roads: DrivableObject[] = [road('built', [[0, 0], [300, 0]])];
    const load = vi.fn(async () => {
      throw new Error('All Overpass mirrors are busy.');
    });
    const mode = new SimulationMode(() => roads, { load });
    mode.enter();
    mode.selectRoad('built', false);
    await flush();
    expect(mode.getState().osmRoads).toEqual({ status: 'error', added: null, error: 'All Overpass mirrors are busy.' });
    expect(load).toHaveBeenCalledTimes(1);
    mode.retryOsmRoads();
    await flush();
    expect(load).toHaveBeenCalledTimes(2);
    mode.dispose();
  });
});

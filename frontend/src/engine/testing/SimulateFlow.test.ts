import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import type { RoadObject, FlyoverObject, BuildingObject } from '../objects/types';
import type { DrivableObject } from '../simulation/StudyAreaExplorer';
import { StudyAreaExplorer } from '../simulation/StudyAreaExplorer';
import { SimulationMode, DEFAULT_STUDY_DISTANCE_M } from '../simulation/SimulationMode';
import { TrafficMicroSim, STEP_S } from '../simulation/TrafficMicroSim';
import { roadConnections } from '../simulation/roadConnections';
import { isUserBuilt } from '../objects/builtBy';

/**
 * The Simulate flow (pick a distance, click a road, traffic runs) and the
 * facts View mode shows about a built road.
 */

const LAT0 = 18.5;
const M_LAT = 1 / 111320;
const M_LNG = 1 / (111320 * Math.cos((LAT0 * Math.PI) / 180));
const pt = (x: number, y: number, z = 0): [number, number, number] => [73.8 + x * M_LNG, LAT0 + y * M_LAT, z];

const road = (id: string, points: [number, number, number?][], extra: Partial<RoadObject> = {}): RoadObject => ({
  id, type: 'road', name: id, layerId: 'roads', scenarioId: 'base',
  coordinates: points.map(([x, y, z]) => pt(x, y, z)),
  roadClass: 'arterial', width: 10, laneCount: 2, laneWidth: 3.5,
  hasDivider: false, dividerWidth: 0, hasFootpath: false, footpathWidth: 0,
  speedLimit: 50, isOneWay: false, trafficCapacity: 2000,
  connectedJunctions: [], createdAt: '', updatedAt: '',
  ...extra,
});

/** A corridor of 250 m pieces running well past any range used here, so traffic enters and leaves at both ends. */
const corridor = (): DrivableObject[] => {
  const roads: DrivableObject[] = [road('mid', [[0, 0], [600, 0]])];
  for (let x = 0; x > -3000; x -= 250) roads.push(road(`w${-x}`, [[x - 250, 0], [x, 0]]));
  for (let x = 600; x < 3600; x += 250) roads.push(road(`e${x}`, [[x, 0], [x + 250, 0]]));
  return roads;
};

describe('Simulate: click a road and traffic runs', () => {
  let frames: FrameRequestCallback[] = [];
  beforeEach(() => {
    frames = [];
    vi.stubGlobal('requestAnimationFrame', (cb: FrameRequestCallback) => frames.push(cb));
    vi.stubGlobal('cancelAnimationFrame', () => {});
  });
  afterEach(() => vi.unstubAllGlobals());

  it('maps the chosen distance, not one derived from the road, and starts traffic', () => {
    const roads = corridor();
    const mode = new SimulationMode(() => roads);
    mode.enter();
    expect(mode.getState().rangeMeters).toBe(DEFAULT_STUDY_DISTANCE_M);
    mode.setRange(500);
    mode.selectRoad('mid', false);

    const s = mode.getState();
    expect(s.rangeMeters).toBe(500);
    expect(s.area?.stats.entries).toBeGreaterThan(0);
    expect(s.traffic.status).toBe('running');
    mode.dispose();
  });

  it('stays paused when the area re-maps, and starts again when the distance changes', async () => {
    const roads = corridor();
    const mode = new SimulationMode(() => roads);
    mode.enter();
    mode.setRange(500);
    mode.selectRoad('mid', false);
    mode.pauseTraffic();

    mode.networkChanged();
    await new Promise(r => setTimeout(r, 300)); // re-map debounce
    expect(mode.getState().traffic.status).toBe('idle');

    mode.setRange(1000);
    expect(mode.getState().traffic.status).toBe('running');
    mode.dispose();
  });

  it('going back to choose another road stops the traffic', () => {
    const roads = corridor();
    const mode = new SimulationMode(() => roads);
    mode.enter();
    mode.selectRoad('mid', false);
    mode.clearSeeds();
    expect(mode.getState().seedRoadIds).toEqual([]);
    expect(mode.getState().traffic.status).toBe('idle');
    mode.dispose();
  });
});

describe('Traffic on the selected road', () => {
  it('counts the vehicles that use it', () => {
    const roads = corridor();
    const area = new StudyAreaExplorer().explore(roads, 1, { seedRoadIds: ['mid'], rangeMeters: 500, direction: 'both' });
    const sim = new TrafficMicroSim(area, new Map(roads.map(r => [r.id, r])), { demandLevel: 0.2, seed: 7, watchRoadIds: ['mid'] });
    for (let i = 0; i < 300 / STEP_S; i++) sim.step();
    const m = sim.getMetrics();
    // Every trip along the corridor crosses the middle road
    expect(m.watched.passed).toBeGreaterThan(0);
    expect(m.watched.passed).toBeLessThanOrEqual(m.completedTrips + m.onNetwork);
  });
});

describe('Road connections for View mode', () => {
  const flyover = (id: string, points: [number, number, number][]): FlyoverObject => ({
    id, type: 'flyover', name: id, layerId: 'roads', scenarioId: 'base',
    coordinates: points.map(([x, y, z]) => pt(x, y, z)),
    roadClass: 'arterial', width: 12, laneCount: 2, laneWidth: 3.5, hasDivider: true, dividerWidth: 2,
    hasFootpath: false, footpathWidth: 0, speedLimit: 60, isOneWay: false, elevation: 6, pierSpacing: 30,
    createdAt: '', updatedAt: '',
  });

  it('names the roads at each end and what it passes over', () => {
    const roads: DrivableObject[] = [
      road('west_road', [[-300, 0], [0, 0]]),
      road('east_road', [[400, 0], [700, 0]]),
      road('cross_street', [[200, -150], [200, 150]]),
      flyover('fly', [[0, 0, 0], [50, 0, 6], [350, 0, 6], [400, 0, 0]]),
    ];
    const c = roadConnections(roads[3], roads);
    expect(c.start).toEqual(['west_road']);
    expect(c.end).toEqual(['east_road']);
    expect(c.over).toEqual(['cross_street']);
  });

  it('reports a loose end', () => {
    const roads: DrivableObject[] = [road('main', [[0, 0], [400, 0]]), road('stub', [[200, 0], [200, 300]])];
    const c = roadConnections(roads[1], roads);
    expect(c.start).toEqual(['main']);
    expect(c.end).toEqual([]);
  });
});

describe('What counts as built by the user', () => {
  it('leaves out imported OpenStreetMap objects', () => {
    expect(isUserBuilt(road('xo5htspm6', [[0, 0], [1, 0]]))).toBe(true);
    expect(isUserBuilt(road('osm_123', [[0, 0], [1, 0]]))).toBe(false);
    expect(isUserBuilt(road('r1', [[0, 0], [1, 0]], {
      osmProvenance: { osmId: 1, originalTags: {}, layer: 0, bridge: false, tunnel: false, roundabout: false },
    }))).toBe(false);
    expect(isUserBuilt({ id: 'b1', type: 'building', source: 'OSM' } as BuildingObject)).toBe(false);
  });
});

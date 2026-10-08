import { afterEach, describe, expect, it, vi } from 'vitest';
import type { BuildingObject, RoadObject } from '../objects/types';
import type { DemandZone } from '../objects/demandTypes';
import { compileStudyDemand, demandContextKey, snapDemandPlan, type SimulationContext } from '../simulation/StudyDemand';
import { SimulationMode } from '../simulation/SimulationMode';
import { StudyAreaExplorer } from '../simulation/StudyAreaExplorer';
import { TrafficMicroSim, STEP_S } from '../simulation/TrafficMicroSim';
import { makeLaneConnector, sampleLaneConnector, connectorsConflict } from '../simulation/LaneConnector';

const pt = (x: number, y = 0, z = 0): [number, number, number] => [73.8 + x / (111320 * Math.cos(18.5 * Math.PI / 180)), 18.5 + y / 111320, z];
const road = (id: string, x: number, end: number) => ({ id, type: 'road', coordinates: [pt(x), pt(end)], roadClass: 'arterial', laneCount: 2, laneWidth: 3.5, speedLimit: 50, connectedJunctions: [], scenarioId: 'base' } as RoadObject);
const building = (id: string, x: number, residents = 0, employees = 0) => ({ id, type: 'building', coordinates: [pt(x - 1, -1), pt(x + 1, -1), pt(x + 1, 1), pt(x - 1, 1)], residents, employees } as BuildingObject);
const roads = [road('outerW', -500, 0), road('west', 0, 300), road('mid', 300, 900), road('east', 900, 1200), road('outerE', 1200, 1700)];
const area = () => new StudyAreaExplorer().explore(roads, 1, { seedRoadIds: ['mid'], rangeMeters: 500, direction: 'both' });
const bounds = { minLng: pt(0, 0)[0], maxLng: pt(1200, 0)[0], minLat: pt(0, -10)[1], maxLat: pt(0, 10)[1] };
afterEach(() => vi.restoreAllMocks());

describe('project demand scoped to a study', () => {
  it('excludes distant buildings and does not snap distant or raised endpoints onto ground roads', () => {
    const plan = compileStudyDemand({ buildings: [building('home', 300, 100), building('work', 900, 0, 100), building('far', 100000, 50000)] }, bounds)!;
    expect(plan.provenance.vehiclesPerHour).toBeCloseTo(57.4);
    expect(plan.trips).toHaveLength(3);
    const graph = area().network;
    const remote = { ...plan, trips: [{ ...plan.trips[0], from: pt(100000) }, { ...plan.trips[0], from: pt(300, 0, 12) }] };
    expect(snapDemandPlan(remote, graph).every(t => t.fromNodeId === '')).toBe(true);
  });
  it('apportions residual zone demand by overlap and retains its clipped location', () => {
    const z = { id: 'zone', boundaryPolygon: [pt(0, -10), pt(2400, -10), pt(2400, 10), pt(0, 10)], totalPopulation: 1000, totalEmployment: 0 } as DemandZone;
    const plan = compileStudyDemand({ zones: [z], buildings: [building('work', 900, 0, 100)] }, bounds)!;
    expect(plan.provenance.vehiclesPerHour).toBeCloseTo(1000 * .5 * 1.8 * .35 * .82, 2);
    expect(plan.trips[0].from[0]).toBeCloseTo(pt(600)[0], 8);
    expect(compileStudyDemand({ zones: [{ ...z, boundaryPolygon: z.boundaryPolygon.map(p => pt(100000 + (p[0] - 73.8) * 111320)) }] }, bounds)).toBeNull();
  });
  it('invalidates demand keys for effective activity changes but not visual names', () => {
    const b = building('home', 300, 100);
    expect(demandContextKey({ buildings: [b] })).toBe(demandContextKey({ buildings: [{ ...b, name: 'Renamed' }] }));
    expect(demandContextKey({ buildings: [b] })).not.toBe(demandContextKey({ buildings: [{ ...b, activityProfile: { tripGeneration: { amPeakTrips: 300 } } }] }));
  });
});

describe('repeatable scenario experiments', () => {
  it('replays equal frozen demand, guards changed inputs, and clears vehicle selection on reset', async () => {
    let context: SimulationContext = { buildings: [building('home', 300, 100), building('work', 900, 0, 100)], scenarioId: 'base' };
    const mode = new SimulationMode(() => roads, null, null, () => context);
    vi.spyOn(mode as any, 'startLoop').mockImplementation(() => {});
    mode.enter(); mode.selectRoad('mid', false);
    const baseline = await mode.captureBaseline(180);
    expect(baseline?.metrics.completedTrips).toBeGreaterThan(0);
    expect((await mode.runComparison())?.metrics).toEqual(baseline?.metrics);
    context = { ...context, buildings: [building('home', 300, 200), building('work', 900, 0, 100)] };
    expect(await mode.runComparison()).toBeNull();
    expect(mode.getState().comparison.staleReason).toMatch(/demand changed/i);
    mode.selectVehicle(42); expect(mode.getState().selectedVehicleId).toBe(42);
    mode.resetTraffic(); expect(mode.getState().selectedVehicleId).toBeNull();
    mode.dispose();
  });
  it('counts failed arrivals as trips and keeps the same arrival count after a route disappears', () => {
    const a = area();
    const node = (x: number) => [...a.network.nodes.values()].sort((p, q) => Math.abs(p.coordinates[0] - pt(x)[0]) - Math.abs(q.coordinates[0] - pt(x)[0]))[0].id;
    const demandTrips = [{ fromNodeId: node(300), toNodeId: node(900), vehiclesPerHour: 100, kind: 'car' as const }];
    const map = new Map(roads.map(r => [r.id, r]));
    const good = new TrafficMicroSim(a, map, { demandLevel: .12, seed: 42, demandTrips });
    const bad = new TrafficMicroSim(a, map, { demandLevel: .12, seed: 42, demandTrips: [{ ...demandTrips[0], toNodeId: 'missing' }] });
    for (let i = 0; i < 300 / STEP_S; i++) { good.step(); bad.step(); }
    const m = good.getMetrics();
    expect(bad.getMetrics().unroutable).toBe(m.completedTrips + m.onNetwork + m.waitingToEnter + m.gridlockRemovals);
    expect(m.meanTravelTimeS).toBeGreaterThan(0);
    expect(m.meanDelayS).toBeGreaterThanOrEqual(0);
  });
  it('does not report trips between neighbours on the same junction as unroutable', () => {
    const a = area();
    const node = [...a.network.nodes.values()][0].id;
    const sim = new TrafficMicroSim(a, new Map(roads.map(r => [r.id, r])), { demandLevel: .12, seed: 42, demandTrips: [{ fromNodeId: node, toNodeId: node, vehiclesPerHour: 500, kind: 'car' }] });
    for (let i = 0; i < 120 / STEP_S; i++) sim.step();
    expect(sim.getMetrics().unroutable).toBe(0);
  });
});

describe('lane movement geometry', () => {
  it('has continuous position and tangent at both ends of a turn and samples by distance', () => {
    const pose = (x: number, y: number, heading: number) => ({ lng: pt(x, y)[0], lat: pt(x, y)[1], z: 0, heading, pitch: 0 });
    const a = pose(-8, -1.75, 0), b = pose(1.75, 8, Math.PI / 2);
    const curve = makeLaneConnector(a, b, 92, 8);
    expect(sampleLaneConnector(curve, 0, { ...a })).toEqual(a);
    const end = sampleLaneConnector(curve, curve.length, { ...a });
    expect(end.lng).toBeCloseTo(b.lng, 10); expect(end.lat).toBeCloseTo(b.lat, 10); expect(end.heading).toBeCloseTo(b.heading, 8);
    const middle = sampleLaneConnector(curve, curve.length / 2, { ...a });
    expect(middle.heading).toBeGreaterThan(0); expect(middle.heading).toBeLessThan(Math.PI / 2);
    const crossing = makeLaneConnector(pose(0, -8, Math.PI / 2), pose(0, 8, Math.PI / 2), 92, 8);
    expect(connectorsConflict(curve, crossing)).toBe(true);
  });
});

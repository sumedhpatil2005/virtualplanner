/**
 * Vehicle accounting (docs/OVERHAUL.md §20).
 *
 * Every vehicle the micro-simulation creates is accounted for: still waiting at
 * its entry, on the network, finished (at a destination inside the area or by
 * leaving it at its edge), or removed. Removal after GRIDLOCK_S standing at the
 * front of a queue deletes a vehicle; it is off by default and, when switched
 * on, counted with where the vehicle stood and what it waited on. With it off,
 * gridlock stays on the network and is reported with its location.
 */
import { describe, it, expect } from 'vitest';
import type { RoadObject, RoadClassification } from '../objects/types';
import { StudyAreaExplorer, type StudyArea } from '../simulation/StudyAreaExplorer';
import { TrafficMicroSim, STEP_S, OD_REFERENCE_LEVEL, GRIDLOCK_S, type MicroDemandTrip, type VehicleKind, type VehicleAccounting } from '../simulation/TrafficMicroSim';

const LAT0 = 18.5;
const pt = (x: number, y: number): [number, number, number] => [73.8 + x / (111320 * Math.cos(LAT0 * Math.PI / 180)), LAT0 + y / 111320, 0];
const road = (id: string, a: [number, number], b: [number, number], o: { cls?: RoadClassification; lanes?: number } = {}): RoadObject => ({
  id, type: 'road', name: id, layerId: 'roads', scenarioId: 'base', coordinates: [pt(...a), pt(...b)], roadClass: o.cls ?? 'collector', width: 10, laneCount: o.lanes ?? 2, laneWidth: 3.5,
  hasDivider: false, dividerWidth: 0, hasFootpath: false, footpathWidth: 0, speedLimit: 40, isOneWay: false, trafficCapacity: 1000, connectedJunctions: [], createdAt: '', updatedAt: '',
});
const nodeAt = (area: StudyArea, x: number, y: number) => {
  const [lng, lat] = pt(x, y);
  let best = '', bd = Infinity;
  area.network.nodes.forEach(n => { const d = Math.hypot(n.coordinates[0] - lng, n.coordinates[1] - lat); if (d < bd) { bd = d; best = n.id; } });
  return best;
};
const MIX: [VehicleKind, number][] = [['two_wheeler', 0.5], ['car', 0.3], ['auto', 0.12], ['bus', 0.04], ['truck', 0.04]];

/**
 * An arterial with three junctions 35 m apart (signal, priority, signal) loaded
 * beyond what they pass, side roads crossing it, and trips both to the area's
 * edge and to points inside it. Front vehicles stand for minutes here.
 */
function overloaded(remove: boolean, seed: number) {
  const m = { cls: 'arterial' as RoadClassification, lanes: 4 };
  const xs = [0, 35, 70];
  const roads = [road('m0', [-400, 0], [0, 0], m), road('m1', [0, 0], [35, 0], m), road('m2', [35, 0], [70, 0], m), road('m3', [70, 0], [470, 0], m), road('mw', [-800, 0], [-400, 0], m), road('me', [470, 0], [870, 0], m)];
  for (const x of xs) {
    const cls: RoadClassification = x === 35 ? 'local' : 'collector';
    roads.push(road(`n${x}`, [x, 0], [x, 300], { cls }), road(`s${x}`, [x, 0], [x, -300], { cls }), road(`nx${x}`, [x, 300], [x, 600], { cls }), road(`sx${x}`, [x, -300], [x, -600], { cls }));
  }
  const area = new StudyAreaExplorer().explore(roads, 1, { seedRoadIds: ['m1'], rangeMeters: 450, direction: 'both' });
  const map = new Map(roads.map(r => [r.id, r]));
  const ends: [number, number][] = [[-400, 0], [470, 0], ...xs.flatMap(x => [[x, 300], [x, -300]] as [number, number][])];
  const pairs: [[number, number], [number, number], number][] = [[[-400, 0], [470, 0], 1200], [[470, 0], [-400, 0], 1200]];
  for (const a of ends) for (const b of ends) if (a !== b && !(a[1] === 0 && b[1] === 0)) pairs.push([a, b, 48]);
  const trips: MicroDemandTrip[] = pairs.flatMap(([a, b, vph]) => MIX.map(([kind, s]) => ({ fromNodeId: nodeAt(area, ...a), toNodeId: nodeAt(area, ...b), vehiclesPerHour: vph * s, kind })));
  return new TrafficMicroSim(area, map, { demandLevel: OD_REFERENCE_LEVEL, seed, demandTrips: trips, signalPoints: [0, 70].map(x => [pt(x, 0)[0], pt(x, 0)[1]] as [number, number]), signalTiming: 'webster', removeStuckVehicles: remove });
}

const conserved = (a: VehicleAccounting) => {
  expect(a.spawned, JSON.stringify(a)).toBe(a.completedAtDestination + a.exitedAtEdge + a.timeouts + a.stuckRemovals + a.inNetwork);
  expect(a.generated, JSON.stringify(a)).toBe(a.spawned + a.waitingAtEdge);
  const sum = (r: Record<string, number>) => Object.values(r).reduce((x, y) => x + y, 0);
  expect(sum(a.stuckRemovalsByPlace)).toBe(a.stuckRemovals);
  expect(sum(a.stuckRemovalsByCause)).toBe(a.stuckRemovals);
  expect(sum(a.gridlockEventsByPlace)).toBe(a.gridlockEvents);
  expect(sum(a.gridlockEventsByCause)).toBe(a.gridlockEvents);
  expect(a.timeouts).toBe(0);
  // No lane changing in this model, and every lane maps across every junction
  expect(a.stuckRemovalsByCause.laneChange + a.stuckRemovalsByCause.noConnection + a.gridlockEventsByCause.laneChange + a.gridlockEventsByCause.noConnection).toBe(0);
};

function runChecked(sim: TrafficMicroSim, seconds: number) {
  for (let i = 1; i <= seconds / STEP_S; i++) {
    sim.step();
    if (i % 400 === 0) {
      const m = sim.getMetrics();
      conserved(m.accounting);
      expect(m.accounting.inNetwork).toBe(m.onNetwork);
      expect(m.accounting.waitingAtEdge).toBe(m.waitingToEnter);
      expect(m.completedTrips).toBe(m.accounting.completedAtDestination + m.accounting.exitedAtEdge);
    }
  }
  return sim.getMetrics();
}

describe('vehicle accounting', () => {
  it('conserves vehicles with stuck removal off and on, and only removes when it is on', () => {
    for (const seed of [42, 11]) {
      const off = runChecked(overloaded(false, seed), 1200);
      expect(off.accounting.stuckRemovalEnabled).toBe(false);
      expect(off.accounting.stuckRemovals).toBe(0);
      expect(off.gridlockRemovals).toBe(0);
      expect(off.accounting.completedAtDestination + off.accounting.exitedAtEdge).toBeGreaterThan(500);
      const on = runChecked(overloaded(true, seed), 1200);
      expect(on.accounting.stuckRemovalEnabled).toBe(true);
      // Removal happens in the step the vehicle reaches GRIDLOCK_S, so each gridlock event is a removal
      expect(on.accounting.stuckRemovals).toBe(on.accounting.gridlockEvents);
      expect(on.gridlockRemovals).toBe(on.accounting.stuckRemovals);
    }
  }, 120_000);

  it('trips to a point inside the area finish at their destination, trips to a road leaving the area exit at its edge', () => {
    const roads = [road('a', [0, 0], [300, 0]), road('b', [300, 0], [600, 0]), road('c', [600, 0], [900, 0]), road('d', [900, 0], [1400, 0]), road('w', [-500, 0], [0, 0]), road('side', [300, 0], [300, 200], { cls: 'local' })];
    const area = new StudyAreaExplorer().explore(roads, 1, { seedRoadIds: ['b'], rangeMeters: 200, direction: 'both' });
    const map = new Map(roads.map(r => [r.id, r]));
    // 'side' ends inside the area with nothing beyond it: a destination. The far end of the corridor continues outside.
    const trips: MicroDemandTrip[] = [
      { fromNodeId: nodeAt(area, 0, 0), toNodeId: nodeAt(area, 300, 200), vehiclesPerHour: 200, kind: 'car' },
      { fromNodeId: nodeAt(area, 0, 0), toNodeId: nodeAt(area, 900, 0), vehiclesPerHour: 200, kind: 'car' },
    ];
    const sim = new TrafficMicroSim(area, map, { demandLevel: OD_REFERENCE_LEVEL, seed: 3, demandTrips: trips });
    const m = runChecked(sim, 900);
    expect(m.accounting.completedAtDestination).toBeGreaterThan(10);
    expect(m.accounting.exitedAtEdge).toBeGreaterThan(10);
  });

  it('gridlock left in place is reported with its location and what it waits on', () => {
    const sim = overloaded(false, 42);
    let seen = 0;
    for (let i = 1; i <= 1500 / STEP_S; i++) {
      sim.step();
      if (i % 40) continue;
      const sites = sim.gridlockSites();
      const now = sim.getMetrics().accounting.gridlockedNow;
      expect(sites.reduce((n, s) => n + s.vehicles, 0)).toBe(now);
      for (const s of sites) {
        expect(s.longestS).toBeGreaterThan(GRIDLOCK_S);
        expect(Number.isFinite(s.lng) && Number.isFinite(s.lat) && s.lng !== 0).toBe(true);
        expect(Object.values(s.causes).reduce((a, b) => a + (b ?? 0), 0)).toBe(s.vehicles);
      }
      seen = Math.max(seen, now);
    }
    // This network is overloaded: some front vehicle stands for over three minutes at some point
    expect(sim.getMetrics().accounting.gridlockEvents).toBeGreaterThan(0);
    expect(seen).toBeGreaterThan(0);
  }, 60_000);

  it('is repeatable: the same seed gives the same counters', () => {
    const a = runChecked(overloaded(false, 7), 600).accounting;
    const b = runChecked(overloaded(false, 7), 600).accounting;
    expect(b).toEqual(a);
  }, 60_000);
});

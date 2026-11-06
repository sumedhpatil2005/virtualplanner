/**
 * Junction blocking and deadlocks (docs/OVERHAUL.md §18).
 *
 *  1. Keep the box clear: a vehicle is cleared into a junction only when the
 *     lane it leads to can take it (its length and a standstill gap past the end
 *     of the movement). A moving tail counts only as far as the lane can close
 *     up. Before, a tail rolling at turning speed was projected 20-35 m on even
 *     when the lane ahead was a short link already full, so followers entered,
 *     stopped inside the junction holding their claim, and, between closely
 *     spaced junctions, blocked each other in a ring.
 *  2. Merging in turn: where two approaches feed one short lane, a vehicle held
 *     at its line for a minute gets the lane next instead of waiting until it is
 *     removed as gridlock while the other approach takes every gap.
 *
 * Congestion is kept: the over-loaded networks below still queue.
 */
import { describe, it, expect } from 'vitest';
import type { RoadObject, RoadClassification } from '../objects/types';
import { StudyAreaExplorer, type StudyArea } from '../simulation/StudyAreaExplorer';
import { TrafficMicroSim, STEP_S, OD_REFERENCE_LEVEL, type MicroDemandTrip, type VehicleKind } from '../simulation/TrafficMicroSim';

const LAT0 = 18.5;
const pt = (x: number, y: number): [number, number, number] => [73.8 + x / (111320 * Math.cos(LAT0 * Math.PI / 180)), LAT0 + y / 111320, 0];
const road = (id: string, a: [number, number], b: [number, number], o: { cls?: RoadClassification; lanes?: number; speed?: number; oneWay?: boolean } = {}): RoadObject => ({
  id, type: 'road', name: id, layerId: 'roads', scenarioId: 'base', coordinates: [pt(...a), pt(...b)], roadClass: o.cls ?? 'collector', width: 10, laneCount: o.lanes ?? 2, laneWidth: 3.5,
  hasDivider: false, dividerWidth: 0, hasFootpath: false, footpathWidth: 0, speedLimit: o.speed ?? 40, isOneWay: o.oneWay ?? false, trafficCapacity: 1000, connectedJunctions: [], createdAt: '', updatedAt: '',
});
const nodeAt = (area: StudyArea, x: number, y: number) => {
  const [lng, lat] = pt(x, y);
  let best = '', bd = Infinity;
  area.network.nodes.forEach(n => { const d = Math.hypot(n.coordinates[0] - lng, n.coordinates[1] - lat); if (d < bd) { bd = d; best = n.id; } });
  return best;
};
/** Pune-like mix: half two-wheelers. */
const MIX: [VehicleKind, number][] = [['two_wheeler', 0.5], ['car', 0.3], ['auto', 0.12], ['bus', 0.04], ['truck', 0.04]];
const od = (area: StudyArea, pairs: [[number, number], [number, number], number][]): MicroDemandTrip[] =>
  pairs.flatMap(([a, b, vph]) => MIX.map(([kind, s]) => ({ fromNodeId: nodeAt(area, ...a), toNodeId: nodeAt(area, ...b), vehiclesPerHour: vph * s, kind })));

/** Per run: the longest any vehicle stood inside a junction box, and the vehicle-seconds spent standing there over a minute. */
function run(sim: TrafficMicroSim, seconds: number) {
  let stuckInBoxS = 0;
  const standing = new Map<number, number>();
  for (let i = 0; i < seconds / STEP_S; i++) {
    sim.step();
    if (i % 4) continue;
    // Read-only look at the vehicles still driving the movement of the junction behind them
    const links = (sim as unknown as { links: { lanes: { id: number; v: number; arriving: unknown }[][] }[] }).links;
    const seen = new Set<number>();
    for (const l of links) for (const lane of l.lanes) for (const v of lane) {
      if (!v.arriving || v.v >= 0.1) continue;
      seen.add(v.id);
      const s = (standing.get(v.id) ?? 0) + 4 * STEP_S;
      standing.set(v.id, s);
      if (s > 60) stuckInBoxS += 4 * STEP_S;
    }
    for (const id of [...standing.keys()]) if (!seen.has(id)) standing.delete(id);
  }
  return { stuckInBoxS, rep: sim.deadlockReport(), m: sim.getMetrics() };
}

/** A main road with three junctions 35 m apart (signal, priority, signal) and side streets, loaded beyond what they pass. */
function closeJunctions(seed: number) {
  const m = { cls: 'arterial' as RoadClassification, lanes: 4 };
  const xs = [0, 35, 70];
  const roads = [road('m0', [-400, 0], [0, 0], m), road('m1', [0, 0], [35, 0], m), road('m2', [35, 0], [70, 0], m), road('m3', [70, 0], [470, 0], m)];
  for (const x of xs) {
    const cls: RoadClassification = x === 35 ? 'local' : 'collector';
    roads.push(road(`n${x}`, [x, 0], [x, 300], { cls, lanes: 2 }), road(`s${x}`, [x, 0], [x, -300], { cls, lanes: 2 }));
  }
  const area = new StudyAreaExplorer().explore(roads, 1, { seedRoadIds: ['m1'], rangeMeters: 450, direction: 'both' });
  const ends: [number, number][] = [[-400, 0], [470, 0], ...xs.flatMap(x => [[x, 300], [x, -300]] as [number, number][])];
  const pairs: [[number, number], [number, number], number][] = [[[-400, 0], [470, 0], 1200], [[470, 0], [-400, 0], 1200]];
  for (const a of ends) for (const b of ends) if (a !== b && !(a[1] === 0 && b[1] === 0)) pairs.push([a, b, 48]);
  return new TrafficMicroSim(area, new Map(roads.map(r => [r.id, r])), { demandLevel: OD_REFERENCE_LEVEL, seed, demandTrips: od(area, pairs),
    signalPoints: [0, 70].map(x => [pt(x, 0)[0], pt(x, 0)[1]] as [number, number]), signalTiming: 'webster' });
}

describe('keep the junction box clear', () => {
  it('between closely spaced junctions nobody stands inside a junction box, the ring of blocked boxes does not form, and the queues stay', () => {
    for (const seed of [42, 11]) {
      const { stuckInBoxS, rep, m } = run(closeJunctions(seed), 900);
      // Before the fix (seed 42): 368 vehicle-seconds standing in boxes past a minute, the longest 160 s, 5 deadlock events
      expect(stuckInBoxS, `seed ${seed}`).toBe(0);
      expect(rep.maxStuckInBoxS, `seed ${seed}`).toBeLessThan(30);
      // Still over-loaded: far fewer trips finish than arrive, and they take minutes
      expect(m.completedTrips / (900 / 3600), `seed ${seed}`).toBeLessThan(0.7 * m.inflowVph);
      expect(m.meanDelayS!, `seed ${seed}`).toBeGreaterThan(120);
    }
  }, 120_000);
});

/**
 * Two one-way approaches of the same class feed a 13 m, three-lane link: a
 * dense turning stream (1,800 veh/h, on 25-35 m turns) and a straight-on road
 * (500 veh/h). Neither gives way to the other.
 */
function merge(seed: number) {
  const ow = { lanes: 3, oneWay: true };
  const roads = [road('a', [-300, 0], [0, 0], ow), road('b', [-60, 300], [0, 0], ow), road('sh', [0, 0], [13, 0], ow), road('out', [13, 0], [400, 0], ow), road('q', [13, 0], [13, 200]), road('s0', [0, 0], [0, -200])];
  const area = new StudyAreaExplorer().explore(roads, 1, { seedRoadIds: ['sh'], rangeMeters: 450, direction: 'both' });
  const sim = new TrafficMicroSim(area, new Map(roads.map(r => [r.id, r])), { demandLevel: OD_REFERENCE_LEVEL, seed, signalPoints: [],
    demandTrips: od(area, [[[-300, 0], [400, 0], 500], [[-60, 300], [400, 0], 1800]]) });
  const straight = (sim as unknown as { links: { id: string; lanes: { waitS: number }[][] }[] }).links.filter(l => l.id.startsWith('a_'));
  return { sim, straight };
}

describe('merging in turn', () => {
  it('a straight-on queue beside a dense turning stream into one short link gets its turn: its front waits about a minute, nobody is removed, and the link passes as much', () => {
    for (const seed of [42, 11]) {
      const { sim, straight } = merge(seed);
      let maxWait = 0;
      for (let i = 0; i < 1200 / STEP_S; i++) {
        sim.step();
        for (const l of straight) for (const lane of l.lanes) if (lane[0]) maxWait = Math.max(maxWait, lane[0].waitS);
      }
      const m = sim.getMetrics();
      // Before the fix: the straight-on front waited the full 180 s and was removed as gridlock (3 and 5 removals)
      expect(m.gridlockRemovals, `seed ${seed}`).toBe(0);
      expect(maxWait, `seed ${seed}`).toBeLessThan(120);
      // Throughput unchanged within noise: before the fix 699 and 662 trips in 20 minutes
      expect(m.completedTrips, `seed ${seed}`).toBeGreaterThan(640);
      expect(m.completedTrips, `seed ${seed}`).toBeLessThan(760);
    }
  }, 120_000);
});

import { describe, it, expect } from 'vitest';
import type { RoadObject, RoadClassification } from '../objects/types';
import { StudyAreaExplorer, type StudyArea } from '../simulation/StudyAreaExplorer';
import { TrafficMicroSim, STEP_S, OD_REFERENCE_LEVEL, VEHICLE_TYPES, GRIDLOCK_S, type MicroDemandTrip, type VehicleKind } from '../simulation/TrafficMicroSim';

/**
 * Long vehicles (12 m buses, 8 m trucks) through junctions 9-15 m apart
 * (docs/OVERHAUL.md §20): a vehicle that cannot wait between the two stop lines
 * with its whole length clear of the junction behind it does not enter unless it
 * can drive on through both; closely spaced signals run coordinated. No vehicle
 * stands partly in a junction box for over a minute unless the road ahead of it
 * is genuinely full (it is queued nose to tail behind a standing vehicle), and
 * no two vehicles overlap.
 */

const LAT0 = 18.5;
const pt = (x: number, y: number): [number, number, number] => [73.8 + x / (111320 * Math.cos(LAT0 * Math.PI / 180)), LAT0 + y / 111320, 0];
const road = (id: string, a: [number, number], b: [number, number], cls: RoadClassification): RoadObject => ({
  id, type: 'road', name: id, layerId: 'roads', scenarioId: 'base', coordinates: [pt(...a), pt(...b)], roadClass: cls, width: 10, laneCount: 2, laneWidth: 3.5,
  hasDivider: false, dividerWidth: 0, hasFootpath: false, footpathWidth: 0, speedLimit: 40, isOneWay: false, trafficCapacity: 1000, connectedJunctions: [], createdAt: '', updatedAt: '',
});
const nodeAt = (area: StudyArea, x: number, y: number) => {
  const [lng, lat] = pt(x, y);
  let best = '', bd = Infinity;
  area.network.nodes.forEach(n => { const d = Math.hypot(n.coordinates[0] - lng, n.coordinates[1] - lat); if (d < bd) { bd = d; best = n.id; } });
  return best;
};

/** A main road with side roads crossing it every `gap` m: junctions that close become short links between two junctions. */
function scenario(gap: number, signals: boolean, seed: number) {
  const xs = gap === 9 ? [0, 9, 18, 27, 36] : [0, gap, 2 * gap, 3 * gap];
  const last = xs[xs.length - 1];
  const roads: RoadObject[] = [road('mw', [-800, 0], [-400, 0], 'arterial'), road('m0', [-400, 0], [0, 0], 'arterial')];
  for (let i = 0; i + 1 < xs.length; i++) roads.push(road(`m${i + 1}`, [xs[i], 0], [xs[i + 1], 0], 'arterial'));
  roads.push(road('mE', [last, 0], [last + 400, 0], 'arterial'), road('me', [last + 400, 0], [last + 800, 0], 'arterial'));
  for (const x of xs) roads.push(road(`n${x}`, [x, 0], [x, 300], 'local'), road(`s${x}`, [x, 0], [x, -300], 'local'), road(`nx${x}`, [x, 300], [x, 600], 'local'), road(`sx${x}`, [x, -300], [x, -600], 'local'));
  const area = new StudyAreaExplorer().explore(roads, 1, { seedRoadIds: ['m1'], rangeMeters: 450, direction: 'both' });
  const W = nodeAt(area, -400, 0), E = nodeAt(area, last + 400, 0), N = nodeAt(area, last, 300), S = nodeAt(area, last, -300), N0 = nodeAt(area, 0, 300), S0 = nodeAt(area, 0, -300);
  // A fifth of the traffic buses and trucks; through traffic both ways and turns at both ends of the short links
  const mix: [VehicleKind, number][] = [['two_wheeler', 0.4], ['car', 0.3], ['auto', 0.1], ['bus', 0.12], ['truck', 0.08]];
  const q = 500;
  const pairs: [string, string, number][] = [[W, E, q], [E, W, q], [W, N, q * 0.15], [W, S, q * 0.15], [E, N0, q * 0.15], [E, S0, q * 0.15], [N, W, q * 0.1], [S, W, q * 0.1], [N0, E, q * 0.1], [S0, E, q * 0.1]];
  const trips: MicroDemandTrip[] = pairs.flatMap(([a, b, v]) => mix.map(([kind, sh]) => ({ fromNodeId: a, toNodeId: b, vehiclesPerHour: v * sh, kind })));
  return new TrafficMicroSim(area, new Map(roads.map(r => [r.id, r])), {
    demandLevel: OD_REFERENCE_LEVEL, seed, demandTrips: trips, removeStuckVehicles: false,
    signalPoints: signals ? xs.map(x => [pt(x, 0)[0], pt(x, 0)[1]] as [number, number]) : [],
  });
}

/* eslint-disable @typescript-eslint/no-explicit-any */
function run(gap: number, signals: boolean, seed: number, seconds = 900) {
  const sim = scenario(gap, signals, seed);
  const s = sim as any;
  const shortLinks = (s.links as any[]).filter(l => l.length < 20 && s.controls.has(l.from) && s.controls.has(l.to));
  const standing = new Map<number, number>();
  let overlaps = 0, minStandGap = Infinity, unexcusedOver60 = 0, excusedOver60 = 0;
  const heavyThrough = new Set<number>(), heavyTurned = new Set<number>();
  for (let i = 0; i < seconds / STEP_S; i++) {
    sim.step();
    const seen = new Set<number>();
    for (const l of s.links) for (const lane of l.lanes) for (let k = 0; k < lane.length; k++) {
      const v = lane[k];
      const lead = k > 0 ? (v.abreast ? lane[k - 2] : lane[k - 1]) : undefined;
      const gapAhead = lead ? lead.pos - lead.type.lengthM - v.pos : Infinity;
      if (gapAhead < -1e-6) overlaps++;
      if (lead && v.v < 0.1 && lead.v < 0.1) minStandGap = Math.min(minStandGap, gapAhead);
      if (v.type.lengthM >= 7 && shortLinks.includes(l)) { heavyThrough.add(v.id); if (v.arriving?.connector.turn) heavyTurned.add(v.id); }
      // Partly in a junction box: still on its turn/crossing, or its rear not yet past the junction it left
      const inBox = !!v.arriving || (v.pos - v.type.lengthM < -0.5 && s.controls.has(l.from));
      if (!inBox || v.v >= 0.1) continue;
      seen.add(v.id);
      const st = (standing.get(v.id) ?? 0) + STEP_S;
      standing.set(v.id, st);
      if (st > 60) {
        // Downstream genuinely full: queued nose to tail behind a standing vehicle
        const full = !!lead && lead.v < 0.1 && gapAhead < v.type.minGapM + 1;
        if (full) excusedOver60 += STEP_S; else unexcusedOver60 += STEP_S;
      }
    }
    for (const id of [...standing.keys()]) if (!seen.has(id)) standing.delete(id);
  }
  // Front vehicles standing over GRIDLOCK_S at the end, and what holds them
  const gridlocked = (s.links as any[]).flatMap(l => l.lanes.map((lane: any[]) => lane[0]).filter((v: any) => v && v.waitS > GRIDLOCK_S).map((v: any) => `${v.type.kind}:${v.hold}`));
  return { m: sim.getMetrics(), gridlocked, shortLinks: shortLinks.length, overlaps, minStandGap, unexcusedOver60, excusedOver60, heavyThrough: heavyThrough.size, heavyTurned: heavyTurned.size };
}

describe('long vehicles through closely spaced junctions', () => {
  it('a 12 m bus is a 12 m bus', () => {
    expect(VEHICLE_TYPES.find(t => t.kind === 'bus')!.lengthM).toBe(12);
  });

  for (const signals of [true, false]) {
    for (const gap of [9, 12, 15]) {
      it(`${signals ? 'signalised' : 'priority'} junctions ${gap} m apart: buses and trucks through and turning, nobody stands in a box over a minute with room ahead, no overlaps${signals ? ', nothing gridlocked' : ''}`, () => {
        for (const seed of [1, 2]) {
          const r = run(gap, signals, seed);
          const a = r.m.accounting;
          const msg = `seed ${seed}: ${JSON.stringify({ ...r, m: undefined, completed: r.m.completedTrips, gridlocked: a.gridlockedNow, events: a.gridlockEvents })}`;
          // The scenario has what it is meant to test
          expect(r.shortLinks, msg).toBeGreaterThan(0);
          expect(r.heavyThrough, msg).toBeGreaterThan(10);
          expect(r.heavyTurned, msg).toBeGreaterThan(0);
          expect(r.overlaps, msg).toBe(0);
          expect(r.minStandGap, msg).toBeGreaterThanOrEqual(0);
          expect(r.unexcusedOver60, msg).toBe(0);
          // Nothing removed (the option is off), nobody gridlocked at the end, and every vehicle accounted for
          expect(a.stuckRemovals, msg).toBe(0);
          expect(r.gridlocked.length, msg).toBe(a.gridlockedNow);
          if (signals) expect(a.gridlockedNow, msg).toBe(0);
          // At priority junctions a bus or truck that cannot wait on the short link waits at the first junction for a
          // main-road gap long enough to drive through both (15 s and more at its turning speed): with the opposing
          // stream here that can take over GRIDLOCK_S. Only such vehicles, and at most one per run, may be standing that long
          else {
            expect(a.gridlockedNow, msg).toBeLessThanOrEqual(1);
            for (const g of r.gridlocked) expect(g, msg).toMatch(/^(bus|truck):keep-clear$/);
          }
          expect(a.spawned, msg).toBe(a.completedAtDestination + a.exitedAtEdge + a.timeouts + a.stuckRemovals + a.inNetwork);
          expect(a.generated, msg).toBe(a.spawned + a.waitingAtEdge);
          expect(r.m.completedTrips, msg).toBeGreaterThan(100);
        }
      }, 120_000);
    }
  }
});

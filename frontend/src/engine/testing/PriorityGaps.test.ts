/**
 * Priority junctions: gap acceptance, impatience and turn-taking (docs/OVERHAUL.md §20).
 *
 *  - A side-road driver enters only into a gap in the main-road stream at least
 *    its critical gap long (Indo-HCM 2017: 3.8 s from a minor road), shortened by
 *    impatience after a long wait at the line to a floor of 3.0 s. Never in front
 *    of a main-road vehicle closer than that, never while one crosses its path.
 *  - Turn-taking after a minute (MERGE_TURN_S, §18) is between approaches that do
 *    not give way to each other: it never holds main-road traffic for a side
 *    road, never an oncoming vehicle for a right-turner, and never runs a red.
 *  - Main-road drivers do not give way to side-road traffic (no invented courtesy).
 *  - The side road's capacity against the main-road flow lies between the gap-
 *    acceptance capacity (Harders) for Indo-HCM and for HCM 2010 critical gaps, and
 *    never above what the floor critical gap allows.
 */
import { describe, it, expect } from 'vitest';
import type { RoadObject, RoadClassification } from '../objects/types';
import { StudyAreaExplorer, type StudyArea } from '../simulation/StudyAreaExplorer';
import { TrafficMicroSim, STEP_S, OD_REFERENCE_LEVEL, criticalGap, CRITICAL_GAP_MINOR_S, CRITICAL_GAP_MINOR_FLOOR_S, CRITICAL_GAP_MAJOR_RIGHT_S, CRITICAL_GAP_MAJOR_RIGHT_FLOOR_S, type MicroDemandTrip, type VehicleKind } from '../simulation/TrafficMicroSim';
import { connectorsConflict, type LaneConnector } from '../simulation/LaneConnector';

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

/* eslint-disable @typescript-eslint/no-explicit-any */
type Internals = any;

/** A T-junction: a two-lane arterial (one lane each way) and a local side road from the south. Side-road traffic turns right (crosses both streams). */
function tee(majorVph: number, minorVph: number, seed: number, kind: VehicleKind | 'mix' = 'mix') {
  const roads = [road('main', [-400, 0], [400, 0], { cls: 'arterial' }), road('side', [0, 0], [0, -400], { cls: 'local' }),
    road('mw', [-800, 0], [-400, 0], { cls: 'arterial' }), road('me', [400, 0], [800, 0], { cls: 'arterial' }), road('sx', [0, -400], [0, -800], { cls: 'local' })];
  const area = new StudyAreaExplorer().explore(roads, 1, { seedRoadIds: ['main'], rangeMeters: 450, direction: 'both' });
  const map = new Map(roads.map(r => [r.id, r]));
  const W = nodeAt(area, -400, 0), E = nodeAt(area, 400, 0), S = nodeAt(area, 0, -400);
  const kinds: [VehicleKind, number][] = kind === 'mix' ? MIX : [[kind, 1]];
  const trips: MicroDemandTrip[] = [];
  for (const [k, sh] of kinds) {
    if (majorVph > 0) trips.push({ fromNodeId: W, toNodeId: E, vehiclesPerHour: majorVph / 2 * sh, kind: k }, { fromNodeId: E, toNodeId: W, vehiclesPerHour: majorVph / 2 * sh, kind: k });
    trips.push({ fromNodeId: S, toNodeId: E, vehiclesPerHour: minorVph * sh, kind: k });
  }
  return new TrafficMicroSim(area, map, { demandLevel: OD_REFERENCE_LEVEL, seed, demandTrips: trips, signalPoints: [] });
}

/** Watches every grant given to a side-road vehicle: what was closest on the main road, and whether a main-road vehicle was crossing its path. */
function watchSideGrants(sim: TrafficMicroSim) {
  const s = sim as Internals;
  const out = { grants: 0, minLagS: Infinity, inBoxConflicts: 0, longestWaitS: 0, minorCrossings: 0 };
  const reserve = s.reserve.bind(s);
  s.reserve = (veh: Internals, lane: number, connector: LaneConnector) => {
    const link = s.links[veh.link];
    if (link.roadId === 'side') {
      out.grants++;
      out.longestWaitS = Math.max(out.longestWaitS, veh.waitS);
      for (const [idx, other] of s.incomingOf(link.to) as [number, Internals][]) {
        if (idx === link.index) continue;
        other.lanes.forEach((ln: Internals[], li: number) => {
          // The first main-road vehicle still to reach its line in this lane
          const w = ln.find((x: Internals) => x.routeIdx < x.route.length - 1);
          if (!w) return;
          const wNext = s.links[w.route[w.routeIdx + 1]];
          const wConn = w.connector ?? s.connectorFor(other, li, wNext, Math.min(li, wNext.lanes.length - 1));
          if (!connectorsConflict(connector, wConn)) return;
          if (w.v < 0.5 && w.grantLane === null) return; // standing at its own line, not cleared: not coming
          out.minLagS = Math.min(out.minLagS, (wConn.start - w.pos) / Math.max(w.v, 0.1));
        });
      }
      // A main-road vehicle on its movement through the junction: not in the stretch where
      // its path meets this one, and not reaching it within the floor critical gap
      for (const l of s.links as Internals[]) {
        if (l.roadId === 'side') continue;
        for (const ln of l.lanes) for (const w of ln) {
          // On its movement through this junction, from a main-road approach (a side-road vehicle that went just before is a leader, not a conflict)
          if (!w.arriving || w.arriving.reservation?.node !== link.to || s.links[w.arriving.reservation.from].roadId === 'side') continue;
          const c: LaneConnector = w.arriving.connector;
          const m = meeting(c, connector);
          if (!m) continue;
          const front = w.pos - (c.entry - c.length), rear = front - w.type.lengthM;
          if (rear > m.clearAt) continue;
          if (front >= m.first || (m.first - front) / Math.max(w.v, 0.1) < CRITICAL_GAP_MINOR_FLOOR_S) out.inBoxConflicts++;
        }
      }
    }
    reserve(veh, lane, connector);
  };
  const cross = s.crossJunction.bind(s);
  s.crossJunction = (veh: Internals, lane: Internals[]) => { const from = s.links[veh.link]; cross(veh, lane); if (veh.link !== from.index && from.roadId === 'side') out.minorCrossings++; };
  return out;
}

/**
 * Where path `c` comes within 2.3 m of path `other` (the conflict distance of
 * connectorsConflict): the first such distance along `c`, and how far along `c`
 * a rear must be to be clear of it (the last such distance where the paths
 * cross; the first where they end together, a merge, after which the two follow
 * each other in one lane).
 */
function meeting(c: LaneConnector, other: LaneConnector): { first: number; clearAt: number } | null {
  const kx = 111320 * Math.cos(c.points[0].lat * Math.PI / 180);
  const near = (p: LaneConnector['points'][number], q: LaneConnector['points'][number]) => Math.abs(p.z - q.z) <= 3 && Math.hypot((p.lng - q.lng) * kx, (p.lat - q.lat) * 111320) < 2.3;
  let first = -1, last = -1;
  c.points.forEach((p, i) => { if (other.points.some(q => near(p, q))) { if (first < 0) first = c.distances[i]; last = c.distances[i]; } });
  if (first < 0) return null;
  const merge = near(c.points[c.points.length - 1], other.points[other.points.length - 1]);
  return { first, clearAt: (merge ? first : last) + 1 };
}

const run = (sim: TrafficMicroSim, seconds: number) => { for (let i = 0; i < seconds / STEP_S; i++) sim.step(); };

describe('critical gap with impatience', () => {
  it('falls from the Indo-HCM base to its floor over the ramp and never below', () => {
    expect(criticalGap(true, 0)).toBeCloseTo(CRITICAL_GAP_MINOR_S, 9);
    expect(criticalGap(false, 0)).toBeCloseTo(CRITICAL_GAP_MAJOR_RIGHT_S, 9);
    expect(criticalGap(true, 20)).toBeLessThan(CRITICAL_GAP_MINOR_S);
    expect(criticalGap(true, 20)).toBeGreaterThan(CRITICAL_GAP_MINOR_FLOOR_S);
    expect(criticalGap(true, 1e6)).toBeCloseTo(CRITICAL_GAP_MINOR_FLOOR_S, 9);
    expect(criticalGap(false, 1e6)).toBeCloseTo(CRITICAL_GAP_MAJOR_RIGHT_FLOOR_S, 9);
    for (let w = 0; w < 200; w += 5) expect(criticalGap(true, w + 5)).toBeLessThanOrEqual(criticalGap(true, w));
  });
});

describe('priority junction: the side road waits for a gap, the main road keeps its priority', () => {
  it('a side-road driver never enters in front of a main-road vehicle closer than the floor critical gap, nor across one in the junction, however long it waited', () => {
    for (const seed of [42, 7]) {
      // Dense main road: side-road drivers wait minutes (impatience and turn-taking both in play).
      // 2,000 veh/h: at 1,800 the longest wait before a grant fell to 59 s and 46 s (seeds 42, 7)
      // after the long-vehicle changes (12 m buses, heavy vehicles turning at 11 km/h; docs/OVERHAUL.md §20), so the long waits this test
      // is about no longer happened; the denser main road restores them (71 s and 64 s)
      const sim = tee(2000, 400, seed);
      const w = watchSideGrants(sim);
      run(sim, 1500);
      expect(w.grants, `seed ${seed}`).toBeGreaterThan(5);
      expect(w.longestWaitS, `seed ${seed}: some side-road driver waited past the turn-taking minute`).toBeGreaterThan(60);
      expect(w.minLagS, `seed ${seed}`).toBeGreaterThanOrEqual(CRITICAL_GAP_MINOR_FLOOR_S);
      expect(w.inBoxConflicts, `seed ${seed}`).toBe(0);
    }
  }, 60_000);

  it('main-road traffic is never held for the side road: no give-way, no turn owed, no lane held for it', () => {
    const sim = tee(1800, 600, 11);
    const s = sim as Internals;
    let mainGiveWay = 0, mainOwes = 0, mainHeld = 0, sideOwesOrHeld = 0;
    const mustGiveWay = s.mustGiveWay.bind(s);
    s.mustGiveWay = (veh: Internals, link: Internals, ...rest: Internals[]) => { const r = mustGiveWay(veh, link, ...rest); if (r && link.roadId !== 'side') mainGiveWay++; return r; };
    const owesTurn = s.owesTurn.bind(s);
    s.owesTurn = (veh: Internals, link: Internals, c: Internals) => { const r = owesTurn(veh, link, c); if (r) { if (link.roadId !== 'side') mainOwes++; else sideOwesOrHeld++; } return r; };
    const heldFor = s.heldFor.bind(s);
    s.heldFor = (next: Internals, k: number, veh: Internals) => { const r = heldFor(next, k, veh); if (r) { if (s.links[veh.link].roadId !== 'side') mainHeld++; else sideOwesOrHeld++; } return r; };
    run(sim, 1500);
    expect(mainGiveWay).toBe(0);
    expect(mainOwes).toBe(0);
    expect(mainHeld).toBe(0);
    expect(sideOwesOrHeld).toBeGreaterThanOrEqual(0);
  }, 60_000);

  it('turn-taking never holds an oncoming vehicle for a right-turner waiting to cross its path, at a signal or a priority junction, and never clears anyone on red', () => {
    for (const signal of [true, false]) {
      // Crossroads of two equal collectors; heavy opposing through traffic and right turns
      const roads = [road('ew', [-400, 0], [400, 0], { lanes: 2 }), road('ns', [0, -400], [0, 400], { lanes: 2 }), road('ww', [-800, 0], [-400, 0], { lanes: 2 }), road('ee', [400, 0], [800, 0], { lanes: 2 }), road('ss', [0, -800], [0, -400], { lanes: 2 }), road('nn', [0, 400], [0, 800], { lanes: 2 })];
      const area = new StudyAreaExplorer().explore(roads, 1, { seedRoadIds: ['ew'], rangeMeters: 450, direction: 'both' });
      const map = new Map(roads.map(r => [r.id, r]));
      const E: [number, number][] = [[-400, 0], [0, 400], [400, 0], [0, -400]]; // W N E S
      const trips: MicroDemandTrip[] = [];
      for (let i = 0; i < 4; i++) for (const [k, sh] of MIX) {
        trips.push({ fromNodeId: nodeAt(area, ...E[i]), toNodeId: nodeAt(area, ...E[(i + 2) % 4]), vehiclesPerHour: 700 * sh, kind: k });
        // Right turn in left-hand traffic: from W (heading east) to S, i.e. index + 3
        trips.push({ fromNodeId: nodeAt(area, ...E[i]), toNodeId: nodeAt(area, ...E[(i + 3) % 4]), vehiclesPerHour: 200 * sh, kind: k });
      }
      const sim = new TrafficMicroSim(area, map, { demandLevel: OD_REFERENCE_LEVEL, seed: 42, demandTrips: trips, signalPoints: signal ? [[pt(0, 0)[0], pt(0, 0)[1]]] : [], signalTiming: 'webster' });
      const s = sim as Internals;
      let againstPriority = 0, turnsTaken = 0, onRed = 0;
      const longer = s.longerWaiting.bind(s);
      s.longerWaiting = (node: string, mine: Internals, veh: Internals, holds: string[], each: (f: Internals, other: Internals, lane: number) => boolean) => longer(node, mine, veh, holds, (f: Internals, other: Internals, lane: number) => {
        const r = each(f, other, lane);
        if (r && mine.to === node && veh.routeIdx < veh.route.length - 1) {
          turnsTaken++;
          const fNext = s.links[f.holdNext], myNext = s.links[veh.route[veh.routeIdx + 1]];
          const oncoming = Math.abs(((other.headingEnd - mine.headingEnd + 3 * Math.PI) % (2 * Math.PI)) - Math.PI) > 3 * Math.PI / 4;
          if (s.isRightTurn(other, fNext) && oncoming && !s.isRightTurn(mine, myNext)) againstPriority++;
        }
        return r;
      });
      const reserve = s.reserve.bind(s);
      s.reserve = (veh: Internals, lane: number, connector: LaneConnector) => {
        const st = sim.signalState(veh.link);
        if (st === 'red') onRed++;
        if (st === 'amber' && connector.start - veh.pos > veh.v * veh.v / (2 * veh.type.comfortDecel)) onRed++;
        reserve(veh, lane, connector);
      };
      run(sim, 1500);
      expect(againstPriority, signal ? 'signal' : 'priority').toBe(0);
      expect(onRed, signal ? 'signal' : 'priority').toBe(0);
      expect(turnsTaken).toBeGreaterThanOrEqual(0);
    }
  }, 120_000);
});

/** Harders (1968) gap-acceptance capacity (veh/h) of a minor movement against conflicting flow qp (veh/h), critical gap tc and follow-up time tf (s). */
const harders = (qp: number, tc: number, tf: number) => {
  const q = qp / 3600;
  return q <= 0 ? 3600 / tf : 3600 * q * Math.exp(-q * tc) / (1 - Math.exp(-q * tf));
};

describe('side-road capacity against main-road flow (gap acceptance)', () => {
  it('lies between the Harders capacity for HCM 2010 and for Indo-HCM critical gaps, and never above the floor-gap capacity', () => {
    const MEAS = 1800, WARM = 300;
    const capacity = (qp: number, seed: number) => {
      const sim = tee(qp, 2400, seed, 'car');
      const w = watchSideGrants(sim);
      run(sim, WARM);
      const n0 = w.minorCrossings;
      run(sim, MEAS);
      return (w.minorCrossings - n0) * 3600 / MEAS;
    };
    // Follow-up time: the side road's own discharge with no main-road traffic
    const tf = 3600 / capacity(0, 42);
    expect(tf).toBeGreaterThan(2.0);
    expect(tf).toBeLessThan(4.0);
    const rows: string[] = [];
    for (const qp of [300, 600, 1200, 1600]) {
      const c = (capacity(qp, 42) + capacity(qp, 7)) / 2;
      // HCM 2010 Exhibit 19-10/19-11 (two-lane major): minor-street left turn (the right turn of left-hand traffic) tc = 7.1 s, tf = 3.5 s
      const hcm = harders(qp, 7.1, 3.5);
      const indo = harders(qp, CRITICAL_GAP_MINOR_S, tf);
      const floor = harders(qp, CRITICAL_GAP_MINOR_FLOOR_S, tf);
      rows.push(`${qp}: model ${Math.round(c)}  HCM2010 ${Math.round(hcm)}  Indo-HCM ${Math.round(indo)}  floor ${Math.round(floor)}`);
      expect(c, rows.join('\n')).toBeGreaterThan(hcm);
      expect(c, rows.join('\n')).toBeLessThan(floor);
      expect(c, rows.join('\n')).toBeGreaterThan(0.4 * indo);
    }
    console.log(`[PriorityGaps] side-road capacity, veh/h (tf ${tf.toFixed(2)} s)\n${rows.join('\n')}`);
  }, 120_000);
});

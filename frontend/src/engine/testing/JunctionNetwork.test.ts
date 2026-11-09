/**
 * Junction grouping and editing across the network (docs/OVERHAUL.md §26).
 *
 *  - Grouping faults found by running the grouping over the whole backend
 *    database network (11,002 logical junctions), each with its real-geometry
 *    case from that database (fixtures/junction_cases_db.json):
 *      · a ramp to a road on another level (layer -1) and the T-junctions along a link
 *        road were pulled into an at-grade junction as "slip lanes" (Wakad);
 *      · two slip-lane pairs 45 m apart with no junction between them became
 *        one junction of slip-lane ends alone (University Road / Baner Road);
 *      · a 75 m roundabout ring was cut in two by the 50 m span limit
 *        (Rajgopalachari Chowk);
 *      · the simulator folded nodes of two logical junctions into one
 *        simulated junction (99 places), so editing one junction set the
 *        control of its neighbour's approaches too.
 *  - Editing invariants on 100 junctions drawn at random from the Sangamwadi
 *    roads: a no-op edit changes nothing, an edit changes only its own
 *    junction's links and simulated controls, and a banned turn is honoured
 *    by both routers.
 */
import { describe, it, expect } from 'vitest';
import fs from 'fs';
import path from 'path';
import type { RoadObject } from '../objects/types';
import type { TrafficNetwork } from '../objects/trafficTypes';
import { TrafficNetworkBuilder } from '../simulation/TrafficNetworkBuilder';
import { StudyAreaExplorer, type DrivableObject, type StudyArea } from '../simulation/StudyAreaExplorer';
import { TrafficMicroSim, OD_REFERENCE_LEVEL, JOIN_JUNCTION_M, type MicroDemandTrip } from '../simulation/TrafficMicroSim';
import { groupJunctions, SIM_FOLD_M, type LogicalJunction } from '../simulation/junctionGroups';
import { defaultEdit, compileJunctionEdits, type JunctionEditSpec } from '../simulation/junctionControl';
import { legacyInKey, legacyOutKey } from '../simulation/junctionGroups';
import { buildAssignmentNetwork, assignTraffic } from '../simulation/staticAssignment';

const load = (f: string) => JSON.parse(fs.readFileSync(path.join(__dirname, 'fixtures', f), 'utf8')) as { roads: RoadObject[]; signalPoints?: [number, number][] };
const M_LAT = 111320;
const dM = (a: readonly number[], b: readonly number[]) => Math.hypot((a[0] - b[0]) * M_LAT * Math.cos(a[1] * Math.PI / 180), (a[1] - b[1]) * M_LAT);
const tagsOf = (r: RoadObject | undefined) => r?.osmProvenance?.originalTags ?? {};

function grouped(roads: RoadObject[], signalPoints: [number, number][] = []) {
  const map = new Map(roads.map(r => [r.id, r as DrivableObject]));
  const net = new TrafficNetworkBuilder().build(roads).network;
  return { map, net, js: groupJunctions(net, map, { signalPoints }) };
}
const nodeNear = (net: TrafficNetwork, lng: number, lat: number) => [...net.nodes.values()].sort((a, b) => dM(a.coordinates, [lng, lat]) - dM(b.coordinates, [lng, lat]))[0];
const owner = (js: readonly LogicalJunction[]) => { const m = new Map<string, LogicalJunction>(); for (const j of js) for (const n of j.nodeIds) m.set(n, j); return m; };
/** The simulator's own junctions (private `junctionMembers`): simulated junction id → member network nodes. */
const simMembers = (sim: TrafficMicroSim) => (sim as unknown as { junctionMembers: Map<string, string[]> }).junctionMembers;
const simControls = (sim: TrafficMicroSim) => (sim as unknown as { controls: Map<string, unknown> }).controls;
const ser = (v: unknown) => JSON.stringify(v, (_k, x) => (x instanceof Map ? [...x.entries()].sort() : x instanceof Set ? [...x].sort() : x));

describe('grouping faults found on the whole database network, on their real geometry', () => {
  const fx = load('junction_cases_db.json');
  const { net, js } = grouped(fx.roads);
  const own = owner(js);
  const roadById = new Map(fx.roads.map(r => [r.id, r]));

  it('Wakad: the ramp to the bypass on another level (layer -1) is not a slip lane of the junction at grade, and the T-junctions along the link road 50 m apart stay separate', () => {
    // Before: one "junction" of 7 nodes spanning 100 m: Wakad Flyover / Exit to Hinjawadi / Hinjawadi Road, with the layer -1 ramp osm_60977081 ("To NH4 Bypass") as a slip lane
    const ramp = roadById.get('osm_60977081')!;
    expect(tagsOf(ramp).layer).toBe('-1');
    expect(js.some(j => j.slipLaneRoadIds.includes('osm_60977081'))).toBe(false);
    const deckEnd = nodeNear(net, 73.75521, 18.59208), ground = nodeNear(net, 73.75476, 18.59193);
    expect(own.get(deckEnd.id)?.id).not.toBe(own.get(ground.id)?.id);
    const tWest = nodeNear(net, 73.75448, 18.59174), tEast = nodeNear(net, 73.75543, 18.59183);
    expect(dM(tWest.coordinates, tEast.coordinates)).toBeGreaterThan(90);
    expect(own.get(tWest.id)?.id).not.toBe(own.get(tEast.id)?.id);
    for (const j of js) if (j.nodeIds.some(n => [deckEnd.id, ground.id, tWest.id, tEast.id].includes(n))) expect(j.radiusM, j.label).toBeLessThan(40);
  });

  it('University Road / Baner Road: two slip-lane pairs 45 m apart with nothing between them are not one junction made of slip-lane ends', () => {
    const north = nodeNear(net, 73.82816, 18.54247), south = nodeNear(net, 73.82777, 18.54196);
    expect(dM(north.coordinates, south.coordinates)).toBeGreaterThan(40);
    expect(own.get(north.id)?.id).not.toBe(own.get(south.id)?.id);
  });

  it('every slip lane is at grade, and no junction is grown from slip-lane ends alone', () => {
    for (const j of js) for (const r of j.slipLaneRoadIds) {
      const t = tagsOf(roadById.get(r));
      expect(t.bridge === undefined || t.bridge === 'no', `${j.label} ${r}`).toBe(true);
      expect(t.layer === undefined || t.layer === '0', `${j.label} ${r}`).toBe(true);
    }
  });

  it('Rajgopalachari Chowk: the whole 75 m roundabout ring is one junction (the 50 m span limit cut it in two)', () => {
    const ring = fx.roads.filter(r => ['roundabout', 'circular'].includes(tagsOf(r).junction ?? '') && r.name === 'Rajgopalachari Chowk');
    expect(ring.length).toBeGreaterThanOrEqual(2);
    const ringNodes = [...net.edges.values()].filter(e => ring.some(r => r.id === e.roadId)).flatMap(e => [e.fromNodeId, e.toNodeId]).filter(n => own.has(n));
    expect(new Set(ringNodes.map(n => own.get(n)!.id)).size).toBe(1);
    const j = own.get(ringNodes[0])!;
    const names = [...j.approaches, ...j.exits].map(a => a.name);
    expect(names).toContain('Jawaharlal Nehru Marg');
    expect(names).toContain('Sardar Moodliar Path');
    for (const a of j.approaches) expect(j.movements.some(m => m.approachId === a.id), a.label).toBe(true);
  });

  it('no node is in two junctions, and the result does not depend on the order of the roads', () => {
    const seen = new Set<string>();
    for (const j of js) for (const n of j.nodeIds) { expect(seen.has(n)).toBe(false); seen.add(n); }
    let s = 7;
    const rnd = () => (s = (s * 1103515245 + 12345) % 2147483648) / 2147483648;
    const shuffled = [...fx.roads].map(r => [rnd(), r] as const).sort((a, b) => a[0] - b[0]).map(x => x[1]);
    const again = grouped(shuffled).js;
    const key = (xs: readonly LogicalJunction[]) => xs.map(j => `${j.id}:${j.nodeKeys.join(',')}:${j.approaches.map(a => a.id).join(',')}:${j.exits.map(a => a.id).join(',')}`).sort();
    expect(key(again)).toEqual(key(js));
  });

  it('the simulator never folds nodes of two logical junctions into one simulated junction (one control each)', () => {
    expect(SIM_FOLD_M).toBe(JOIN_JUNCTION_M);
    const area = new StudyAreaExplorer().explore(fx.roads, 1, { seedRoadIds: ['osm_60977081'], rangeMeters: 400, direction: 'both' });
    const ja = owner(groupJunctions(area.network, new Map(fx.roads.map(r => [r.id, r as DrivableObject])), {}));
    const sim = new TrafficMicroSim(area, new Map(fx.roads.map(r => [r.id, r as DrivableObject])), { demandLevel: OD_REFERENCE_LEVEL, seed: 1 });
    let shared = 0, multi = 0;
    for (const ms of simMembers(sim).values()) {
      if (ms.length > 1) multi++;
      if (new Set(ms.filter(m => ja.has(m)).map(m => ja.get(m)!.id)).size > 1) shared++;
    }
    expect(multi).toBeGreaterThanOrEqual(3);
    expect(shared).toBe(0);
  });
});

// ── Editing invariants on 100 random junctions ─────────────────────────────

describe('editing invariants on 100 junctions drawn at random from the Sangamwadi roads', () => {
  const fx = load('sangamwadi.json');
  const signals = fx.signalPoints ?? [];
  const map = new Map(fx.roads.map(r => [r.id, r as DrivableObject]));
  const area: StudyArea = new StudyAreaExplorer().explore(fx.roads, 1, { seedRoadIds: ['osm_218681353'], rangeMeters: 2500, direction: 'both' });
  const js = groupJunctions(area.network, map, { signalPoints: signals });
  const own = owner(js);
  let s = 2026;
  const rnd = () => (s = (s * 1103515245 + 12345) % 2147483648) / 2147483648;
  const inArea = new Set(area.segments.map(x => x.key));
  const segOf = (id: string) => id.replace(/_(fwd|bwd)$/, '');
  // Junctions the simulation covers: every arm and internal piece is a study-area segment
  const pool = js.filter(j => j.approaches.length >= 2 && j.exits.length >= 2 && j.movements.length >= 2 &&
    [...j.approaches, ...j.exits].every(a => a.edgeIds.every(e => inArea.has(segOf(e)))) && j.internalEdgeIds.every(e => inArea.has(segOf(e))));
  const sample = pool.map(j => [rnd(), j] as const).sort((a, b) => a[0] - b[0]).slice(0, 100).map(x => x[1]);
  /** A hand-made edit that changes everything: its own signal plan (one phase per approach, 31 s), a ban and a lane connection. */
  const changed = (j: LogicalJunction): JunctionEditSpec => {
    const { asRun: _a, ...e } = defaultEdit(j); void _a;
    const m = j.movements[0];
    return { ...e, control: 'signal', signal: { amberS: 3, allRedS: 2, phases: j.approaches.map(a => ({ greenS: 31, arms: [a.id] })) },
      bannedMovements: [m.key], laneConnections: { [j.movements[1].key]: [[0, 0]] } };
  };
  const base = buildAssignmentNetwork(area, map, signals);
  const linkJson = (n: typeof base) => new Map(n.links.map(l => [l.id, JSON.stringify(l)]));
  const baseLinks = linkJson(base);

  it('the sample is 100 junctions, of every size', () => {
    expect(pool.length).toBeGreaterThanOrEqual(100);
    expect(sample).toHaveLength(100);
    expect(sample.some(j => j.nodeIds.length >= 4)).toBe(true);
    expect(sample.some(j => j.nodeIds.length === 1)).toBe(true);
  });

  it('assignment: a no-op edit (the starting values) leaves every link identical; an edit changes only its own junction\'s links', () => {
    for (const j of sample) {
      const noop = linkJson(buildAssignmentNetwork(area, map, signals, [defaultEdit(j)]));
      expect([...noop.entries()].filter(([id, v]) => baseLinks.get(id) !== v).map(([id]) => id), j.label).toEqual([]);
      const spec = changed(j);
      const c = compileJunctionEdits(area.network, [spec])[0];
      const mine = new Set([...c.approachOfEdge.keys(), ...c.exitOfEdge.keys(), ...c.chainOfEdge.keys(), ...c.internalEdges]);
      const after = linkJson(buildAssignmentNetwork(area, map, signals, [spec]));
      const diff = [...after.entries()].filter(([id, v]) => baseLinks.get(id) !== v).map(([id]) => id);
      for (const id of diff) expect(mine.has(id), `${j.label}: ${id}`).toBe(true);
      // Its member nodes belong to it alone
      for (const n of c.nodeIds) expect(own.get(n)?.id ?? j.id).toBe(j.id);
    }
  }, 120_000);

  it('simulator: a no-op edit keeps every control; an edit changes the controls of its own simulated junctions only, never one that holds a node of another junction', () => {
    // Equal splits: with Webster timing every signal retimes to the flows, and a ban re-routes traffic, so other signals' greens move with the flows (a network effect, not a control written to another junction)
    const opts = { demandLevel: OD_REFERENCE_LEVEL, seed: 1, signalPoints: signals, signalTiming: 'equal' as const };
    const sim0 = new TrafficMicroSim(area, map, opts);
    const c0 = new Map([...simControls(sim0)].map(([k, v]) => [k, ser(v)]));
    const members = simMembers(sim0);
    for (const j of sample.slice(0, 40)) {
      const noop = new TrafficMicroSim(area, map, { ...opts, junctionEdits: [defaultEdit(j)] });
      expect([...simControls(noop)].filter(([k, v]) => c0.get(k) !== ser(v)).map(([k]) => k), j.label).toEqual([]);
      const ed = new TrafficMicroSim(area, map, { ...opts, junctionEdits: [changed(j)] });
      const touched = [...simControls(ed)].filter(([k, v]) => c0.get(k) !== ser(v)).map(([k]) => k);
      expect(touched.length, j.label).toBeGreaterThan(0);
      for (const k of touched) {
        const ms = members.get(k) ?? [k];
        expect(ms.some(m => j.nodeIds.includes(m)), `${j.label}: ${k}`).toBe(true);
        for (const m of ms) expect(own.get(m)?.id ?? j.id, `${j.label}: ${k} holds ${m}`).toBe(j.id);
      }
    }
  }, 300_000);

  it('every arm of every junction has keys of its own (a two-way road running on through a node used to give its two approaches one key), and each edit compiles every stretch to its own arm', () => {
    let throughRoads = 0;
    for (const j of js) {
      const owners = new Map<string, string>();
      for (const a of [...j.approaches, ...j.exits]) for (const k of a.keys) { expect(owners.get(k) ?? a.id, `${j.label} ${k}`).toBe(a.id); owners.set(k, a.id); }
      const legacy = new Map<string, Set<string>>();
      for (const a of j.approaches) for (const id of a.edgeIds) { const k = legacyInKey(area.network, area.network.edges.get(id)!); (legacy.get(k) ?? legacy.set(k, new Set()).get(k)!).add(a.id); }
      for (const a of j.exits) for (const id of a.edgeIds) { const k = legacyOutKey(area.network, area.network.edges.get(id)!); (legacy.get(k) ?? legacy.set(k, new Set()).get(k)!).add(a.id); }
      if ([...legacy.values()].some(v => v.size > 1)) throughRoads++;
    }
    // The old keys collided at many of these junctions
    expect(throughRoads).toBeGreaterThan(10);
    for (const j of sample) {
      const c = compileJunctionEdits(area.network, [defaultEdit(j)])[0];
      for (const a of j.approaches) for (const id of a.edgeIds) expect(c.approachOfEdge.get(id), `${j.label} ${a.label}`).toBe(a.id);
      for (const a of j.exits) for (const id of a.edgeIds) expect(c.exitOfEdge.get(id), `${j.label} ${a.label}`).toBe(a.id);
    }
  });

  it('an edit saved before the side was in the keys still compiles where its keys are unambiguous', () => {
    const j = sample.find(x => x.approaches.length >= 3)!;
    const spec = defaultEdit(j);
    const old: JunctionEditSpec = { ...spec, arms: spec.arms.map(a => ({ ...a, keys: a.keys.map(k => k.split('~')[0]), chainKeys: a.chainKeys.map(k => k.split('~')[0]) })) };
    const c = compileJunctionEdits(area.network, [old])[0];
    expect(c.approachOfEdge.size).toBe(j.approaches.reduce((n, a) => n + a.edgeIds.length, 0));
    expect(c.exitOfEdge.size).toBe(j.exits.reduce((n, a) => n + a.edgeIds.length, 0));
  });

  it('a banned turn is honoured by both routers: no assigned or simulated route makes it', () => {
    const sim = (edits: JunctionEditSpec[]) => new TrafficMicroSim(area, map, { demandLevel: OD_REFERENCE_LEVEL, seed: 1, junctionEdits: edits });
    let checked = 0, rerouted = 0;
    for (const j of sample.slice(0, 30)) {
      const m = j.movements.find(x => x.turn !== 'u_turn') ?? j.movements[0];
      const [inE, outE] = m.edgePairs[0];
      const from = area.network.edges.get(inE)!.fromNodeId, to = area.network.edges.get(outE)!.toNodeId;
      const { asRun: _a, ...rest } = defaultEdit(j); void _a;
      const ban: JunctionEditSpec = { ...rest, bannedMovements: [m.key] };
      const pairs = new Set(m.edgePairs.map(p => p.join('>')));
      const internal = new Set(j.internalEdgeIds);
      /** The route makes the banned movement: a pair (in, out) with only pieces inside the junction between. */
      const makes = (ids: string[]) => ids.some((id, i) => { let k = i + 1; while (k < ids.length && internal.has(ids[k])) k++; return k < ids.length && pairs.has(`${id}>${ids[k]}`); });
      const demand: MicroDemandTrip[] = [{ fromNodeId: from, toNodeId: to, vehiclesPerHour: 100, kind: 'car' }];
      const res = assignTraffic(area, map, demand, { junctionEdits: [ban] });
      for (const ps of res.odPaths) for (const p of ps) { const ids = [...res.paths[p.pathId]].map(i => res.links[i].id); expect(makes(ids), `assignment ${j.label}`).toBe(false); }
      const sm = sim([ban]) as unknown as { route(a: string, b: string): { route: number[] } | null; links: { id: string }[]; junction(id: string): string };
      const r = sm.route(sm.junction(from), sm.junction(to));
      if (r) { const ids = r.route.map(i => sm.links[i].id); expect(makes(ids), `simulator ${j.label}`).toBe(false); rerouted++; }
      checked++;
    }
    expect(checked).toBe(30);
    expect(rerouted).toBeGreaterThanOrEqual(8);
  }, 300_000);
});

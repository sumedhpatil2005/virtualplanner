/**
 * Junction-level editing of imported junctions (docs/OVERHAUL.md §23).
 *
 *  - Grouping: OSM draws one junction as several nodes and short pieces; they
 *    are grouped into one logical junction with its approaches and exits, on
 *    the real roads around Sangamwadi (fixtures/sangamwadi.json) and on small
 *    synthetic layouts (a divided-road crossing; two junctions 60 m apart).
 *  - The engine honours an edit: the signal plan (simulator and assignment),
 *    banned turns (both routers), priority and lane connections.
 *  - An edit is a Build edit: it changes the network key, the analysis
 *    re-runs, and Undo gives back the identical network and the kept result.
 */
import { describe, it, expect, beforeEach } from 'vitest';
import fs from 'fs';
import path from 'path';
import type { RoadObject, RoadClassification, JunctionObject } from '../objects/types';
import { ObjectManager } from '../objects/ObjectManager';
import { HistoryManager } from '../history/HistoryManager';
import { TrafficNetworkBuilder } from '../simulation/TrafficNetworkBuilder';
import { StudyAreaExplorer, type StudyArea, type DrivableObject } from '../simulation/StudyAreaExplorer';
import { TrafficMicroSim, STEP_S, OD_REFERENCE_LEVEL, JOIN_JUNCTION_M, type MicroDemandTrip, type VehicleKind } from '../simulation/TrafficMicroSim';
import { groupJunctions, nodeKey, INTERNAL_MAX_M, ENCLOSED_CHAIN_M, MAX_SPAN_M, SIM_FOLD_M, type LogicalJunction } from '../simulation/junctionGroups';
import { defaultEdit, validateEdit, cycleOf, splitJunctionObjects, compileJunctionEdits, simJunctionSetups, type JunctionEditSpec } from '../simulation/junctionControl';
import { runSignalStructure } from '../simulation/RoadAnalysis';
import { buildAssignmentNetwork, assignTraffic } from '../simulation/staticAssignment';
import { junctionsAround, junctionOfRoad, applyJunctionEdit, junctionEditObject, junctionFrame, FRAME_RANGE_PER_RADIUS } from '../editing/junctionEdits';
import { networkContentKey } from '../simulation/StudyDemand';
import { SimulationMode } from '../simulation/SimulationMode';
import { junctionApproachDeltas } from '../simulation/junctionCompare';
import { startingDraft, startingNote, lastRunControl, setGreen, setControl, setTiming, toggleMajor, toggleArmInPhase, toggleBan, toggleLane, defaultLanePairs } from '../editing/junctionDraft';
import { createElement } from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import { JunctionCompareCard } from '../../components/JunctionCompareCard';

const fx = JSON.parse(fs.readFileSync(path.join(__dirname, 'fixtures/sangamwadi.json'), 'utf8')) as { roads: RoadObject[]; signalPoints: [number, number][] };
const fxRoads = new Map(fx.roads.map(r => [r.id, r as DrivableObject]));
const fxNet = new TrafficNetworkBuilder().build(fx.roads).network;
const fxJunctions = groupJunctions(fxNet, fxRoads, { signalPoints: fx.signalPoints });
const junctionWithNode = (js: readonly LogicalJunction[], lng: number, lat: number) => {
  const key = [...fxNet.nodes.values()].map(n => n.coordinates).sort((a, b) => Math.hypot(a[0] - lng, a[1] - lat) - Math.hypot(b[0] - lng, b[1] - lat))[0];
  return js.find(j => j.nodeKeys.includes(nodeKey(key)))!;
};
/** Babasaheb Ambedkar Marg / Veer Santaji Ghorpade Road: the junction of the reported analysis suggestion (a divided-road square with signals). */
const AMBEDKAR = [73.8634, 18.5278] as const;
/** The square at Veer Santaji Ghorpade Marg / Dagadi Pool Road, south-west of Sangamwadi. */
const DAGADI = [73.85793, 18.52386] as const;

describe('grouping on the real roads around Sangamwadi', () => {
  it('Babasaheb Ambedkar Marg / Veer Santaji Ghorpade Road is one junction: the signalised square, its internal pieces and slip lanes', () => {
    const j = junctionWithNode(fxJunctions, ...AMBEDKAR);
    expect(j.label).toContain('Babasaheb Ambedkar Marg');
    expect(j.label).toContain('Veer Santaji Ghorpade Road');
    // The four corners of the divided-road crossing
    for (const [lng, lat] of [[73.86340, 18.52780], [73.86337, 18.52790], [73.86347, 18.52791], [73.86351, 18.52781]]) {
      expect(j.nodeIds.some(id => id.startsWith(`node_${lng.toFixed(5)}_${lat.toFixed(5)}`)), `${lng},${lat}`).toBe(true);
    }
    // The 12 m piece the user could select on its own is inside it
    expect(j.internalRoadIds).toContain('osm_216506286');
    expect(j.signalised).toBe(true);
    expect(j.slipLaneRoadIds).toContain('osm_314806612');
    const names = j.approaches.map(a => a.name);
    expect(names).toContain('Babasaheb Ambedkar Marg');
    expect(names).toContain('Veer Santaji Ghorpade Road');
    expect(j.approaches.length).toBeGreaterThanOrEqual(4);
    expect(j.exits.length).toBeGreaterThanOrEqual(3);
    // Every approach can leave by at least one exit
    for (const a of j.approaches) expect(j.movements.some(m => m.approachId === a.id), a.label).toBe(true);
    // No geometry changed: arms are network stretches of the imported roads
    for (const a of [...j.approaches, ...j.exits]) for (const id of a.edgeIds) expect(fxNet.edges.has(id)).toBe(true);
  });

  it('the Veer Santaji Ghorpade Marg / Dagadi Pool Road square near Sangamwadi is one junction: its four corners and the short stubs to the bridges', () => {
    const j = junctionWithNode(fxJunctions, ...DAGADI);
    for (const [lng, lat] of [[73.85793, 18.52386], [73.85784, 18.52394], [73.85801, 18.52405], [73.85808, 18.52397]]) {
      expect(j.nodeIds.some(id => id.startsWith(`node_${lng.toFixed(5)}_${lat.toFixed(5)}`)), `${lng},${lat}`).toBe(true);
    }
    expect(j.radiusM).toBeLessThan(30);
    expect(j.label).toContain('Veer Santaji Ghorpade Marg');
    expect(j.signalised).toBe(true);
    expect(j.internalEdgeIds.length).toBeGreaterThanOrEqual(4);
  });

  it('no node is in two junctions; internal pieces are short or slip lanes', () => {
    const seen = new Set<string>();
    for (const j of fxJunctions) for (const n of j.nodeIds) { expect(seen.has(n), n).toBe(false); seen.add(n); }
    for (const j of fxJunctions) for (const id of j.internalEdgeIds) {
      const e = fxNet.edges.get(id)!;
      expect(e.length <= INTERNAL_MAX_M + 1e-6 || j.slipLaneRoadIds.includes(e.roadId) || j.radiusM < 80, id).toBe(true);
    }
  });

  it('the junction id is stable: the same junction found from only the roads around it has the same id, nodes and arms', () => {
    const full = junctionWithNode(fxJunctions, ...AMBEDKAR);
    const local = junctionsAround(fx.roads, AMBEDKAR, fx.signalPoints).junctions.find(j => j.id === full.id)!;
    expect(local).toBeDefined();
    expect(local.nodeKeys).toEqual(full.nodeKeys);
    expect(local.approaches.map(a => a.id)).toEqual(full.approaches.map(a => a.id));
    expect(local.exits.map(a => a.id)).toEqual(full.exits.map(a => a.id));
  });

  it('clicking the 12 m internal piece finds the whole junction; a long road between junctions finds none', () => {
    const hit = junctionOfRoad(fx.roads, fxRoads.get('osm_216506286')!, fx.signalPoints)!;
    expect(hit.inside).toBe(true);
    expect(hit.junction.id).toBe(junctionWithNode(fxJunctions, ...AMBEDKAR).id);
    // The 368 m bridge deck is not part of a junction
    expect(junctionOfRoad(fx.roads, fxRoads.get('osm_208004768')!, fx.signalPoints)).toBeNull();
  });
});

// ── Synthetic layouts ───────────────────────────────────────────────────────

const LAT0 = 18.5;
const pt = (x: number, y: number): [number, number, number] => [73.8 + x / (111320 * Math.cos(LAT0 * Math.PI / 180)), LAT0 + y / 111320, 0];
const road = (id: string, pts: [number, number][], o: { cls?: RoadClassification; lanes?: number; oneWay?: boolean; name?: string } = {}): RoadObject => ({
  id, type: 'road', name: o.name ?? id, layerId: 'roads', scenarioId: 'base', coordinates: pts.map(p => pt(...p)), roadClass: o.cls ?? 'collector', width: 10, laneCount: o.lanes ?? 2, laneWidth: 3.5,
  hasDivider: false, dividerWidth: 0, hasFootpath: false, footpathWidth: 0, speedLimit: 40, isOneWay: o.oneWay ?? false, trafficCapacity: 1000, connectedJunctions: [], createdAt: '', updatedAt: '',
});
const groupsOf = (roads: RoadObject[], signals: [number, number][] = []) => {
  const net = new TrafficNetworkBuilder().build(roads).network;
  return { net, js: groupJunctions(net, new Map(roads.map(r => [r.id, r])), { signalPoints: signals.map(([x, y]) => [pt(x, y)[0], pt(x, y)[1]] as [number, number]) }) };
};

describe('grouping on synthetic layouts', () => {
  it('a divided road crossing a divided road (four one-way carriageways, 20 m apart) is one junction with four approaches and four exits', () => {
    const a = { cls: 'arterial' as RoadClassification, oneWay: true, lanes: 2 };
    const roads = [
      // East-west road: eastbound at y = -10, westbound at y = +10
      road('eb', [[-300, -10], [-10, -10], [10, -10], [300, -10]], { ...a, name: 'East West Road' }),
      road('wb', [[300, 10], [10, 10], [-10, 10], [-300, 10]], { ...a, name: 'East West Road' }),
      // North-south road: northbound at x = +10, southbound at x = -10
      road('nb', [[10, -300], [10, -10], [10, 10], [10, 300]], { ...a, name: 'North South Road' }),
      road('sb', [[-10, 300], [-10, 10], [-10, -10], [-10, -300]], { ...a, name: 'North South Road' }),
    ];
    const { js } = groupsOf(roads);
    const multi = js.filter(j => j.nodeIds.length > 1);
    expect(multi).toHaveLength(1);
    const j = multi[0];
    expect(j.nodeIds).toHaveLength(4);
    expect(j.approaches.map(x => x.label).sort()).toEqual(['East West Road from the east', 'East West Road from the west', 'North South Road from the north', 'North South Road from the south']);
    expect(j.exits).toHaveLength(4);
    // From the west: straight to the east, left to the north, right to the south (left-hand traffic), and the U-turn
    const fromW = j.approaches.find(x => x.label.endsWith('from the west'))!;
    const turns = Object.fromEntries(j.movements.filter(m => m.approachId === fromW.id).map(m => [j.exits.find(x => x.id === m.exitId)!.label, m.turn]));
    expect(turns).toEqual({ 'East West Road to the east': 'straight', 'North South Road to the north': 'left', 'North South Road to the south': 'right', 'East West Road to the west': 'u_turn' });
  });

  it('two junctions 60 m apart on one road stay two junctions; 20 m apart they are one', () => {
    const t = (gap: number) => [
      road('main', [[-300, 0], [0, 0], [gap, 0], [300, 0]], { name: 'Main Road', cls: 'arterial' }),
      road('sideA', [[0, 0], [0, 200]], { name: 'Side A' }),
      road('sideB', [[gap, 0], [gap, -200]], { name: 'Side B' }),
    ];
    const far = groupsOf(t(60)).js;
    expect(far.filter(j => j.nodeIds.length > 1)).toHaveLength(0);
    expect(far).toHaveLength(2);
    expect(new Set(far.map(j => j.id)).size).toBe(2);
    const near = groupsOf(t(20)).js;
    expect(near).toHaveLength(1);
    expect(near[0].nodeIds).toHaveLength(2);
  });
});

// ── The engine honours the edit ────────────────────────────────────────────

/** A crossroads of two collector roads, 300 m arms, signal at the centre. */
function crossroads(lanes = 2) {
  const roads = [
    road('w', [[-300, 0], [0, 0]], { lanes, name: 'West Road' }), road('e', [[0, 0], [300, 0]], { lanes, name: 'East Road' }),
    road('n', [[0, 0], [0, 300]], { lanes, name: 'North Road' }), road('s', [[0, -300], [0, 0]], { lanes, name: 'South Road' }),
  ];
  const area = new StudyAreaExplorer().explore(roads, 1, { seedRoadIds: ['w'], rangeMeters: 800, direction: 'both' });
  const { js } = groupsOf(roads, [[0, 0]]);
  return { roads, area, j: js.find(x => x.approaches.length === 4)! };
}
const nodeAt = (area: StudyArea, x: number, y: number) => {
  const [lng, lat] = pt(x, y);
  let best = '', bd = Infinity;
  area.network.nodes.forEach(n => { const d = Math.hypot(n.coordinates[0] - lng, n.coordinates[1] - lat); if (d < bd) { bd = d; best = n.id; } });
  return best;
};
const MIX: [VehicleKind, number][] = [['two_wheeler', 0.5], ['car', 0.35], ['auto', 0.15]];
const trips = (area: StudyArea, pairs: [[number, number], [number, number], number][]): MicroDemandTrip[] =>
  pairs.flatMap(([a, b, vph]) => MIX.map(([kind, s]) => ({ fromNodeId: nodeAt(area, ...a), toNodeId: nodeAt(area, ...b), vehiclesPerHour: vph * s, kind })));
/** A hand-made edit: the starting values without the "as run" mark, so its control and plan run as written. */
const editOf = (j: LogicalJunction): JunctionEditSpec => { const { asRun: _asRun, ...e } = defaultEdit(j); void _asRun; return e; };
const arm = (j: LogicalJunction, label: string) => [...j.approaches, ...j.exits].find(a => a.label === label)!;
const simOf = (area: StudyArea, roads: RoadObject[], demand: MicroDemandTrip[], edits?: JunctionEditSpec[], seed = 42) =>
  new TrafficMicroSim(area, new Map(roads.map(r => [r.id, r])), { demandLevel: OD_REFERENCE_LEVEL, seed, demandTrips: demand, signalPoints: [[pt(0, 0)[0], pt(0, 0)[1]]], signalTiming: 'webster', junctionEdits: edits });
function runFor(sim: TrafficMicroSim, warm: number, measure: number) {
  for (let i = 0; i < warm / STEP_S; i++) sim.step();
  sim.startAnalysis();
  for (let i = 0; i < measure / STEP_S; i++) sim.step();
  return sim.analysisCounts()!;
}
const linkInto = (area: StudyArea, roadId: string) => [...area.network.edges.values()].find(e => e.roadId === roadId && e.toNodeId === nodeAt(area, 0, 0))!.id;
const linkOutOf = (area: StudyArea, roadId: string) => [...area.network.edges.values()].find(e => e.roadId === roadId && e.fromNodeId === nodeAt(area, 0, 0))!.id;

describe('the engine honours a junction edit', () => {
  const plan = (j: LogicalJunction, ewGreen: number, nsGreen: number): JunctionEditSpec => {
    const e = editOf(j);
    const ew = [arm(j, 'West Road from the west').id, arm(j, 'East Road from the east').id], ns = [arm(j, 'North Road from the north').id, arm(j, 'South Road from the south').id];
    return { ...e, control: 'signal', signal: { amberS: 3, allRedS: 2, phases: [{ greenS: ewGreen, arms: ew }, { greenS: nsGreen, arms: ns }] } };
  };

  it('signal plan: the simulator runs the edited plan as fixed time, and a longer green for one approach shortens its delay and lengthens the other\'s', () => {
    const { roads, area, j } = crossroads();
    const demand = trips(area, [[[-300, 0], [300, 0], 700], [[0, -300], [0, 300], 700]]);
    const delay = (edits: JunctionEditSpec[]) => {
      const sim = simOf(area, roads, demand, edits);
      const c = runFor(sim, 300, 900);
      const at = (id: string) => c.links.find(l => l.id === id)!;
      const w = at(linkInto(area, 'w')), s = at(linkInto(area, 's'));
      return { sim, w: w.meanTimeS! - w.freeFlowS, s: s.meanTimeS! - s.freeFlowS, gW: w.gC, gS: s.gC };
    };
    const ewLong = delay([plan(j, 50, 10)]), nsLong = delay([plan(j, 10, 50)]);
    // The plan in force is the edited one, not a Webster retiming
    const p = ewLong.sim.signalPlans();
    expect(p).toHaveLength(1);
    expect(p[0].cycleS).toBe(70);
    expect(p[0].greensS).toEqual([50, 10]);
    expect(ewLong.gW).toBeCloseTo(50 / 70, 6);
    expect(ewLong.gS).toBeCloseTo(10 / 70, 6);
    expect(ewLong.w).toBeLessThan(nsLong.w);
    expect(ewLong.s).toBeGreaterThan(nsLong.s);
    validateEdit(plan(j, 50, 10)).forEach(m => expect(m).toBe(''));
    expect(cycleOf(plan(j, 50, 10).signal!)).toBe(70);
  }, 60000);

  it('signal plan: the area assignment takes the approach\'s green ratio and stop-line capacity from the plan', () => {
    const { roads, area, j } = crossroads();
    const map = new Map(roads.map(r => [r.id, r as DrivableObject]));
    const sig: [number, number][] = [[pt(0, 0)[0], pt(0, 0)[1]]];
    const base = buildAssignmentNetwork(area, map, sig);
    const ed = buildAssignmentNetwork(area, map, sig, [plan(j, 50, 10)]);
    const w = (n: typeof base) => n.links.find(l => l.id === linkInto(area, 'w'))!;
    const s = (n: typeof base) => n.links.find(l => l.id === linkInto(area, 's'))!;
    // Effective green = green + amber - 2 s start-up lost time
    expect(w(ed).gC).toBeCloseTo(51 / 70, 6);
    expect(s(ed).gC).toBeCloseTo(11 / 70, 6);
    expect(w(ed).stopLinePcu!).toBeGreaterThan(w(base).stopLinePcu!);
    expect(s(ed).stopLinePcu!).toBeLessThan(s(base).stopLinePcu!);
    // No control: no signal at all
    const none = buildAssignmentNetwork(area, map, sig, [{ ...editOf(j), control: 'none' }]);
    expect(w(none).gC).toBeNull();
  });

  it('banned turn: neither the assignment nor the simulator routes through it; they take the other way', () => {
    // Crossroads plus a diagonal from the east arm's end to the north arm's end: west -> north can go left at the crossroads, or straight on and round
    const { roads: base } = crossroads();
    const roads = [...base, road('diag', [[300, 0], [0, 300]], { name: 'Diagonal' })];
    const area = new StudyAreaExplorer().explore(roads, 1, { seedRoadIds: ['w'], rangeMeters: 900, direction: 'both' });
    const j = groupsOf(roads, [[0, 0]]).js.find(x => x.approaches.length === 4)!;
    const ban: JunctionEditSpec = { ...defaultEdit(j), bannedMovements: [`${arm(j, 'West Road from the west').id}>${arm(j, 'North Road to the north').id}`] };
    const map = new Map(roads.map(r => [r.id, r as DrivableObject]));
    const demand = trips(area, [[[-300, 0], [0, 300], 300]]);
    const inW = linkInto(area, 'w'), outN = linkOutOf(area, 'n');
    const uses = (res: ReturnType<typeof assignTraffic>) => res.odPaths.flatMap(ps => ps.map(p => [...res.paths[p.pathId]].map(i => res.links[i].id)));
    const before = assignTraffic(area, map, demand);
    expect(uses(before).some(p => p.join(',').includes(`${inW},${outN}`))).toBe(true);
    const after = assignTraffic(area, map, demand, { junctionEdits: [ban] });
    expect(after.unroutedVeh).toBe(0);
    for (const p of uses(after)) expect(p.join(',')).not.toContain(`${inW},${outN}`);
    expect(uses(after).every(p => p.includes(linkOutOf(area, 'e')))).toBe(true);
    // Simulator: the vehicle's route avoids the banned pair
    const sim = new TrafficMicroSim(area, map, { demandLevel: OD_REFERENCE_LEVEL, seed: 1, demandTrips: demand, junctionEdits: [ban] });
    const r = (sim as unknown as { route(a: string, b: string): { route: number[] } | null; links: { id: string }[] }).route(nodeAt(area, -300, 0), nodeAt(area, 0, 300))!;
    const ids = r.route.map(i => (sim as unknown as { links: { id: string }[] }).links[i].id);
    expect(ids.join(',')).not.toContain(`${inW},${outN}`);
    expect(ids).toContain(linkOutOf(area, 'e'));
    const plain = new TrafficMicroSim(area, map, { demandLevel: OD_REFERENCE_LEVEL, seed: 1, demandTrips: demand });
    const r0 = (plain as unknown as { route(a: string, b: string): { route: number[] } }).route(nodeAt(area, -300, 0), nodeAt(area, 0, 300));
    expect(r0.route.map(i => (plain as unknown as { links: { id: string }[] }).links[i].id).join(',')).toContain(`${inW},${outN}`);
  }, 60000);

  it('priority: the approaches marked major go first; the others give way', () => {
    const { roads, area, j } = crossroads();
    const demand = trips(area, [[[-300, 0], [300, 0], 600], [[300, 0], [-300, 0], 600], [[0, -300], [0, 300], 300]]);
    const giveWay = (major: string[]) => {
      const sim = simOf(area, roads, demand, [{ ...editOf(j), control: 'priority', majorArms: major.map(l => arm(j, l).id) }]);
      const c = runFor(sim, 200, 600);
      // Waiting for crossing traffic: a gap refused (giveWay) or a major-road vehicle still on its way through the
      // meeting point (conflict; since the conflict-point timing of the priority rules most of a minor road's wait is this)
      const hold = c.links.find(l => l.id === linkInto(area, 's'))!.hold;
      return hold.giveWay + hold.conflict;
    };
    const ewMajor = giveWay(['West Road from the west', 'East Road from the east']);
    const nsMajor = giveWay(['North Road from the north', 'South Road from the south']);
    // South approach as the minor road waits to give way; as a major road it does not
    expect(ewMajor).toBeGreaterThan(nsMajor + 20);
  }, 60000);

  it('lane connections: both entry lanes sent to exit lane 1 only put every vehicle on that lane, and pass fewer than the default', () => {
    // Two lanes each way
    const { roads, area, j } = crossroads(4);
    const demand = trips(area, [[[-300, 0], [300, 0], 1400]]);
    const move = `${arm(j, 'West Road from the west').id}>${arm(j, 'East Road to the east').id}`;
    const run = (edits: JunctionEditSpec[]) => {
      const sim = simOf(area, roads, demand, edits);
      const outE = linkOutOf(area, 'e');
      const lanesUsed = [0, 0];
      for (let i = 0; i < 600 / STEP_S; i++) {
        sim.step();
        const link = (sim as unknown as { links: { id: string; lanes: { pos: number }[][] }[] }).links.find(l => l.id === outE)!;
        link.lanes.forEach((lane, k) => { lanesUsed[k] += lane.filter(v => v.pos < 30).length; });
      }
      return { lanesUsed, through: sim.getMetrics().completedTrips };
    };
    const base = { ...editOf(j), control: 'none' as const };
    const dflt = run([base]);
    const one = run([{ ...base, laneConnections: { [move]: [[0, 0], [1, 0]] } }]);
    expect(dflt.lanesUsed[0]).toBeGreaterThan(0);
    expect(dflt.lanesUsed[1]).toBeGreaterThan(0);
    expect(one.lanesUsed[1]).toBe(0);
    expect(one.lanesUsed[0]).toBeGreaterThan(0);
    expect(one.through).toBeLessThan(dflt.through);
  }, 60000);
});

// ── Build edit → network key → recompute → undo ────────────────────────────

describe('a junction edit is a Build edit: key change, re-run, comparison, undo', () => {
  let om: ObjectManager, history: HistoryManager;
  beforeEach(() => {
    om = new ObjectManager();
    om.addMultiple(structuredClone(fx.roads), true);
    history = new HistoryManager(om);
  });
  const junctionObjs = () => om.getAll().filter((o): o is JunctionObject => o.type === 'junction');
  const content = () => JSON.stringify(om.getAll().map(o => { const { createdAt: _c, updatedAt: _u, ...rest } = o as unknown as Record<string, unknown>; void _c; void _u; return rest; }).sort((a, b) => String(a.id) < String(b.id) ? -1 : 1));

  it('edit → new network key → the analysis re-runs on the edited junction → comparison per approach → undo restores the identical network and the kept result', async () => {
    const j = junctionWithNode(fxJunctions, ...AMBEDKAR);
    const vsg = j.approaches.find(a => a.name === 'Veer Santaji Ghorpade Road')!;
    const mode = new SimulationMode(() => om.getAll().filter(o => o.type === 'road') as DrivableObject[], null, null, () => ({ buildings: [], junctions: junctionObjs() }),
      () => Promise.reject(new Error('no counts')), null, null);
    mode.analysisSeeds = [42];
    mode.enter();
    mode.setRange(700);
    // The road the analysis was about: Veer Santaji Ghorpade Road arriving at the junction
    mode.selectRoad(vsg.roadIds[0], false);
    await mode.runAnalysis();
    const key0 = mode.getState().analysis.key, out0 = mode.getState().analysis.output!;
    const net0 = networkContentKey(om.getAll().filter(o => o.type === 'road'), junctionObjs(), null);
    const content0 = content();
    await mode.captureBaseline();

    // Edit: signal with the Veer Santaji Ghorpade Road approach given a long green of its own
    const spec = editOf(j);
    const others = j.approaches.filter(a => a.id !== vsg.id).map(a => a.id);
    spec.control = 'signal';
    spec.signal = { amberS: 3, allRedS: 2, phases: [{ greenS: 60, arms: [vsg.id] }, { greenS: 20, arms: others }] };
    expect(validateEdit(spec)).toEqual([]);
    applyJunctionEdit(om, history, spec, 'base', j.centre);
    expect(splitJunctionObjects(junctionObjs()).edits).toHaveLength(1);
    const net1 = networkContentKey(om.getAll().filter(o => o.type === 'road'), junctionObjs(), null);
    expect(net1).not.toBe(net0);
    mode.networkChanged();
    await new Promise(r => setTimeout(r, 400));
    expect(mode.getState().analysis.outdated).toBe(true);
    await mode.runAnalysis();
    const key1 = mode.getState().analysis.key, out1 = mode.getState().analysis.output!;
    expect(key1).not.toBe(key0);
    expect(out1).not.toBe(out0);
    // The edited plan ran: 60 + 20 + 2 x 5 = 90 s cycle at the junction, green ratio 60/90 on the approach
    const net = mode.getState().area!.network;
    const deltas = junctionApproachDeltas(net, spec, out0.result, out1.result)!;
    const v = deltas.approaches.find(a => a.armId === vsg.id)!;
    expect(v.after.gC).toBeCloseTo(60 / 90, 3);
    expect([...(out1.result.signalCycles?.values() ?? [])]).toContain(90);

    await mode.runComparison();
    const cmp = mode.getState().comparison;
    expect(cmp.result!.inputs).toMatchObject({ matched: true });

    history.undo();
    expect(content()).toBe(content0);
    expect(networkContentKey(om.getAll().filter(o => o.type === 'road'), junctionObjs(), null)).toBe(net0);
    mode.networkChanged();
    await new Promise(r => setTimeout(r, 400));
    expect(mode.getState().analysis.key).toBe(key0);
    expect(mode.getState().analysis.output).toBe(out0);
    expect(mode.getState().analysis.outdated).toBeFalsy();
    // Not only the kept result: a fresh analysis of the restored network gives the same figures to the digit
    const fresh = new SimulationMode(() => om.getAll().filter(o => o.type === 'road') as DrivableObject[], null, null, () => ({ buildings: [], junctions: junctionObjs() }),
      () => Promise.reject(new Error('no counts')), null, null);
    fresh.analysisSeeds = [42];
    fresh.enter();
    fresh.setRange(700);
    fresh.selectRoad(vsg.roadIds[0], false);
    await fresh.runAnalysis();
    expect(fresh.getState().analysis.key).toBe(key0);
    // Wall-clock timings left out (elapsedMs, timings)
    const plain = (r: unknown) => JSON.stringify(r, (k, x) => (k === 'elapsedMs' ? undefined : x instanceof Map ? [...x] : x));
    const { elapsedMs: _e0, timings: _t0, ...a0 } = out0;
    const { elapsedMs: _e1, timings: _t1, ...a1 } = fresh.getState().analysis.output!;
    void _e0; void _t0; void _e1; void _t1;
    expect(plain(a1)).toBe(plain(a0));
    fresh.dispose();
    history.redo();
    mode.networkChanged();
    await new Promise(r => setTimeout(r, 400));
    expect(mode.getState().analysis.key).toBe(key1);
    expect(mode.getState().analysis.output).toBe(out1);
    mode.dispose();
  }, 240000);

  it('the edit object is plain data that survives a save and reload (structured clone and JSON) unchanged', () => {
    const j = junctionWithNode(fxJunctions, ...AMBEDKAR);
    const o = junctionEditObject(defaultEdit(j), 'base', j.centre, 't');
    expect(JSON.parse(JSON.stringify(o))).toEqual(o);
    expect(structuredClone(o)).toEqual(o);
    expect(o.id).toBe(`${j.id}__base`);
  });
});

describe('junction editor draft and comparison card', () => {
  const j = junctionWithNode(fxJunctions, ...AMBEDKAR);
  it('with no analysis yet, starts from what the engine does: mapped signal, one phase per approach at 25 s, 3 s amber, 2 s all-red, marked as the engine\'s own', () => {
    const d = startingDraft(j, null, null);
    expect(d.source).toBe('default');
    expect(d.draft.control).toBe('signal');
    expect(d.draft.asRun).toBe(true);
    expect(d.draft.signal!.phases).toHaveLength(j.approaches.length);
    expect(d.draft.signal!.phases.every(p => p.greenS === 25 && p.arms.length === 1)).toBe(true);
    expect(cycleOf(d.draft.signal!)).toBe(30 * j.approaches.length);
    expect(startingNote(j, d)).toMatch(/Applying them unchanged keeps the simulation exactly as it was/);
  });
  it('from the last run: each approach gets the phase and green of the first signal that held it; an approach no signal held is always green', () => {
    // A run with one signal at the first corner: two approaches in phase 0 (40 s), one in phase 1 (10 s), a phase 2 (20 s) that held only pieces inside; the rest no signal
    const node = 'sim_corner';
    const signalLinks = new Map<string, { node: string; phase: number }>();
    const [a0, a1, a2] = j.approaches;
    for (const id of a0.edgeIds) signalLinks.set(id, { node, phase: 0 });
    for (const id of a1.edgeIds) signalLinks.set(id, { node, phase: 0 });
    for (const id of a2.edgeIds) signalLinks.set(id, { node, phase: 1 });
    const r = { signalLinks, signalGreens: new Map([[node, [40, 10, 20]]]), signalCycles: new Map([[node, 85]]) } as never;
    const run = lastRunControl(j, r, fxNet)!;
    expect(run.signals).toEqual([{ node, cycleS: 85, arms: [a0.id, a1.id, a2.id] }]);
    const rest = j.approaches.slice(3).map(a => a.id);
    expect(run.alwaysGreen).toEqual(rest);
    expect(run.plan).toEqual({ amberS: 3, allRedS: 2, phases: [{ greenS: 40, arms: [a0.id, a1.id, ...rest] }, { greenS: 10, arms: [a2.id, ...rest] }, { greenS: 20, arms: rest }] });
    expect(cycleOf(run.plan!)).toBe(85);
    const l = startingDraft(j, null, r, fxNet);
    expect(l.source).toBe('last-run');
    expect(l.draft).toMatchObject({ control: 'signal', asRun: true });
    expect(startingNote(j, l)).toMatch(/always green/);
    // A run covering the junction with no signal there: priority, as run
    const ranHere = new Map(j.approaches.flatMap(a => a.edgeIds).map(id => [id, 100]));
    const p = startingDraft(j, null, { signalLinks: new Map(), signalGreens: new Map(), signalCycles: new Map(), linkVph: ranHere } as never, fxNet);
    expect(p.source).toBe('last-run');
    expect(p.draft).toMatchObject({ control: 'priority', asRun: true });
    // A run that did not simulate this junction at all (it lies outside the run's corridor): not "ran without a signal",
    // but what the engine does here, the mapped signal (the Sangamwadi report: every junction opened as Priority, §26)
    expect(j.signalised).toBe(true);
    const out = startingDraft(j, null, { signalLinks: new Map(), signalGreens: new Map(), signalCycles: new Map(), linkVph: new Map([['elsewhere', 100]]) } as never, fxNet);
    expect(out.source).toBe('default');
    expect(out.draft).toMatchObject({ control: 'signal', asRun: true });
  });
  it('changing the control, a green, amber, a phase or the major approaches makes the plan the user\'s own; a ban or lane change keeps the engine\'s control', () => {
    const d = startingDraft(j, null, null).draft;
    expect(setGreen(d, 0, d.signal!.phases[0].greenS)).toBe(d);
    expect(setGreen(d, 0, 40).asRun).toBeUndefined();
    expect(setTiming(d, 'amberS', 4).asRun).toBeUndefined();
    expect(setControl(d, 'priority').asRun).toBeUndefined();
    expect(setControl(d, 'signal')).toBe(d);
    expect(toggleArmInPhase(d, 0, j.approaches[1].id).asRun).toBeUndefined();
    expect(toggleMajor(d, j.approaches[0].id).asRun).toBeUndefined();
    expect(toggleBan(d, j.movements[0].key).asRun).toBe(true);
    expect(toggleLane(d, j.movements[0].key, 0, 0, 2, 2).asRun).toBe(true);
  });
  it('draft changes: green, phase membership, bans, lane connections from the default', () => {
    let d = startingDraft(j, null, null).draft;
    d = setGreen(d, 0, 61.4);
    expect(d.signal!.phases[0].greenS).toBe(61);
    d = setGreen(d, 0, 1);
    expect(d.signal!.phases[0].greenS).toBe(5);
    const a = j.approaches[1].id;
    d = toggleArmInPhase(d, 0, a);
    expect(d.signal!.phases[0].arms).toContain(a);
    const m = j.movements[0].key;
    d = toggleBan(d, m);
    expect(d.bannedMovements).toEqual([m]);
    expect(defaultLanePairs(2, 2)).toEqual([[0, 0], [1, 1]]);
    expect(defaultLanePairs(2, 3)).toEqual([[0, 0], [0, 1], [1, 1], [1, 2]]);
    d = toggleLane(d, m, 1, 1, 2, 2);
    expect(d.laneConnections![m]).toEqual([[0, 0]]);
    expect(validateEdit({ ...d, control: 'signal', signal: { ...d.signal!, phases: [{ greenS: 20, arms: [] }] } })[0]).toMatch(/no green in any phase/);
  });
  it('the comparison card shows each approach before and after, and the junction as a whole', () => {
    const appr = (armId: string, label: string, b: number, a: number) => ({ armId, label, before: { delayS: b, vph: 500, gC: 0.3 }, after: { delayS: a, vph: 520, gC: 0.5 }, delayChangeS: a - b, verdict: (a < b - 2 ? 'better' : a > b + 2 ? 'worse' : 'same') as 'better' | 'worse' | 'same' });
    const html = renderToStaticMarkup(createElement(JunctionCompareCard, { items: [{ junctionId: 'jx_1', label: 'A / B', deltas: { approaches: [appr('in_1', 'A from the west', 120, 60), appr('in_2', 'B from the north', 30, 55)], total: appr('all', 'All approaches', 75, 58) } }] }));
    expect(html).toContain('Edited junction: A / B');
    expect(html).toContain('data-verdict="better"');
    expect(html).toContain('data-verdict="worse"');
    expect(html).toContain('120 s → ');
    expect(html).toContain('-60 s, shorter');
    expect(html).toContain('+25 s, longer');
    expect(html).toContain('green 30% → 50% of cycle');
  });
});

// ── The reported junction on the backend's roads (no signals loaded) ────────

/**
 * fixtures/ambedkar_db.json: the backend DB's roads within 250 m of Babasaheb
 * Ambedkar Marg / Veer Santaji Ghorpade Road, as the browser run had them (the
 * signal layer failed to load there, so no signal points).
 */
const db = JSON.parse(fs.readFileSync(path.join(__dirname, 'fixtures/ambedkar_db.json'), 'utf8')) as { roads: RoadObject[] };
const dbRoads = new Map(db.roads.map(r => [r.id, r as DrivableObject]));
const dbNet = new TrafficNetworkBuilder().build(db.roads).network;
const dbJunctions = groupJunctions(dbNet, dbRoads, {});
const M_LAT = 111320;
const dM = (a: readonly number[], b: readonly number[]) => Math.hypot((a[0] - b[0]) * M_LAT * Math.cos(a[1] * Math.PI / 180), (a[1] - b[1]) * M_LAT);
const dbNodeAt = (lng: number, lat: number) => [...dbNet.nodes.values()].sort((a, b) => dM(a.coordinates, [lng, lat]) - dM(b.coordinates, [lng, lat]))[0];
const dbJunctionOf = (lng: number, lat: number) => dbJunctions.find(j => j.nodeIds.includes(dbNodeAt(lng, lat).id));
const stretches = (nodeId: string) => { const n = dbNet.nodes.get(nodeId)!; return new Set([...n.incomingSegments, ...n.outgoingSegments].map(s => s.replace(/_(fwd|bwd)$/, ''))).size; };
/** Where Veer Santaji Ghorpade Road becomes Veer Santaji Ghorpade Marg, 8 m before the square: a plain node (2 stretches) with no signal loaded. */
const NAME_CHANGE = [73.8633, 18.52788] as const;

describe('grouping on the backend DB roads (the reported junction, no signals loaded)', () => {
  const j = dbJunctionOf(...AMBEDKAR)!;

  it('"Veer Santaji Ghorpade Marg" is the last 8 m of the north-east-bound carriageway, not a neighbouring junction: it is inside the junction, and the junction is the same with or without signals', () => {
    const q = dbNodeAt(...NAME_CHANGE);
    expect(dM(q.coordinates, NAME_CHANGE)).toBeLessThan(1);
    // A plain node: Veer Santaji Ghorpade Road in, Veer Santaji Ghorpade Marg out, nothing else; 2 m from the junction centre
    expect(stretches(q.id)).toBe(2);
    expect(dM(q.coordinates, j.centre)).toBeLessThan(8);
    expect(j.nodeIds).toContain(q.id);
    // The 39.5 m piece into it (from where the slip lane leaves) and the 7.9 m Marg piece are internal
    const marg = [...dbNet.edges.values()].find(e => e.roadId === 'osm_1146886465')!;
    expect(marg.length).toBeCloseTo(7.9, 0);
    expect(j.internalEdgeIds).toContain(marg.id);
    expect(j.internalRoadIds).toContain('osm_218681353');
    // (§26: the residential lane 8 m past the south-west slip lane end is in it: the simulator folds that T into the same simulated junction)
    expect(j.approaches.map(a => a.label)).toEqual(['Unnamed road from the north', 'Babasaheb Ambedkar Marg from the south-east', 'Unnamed road from the south-west', 'Veer Santaji Ghorpade Road from the south-west', 'Arjunrao Pawar Path from the north-west']);
    expect(j.exits.map(a => a.label)).toEqual(['Underpass to the north', 'Babasaheb Ambedkar Marg to the south-east', 'Unnamed road to the south-west', 'Veer Santaji Ghorpade Road to the south-west']);
    expect([...j.approaches, ...j.exits].some(a => a.name === 'Veer Santaji Ghorpade Marg')).toBe(false);
    expect(j.nodeIds).toHaveLength(14);
    expect(j.internalEdgeIds).toHaveLength(19);
    expect(j.id).toBe('jx_cdfebe2b');
    expect(j.radiusM).toBeLessThan(55);
    // Same junction (id, nodes, arms) as on the Sangamwadi roads with the mapped signals loaded
    const withSignals = junctionWithNode(fxJunctions, ...AMBEDKAR);
    expect(j.id).toBe(withSignals.id);
    expect(j.nodeKeys).toEqual(withSignals.nodeKeys);
    expect(j.approaches.map(a => a.id)).toEqual(withSignals.approaches.map(a => a.id));
    expect(j.exits.map(a => a.id)).toEqual(withSignals.exits.map(a => a.id));
  });

  it('the residential T 8 m past the south-west slip lane end is in the junction, as the simulator folds it (§26); the one 16 m past the south-east end (68 m out) stays separate', () => {
    const swT = dbNodeAt(73.86288, 18.52756), seT = dbNodeAt(73.86377, 18.52745);
    for (const n of [swT, seT]) expect(stretches(n.id)).toBe(3);
    // The slip lane's south-west end and the T are 8.4 m apart: shorter than the simulator's JOIN_JUNCTION_M, so one simulated junction with one control
    const slipEnd = j.nodeIds.map(id => dbNet.nodes.get(id)!).sort((a, b) => dM(a.coordinates, swT.coordinates) - dM(b.coordinates, swT.coordinates))[0];
    expect(dM(slipEnd.coordinates, swT.coordinates)).toBeLessThan(JOIN_JUNCTION_M);
    expect(SIM_FOLD_M).toBe(JOIN_JUNCTION_M);
    expect(j.nodeIds).toContain(swT.id);
    expect(j.nodeIds).not.toContain(seT.id);
    expect(dbJunctions.find(x => x.nodeIds.includes(seT.id))!.id).not.toBe(j.id);
    expect(dM(seT.coordinates, j.centre)).toBeGreaterThan(MAX_SPAN_M);
    // Every member node is a junction node of this junction's roads or a slip lane end: no road meets a member without being one of its arms or internal pieces
    const own = new Set([...j.internalRoadIds, ...j.approaches.flatMap(a => a.roadIds), ...j.exits.flatMap(a => a.roadIds)]);
    for (const id of j.nodeIds) {
      const n = dbNet.nodes.get(id)!;
      for (const e of [...n.incomingSegments, ...n.outgoingSegments]) expect(own.has(dbNet.edges.get(e)!.roadId), `${id} ${e}`).toBe(true);
    }
  });

  it('a road leaving a junction and coming back through plain nodes is inside it only when short: a 40 m dog-leg is absorbed, a 150 m loop is not', () => {
    const mk = (out: number) => [
      road('main', [[-300, 0], [-10, 0], [10, 0], [300, 0]], { name: 'Main Road', cls: 'arterial' }),
      road('side', [[-10, 0], [-10, -300]], { name: 'Side A' }),
      road('side2', [[10, 0], [10, 300]], { name: 'Side B' }),
      // Leaves the west node and comes back into the east node; the two ways meet at a plain node (a name change)
      road('loopA', [[-10, 0], [0, -out]], { name: 'Loop Lane', cls: 'local' }),
      road('loopB', [[0, -out], [10, 0]], { name: 'Loop Lane', cls: 'local' }),
    ];
    const short = groupsOf(mk(15)).js.filter(x => x.nodeIds.length > 1);
    expect(short).toHaveLength(1);
    expect(short[0].nodeIds).toHaveLength(3);
    expect(short[0].internalRoadIds).toEqual(expect.arrayContaining(['loopA', 'loopB']));
    expect(short[0].approaches.concat(short[0].exits).some(a => a.name === 'Loop Lane')).toBe(false);
    // 2 x 75 m: longer than ENCLOSED_CHAIN_M, so the bend stays outside and the lane is an exit and an approach
    const long = groupsOf(mk(75)).js.filter(x => x.nodeIds.length > 1);
    expect(long).toHaveLength(1);
    expect(long[0].nodeIds).toHaveLength(2);
    expect(long[0].exits.some(a => a.name === 'Loop Lane')).toBe(true);
    expect(ENCLOSED_CHAIN_M).toBeLessThan(2 * 75);
  });

  it('the camera frames the whole junction: every member, internal piece and arm stub inside the sphere, from far enough to see it', () => {
    const pts = [...j.nodeIds.map(id => dbNet.nodes.get(id)!.coordinates), ...j.internalEdgeIds.flatMap(id => dbNet.edges.get(id)!.coordinates)];
    const f = junctionFrame(pts);
    for (const p of pts) expect(dM(p, f.centre)).toBeLessThanOrEqual(f.radiusM + 0.01);
    expect(f.radiusM).toBeGreaterThan(40);
    expect(f.rangeM).toBeGreaterThanOrEqual(2 * f.radiusM);
    expect(f.rangeM).toBeCloseTo(Math.max(150, f.radiusM * FRAME_RANGE_PER_RADIUS), 6);
    expect(dM(f.centre, j.centre)).toBeLessThan(f.radiusM);
    expect(junctionFrame([])).toEqual({ centre: [0, 0, 0], radiusM: 0, rangeM: 0 });
  });
});

describe('the editor starts from exactly what the simulation ran; applying it unchanged changes nothing', () => {
  // The Sangamwadi roads with no signals loaded (as in the browser run): signals estimated from road classes
  const area = new StudyAreaExplorer().explore(fx.roads, 1, { seedRoadIds: ['osm_218681353'], rangeMeters: 700, direction: 'both' });
  const jArea = groupJunctions(area.network, fxRoads, {}).find(x => x.id === junctionWithNode(fxJunctions, ...AMBEDKAR).id)!;
  const probe = new TrafficMicroSim(area, fxRoads, { demandLevel: OD_REFERENCE_LEVEL, seed: 1 });
  const sources = probe.getSourceNodes(), sinks = probe.getSinkNodes();
  const MIXK: [VehicleKind, number][] = [['two_wheeler', 0.5], ['car', 0.35], ['auto', 0.15]];
  // Traffic from every edge entry to the exits on the far side of the junction (so its approaches carry flow and the signals are timed by Webster)
  const far = (from: string) => sinks.filter(t => t !== from).sort((a, b) => dM(area.network.nodes.get(b)!.coordinates, area.network.nodes.get(from)!.coordinates) - dM(area.network.nodes.get(a)!.coordinates, area.network.nodes.get(from)!.coordinates)).slice(0, 2);
  const demand: MicroDemandTrip[] = sources.flatMap(a => far(a).flatMap(b => MIXK.map(([kind, sh]) => ({ fromNodeId: a, toNodeId: b, vehiclesPerHour: 120 * sh, kind }))));
  const sim = (edits?: JunctionEditSpec[]) => {
    const s = new TrafficMicroSim(area, fxRoads, { demandLevel: OD_REFERENCE_LEVEL, seed: 42, demandTrips: demand, signalTiming: 'webster', junctionEdits: edits });
    return { s, c: runFor(s, 300, 600) };
  };

  it('the plan is the run\'s (the signal that held most approaches: its phases and greens, a phase that held only pieces inside kept; then the other signals\' phases); a no-op Apply gives the identical simulation and assignment', () => {
    const base = sim();
    expect(base.s.getMetrics().completedTrips).toBeGreaterThan(100);
    const st = runSignalStructure(base.s, base.c.links);
    const start = startingDraft(jArea, null, st as never, area.network);
    expect(start.source).toBe('last-run');
    const run = start.run!;
    expect(run.signals.length).toBeGreaterThanOrEqual(1);
    const plans = new Map(base.s.signalPlans().map(p => [p.nodeId, p]));
    const p0 = plans.get(run.signals[0].node)!;
    // Webster timing from the flows, not the 25 s default
    expect(p0.flowRatioSum).not.toBeNull();
    const plan = start.draft.signal!;
    const n0 = p0.greensS.length;
    expect(plan.phases.slice(0, n0).map(p => p.greenS)).toEqual(p0.greensS.map(g => Math.max(5, Math.round(g))));
    expect(Math.abs(cycleOf({ ...plan, phases: plan.phases.slice(0, n0) }) - p0.cycleS)).toBeLessThanOrEqual(n0);
    // Every approach held by a signal is in the phase(s) of the signal that held it; the others are in every phase
    for (const a of jArea.approaches) {
      const inPhases = plan.phases.filter(p => p.arms.includes(a.id)).length;
      if (run.alwaysGreen.includes(a.id)) expect(inPhases).toBe(plan.phases.length);
      else expect(inPhases).toBeGreaterThanOrEqual(1);
    }
    expect(run.signals.reduce((n, x) => n + x.arms.length, 0)).toBeGreaterThanOrEqual(run.signalHeld);
    expect(start.draft).toMatchObject({ control: 'signal', asRun: true });

    // No-op Apply: the same simulation to the last vehicle, the same assignment
    const same = sim([start.draft]);
    expect(JSON.stringify(same.c.links)).toBe(JSON.stringify(base.c.links));
    expect(JSON.stringify(same.s.getMetrics())).toBe(JSON.stringify(base.s.getMetrics()));
    expect(JSON.stringify(same.s.signalPlans())).toBe(JSON.stringify(base.s.signalPlans()));
    const a0 = assignTraffic(area, fxRoads, demand), a1 = assignTraffic(area, fxRoads, demand, { junctionEdits: [start.draft] });
    expect(JSON.stringify(a1.links)).toBe(JSON.stringify(a0.links));

    // One green changed: the plan is the user's, fixed as entered, one cycle over every simulated junction of it
    const edited = setGreen(start.draft, 0, plan.phases[0].greenS + 20);
    expect(edited.asRun).toBeUndefined();
    const changed = sim([edited]);
    const mine = changed.s.signalPlans().filter(p => jArea.nodeIds.some(n => changed.s.junctionOfNode(n) === p.nodeId));
    expect(mine.length).toBeGreaterThan(0);
    expect(mine.every(p => p.cycleS === cycleOf(edited.signal!))).toBe(true);
    expect(JSON.stringify(changed.c.links)).not.toBe(JSON.stringify(base.c.links));
  }, 120000);

  it('in the simulator an approach in every phase is never stopped, and pieces inside the junction are never stopped', () => {
    const first = jArea.approaches[0].id;
    const c = compileJunctionEdits(area.network, [{ ...editOf(jArea), control: 'signal', signal: { amberS: 3, allRedS: 2, phases: [
      { greenS: 20, arms: jArea.approaches.map(a => a.id) }, { greenS: 20, arms: [first] }] } }]);
    const links = (probe as unknown as { links: { index: number; id: string; from: string; to: string; roadId: string; lanes: unknown[] }[] }).links.map(l => ({ index: l.index, id: l.id, from: l.from, to: l.to, roadId: l.roadId, lanes: l.lanes.length }));
    const { setups } = simJunctionSetups(c, links, n => [n, ...area.network.nodes.has(n) ? jArea.nodeIds.filter(m => probe.junctionOfNode(m) === n) : []]);
    expect(setups.length).toBeGreaterThan(0);
    let firstSeen = 0, othersSeen = 0, insideSeen = 0;
    const inside = new Set(setups.map(x => x.simNode));
    for (const x of setups) for (const [index, phase] of x.phaseOfLink) {
      const l = links[index];
      if (inside.has(l.from)) { expect(phase).toBe(-1); insideSeen++; continue; }
      const arm = c[0].approachOfEdge.get(l.id) ?? c[0].chainOfEdge.get(l.id);
      // The first approach is in both phases (always green), the others only in phase 1
      if (arm === first) { expect(phase).toBe(-1); firstSeen++; } else if (arm) { expect(phase).toBe(0); othersSeen++; }
    }
    expect(firstSeen).toBeGreaterThan(0);
    expect(othersSeen).toBeGreaterThan(0);
    expect(insideSeen).toBeGreaterThan(0);
  });
});

describe('a no-op Apply through the whole analysis: same numbers', () => {
  it('apply the unchanged starting plan → new network key, the analysis re-runs → identical results; a changed green → different results', async () => {
    const om = new ObjectManager();
    om.addMultiple(structuredClone(fx.roads), true);
    const history = new HistoryManager(om);
    const junctionObjs = () => om.getAll().filter((o): o is JunctionObject => o.type === 'junction');
    const mode = new SimulationMode(() => om.getAll().filter(o => o.type === 'road') as DrivableObject[], null, null, () => ({ buildings: [], junctions: junctionObjs() }),
      () => Promise.reject(new Error('no counts')), null, null);
    mode.analysisSeeds = [42];
    mode.enter();
    mode.setRange(700);
    mode.selectRoad('osm_218681353', false);
    await mode.runAnalysis();
    const key0 = mode.getState().analysis.key, out0 = mode.getState().analysis.output!;
    expect(out0.result.signalLinks?.size).toBeGreaterThan(0);
    const net = mode.getState().area!.network;
    const j = groupJunctions(net, fxRoads, {}).find(x => x.id === junctionWithNode(fxJunctions, ...AMBEDKAR).id)!;
    const start = startingDraft(j, null, out0.result, net);
    expect(start.source).toBe('last-run');
    expect(start.draft).toMatchObject({ control: 'signal', asRun: true });
    applyJunctionEdit(om, history, start.draft, 'base', j.centre);
    mode.networkChanged();
    await new Promise(r => setTimeout(r, 400));
    expect(mode.getState().analysis.outdated).toBe(true);
    await mode.runAnalysis();
    const out1 = mode.getState().analysis.output!;
    expect(mode.getState().analysis.key).not.toBe(key0);
    expect(out1).not.toBe(out0);
    const plain = (r: unknown) => JSON.stringify(r, (k, x) => (k === 'elapsedMs' || k === 'timings' ? undefined : x instanceof Map ? [...x] : x));
    expect(plain(out1.result)).toBe(plain(out0.result));

    // A real change: 20 s more green in the first phase
    history.undo();
    applyJunctionEdit(om, history, setGreen(start.draft, 0, start.draft.signal!.phases[0].greenS + 20), 'base', j.centre);
    mode.networkChanged();
    await new Promise(r => setTimeout(r, 400));
    await mode.runAnalysis();
    expect(plain(mode.getState().analysis.output!.result)).not.toBe(plain(out0.result));
    mode.dispose();
  }, 240000);
});

describe('with mapped signals loaded, a junction the run did not simulate starts from the engine\'s control, not as Priority (§26)', () => {
  // Reported: with mapped signals, every junction round the Sangamwadi deck opened as Priority. The run simulates its corridor
  // (here the 1 km area's 700 m corridor) and the OSM signals of the area lie at or beyond its edge, so inside it Priority is
  // what OSM maps; but the junctions outside it, never simulated, were shown as "ran without a signal" too.
  it('Sangamwadi deck, 1 km, the fixture\'s OSM signal positions: inside the run as run (no signal mapped there), outside as the engine does (mapped signal)', async () => {
    const om = new ObjectManager();
    om.addMultiple(structuredClone(fx.roads), true);
    const signals = { signalsIn: async (b: { minLng: number; maxLng: number; minLat: number; maxLat: number }) => fx.signalPoints.filter(([x, y]) => x >= b.minLng && x <= b.maxLng && y >= b.minLat && y <= b.maxLat) } as never;
    const mode = new SimulationMode(() => om.getAll().filter(o => o.type === 'road') as DrivableObject[], null, signals, () => ({ buildings: [], junctions: [] }),
      () => Promise.reject(new Error('no counts')), null, null);
    mode.analysisSeeds = [42];
    mode.enter();
    mode.setRange(1000);
    mode.selectRoad('osm_208004768', false);
    for (let i = 0; i < 50 && mode.getState().signals.status !== 'ready'; i++) await new Promise(r => setTimeout(r, 50));
    expect(mode.getState().signals.status).toBe('ready');
    await mode.runAnalysis();
    const st = mode.getState(), r = st.analysis.output!.result, net = st.area!.network;
    const sigs = fx.signalPoints.filter(([x, y]) => { const b = st.area!.bounds; return x >= b.minLng && x <= b.maxLng && y >= b.minLat && y <= b.maxLat; });
    const js = groupJunctions(net, fxRoads, { signalPoints: sigs }).filter(j => j.nodeIds.length > 1 || j.signalised);
    let inRun = 0, outMapped = 0;
    for (const j of js) {
      const s = startingDraft(j, null, r, net);
      const ran = j.approaches.some(a => a.edgeIds.some(id => r.linkVph.has(id)));
      if (ran) {
        inRun++;
        expect(s.source).toBe('last-run');
        // Priority only where OSM maps no signal at the junction
        if (s.draft.control === 'priority') expect(j.signalised).toBe(false);
      } else if (!j.internalEdgeIds.some(id => r.linkVph.has(id))) {
        expect(s.source).toBe('default');
        expect(s.draft.control).toBe(j.signalised ? 'signal' : 'priority');
        if (j.signalised) outMapped++;
      }
    }
    expect(inRun).toBeGreaterThan(10);
    expect(outMapped).toBeGreaterThanOrEqual(3);
  }, 120000);
});

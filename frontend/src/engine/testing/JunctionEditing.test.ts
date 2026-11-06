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
import { TrafficMicroSim, STEP_S, OD_REFERENCE_LEVEL, type MicroDemandTrip, type VehicleKind } from '../simulation/TrafficMicroSim';
import { groupJunctions, nodeKey, INTERNAL_MAX_M, type LogicalJunction } from '../simulation/junctionGroups';
import { defaultEdit, validateEdit, cycleOf, splitJunctionObjects, type JunctionEditSpec } from '../simulation/junctionControl';
import { buildAssignmentNetwork, assignTraffic } from '../simulation/staticAssignment';
import { junctionsAround, junctionOfRoad, applyJunctionEdit, junctionEditObject } from '../editing/junctionEdits';
import { networkContentKey } from '../simulation/StudyDemand';
import { SimulationMode } from '../simulation/SimulationMode';
import { junctionApproachDeltas } from '../simulation/junctionCompare';
import { startingDraft, setGreen, toggleArmInPhase, toggleBan, toggleLane, defaultLanePairs, lastRunTiming } from '../editing/junctionDraft';
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
    const e = defaultEdit(j);
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
    const none = buildAssignmentNetwork(area, map, sig, [{ ...defaultEdit(j), control: 'none' }]);
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
      const sim = simOf(area, roads, demand, [{ ...defaultEdit(j), control: 'priority', majorArms: major.map(l => arm(j, l).id) }]);
      const c = runFor(sim, 200, 600);
      return c.links.find(l => l.id === linkInto(area, 's'))!.hold.giveWay;
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
    const base = { ...defaultEdit(j), control: 'none' as const };
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
    const spec = defaultEdit(j);
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
  it('starts from what the engine does: mapped signal, one phase per approach at 25 s, 3 s amber, 2 s all-red; from the last run\'s greens when there is one', () => {
    const d = startingDraft(j, null, null);
    expect(d.source).toBe('default');
    expect(d.draft.control).toBe('signal');
    expect(d.draft.signal!.phases).toHaveLength(j.approaches.length);
    expect(d.draft.signal!.phases.every(p => p.greenS === 25 && p.arms.length === 1)).toBe(true);
    expect(cycleOf(d.draft.signal!)).toBe(30 * j.approaches.length);
    // Last run: two approaches at 40% of a 100 s cycle, the others at 10%
    const linkDelay = new Map<string, { delayS: number | null; vph: number; gC: number | null }>();
    j.approaches.forEach((a, i) => a.edgeIds.forEach(id => linkDelay.set(id, { delayS: 10, vph: 100, gC: i < 2 ? 0.4 : 0.1 })));
    const r = { linkDelay, signalCycles: new Map([[j.nodeIds[0], 100]]) } as never;
    expect(lastRunTiming(j, r)!.cycleS).toBe(100);
    const l = startingDraft(j, null, r);
    expect(l.source).toBe('last-run');
    expect(l.draft.signal!.phases.map(p => [p.greenS, p.arms.length]).sort()).toEqual([[10, j.approaches.length - 2], [40, 2]]);
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

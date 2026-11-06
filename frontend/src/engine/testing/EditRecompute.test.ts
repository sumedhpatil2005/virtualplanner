import { describe, it, expect, beforeEach } from 'vitest';
import fs from 'fs';
import path from 'path';
import type { RoadObject } from '../objects/types';
import { ObjectManager } from '../objects/ObjectManager';
import { HistoryManager } from '../history/HistoryManager';
import { laneEditPlan, roadFieldUpdates, carriagewayPieces } from '../editing/roadEdits';
import { StudyAreaExplorer, type DrivableObject, type StudyArea } from '../simulation/StudyAreaExplorer';
import { applyNetworkCorrections, validateCorrectionLayer } from '../simulation/networkCorrections';
import { applyUrbanSpeeds, midblockCapacityPcu } from '../simulation/roadParameters';
import { compileAreaDemand } from '../simulation/AreaDemand';
import { roadSection } from '../simulation/roadSection';
import { sectionDirections, areaContext } from '../simulation/RoadAnalysis';
import { assignTraffic } from '../simulation/staticAssignment';
import { snapDemandPlan, networkContentKey } from '../simulation/StudyDemand';
import { TrafficMicroSim } from '../simulation/TrafficMicroSim';
import { runAnalysisJob } from '../simulation/analysisJob';
import { SimulationMode } from '../simulation/SimulationMode';

/**
 * Build edits and recompute (docs/OVERHAUL.md §14), on the real OpenStreetMap
 * roads within 1 km of Sangamwadi Bridge, Pune (fixtures/sangamwadi.json).
 *
 * Sangamwadi Bridge is a divided road mapped as one-way ways, each 2 lanes:
 * eastbound osm_661187162 (60 m approach) -> osm_208004768 (368 m deck) ->
 * osm_1151682763 (136 m approach); westbound four other ways. A lane edit in
 * Build goes through the same code as the properties panel (roadFieldUpdates
 * via laneEditPlan), the object store (ObjectManager) and undo (HistoryManager);
 * the simulation sees the roads the way SimulationMode.getRoads gives them.
 */

const fx = JSON.parse(fs.readFileSync(path.join(__dirname, 'fixtures/sangamwadi.json'), 'utf8')) as { roads: RoadObject[]; signalPoints: [number, number][] };
const DECK = 'osm_208004768';
const EAST = ['osm_661187162', DECK, 'osm_1151682763'];
const WEST = ['osm_1151682762', 'osm_227095239', 'osm_661187159', 'osm_661187161'];
const RANGE_M = 700;

const simRoads = (om: ObjectManager): DrivableObject[] =>
  applyUrbanSpeeds(applyNetworkCorrections(om.getAll().filter(o => o.type === 'road') as DrivableObject[], null).roads).roads;

function analyse(roads: DrivableObject[], revision: number, explorer = new StudyAreaExplorer()) {
  const map = new Map(roads.map(r => [r.id, r]));
  const area = explorer.explore(roads, revision, { seedRoadIds: [DECK], rangeMeters: RANGE_M, direction: 'both' });
  const plan = compileAreaDemand({ buildings: [] }, area, map)!;
  const trips = snapDemandPlan(plan, area.network, 250, new Set(area.segments.map(s => s.key)));
  const res = assignTraffic(area, map, trips, { signalPoints: fx.signalPoints });
  const section = roadSection(area, map, [DECK]);
  const dirs = sectionDirections(area, section, map);
  const ctx = areaContext(res, area, map, section, dirs, plan.provenance.vehiclesPerHour);
  const east = dirs.findIndex(d => d.linkIds.some(id => id.startsWith(DECK)));
  return { area, map, res, dirs, ctx, east, west: 1 - east };
}
const edgeLanes = (area: StudyArea) => new Map([...area.network.edges.values()].map(e => [e.id, e.lanes]));
const roadOfEdge = (id: string) => id.replace(/_seg_\d+_(fwd|bwd)$/, '');

let om: ObjectManager, history: HistoryManager;
beforeEach(() => {
  om = new ObjectManager();
  om.addMultiple(structuredClone(fx.roads), true);
  history = new HistoryManager(om);
});

/** A lane edit as the Build properties panel makes it. */
function buildLaneEdit(roadId: string, field: 'lanesForward' | 'lanesBackward', value: number) {
  const roads = om.getAll().filter(o => o.type === 'road') as RoadObject[];
  const plan = laneEditPlan(roads, roadId, field, value, r => om.synthesizeDefaultSections(r));
  const before = plan.map(p => structuredClone(om.getById(p.id)!));
  if (plan.length === 1) history.recordUpdate(before[0], { ...before[0], ...plan[0].updates } as RoadObject);
  else history.pushDiff({ type: 'batch', diffs: plan.map((p, i) => ({ type: 'update', id: p.id, before: before[i], after: { ...before[i], ...p.updates } as RoadObject })), description: 'lanes' });
  for (const p of plan) om.update(p.id, p.updates, true);
  return plan.map(p => p.id);
}

describe('Build lane edits recompute the road analysis', () => {
  it('capacity scales with lanes: IRC:106 mid-block capacity of a divided primary carriageway, 2 vs 3 lanes', () => {
    const deck = fx.roads.find(r => r.id === DECK)!;
    expect(midblockCapacityPcu(deck, 2, false, true)).toBeCloseTo(3600 / 2 / 0.7, 6); // 4-lane divided, per direction
    expect(midblockCapacityPcu(deck, 3, false, true)).toBeCloseTo(5400 / 2 / 0.7, 6); // 6-lane divided, per direction
  });

  it('adding a lane to the bridge widens its whole carriageway in the compiled network and the assignment, and nothing else', () => {
    const a0 = analyse(simRoads(om), 1);
    const changed = buildLaneEdit(DECK, 'lanesForward', 3);
    // The edit covers the bridge's eastbound carriageway (its approach pieces carry the same name and lanes), not the other direction
    expect(new Set(changed)).toEqual(new Set(EAST));
    const a1 = analyse(simRoads(om), 2);
    const l0 = edgeLanes(a0.area), l1 = edgeLanes(a1.area);
    expect([...l1.keys()].sort()).toEqual([...l0.keys()].sort());
    for (const [id, lanes] of l1) expect(lanes, id).toBe(EAST.includes(roadOfEdge(id)) ? 3 : l0.get(id));
    const cap0 = new Map(a0.res.links.map(l => [l.id, l.midblockPcu]));
    for (const l of a1.res.links) expect(Math.round(l.midblockPcu), l.id).toBe(Math.round(EAST.includes(l.roadId) ? 5400 / 2 / 0.7 : cap0.get(l.id)!));
    // The section's eastbound figures follow: 3 lanes, 3,857 PCU/h; westbound stays 2 lanes, 2,571 PCU/h
    expect(a0.ctx.directions[a0.east]).toMatchObject({ lanes: 2 });
    expect(Math.round(a0.ctx.directions[a0.east].midblockPcu)).toBe(2571);
    expect(a1.ctx.directions[a1.east]).toMatchObject({ lanes: 3 });
    expect(Math.round(a1.ctx.directions[a1.east].midblockPcu)).toBe(3857);
    expect(a1.ctx.directions[a1.west]).toMatchObject({ lanes: 2 });
    expect(Math.round(a1.ctx.directions[a1.west].midblockPcu)).toBe(2571);
  }, 60000);

  it('a direction widened on only part of its length reports the lanes of the stretch its capacity comes from', () => {
    // One piece edited on its own (as a user can, e.g. a different lane count on the deck than the approaches)
    const deck = om.getById(DECK) as RoadObject;
    om.update(DECK, roadFieldUpdates(deck, 'lanesForward', 3, r => om.synthesizeDefaultSections(r)), true);
    const a = analyse(simRoads(om), 1);
    const east = a.ctx.directions[a.east];
    // Before the fix: "3 lanes" (length-weighted mean) beside 2,571 PCU/h (the 2-lane approaches' capacity)
    expect(Math.round(east.midblockPcu)).toBe(2571);
    expect(east.lanes).toBe(2);
    expect(east).toMatchObject({ lanesRange: [2, 3] });
  }, 60000);

  it('changes the network key, so a re-run is not served the stale result; the explorer recompiles on the new revision', () => {
    const r0 = simRoads(om), k0 = networkContentKey(r0, [], fx.signalPoints);
    const explorer = new StudyAreaExplorer();
    explorer.explore(r0, 1, { seedRoadIds: [DECK], rangeMeters: RANGE_M, direction: 'both' });
    buildLaneEdit(DECK, 'lanesForward', 3);
    const r1 = simRoads(om);
    expect(networkContentKey(r1, [], fx.signalPoints)).not.toBe(k0);
    // SimulationMode bumps its revision on every road change (TwinCityEngine -> networkChanged); the compiled graph follows it
    const fresh = explorer.explore(r1, 2, { seedRoadIds: [DECK], rangeMeters: RANGE_M, direction: 'both' });
    expect(fresh.network.edges.get(`${DECK}_seg_1_fwd`)?.lanes).toBe(3);
  }, 60000);

  it('the micro-simulation drives the new lane count', () => {
    buildLaneEdit(DECK, 'lanesForward', 3);
    const roads = simRoads(om);
    const corridor = new StudyAreaExplorer().explore(roads, 1, { seedRoadIds: [DECK], rangeMeters: 300, direction: 'both' });
    const sim = new TrafficMicroSim(corridor, new Map(roads.map(r => [r.id, r])), { demandLevel: 0, seed: 42, demandTrips: [], signalPoints: fx.signalPoints });
    sim.startAnalysis();
    const links = sim.analysisCounts()!.links;
    for (const id of EAST) for (const l of links.filter(x => x.roadId === id)) expect(l.lanes, l.id).toBe(3);
    for (const id of WEST) for (const l of links.filter(x => x.roadId === id)) expect(l.lanes, l.id).toBe(2);
  }, 60000);

  it('undoing the edit restores the original network key and result exactly', () => {
    const r0 = simRoads(om), a0 = analyse(r0, 1);
    const k0 = networkContentKey(r0, [], fx.signalPoints);
    buildLaneEdit(DECK, 'lanesForward', 3);
    const a1 = analyse(simRoads(om), 2);
    expect(a1.res.links.map(l => l.capacityPcu)).not.toEqual(a0.res.links.map(l => l.capacityPcu));
    history.undo();
    const r2 = simRoads(om), a2 = analyse(r2, 3);
    expect(networkContentKey(r2, [], fx.signalPoints)).toBe(k0);
    expect(Array.from(a2.res.volPcu)).toEqual(Array.from(a0.res.volPcu));
    expect(a2.res.links.map(l => l.capacityPcu)).toEqual(a0.res.links.map(l => l.capacityPcu));
    expect(a2.ctx.directions).toEqual(a0.ctx.directions);
  }, 60000);

  it('an edit outside the study area changes nothing in it', () => {
    const a0 = analyse(simRoads(om), 1);
    const inArea = new Set([...a0.area.network.edges.values()].map(e => e.roadId));
    const far = fx.roads.find(r => !inArea.has(r.id) && r.type === 'road' && !r.isOneWay && (r.sections?.[0]?.carriagewayA?.lanes ?? 0) >= 1)!;
    expect(far).toBeTruthy();
    buildLaneEdit(far.id, 'lanesForward', 3);
    const a1 = analyse(simRoads(om), 2);
    expect(Array.from(a1.res.volPcu)).toEqual(Array.from(a0.res.volPcu));
    expect(a1.ctx.directions).toEqual(a0.ctx.directions);
  }, 60000);
});

describe('which pieces a lane edit covers', () => {
  const LAT0 = 18.5;
  const pt = (x: number, y: number): [number, number, number] => [73.8 + x / (111320 * Math.cos(LAT0 * Math.PI / 180)), LAT0 + y / 111320, 0];
  const road = (id: string, a: [number, number], b: [number, number], extra: Partial<RoadObject> = {}): RoadObject => ({
    id, type: 'road', name: 'Test Road', layerId: 'roads', scenarioId: 'base', coordinates: [pt(...a), pt(...b)], roadClass: 'arterial', width: 10, laneCount: 2, laneWidth: 3.5,
    hasDivider: false, dividerWidth: 0, hasFootpath: false, footpathWidth: 0, speedLimit: 40, isOneWay: false, trafficCapacity: 2000, connectedJunctions: [], createdAt: '', updatedAt: '', ...extra,
  } as RoadObject);
  const om2 = () => new ObjectManager();
  const load = (rs: RoadObject[]) => { const m = om2(); m.addMultiple(rs, true); return m.getAll() as RoadObject[]; };

  it('follows a two-way road drawn the other way round with its directions swapped, and stops at a main road of another name', () => {
    const rs = load([road('a', [0, 0], [200, 0]), road('b', [400, 0], [200, 0]), road('c', [400, 0], [600, 0]),
      road('x', [400, -200], [400, 0], { name: 'Cross Road', roadClass: 'collector' }), road('y', [400, 0], [400, 200], { name: 'Cross Road', roadClass: 'collector' })]);
    const p = carriagewayPieces(rs, 'a', 'lanesForward');
    expect(p.map(x => [x.road.id, x.field])).toEqual([['a', 'lanesForward'], ['b', 'lanesBackward']]);
  });
  it('stops where the lanes differ, at a fork, and leaves unnamed roads to the piece clicked', () => {
    const rs = load([road('a', [0, 0], [200, 0], { isOneWay: true, laneCount: 2 }), road('b', [200, 0], [400, 0], { isOneWay: true, laneCount: 3 }),
      road('c', [-200, 0], [0, 0], { isOneWay: true }), road('d1', [-400, 50], [-200, 0], { isOneWay: true }), road('d2', [-400, -50], [-200, 0], { isOneWay: true }),
      road('u1', [0, 500], [200, 500], { name: '' }), road('u2', [200, 500], [400, 500], { name: '' })]);
    expect(carriagewayPieces(rs, 'a', 'lanesForward').map(x => x.road.id).sort()).toEqual(['a', 'c']);
    expect(carriagewayPieces(rs, 'u1', 'lanesForward').map(x => x.road.id)).toEqual(['u1']);
  });
  it('never takes the other carriageway of a divided road', () => {
    const rs = fx.roads as RoadObject[];
    expect(new Set(carriagewayPieces(rs, DECK, 'lanesForward').map(x => x.road.id))).toEqual(new Set(EAST));
    expect(new Set(carriagewayPieces(rs, 'osm_227095239', 'lanesForward').map(x => x.road.id))).toEqual(new Set(WEST));
  });
});

describe('the whole road analysis after a lane edit (assignment and micro-simulation)', () => {
  it('re-runs on the edited network: the eastbound capacity rises and the westbound one does not; undo gives the first result back', async () => {
    const job = () => {
      const roads = simRoads(om), map = new Map(roads.map(r => [r.id, r]));
      const ex = new StudyAreaExplorer();
      const area = ex.explore(roads, 1, { seedRoadIds: [DECK], rangeMeters: RANGE_M, direction: 'both' });
      const corridor = ex.explore(roads, 1, { seedRoadIds: [DECK], rangeMeters: 300, direction: 'both' });
      return { area, corridor, roads: map, options: { demandLevel: 0.12, signalTiming: 'webster' as const, signalPoints: fx.signalPoints }, plan: compileAreaDemand({ buildings: [] }, area, map)!,
        section: roadSection(area, map, [DECK]), hourFactor: 1, seeds: [42], warmupS: 60, measureS: 180 };
    };
    const pick = (o: Awaited<ReturnType<typeof runAnalysisJob>>) => o.result.directions.map(d => ({ lanes: d.lanes, capacityPcu: d.capacityPcu, midblockPcu: d.midblockPcu, vph: d.vph, speed: d.meanSpeedKmh, label: d.label }));
    const before = pick(await runAnalysisJob(job(), undefined, 1e9));
    buildLaneEdit(DECK, 'lanesForward', 3);
    const after = pick(await runAnalysisJob(job(), undefined, 1e9));
    history.undo();
    const undone = pick(await runAnalysisJob(job(), undefined, 1e9));
    const mids = (x: typeof before) => x.map(d => d.midblockPcu).sort((a, b) => a - b);
    expect(mids(before)).toEqual([2571, 2571]);
    expect(mids(after)).toEqual([2571, 3857]);
    expect(after.find(d => d.midblockPcu === 3857)!.lanes).toBe(3);
    expect(undone).toEqual(before);
    if (process.env.EDIT_RECOMPUTE_LOG) console.log(JSON.stringify({ before, after, undone }));
  }, 120000);
});

describe('Simulate after a Build edit (SimulationMode: road cache, compiled graph, analysis key)', () => {
  it('marks the shown result outdated, re-runs on the edited network, and after undo is back on the first key and result', async () => {
    const mode = new SimulationMode(() => om.getAll().filter(o => o.type === 'road') as DrivableObject[], null, null, () => ({ buildings: [] }),
      () => Promise.reject(new Error('no counts')), null, null);
    mode.analysisSeeds = [42];
    mode.enter();
    mode.setRange(RANGE_M);
    mode.selectRoad(DECK, false);
    const read = () => { const r = mode.getState().analysis.output!.result; return r.directions.map(d => ({ label: d.label, lanes: d.lanes, midblockPcu: d.midblockPcu, vc: d.vc, vph: d.vph })); };
    const out0 = await mode.runAnalysis();
    expect(out0).toBeTruthy();
    const key0 = mode.getState().analysis.key, first = read();
    expect(first.map(d => d.midblockPcu)).toEqual([2571, 2571]);

    // The engine calls networkChanged on every road change (TwinCityEngine objects.onChange)
    buildLaneEdit(DECK, 'lanesForward', 3);
    mode.networkChanged();
    await new Promise(r => setTimeout(r, 400)); // re-map debounce
    expect(mode.getState().analysis.outdated).toBe(true);
    await mode.runAnalysis();
    const key1 = mode.getState().analysis.key, second = read();
    expect(key1).not.toBe(key0);
    expect(mode.getState().analysis.outdated).toBeFalsy();
    expect(second.find(d => d.label === 'eastbound')).toMatchObject({ lanes: 3, midblockPcu: 3857 });
    expect(second.find(d => d.label === 'westbound')).toMatchObject({ lanes: 2, midblockPcu: 2571 });

    history.undo();
    mode.networkChanged();
    await new Promise(r => setTimeout(r, 400));
    await mode.runAnalysis();
    expect(mode.getState().analysis.key).toBe(key0);
    expect(read()).toEqual(first);

    // Redo the same edit: its result is kept by analysis key (docs §16), so it comes back at once, not outdated
    buildLaneEdit(DECK, 'lanesForward', 3);
    mode.networkChanged();
    await new Promise(r => setTimeout(r, 400));
    expect(mode.getState().analysis.key).toBe(key1);
    expect(mode.getState().analysis.outdated).toBeFalsy();
    history.undo();
    mode.networkChanged();
    await new Promise(r => setTimeout(r, 400));
    expect(mode.getState().analysis.key).toBe(key0);

    // An edit with no kept result, then undo before its re-run lands: the shown result is current again, so it is not marked outdated
    buildLaneEdit(DECK, 'lanesForward', 4);
    mode.networkChanged();
    await new Promise(r => setTimeout(r, 400));
    expect(mode.getState().analysis.outdated).toBe(true);
    history.undo();
    mode.networkChanged();
    await new Promise(r => setTimeout(r, 400));
    expect(mode.getState().analysis.key).toBe(key0);
    expect(mode.getState().analysis.outdated).toBe(false);
    mode.dispose();
  }, 120000);
});

describe('lanes set in Build win over the correction layer', () => {
  it('a set_lanes correction (shipped pune_west_v1, Sakharam Waghmare Chowk) no longer overrides the lanes the user set', () => {
    const layer = validateCorrectionLayer(JSON.parse(fs.readFileSync(path.resolve(__dirname, '../../../../backend/data/network_corrections/pune_west_v1.json'), 'utf8')));
    const fix = layer.corrections.find(c => c.id === 'sakharam-lanes-253976061')!;
    expect(fix).toMatchObject({ action: 'set_lanes', params: { lanes: 2 } });
    // A one-way 2-lane way standing in for OSM way 253976061
    const base = structuredClone(fx.roads.find(r => r.id === DECK)!) as RoadObject;
    const road = { ...base, id: 'osm_253976061', osmProvenance: { ...base.osmProvenance!, osmId: 253976061 } } as RoadObject;
    const m = new ObjectManager();
    m.addMultiple([road], true);
    // Untouched: the layer's 2 lanes
    expect(applyNetworkCorrections(m.getAll() as DrivableObject[], layer).roads[0]).toMatchObject({ laneCount: 2 });
    m.update(road.id, roadFieldUpdates(m.getById(road.id) as RoadObject, 'lanesForward', 3, r => m.synthesizeDefaultSections(r)), true);
    const { roads, report } = applyNetworkCorrections(m.getAll() as DrivableObject[], layer);
    expect(roads[0]).toMatchObject({ laneCount: 3 });
    expect((roads[0] as RoadObject).sections![0].carriagewayA.lanes).toBe(3);
    expect(report.userOverridden).toContain('sakharam-lanes-253976061');
    expect(report.notFound).not.toContain('sakharam-lanes-253976061');
  });
});

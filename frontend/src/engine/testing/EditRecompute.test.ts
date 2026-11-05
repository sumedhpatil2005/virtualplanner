import { describe, it, expect, beforeEach } from 'vitest';
import fs from 'fs';
import path from 'path';
import type { RoadObject } from '../objects/types';
import { ObjectManager } from '../objects/ObjectManager';
import { HistoryManager } from '../history/HistoryManager';
import { laneEditPlan, roadFieldUpdates } from '../editing/roadEdits';
import { StudyAreaExplorer, type DrivableObject, type StudyArea } from '../simulation/StudyAreaExplorer';
import { applyNetworkCorrections } from '../simulation/networkCorrections';
import { applyUrbanSpeeds, midblockCapacityPcu } from '../simulation/roadParameters';
import { compileAreaDemand } from '../simulation/AreaDemand';
import { roadSection } from '../simulation/roadSection';
import { sectionDirections, areaContext } from '../simulation/RoadAnalysis';
import { assignTraffic } from '../simulation/staticAssignment';
import { snapDemandPlan, networkContentKey } from '../simulation/StudyDemand';
import { TrafficMicroSim } from '../simulation/TrafficMicroSim';

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

import { describe, it, expect, beforeEach } from 'vitest';
import fs from 'fs';
import path from 'path';
import type { RoadObject } from '../objects/types';
import { ObjectManager } from '../objects/ObjectManager';
import { HistoryManager } from '../history/HistoryManager';
import { laneEditPlan, laneEditPreview, type LaneEditScope } from '../editing/roadEdits';
import { StudyAreaExplorer, type DrivableObject } from '../simulation/StudyAreaExplorer';
import { applyNetworkCorrections } from '../simulation/networkCorrections';
import { applyUrbanSpeeds } from '../simulation/roadParameters';
import { compileAreaDemand } from '../simulation/AreaDemand';
import { roadSection } from '../simulation/roadSection';
import { sectionDirections, areaContext, type DirectionFlow } from '../simulation/RoadAnalysis';
import { assignTraffic } from '../simulation/staticAssignment';
import { snapDemandPlan, networkContentKey } from '../simulation/StudyDemand';
import { laneInsights } from '../simulation/ScenarioComparison';
import { SimulationMode } from '../simulation/SimulationMode';

/**
 * Lane edit scope (docs/OVERHAUL.md §16), on the real OpenStreetMap roads
 * around Sangamwadi Bridge, Pune (fixtures/sangamwadi.json). Eastbound is
 * osm_661187162 (60 m approach) -> osm_208004768 (368 m deck) ->
 * osm_1151682763 (136 m approach), all 2 lanes.
 *
 * The carriageway is the deck and the east approach. The west approach
 * osm_661187162 has two trunk_link slip roads of the Old Pune–Mumbai Highway
 * joining inside it (osm_1355142505 at its vertex 2, osm_208099367 through its
 * vertex 3); a slip road takes its parent's class (a6e30e7: trunk_link ranks
 * as highway), and a carriageway run ends before a piece that passes a
 * junction with a main road of another name (carriagewayRun, §21). Before
 * a6e30e7 these slips were stored as local and the run reached the west
 * approach; after it the analysis (corrected classes) stopped at the deck
 * while the edit (stored classes) still reached it, until both ranked classes
 * alike (§27.7). The browser on the project database showed the same 2 pieces.
 *
 * "Entire connected carriageway" (the default) edits both; "Selected
 * segment only" edits the clicked way alone, and the analysis must then say
 * the 2-lane approach still sets the direction's capacity.
 */

const fx = JSON.parse(fs.readFileSync(path.join(__dirname, 'fixtures/sangamwadi.json'), 'utf8')) as { roads: RoadObject[]; signalPoints: [number, number][] };
const DECK = 'osm_208004768';
const APPROACH_W = 'osm_661187162', APPROACH_E = 'osm_1151682763';
const EAST = [DECK, APPROACH_E];
const RANGE_M = 700;

const simRoads = (om: ObjectManager): DrivableObject[] =>
  applyUrbanSpeeds(applyNetworkCorrections(om.getAll().filter(o => o.type === 'road') as DrivableObject[], null).roads).roads;

function analyse(roads: DrivableObject[]) {
  const map = new Map(roads.map(r => [r.id, r]));
  const area = new StudyAreaExplorer().explore(roads, 1, { seedRoadIds: [DECK], rangeMeters: RANGE_M, direction: 'both' });
  const plan = compileAreaDemand({ buildings: [] }, area, map)!;
  const trips = snapDemandPlan(plan, area.network, 250, new Set(area.segments.map(s => s.key)));
  const res = assignTraffic(area, map, trips, { signalPoints: fx.signalPoints });
  const section = roadSection(area, map, [DECK]);
  const dirs = sectionDirections(area, section, map);
  const ctx = areaContext(res, area, map, section, dirs, plan.provenance.vehiclesPerHour);
  const east = dirs.findIndex(d => d.linkIds.some(id => id.startsWith(DECK)));
  return { ctx, east, west: 1 - east };
}

let om: ObjectManager, history: HistoryManager;
beforeEach(() => {
  om = new ObjectManager();
  om.addMultiple(structuredClone(fx.roads), true);
  history = new HistoryManager(om);
});
const roadsNow = () => om.getAll().filter(o => o.type === 'road') as RoadObject[];

/** A lane edit as the Build properties panel makes it, with the chosen scope. */
function buildLaneEdit(roadId: string, field: 'lanesForward' | 'lanesBackward', value: number, scope: LaneEditScope) {
  const plan = laneEditPlan(roadsNow(), roadId, field, value, r => om.synthesizeDefaultSections(r), scope);
  const before = plan.map(p => structuredClone(om.getById(p.id)!));
  if (plan.length === 1) history.recordUpdate(before[0], { ...before[0], ...plan[0].updates } as RoadObject);
  else history.pushDiff({ type: 'batch', diffs: plan.map((p, i) => ({ type: 'update', id: p.id, before: before[i], after: { ...before[i], ...p.updates } as RoadObject })), description: 'lanes' });
  for (const p of plan) om.update(p.id, p.updates, true);
  return plan.map(p => p.id);
}

describe('lane edit scope: which ways change', () => {
  it('"Selected segment only" changes exactly the selected way', () => {
    const changed = buildLaneEdit(DECK, 'lanesForward', 3, 'segment');
    expect(changed).toEqual([DECK]);
    for (const id of EAST.filter(x => x !== DECK)) expect((om.getById(id) as RoadObject).sections?.[0]?.carriagewayA.lanes ?? 2, id).toBe(2);
    expect((om.getById(DECK) as RoadObject).sections![0].carriagewayA.lanes).toBe(3);
  });

  it('"Entire connected carriageway" (the default) changes the eastbound deck and east approach, not the west approach past the slip roads', () => {
    expect(new Set(buildLaneEdit(DECK, 'lanesForward', 3, 'carriageway'))).toEqual(new Set(EAST));
    // The default scope is the carriageway
    expect(new Set(laneEditPlan(roadsNow(), APPROACH_E, 'lanesForward', 4, r => om.synthesizeDefaultSections(r)).map(p => p.id))).toEqual(new Set(EAST));
    expect(((om.getById(APPROACH_W) as RoadObject).sections?.[0]?.carriagewayA.lanes ?? 2)).toBe(2);
  });

  it('the preview shows the same ways the edit then changes, with their count and total length', () => {
    for (const scope of ['segment', 'carriageway'] as const) {
      const preview = laneEditPreview(roadsNow(), DECK, 'lanesForward', scope);
      const plan = laneEditPlan(roadsNow(), DECK, 'lanesForward', 3, r => om.synthesizeDefaultSections(r), scope);
      expect(new Set(preview.roadIds), scope).toEqual(new Set(plan.map(p => p.id)));
    }
    const seg = laneEditPreview(roadsNow(), DECK, 'lanesForward', 'segment');
    expect(seg).toMatchObject({ count: 1, roadIds: [DECK] });
    expect(seg.lengthM).toBeGreaterThan(355);
    expect(seg.lengthM).toBeLessThan(380);
    expect(seg.label).toMatch(/^1 piece · \d+ m$/);
    const cw = laneEditPreview(roadsNow(), DECK, 'lanesForward', 'carriageway');
    expect(cw.count).toBe(2);
    expect(cw.lengthM).toBeGreaterThan(490);
    expect(cw.lengthM).toBeLessThan(520);
    expect(cw.label).toMatch(/^2 pieces · \d+ m$/);
  });
});

describe('lane edit scope: the analysis follows the edited network', () => {
  it('both scopes change the network key; the carriageway edit and the segment edit give different networks', () => {
    const k0 = networkContentKey(simRoads(om), [], fx.signalPoints);
    buildLaneEdit(DECK, 'lanesForward', 3, 'segment');
    const kSeg = networkContentKey(simRoads(om), [], fx.signalPoints);
    history.undo();
    expect(networkContentKey(simRoads(om), [], fx.signalPoints)).toBe(k0);
    buildLaneEdit(DECK, 'lanesForward', 3, 'carriageway');
    const kCw = networkContentKey(simRoads(om), [], fx.signalPoints);
    history.undo();
    expect(networkContentKey(simRoads(om), [], fx.signalPoints)).toBe(k0);
    expect(new Set([k0, kSeg, kCw]).size).toBe(3);
  });

  it('widening only the deck leaves eastbound capacity at 2,571 PCU/h and names the 2-lane approach that sets it', () => {
    buildLaneEdit(DECK, 'lanesForward', 3, 'segment');
    const { ctx, east } = analyse(simRoads(om));
    const e = ctx.directions[east];
    expect(Math.round(e.midblockPcu)).toBe(2571);
    expect(e.lanesRange).toEqual([2, 3]);
    // The binding stretch: the longer 2-lane approach, not the 3-lane deck
    expect(e.binding).toMatchObject({ roadId: APPROACH_E, lanes: 2, name: 'Sangamwadi Bridge' });
    expect(Math.round(e.binding!.capacityPcu)).toBe(2571);
    expect(e.binding!.lengthM).toBeGreaterThan(120);
    expect(e.binding!.lengthM).toBeLessThan(150);
    expect(new Set(e.bindingSegments.map(b => b.roadId))).toEqual(new Set([APPROACH_E]));
    expect(e.roadIds).toEqual(expect.arrayContaining(EAST));
  }, 60000);

  it('widening the carriageway moves eastbound capacity to 3,857 PCU/h, set along its whole length', () => {
    buildLaneEdit(DECK, 'lanesForward', 3, 'carriageway');
    const { ctx, east } = analyse(simRoads(om));
    const e = ctx.directions[east];
    expect(Math.round(e.midblockPcu)).toBe(3857);
    expect(e.lanesRange).toEqual([3, 3]);
    expect(e.binding).toMatchObject({ lanes: 3 });
    expect(new Set(e.bindingSegments.map(b => b.roadId))).toEqual(new Set(EAST));
    // The analysis measures the stretch the edit reached (§21): the same ways
    expect(new Set(e.roadIds)).toEqual(new Set(EAST));
  }, 60000);

  it('westbound is measured on the westbound deck and its approach, not the ramp where the carriageways meet', () => {
    const { ctx, west } = analyse(simRoads(om));
    expect(new Set(ctx.directions[west].roadIds)).toEqual(new Set(['osm_227095239', 'osm_1151682762']));
  }, 60000);
});

describe('lane insight in the comparison (pure)', () => {
  const dir = (label: string, cap: number, lanes: [number, number], binding: DirectionFlow['binding'], roadIds: string[]) =>
    ({ label, capacityPcu: cap, midblockPcu: cap, capacityBasis: 'midblock', lanes: lanes[0], lanesRange: lanes, binding, bindingSegments: binding ? [binding] : [], roadIds, bearingDeg: 90 }) as unknown as DirectionFlow;
  const approach = { roadId: APPROACH_E, name: 'Sangamwadi Bridge', lanes: 2, lengthM: 136, capacityPcu: 2571 };
  const deck = { roadId: DECK, name: 'Sangamwadi Bridge', lanes: 3, lengthM: 368, capacityPcu: 3857 };
  const roads = (deckLanes: number) => new Map(fx.roads.map(r => [r.id, (r.id === DECK ? { ...r, laneCount: deckLanes, sections: [{ ...r.sections![0], carriagewayA: { ...r.sections![0].carriagewayA, lanes: deckLanes } }] } : r) as DrivableObject]));

  it('flags an edited direction whose capacity did not change because a 2-lane stretch elsewhere still sets it', () => {
    const before = [dir('eastbound', 2571, [2, 2], approach, EAST)], after = [dir('eastbound', 2571, [2, 3], approach, EAST)];
    const ins = laneInsights(before, after, { before: roads(2), after: roads(3) }, []);
    expect(ins).toHaveLength(1);
    expect(ins[0]).toMatchObject({ direction: 'eastbound', editedRoadIds: [DECK], capacityChanged: false, bindingEdited: false, binding: approach, kind: 'unchanged_elsewhere' });
    expect(ins[0].text).toMatch(/2-lane/);
    expect(ins[0].text).toMatch(/osm_1151682763/);
    expect(ins[0].text).toMatch(/136 m/);
    expect(ins[0].text).toMatch(/model/i);
  });

  it('reports a capacity rise without a warning when the edited stretch is now the binding one, and nothing for directions not edited', () => {
    const before = [dir('eastbound', 2571, [2, 2], approach, EAST), dir('westbound', 2571, [2, 2], approach, ['osm_227095239'])];
    const after = [dir('eastbound', 3857, [3, 3], deck, EAST), dir('westbound', 2571, [2, 2], approach, ['osm_227095239'])];
    const ins = laneInsights(before, after, { before: roads(2), after: roads(3) }, []);
    expect(ins).toHaveLength(1);
    expect(ins[0]).toMatchObject({ direction: 'eastbound', capacityChanged: true, kind: 'raised' });
  });
});

describe('Simulate after a lane edit of either scope: outdated, re-run, undo restores the kept result', () => {
  const makeMode = () => {
    const mode = new SimulationMode(() => om.getAll().filter(o => o.type === 'road') as DrivableObject[], null, null, () => ({ buildings: [] }),
      () => Promise.reject(new Error('no counts')), null, null);
    mode.analysisSeeds = [42];
    mode.enter();
    mode.setRange(RANGE_M);
    mode.selectRoad(DECK, false);
    return mode;
  };
  const settle = () => new Promise(r => setTimeout(r, 400));
  const east = (mode: SimulationMode) => mode.getState().analysis.output!.result.directions.find(d => d.label === 'eastbound')!;

  it('segment only: re-run keeps 2,571 PCU/h and names the binding approach; the comparison says so; undo restores key and result without a re-run, redo too', async () => {
    const mode = makeMode();
    await mode.runAnalysis();
    const key0 = mode.getState().analysis.key, out0 = mode.getState().analysis.output;
    expect(Math.round(east(mode).capacityPcu)).toBe(2571);
    await mode.captureBaseline();

    expect(buildLaneEdit(DECK, 'lanesForward', 3, 'segment')).toEqual([DECK]);
    mode.networkChanged();
    await settle();
    expect(mode.getState().analysis.outdated).toBe(true);
    await mode.runAnalysis();
    const key1 = mode.getState().analysis.key, out1 = mode.getState().analysis.output;
    expect(key1).not.toBe(key0);
    expect(mode.getState().analysis.outdated).toBeFalsy();
    const e = east(mode);
    expect(e.midblockPcu).toBe(2571);
    expect(e.lanesRange).toEqual([2, 3]);
    expect(e.binding).toMatchObject({ roadId: APPROACH_E, lanes: 2 });

    // The proposal runs on the baseline's demand, hour and seeds, even if the analysis seeds changed since (docs/OVERHAUL.md §16)
    mode.analysisSeeds = [7];
    await mode.runComparison();
    mode.analysisSeeds = [42];
    const cmp = mode.getState().comparison;
    expect(cmp.current!.inputs).toEqual(cmp.baseline!.inputs);
    expect(cmp.current!.inputs.seeds).toEqual([42]);
    expect(cmp.result!.inputs).toMatchObject({ matched: true, mismatches: [] });
    const ins = mode.getState().comparison.result!.laneInsights;
    const ie = ins.find(x => x.direction === 'eastbound')!;
    expect(ie).toMatchObject({ editedRoadIds: [DECK], capacityChanged: false, bindingEdited: false, kind: 'unchanged_elsewhere' });
    expect(ie.binding).toMatchObject({ roadId: APPROACH_E });
    expect(ins.find(x => x.direction === 'westbound')).toBeUndefined();

    history.undo();
    mode.networkChanged();
    await settle();
    // Same network, demand and hour as the first result: it is back on show at once, not marked outdated
    expect(mode.getState().analysis.key).toBe(key0);
    expect(mode.getState().analysis.output).toBe(out0);
    expect(mode.getState().analysis.outdated).toBeFalsy();
    expect(mode.getState().analysis.status).toBe('ready');

    history.redo();
    mode.networkChanged();
    await settle();
    expect(mode.getState().analysis.key).toBe(key1);
    expect(mode.getState().analysis.output).toBe(out1);
    expect(mode.getState().analysis.outdated).toBeFalsy();
    mode.dispose();
  }, 180000);

  it('carriageway: re-run gives 3,857 PCU/h eastbound; undo restores the first key and result', async () => {
    const mode = makeMode();
    await mode.runAnalysis();
    const key0 = mode.getState().analysis.key, out0 = mode.getState().analysis.output;
    expect(new Set(buildLaneEdit(DECK, 'lanesForward', 3, 'carriageway'))).toEqual(new Set(EAST));
    mode.networkChanged();
    await settle();
    expect(mode.getState().analysis.outdated).toBe(true);
    await mode.runAnalysis();
    expect(mode.getState().analysis.key).not.toBe(key0);
    expect(east(mode)).toMatchObject({ lanes: 3, midblockPcu: 3857 });
    history.undo();
    mode.networkChanged();
    await settle();
    expect(mode.getState().analysis.key).toBe(key0);
    expect(mode.getState().analysis.output).toBe(out0);
    expect(mode.getState().analysis.outdated).toBeFalsy();
    mode.dispose();
  }, 180000);
});

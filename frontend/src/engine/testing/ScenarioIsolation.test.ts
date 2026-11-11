import { afterEach, describe, expect, it, vi } from 'vitest';
import { ObjectManager } from '../objects/ObjectManager';
import { HistoryManager, deleteWithHistory } from '../history/HistoryManager';
import { commitRoadFieldEdit, laneEditPreview } from '../editing/roadEdits';
import { filterObjectsForScenario } from '../scenarios/scenarioFilter';
import type { CityObject, RoadObject } from '../objects/types';
import { canon } from './editHarness';

/**
 * Scenario isolation (docs/SCENARIOS_AND_VERSIONING.md). A proposal is the baseline plus its own change set; the
 * baseline must not change while a proposal is edited, and proposals must not change each other.
 *
 * These cases were first run against the code before the fix (commit 72ea0bd) to reproduce the suspected defects
 * of docs/SYSTEM_ARCHITECTURE.md §1.7 #1–#3; the optional calls (`setActiveScenario?.`, `viewOf?.`) let the same
 * file run on both. Synthetic fixture: three straight roads, ids shaped like imported OSM ways.
 */

const LAT0 = 18.53;
const kx = 111320 * Math.cos(LAT0 * Math.PI / 180);
const pt = (x: number, y: number): [number, number, number] => [73.85 + x / kx, LAT0 + y / 111320, 0];
const road = (id: string, x0: number, x1: number, y = 0, extra: Partial<RoadObject> = {}): RoadObject => ({
  id, type: 'road', name: id, layerId: 'roads', scenarioId: 'base', coordinates: [pt(x0, y), pt(x1, y)], roadClass: 'arterial', width: 7, laneCount: 2, laneWidth: 3.5,
  hasDivider: false, dividerWidth: 0, hasFootpath: false, footpathWidth: 0, speedLimit: 50, isOneWay: true, trafficCapacity: 2000, connectedJunctions: [],
  createdAt: 'synthetic', updatedAt: 'synthetic', ...extra,
} as RoadObject);

interface Calls { post: CityObject[]; del: string[]; changes: { scenarioId: string; objectId: string; op: string }[] }

function setup() {
  const om = new ObjectManager();
  const calls: Calls = { post: [], del: [], changes: [] };
  vi.spyOn(om, 'syncPost').mockImplementation(async o => { calls.post.push(o); });
  vi.spyOn(om, 'syncPostMultiple').mockImplementation(async os => { calls.post.push(...os); });
  vi.spyOn(om, 'syncDelete').mockImplementation(async id => { calls.del.push(id); });
  vi.spyOn(om, 'syncDeleteMultiple').mockImplementation(async ids => { calls.del.push(...ids); });
  if ((om as any).syncChanges) vi.spyOn(om as any, 'syncChanges').mockImplementation(async (...args: any[]) => {
    const [scenarioId, list] = args as [string, { objectId: string; op: string }[]];
    for (const c of list) calls.changes.push({ scenarioId, objectId: c.objectId, op: c.op });
  });
  (om as any).deletedOsm = new Set<string>();
  // Three base roads in a line (one carriageway) and a far one
  om.addMultiple([road('osm_1', 0, 100, 0, { name: 'Main Rd' }), road('osm_2', 100, 200, 0, { name: 'Main Rd' }), road('osm_3', 200, 300, 0, { name: 'Main Rd' }), road('osm_9', 0, 100, 900)], true);
  const history = new HistoryManager(om);
  calls.post.length = 0;
  return { om, history, calls };
}
const activate = (om: ObjectManager, id: string) => (om as any).setActiveScenario?.(id);
/** The objects a scenario shows (baseline ⊕ its changes). */
const view = (om: ObjectManager, id: string): CityObject[] => (om as any).viewOf ? (om as any).viewOf(id) : filterObjectsForScenario(om.getAll(), id);
const viewKey = (om: ObjectManager, id: string) => canon([...view(om, id)].sort((a, b) => a.id.localeCompare(b.id)).map(o => ({ ...o, updatedAt: undefined, createdAt: undefined })));
const byId = (om: ObjectManager, scen: string, id: string) => view(om, scen).find(o => o.id === id) as RoadObject | undefined;
const shown = (om: ObjectManager, id: string) => om.getById(id) as RoadObject;
afterEach(() => vi.restoreAllMocks());

describe('defect #1: editing a base road while a proposal is active', () => {
  it('a lane edit in a proposal leaves the baseline (memory and backend rows) unchanged', () => {
    const { om, history, calls } = setup();
    const base0 = viewKey(om, 'base');
    activate(om, 'P');
    commitRoadFieldEdit(om, history, shown(om, 'osm_2'), 'lanesForward', 4, 'segment');
    expect(byId(om, 'P', 'osm_2')!.laneCount).toBe(4);
    expect(viewKey(om, 'base')).toBe(base0);
    expect(calls.post.filter(o => o.scenarioId === 'base').map(o => o.id)).toEqual([]);
  });

  it('deleting a base road in a proposal hides it there only (tombstone), baseline and device deletion list unchanged', () => {
    const { om, history, calls } = setup();
    const base0 = viewKey(om, 'base');
    activate(om, 'P');
    deleteWithHistory(om, history, 'osm_2');
    expect(byId(om, 'P', 'osm_2')).toBeUndefined();
    expect(viewKey(om, 'base')).toBe(base0);
    expect(calls.del).toEqual([]);
    expect([...((om as any).deletedOsm as Set<string>)]).toEqual([]);
  });

  it('Undo and Redo of proposal edits are exact and never touch the baseline', () => {
    const { om, history } = setup();
    const base0 = viewKey(om, 'base');
    activate(om, 'P');
    const p0 = viewKey(om, 'P');
    commitRoadFieldEdit(om, history, shown(om, 'osm_1'), 'speedLimit', 30, 'segment');
    const p1 = viewKey(om, 'P');
    deleteWithHistory(om, history, 'osm_3');
    const p2 = viewKey(om, 'P');
    history.undo(); expect(viewKey(om, 'P')).toBe(p1);
    history.undo(); expect(viewKey(om, 'P')).toBe(p0);
    history.redo(); expect(viewKey(om, 'P')).toBe(p1);
    history.redo(); expect(viewKey(om, 'P')).toBe(p2);
    expect(viewKey(om, 'base')).toBe(base0);
  });
});

describe('defect #2: a proposal cannot hold an override of a base road', () => {
  it('an override with the base id replaces the base road in the proposal only', () => {
    const { om } = setup();
    const base0 = viewKey(om, 'base');
    activate(om, 'P');
    // The proposal's version of osm_1, same id (what scenarioFilter's override rule expects)
    om.add({ ...shown(om, 'osm_1'), scenarioId: 'P', speedLimit: 20 } as RoadObject, true);
    expect(byId(om, 'P', 'osm_1')!.speedLimit).toBe(20);
    expect(view(om, 'P').filter(o => o.id === 'osm_1')).toHaveLength(1);
    expect(viewKey(om, 'base')).toBe(base0);
  });
});

describe('defect #3: lane-scope edits read roads of other proposals', () => {
  it('a carriageway lane edit in P does not reach a road that exists only in proposal Q', () => {
    const { om } = setup();
    // Q's own road continues the carriageway (exists only in Q)
    om.add(road('q_road', 300, 400, 0, { scenarioId: 'Q', name: 'Main Rd' }), true);
    activate(om, 'P');
    const roads = om.getAll().filter((o): o is RoadObject => o.type === 'road');
    const ids = laneEditPreview(roads, 'osm_2', 'lanesForward', 'carriageway').roadIds;
    expect(ids).not.toContain('q_road');
    expect(ids).toEqual(expect.arrayContaining(['osm_1', 'osm_2', 'osm_3']));
  });

  it('after one piece is overridden in P, a carriageway lane edit there still reaches the base pieces (and only in P)', () => {
    const { om, history } = setup();
    const base0 = viewKey(om, 'base');
    activate(om, 'P');
    commitRoadFieldEdit(om, history, shown(om, 'osm_1'), 'speedLimit', 30, 'segment');
    const { ids } = commitRoadFieldEdit(om, history, shown(om, 'osm_1'), 'lanesForward', 3, 'carriageway');
    expect(ids.sort()).toEqual(['osm_1', 'osm_2', 'osm_3']);
    expect(['osm_1', 'osm_2', 'osm_3'].map(id => byId(om, 'P', id)!.laneCount)).toEqual([3, 3, 3]);
    expect(viewKey(om, 'base')).toBe(base0);
  });
});

describe('three proposals from one baseline stay independent', () => {
  it('edits in A, B and C change only their own view', () => {
    const { om, history } = setup();
    const base0 = viewKey(om, 'base');
    activate(om, 'A');
    commitRoadFieldEdit(om, history, shown(om, 'osm_1'), 'speedLimit', 30, 'segment');
    const a1 = viewKey(om, 'A');
    activate(om, 'B');
    deleteWithHistory(om, history, 'osm_1');
    const b1 = viewKey(om, 'B');
    activate(om, 'C');
    commitRoadFieldEdit(om, history, shown(om, 'osm_1'), 'lanesForward', 3, 'segment');
    om.add(road('c_new', 300, 400, 50, { scenarioId: 'C' }), true);
    expect(viewKey(om, 'A')).toBe(a1);
    expect(viewKey(om, 'B')).toBe(b1);
    expect(viewKey(om, 'base')).toBe(base0);
    expect(byId(om, 'A', 'osm_1')!.speedLimit).toBe(30);
    expect(byId(om, 'B', 'osm_1')).toBeUndefined();
    expect(byId(om, 'C', 'osm_1')!.laneCount).toBe(3);
    expect(byId(om, 'A', 'c_new')).toBeUndefined();
  });
});

describe('changes survive a reload and a restore replaces a proposal only', () => {
  it('the changes sent to the backend rebuild the same proposal views in a fresh store; the baseline is unchanged', () => {
    const { om, history } = setup();
    const sent: { scenarioId: string; objectId: string; op: string; object?: any }[] = [];
    (om.syncChanges as any).mockImplementation(async (scenarioId: string, list: any[]) => { for (const c of list) sent.push({ scenarioId, ...c }); });
    activate(om, 'A'); deleteWithHistory(om, history, 'osm_2');
    activate(om, 'B'); commitRoadFieldEdit(om, history, shown(om, 'osm_2'), 'lanesForward', 4, 'segment');
    commitRoadFieldEdit(om, history, shown(om, 'osm_3'), 'speedLimit', 20, 'segment');
    history.undo(); // the speed edit is reverted: its change must be dropped, not kept
    const a = viewKey(om, 'A'), b = viewKey(om, 'B'), base = viewKey(om, 'base');
    // Server state: the last write per (scenario, object); 'revert' removes it
    const server = new Map<string, any>();
    for (const c of sent) { const k = `${c.scenarioId}|${c.objectId}`; if (c.op === 'revert') server.delete(k); else server.set(k, c); }
    const fresh = new ObjectManager();
    fresh.addMultiple(om.viewOf('base').map(o => structuredClone(o)), true);
    fresh.loadChanges([...server.values()].map(c => ({ scenarioId: c.scenarioId, objectId: c.objectId, op: c.op, object: c.object })));
    expect(viewKey(fresh, 'A')).toBe(a);
    expect(viewKey(fresh, 'B')).toBe(b);
    expect(viewKey(fresh, 'base')).toBe(base);
    expect([...server.keys()].sort()).toEqual(['A|osm_2', 'B|osm_2']);
  });

  it('replaceScenarioState (restore) changes that proposal only', () => {
    const { om, history } = setup();
    activate(om, 'A'); deleteWithHistory(om, history, 'osm_1');
    activate(om, 'B'); deleteWithHistory(om, history, 'osm_3');
    const a = viewKey(om, 'A'), base = viewKey(om, 'base');
    om.replaceScenarioState('B', [{ objectId: 'osm_1', op: 'delete' }]);
    expect(byId(om, 'B', 'osm_3')).toBeDefined();
    expect(byId(om, 'B', 'osm_1')).toBeUndefined();
    expect(viewKey(om, 'A')).toBe(a);
    expect(viewKey(om, 'base')).toBe(base);
  });
});

describe('fair comparison: every differing frozen input is listed', () => {
  it('checkRunInputs reports signal timing, signal source and corrections with both values', async () => {
    const { checkRunInputs } = await import('../simulation/ScenarioComparison');
    const a = { demandKey: 'k', trips: 10, plannedVph: 500, hour: 9, hourFactor: 1, seeds: [1, 2, 3], measureS: 900, warmupS: 300, signalTiming: 'webster', signalSource: 'mapped', networkCorrections: true };
    expect(checkRunInputs(a, { ...a }).matched).toBe(true);
    const c = checkRunInputs(a, { ...a, signalTiming: 'equal', signalSource: 'estimated', networkCorrections: false });
    expect(c.matched).toBe(false);
    expect(c.differences).toEqual([
      { input: 'signal timing', before: 'webster', after: 'equal' },
      { input: 'signal locations', before: 'mapped', after: 'estimated' },
      { input: 'network corrections', before: 'true', after: 'false' },
    ]);
    // Older snapshots without the new fields are not flagged for them
    const { warmupS: _w, signalTiming: _s, signalSource: _ss, networkCorrections: _n, ...old } = a;
    expect(checkRunInputs(old, a).matched).toBe(true);
  });
});

import { afterEach, describe, expect, it, vi } from 'vitest';
import fs from 'fs';
import path from 'path';
import { ObjectManager } from '../objects/ObjectManager';
import { HistoryManager, deleteWithHistory } from '../history/HistoryManager';
import { EditingEngine } from '../editing/EditingEngine';
import { SAME_LEVEL_SNAP_M } from '../editing/SnapManager';
import { commitRoadFieldEdit } from '../editing/roadEdits';
import type { CityObject, RoadObject } from '../objects/types';
import { canon, contentChanged, keyOf, loadNetwork, snap } from './editHarness';

/**
 * Root causes found by the whole-network edit checks (NetworkEditIsolation.test.ts, docs/OVERHAUL.md §27), each
 * pinned by a small case. Every test here failed before its fix.
 */

const LAT0 = 18.53;
const kx = 111320 * Math.cos(LAT0 * Math.PI / 180);
const pt = (x: number, y: number, z = 0): [number, number, number] => [73.85 + x / kx, LAT0 + y / 111320, z];
const road = (id: string, coords: [number, number, number][], extra: Partial<RoadObject> = {}): RoadObject => ({
  id, type: 'road', name: id, layerId: 'roads', scenarioId: 'base', coordinates: coords, roadClass: 'arterial', width: 7, laneCount: 2, laneWidth: 3.5,
  hasDivider: false, dividerWidth: 0, hasFootpath: false, footpathWidth: 0, speedLimit: 50, isOneWay: true, trafficCapacity: 2000, connectedJunctions: [],
  createdAt: '2026-11-09T00:00:00.000Z', updatedAt: '2026-11-09T00:00:00.000Z', ...extra,
} as RoadObject);

function setup(objs: CityObject[]) {
  vi.spyOn(EditingEngine.prototype, 'fetchSavedAreas').mockResolvedValue();
  const om = new ObjectManager();
  for (const k of ['syncPost', 'syncPostMultiple', 'syncDelete', 'syncDeleteMultiple'] as const) vi.spyOn(om, k).mockResolvedValue();
  (om as any).deletedOsm = new Set<string>();
  om.addMultiple(objs, true);
  const history = new HistoryManager(om);
  const editing = new EditingEngine(om, history, undefined, {} as any);
  return { om, history, editing };
}
afterEach(() => vi.restoreAllMocks());

describe('drawing a road changes only the road its end lies on', () => {
  it('a dual road: the end joins carriageway A; carriageway B 10 m away and a flyover deck overhead keep their points', () => {
    const A = road('cwA', [pt(0, 0), pt(300, 0)]);
    const B = road('cwB', [pt(300, 10), pt(0, 10)]);
    // An elevated road drawn by hand at deck height (not densified, so no deck point is near enough to snap to)
    const deck = road('deck', [pt(140, -60, 6.5), pt(140, 60, 6.5)], { isOneWay: false });
    const { om, editing } = setup([A, B, deck]);
    const s0 = snap(om);
    editing.setMode('draw_road');
    editing.addDrawingPoint(pt(128, -120));
    editing.addDrawingPoint(pt(128, 0.4)); // the end lies on A (0.4 m off), 9.6 m from B; the deck passes 12 m away at 6.5 m
    editing.finalizeDrawing('base');
    const changed = contentChanged(s0, snap(om));
    const drawn = changed.filter(id => !s0.has(id));
    expect(drawn).toHaveLength(1);
    // Before the fix: cwB and deck got a vertex at the end point too (deck pulled down to the ground there)
    expect(changed.filter(id => s0.has(id))).toEqual(['cwA']);
    expect((om.getById('deck') as RoadObject).coordinates.every(p => p[2] === 6.5)).toBe(true);
  });
});

describe('a drawn flyover\'s effect on the surface roads is one Undo step', () => {
  const surface = () => [road('under', [pt(0, 0), pt(400, 0)], { isOneWay: false, laneCount: 4, trafficCapacity: 4000 })];
  const drawFlyover = (editing: EditingEngine) => {
    editing.setMode('draw_flyover');
    editing.addDrawingPoint(pt(0, 3));
    editing.addDrawingPoint(pt(400, 3));
    editing.finalizeDrawing('base');
    editing.setMode('select');
  };
  it('undo gives the road below back unchanged, redo gives back the drawn state exactly, delete gives the capacity back', () => {
    const { om, history, editing } = setup(surface());
    const s0 = snap(om), k0 = keyOf(om);
    drawFlyover(editing);
    const s1 = snap(om), k1 = keyOf(om);
    const under = om.getById('under') as RoadObject;
    expect(under.flyoverImpact).toBeTruthy();
    expect(under.trafficCapacity).toBe(3000);
    history.undo();
    // Before the fix: the road kept flyoverImpact and its reduced capacity
    expect(contentChanged(s0, snap(om))).toEqual([]);
    expect(keyOf(om)).toBe(k0);
    history.redo();
    // Before the fix: the flyover came back without its feasibilityResult
    expect(contentChanged(s1, snap(om))).toEqual([]);
    expect(keyOf(om)).toBe(k1);
    const fly = [...s1.values()].find(o => o.type === 'flyover')!;
    deleteWithHistory(om, history, fly.id);
    expect((om.getById('under') as RoadObject).flyoverImpact).toBeUndefined();
    expect((om.getById('under') as RoadObject).trafficCapacity).toBe(4000);
    history.undo();
    expect(contentChanged(s1, snap(om))).toEqual([]);
  });
  it('the reduced capacity survives a later edit of the road and a reload', () => {
    const { om, history, editing } = setup(surface());
    drawFlyover(editing);
    const under = om.getById('under') as RoadObject;
    commitRoadFieldEdit(om, history, { ...under }, 'lanesForward', 3, 'segment');
    expect((om.getById('under') as RoadObject).trafficCapacity).toBe(Math.round(5 * 1000 * 0.75));
    const reloaded = new ObjectManager();
    reloaded.addMultiple([structuredClone(om.getById('under')!)], true);
    expect((reloaded.getById('under') as RoadObject).trafficCapacity).toBe(Math.round(5 * 1000 * 0.75));
  });
});

describe('a properties edit of one field changes only that field', () => {
  it('speed limit and class of a one-way road leave its cross-section and width alone', () => {
    const r = road('ow', [pt(0, 0), pt(100, 0)], { hasFootpath: true, footpathWidth: 1.5 });
    const { om, history } = setup([r]);
    const before = structuredClone(om.getById('ow')!) as RoadObject;
    commitRoadFieldEdit(om, history, { ...(om.getById('ow') as RoadObject) }, 'speedLimit', 30);
    commitRoadFieldEdit(om, history, { ...(om.getById('ow') as RoadObject) }, 'roadClass', 'collector');
    const after = om.getById('ow') as RoadObject;
    // Before the fix: a footpath appeared on the right of the one-way road (width 8.5 -> 10 m)
    expect(canon(after.sections)).toBe(canon(before.sections));
    expect(after.width).toBe(before.width);
    expect([after.speedLimit, after.roadClass]).toEqual([30, 'collector']);
  });
});

describe('Undo puts back the whole object', () => {
  it('a field the edit added goes again on Undo', () => {
    const { om, history } = setup([road('r', [pt(0, 0), pt(100, 0)])]);
    const s0 = snap(om), k0 = keyOf(om);
    const before = om.getById('r')!;
    const after = { ...before, flyoverImpact: { flyoverId: 'f', flyoverName: 'f', capacityReductionPercent: 25, originalCapacity: 2000, reason: 'x' } } as CityObject;
    history.recordUpdate(before, after, 'impact');
    om.update('r', after);
    history.undo();
    // Before the fix: the update was merged into the current object, so flyoverImpact stayed
    expect((om.getById('r') as RoadObject).flyoverImpact).toBeUndefined();
    expect(contentChanged(s0, snap(om))).toEqual([]);
    expect(keyOf(om)).toBe(k0);
  });
});

describe('a road raised as an approach and lowered again has its own points back', () => {
  it('deleting the slip road next to Sangamwadi Bridge and undoing it leaves every road as it was (real OSM roads)', () => {
    const fx = JSON.parse(fs.readFileSync(path.join(__dirname, 'fixtures/sangamwadi.json'), 'utf8')) as { roads: any[] };
    const rows = fx.roads.filter(r => r.type === 'road').map(({ id, type, name, layerId, scenarioId, coordinates, ...properties }) => ({ id, type, name, layerId, scenarioId, coordinates, properties }));
    const { om, history } = loadNetwork(rows as any);
    const s0 = snap(om), k0 = keyOf(om);
    const n0 = (om.getById('osm_1118894175') as RoadObject).coordinates.length;
    deleteWithHistory(om, history, 'osm_208099367');
    // Its neighbour becomes an approach of the bridge (as a fresh load without the slip road gives it)
    expect((om.getById('osm_1118894175') as RoadObject).coordinates.length).toBeGreaterThan(n0);
    history.undo();
    // Before the fix: osm_1118894175 came back flat with 109 points instead of its 40
    expect((om.getById('osm_1118894175') as RoadObject).coordinates.length).toBe(n0);
    expect(contentChanged(s0, snap(om))).toEqual([]);
    expect(keyOf(om)).toBe(k0);
  });
});

describe('a drawn road snaps only to points at its own level', () => {
  it('a ground click 10 m from a flyover deck vertex does not join the deck in mid-air; the foot of the ramp and a ground road still snap; a flyover drawing still snaps to the deck', () => {
    // A deck at 6.5 m from (100, 0), its approach ramp coming down to the ground at (0, 0); a ground road ending at (100, -40)
    // (drawn by hand with these heights: imported bridges get their heights from §21's elevation pass)
    const deck = road('deck', [pt(100, 0, 6.5), pt(200, 0, 6.5)]);
    const ramp = road('ramp', [pt(0, 0, 0), pt(50, 0, 3.2), pt(100, 0, 6.5)]);
    const ground = road('ground', [pt(100, -200), pt(100, -40)]);
    const { om, editing } = setup([deck, ramp, ground]);
    expect(om.getById('deck')!.coordinates[0][2]).toBe(6.5);
    expect((om.getById('ramp') as RoadObject).coordinates[0][2]).toBe(0);
    editing.setMode('draw_road');
    // 10 m from the deck vertex (inside the ~16 m vertex snap radius), on the ground
    const nearDeck = editing.findSnap(pt(100, 10));
    expect(['deck', 'ramp']).not.toContain(nearDeck.targetObjId);
    expect(nearDeck.point[2]).toBe(0);
    // 8 m from the ramp's foot (at 0 m) snaps to it
    const foot = editing.findSnap(pt(0, 8));
    expect(foot.targetObjId).toBe('ramp');
    expect(foot.point).toEqual(pt(0, 0, 0));
    // A ground road's end 6 m away still snaps
    const g = editing.findSnap(pt(104, -36));
    expect(g.targetObjId).toBe('ground');
    // Drawing a road through it: no point of the new road lies at deck height
    editing.addDrawingPoint(pt(100, 10));
    expect(editing.getDrawingPoints()[0][2]).toBe(0);
    editing.clearDrawing();
    // A flyover is drawn to meet decks: it keeps the any-level snap
    editing.setMode('draw_flyover');
    expect(['deck', 'ramp']).toContain(editing.findSnap(pt(100, 10)).targetObjId);
    expect(editing.findSnap(pt(100, 10)).point[2]).toBeGreaterThan(SAME_LEVEL_SNAP_M);
  });
});

describe('a road end carried exactly onto another road joins that road in the traffic network', () => {
  it('Road ends: Connect onto a vertex: the end joins that vertex, not an older node of a third road 4.5 m away', async () => {
    const { TrafficNetworkBuilder } = await import('../simulation/TrafficNetworkBuilder');
    const osm = { osmProvenance: { osmId: 1 } as any };
    // X: an OSM way ending 4.5 m from T's first point (they do not meet in OSM); T: the OSM way connected to;
    // R: the way whose end was carried onto T's first point (an edited way joins by geometry, as a drawn road)
    const X = road('X', [pt(-60, 40), pt(0, 4.5)], osm);
    const T = road('T', [pt(0, 0), pt(100, 0)], osm);
    const R = road('R', [pt(-80, -10), pt(0, 0)]);
    const { network } = new TrafficNetworkBuilder().build([X, T, R]);
    const nodesOf = (id: string) => new Set([...network.edges.values()].filter(e => e.roadId === id).flatMap(e => [e.fromNodeId, e.toNodeId]));
    const shared = (a: string, b: string) => [...nodesOf(a)].some(n => nodesOf(b).has(n));
    expect(shared('R', 'T')).toBe(true);
    expect(shared('R', 'X')).toBe(false);
  });
});

import { afterEach, describe, expect, it, vi } from 'vitest';
import { EditingEngine } from '../editing/EditingEngine';
import { loadNetwork, canon, type DbRow } from './editHarness';
import { TrafficNetworkBuilder } from '../simulation/TrafficNetworkBuilder';
import type { CityObject, RoadObject } from '../objects/types';

/**
 * Topology reconstruction inside a proposal (docs/TOPOLOGY_RECONSTRUCTION.md §4, docs/SCENARIOS_AND_VERSIONING.md):
 * a road drawn in a proposal that crosses or ends on baseline roads must not write vertices into the baseline rows;
 * the base road gets a proposal override (copy on write) instead. SYNTHETIC roads at 18.5°N, 73.85°E.
 */
const LAT = 18.5, LNG = 73.85, dLat = (m: number) => m / 111320, dLng = (m: number) => m / (111320 * Math.cos(LAT * Math.PI / 180));
const row = (id: string, pts: [number, number][], z: number, tags: Record<string, string> = {}): DbRow => ({
  id, type: 'road', name: id, layerId: 'roads', scenarioId: 'base',
  coordinates: pts.map(([x, y]) => [LNG + dLng(x), LAT + dLat(y), z]),
  properties: {
    roadClass: 'local', width: 10, laneCount: 2, laneWidth: 3.5, hasDivider: false, dividerWidth: 0, hasFootpath: false, footpathWidth: 0,
    speedLimit: 40, isOneWay: false, trafficCapacity: 1000, connectedJunctions: [],
    osmProvenance: { osmId: Number(id.replace(/\D/g, '')) || 1, originalTags: { highway: 'residential', ...tags }, layer: Number(tags.layer ?? 0), bridge: !!tags.bridge, tunnel: !!tags.tunnel, roundabout: false },
  },
});

function setup() {
  vi.spyOn(EditingEngine.prototype, 'fetchSavedAreas').mockResolvedValue();
  // osm_1 ground road (crossed mid-way), osm_2 ground road (an end drawn onto it), osm_3 layer=1 at ground height (uncertain)
  const { om, history } = loadNetwork([
    row('osm_1', [[-100, 0], [100, 0]], 0),
    row('osm_2', [[-100, 80], [100, 80]], 0),
    row('osm_3', [[60, -100], [60, 100]], 0, { layer: '1' }),
  ], true); // frozen: any in-place write into a base object throws
  const changes: { scenarioId: string; objectId: string; op: string }[] = [];
  const posts: CityObject[] = [];
  vi.spyOn(om, 'syncChanges').mockImplementation(async (scenarioId, list) => { for (const c of list) changes.push({ scenarioId, objectId: c.objectId, op: c.op }); });
  vi.spyOn(om, 'syncPost').mockImplementation(async o => { posts.push(o); });
  vi.spyOn(om, 'syncPostMultiple').mockImplementation(async os => { posts.push(...os); });
  const ed = new EditingEngine(om, history, undefined, {} as any);
  const baseKey = () => canon(om.viewOf('base').map(o => ({ ...o, updatedAt: undefined })).sort((a, b) => a.id.localeCompare(b.id)));
  const draw = (pts: [number, number][], scen: string) => {
    ed.setMode('draw_road');
    for (const [x, y] of pts) ed.addDrawingPoint([LNG + dLng(x), LAT + dLat(y), 0]);
    const before = new Set(om.getAll().map(o => o.id));
    ed.finalizeDrawing(scen);
    ed.setMode('select');
    return om.getAll().find(o => !before.has(o.id)) as RoadObject;
  };
  return { om, history, ed, changes, posts, baseKey, draw };
}

describe('topology reconstruction in a proposal (synthetic roads)', () => {
  afterEach(() => vi.restoreAllMocks());

  it('a crossing and an end on base roads become proposal overrides; the baseline rows are untouched; undo/redo exact', () => {
    const t = setup();
    const base0 = t.baseKey();
    t.om.setActiveScenario('P');
    // Crosses osm_1 at x=0 (junction), ends on osm_2 mid-way (T-junction)
    const nr = t.draw([[-20, -60], [-20, 80]], 'P');
    expect(nr.scenarioId).toBe('P');
    // Baseline unchanged, in memory and on the wire (no base row posted)
    expect(t.baseKey()).toBe(base0);
    expect((t.om.viewOf('base').find(o => o.id === 'osm_1') as RoadObject).coordinates).toHaveLength(2);
    expect((t.om.viewOf('base').find(o => o.id === 'osm_2') as RoadObject).coordinates).toHaveLength(2);
    expect(t.posts.filter(o => o.scenarioId === 'base' || o.id.startsWith('osm_'))).toEqual([]);
    // The proposal has its own versions of both base roads, with the junction vertex
    const ov = t.om.overlayOf('P');
    expect((ov.get('osm_1') as RoadObject).coordinates).toHaveLength(3);
    expect((ov.get('osm_2') as RoadObject).coordinates).toHaveLength(3);
    expect(t.changes.filter(c => c.op === 'modify').map(c => c.objectId).sort()).toEqual(['osm_1', 'osm_2']);
    // In the proposal's network the drawn road shares a node with both
    const net = new TrafficNetworkBuilder().build(t.om.viewOf('P').filter(o => o.type === 'road') as RoadObject[]).network;
    const nodes = (id: string) => new Set([...net.edges.values()].filter(e => e.roadId === id).flatMap(e => [e.fromNodeId, e.toNodeId]));
    for (const id of ['osm_1', 'osm_2']) expect([...nodes(nr.id)].filter(n => nodes(id).has(n)).length).toBeGreaterThan(0);
    // Undo: overlay gone (reverted), baseline still untouched; redo: overrides back
    const p1 = canon(t.om.viewOf('P').map(o => ({ ...o, updatedAt: undefined })).sort((a, b) => a.id.localeCompare(b.id)));
    t.history.undo();
    expect(t.om.overlayOf('P').size).toBe(0);
    expect(t.om.viewOf('P').some(o => o.id === nr.id)).toBe(false);
    expect(t.baseKey()).toBe(base0);
    t.history.redo();
    expect(canon(t.om.viewOf('P').map(o => ({ ...o, updatedAt: undefined })).sort((a, b) => a.id.localeCompare(b.id)))).toBe(p1);
    expect(t.baseKey()).toBe(base0);
    // The baseline view shows no trace of the drawn road
    expect(t.om.viewOf('base').some(o => o.id === nr.id)).toBe(false);
  });

  it('Confirm junction on an uncertain crossing in a proposal overrides the base road, not the baseline row', () => {
    const t = setup();
    const base0 = t.baseKey();
    t.om.setActiveScenario('P');
    const nr = t.draw([[0, -60], [120, -60]], 'P'); // crosses osm_3 (layer=1, 0 m) at x=60
    expect(nr.levelCrossings?.map(f => [f.roadId, f.decision])).toEqual([['osm_3', 'unconfirmed']]);
    expect(t.om.overlayOf('P').has('osm_3')).toBe(false);
    t.ed.resolveLevelCrossing(nr.id, 0, 'junction');
    expect((t.om.overlayOf('P').get('osm_3') as RoadObject).coordinates).toHaveLength(3);
    expect(t.baseKey()).toBe(base0);
    expect(t.posts.filter(o => o.id.startsWith('osm_'))).toEqual([]);
    t.history.undo();
    expect(t.om.overlayOf('P').has('osm_3')).toBe(false);
    expect(t.baseKey()).toBe(base0);
  });
});

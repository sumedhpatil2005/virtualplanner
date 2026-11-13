import { afterEach, describe, expect, it, vi } from 'vitest';
import { ObjectManager } from '../objects/ObjectManager';
import { HistoryManager, deleteWithHistory } from '../history/HistoryManager';
import { filterObjectsForScenario } from '../scenarios/scenarioFilter';
import type { CityObject, RoadObject, UndergroundAlignmentObject, UtilityObject } from '../objects/types';
import { alignmentElementPayload, alignmentProfile, crossSectionAt, crownDepthAt, findCrossings } from '../underground/alignmentGeometry';
import { buildAlignment, withAllDepths, withSection, withVertexDepth } from '../underground/alignmentFactory';
import { layoutProfile, layoutSection, scale } from '../underground/sectionLayout';
import { depthRuns } from '../underground/UndergroundRenderer';
import { UndergroundView, type ViewerLike } from '../underground/UndergroundView';
import { alignmentsRect } from '../underground/viewRect';
import { canon } from './editHarness';

/**
 * Underground workspace (docs/urbanos/UNDERGROUND_WORKSPACE.md): profile / cross-section geometry, UNKNOWN handling,
 * coordination payload, object persistence (Undo, copy-on-write isolation) and the globe view state round trip.
 * All geometry is SYNTHETIC (metres east/north of a point in Pune).
 */
const LAT0 = 18.53;
const kx = 111320 * Math.cos(LAT0 * Math.PI / 180), ky = 110574;
const pt = (x: number, y: number): [number, number, number] => [73.85 + x / kx, LAT0 + y / ky, 0];

const tunnel = (extra: Partial<UndergroundAlignmentObject> = {}): UndergroundAlignmentObject => ({
  ...buildAlignment({
    id: 'ug1', scenarioId: 'P', points: [pt(0, 0), pt(100, 0), pt(200, 0)], kind: 'bored_tunnel', crownDepthM: 10, depthCertainty: 'hypothetical',
    section: { shape: 'circular', diameterM: 6 }, sectionCertainty: 'hypothetical', createdAt: 'synthetic',
  }),
  ...extra,
});
const road = (id: string, x: number, scenarioId = 'base'): RoadObject => ({
  id, type: 'road', name: id, layerId: 'roads', scenarioId, coordinates: [pt(x, -50), pt(x, 50)], roadClass: 'arterial', width: 12, laneCount: 2, laneWidth: 3.5,
  hasDivider: false, dividerWidth: 0, hasFootpath: false, footpathWidth: 0, speedLimit: 50, isOneWay: false, trafficCapacity: 2000, connectedJunctions: [],
  createdAt: 'synthetic', updatedAt: 'synthetic',
} as RoadObject);
const utility = (id: string, x: number, depth: number, diameterMm: number | null): UtilityObject => ({
  id, type: 'utility', name: id, layerId: 'water_util', scenarioId: 'base', coordinates: [pt(x, -50), pt(x, 50)], utilityType: 'water', depth,
  depthCertainty: 'estimated', diameterMm, capacity: 100, createdAt: 'synthetic', updatedAt: 'synthetic',
} as UtilityObject);

describe('alignment geometry: long-section', () => {
  it('chainage, crown/invert and gradient; length ≈ 200 m', () => {
    const a = withVertexDepth(tunnel(), 2, { crownDepthM: 14 });
    const p = alignmentProfile(a);
    expect(p.lengthM).toBeCloseTo(200, 0);
    expect(p.vertices.map(v => Math.round(v.chainageM))).toEqual([0, 100, 200]);
    expect(p.vertices[0].invertDepthM).toBe(16);
    expect(p.gradientsPct[0]).toBeCloseTo(0, 6);
    expect(p.gradientsPct[1]).toBeCloseTo(4, 1); // 4 m deeper over 100 m
    expect(p.maxKnownDepthM).toBe(20);
    expect(crownDepthAt(a, 150).depthM).toBeCloseTo(12, 1);
  });

  it('an UNKNOWN vertex depth stays null, is never 0 and is never interpolated across', () => {
    const a = withVertexDepth(tunnel(), 1, { crownDepthM: null });
    const p = alignmentProfile(a);
    expect(p.vertices[1].crownDepthM).toBeNull();
    expect(p.vertices[1].certainty).toBe('unknown');
    expect(p.unknownDepthCount).toBe(1);
    expect(p.gradientsPct).toEqual([null, null]);
    expect(crownDepthAt(a, 50).depthM).toBeNull();
    expect(crownDepthAt(a, 150).depthM).toBeNull();
    const runs = depthRuns(a);
    expect(runs.known).toEqual([]); // no two consecutive known vertices → nothing placed below ground
    expect(runs.unknown).toEqual([[0, 1, 2]]);
    const L = layoutProfile(a, [], { width: 800, height: 180 });
    expect(L.unknownVertices).toHaveLength(1);
    expect(L.crownRuns).toHaveLength(0);
  });

  it('a blank section size is UNKNOWN (null), so the invert and the element z_min are UNKNOWN', () => {
    const a = withSection(tunnel(), { shape: 'circular', diameterM: 0 });
    expect(a.section).toEqual({ shape: 'circular', diameterM: null });
    const p = alignmentProfile(a);
    expect(p.vertices.every(v => v.invertDepthM === null)).toBe(true);
    const e = alignmentElementPayload(a);
    expect(e.z_min_m).toBeNull();
    expect(e.width_m).toBeNull();
    expect(e.z_max_m).toBe(-10);
  });

  it('crossings with model objects carry their (UNKNOWN) vertical extent from the model', () => {
    const others: CityObject[] = [road('r1', 50), utility('u1', 150, 2, 300), road('far', 5000)];
    const xs = findCrossings(tunnel(), others);
    expect(xs.map(x => x.objectId)).toEqual(['r1', 'u1']);
    expect(xs[0].chainageM).toBeCloseTo(50, 0);
    expect(xs[0].extent.topDepthM).toBe(0);
    expect(xs[0].extent.bottomDepthM).toBeNull(); // road structure depth not in the model
    expect(xs[0].extent.certainty).toBe('unknown');
    expect(xs[1].extent.topDepthM).toBe(2);
    expect(xs[1].extent.bottomDepthM).toBeCloseTo(2.3, 6);
    expect(xs[1].extent.certainty).toBe('estimated');
    const L = layoutProfile(tunnel(), others, { width: 800, height: 180 });
    expect(L.crossings).toHaveLength(2);
    expect(scale(L.y, 0)).toBeGreaterThan(L.box.top); // ground line inside the plot, with headroom above
    expect(L.depthRange[1]).toBeGreaterThanOrEqual(16);
    expect(L.bands).toHaveLength(1);
  });
});

describe('alignment geometry: cross-section', () => {
  it('perpendicular cut at a chainage finds objects at their signed offset', () => {
    const others: CityObject[] = [{ ...road('par', 0), coordinates: [pt(-50, 20), pt(300, 20)] } as RoadObject, { ...road('par2', 0), coordinates: [pt(-50, -15), pt(300, -15)] } as RoadObject];
    const s = crossSectionAt(tunnel(), 100, 30, others);
    expect(s.chainageM).toBeCloseTo(100, 6);
    expect(s.own.crownDepthM).toBe(10);
    expect(s.own.widthM).toBe(6);
    expect(s.items.map(i => [i.objectId, Math.round(i.offsetM)])).toEqual([['par', -20], ['par2', 15]]); // north = left of an eastbound alignment
    expect(crossSectionAt(tunnel(), 100, 10, others).items).toEqual([]);
    const L = layoutSection(tunnel(), 100, 30, others, { width: 800, height: 180 });
    expect(L.own && L.own.shape).toBe('circular');
  });
  it('own structure is UNKNOWN in the section when the depth there is unknown', () => {
    const a = withVertexDepth(tunnel(), 1, { crownDepthM: null });
    const L = layoutSection(a, 50, 30, [], { width: 800, height: 180 });
    expect(L.section.own.crownDepthM).toBeNull();
    expect(L.own).toBeNull();
  });
});

describe('coordination element payload', () => {
  it('z relative to ground, up positive; per-vertex profile; certainty = worst; provenance names the object', () => {
    const a = withVertexDepth(withVertexDepth(tunnel(), 0, { certainty: 'measured' }), 2, { crownDepthM: 12, certainty: 'estimated' });
    const e = alignmentElementPayload(a);
    expect(e.kind).toBe('tunnel');
    expect(e.z_ref).toBe('ground');
    expect(e.profile.map(q => [q.z_max_m, q.z_min_m])).toEqual([[-10, -16], [-10, -16], [-12, -18]]);
    expect(e.z_max_m).toBe(-10);
    expect(e.z_min_m).toBe(-18);
    expect(e.width_m).toBe(6);
    expect(e.certainty).toBe('hypothetical');
    expect(e.provenance).toContain('alignment ug1 ');
    expect(e.geometry.coordinates).toHaveLength(3);
    const unk = alignmentElementPayload(withVertexDepth(a, 1, { crownDepthM: null }));
    expect(unk.z_max_m).toBeNull();
    expect(unk.certainty).toBe('unknown');
  });
});

// ---- persistence / isolation -------------------------------------------------------------------------------------
function setup() {
  const om = new ObjectManager();
  const posted: CityObject[] = [];
  vi.spyOn(om, 'syncPost').mockImplementation(async o => { posted.push(o); });
  vi.spyOn(om, 'syncPostMultiple').mockImplementation(async os => { posted.push(...os); });
  vi.spyOn(om, 'syncDelete').mockImplementation(async () => {});
  vi.spyOn(om, 'syncDeleteMultiple').mockImplementation(async () => {});
  vi.spyOn(om as any, 'syncChanges').mockImplementation(async () => {});
  (om as any).deletedOsm = new Set<string>();
  om.addMultiple([road('osm_1', 50)], true);
  const history = new HistoryManager(om);
  return { om, history, posted };
}
const view = (om: ObjectManager, id: string): CityObject[] => (om as any).viewOf ? (om as any).viewOf(id) : filterObjectsForScenario(om.getAll(), id);
const key = (om: ObjectManager, id: string) => canon([...view(om, id)].sort((a, b) => a.id.localeCompare(b.id)).map(o => ({ ...o, updatedAt: undefined, createdAt: undefined })));
const edit = (om: ObjectManager, h: HistoryManager, before: UndergroundAlignmentObject, after: UndergroundAlignmentObject) => {
  h.recordUpdate(before, after, 'edit');
  const { id: _i, type: _t, ...rest } = after; void _i; void _t;
  om.update(before.id, rest as Partial<CityObject>);
};
afterEach(() => vi.restoreAllMocks());

describe('underground alignment as a scenario object', () => {
  it('drawn in a proposal it exists only there; depth edits undo/redo; baseline and other proposals unchanged', () => {
    const { om, history } = setup();
    const base0 = key(om, 'base');
    (om as any).setActiveScenario?.('Q');
    const q0 = key(om, 'Q');
    (om as any).setActiveScenario?.('P');
    const a = tunnel();
    history.recordAdd?.(a, 'add');
    om.add(a);
    const added = key(om, 'P');
    expect(view(om, 'P').some(o => o.id === 'ug1')).toBe(true);
    edit(om, history, om.getById('ug1') as UndergroundAlignmentObject, withVertexDepth(om.getById('ug1') as UndergroundAlignmentObject, 1, { crownDepthM: 22, certainty: 'estimated' }));
    const got = om.getById('ug1') as UndergroundAlignmentObject;
    expect(got.depths[1]).toEqual({ crownDepthM: 22, certainty: 'estimated' });
    expect(key(om, 'base')).toBe(base0);
    expect(key(om, 'Q')).toBe(q0);
    expect(view(om, 'base').some(o => o.id === 'ug1')).toBe(false);
    history.undo();
    expect((om.getById('ug1') as UndergroundAlignmentObject).depths[1].crownDepthM).toBe(10);
    expect(key(om, 'P')).toBe(added);
    history.redo();
    expect((om.getById('ug1') as UndergroundAlignmentObject).depths[1].crownDepthM).toBe(22);
    deleteWithHistory(om, history, 'ug1');
    expect(view(om, 'P').some(o => o.id === 'ug1')).toBe(false);
    history.undo();
    expect((om.getById('ug1') as UndergroundAlignmentObject).depths[1].crownDepthM).toBe(22);
    expect(key(om, 'base')).toBe(base0);
  });

  it('editing a baseline alignment in a proposal is copy-on-write: the baseline keeps its depths', () => {
    const { om, history } = setup();
    om.addMultiple([tunnel({ scenarioId: 'base' })], true);
    const base0 = key(om, 'base');
    (om as any).setActiveScenario?.('P');
    const before = om.getById('ug1') as UndergroundAlignmentObject;
    edit(om, history, before, withAllDepths(before, 30, 'hypothetical'));
    expect((om.getById('ug1') as UndergroundAlignmentObject).depths.map(d => d.crownDepthM)).toEqual([30, 30, 30]);
    expect(key(om, 'base')).toBe(base0);
    expect((view(om, 'base').find(o => o.id === 'ug1') as UndergroundAlignmentObject).depths.map(d => d.crownDepthM)).toEqual([10, 10, 10]);
  });

  it('the object survives the backend schema round trip (properties carry depths and section)', () => {
    const om = new ObjectManager();
    const row = (om as any).mapToSchema(tunnel()) as { type: string; properties: Record<string, unknown> };
    expect(row.type).toBe('underground_alignment');
    expect(row.properties.depths).toEqual(tunnel().depths);
    expect(row.properties.section).toEqual({ shape: 'circular', diameterM: 6 });
  });
});

// ---- globe view state ----------------------------------------------------------------------------------------------
describe('underground view (globe translucency) enter / leave', () => {
  const fakeViewer = (): ViewerLike => ({
    scene: {
      globe: { translucency: { enabled: false, frontFaceAlpha: 1, backFaceAlpha: 1, rectangle: 'R0' }, undergroundColor: 'BLACK', depthTestAgainstTerrain: true },
      screenSpaceCameraController: { enableCollisionDetection: true },
    },
  });
  it('applies opacity / X-ray / collision off, and restores the previous state exactly', () => {
    const v = fakeViewer();
    const before = JSON.stringify(v);
    const uv = new UndergroundView({ rectangle: d => (d ? `RECT ${d.join(',')}` : 'MAX'), tint: () => 'SLATE' });
    uv.enter(v);
    const g = v.scene.globe;
    expect(g.translucency.enabled).toBe(true);
    expect(g.translucency.frontFaceAlpha).toBeCloseTo(0.35);
    expect(v.scene.screenSpaceCameraController.enableCollisionDetection).toBe(false);
    expect(g.undergroundColor).toBe('SLATE');
    expect(g.translucency.rectangle).toBe('MAX');
    uv.update({ rectangleDeg: [1, 2, 3, 4] });
    expect(g.translucency.rectangle).toBe('RECT 1,2,3,4');
    uv.update({ groundOpacity: 1 });
    expect(g.translucency.enabled).toBe(false);
    expect(g.depthTestAgainstTerrain).toBe(true);
    uv.update({ xray: true });
    expect(g.translucency.enabled).toBe(true);
    expect(g.translucency.frontFaceAlpha).toBe(0.5);
    expect(g.depthTestAgainstTerrain).toBe(false);
    uv.update({ groundOpacity: -3 });
    expect(uv.getSettings().groundOpacity).toBe(0);
    uv.leave();
    expect(JSON.stringify(v)).toBe(before);
    expect(uv.isActive()).toBe(false);
  });
  it('limits translucency to a rectangle around the alignments', () => {
    const r = alignmentsRect([tunnel()], 100)!;
    expect(r[0]).toBeLessThan(73.85);
    expect(r[2]).toBeGreaterThan(73.85 + 200 / kx);
    expect(alignmentsRect([])).toBeNull();
  });
});

import { afterEach, describe, expect, it, vi } from 'vitest';
import fs from 'fs';
import path from 'path';
import { EditingEngine } from '../editing/EditingEngine';
import { ObjectManager } from '../objects/ObjectManager';
import { HistoryManager } from '../history/HistoryManager';
import { LocalOsmIndex } from '../editing/LocalOsmIndex';
import { areaFromBoundary } from '../editing/studyAreaImport';
import { TrafficNetworkBuilder } from '../simulation/TrafficNetworkBuilder';
import { networkContentKey } from '../simulation/StudyDemand';
import type { RoadObject } from '../objects/types';

/**
 * Imported roads join where OpenStreetMap joins them, however they were imported (docs/OVERHAUL.md §19, §21),
 * on the real ways round COEP Road and Sangamwadi Bridge as the local extract serves them
 * (fixtures/coep_osm_ways.json): the Mokshagundam Vishweshvarayya Flyover chain beside COEP Road (any one
 * piece missing or unjoined sent the area's through traffic onto the one-lane campus road at 887-970% of
 * its capacity, §17), Sangamwadi Bridge, nine underpass ways (layer -1, tunnel) and 42 bridge ways.
 */
const fx = JSON.parse(fs.readFileSync(path.join(__dirname, 'fixtures/coep_osm_ways.json'), 'utf8')) as { elements: any[] };
const BOX = { minLng: 73.846, minLat: 18.522, maxLng: 73.866, maxLat: 18.538 };
const P = (x: number, y: number): [number, number, number] => [x, y, 0];
const WHOLE = areaFromBoundary('area_whole', 'whole', [P(BOX.minLng, BOX.minLat), P(BOX.maxLng, BOX.minLat), P(BOX.maxLng, BOX.maxLat), P(BOX.minLng, BOX.maxLat)]);
// A drawn area whose east edge (73.8562 E, south of 18.531 N) cuts the flyover 661187172 and COEP Road
const CUT = areaFromBoundary('area_cut', 'cut', [P(73.846, 18.523), P(73.8562, 18.523), P(73.8562, 18.531), P(73.866, 18.531), P(73.866, 18.537), P(73.846, 18.537)]);
const CHAIN = [22841398, 661187172, 317550167, 327073027, 815335438, 208099367];
/** Consecutive pieces of the chain beside COEP Road that meet at an OSM node, west-bound and east-bound. */
const CHAIN_JOINS: [number, number][] = [[22841398, 661187172], [661187172, 317550167], [327073027, 815335438], [208099367, 327073027]];

const inBoxes = (boxes: readonly typeof BOX[]) => fx.elements.filter(e => e.geometry.some((p: any) => boxes.some(b => p.lon >= b.minLng && p.lon <= b.maxLng && p.lat >= b.minLat && p.lat <= b.maxLat)));

function setup() {
  vi.spyOn(EditingEngine.prototype, 'fetchSavedAreas').mockResolvedValue();
  const om = new ObjectManager();
  const local = new LocalOsmIndex();
  vi.spyOn(local, 'supports').mockResolvedValue(true);
  vi.spyOn(local, 'covers').mockResolvedValue(true);
  vi.spyOn(local, 'ways').mockImplementation(async (boxes: any) => structuredClone(inBoxes(boxes)));
  const history = new HistoryManager(om);
  const editing = new EditingEngine(om, history, undefined, local);
  vi.spyOn(om, 'addMultipleAndSave').mockImplementation(async objects => { om.addMultiple(objects, true); });
  vi.spyOn(om, 'syncPost').mockResolvedValue();
  vi.spyOn(om, 'syncPostMultiple').mockResolvedValue();
  vi.spyOn(om, 'syncDelete').mockResolvedValue();
  vi.spyOn(om, 'syncDeleteMultiple').mockResolvedValue();
  (om as any).deletedOsm = new Set<string>(); // the user's deleted-OSM list (IndexedDB in the app), empty
  vi.spyOn(EditingEngine.prototype as any, 'recordStudyAreaBoxes').mockImplementation(() => {});
  return { om, editing, history };
}
afterEach(() => vi.restoreAllMocks());

const roadsOf = (om: ObjectManager) => om.getAll().filter((o): o is RoadObject => o.type === 'road');
const key = (om: ObjectManager) => networkContentKey(roadsOf(om), [], []);
const vkey = (p: readonly number[]) => `${p[0].toFixed(7)},${p[1].toFixed(7)}`;

/** Which roads share a network node, by road id pair. */
function joins(roads: RoadObject[]) {
  const { network } = new TrafficNetworkBuilder().build(roads);
  const nodesOf = new Map<string, Set<string>>();
  for (const e of network.edges.values()) {
    const s = nodesOf.get(e.roadId) ?? nodesOf.set(e.roadId, new Set()).get(e.roadId)!;
    s.add(e.fromNodeId); s.add(e.toNodeId);
  }
  return (a: string, b: string) => [...(nodesOf.get(a) ?? [])].some(n => nodesOf.get(b)?.has(n));
}
const wayId = (roads: RoadObject[], way: number) => roads.find(r => r.osmProvenance?.osmId === way)?.id;

/** Pairs of OSM roads that share a node, and pairs whose lines cross with no shared node there. */
function sharedAndCrossing(roads: RoadObject[]) {
  const owners = new Map<string, Set<string>>();
  for (const r of roads) for (const p of r.coordinates) (owners.get(vkey(p)) ?? owners.set(vkey(p), new Set()).get(vkey(p))!).add(r.id);
  const shared = new Set<string>();
  for (const ids of owners.values()) { const l = [...ids].sort(); for (let i = 0; i < l.length; i++) for (let j = i + 1; j < l.length; j++) shared.add(`${l[i]}|${l[j]}`); }
  const crossing: { a: RoadObject; b: RoadObject }[] = [];
  const cross = (p: readonly number[], q: readonly number[], r: readonly number[], s: readonly number[]) => {
    const d = (q[0] - p[0]) * (s[1] - r[1]) - (q[1] - p[1]) * (s[0] - r[0]);
    if (Math.abs(d) < 1e-18) return false;
    const t = ((r[0] - p[0]) * (s[1] - r[1]) - (r[1] - p[1]) * (s[0] - r[0])) / d;
    const u = ((r[0] - p[0]) * (q[1] - p[1]) - (r[1] - p[1]) * (q[0] - p[0])) / d;
    return t > 0.02 && t < 0.98 && u > 0.02 && u < 0.98;
  };
  for (let i = 0; i < roads.length; i++) for (let j = i + 1; j < roads.length; j++) {
    const A = roads[i], B = roads[j];
    if (shared.has([A.id, B.id].sort().join('|'))) continue;
    let hit = false;
    for (let a = 0; a + 1 < A.coordinates.length && !hit; a++) for (let b = 0; b + 1 < B.coordinates.length && !hit; b++) hit = cross(A.coordinates[a], A.coordinates[a + 1], B.coordinates[b], B.coordinates[b + 1]);
    if (hit) crossing.push({ a: A, b: B });
  }
  return { shared, crossing };
}

describe('imported OSM roads join where OSM joins them', () => {
  it('a direct import: every pair of ways sharing an OSM node joins (bridges, underpasses and their ramps at any height); ways crossing on different levels without a shared node do not', async () => {
    const { om, editing } = setup();
    await editing.importStudyArea(WHOLE, 'base', ['roads']);
    const roads = roadsOf(om);
    expect(roads.length).toBeGreaterThan(600);
    const joined = joins(roads);
    const { shared, crossing } = sharedAndCrossing(roads);
    const unjoined = [...shared].map(p => p.split('|')).filter(([a, b]) => !joined(a, b));
    expect(unjoined).toEqual([]);
    for (const [a, b] of CHAIN_JOINS) expect(joined(wayId(roads, a)!, wayId(roads, b)!), `${a}-${b}`).toBe(true);
    // Lifted: the flyover deck is raised, and its ramps meet it at its height
    const deck = om.getById('osm_317550167') as RoadObject;
    expect(Math.max(...deck.coordinates.map(p => p[2]))).toBeGreaterThan(5);
    // Ways crossing without a shared node on different levels (a bridge or underpass over or under a road)
    const level = (r: RoadObject) => (r.osmProvenance?.bridge ? 1 : 0) + (r.osmProvenance?.tunnel ? -1 : 0) + (r.osmProvenance?.layer ?? 0) * 10;
    const separated = crossing.filter(({ a, b }) => level(a) !== level(b));
    expect(separated.length).toBeGreaterThan(10);
    expect(separated.filter(({ a, b }) => joined(a.id, b.id)).map(({ a, b }) => `${a.id}/${b.id}`)).toEqual([]);
    // Ways crossing at the same level with no shared node are not joined either (OSM has no junction there)
    expect(crossing.filter(({ a, b }) => level(a) === level(b) && joined(a.id, b.id)).map(({ a, b }) => `${a.id}/${b.id}`)).toEqual([]);
  });

  it('a clipped Map Selected Area that cuts the flyover, then a study-area load over a larger box: the pieces are completed and the network is the direct import\'s, key for key', async () => {
    const direct = setup();
    await direct.editing.importStudyArea(WHOLE, 'base', ['roads']);
    const directKey = key(direct.om);
    vi.restoreAllMocks();

    const { om, editing } = setup();
    const rep = await editing.importStudyArea(CUT, 'base', ['roads'], { clipToBoundary: true });
    expect(rep.boundaryCuts).toBeGreaterThan(10);
    expect(om.getById('osm_661187172')).toBeUndefined();
    expect(roadsOf(om).some(r => r.osmProvenance?.osmId === 661187172 && r.osmProvenance.clip)).toBe(true);
    await editing.loadOsmRoadsForStudyArea([BOX]);
    const roads = roadsOf(om);
    expect(roads.filter(r => r.osmProvenance?.clip).map(r => r.id)).toEqual([]);
    for (const w of CHAIN) expect(om.getById(`osm_${w}`), String(w)).toBeDefined();
    const joined = joins(roads);
    for (const [a, b] of CHAIN_JOINS) expect(joined(`osm_${a}`, `osm_${b}`), `${a}-${b}`).toBe(true);
    expect(key(om)).toBe(directKey);
  });

  it('undo and redo of an import: undo removes it without marking its ways deleted (a later load brings them back); redo and the reload give the same network key', async () => {
    const { om, editing, history } = setup();
    const empty = key(om);
    await editing.importStudyArea(WHOLE, 'base', ['roads']);
    const imported = key(om);
    expect(imported).not.toBe(empty);
    history.undo();
    expect(roadsOf(om)).toHaveLength(0);
    expect(key(om)).toBe(empty);
    expect([...(await om.deletedOsmIds())].filter(id => id.startsWith('osm_'))).toEqual([]);
    history.redo();
    expect(key(om)).toBe(imported);
    history.undo();
    await editing.loadOsmRoadsForStudyArea([BOX]);
    expect(key(om)).toBe(imported);
    const joined = joins(roadsOf(om));
    for (const [a, b] of CHAIN_JOINS) expect(joined(`osm_${a}`, `osm_${b}`)).toBe(true);
  });

  it('an approach reshaped in Build keeps the heights it was saved with, and still meets the flyover after a reload', async () => {
    const { om, editing } = setup();
    await editing.importStudyArea(WHOLE, 'base', ['roads']);
    const approach = om.getById('osm_22841398') as RoadObject;
    const endZ = approach.coordinates[approach.coordinates.length - 1][2];
    expect(endZ).toBeGreaterThan(3);
    // Saved as edited: a moved vertex, the lifted heights it had, shape marked as the user's
    const saved = roadsOf(om).map(r => structuredClone(r.id !== approach.id ? r : {
      ...r, coordinates: r.coordinates.map((p, i) => (i === 3 ? [p[0], p[1] + 0.00001, p[2]] : p)) as [number, number, number][],
      sections: (r.sections ?? []).map(s => ({ ...s, provenance: { ...(s.provenance ?? { originalSource: 'OSM', originalConfidence: 'estimated', verificationStatus: 'unverified' }), geometryModified: true, lastModifiedBy: 'manual' } })) as any,
    }));
    const reloaded = new ObjectManager();
    reloaded.addMultiple(saved, true);
    const a = reloaded.getById('osm_22841398') as RoadObject, d = reloaded.getById('osm_661187172') as RoadObject;
    expect(a.coordinates[a.coordinates.length - 1][2]).toBeCloseTo(endZ, 6);
    expect(d.coordinates[0][2]).toBeCloseTo(endZ, 6);
    expect(joins(roadsOf(reloaded))('osm_22841398', 'osm_661187172')).toBe(true);
  });

  it('deleting a flyover piece lowers its approach in the session as a reload would; undoing the deletion restores the network key', async () => {
    const { om, editing } = setup();
    await editing.importStudyArea(WHOLE, 'base', ['roads']);
    const before = key(om);
    const deck = structuredClone(om.getById('osm_661187172')!);
    expect((om.getById('osm_22841398') as RoadObject).coordinates.at(-1)![2]).toBeGreaterThan(3);
    om.deleteMultiple([deck], true, false);
    expect((om.getById('osm_22841398') as RoadObject).coordinates.at(-1)![2]).toBe(0);
    // A reload of what is left gives the same roads
    const reloaded = new ObjectManager();
    reloaded.addMultiple(structuredClone(roadsOf(om)), true);
    expect(key(reloaded)).toBe(key(om));
    om.addMultiple([deck], true);
    expect(key(om)).toBe(before);
  });
});


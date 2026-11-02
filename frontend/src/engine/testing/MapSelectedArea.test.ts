import { afterEach, describe, expect, it, vi } from 'vitest';
import { clipPolylineToPolygon, footprintInPolygon, pointInPolygon, ringSelfIntersects } from '../editing/polygonClip';
import { EditingEngine, clippedRoadId } from '../editing/EditingEngine';
import { ObjectManager } from '../objects/ObjectManager';
import { HistoryManager } from '../history/HistoryManager';
import { LocalOsmIndex } from '../editing/LocalOsmIndex';
import { areaFromBoundary } from '../editing/studyAreaImport';
import { TrafficNetworkBuilder } from '../simulation/TrafficNetworkBuilder';
import { StudyAreaExplorer, isAreaCutEnd } from '../simulation/StudyAreaExplorer';
import type { RoadObject } from '../objects/types';

/**
 * "Map Selected Area": a drawn polygon (possibly concave) decides what is
 * imported; its bounding box is only used to fetch. Roads crossing the
 * boundary are cut exactly at it, and cut ends never join anything.
 */

// A concave "U" polygon, open to the north: x in [0, 3], y in [0, 3], notch x in [1, 2], y in [1, 3]
const U: [number, number, number][] = [[0, 0, 0], [3, 0, 0], [3, 3, 0], [2, 3, 0], [2, 1, 0], [1, 1, 0], [1, 3, 0], [0, 3, 0], [0, 0, 0]];

describe('point in polygon', () => {
  it('handles a concave polygon, including points in the notch and on the boundary', () => {
    expect(pointInPolygon([0.5, 2], U)).toBe(true);
    expect(pointInPolygon([2.5, 2], U)).toBe(true);
    expect(pointInPolygon([1.5, 2], U)).toBe(false); // in the notch
    expect(pointInPolygon([1.5, 0.5], U)).toBe(true); // below the notch
    expect(pointInPolygon([3, 1.5], U)).toBe(true); // on the boundary counts as inside
    expect(pointInPolygon([4, 1], U)).toBe(false);
  });
  it('rejects self-intersecting boundaries but accepts concave ones', () => {
    expect(ringSelfIntersects(U)).toBe(false);
    expect(ringSelfIntersects([[0, 0, 0], [1, 1, 0], [1, 0, 0], [0, 1, 0], [0, 0, 0]])).toBe(true);
  });
  it('keeps a building by where its footprint centre lies', () => {
    expect(footprintInPolygon([[0.2, 0.2, 0], [0.4, 0.2, 0], [0.4, 0.4, 0], [0.2, 0.4, 0], [0.2, 0.2, 0]], U)).toBe(true);
    expect(footprintInPolygon([[1.4, 2, 0], [1.6, 2, 0], [1.6, 2.2, 0], [1.4, 2.2, 0], [1.4, 2, 0]], U)).toBe(false);
  });
});

describe('clipping a road to the polygon', () => {
  it('splits a road crossing a concave polygon into the parts inside, cut exactly at the boundary', () => {
    // East-west through both arms of the U, crossing the notch: inside, outside (notch), inside
    const pieces = clipPolylineToPolygon([[-1, 2, 0], [4, 2, 10]], U);
    expect(pieces).toHaveLength(2);
    expect(pieces[0].coordinates[0][0]).toBeCloseTo(0, 12);
    expect(pieces[0].coordinates.at(-1)![0]).toBeCloseTo(1, 12);
    expect(pieces[1].coordinates[0][0]).toBeCloseTo(2, 12);
    expect(pieces[1].coordinates.at(-1)![0]).toBeCloseTo(3, 12);
    // Every piece is cut at both ends (the road goes on outside), and heights are interpolated
    expect(pieces.every(p => p.startCut && p.endCut)).toBe(true);
    expect(pieces[0].coordinates[0][2]).toBeCloseTo(2, 9); // x=0 is 1/5 of the way from x=-1 to x=4
    // Cut points are new; the input's vertices are outside
    expect(pieces[0].sourceIndices).toEqual([null, null]);
  });
  it('keeps a road wholly inside as it is, with no cut ends', () => {
    const coords: [number, number, number][] = [[0.2, 0.2, 0], [0.5, 0.5, 0], [2.5, 0.5, 0]];
    const [piece, ...rest] = clipPolylineToPolygon(coords, U);
    expect(rest).toHaveLength(0);
    expect(piece.coordinates).toEqual(coords);
    expect(piece.startCut || piece.endCut).toBe(false);
    expect(piece.sourceIndices).toEqual([0, 1, 2]);
  });
  it('cuts only the end that leaves the polygon, and keeps interior vertices', () => {
    const [piece] = clipPolylineToPolygon([[0.5, 0.5, 0], [0.5, 2, 0], [0.5, 4, 0]], U);
    expect(piece.startCut).toBe(false);
    expect(piece.endCut).toBe(true);
    expect(piece.coordinates.map(p => p[1])).toEqual([0.5, 2, 3]);
    expect(piece.sourceIndices).toEqual([0, 1, null]);
  });
  it('drops roads outside, or only running along the boundary', () => {
    expect(clipPolylineToPolygon([[1.5, 1.5, 0], [1.5, 2.5, 0]], U)).toHaveLength(0); // in the notch
    expect(clipPolylineToPolygon([[0, 0, 0], [3, 0, 0]], U)).toHaveLength(0); // along the south edge
  });
});

// ── Import ("Map Selected Area") ─────────────────────────────────────────────

const LAT0 = 18.5, LNG0 = 73.8;
const M_LAT = 1 / 111320, M_LNG = 1 / (111320 * Math.cos((LAT0 * Math.PI) / 180));
const at = (x: number, y: number) => ({ lon: +(LNG0 + x * M_LNG).toFixed(7), lat: +(LAT0 + y * M_LAT).toFixed(7) });
const P = (x: number, y: number): [number, number, number] => { const p = at(x, y); return [p.lon, p.lat, 0]; };
// Concave area, 400 m square with a notch from the north: x in [150, 250], y in [150, 400]
const area = areaFromBoundary('area_u', 'U area', [P(0, 0), P(400, 0), P(400, 400), P(250, 400), P(250, 150), P(150, 150), P(150, 400), P(0, 400)]);
const way = (id: number, points: [number, number][], tags: Record<string, string> = { highway: 'residential' }) => ({ type: 'way', id, tags, geometry: points.map(([x, y]) => at(x, y)) });

function setup() {
  vi.spyOn(EditingEngine.prototype, 'fetchSavedAreas').mockResolvedValue();
  const om = new ObjectManager();
  const local = new LocalOsmIndex();
  vi.spyOn(local, 'supports').mockResolvedValue(false);
  const editing = new EditingEngine(om, new HistoryManager(om), undefined, local);
  const fetch = vi.spyOn(editing as any, 'fetchAreaElements');
  vi.spyOn(om, 'addMultipleAndSave').mockImplementation(async objects => { om.addMultiple(objects, true); });
  vi.spyOn(om, 'syncPost').mockResolvedValue();
  vi.spyOn(om, 'deletedOsmIds').mockResolvedValue(new Set());
  return { om, editing, fetch };
}
afterEach(() => vi.restoreAllMocks());

describe('Map Selected Area import', () => {
  it('cuts roads at a concave boundary, keeps what is inside, and records the cut ends', async () => {
    const { om, editing, fetch } = setup();
    fetch.mockResolvedValue([
      way(1, [[-100, 300], [500, 300]]), // crosses both arms and the notch
      way(2, [[50, 50], [350, 50]]), // wholly inside
      way(3, [[200, 200], [200, 380]]), // in the notch only: outside
    ]);
    const report = await editing.importStudyArea(area, 'base', ['roads'], { clipToBoundary: true });
    expect(report.completed).toBe(true);
    expect(report.clippedToBoundary).toBe(true);
    const roads = om.getAll().filter((o): o is RoadObject => o.type === 'road');
    expect(roads.map(r => r.id).sort()).toEqual([clippedRoadId(1, 'area_u', 0), clippedRoadId(1, 'area_u', 1), 'osm_2'].sort());
    expect(report.boundaryCuts).toBe(4);
    const piece = om.getById(clippedRoadId(1, 'area_u', 0)) as RoadObject;
    expect(piece.osmProvenance).toMatchObject({ osmId: 1, clip: { areaId: 'area_u', piece: 0, startCut: true, endCut: true } });
    // The piece ends on the boundary (x = 0 m and x = 150 m)
    expect((piece.coordinates[0][0] - LNG0) / M_LNG).toBeCloseTo(0, 1);
    expect((piece.coordinates.at(-1)![0] - LNG0) / M_LNG).toBeCloseTo(150, 1);
    // A whole way has no clip record
    expect((om.getById('osm_2') as RoadObject).osmProvenance?.clip).toBeUndefined();
  });

  it('keeps buildings by their centre and filters stations to the polygon', async () => {
    const { om, editing, fetch } = setup();
    const square = (id: number, x: number, y: number) => ({ type: 'way', id, tags: { building: 'yes' }, geometry: [[x, y], [x + 10, y], [x + 10, y + 10], [x, y + 10], [x, y]].map(([a, b]) => at(a, b)) });
    fetch.mockImplementation(async (_a: any, category: string) => category === 'buildings'
      ? [square(10, 50, 50), square(11, 195, 300), square(12, 395, 200)] // inside; in the notch; straddling the east edge (centre outside)
      : [{ type: 'node', id: 20, ...at(100, 100), tags: { railway: 'station', station: 'subway' } }, { type: 'node', id: 21, ...at(200, 300), tags: { railway: 'station', station: 'subway' } }]);
    await editing.importStudyArea(area, 'base', ['buildings', 'metro'], { clipToBoundary: true });
    const ids = om.getAll().map(o => o.id).sort();
    expect(ids).toEqual(['osm_b_way_10', 'osm_m_node_20']);
  });

  it('does not add a way twice: whole, or as pieces from another area', async () => {
    const { om, editing, fetch } = setup();
    fetch.mockResolvedValue([way(1, [[-100, 300], [500, 300]])]);
    await editing.importStudyArea(area, 'base', ['roads'], { clipToBoundary: true });
    const before = om.getAll().length;
    const report = await editing.importStudyArea(area, 'base', ['roads']); // whole-feature import of the same way
    expect(report.categories[0].added).toBe(0);
    expect(om.getAll().length).toBe(before);
  });

  it('never joins cut ends of different roads, and offers them as area edges (no traffic invented)', async () => {
    const { om, editing, fetch } = setup();
    // Two one-way carriageways 4 m apart crossing the south edge, and a road joining them inside at shared nodes
    fetch.mockResolvedValue([
      way(1, [[60, 100], [60, -50]], { highway: 'primary', oneway: 'yes' }),
      way(2, [[64, -50], [64, 100]], { highway: 'primary', oneway: 'yes' }),
      way(3, [[60, 100], [64, 100]], { highway: 'primary' }),
    ]);
    await editing.importStudyArea(area, 'base', ['roads'], { clipToBoundary: true });
    const roads = om.getAll().filter((o): o is RoadObject => o.type === 'road');
    const { network } = new TrafficNetworkBuilder().build(roads);
    // The two cut ends (at y = 0, 4 m apart) stay two separate nodes
    const cutNodes = [...network.nodes.values()].filter(n => Math.abs((n.coordinates[1] - LAT0) / M_LAT) < 0.5);
    expect(cutNodes).toHaveLength(2);
    const area2 = new StudyAreaExplorer().explore(roads, 1, { seedRoadIds: ['osm_3'], rangeMeters: 500, direction: 'both' });
    const edges = area2.problems.filter(p => p.kind === 'area_edge');
    expect(edges).toHaveLength(2);
    expect(area2.problems.some(p => p.kind === 'one_way_trap' || p.kind === 'one_way_source')).toBe(false);
    const piece = roads.find(r => r.osmProvenance?.osmId === 1)!;
    expect(isAreaCutEnd(piece, piece.coordinates.at(-1)!)).toBe(true);
    expect(isAreaCutEnd(piece, piece.coordinates[0])).toBe(false);
  });
});

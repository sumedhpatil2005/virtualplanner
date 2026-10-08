import { describe, it, expect, vi } from 'vitest';
import type { RoadObject } from '../objects/types';
import { ObjectManager } from '../objects/ObjectManager';
import { HistoryManager } from '../history/HistoryManager';
import { EditingEngine } from '../editing/EditingEngine';
import { LocalOsmIndex } from '../editing/LocalOsmIndex';
import { StudyAreaExplorer } from '../simulation/StudyAreaExplorer';
import { crossingGaps, piecesBetween, pathLength, mergeGaps } from '../rendering/geometry/junctionGaps';
import { osmRoad, builtRoad } from './OsmStudyNetwork.fixtures';

/**
 * The project holds every mapped road around a study: missing OpenStreetMap
 * roads are filled in (from the local extract, or Overpass), roads the user
 * deleted stay deleted, and hand-drawn copies of mapped roads are pointed out.
 */

const LAT0 = 18.5;
const M_LAT = 1 / 111320;
const M_LNG = 1 / (111320 * Math.cos((LAT0 * Math.PI) / 180));
const pt = (x: number, y: number, z = 0): [number, number, number] => [73.8 + x * M_LNG, LAT0 + y * M_LAT, z];

/** An Overpass-style way element running through the given points (metres). */
const way = (id: number, points: [number, number][], tags: Record<string, string> = { highway: 'primary', name: `Road ${id}` }) => ({
  type: 'way', id, tags,
  geometry: points.map(([x, y]) => ({ lon: pt(x, y)[0], lat: pt(x, y)[1] })),
});

const box = { minLng: pt(-500, -500)[0], minLat: pt(-500, -500)[1], maxLng: pt(500, 500)[0], maxLat: pt(500, 500)[1] };

function setup(elements: any[]) {
  const om = new ObjectManager();
  const saved: string[][] = [];
  om.syncPostMultiple = vi.fn(async objs => {
    saved.push(objs.map(o => o.id));
  });
  const local = new LocalOsmIndex();
  vi.spyOn(local, 'covers').mockResolvedValue(true);
  vi.spyOn(local, 'ways').mockResolvedValue(elements);
  const editing = new EditingEngine(om, new HistoryManager(om), undefined, local);
  return { om, editing, saved };
}

describe('Filling in missing OpenStreetMap roads', () => {
  it('adds only the roads the project is missing, and waits until they are saved', async () => {
    const { om, editing, saved } = setup([way(1, [[0, 0], [300, 0]]), way(2, [[0, 0], [0, 300]]), way(3, [[0, 0], [-300, 0]], { highway: 'footway' })]);
    om.addMultiple([osmRoad('osm_1', [pt(0, 0), pt(300, 0)])], true);
    const added = await editing.loadOsmRoadsForStudyArea([box]);
    expect(added).toBe(1); // way 2; way 1 is held already, the footway is not a road
    expect(saved).toEqual([['osm_2']]);
    expect(om.getById('osm_2')).toBeDefined();
  });

  it('does not bring back roads the user deleted', async () => {
    const { om, editing } = setup([way(5, [[0, 0], [300, 0]])]);
    om.addMultiple([osmRoad('osm_5', [pt(0, 0), pt(300, 0)])], true);
    om.delete('osm_5', true);
    expect(await editing.loadOsmRoadsForStudyArea([box])).toBe(0);
    expect(om.getById('osm_5')).toBeUndefined();
  });

  it('fails, rather than recording the place as checked, when the roads could not be saved', async () => {
    const { om, editing } = setup([way(7, [[0, 0], [300, 0]])]);
    om.syncPostMultiple = vi.fn(async () => {
      throw new Error('backend down');
    });
    await expect(editing.loadOsmRoadsForStudyArea([box])).rejects.toThrow('backend down');
    expect(editing.getSavedAreas()).toHaveLength(0);
  });

  it('asks Overpass for road ids, then fetches only the missing roads, where there is no local extract', async () => {
    const om = new ObjectManager();
    om.syncPostMultiple = vi.fn(async () => {});
    const local = new LocalOsmIndex();
    vi.spyOn(local, 'covers').mockResolvedValue(false);
    const editing = new EditingEngine(om, new HistoryManager(om), undefined, local);
    om.addMultiple([osmRoad('osm_1', [pt(0, 0), pt(300, 0)])], true);
    const query = vi.fn()
      .mockResolvedValueOnce({ elements: [{ type: 'way', id: 1 }, { type: 'way', id: 2 }] })
      .mockResolvedValueOnce({ elements: [way(2, [[0, 0], [0, 300]])] });
    (editing as any).overpass.query = query;
    expect(await editing.loadOsmRoadsForStudyArea([box])).toBe(1);
    expect(query.mock.calls[0][0]).toContain('out ids');
    expect(query.mock.calls[1][0]).toContain('way(id:2)');
  });

  it('treats an empty Overpass answer as a failure, not as a place with no roads', async () => {
    const om = new ObjectManager();
    const local = new LocalOsmIndex();
    vi.spyOn(local, 'covers').mockResolvedValue(false);
    const editing = new EditingEngine(om, new HistoryManager(om), undefined, local);
    (editing as any).overpass.query = vi.fn().mockResolvedValue({ elements: [] });
    await expect(editing.loadOsmRoadsForStudyArea([box])).rejects.toThrow(/no roads/);
  });
});

describe('Hand-drawn copies of mapped roads', () => {
  it('points out a built road that runs along a mapped road', () => {
    const roads: RoadObject[] = [
      osmRoad('osm_main', [pt(-200, 0), pt(400, 0)]),
      builtRoad('copy', [pt(0, 8), pt(300, 12)]), // about 10 m to the side, all the way
      builtRoad('spur', [pt(100, 0), pt(100, 300)]), // leaves the main road
    ];
    const area = new StudyAreaExplorer().explore(roads, 1, { seedRoadIds: ['osm_main'], rangeMeters: 500, direction: 'both' });
    const dupes = area.problems.filter(p => p.kind === 'duplicate');
    expect(dupes.map(p => p.roadIds[0])).toEqual(['copy']);
    expect(dupes[0].title).toContain('osm_main');
  });
});

describe('Clean junctions', () => {
  const road = (points: [number, number][], width = 10) => ({ coordinates: points.map(([x, y]) => pt(x, y)), width });

  it('leaves a gap the width of a crossing road, plus clearance', () => {
    const path = [pt(0, 0), pt(200, 0)];
    const gaps = mergeGaps(crossingGaps(path, road([[100, -50], [100, 50]], 10)), pathLength(path));
    expect(gaps).toHaveLength(1);
    expect(gaps[0][0]).toBeCloseTo(100 - 6.5, 0);
    expect(gaps[0][1]).toBeCloseTo(100 + 6.5, 0);
  });

  it('leaves a gap where a side road meets it, and at its own end on another road', () => {
    const path = [pt(0, 0), pt(200, 0)];
    const t = mergeGaps(crossingGaps(path, road([[60, 0], [60, 100]])), pathLength(path));
    expect(t).toHaveLength(1);
    expect((t[0][0] + t[0][1]) / 2).toBeCloseTo(60, 0);
    const end = mergeGaps(crossingGaps(path, road([[200, -50], [200, 50]])), pathLength(path));
    expect(end[0][1]).toBeCloseTo(200, 0);
  });

  it('leaves no gap under a flyover passing overhead', () => {
    const path = [pt(0, 0), pt(200, 0)];
    const fly = { coordinates: [pt(100, -50, 7), pt(100, 50, 7)], width: 12 };
    expect(crossingGaps(path, fly)).toEqual([]);
  });

  it('splits the road into the pieces between gaps', () => {
    const path = [pt(0, 0), pt(200, 0)];
    const pieces = piecesBetween(path, [[50, 60], [120, 130]]);
    expect(pieces.map(p => Math.round(pathLength(p)))).toEqual([50, 60, 70]);
  });
});

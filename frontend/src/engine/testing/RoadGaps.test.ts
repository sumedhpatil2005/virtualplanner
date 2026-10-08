import { describe, it, expect } from 'vitest';
import type { RoadObject, FlyoverObject, RoadSectionProfile, CityObject } from '../objects/types';
import { ObjectManager } from '../objects/ObjectManager';
import { HistoryManager } from '../history/HistoryManager';
import { EditingEngine } from '../editing/EditingEngine';
import { findRoadEndGaps, insertRoadVertex, MAX_CONNECT_GAP_M } from '../editing/roadGaps';
import { TrafficNetworkBuilder } from '../simulation/TrafficNetworkBuilder';
import { Pathfinder } from '../simulation/Pathfinder';
import type { TrafficNetwork } from '../objects/trafficTypes';

// Local metric frame: (x, y) metres east/north of an origin in Pune
const LAT0 = 18.5;
const M_LAT = 1 / 111320;
const M_LNG = 1 / (111320 * Math.cos((LAT0 * Math.PI) / 180));
const pt = (x: number, y: number, z = 0): [number, number, number] => [73.8 + x * M_LNG, LAT0 + y * M_LAT, z];

const road = (id: string, coords: [number, number, number][]): RoadObject => ({
  id,
  type: 'road',
  name: id,
  layerId: 'roads',
  scenarioId: 'base',
  coordinates: coords,
  roadClass: 'local',
  width: 10,
  laneCount: 2,
  laneWidth: 3.5,
  hasDivider: false,
  dividerWidth: 0,
  hasFootpath: false,
  footpathWidth: 0,
  speedLimit: 40,
  isOneWay: false,
  trafficCapacity: 1000,
  connectedJunctions: [],
  createdAt: '',
  updatedAt: '',
});

const flyover = (id: string, coords: [number, number, number][]): FlyoverObject => ({
  ...road(id, coords),
  type: 'flyover',
  elevation: 7,
  pierSpacing: 30,
} as unknown as FlyoverObject);

const setup = (objects: CityObject[]) => {
  const om = new ObjectManager();
  const history = new HistoryManager(om);
  const editing = new EditingEngine(om, history);
  om.addMultiple(objects, true);
  return { om, history, editing };
};

const nearestNode = (net: TrafficNetwork, p: [number, number, number]) => {
  let best = '', bestD = Infinity;
  net.nodes.forEach(n => {
    const d = Math.hypot(n.coordinates[0] - p[0], n.coordinates[1] - p[1]);
    if (d < bestD) { bestD = d; best = n.id; }
  });
  return best;
};

/** Whether traffic can drive from `from` to `to` over these roads. */
const routable = (roads: CityObject[], from: [number, number, number], to: [number, number, number]) => {
  const { network } = new TrafficNetworkBuilder().build(roads as RoadObject[]);
  const path = Pathfinder.findPath(network, nearestNode(network, from), nearestNode(network, to));
  return path !== null && path.length > 0;
};

const section = (start: number, end: number): RoadSectionProfile =>
  ({ startNodeIndex: start, endNodeIndex: end } as RoadSectionProfile);

describe('insertRoadVertex', () => {
  const coords = [pt(0, 0), pt(10, 0), pt(20, 0), pt(30, 0), pt(40, 0)];
  const twoSections = { coordinates: coords, sections: [section(0, 2), section(2, 4)] };
  const ranges = (s: RoadSectionProfile[] | undefined) => s!.map(x => [x.startNodeIndex, x.endNodeIndex]);

  it('extends the last section when appending', () => {
    const r = insertRoadVertex(twoSections, 5, pt(50, 0));
    expect(r.coordinates).toHaveLength(6);
    expect(ranges(r.sections)).toEqual([[0, 2], [2, 5]]);
  });

  it('extends the first section when prepending', () => {
    const r = insertRoadVertex(twoSections, 0, pt(-10, 0));
    expect(r.coordinates[0]).toEqual(pt(-10, 0));
    expect(ranges(r.sections)).toEqual([[0, 3], [3, 5]]);
  });

  it('shifts later ranges when inserting inside a section', () => {
    const r = insertRoadVertex(twoSections, 1, pt(5, 0));
    expect(ranges(r.sections)).toEqual([[0, 3], [3, 5]]);
    const r2 = insertRoadVertex(twoSections, 4, pt(35, 0));
    expect(ranges(r2.sections)).toEqual([[0, 2], [2, 5]]);
  });

  it('keeps a road without sections section-less', () => {
    expect(insertRoadVertex({ coordinates: coords }, 2, pt(15, 0)).sections).toBeUndefined();
  });

  it('rejects indices outside the road', () => {
    expect(() => insertRoadVertex(twoSections, 6, pt(0, 0))).toThrow();
  });
});

describe('findRoadEndGaps', () => {
  const main = road('main', [pt(0, 0), pt(100, 0), pt(200, 0)]);

  it('finds an end that stops short and where it would join', () => {
    const side = road('side', [pt(150, 100), pt(150, 12)]);
    const gaps = findRoadEndGaps(side, [main, side]);
    expect(gaps).toHaveLength(1);
    expect(gaps[0]).toMatchObject({ roadId: 'side', end: 'end', targetRoadId: 'main', targetVertex: null, targetSegment: 1 });
    expect(gaps[0].gapM).toBeCloseTo(12, 0);
    expect(gaps[0].joinPoint[0]).toBeCloseTo(pt(150, 0)[0], 9);
    expect(gaps[0].joinPoint[1]).toBeCloseTo(LAT0, 9);
  });

  it('ignores ends the network already joins, far gaps, and roads at other heights', () => {
    const joined = road('joined', [pt(50, 100), pt(50, 3)]); // within the ~6 m join tolerance
    const far = road('far', [pt(120, 100), pt(120, MAX_CONNECT_GAP_M + 5)]);
    const over = flyover('over', [pt(-50, 10, 7), pt(250, 10, 7)]);
    const high = road('high', [pt(170, 100, 7), pt(170, 12, 7)]); // an elevated end over the ground road
    expect(findRoadEndGaps(joined, [main, joined])).toEqual([]);
    expect(findRoadEndGaps(far, [main, far])).toEqual([]);
    expect(findRoadEndGaps(high, [main, high, over])).toEqual([]);
    expect(findRoadEndGaps(over, [main, over])).toEqual([]); // flyovers are never extended
  });

  it('reuses a vertex of the other road that is right at the join point', () => {
    const side = road('side', [pt(100.5, 100), pt(100.5, 10)]);
    const [gap] = findRoadEndGaps(side, [main, side]);
    expect(gap.targetVertex).toBe(1);
    expect(gap.joinPoint).toEqual(main.coordinates[1]);
  });
});

describe('EditingEngine.connectRoadEnd', () => {
  it('joins the roads so traffic can route between them, as one undo step', () => {
    const main = road('main', [pt(0, 0), pt(100, 0), pt(200, 0)]);
    const side = road('side', [pt(150, 100), pt(150, 12)]);
    const { om, history, editing } = setup([main, side]);
    const before = om.getAll().map(o => JSON.parse(JSON.stringify(o)));
    expect(routable(om.getAll(), pt(0, 0), pt(150, 100))).toBe(false);

    const [gap] = findRoadEndGaps(om.getById('side')!, om.getAll());
    editing.connectRoadEnd(gap, om.getAll());

    const mainAfter = om.getById('main') as RoadObject;
    const sideAfter = om.getById('side') as RoadObject;
    expect(mainAfter.coordinates).toHaveLength(4);
    expect(sideAfter.coordinates[sideAfter.coordinates.length - 1]).toEqual(mainAfter.coordinates[2]);
    // Section ranges still cover the whole road, and the edit is marked as manual geometry
    expect(mainAfter.sections![0].endNodeIndex).toBe(3);
    expect(sideAfter.sections![0].endNodeIndex).toBe(2);
    expect(sideAfter.sections![0].provenance.geometryModified).toBe(true);
    expect(routable(om.getAll(), pt(0, 0), pt(150, 100))).toBe(true);
    expect(findRoadEndGaps(sideAfter, om.getAll())).toEqual([]);

    history.undo();
    const restored = (id: string) => (om.getById(id) as RoadObject);
    for (const b of before) {
      expect(restored(b.id).coordinates).toEqual(b.coordinates);
      expect(restored(b.id).sections).toEqual(b.sections);
    }
    expect(history.canUndo()).toBe(false);

    history.redo();
    expect(routable(om.getAll(), pt(0, 0), pt(150, 100))).toBe(true);
  });

  it('adds no vertex to the other road when joining at an existing one', () => {
    const main = road('main', [pt(0, 0), pt(100, 0), pt(200, 0)]);
    const side = road('side', [pt(100.5, 100), pt(100.5, 10)]);
    const { om, editing } = setup([main, side]);
    const [gap] = findRoadEndGaps(om.getById('side')!, om.getAll());
    editing.connectRoadEnd(gap, om.getAll());
    expect((om.getById('main') as RoadObject).coordinates).toHaveLength(3);
    expect(routable(om.getAll(), pt(0, 0), pt(100.5, 100))).toBe(true);
  });

  it('refuses while the network is locked for Simulation mode', () => {
    const main = road('main', [pt(0, 0), pt(200, 0)]);
    const side = road('side', [pt(150, 100), pt(150, 12)]);
    const { om, editing } = setup([main, side]);
    const [gap] = findRoadEndGaps(om.getById('side')!, om.getAll());
    editing.setLocked(true);
    expect(() => editing.connectRoadEnd(gap, om.getAll())).toThrow(/read-only/);
    expect((om.getById('main') as RoadObject).coordinates).toHaveLength(2);
  });

  it('refuses a gap that has since been closed', () => {
    const main = road('main', [pt(0, 0), pt(200, 0)]);
    const side = road('side', [pt(150, 100), pt(150, 12)]);
    const { om, editing } = setup([main, side]);
    const [gap] = findRoadEndGaps(om.getById('side')!, om.getAll());
    editing.connectRoadEnd(gap, om.getAll());
    expect(() => editing.connectRoadEnd(gap, om.getAll())).toThrow(/no longer stops short/);
  });
});

describe('drawing a road onto another keeps its sections whole', () => {
  it('extends the split road\'s section to its last vertex', () => {
    const main = road('main', [pt(0, 0), pt(200, 0)]);
    const { om, editing } = setup([main]);
    expect((om.getById('main') as RoadObject).sections![0].endNodeIndex).toBe(1);
    editing.setMode('draw_road');
    editing.addDrawingPoint(pt(100, 80));
    editing.addDrawingPoint(pt(100, 0));
    editing.finalizeDrawing('base');
    const split = om.getById('main') as RoadObject;
    expect(split.coordinates).toHaveLength(3);
    expect(split.sections![0].endNodeIndex).toBe(2);
  });
});

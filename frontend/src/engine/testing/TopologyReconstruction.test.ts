import { beforeEach, describe, expect, it, vi } from 'vitest';
import { EditingEngine } from '../editing/EditingEngine';
import { loadNetwork, type DbRow } from './editHarness';
import { TrafficNetworkBuilder } from '../simulation/TrafficNetworkBuilder';
import { Pathfinder } from '../simulation/Pathfinder';
import type { RoadObject } from '../objects/types';

/**
 * Topology reconstruction rules (docs/TOPOLOGY_RECONSTRUCTION.md), on SYNTHETIC roads (not real data): an east-west
 * road at 18.5°N, 73.85°E, crossed north-south by a drawn road.
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

function setup(rows: DbRow[]) {
  vi.spyOn(EditingEngine.prototype, 'fetchSavedAreas').mockResolvedValue();
  const { om, history } = loadNetwork(rows, false);
  const ed = new EditingEngine(om, history, undefined, {} as any);
  const draw = (pts: [number, number, number][]) => {
    ed.setMode('draw_road');
    for (const [x, y, z] of pts) ed.addDrawingPoint([LNG + dLng(x), LAT + dLat(y), z]);
    const before = new Set(om.getAll().map(o => o.id));
    ed.finalizeDrawing('base');
    ed.setMode('select');
    return om.getAll().find(o => !before.has(o.id)) as RoadObject;
  };
  const net = () => new TrafficNetworkBuilder().build(om.getAll().filter(o => o.type === 'road') as RoadObject[]).network;
  const sharedNodes = (a: string, b: string) => {
    const n = net();
    const of = (id: string) => new Set([...n.edges.values()].filter(e => e.roadId === id).flatMap(e => [e.fromNodeId, e.toNodeId]));
    const A = of(a), B = of(b);
    return [...A].filter(x => B.has(x));
  };
  return { om, history, ed, draw, net, sharedNodes };
}

describe('topology reconstruction (synthetic roads)', () => {
  beforeEach(() => vi.restoreAllMocks());

  it('a drawn road crossing a ground road mid-way makes a junction: a vertex on both, one graph node, routable', () => {
    const t = setup([row('osm_1', [[-100, 0], [100, 0]], 0)]);
    const nr = t.draw([[0, -60, 0], [0, 60, 0]]);
    const ground = t.om.getById('osm_1') as RoadObject;
    expect(ground.coordinates).toHaveLength(3);
    expect(nr.coordinates).toHaveLength(3);
    expect(nr.coordinates[1][0]).toBe(ground.coordinates[1][0]);
    expect(nr.coordinates[1][1]).toBe(ground.coordinates[1][1]);
    expect(nr.levelCrossings).toBeUndefined();
    const shared = t.sharedNodes(nr.id, 'osm_1');
    expect(shared).toHaveLength(1);
    const n = t.net();
    const ends = [...n.edges.values()].filter(e => e.roadId === nr.id).flatMap(e => [e.fromNodeId, e.toNodeId]).filter(x => x !== shared[0]);
    const groundEnds = [...n.edges.values()].filter(e => e.roadId === 'osm_1').flatMap(e => [e.fromNodeId, e.toNodeId]).filter(x => x !== shared[0]);
    expect(Pathfinder.findPath(n, ends[0], groundEnds[0])).not.toBeNull();
    // Undo: both roads exactly as before; redo: as drawn
    const after = structuredClone(t.om.getById('osm_1'));
    t.history.undo();
    expect((t.om.getById('osm_1') as RoadObject).coordinates).toHaveLength(2);
    expect(t.om.getById(nr.id)).toBeUndefined();
    t.history.redo();
    expect((t.om.getById('osm_1') as RoadObject).coordinates).toEqual(after!.coordinates);
  });

  it('a ground road under a bridge deck (6.5 m) is not joined and not flagged', () => {
    const t = setup([row('osm_2', [[-100, 0], [100, 0]], 6.5, { bridge: 'yes', layer: '1' })]);
    const deck = t.om.getById('osm_2');
    expect(Math.min(...(deck as RoadObject).coordinates.slice(3, -3).map(p => p[2]))).toBeGreaterThan(3);
    const nr = t.draw([[0, -60, 0], [0, 60, 0]]);
    expect(t.sharedNodes(nr.id, 'osm_2')).toEqual([]);
    expect(nr.levelCrossings).toBeUndefined();
    expect(t.om.getById('osm_2')).toBe(deck);
  });

  it('a bridge-tagged piece at ground height: not guessed; flagged; Confirm junction joins, Keep separate keeps apart; undo exact', () => {
    // bridge=yes, 20 m long, over nothing known (a nala): bridgeElevation keeps it near road level (0.5 m at mid-span)
    const t = setup([row('osm_31', [[-100, 0], [-10, 0]], 0), row('osm_3', [[-10, 0], [10, 0]], 0, { bridge: 'yes' }), row('osm_32', [[10, 0], [100, 0]], 0)]);
    const bridge = t.om.getById('osm_3') as RoadObject;
    expect(Math.max(...bridge.coordinates.map(p => p[2]))).toBeLessThan(3);
    const nr = t.draw([[0, -60, 0], [0, 60, 0]]);
    expect(nr.levelCrossings).toHaveLength(1);
    expect(nr.levelCrossings![0]).toMatchObject({ roadId: 'osm_3', decision: 'unconfirmed' });
    expect(t.sharedNodes(nr.id, 'osm_3')).toEqual([]);
    expect(t.om.getById('osm_3')).toBe(bridge);

    const drawn = structuredClone(t.om.getById(nr.id));
    t.ed.resolveLevelCrossing(nr.id, 0, 'junction');
    expect(t.sharedNodes(nr.id, 'osm_3')).toHaveLength(1);
    expect((t.om.getById(nr.id) as RoadObject).levelCrossings![0].decision).toBe('junction');
    t.history.undo();
    expect(t.om.getById(nr.id)).toEqual({ ...drawn, updatedAt: t.om.getById(nr.id)!.updatedAt });
    expect((t.om.getById('osm_3') as RoadObject).coordinates).toEqual(bridge.coordinates);
    expect(t.sharedNodes(nr.id, 'osm_3')).toEqual([]);

    t.ed.resolveLevelCrossing(nr.id, 0, 'separate');
    expect(t.sharedNodes(nr.id, 'osm_3')).toEqual([]);
    expect((t.om.getById(nr.id) as RoadObject).levelCrossings![0].decision).toBe('separate');
    expect(t.ed.unconfirmedCrossings(nr.id)).toEqual([]);
  });

  it('a ground road crossing a layer=1 road (no bridge tag) at the same height is flagged, not joined', () => {
    const t = setup([row('osm_4', [[-100, 0], [100, 0]], 0, { layer: '1' })]);
    const nr = t.draw([[0, -60, 0], [0, 60, 0]]);
    expect(nr.levelCrossings?.[0]).toMatchObject({ roadId: 'osm_4', decision: 'unconfirmed' });
    expect(t.sharedNodes(nr.id, 'osm_4')).toEqual([]);
  });

  it('an OSM road end 5 m from a drawn road is not joined to it; a drawn end 5 m short of a road still is', () => {
    // osm_5 ends 5 m east of where the drawn road passes (x = 0); before, the 6.6 m join tolerance joined them
    const t = setup([row('osm_5', [[5, 0], [100, 0]], 0), row('osm_6', [[-100, 80], [100, 80]], 0)]);
    const nr = t.draw([[0, -60, 0], [0, 40, 0]]);
    expect(t.sharedNodes(nr.id, 'osm_5')).toEqual([]);
    // A road the user draws that stops 5 m short of osm_6 joins it (auto-connect carries the end; tolerance otherwise)
    const nr2 = t.draw([[50, 20, 0], [50, 75, 0]]);
    expect(t.sharedNodes(nr2.id, 'osm_6')).toHaveLength(1);
  });
});

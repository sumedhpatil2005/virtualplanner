import { describe, expect, it, vi } from 'vitest';
import { junctionLayout } from '../objects/junctionLayout';
import { ProceduralGeometryGenerator } from '../rendering/geometry/ProceduralGeometryGenerator';
import type { JunctionObject, RoadObject } from '../objects/types';
import { ObjectManager } from '../objects/ObjectManager';
import { HistoryManager } from '../history/HistoryManager';
import { EditingEngine } from '../editing/EditingEngine';

const pt = (x: number, y: number, z = 0): [number, number, number] => [73.8 + x / (111320 * Math.cos(18.5 * Math.PI / 180)), 18.5 + y / 111320, z];
const road = (id: string, coords: [number, number, number][]) => ({ id, type: 'road', coordinates: coords, laneCount: 2, laneWidth: 3.5, width: 7, roadClass: 'local', connectedJunctions: [], speedLimit: 40 } as unknown as RoadObject);
const cross = [road('ew', [pt(-60, 0), pt(0, 0), pt(60, 0)]), road('ns', [pt(0, -60), pt(0, 0), pt(0, 60)])];

describe('Junction footprint shared by editor and renderer', () => {
  it('recognises all four arms at a vertex without duplicating them', () => {
    const layout = junctionLayout(pt(0, 0), cross);
    expect(layout.valid).toBe(true);
    expect(layout.arms).toHaveLength(4);
    expect(layout.roadIds).toEqual(['ew', 'ns']);
    expect(layout.boundary).toHaveLength(8);
  });
  it('does not connect another deck or an adjacent parallel road', () => {
    const layout = junctionLayout(pt(0, 0), [cross[0], road('bridge', [pt(0, -60, 8), pt(0, 60, 8)]), road('parallel', [pt(-60, 7), pt(60, 7)])]);
    expect(layout.roadIds).toEqual(['ew']);
    expect(layout.arms).toHaveLength(2);
  });
  it('keeps both road tangents when the cursor is slightly offset from a vertex', () => {
    const layout = junctionLayout(pt(0, 2), [cross[0]]);
    expect(layout.arms).toHaveLength(2);
    expect(layout.arms.map(a => Math.round(a.dx)).sort()).toEqual([-1, 1]);
    expect(layout.arms.every(a => Math.abs(a.dy) < 0.001)).toBe(true);
  });
  it('rejects isolated placement and a single dead-end approach', () => {
    expect(junctionLayout(pt(100, 100), cross).valid).toBe(false);
    expect(junctionLayout(pt(0, 0), [road('end', [pt(0, 0), pt(50, 0)])]).valid).toBe(false);
  });
  it('renders approach-shaped asphalt and pedestrian markings instead of a cylinder', () => {
    const j = { id: 'j', type: 'junction', coordinates: pt(0, 0), connectedRoads: ['ew', 'ns'], hasSignals: true, hasPedestrianCrossing: true } as JunctionObject;
    const meshes = new ProceduralGeometryGenerator().generateMeshData(j, new Map([['j', j], ...cross.map(r => [r.id, r] as const)]));
    expect(meshes[0].positions.length).toBe(8 * 3);
    expect(meshes[0].indices.length).toBe(6 * 3);
    expect(meshes.filter(m => m.layerId === 'marking').length).toBeGreaterThan(4);
    expect(meshes.every(m => [...m.positions].every(Number.isFinite))).toBe(true);
  });
});

describe('Placing a junction on a deck', () => {
  it('keeps each road at its own height and seats the junction on the deck, not the cursor', () => {
    const deck = (id: string, coords: [number, number, number][]) => ({
      ...road(id, coords), name: id, layerId: 'roads', scenarioId: 'base', hasDivider: false, dividerWidth: 0,
      hasFootpath: false, footpathWidth: 0, isOneWay: false, trafficCapacity: 1000,
      createdAt: new Date().toISOString(), updatedAt: new Date().toISOString(),
    } as RoadObject);
    const om = new ObjectManager();
    const editing = new EditingEngine(om, new HistoryManager(om));
    om.add(deck('ew', [pt(-60, 0, 6), pt(60, 0, 6)]), true);
    om.add(deck('ns', [pt(0, -60, 6), pt(0, 60, 6)]), true);
    expect(junctionLayout(pt(0, 0, 7.5), om.getAll() as RoadObject[]).elevation).toBeCloseTo(6, 6);
    editing.setMode('draw_junction');
    // The pick landed 1.5 m above the deck (e.g. on a vehicle or label) and nothing snapped
    vi.spyOn((editing as any).snapManager, 'findSnap').mockReturnValue({ type: 'none' });
    editing.addDrawingPoint(pt(0, 0, 7.5));
    editing.finalizeDrawing('base');
    const junction = om.getAll().find(o => o.type === 'junction') as JunctionObject;
    expect(junction.connectedRoads.sort()).toEqual(['ew', 'ns']);
    expect(junction.coordinates[2]).toBeCloseTo(6, 6);
    for (const id of ['ew', 'ns']) {
      const r = om.getById(id) as RoadObject;
      expect(r.coordinates).toHaveLength(3);
      expect(r.coordinates.every(p => Math.abs(p[2] - 6) < 1e-6)).toBe(true);
    }
  });
});

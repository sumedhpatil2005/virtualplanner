import { describe, it, expect, vi, afterEach } from 'vitest';
import { HistoryManager } from '../history/HistoryManager';
import { ObjectManager } from '../objects/ObjectManager';
import { EditingEngine } from '../editing/EditingEngine';
import { connectionState, apiGet } from '../../lib/api';
import type { RoadObject, BuildingObject } from '../objects/types';

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
  createdAt: new Date().toISOString(),
  updatedAt: new Date().toISOString()
});

const setup = () => {
  const om = new ObjectManager();
  const history = new HistoryManager(om);
  const editing = new EditingEngine(om, history);
  return { om, history, editing };
};

describe('Editing workflow regressions', () => {
  it('ignores the duplicate point a double-click produces', () => {
    const { editing } = setup();
    editing.setMode('draw_road');
    editing.addDrawingPoint([73.7, 18.5, 0]);
    editing.addDrawingPoint([73.7, 18.5, 0]); // second click of a double-click
    expect(editing.getDrawingPoints()).toHaveLength(1);
  });

  it('keeps the tool active after finishing a drawing (sticky tools)', () => {
    const { om, editing } = setup();
    editing.setMode('draw_road');
    editing.addDrawingPoint([73.70, 18.50, 0]);
    editing.addDrawingPoint([73.71, 18.50, 0]);
    editing.finalizeDrawing('base');
    expect(editing.getMode()).toBe('draw_road');
    expect(editing.getDrawingPoints()).toHaveLength(0);
    expect(om.getAll().filter(o => o.type === 'road')).toHaveLength(1);
  });

  it('reports a clear error instead of silently ignoring too few points', () => {
    const { editing } = setup();
    editing.setMode('draw_road');
    editing.addDrawingPoint([73.70, 18.50, 0]);
    expect(() => editing.finalizeDrawing('base')).toThrow(/at least 2 points/);
    // The in-progress point is kept so the user can continue
    expect(editing.getDrawingPoints()).toHaveLength(1);
  });

  it('undoes a T-junction road draw as one step, restoring the split road', () => {
    const { om, history, editing } = setup();
    const main = road('main', [[73.70, 18.50, 0], [73.72, 18.50, 0]]);
    om.add(main, true);

    editing.setMode('draw_road');
    editing.addDrawingPoint([73.71, 18.52, 0]);
    editing.addDrawingPoint([73.71, 18.50, 0]); // lands mid-way along "main"
    editing.finalizeDrawing('base');

    expect(om.getById('main')!.coordinates).toHaveLength(3);
    expect(om.getAll()).toHaveLength(2);

    history.undo();
    expect(om.getAll()).toHaveLength(1);
    expect(om.getById('main')!.coordinates).toHaveLength(2);

    history.redo();
    expect(om.getAll()).toHaveLength(2);
    expect(om.getById('main')!.coordinates).toHaveLength(3);
  });

  it('splits correctly when both ends of the new road hit the same road', () => {
    const { om, editing } = setup();
    om.add(road('loop', [[73.70, 18.50, 0], [73.72, 18.50, 0]]), true);
    editing.setMode('draw_road');
    editing.addDrawingPoint([73.705, 18.50, 0]);
    editing.addDrawingPoint([73.705, 18.51, 0]);
    editing.addDrawingPoint([73.715, 18.51, 0]);
    editing.addDrawingPoint([73.715, 18.50, 0]);
    editing.finalizeDrawing('base');
    // Both insertions survive (previously the second overwrote the first)
    expect(om.getById('loop')!.coordinates).toHaveLength(4);
  });

  it('coalesces rapid edits to the same field into one undo step', () => {
    const om = new ObjectManager();
    const history = new HistoryManager(om);
    const b0 = { ...road('r', [[0, 0, 0], [1, 0, 0]]), name: 'A' };
    om.add(b0, true);
    let prev = om.getById('r')!;
    for (const name of ['Ab', 'Abc', 'Abcd']) {
      const next = { ...prev, name };
      history.recordUpdate(prev, next, 'rename', 'r:name');
      om.update('r', { name }, true);
      prev = om.getById('r')!;
    }
    expect(history.getUndoStackCount()).toBe(1);
    history.undo();
    expect(om.getById('r')!.name).toBe('A');
  });

  it('does not coalesce edits to different fields', () => {
    const om = new ObjectManager();
    const history = new HistoryManager(om);
    const b = { id: 'b', type: 'building', name: 'B', height: 10 } as unknown as BuildingObject;
    history.recordUpdate(b, { ...b, name: 'C' }, 'rename', 'b:name');
    history.recordUpdate(b, { ...b, height: 12 }, 'height', 'b:height');
    expect(history.getUndoStackCount()).toBe(2);
  });
});

describe('Connection state', () => {
  afterEach(() => {
    vi.unstubAllGlobals();
  });

  it('recovers from offline once a request succeeds', async () => {
    vi.stubGlobal('fetch', vi.fn().mockRejectedValue(new TypeError('Failed to fetch')));
    await expect(apiGet('/api/areas')).rejects.toThrow();
    expect(connectionState.current).toBe('offline');

    vi.stubGlobal('fetch', vi.fn().mockResolvedValue(new Response('[]', { status: 200 })));
    await apiGet('/api/areas');
    expect(connectionState.current).toBe('online');
  });

  it('treats an HTTP error as reachable (not offline) but still throws', async () => {
    vi.stubGlobal('fetch', vi.fn().mockResolvedValue(new Response('bad', { status: 422 })));
    await expect(apiGet('/api/objects')).rejects.toThrow(/422/);
    expect(connectionState.current).toBe('online');
  });
});

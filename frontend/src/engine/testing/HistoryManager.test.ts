import { describe, it, expect } from 'vitest';
import { HistoryManager } from '../history/HistoryManager';
import { ObjectManager } from '../objects/ObjectManager';
import type { CityObject, RoadObject, BuildingObject } from '../objects/types';

describe('HistoryManager — Structural Diffs & Honest Undo (Phase 1)', () => {
  const createMockRoad = (id: string, name: string): RoadObject => ({
    id,
    type: 'road',
    name,
    layerId: 'roads',
    scenarioId: 'base',
    coordinates: [[73.74, 18.59, 0], [73.75, 18.59, 0]],
    roadClass: 'arterial',
    width: 14,
    laneCount: 4,
    laneWidth: 3.5,
    hasDivider: true,
    dividerWidth: 1.0,
    hasFootpath: false,
    footpathWidth: 0,
    speedLimit: 60,
    isOneWay: false,
    trafficCapacity: 2000,
    connectedJunctions: [],
    createdAt: new Date().toISOString(),
    updatedAt: new Date().toISOString()
  });

  const createMockBuilding = (id: string, name: string, height = 20): BuildingObject => ({
    id,
    type: 'building',
    name,
    layerId: 'buildings',
    scenarioId: 'base',
    coordinates: [
      [73.74, 18.59, 0],
      [73.741, 18.59, 0],
      [73.741, 18.591, 0],
      [73.74, 18.591, 0],
      [73.74, 18.59, 0]
    ],
    height,
    floors: Math.round(height / 3),
    population: 100,
    usageType: 'residential',
    waterDemand: 13500,
    electricityDemand: 500,
    createdAt: new Date().toISOString(),
    updatedAt: new Date().toISOString()
  });

  it('1. Correctly records and undoes an object creation (recordAdd)', () => {
    const om = new ObjectManager();
    const history = new HistoryManager(om);

    const road = createMockRoad('road_1', 'Phase 1 Boulevard');
    om.add(road, true);
    history.recordAdd(road, 'Add road_1');

    expect(om.getById('road_1')).toBeDefined();
    expect(history.canUndo()).toBe(true);
    expect(history.canRedo()).toBe(false);

    // Undo -> road is deleted
    history.undo();
    expect(om.getById('road_1')).toBeUndefined();
    expect(history.canUndo()).toBe(false);
    expect(history.canRedo()).toBe(true);

    // Redo -> road is restored
    history.redo();
    expect(om.getById('road_1')).toBeDefined();
    expect(history.canUndo()).toBe(true);
  });

  it('2. Correctly records and undoes an object update (recordUpdate)', () => {
    const om = new ObjectManager();
    const history = new HistoryManager(om);

    const originalBuilding = createMockBuilding('b_1', 'Tower A', 30);
    om.add(originalBuilding, true);

    const updatedBuilding = { ...originalBuilding, height: 90, floors: 30 };
    history.recordUpdate(originalBuilding, updatedBuilding, 'Raise Tower A height');
    om.update('b_1', updatedBuilding, true);

    expect((om.getById('b_1') as BuildingObject).height).toBe(90);

    // Undo -> height reverts to 30
    history.undo();
    expect((om.getById('b_1') as BuildingObject).height).toBe(30);

    // Redo -> height is 90 again
    history.redo();
    expect((om.getById('b_1') as BuildingObject).height).toBe(90);
  });

  it('3. Correctly records and undoes batch deletion (recordDelete)', () => {
    const om = new ObjectManager();
    const history = new HistoryManager(om);

    const b1 = createMockBuilding('b_1', 'Building 1');
    const b2 = createMockBuilding('b_2', 'Building 2');
    const b3 = createMockBuilding('b_3', 'Building 3');
    om.addMultiple([b1, b2, b3], true);

    expect(om.getAll().length).toBe(3);

    // Delete 3 buildings
    history.recordDelete([b1, b2, b3], 'Delete 3 buildings');
    om.deleteMultiple([b1, b2, b3], true);

    expect(om.getAll().length).toBe(0);

    // Undo -> all 3 buildings restored
    history.undo();
    expect(om.getAll().length).toBe(3);
    expect(om.getById('b_1')).toBeDefined();
    expect(om.getById('b_2')).toBeDefined();
    expect(om.getById('b_3')).toBeDefined();

    // Redo -> all 3 deleted again
    history.redo();
    expect(om.getAll().length).toBe(0);
  });

  it('4. Multi-step sequence: Draw road -> Delete 3 buildings -> Edit field -> Undo 3x reverses in order', () => {
    const om = new ObjectManager();
    const history = new HistoryManager(om);

    // Base buildings
    const b1 = createMockBuilding('b_1', 'Tower 1', 20);
    const b2 = createMockBuilding('b_2', 'Tower 2', 25);
    const b3 = createMockBuilding('b_3', 'Tower 3', 30);
    const b4 = createMockBuilding('b_4', 'Tower 4', 40);
    om.addMultiple([b1, b2, b3, b4], true);

    // Step 1: Draw a road
    const newRoad = createMockRoad('road_10', 'Expressway');
    om.add(newRoad, true);
    history.recordAdd(newRoad, 'Draw road');

    // Step 2: Delete 3 buildings
    const toDelete = [b1, b2, b3];
    history.recordDelete(toDelete, 'Delete 3 towers');
    om.deleteMultiple(toDelete, true);

    // Step 3: Edit field on b4 (raise height to 80)
    const b4Updated = { ...b4, height: 80 };
    history.recordUpdate(b4, b4Updated, 'Update b4 height');
    om.update('b_4', b4Updated, true);

    // State right now: road exists, b1-b3 deleted, b4 height 80
    expect(om.getById('road_10')).toBeDefined();
    expect(om.getById('b_1')).toBeUndefined();
    expect((om.getById('b_4') as BuildingObject).height).toBe(80);

    // Undo 1: Reverses Step 3 (b4 height reverts to 40)
    history.undo();
    expect((om.getById('b_4') as BuildingObject).height).toBe(40);
    expect(om.getById('b_1')).toBeUndefined(); // Still deleted

    // Undo 2: Reverses Step 2 (b1, b2, b3 restored)
    history.undo();
    expect(om.getById('b_1')).toBeDefined();
    expect(om.getById('b_2')).toBeDefined();
    expect(om.getById('b_3')).toBeDefined();
    expect(om.getById('road_10')).toBeDefined(); // Road still exists

    // Undo 3: Reverses Step 1 (road is removed)
    history.undo();
    expect(om.getById('road_10')).toBeUndefined();
    expect(om.getById('b_1')).toBeDefined();
    expect(om.getById('b_4')).toBeDefined();

    // Redo 3x reconstructs state
    history.redo(); // Restores road
    expect(om.getById('road_10')).toBeDefined();

    history.redo(); // Deletes 3 buildings again
    expect(om.getById('b_1')).toBeUndefined();

    history.redo(); // Restores b4 height 80
    expect((om.getById('b_4') as BuildingObject).height).toBe(80);
  });

  it('5. Respects maximum stack depth of 100 entries', () => {
    const om = new ObjectManager();
    const history = new HistoryManager(om);

    for (let i = 0; i < 115; i++) {
      const road = createMockRoad(`road_${i}`, `Street ${i}`);
      history.recordAdd(road, `Add road ${i}`);
    }

    expect(history.getUndoStackCount()).toBe(100);
  });

  it('6. Supports pure array transformation fallback when ObjectManager is not bound', () => {
    const history = new HistoryManager(); // No ObjectManager bound
    const road = createMockRoad('road_x', 'Detached Road');

    history.recordAdd(road, 'Add detached road');

    const stateBeforeUndo: CityObject[] = [road];
    const afterUndo = history.undo(stateBeforeUndo);
    expect(afterUndo).toEqual([]);

    const afterRedo = history.redo(afterUndo!);
    expect(afterRedo?.length).toBe(1);
    expect(afterRedo?.[0].id).toBe('road_x');
  });

  it('7. Supports backwards-compatible pushState', () => {
    const om = new ObjectManager();
    const history = new HistoryManager(om);

    const b1 = createMockBuilding('b1', 'Building 1');
    history.pushState([b1]);

    const b2 = createMockBuilding('b2', 'Building 2');
    history.pushState([b1, b2]);

    expect(history.canUndo()).toBe(true);
    history.undo();
    expect(history.canRedo()).toBe(true);
  });
});

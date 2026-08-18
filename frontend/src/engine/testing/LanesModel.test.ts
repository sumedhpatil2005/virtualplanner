import { describe, it, expect } from 'vitest';
import type { RoadObject } from '../objects/types';
import { ObjectManager } from '../objects/ObjectManager';
import { TrafficNetworkBuilder } from '../simulation/TrafficNetworkBuilder';
import { EditingEngine } from '../editing/EditingEngine';
import { ProceduralGeometryGenerator } from '../rendering/geometry/ProceduralGeometryGenerator';

describe('Unified Road Lane Model & Systems Integration', () => {
  it('Scenario 1: parses lanes=3 + oneway=yes into 3 forward, 0 backward', async () => {
    const objManager = new ObjectManager();
    const editingEngine = new EditingEngine(objManager, {} as any);

    // Mock overpass response for a one-way 3-lane road
    (editingEngine as any).fetchFromOverpass = async () => ({
      elements: [
        {
          type: 'way',
          id: 101,
          tags: {
            highway: 'primary',
            lanes: '3',
            oneway: 'yes'
          },
          geometry: [
            { lon: 73.8567, lat: 18.5204 },
            { lon: 73.8577, lat: 18.5204 }
          ]
        }
      ]
    });

    const count = await editingEngine.importOSMRoadsInsideArea({
      id: 'area1',
      name: 'Test Area',
      polygonCoordinates: [[73.856, 18.520, 0], [73.858, 18.520, 0], [73.858, 18.521, 0], [73.856, 18.521, 0]],
      minLat: 18.520, maxLat: 18.521, minLon: 73.856, maxLon: 73.858,
      createdAt: ''
    }, 'base');

    expect(count).toBe(1);
    const road = objManager.getById('osm_101') as RoadObject;
    expect(road).toBeDefined();
    expect(road.laneCount).toBe(3);
    expect(road.isOneWay).toBe(true);
    expect(road.sections![0].carriagewayA.lanes).toBe(3);
    expect(road.sections![0].carriagewayB).toBeUndefined();
  });

  it('Scenario 2: parses lanes=4 + oneway=no into 2 forward, 2 backward', async () => {
    const objManager = new ObjectManager();
    const editingEngine = new EditingEngine(objManager, {} as any);

    (editingEngine as any).fetchFromOverpass = async () => ({
      elements: [
        {
          type: 'way',
          id: 102,
          tags: {
            highway: 'primary',
            lanes: '4',
            oneway: 'no'
          },
          geometry: [
            { lon: 73.8567, lat: 18.5204 },
            { lon: 73.8577, lat: 18.5204 }
          ]
        }
      ]
    });

    await editingEngine.importOSMRoadsInsideArea({
      id: 'area1',
      name: 'Test Area',
      polygonCoordinates: [[73.856, 18.520, 0], [73.858, 18.520, 0], [73.858, 18.521, 0], [73.856, 18.521, 0]],
      minLat: 18.520, maxLat: 18.521, minLon: 73.856, maxLon: 73.858,
      createdAt: ''
    }, 'base');

    const road = objManager.getById('osm_102') as RoadObject;
    expect(road).toBeDefined();
    expect(road.laneCount).toBe(4);
    expect(road.isOneWay).toBe(false);
    expect(road.sections![0].carriagewayA.lanes).toBe(2);
    expect(road.sections![0].carriagewayB).toBeDefined();
    expect(road.sections![0].carriagewayB!.lanes).toBe(2);
  });

  it('Scenario 3: parses lanes:forward=3 + lanes:backward=2 into 3 forward, 2 backward', async () => {
    const objManager = new ObjectManager();
    const editingEngine = new EditingEngine(objManager, {} as any);

    (editingEngine as any).fetchFromOverpass = async () => ({
      elements: [
        {
          type: 'way',
          id: 103,
          tags: {
            highway: 'primary',
            'lanes:forward': '3',
            'lanes:backward': '2',
            oneway: 'no'
          },
          geometry: [
            { lon: 73.8567, lat: 18.5204 },
            { lon: 73.8577, lat: 18.5204 }
          ]
        }
      ]
    });

    await editingEngine.importOSMRoadsInsideArea({
      id: 'area1',
      name: 'Test Area',
      polygonCoordinates: [[73.856, 18.520, 0], [73.858, 18.520, 0], [73.858, 18.521, 0], [73.856, 18.521, 0]],
      minLat: 18.520, maxLat: 18.521, minLon: 73.856, maxLon: 73.858,
      createdAt: ''
    }, 'base');

    const road = objManager.getById('osm_103') as RoadObject;
    expect(road).toBeDefined();
    expect(road.laneCount).toBe(5);
    expect(road.isOneWay).toBe(false);
    expect(road.sections![0].carriagewayA.lanes).toBe(3);
    expect(road.sections![0].carriagewayB).toBeDefined();
    expect(road.sections![0].carriagewayB!.lanes).toBe(2);
  });

  it('Scenario 4: parses one-way highway with lanes=4 into 4 forward, 0 backward', async () => {
    const objManager = new ObjectManager();
    const editingEngine = new EditingEngine(objManager, {} as any);

    (editingEngine as any).fetchFromOverpass = async () => ({
      elements: [
        {
          type: 'way',
          id: 104,
          tags: {
            highway: 'motorway',
            lanes: '4',
            oneway: 'yes'
          },
          geometry: [
            { lon: 73.8567, lat: 18.5204 },
            { lon: 73.8577, lat: 18.5204 }
          ]
        }
      ]
    });

    await editingEngine.importOSMRoadsInsideArea({
      id: 'area1',
      name: 'Test Area',
      polygonCoordinates: [[73.856, 18.520, 0], [73.858, 18.520, 0], [73.858, 18.521, 0], [73.856, 18.521, 0]],
      minLat: 18.520, maxLat: 18.521, minLon: 73.856, maxLon: 73.858,
      createdAt: ''
    }, 'base');

    const road = objManager.getById('osm_104') as RoadObject;
    expect(road).toBeDefined();
    expect(road.laneCount).toBe(4);
    expect(road.isOneWay).toBe(true);
    expect(road.sections![0].carriagewayA.lanes).toBe(4);
    expect(road.sections![0].carriagewayB).toBeUndefined();
  });

  it('Scenario 5: UI lane modification synchronizes all fields', () => {
    const objManager = new ObjectManager();
    const testRoad: RoadObject = {
      id: 'test_ui_road',
      type: 'road',
      name: 'Test Road',
      layerId: 'roads',
      scenarioId: 'base',
      coordinates: [[0, 0, 0], [1, 0, 0]],
      roadClass: 'arterial',
      width: 10,
      laneCount: 2,
      laneWidth: 3.5,
      hasDivider: false,
      dividerWidth: 0,
      hasFootpath: false,
      footpathWidth: 0,
      speedLimit: 50,
      isOneWay: false,
      trafficCapacity: 2000,
      connectedJunctions: []
    };

    // 1. Adding a legacy road synthesizes sections
    objManager.add(testRoad);
    let road = objManager.getById('test_ui_road') as RoadObject;
    expect(road.sections).toBeDefined();
    expect(road.sections![0].carriagewayA.lanes).toBe(1);
    expect(road.sections![0].carriagewayB!.lanes).toBe(1);

    // 2. Simulate UI change (change forward to 3 lanes, backward to 2 lanes)
    const sections = JSON.parse(JSON.stringify(road.sections));
    sections[0].carriagewayA.lanes = 3;
    sections[0].carriagewayB.lanes = 2;
    
    objManager.update('test_ui_road', { sections });

    // Verify consistency
    road = objManager.getById('test_ui_road') as RoadObject;
    expect(road.laneCount).toBe(5);
    expect(road.isOneWay).toBe(false);
    expect(road.width).toBeCloseTo(5 * 3.5);
    expect(road.trafficCapacity).toBe(5000);
  });

  it('Scenario 6: save/reload flow preserves exact lane configuration', () => {
    const objManager = new ObjectManager();
    const originalRoad: RoadObject = {
      id: 'test_ui_road2',
      type: 'road',
      name: 'Test Road Reload',
      layerId: 'roads',
      scenarioId: 'base',
      coordinates: [[0, 0, 0], [1, 0, 0]],
      roadClass: 'arterial',
      width: 17.5,
      laneCount: 5,
      laneWidth: 3.5,
      hasDivider: false,
      dividerWidth: 0,
      hasFootpath: false,
      footpathWidth: 0,
      speedLimit: 50,
      isOneWay: false,
      trafficCapacity: 5000,
      connectedJunctions: []
    };
    objManager.add(originalRoad);

    const road = objManager.getById('test_ui_road2') as RoadObject;
    road.sections![0].carriagewayA.lanes = 3;
    road.sections![0].carriagewayB!.lanes = 2;
    objManager.update('test_ui_road2', { sections: road.sections });

    // Map to Schema (what gets serialized to DB json)
    const schema = (objManager as any).mapToSchema(road);

    // Reloading back
    const reloaded = {
      id: schema.id,
      type: schema.type,
      name: schema.name,
      layerId: schema.layerId,
      scenarioId: schema.scenarioId,
      coordinates: schema.coordinates,
      ...schema.properties
    } as RoadObject;

    const objManagerReloaded = new ObjectManager();
    objManagerReloaded.add(reloaded);

    const finalRoad = objManagerReloaded.getById('test_ui_road2') as RoadObject;
    expect(finalRoad.laneCount).toBe(5);
    expect(finalRoad.isOneWay).toBe(false);
    expect(finalRoad.sections![0].carriagewayA.lanes).toBe(3);
    expect(finalRoad.sections![0].carriagewayB!.lanes).toBe(2);
  });

  it('Scenario 7: traffic network edge lanes match road directional lane configuration', () => {
    const objManager = new ObjectManager();
    const road3_2: RoadObject = {
      id: 'road_3_2',
      type: 'road',
      name: 'Road 3-2',
      layerId: 'roads',
      scenarioId: 'base',
      coordinates: [[73.8000, 18.5000, 0], [73.8100, 18.5000, 0]],
      roadClass: 'arterial',
      width: 17.5,
      laneCount: 5,
      laneWidth: 3.5,
      hasDivider: false,
      dividerWidth: 0,
      hasFootpath: false,
      footpathWidth: 0,
      speedLimit: 50,
      isOneWay: false,
      trafficCapacity: 5000,
      connectedJunctions: []
    };
    objManager.add(road3_2);
    
    // Explicitly modify the sections
    const r = objManager.getById('road_3_2') as RoadObject;
    r.sections![0].carriagewayA.lanes = 3;
    r.sections![0].carriagewayB!.lanes = 2;
    objManager.update('road_3_2', { sections: r.sections });

    const builder = new TrafficNetworkBuilder();
    const { network } = builder.build([objManager.getById('road_3_2') as RoadObject]);

    const edgeFwd = network.edges.get('road_3_2_seg_0_fwd');
    const edgeBwd = network.edges.get('road_3_2_seg_0_bwd');

    expect(edgeFwd).toBeDefined();
    expect(edgeFwd!.lanes).toBe(3);
    expect(edgeFwd!.capacity).toBe(3000); // 3/5 of 5000

    expect(edgeBwd).toBeDefined();
    expect(edgeBwd!.lanes).toBe(2);
    expect(edgeBwd!.capacity).toBe(2000); // 2/5 of 5000
  });

  it('Scenario 8: 3D visual geometry offset calculation uses actual carriageway lane configuration', () => {
    const objManager = new ObjectManager();
    const road3_2: RoadObject = {
      id: 'road_3_2',
      type: 'road',
      name: 'Road 3-2',
      layerId: 'roads',
      scenarioId: 'base',
      coordinates: [[0, 0, 0], [1, 0, 0]],
      roadClass: 'arterial',
      width: 17.5,
      laneCount: 5,
      laneWidth: 3.5,
      hasDivider: false,
      dividerWidth: 0,
      hasFootpath: false,
      footpathWidth: 0,
      speedLimit: 50,
      isOneWay: false,
      trafficCapacity: 5000,
      connectedJunctions: []
    };
    objManager.add(road3_2);
    
    const r = objManager.getById('road_3_2') as RoadObject;
    r.sections![0].carriagewayA.lanes = 3;
    r.sections![0].carriagewayB!.lanes = 2;
    objManager.update('road_3_2', { sections: r.sections });

    const generator = new ProceduralGeometryGenerator();
    const offsets = (generator as any).calculateOffsetsForSection(r.sections![0]);

    // Divided/Two-way with B: centerline is median center (0 in this case since hasMedian=false)
    // carriageA_start = -(halfMedian + A.lanes * A.laneWidth) = -(0 + 3 * 3.5) = -10.5
    // carriageA_end = -halfMedian = 0
    // carriageB_start = halfMedian = 0
    // carriageB_end = halfMedian + B.lanes * B.laneWidth = 0 + 2 * 3.5 = 7.0
    
    // So visual width is span between carriageA_start and carriageB_end, which depends on lanes!
    const widthFromLanes = offsets.carriageB[1] - offsets.carriageA[0];
    expect(widthFromLanes).toBe(17.5); // (3 * 3.5) + (2 * 3.5) = 10.5 + 7.0 = 17.5
  });
});

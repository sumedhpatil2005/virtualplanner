import { describe, it, expect } from 'vitest';
import { EditingEngine } from '../editing/EditingEngine';
import { ObjectManager } from '../objects/ObjectManager';
import { HistoryManager } from '../history/HistoryManager';
import { DemandMatrixCompiler } from '../simulation/DemandMatrixCompiler';
import type { TrafficNetwork, TrafficNode, TrafficEdge } from '../objects/trafficTypes';
import type { ZoneObject, GatewayObject, RoadObject, BuildingObject } from '../objects/types';

describe('Zoning and Gateway Planning CAD Workflow', () => {
  // Setup standard mock network: Node_A (73.74, 18.59) -> Node_B (73.75, 18.59)
  const nodes = new Map<string, TrafficNode>();
  const edges = new Map<string, TrafficEdge>();

  nodes.set('node_A', {
    id: 'node_A',
    coordinates: [73.74, 18.59, 0],
    incomingSegments: [],
    outgoingSegments: ['edge_AB'],
    hasSignals: false,
    allowedMovements: []
  });

  nodes.set('node_B', {
    id: 'node_B',
    coordinates: [73.75, 18.59, 0],
    incomingSegments: ['edge_AB'],
    outgoingSegments: [],
    hasSignals: false,
    allowedMovements: []
  });

  edges.set('edge_AB', {
    id: 'edge_AB',
    roadId: 'road_1',
    fromNodeId: 'node_A',
    toNodeId: 'node_B',
    coordinates: [[73.74, 18.59, 0], [73.75, 18.59, 0]],
    length: 1000,
    lanes: 2,
    direction: 'forward',
    speedLimit: 60,
    capacity: 2000
  });

  const mockNetwork: TrafficNetwork = { nodes, edges };

  it('1. Create valid zone polygon and successfully save it', () => {
    const objects = new ObjectManager();
    const history = new HistoryManager();
    const editing = new EditingEngine(objects, history, () => mockNetwork);

    editing.setMode('draw_zone');
    editing.addDrawingPoint([73.738, 18.588, 0]);
    editing.addDrawingPoint([73.746, 18.588, 0]);
    editing.addDrawingPoint([73.746, 18.595, 0]);

    editing.finalizeDrawing('base');

    const all = objects.getAll();
    const zone = all.find(o => o.type === 'zone') as ZoneObject;

    expect(zone).toBeDefined();
    expect(zone.coordinates.length).toBe(4); // Closed loop (4th matches 1st)
    expect(zone.coordinates[0]).toEqual([73.738, 18.588, 0]);
    expect(zone.coordinates[3]).toEqual([73.738, 18.588, 0]);
    expect(zone.totalPopulation).toBe(10000);
    expect(zone.totalEmployment).toBe(5000);
  });

  it('2. Reject invalid zone polygons (too few vertices or self-intersecting)', () => {
    const objects = new ObjectManager();
    const history = new HistoryManager();
    const editing = new EditingEngine(objects, history, () => mockNetwork);

    // Too few vertices
    editing.setMode('draw_zone');
    editing.addDrawingPoint([73.738, 18.588, 0]);
    editing.addDrawingPoint([73.746, 18.588, 0]);
    expect(() => editing.finalizeDrawing('base')).toThrowError("A zone must have at least 3 vertices.");

    // Self-intersecting polygon (bowtie shape)
    editing.clearDrawing();
    editing.addDrawingPoint([0, 0, 0]);
    editing.addDrawingPoint([1, 1, 0]);
    editing.addDrawingPoint([1, 0, 0]);
    editing.addDrawingPoint([0, 1, 0]); // self-intersects
    expect(() => editing.finalizeDrawing('base')).toThrowError("Invalid polygon: The zone boundary cannot self-intersect.");
  });

  it('3. Edit zone boundary coordinates and save update', () => {
    const objects = new ObjectManager();
    const history = new HistoryManager();
    const editing = new EditingEngine(objects, history, () => mockNetwork);

    editing.setMode('draw_zone');
    editing.addDrawingPoint([73.738, 18.588, 0]);
    editing.addDrawingPoint([73.746, 18.588, 0]);
    editing.addDrawingPoint([73.746, 18.595, 0]);
    editing.finalizeDrawing('base');

    const zone = objects.getAll().find(o => o.type === 'zone') as ZoneObject;
    expect(zone).toBeDefined();

    // Edit vertex 1
    const newCoords = [...zone.coordinates];
    newCoords[1] = [73.748, 18.588, 0];
    objects.update(zone.id, { coordinates: newCoords });

    const updated = objects.getById(zone.id) as ZoneObject;
    expect(updated.coordinates[1]).toEqual([73.748, 18.588, 0]);
  });

  it('4. Create gateway and snap to the nearest traffic node', () => {
    const objects = new ObjectManager();
    const history = new HistoryManager();
    const editing = new EditingEngine(objects, history, () => mockNetwork);

    editing.setMode('draw_gateway');
    // Place point close to Node_A (73.74, 18.59)
    editing.addDrawingPoint([73.7402, 18.5901, 0]);
    editing.finalizeDrawing('base');

    const gw = objects.getAll().find(o => o.type === 'gateway') as GatewayObject;
    expect(gw).toBeDefined();
    // Gateway snaps exactly to Node_A's coordinates
    expect(gw.coordinates[0]).toEqual([73.74, 18.59, 0]);
    expect(gw.connectedNodeId).toBe('node_A');
  });

  it('5. Reject gateway placement if placed too far from road network', () => {
    const objects = new ObjectManager();
    const history = new HistoryManager();
    const editing = new EditingEngine(objects, history, () => mockNetwork);

    editing.setMode('draw_gateway');
    // Place far away from Node_A or Node_B
    editing.addDrawingPoint([73.95, 18.75, 0]);
    expect(() => editing.finalizeDrawing('base')).toThrowError("Gateway is too far from the road network. Please place it within 300m of a road.");
  });

  it('6. Ensure DemandMatrixCompiler successfully compiles with new zones/gateways', () => {
    const roads: RoadObject[] = [
      {
        id: 'road_1',
        type: 'road',
        name: 'Hinjawadi Link Road',
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
        createdAt: '',
        updatedAt: ''
      }
    ];

    const buildings: BuildingObject[] = [];

    const zones = [
      {
        id: 'zone_hinjewadi',
        name: 'Hinjewadi Central',
        boundaryPolygon: [
          [73.738, 18.588, 0],
          [73.746, 18.588, 0],
          [73.746, 18.595, 0],
          [73.738, 18.595, 0],
          [73.738, 18.588, 0]
        ] as [number, number, number][],
        totalPopulation: 1000,
        totalEmployment: 800,
        landUseMix: { residential: 50, commercial: 50, industrial: 0, educational: 0 },
        gateways: [],
        provenance: { source: 'estimated', confidence: 0.8, updatedAt: '' }
      }
    ];

    const gateways = [
      {
        id: 'gateway_wakad',
        name: 'Wakad Highway Entry',
        coordinates: [73.751, 18.591, 0],
        connectedNodeId: 'node_B',
        inboundFlows: { AM_Peak: 400, PM_Peak: 200, Midday: 100, Night: 50 },
        outboundFlows: { AM_Peak: 200, PM_Peak: 400, Midday: 100, Night: 50 },
        modeSplit: { car: 0.4, twoWheeler: 0.4, bus: 0.2, metro: 0.0, walking: 0.0, other: 0.0 },
        provenance: { source: 'synthetic', confidence: 0.75, updatedAt: '' }
      }
    ];

    const compiler = new DemandMatrixCompiler();
    const result = compiler.compile(mockNetwork, roads, buildings, zones, gateways, 'base');

    expect(result).toBeDefined();
    expect(result.matrix).toBeDefined();
    expect(result.matrix.trips.length).toBeGreaterThan(0);
  });
});

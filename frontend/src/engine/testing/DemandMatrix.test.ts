import { describe, it, expect } from 'vitest';
import type { RoadObject, BuildingObject } from '../objects/types';
import type { TrafficNetwork, TrafficNode, TrafficEdge } from '../objects/trafficTypes';
import type { DemandZone, ExternalGateway } from '../objects/demandTypes';
import { DemandMatrixCompiler } from '../simulation/DemandMatrixCompiler';
import { Pathfinder } from '../simulation/Pathfinder';

describe('Traffic Demand Planning Matrix Compiler', () => {
  it('Scenario 1: Snaps buildings and gateways, calculates residual math, and routes OD pairs', () => {
    // 1. Construct simple network: Node_A (73.74, 18.59) -> Node_B (73.75, 18.59)
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

    const network: TrafficNetwork = { nodes, edges };

    // 2. Define a RoadObject
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

    // 3. Define a building near Node_A
    const buildings: BuildingObject[] = [
      {
        id: 'building_1',
        type: 'building',
        name: 'Wipro Campus',
        layerId: 'buildings',
        scenarioId: 'base',
        coordinates: [
          [73.7401, 18.5901, 0],
          [73.7403, 18.5901, 0],
          [73.7403, 18.5903, 0],
          [73.7401, 18.5903, 0],
          [73.7401, 18.5901, 0]
        ],
        usageType: 'commercial',
        height: 20,
        floors: 5,
        population: 0,
        parkingSpaces: 100,
        waterDemand: 1000,
        electricityDemand: 500,
        constructionYear: 2020,
        category: 'office',
        employees: 200,
        residents: 0,
        activityProfile: {
          peakArrivalStart: '08:30',
          peakArrivalEnd: '10:00',
          peakDepartureStart: '17:30',
          peakDepartureEnd: '19:30',
          modeSplit: { car: 30, twoWheeler: 40, bus: 30, metro: 0, walk: 0, other: 0 }
        },
        createdAt: '',
        updatedAt: ''
      }
    ];

    // 4. Define a Zone containing the building
    const zones: DemandZone[] = [
      {
        id: 'zone_hinjewadi',
        name: 'Hinjewadi Central',
        boundaryPolygon: [
          [73.738, 18.588, 0],
          [73.746, 18.588, 0],
          [73.746, 18.595, 0],
          [73.738, 18.595, 0],
          [73.738, 18.588, 0]
        ],
        totalPopulation: 1000,
        totalEmployment: 800,
        landUseMix: { residential: 50, commercial: 50, industrial: 0, educational: 0 },
        gateways: [],
        provenance: { source: 'estimated', confidence: 0.8, updatedAt: '' }
      }
    ];

    // 5. Define an External Gateway near Node_B
    const gateways: ExternalGateway[] = [
      {
        id: 'gateway_wakad',
        name: 'Wakad Highway Entry',
        coordinates: [73.751, 18.591, 0],
        connectedNodeId: '',
        inboundFlows: { AM_Peak: 400, PM_Peak: 200, Midday: 100, Night: 50 },
        outboundFlows: { AM_Peak: 200, PM_Peak: 400, Midday: 100, Night: 50 },
        modeSplit: { car: 0.4, twoWheeler: 0.4, bus: 0.2, metro: 0.0, walking: 0.0, other: 0.0 },
        provenance: { source: 'synthetic', confidence: 0.75, updatedAt: '' }
      }
    ];

    const compiler = new DemandMatrixCompiler();
    const result = compiler.compile(network, roads, buildings, zones, gateways, 'base');

    expect(result).toBeDefined();
    expect(result.matrix).toBeDefined();
    expect(result.matrix.trips.length).toBeGreaterThan(0);

    // Test 1: Building snaps to correct edge and access node
    const b = buildings[0];
    expect(b.nearestEdgeId).toBe('edge_AB');
    expect(b.accessNodeId).toBe('node_A');

    // Test 2: Gateway snaps to closest TrafficNode
    const gw = gateways[0];
    expect(gw.connectedNodeId).toBe('node_B');

    // Test 3 & 4: Residual math calculation (employment/population minus explicit buildings)
    // Zone Total employment = 800. Building 1 employees = 200.
    // Residual employment = 800 - 200 = 600.
    // Total residents = 1000. Building residents = 0.
    // Residual residents = 1000 - 0 = 1000.
    expect(result.diagnostics).toContain('Explicit building demand:\n  - Population: 0\n  - Employment: 200');
    expect(result.diagnostics).toContain('Residual zone demand:\n  - Population: 1,000\n  - Employment: 600');

    // Test 5: Dijkstra successfully routes at least one OD pair
    const route = Pathfinder.findPath(network, 'node_A', 'node_B');
    expect(route).toBeDefined();
    expect(route).toEqual(['edge_AB']);
  });
});

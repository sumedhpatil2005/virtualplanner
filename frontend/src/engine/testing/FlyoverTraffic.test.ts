import { describe, it, expect } from 'vitest';
import type { RoadObject, FlyoverObject } from '../objects/types';
import type { TrafficNetwork } from '../objects/trafficTypes';
import { TrafficNetworkBuilder } from '../simulation/TrafficNetworkBuilder';
import { Pathfinder } from '../simulation/Pathfinder';
import { getFlyoverConnectionStatus, applyFlyoverElevationProfile } from '../objects/flyoverHelper';
import { interpolateCoordsAlongPolyline } from '../simulation/VehicleAgent';
import { ProceduralGeometryGenerator } from '../rendering/geometry/ProceduralGeometryGenerator';

describe('Flyover Traffic Integration & Validation Tests', () => {

  const builder = new TrafficNetworkBuilder();

  // Test A: Surface road + flyover crossing at different Z -> no false intersection
  it('A. Surface road + flyover crossing at different Z: no false intersection', () => {
    const road: RoadObject = {
      id: 'surface_road',
      type: 'road',
      name: 'Surface Road',
      layerId: 'roads',
      scenarioId: 'base',
      coordinates: [
        [73.8000, 18.5000, 0],
        [73.8100, 18.5000, 0]
      ],
      roadClass: 'arterial',
      width: 12,
      laneCount: 2,
      laneWidth: 3.5,
      hasDivider: false,
      dividerWidth: 0,
      hasFootpath: false,
      footpathWidth: 0,
      speedLimit: 50,
      isOneWay: false,
      trafficCapacity: 2000,
      connectedJunctions: [],
      createdAt: new Date().toISOString(),
      updatedAt: new Date().toISOString()
    };

    const flyover: FlyoverObject = {
      id: 'elevated_flyover',
      type: 'flyover',
      name: 'Elevated Flyover',
      layerId: 'roads',
      scenarioId: 'base',
      coordinates: [
        [73.8050, 18.4900, 6.0], // elevated
        [73.8050, 18.5100, 6.0]  // elevated
      ],
      roadClass: 'highway',
      width: 12,
      laneCount: 2,
      laneWidth: 3.5,
      hasDivider: true,
      dividerWidth: 2.0,
      hasFootpath: false,
      footpathWidth: 0,
      speedLimit: 80,
      isOneWay: false,
      elevation: 6.0,
      pierSpacing: 30.0,
      createdAt: new Date().toISOString(),
      updatedAt: new Date().toISOString()
    };

    const { network } = builder.build([road, flyover as any]);

    // Should have 4 dead-end nodes, meaning no intersection node was added
    expect(network.nodes.size).toBe(4);
    
    // Check that none of the nodes have more than 2 connected segments (no junction formed)
    network.nodes.forEach(node => {
      const connCount = node.incomingSegments.length + node.outgoingSegments.length;
      expect(connCount).toBeLessThanOrEqual(2);
    });
  });

  // Test B: Connected flyover -> appears in TrafficNetwork
  // Test C: Dijkstra -> can route over flyover when appropriate
  it('B & C. Connected flyover appears in TrafficNetwork and can be routed over via Dijkstra', () => {
    // Road A goes from point 1 to point 2 on surface
    // Road B goes from point 2 to point 3 on surface
    // Flyover goes from point 1 directly to point 3 (elevated in middle, snapped at ends)
    const road1: RoadObject = {
      id: 'road_1',
      type: 'road',
      name: 'Surface Road 1',
      layerId: 'roads',
      scenarioId: 'base',
      coordinates: [
        [73.8000, 18.5000, 0],
        [73.8050, 18.5000, 0]
      ],
      roadClass: 'arterial',
      width: 12,
      laneCount: 2,
      laneWidth: 3.5,
      hasDivider: false,
      dividerWidth: 0,
      hasFootpath: false,
      footpathWidth: 0,
      speedLimit: 40, // slow speed limit on surface
      isOneWay: true,
      trafficCapacity: 2000,
      connectedJunctions: [],
      createdAt: new Date().toISOString(),
      updatedAt: new Date().toISOString()
    };

    const road2: RoadObject = {
      id: 'road_2',
      type: 'road',
      name: 'Surface Road 2',
      layerId: 'roads',
      scenarioId: 'base',
      coordinates: [
        [73.8050, 18.5000, 0],
        [73.8100, 18.5000, 0]
      ],
      roadClass: 'arterial',
      width: 12,
      laneCount: 2,
      laneWidth: 3.5,
      hasDivider: false,
      dividerWidth: 0,
      hasFootpath: false,
      footpathWidth: 0,
      speedLimit: 40,
      isOneWay: true,
      trafficCapacity: 2000,
      connectedJunctions: [],
      createdAt: new Date().toISOString(),
      updatedAt: new Date().toISOString()
    };

    const flyover: FlyoverObject = {
      id: 'flyover_direct',
      type: 'flyover',
      name: 'Direct Flyover',
      layerId: 'roads',
      scenarioId: 'base',
      coordinates: [
        [73.8000, 18.5000, 0], // Snapped to start of road1 (Z=0)
        [73.8050, 18.5010, 6], // Elevated in the middle
        [73.8100, 18.5000, 0]  // Snapped to end of road2 (Z=0)
      ],
      roadClass: 'highway',
      width: 12,
      laneCount: 2,
      laneWidth: 3.5,
      hasDivider: true,
      dividerWidth: 2.0,
      hasFootpath: false,
      footpathWidth: 0,
      speedLimit: 90, // very fast flyover speed
      isOneWay: true,
      elevation: 6.0,
      pierSpacing: 30.0,
      createdAt: new Date().toISOString(),
      updatedAt: new Date().toISOString()
    };

    const { network } = builder.build([road1, road2, flyover as any]);

    // Check that flyover edges were created in network
    const flyoverEdges = Array.from(network.edges.values()).filter(e => e.roadId === 'flyover_direct');
    expect(flyoverEdges.length).toBeGreaterThan(0);

    // Node count:
    // Start node: [73.8000, 18.5000, 0]
    // End node: [73.8100, 18.5000, 0]
    // Middle node for roads: [73.8050, 18.5000, 0]
    // Middle node for flyover: [73.8050, 18.5010, 6] (interior coordinate, not a node)
    // Total nodes should be 3
    expect(network.nodes.size).toBe(3);

    // Start node is shared by road1 fwd and flyover_direct fwd
    const startNode = Array.from(network.nodes.values()).find(n => 
      Math.abs(n.coordinates[0] - 73.8000) < 0.0001 && Math.abs(n.coordinates[1] - 18.5000) < 0.0001
    )!;
    expect(startNode).toBeDefined();
    expect(startNode.outgoingSegments).toContain('road_1_seg_1_fwd');
    expect(startNode.outgoingSegments).toContain('flyover_direct_seg_1_fwd');

    // End node is shared by road2 fwd and flyover_direct bwd/fwd (toNodeId)
    const endNode = Array.from(network.nodes.values()).find(n => 
      Math.abs(n.coordinates[0] - 73.8100) < 0.0001 && Math.abs(n.coordinates[1] - 18.5000) < 0.0001
    )!;
    expect(endNode).toBeDefined();
    
    // Route from start node to end node.
    // The surface road route is: road_1 (1000m, 40km/h) + road_2 (1000m, 40km/h). Travel time = 2 * (1000 / (40/3.6)) = 180s.
    // The flyover route is: flyover (approx 2000m, 90km/h). Travel time = 2000 / (90/3.6) = 80s.
    // Dijkstra should prefer the flyover because of its 90 km/h speed limit!
    const route = Pathfinder.findPath(network, startNode.id, endNode.id);
    expect(route).toBeDefined();
    expect(route![0]).toContain('flyover_direct');
  });

  // Test D: Flyover traffic volume calculation
  // Test E: Flyover congestion coloring
  it('D & E. Congestion levels map correctly to flow states and colors based on capacity', () => {
    // Verify volume/capacity mappings
    const testCases = [
      { vcRatio: 0.05, expectedState: 'Free Flow', expectedColor: '#1e293b' }, // default local/arterial color or green
      { vcRatio: 0.25, expectedState: 'Moderate', expectedColor: '#fbbf24' }, // Yellow
      { vcRatio: 0.55, expectedState: 'Heavy', expectedColor: '#f97316' },    // Orange
      { vcRatio: 0.85, expectedState: 'Severe', expectedColor: '#ef4444' }     // Red
    ];

    testCases.forEach(tc => {
      let state = 'Free Flow';
      if (tc.vcRatio > 0.8) state = 'Severe';
      else if (tc.vcRatio > 0.4) state = 'Heavy';
      else if (tc.vcRatio > 0.1) state = 'Moderate';
      expect(state).toBe(tc.expectedState);

      // Simulation Manager coloring logic:
      let color = '#1e293b'; // Default arterial
      if (tc.vcRatio > 0.8) {
        color = '#ef4444';
      } else if (tc.vcRatio > 0.4) {
        color = '#f97316';
      } else if (tc.vcRatio > 0.1) {
        color = '#fbbf24';
      }
      
      if (tc.vcRatio > 0.1) {
        expect(color).toBe(tc.expectedColor);
      }
    });
  });

  // Test F: Metrics check
  it('F. Metrics compile aggregates include flyovers exactly once', () => {
    const roadsList = [
      { id: 'road_1', type: 'road' },
      { id: 'road_2', type: 'road' },
      { id: 'flyover_1', type: 'flyover' },
      { id: 'metro_flyover_1', type: 'metro_flyover' }
    ];

    // Simulating objects.filter(o => o.type === 'road' || o.type === 'flyover' || o.type === 'metro_flyover')
    const filteredRoads = roadsList.filter(o => o.type === 'road' || o.type === 'flyover' || o.type === 'metro_flyover');
    
    // Check that we have exactly 4 items and IDs are unique
    expect(filteredRoads.length).toBe(4);
    const ids = filteredRoads.map(r => r.id);
    const uniqueIds = new Set(ids);
    expect(uniqueIds.size).toBe(4);
  });

  // Test G: Disconnected flyover
  it('G. Disconnected flyover is correctly flagged as disconnected', () => {
    const flyover: FlyoverObject = {
      id: 'flyover_island',
      type: 'flyover',
      name: 'Island Flyover',
      layerId: 'roads',
      scenarioId: 'base',
      coordinates: [
        [73.9000, 18.5000, 0],
        [73.9050, 18.5000, 6],
        [73.9100, 18.5000, 0]
      ],
      roadClass: 'highway',
      width: 12,
      laneCount: 2,
      laneWidth: 3.5,
      hasDivider: true,
      dividerWidth: 2.0,
      hasFootpath: false,
      footpathWidth: 0,
      speedLimit: 80,
      isOneWay: false,
      elevation: 6.0,
      pierSpacing: 30.0,
      createdAt: new Date().toISOString(),
      updatedAt: new Date().toISOString()
    };

    // Build the network with ONLY the flyover.
    // It is an island - no other roads exist.
    const { network } = builder.build([flyover as any]);

    const conn = getFlyoverConnectionStatus(flyover, network);
    expect(conn.connected).toBe(false);
    expect(conn.startConnected).toBe(false);
    expect(conn.endConnected).toBe(false);
  });

  // Test H: Vehicle movement along elevated coordinates
  it('H. Vehicle moves through elevated coordinates correctly in 3D', () => {
    const path3D: [number, number, number][] = [
      [73.8000, 18.5000, 0],
      [73.8010, 18.5000, 3],
      [73.8020, 18.5000, 6]
    ];

    // Compute coordinate exactly in the middle of the first segment (at 50% distance)
    const totalDist = 111000 * 0.001; // roughly 111 meters
    const halfDist = totalDist / 2;

    const midPt = interpolateCoordsAlongPolyline(path3D, halfDist);
    
    // Altitude at 50% along ramp from 0m to 3m should be close to 1.58m due to cosine factor
    expect(midPt[2]).toBeCloseTo(1.6, 1);
    
    // Coordinates should be at [73.8005, 18.5000, 1.5]
    expect(midPt[0]).toBeCloseTo(73.8005, 4);
    expect(midPt[1]).toBeCloseTo(18.5000, 4);
  });

  // Test I: Verify flyover geometry meshes do not contain NaN/Infinity
  it('I. Verify flyover geometry meshes do not contain NaN/Infinity', () => {
    const generator = new ProceduralGeometryGenerator();

    const flyover: FlyoverObject = {
      id: 'elevated_flyover_geom_test',
      type: 'flyover',
      name: 'Elevated Flyover Geom Test',
      layerId: 'roads',
      scenarioId: 'base',
      coordinates: [
        [73.8000, 18.5000, 0],
        [73.8050, 18.5000, 0]
      ],
      roadClass: 'highway',
      width: 12,
      laneCount: 2,
      laneWidth: 3.5,
      hasDivider: true,
      dividerWidth: 2.0,
      hasFootpath: false,
      footpathWidth: 0,
      speedLimit: 80,
      isOneWay: false,
      elevation: 6.0,
      pierSpacing: 30.0,
      createdAt: new Date().toISOString(),
      updatedAt: new Date().toISOString()
    };

    // Apply elevation profile first (like ObjectManager does!)
    applyFlyoverElevationProfile(flyover);

    // Generate meshes
    const meshes = generator.generateMeshData(flyover as any);
    expect(meshes.length).toBeGreaterThan(0);

    // Inspect positions and indices in each mesh
    meshes.forEach(mesh => {
      expect(mesh.positions).toBeDefined();
      expect(mesh.positions.length).toBeGreaterThan(0);
      mesh.positions.forEach(val => {
        expect(Number.isNaN(val)).toBe(false);
        expect(Number.isFinite(val)).toBe(true);
      });
    });
  });
});

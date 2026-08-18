import { describe, it, expect } from 'vitest';
import type { RoadObject } from '../objects/types';
import { TrafficNetworkBuilder } from '../simulation/TrafficNetworkBuilder';

describe('TrafficNetworkBuilder Topology Compiler', () => {
  const builder = new TrafficNetworkBuilder();

  it('detects a simple spatial T-junction between two roads within tolerance', () => {
    // Road A goes East-West
    const roadA: RoadObject = {
      id: 'road_A',
      type: 'road',
      name: 'Main Street East-West',
      layerId: 'roads',
      scenarioId: 'base',
      coordinates: [
        [73.8000, 18.5000, 0],
        [73.8100, 18.5000, 0]
      ],
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
      connectedJunctions: [],
      createdAt: new Date().toISOString(),
      updatedAt: new Date().toISOString()
    };

    // Road B runs South-North and terminates near Road A's center (73.8050, 18.5000)
    // Note: B's endpoint is slightly offset by 0.00002 degrees (~2 meters) to test spatial tolerance!
    const roadB: RoadObject = {
      id: 'road_B',
      type: 'road',
      name: 'South Avenue',
      layerId: 'roads',
      scenarioId: 'base',
      coordinates: [
        [73.8050, 18.4900, 0],
        [73.8050, 18.49998, 0] // 0.00002 off from 18.5000
      ],
      roadClass: 'local',
      width: 8,
      laneCount: 2,
      laneWidth: 3.5,
      hasDivider: false,
      dividerWidth: 0,
      hasFootpath: false,
      footpathWidth: 0,
      speedLimit: 40,
      isOneWay: false,
      trafficCapacity: 1500,
      connectedJunctions: [],
      createdAt: new Date().toISOString(),
      updatedAt: new Date().toISOString()
    };

    const { network, diagnostics } = builder.build([roadA, roadB]);

    // Expect 4 total nodes (3 dead-ends + 1 junction)
    expect(network.nodes.size).toBe(4);

    // Filter to find actual junction nodes (more than 2 connected fwd/bwd edges)
    const junctionNodes = Array.from(network.nodes.values()).filter(
      n => n.incomingSegments.length + n.outgoingSegments.length > 2
    );
    expect(junctionNodes.length).toBe(1);

    // Expect Road A to be split in two segments (East-West), plus Road B (South-North)
    // Since roads are two-way, fwd and bwd edges are created:
    // Road A split into 2 segments -> 4 edges (2 fwd, 2 bwd)
    // Road B -> 2 edges (1 fwd, 1 bwd)
    // Total = 6 edges
    expect(network.edges.size).toBe(6);

    const node = junctionNodes[0];
    expect(node.coordinates[0]).toBeCloseTo(73.8050, 4);
    expect(node.coordinates[1]).toBeCloseTo(18.5000, 4);

    expect(diagnostics).toContain('Total Detected Junctions (Nodes): 4');
    expect(diagnostics).toContain('Total Traffic Edges Generated: 6');
  });

  it('excludes grade-separated crossings (different layer tags)', () => {
    // Surface Road A (layer = 0)
    const roadA: RoadObject = {
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
      connectedJunctions: [],
      createdAt: new Date().toISOString(),
      updatedAt: new Date().toISOString(),
      osmProvenance: {
        osmId: 101,
        originalTags: {},
        layer: 0,
        bridge: false,
        tunnel: false,
        roundabout: false
      }
    };

    // Elevated Flyover B (layer = 1) crossing Road A
    const roadB: RoadObject = {
      id: 'elevated_flyover',
      type: 'road',
      name: 'Elevated Flyover',
      layerId: 'roads',
      scenarioId: 'base',
      coordinates: [
        [73.8050, 18.4900, 6], // 6m high
        [73.8050, 18.5100, 6]
      ],
      roadClass: 'highway',
      width: 12,
      laneCount: 4,
      laneWidth: 3.5,
      hasDivider: true,
      dividerWidth: 2,
      hasFootpath: false,
      footpathWidth: 0,
      speedLimit: 80,
      isOneWay: false,
      trafficCapacity: 4000,
      connectedJunctions: [],
      createdAt: new Date().toISOString(),
      updatedAt: new Date().toISOString(),
      osmProvenance: {
        osmId: 102,
        originalTags: { bridge: 'yes', layer: '1' },
        layer: 1,
        bridge: true,
        tunnel: false,
        roundabout: false
      }
    };

    const { network, diagnostics } = builder.build([roadA, roadB]);

    // Should NOT detect any intersection/junction (only 4 boundary dead-end nodes)
    expect(network.nodes.size).toBe(4);

    const junctionNodes = Array.from(network.nodes.values()).filter(
      n => n.incomingSegments.length + n.outgoingSegments.length > 2
    );
    expect(junctionNodes.length).toBe(0);

    // Road A undivided two-way -> 2 edges
    // Road B divided two-way -> 2 edges
    // Total = 4 edges
    expect(network.edges.size).toBe(4);
    expect(diagnostics).toContain('Detected Bridge/Tunnel Crossings: 1');
  });

  it('supports roundabouts and segments their connections correctly', () => {
    // Circular roundabout way
    const roundabout: RoadObject = {
      id: 'roundabout',
      type: 'road',
      name: 'Circular Roundabout',
      layerId: 'roads',
      scenarioId: 'base',
      coordinates: [
        [73.8040, 18.5000, 0],
        [73.8050, 18.5010, 0],
        [73.8060, 18.5000, 0],
        [73.8050, 18.4990, 0],
        [73.8040, 18.5000, 0] // closed loop
      ],
      roadClass: 'collector',
      width: 8,
      laneCount: 2,
      laneWidth: 3.5,
      hasDivider: false,
      dividerWidth: 0,
      hasFootpath: false,
      footpathWidth: 0,
      speedLimit: 30,
      isOneWay: true, // Roundabouts are one-way loops
      trafficCapacity: 2000,
      connectedJunctions: [],
      createdAt: new Date().toISOString(),
      updatedAt: new Date().toISOString(),
      osmProvenance: {
        osmId: 201,
        originalTags: { junction: 'roundabout', oneway: 'yes' },
        layer: 0,
        bridge: false,
        tunnel: false,
        roundabout: true
      }
    };

    // Incoming radial road merging at (73.8040, 18.5000)
    const incomingRoad: RoadObject = {
      id: 'radial_road',
      type: 'road',
      name: 'Access Road',
      layerId: 'roads',
      scenarioId: 'base',
      coordinates: [
        [73.7990, 18.5000, 0],
        [73.80395, 18.5000, 0] // touches roundabout within tolerance
      ],
      roadClass: 'local',
      width: 6,
      laneCount: 2,
      laneWidth: 3.0,
      hasDivider: false,
      dividerWidth: 0,
      hasFootpath: false,
      footpathWidth: 0,
      speedLimit: 40,
      isOneWay: false,
      trafficCapacity: 1200,
      connectedJunctions: [],
      createdAt: new Date().toISOString(),
      updatedAt: new Date().toISOString()
    };

    const { network, diagnostics } = builder.build([roundabout, incomingRoad]);
    console.log("ROUNDABOUT DIAGNOSTICS:", diagnostics);

    // Expect 2 total nodes (roundabout junction + radial road dead-end)
    expect(network.nodes.size).toBe(2);

    const junctionNodes = Array.from(network.nodes.values()).filter(
      n => n.incomingSegments.length + n.outgoingSegments.length > 2
    );
    expect(junctionNodes.length).toBe(1);

    const node = junctionNodes[0];
    expect(node.coordinates[0]).toBeCloseTo(73.8040, 4);
    expect(node.coordinates[1]).toBeCloseTo(18.5000, 4);
  });
});

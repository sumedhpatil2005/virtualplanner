import { describe, it, expect } from 'vitest';
import type { TrafficNetwork, TrafficNode, TrafficEdge } from '../objects/trafficTypes';
import { Pathfinder } from '../simulation/Pathfinder';

describe('Pathfinder Dijkstra Routing Compiler', () => {
  it('Scenario 1: resolves shortest travel-time path on a simple 3-node network', () => {
    // Construct a simple linear graph A -> B -> C
    const nodes = new Map<string, TrafficNode>();
    const edges = new Map<string, TrafficEdge>();

    nodes.set('node_A', {
      id: 'node_A',
      coordinates: [73.85, 18.52, 0],
      incomingSegments: [],
      outgoingSegments: ['edge_AB'],
      hasSignals: false,
      allowedMovements: []
    });

    nodes.set('node_B', {
      id: 'node_B',
      coordinates: [73.86, 18.52, 0],
      incomingSegments: ['edge_AB'],
      outgoingSegments: ['edge_BC'],
      hasSignals: false,
      allowedMovements: []
    });

    nodes.set('node_C', {
      id: 'node_C',
      coordinates: [73.87, 18.52, 0],
      incomingSegments: ['edge_BC'],
      outgoingSegments: [],
      hasSignals: false,
      allowedMovements: []
    });

    // Speed limits: edge_AB is fast (100 km/h), edge_BC is slow (30 km/h)
    edges.set('edge_AB', {
      id: 'edge_AB',
      roadId: 'road_1',
      fromNodeId: 'node_A',
      toNodeId: 'node_B',
      coordinates: [[73.85, 18.52, 0], [73.86, 18.52, 0]],
      length: 1000,
      lanes: 2,
      direction: 'forward',
      speedLimit: 100,
      capacity: 2000
    });

    edges.set('edge_BC', {
      id: 'edge_BC',
      roadId: 'road_2',
      fromNodeId: 'node_B',
      toNodeId: 'node_C',
      coordinates: [[73.86, 18.52, 0], [73.87, 18.52, 0]],
      length: 1000,
      lanes: 2,
      direction: 'forward',
      speedLimit: 30,
      capacity: 2000
    });

    const network: TrafficNetwork = { nodes, edges };

    const route = Pathfinder.findPath(network, 'node_A', 'node_C');
    expect(route).toBeDefined();
    expect(route).toEqual(['edge_AB', 'edge_BC']);
  });

  it('Scenario 2: returns null when start/end nodes are disconnected', () => {
    const nodes = new Map<string, TrafficNode>();
    const edges = new Map<string, TrafficEdge>();

    nodes.set('node_A', {
      id: 'node_A',
      coordinates: [73.85, 18.52, 0],
      incomingSegments: [],
      outgoingSegments: [],
      hasSignals: false,
      allowedMovements: []
    });

    nodes.set('node_B', {
      id: 'node_B',
      coordinates: [73.86, 18.52, 0],
      incomingSegments: [],
      outgoingSegments: [],
      hasSignals: false,
      allowedMovements: []
    });

    const network: TrafficNetwork = { nodes, edges };

    const route = Pathfinder.findPath(network, 'node_A', 'node_B');
    expect(route).toBeNull();
  });

  it('Scenario 3: returns empty array when start and end node are identical', () => {
    const nodes = new Map<string, TrafficNode>();
    const edges = new Map<string, TrafficEdge>();

    nodes.set('node_A', {
      id: 'node_A',
      coordinates: [73.85, 18.52, 0],
      incomingSegments: [],
      outgoingSegments: [],
      hasSignals: false,
      allowedMovements: []
    });

    const network: TrafficNetwork = { nodes, edges };

    const route = Pathfinder.findPath(network, 'node_A', 'node_A');
    expect(route).toEqual([]);
  });
});

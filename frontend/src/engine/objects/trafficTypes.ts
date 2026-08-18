

export type TurnDirection = 'left' | 'straight' | 'right' | 'u_turn';

export interface TurnMovement {
  fromSegmentId: string;
  toSegmentId: string;
  allowed: boolean;
  direction: TurnDirection;
}

export interface TrafficNode {
  id: string; // unique ID based on intersection coordinates
  coordinates: [number, number, number]; // [longitude, latitude, elevation]
  incomingSegments: string[]; // TrafficEdge IDs
  outgoingSegments: string[]; // TrafficEdge IDs
  hasSignals: boolean;
  signalTiming?: number; // Cycle timing in seconds
  allowedMovements: TurnMovement[];
}

export interface TrafficEdge {
  id: string; // segment ID: e.g. "roadId_segmentIdx"
  roadId: string; // Parent RoadObject ID
  fromNodeId: string; // TrafficNode ID
  toNodeId: string; // TrafficNode ID
  coordinates: [number, number, number][]; // Sub-polyline coordinates
  length: number; // calculated geodesic distance in meters
  lanes: number;
  direction: 'forward' | 'backward' | 'both';
  speedLimit: number; // km/h
  capacity: number; // vehicles per hour
}

export interface TrafficNetwork {
  nodes: Map<string, TrafficNode>;
  edges: Map<string, TrafficEdge>;
}

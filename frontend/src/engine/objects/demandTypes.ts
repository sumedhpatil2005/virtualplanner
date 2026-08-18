export type TransportMode = 'car' | 'two_wheeler' | 'bus' | 'metro' | 'walking' | 'other';
export type TimePeriod = 'AM_Peak' | 'PM_Peak' | 'Midday' | 'Night';
export type DemandSourceType = 'estimated' | 'synthetic' | 'observed' | 'survey';

export interface ModeSplit {
  car: number;        // fractional (0.0 to 1.0)
  twoWheeler: number;
  bus: number;
  metro: number;
  walking: number;
  other: number;
}

export interface DemandProvenance {
  source: DemandSourceType;
  confidence: number; // 0.0 to 1.0
  updatedAt: string;
}

export interface ExternalGateway {
  id: string; // unique ID e.g., "gateway_wakad_nh48"
  name: string; // human readable name
  coordinates: [number, number, number]; // [lon, lat, alt]
  connectedNodeId: string; // TrafficNode ID on the network boundary
  inboundFlows: Record<TimePeriod, number>; // vehicles/trips per hour entering
  outboundFlows: Record<TimePeriod, number>; // vehicles/trips per hour leaving
  modeSplit: ModeSplit;
  provenance: DemandProvenance;
}

export interface DemandZone {
  id: string; // references AreaObject ID
  name: string;
  boundaryPolygon: [number, number, number][]; // footprint coordinates
  totalPopulation: number; // overall residents in zone
  totalEmployment: number; // overall employees in zone
  landUseMix: {
    residential: number; // percentage (0 to 100)
    commercial: number;
    industrial: number;
    educational: number;
  };
  gateways: string[]; // ExternalGateway IDs inside/adjacent to the zone
  provenance: DemandProvenance;
}

export interface BuildingDemandProfile {
  buildingId: string;
  nearestEdgeId: string; // snapped TrafficEdge ID for access
  accessNodeId: string; // snapped TrafficNode ID
  modeSplit: ModeSplit;
  provenance: DemandProvenance;
}

export interface ODTrip {
  id: string; // unique ID: e.g. "originId_destId_time_mode"
  originId: string; // DemandZone ID, Building ID, or ExternalGateway ID
  originType: 'zone' | 'building' | 'gateway';
  destinationId: string; // DemandZone ID, Building ID, or ExternalGateway ID
  destinationType: 'zone' | 'building' | 'gateway';
  timePeriod: TimePeriod;
  mode: TransportMode;
  tripsCount: number; // Number of trips/hour
  provenance: DemandProvenance;
}

export interface TrafficDemandMatrix {
  scenarioId: string;
  trips: ODTrip[];
}

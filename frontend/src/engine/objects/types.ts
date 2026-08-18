export type CityObjectType = 'road' | 'building' | 'junction' | 'flyover' | 'utility' | 'metro_line' | 'metro_station' | 'zone' | 'gateway' | 'metro_flyover';

export interface BaseCityObject {
  id: string;
  type: CityObjectType;
  name: string;
  layerId: string;
  scenarioId: string;
  createdAt: string;
  updatedAt: string;
}

export type RoadClassification = 'highway' | 'arterial' | 'collector' | 'local';
export type TrafficDirection = 'forward' | 'backward' | 'both';
export type ReserveType = 'future_widening' | 'utility_corridor' | 'drainage' | 'green_buffer' | 'setback' | 'unknown';
export type MeasurementSource = 'OSM' | 'satellite' | 'municipal' | 'manual' | 'surveyed';
export type MeasurementConfidence = 'unknown' | 'estimated' | 'verified' | 'surveyed';
export type InfrastructureState = 'existing' | 'proposed';

export interface RoadsideProfile {
  footpathWidth: number;
  cycleTrackWidth: number;
  vergeWidth: number;
  parkingWidth: number;
  drainageWidth: number;
}

export interface CarriagewayProfile {
  direction: TrafficDirection;
  lanes: number;
  laneWidth: number;
  leftRoadside: RoadsideProfile;
  rightRoadside: RoadsideProfile;
}

export interface ReservedSpace {
  type: ReserveType;
  width: number;
  side: 'left' | 'right';
  status: InfrastructureState;
}

export interface ProvenanceMetadata {
  originalSource: MeasurementSource;
  originalConfidence: MeasurementConfidence;
  geometryModified: boolean;
  profileModified: boolean;
  lastModifiedBy: 'importer' | 'manual';
  verificationStatus: 'unverified' | 'verified' | 'surveyed';
}

export interface OSMProvenance {
  osmId: number;
  originalTags: Record<string, string>;
  layer: number;
  bridge: boolean;
  tunnel: boolean;
  roundabout: boolean;
}

export interface RoadSectionProfile {
  startNodeIndex: number;
  endNodeIndex: number;
  totalRowWidth: number;
  wideningPossible: boolean;
  hasMedian: boolean;
  medianWidth: number;
  carriagewayA: CarriagewayProfile;
  carriagewayB?: CarriagewayProfile;
  reservedSpaces: ReservedSpace[];
  provenance: ProvenanceMetadata;
}

export interface RoadObject extends BaseCityObject {
  type: 'road';
  coordinates: [number, number, number][]; // Array of [longitude, latitude, elevation]
  sourceCoordinates?: [number, number, number][];
  sections?: RoadSectionProfile[];
  
  // Legacy fallback fields for compatibility
  roadClass: RoadClassification;
  width: number; // overall width in meters
  laneCount: number;
  laneWidth: number; // width per lane in meters
  hasDivider: boolean;
  dividerWidth: number; // width of center divider in meters
  hasFootpath: boolean;
  footpathWidth: number; // width of footpaths on each side in meters
  speedLimit: number; // km/h
  isOneWay: boolean;
  trafficCapacity: number; // vehicles per hour
  connectedJunctions: string[]; // junction object IDs
  
  // Provenance details
  osmProvenance?: OSMProvenance;
}

export type BuildingUsage = 'residential' | 'commercial' | 'industrial' | 'educational' | 'institutional' | 'mixed';

export type BuildingCategory =
  | 'residential'
  | 'office'
  | 'IT'
  | 'commercial'
  | 'retail'
  | 'industrial'
  | 'hospital'
  | 'school'
  | 'college'
  | 'hotel'
  | 'government'
  | 'mixed_use'
  | 'other';

export type BuildingState = 'existing' | 'under_construction' | 'proposed';

export interface BuildingActivityProfile {
  peakArrivalStart?: string;
  peakArrivalEnd?: string;
  peakDepartureStart?: string;
  peakDepartureEnd?: string;
  modeSplit?: {
    car?: number;
    twoWheeler?: number;
    bus?: number;
    metro?: number;
    walk?: number;
    other?: number;
  };
  tripGeneration?: {
    dailyTrips?: number;
    amPeakTrips?: number;
    pmPeakTrips?: number;
  };
}

export interface BuildingAccessPoints {
  mainEntrance?: [number, number, number];
  vehicleEntrance?: [number, number, number];
  serviceEntrance?: [number, number, number];
}

export interface BuildingObject extends BaseCityObject {
  type: 'building';
  coordinates: [number, number, number][]; // Polygon outer boundary [longitude, latitude, elevation]
  usageType: BuildingUsage;
  height: number; // meters
  floors: number;
  population: number;
  parkingSpaces: number;
  waterDemand: number; // Liters/day
  electricityDemand: number; // kWh/day
  constructionYear: number;

  // New persistent building planning properties
  category?: BuildingCategory;
  state?: BuildingState;
  
  // Specific capacity metrics (optional based on category)
  residents?: number;
  employees?: number;
  students?: number;
  patients?: number;
  visitorsPerDay?: number;
  parkingCapacity?: number;
  notes?: string;

  // OSM Provenance details
  osmId?: number;
  originalOsmTags?: Record<string, string>;
  source?: 'OSM' | 'manual' | 'municipal' | 'surveyed';
  originalFootprint?: [number, number, number][];
  isManuallyEdited?: boolean;

  // Traffic / Activity profiles
  activityProfile?: BuildingActivityProfile;

  // Connection points to road network
  accessPoints?: BuildingAccessPoints;
  nearestEdgeId?: string;
  accessNodeId?: string;
}

export interface JunctionObject extends BaseCityObject {
  type: 'junction';
  coordinates: [number, number, number]; // [longitude, latitude, elevation]
  connectedRoads: string[]; // Road object IDs
  hasSignals: boolean;
  signalTiming: number; // cycle length in seconds
  hasPedestrianCrossing: boolean;
}

export interface FlyoverObject extends BaseCityObject {
  type: 'flyover';
  coordinates: [number, number, number][]; // Path of flyover
  roadClass: RoadClassification;
  width: number; // overall width in meters
  laneCount: number;
  laneWidth: number;
  hasDivider: boolean;
  dividerWidth: number;
  hasFootpath: boolean;
  footpathWidth: number;
  speedLimit: number;
  isOneWay: boolean;
  elevation: number; // base height of deck above terrain in meters (e.g. 6)
  pierSpacing: number; // spacing between support columns in meters (e.g. 30)
  groundCoordinates?: [number, number, number][];
}

export interface MetroLineObject extends BaseCityObject {
  type: 'metro_line';
  coordinates: [number, number, number][]; // Path of elevated rail tracks
  trackCount: number; // e.g. 1 or 2
  trackGauge: number; // in meters (default 1.435)
  deckWidth: number; // overall width in meters (e.g. 8.0)
  elevation: number; // height of track deck above terrain (e.g. 12)
  pierSpacing: number; // column spacing (default 30)
  status?: 'operational' | 'under_construction';
  tags?: Record<string, string>;
}

export interface MetroStationObject extends BaseCityObject {
  type: 'metro_station';
  coordinates: [number, number, number]; // Location [longitude, latitude, elevation]
  stationName: string;
  length: number; // in meters (default 140)
  width: number; // in meters (default 20)
  height: number; // in meters (default 8)
  elevation: number; // platform floor level above ground (e.g. 12)
  capacity: number; // passenger capacity
}

export type UtilityType = 'water' | 'electricity' | 'sewage' | 'gas' | 'fiber';

export interface UtilityObject extends BaseCityObject {
  type: 'utility';
  coordinates: [number, number, number][]; // Path or line of utility piping/cables
  utilityType: UtilityType;
  depth: number; // meters below ground
  capacity: number; // capacity units
}

export interface MetroFlyoverObject extends BaseCityObject {
  type: 'metro_flyover';
  coordinates: [number, number, number][]; // Path of double-decker corridor
  roadClass: RoadClassification;
  width: number; // overall width of flyover deck (e.g. 19)
  laneCount: number;
  laneWidth: number;
  hasDivider: boolean;
  dividerWidth: number;
  hasFootpath: boolean;
  footpathWidth: number;
  speedLimit: number;
  isOneWay: boolean;
  elevation: number; // middle deck height above ground (e.g. 6)
  metroElevation: number; // top deck height above ground (e.g. 12)
  pierSpacing: number; // central column spacing (e.g. 30)
  groundCoordinates?: [number, number, number][];
}

export type CityObject = RoadObject | BuildingObject | JunctionObject | FlyoverObject | UtilityObject | MetroLineObject | MetroStationObject | ZoneObject | GatewayObject | MetroFlyoverObject;

export interface ZoneObject extends BaseCityObject {
  type: 'zone';
  coordinates: [number, number, number][]; // Boundary polygon coordinates
  totalPopulation: number;
  totalEmployment: number;
  landUseMix: {
    residential: number; // percentage (0 to 100)
    commercial: number;
    industrial: number;
    educational: number;
  };
  gateways: string[]; // Associated Gateway IDs
  provenance: {
    source: 'estimated' | 'synthetic' | 'observed' | 'survey';
    confidence: number;
    updatedAt: string;
  };
}

export interface GatewayObject extends BaseCityObject {
  type: 'gateway';
  coordinates: [number, number, number][]; // Single gateway coordinate: [[lon, lat, alt]]
  connectedNodeId: string;
  inboundFlows: Record<string, number>; // TimePeriod -> flow (vehicles/hr)
  outboundFlows: Record<string, number>;
  modeSplit: {
    car: number;
    twoWheeler: number;
    bus: number;
    metro: number;
    walking: number;
    other: number;
  };
  provenance: {
    source: 'estimated' | 'synthetic' | 'observed' | 'survey';
    confidence: number;
    updatedAt: string;
  };
}

export interface Area {
  id: string;
  name: string;
  polygonCoordinates: [number, number, number][]; // Array of [longitude, latitude, elevation]
  minLat: number;
  maxLat: number;
  minLon: number;
  maxLon: number;
  createdAt: string;
}

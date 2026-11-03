import type { BuildingObject, JunctionObject } from '../objects/types';
import type { DemandZone, ExternalGateway, ModeSplit, TimePeriod } from '../objects/demandTypes';
import type { TrafficNetwork } from '../objects/trafficTypes';
import type { MicroDemandTrip, VehicleKind } from './TrafficMicroSim';
import { resolveBuildingTripEvents, hasTripOverrides } from './modeSplit';
import { PUNE_TRIP_RATES, vehicleTripsByClass } from './tripRates';
import type { Bounds } from './StudyAreaExplorer';

export interface SimulationContext {
  scenarioId?: string;
  junctions?: JunctionObject[];
  buildings?: BuildingObject[];
  zones?: DemandZone[];
  gateways?: ExternalGateway[];
  period?: TimePeriod;
}
export interface DemandProvenance {
  /** project-estimate: heuristic gravity demand; synthetic: capacity-based; calibrated: either, scaled to observed counts. */
  source: 'project-estimate' | 'synthetic' | 'calibrated';
  label: string;
  period: TimePeriod;
  vehiclesPerHour: number;
  pairCount: number;
}
export interface DemandPlan {
  provenance: DemandProvenance;
  /** Coordinates keep the same OD demand when a road edit changes network node IDs. */
  trips: {
    from: [number, number, number]; to: [number, number, number]; vehiclesPerHour: number; kind: VehicleKind; viaRoadId?: string;
    /** Links (simulator link ids) the trip must use in this order: a count-seeded trip's stop-line approach and exit. */
    viaLinkIds?: string[];
  }[];
}
const DEFAULT_SPLIT: ModeSplit = { car: .25, twoWheeler: .35, bus: .2, metro: .1, walking: .08, other: .02 };
const centroid = (points: [number, number, number][]): [number, number, number] => points.length
  ? [points.reduce((n, p) => n + p[0], 0) / points.length, points.reduce((n, p) => n + p[1], 0) / points.length, points.reduce((n, p) => n + p[2], 0) / points.length] : [0, 0, 0];
const inside = (p: [number, number, number], polygon: [number, number, number][]) => {
  let result = false;
  for (let i = 0, j = polygon.length - 1; i < polygon.length; j = i++) {
    const a = polygon[i], b = polygon[j];
    if ((a[1] > p[1]) !== (b[1] > p[1]) && p[0] < (b[0] - a[0]) * (p[1] - a[1]) / (b[1] - a[1]) + a[0]) result = !result;
  }
  return result;
};
const distance = (a: readonly number[], b: readonly number[]) => Math.hypot((a[0] - b[0]) * 111320 * Math.cos(a[1] * Math.PI / 180), (a[1] - b[1]) * 111320);

/** Employees' daily motorised trips: the model's 1.5 trips per employee, at PCMC's motorised share of all trips (CMP 2018 Table 6). */
const EMPLOYEE_MOTORISED_DAILY = 1.5 * PUNE_TRIP_RATES.motorisedTripsPerResident / PUNE_TRIP_RATES.allTripsPerResident;

/** Vehicles per class for person trips under an explicit (user or gateway) mode split. */
function vehiclesFromSplit(personTrips: number, split: ModeSplit): [VehicleKind, number][] {
  const occ = PUNE_TRIP_RATES.occupancy;
  return [['two_wheeler', personTrips * split.twoWheeler / occ.two_wheeler!], ['car', personTrips * split.car / occ.car!],
    ['bus', personTrips * split.bus / occ.bus!], ['auto', personTrips * split.other / occ.auto!]];
}

/**
 * Peak-hour vehicle OD demand for a study area from its buildings, residual
 * zones and gateways (activity model as in DemandMatrixCompiler), using real
 * Pune rates (tripRates.ts): motorised trips per resident, the peak-hour share
 * of daily traffic, the PCMC motorised mode split and vehicle occupancy.
 * Buildings with their own Activity Profile keep the user's trip numbers and
 * split (as person trips, divided by occupancy). Gateway flows are vehicles.
 */
export function compileStudyDemand(context: SimulationContext, bounds?: Bounds): DemandPlan | null {
  const period = context.period ?? 'AM_Peak';
  type Endpoint = { id: string; point: [number, number, number]; flow: number; vehicles: [VehicleKind, number][] };
  const origins: Endpoint[] = [], destinations: Endpoint[] = [];
  const add = (role: 'origin' | 'destination', id: string, point: [number, number, number], vehicles: [VehicleKind, number][]) => {
    const flow = vehicles.reduce((n, [, v]) => n + v, 0);
    if (flow > 0 && Number.isFinite(flow)) (role === 'origin' ? origins : destinations).push({ id, point, flow, vehicles });
  };
  const peak = period === 'AM_Peak' || period === 'PM_Peak';
  const share = PUNE_TRIP_RATES.peakHourShare;
  /** Residents leave in the AM peak and return in the PM peak; jobs the reverse. */
  const addActivity = (id: string, point: [number, number, number], residents: number, employees: number) => {
    if (!peak) return;
    const home = vehicleTripsByClass(residents * PUNE_TRIP_RATES.motorisedTripsPerResident * share);
    const work = vehicleTripsByClass(employees * EMPLOYEE_MOTORISED_DAILY * share);
    add(period === 'AM_Peak' ? 'origin' : 'destination', id, point, home);
    add(period === 'AM_Peak' ? 'destination' : 'origin', id, point, work);
  };
  const inBounds = (p: readonly number[]) => !bounds || (p[0] >= bounds.minLng && p[0] <= bounds.maxLng && p[1] >= bounds.minLat && p[1] <= bounds.maxLat);
  const buildings = (context.buildings ?? []).filter(b => b.coordinates.length && inBounds(centroid(b.coordinates)));
  for (const b of buildings) {
    if (!b.coordinates.length) continue;
    const point = b.accessPoints?.vehicleEntrance ?? b.accessPoints?.mainEntrance ?? centroid(b.coordinates);
    if (!hasTripOverrides(b)) {
      addActivity(b.id, point, Math.max(0, b.residents ?? 0), Math.max(0, b.employees ?? 0));
      continue;
    }
    for (const event of resolveBuildingTripEvents(b, DEFAULT_SPLIT)) {
      if (event.period === period) add(event.role, b.id, point, vehiclesFromSplit(event.trips, event.modeSplit));
    }
  }
  for (const z of context.zones ?? []) {
    if (!z.boundaryPolygon.length) continue;
    const clipped = bounds ? clipPolygon(z.boundaryPolygon, bounds) : z.boundaryPolygon;
    const fraction = Math.min(1, polygonArea(clipped) / Math.max(1e-20, polygonArea(z.boundaryPolygon)));
    if (fraction <= 0) continue;
    // Residual totals are calculated against all modelled buildings, then apportioned by overlap.
    const contained = (context.buildings ?? []).filter(b => b.coordinates.length && inside(centroid(b.coordinates), z.boundaryPolygon));
    const population = Math.max(0, z.totalPopulation - contained.reduce((n, b) => n + (b.residents ?? 0), 0)) * fraction;
    const employment = Math.max(0, z.totalEmployment - contained.reduce((n, b) => n + (b.employees ?? 0), 0)) * fraction;
    addActivity(z.id, centroid(clipped), population, employment);
  }
  for (const g of context.gateways ?? []) {
    if (!inBounds(g.coordinates)) continue;
    // Gateway flows are vehicles per hour; the split is read as a vehicle mix ("other" = autos)
    const mix = (vph: number): [VehicleKind, number][] => [['two_wheeler', vph * g.modeSplit.twoWheeler], ['car', vph * g.modeSplit.car], ['bus', vph * g.modeSplit.bus], ['auto', vph * g.modeSplit.other]];
    add('origin', g.id, g.coordinates, mix(g.inboundFlows[period]));
    add('destination', g.id, g.coordinates, mix(g.outboundFlows[period]));
  }
  if (!origins.length && !destinations.length) return null;
  const trips: DemandPlan['trips'] = [];
  for (const origin of origins) {
    // Bound OD storage for dense imports; retain the strongest local gravity destinations.
    const options = destinations.filter(d => d.id !== origin.id).map(d => ({ d, weight: d.flow / Math.max(100, distance(origin.point, d.point)) ** 2 })).sort((a, b) => b.weight - a.weight).slice(0, 32);
    const sum = options.reduce((n, d) => n + d.weight, 0);
    if (sum <= 0) continue;
    for (const { d, weight } of options) {
      for (const [kind, vph] of origin.vehicles) {
        const vehiclesPerHour = vph * weight / sum;
        if (vehiclesPerHour > 0) trips.push({ from: [...origin.point], to: [...d.point], vehiclesPerHour, kind });
      }
    }
  }
  return { trips, provenance: { source: 'project-estimate', label: 'Local gravity estimate from study-area buildings, zones and gateways, at real Pune rates (PCMC motorised trips per person, 7.8% peak-hour share, PCMC mode split and occupancy; CMP 2018/2008); up to 32 destinations per origin. Not measured traffic counts.',
    period, vehiclesPerHour: trips.reduce((n, t) => n + t.vehiclesPerHour, 0), pairCount: trips.length } };
}

export function snapDemandPlan(plan: DemandPlan, network: TrafficNetwork, maxAccessDistanceM = 250, includedSegments?: ReadonlySet<string>): MicroDemandTrip[] {
  const cache = new Map<string, string>();
  const allowed = includedSegments ? new Set([...network.edges.values()].filter(e => includedSegments.has(e.id.replace(/_(fwd|bwd)$/, ''))).flatMap(e => [e.fromNodeId, e.toNodeId])) : null;
  const nearest = (point: readonly number[]) => {
    const key = point.join(',');
    if (cache.has(key)) return cache.get(key)!;
    let id = '', best = maxAccessDistanceM;
    for (const node of network.nodes.values()) {
      if (allowed && !allowed.has(node.id)) continue;
      // Demand attaches to the ground network, never to a flyover passing above a building.
      if (Math.abs((node.coordinates[2] || 0) - (point[2] || 0)) > 3) continue;
      const d = distance(point, node.coordinates);
      if (d < best) { best = d; id = node.id; }
    }
    cache.set(key, id);
    return id;
  };
  return plan.trips.map(t => ({ fromNodeId: nearest(t.from), toNodeId: nearest(t.to), vehiclesPerHour: t.vehiclesPerHour, kind: t.kind, viaRoadId: t.viaRoadId, ...(t.viaLinkIds ? { viaLinkIds: t.viaLinkIds } : {}) }));
}

function polygonArea(points: readonly (readonly number[])[]): number {
  return Math.abs(points.reduce((sum, p, i) => { const q = points[(i + 1) % points.length]; return sum + p[0] * q[1] - q[0] * p[1]; }, 0)) / 2;
}

/** Clip residual-zone geometry to the study rectangle without moving distant demand into the area. */
function clipPolygon(polygon: [number, number, number][], bounds: Bounds): [number, number, number][] {
  let points = polygon;
  for (const [axis, edge, sign] of [[0, bounds.minLng, 1], [0, bounds.maxLng, -1], [1, bounds.minLat, 1], [1, bounds.maxLat, -1]]) {
    const output: [number, number, number][] = [];
    for (let i = 0; i < points.length; i++) {
      const a = points[i], b = points[(i + 1) % points.length];
      const aIn = (a[axis] - edge) * sign >= 0, bIn = (b[axis] - edge) * sign >= 0;
      if (aIn) output.push(a);
      if (aIn !== bIn) {
        const t = (edge - a[axis]) / (b[axis] - a[axis]);
        output.push([a[0] + t * (b[0] - a[0]), a[1] + t * (b[1] - a[1]), a[2] + t * (b[2] - a[2])]);
      }
    }
    points = output;
    if (!points.length) break;
  }
  return points;
}

export function demandContextKey(context: SimulationContext): string {
  return contentKey({ period: context.period ?? 'AM_Peak',
    buildings: context.buildings?.map(b => ({ id: b.id, coordinates: b.coordinates, accessPoints: b.accessPoints, residents: b.residents, employees: b.employees, events: resolveBuildingTripEvents(b, DEFAULT_SPLIT) })),
    zones: context.zones?.map(z => ({ id: z.id, polygon: z.boundaryPolygon, population: z.totalPopulation, employment: z.totalEmployment })),
    gateways: context.gateways?.map(g => ({ id: g.id, coordinates: g.coordinates, inbound: g.inboundFlows, outbound: g.outboundFlows, modeSplit: g.modeSplit })) });
}

export function contentKey(value: unknown): string {
  const text = JSON.stringify(value);
  let hash = 2166136261;
  for (let i = 0; i < text.length; i++) hash = Math.imul(hash ^ text.charCodeAt(i), 16777619);
  return (hash >>> 0).toString(16);
}

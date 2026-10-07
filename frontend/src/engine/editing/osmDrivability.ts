import type { CityObject, RoadObject } from '../objects/types';

/**
 * Which OSM ways are roads that motor vehicles use, for the road importer.
 *
 * An allowlist: footways, paths, cycleways, steps, busways, roads under
 * construction and any unfamiliar highway value are left out, so nothing
 * unknown is routed as a car road. Tracks are kept only when tagged to allow
 * motor vehicles.
 */

/** highway=* values that are roads for general motor traffic. */
const VEHICLE_HIGHWAYS = new Set([
  'motorway', 'motorway_link',
  'trunk', 'trunk_link',
  'primary', 'primary_link',
  'secondary', 'secondary_link',
  'tertiary', 'tertiary_link',
  'unclassified', 'residential', 'living_street', 'service',
  'road', // road of unknown class, still a road
]);

/** Access values under which the public may drive a track. */
const PUBLIC_MOTOR_ACCESS = new Set(['yes', 'designated', 'permissive', 'destination']);

export type OsmWayTags = Record<string, string | undefined>;

export type OsmRoadDecision =
  | { include: true }
  | { include: false; reason: string };

/**
 * Motor-vehicle access from the most specific tag present
 * (motor_vehicle, then vehicle, then access), or undefined if none is set.
 * Only the first of several `;`-separated values is used.
 */
export function motorVehicleAccess(tags: OsmWayTags): string | undefined {
  for (const key of ['motor_vehicle', 'vehicle', 'access']) {
    const value = tags[key]?.split(';')[0].trim().toLowerCase();
    if (value) return value;
  }
  return undefined;
}

/** Whether an OSM way should be imported as a vehicle road, and why not. */
export function classifyOsmWay(tags: OsmWayTags): OsmRoadDecision {
  const highway = tags.highway?.trim().toLowerCase();
  if (!highway) return { include: false, reason: 'no highway tag' };
  if (tags.area === 'yes') return { include: false, reason: `highway=${highway} mapped as an area` };

  const access = motorVehicleAccess(tags);
  if (highway === 'track') {
    return access && PUBLIC_MOTOR_ACCESS.has(access)
      ? { include: true }
      : { include: false, reason: 'track not tagged open to motor vehicles' };
  }
  if (!VEHICLE_HIGHWAYS.has(highway)) {
    return { include: false, reason: `highway=${highway} is not a vehicle road` };
  }
  if (access === 'no') {
    return { include: false, reason: `highway=${highway} closed to motor vehicles` };
  }
  return { include: true };
}

export interface NonDrivableRoad {
  road: RoadObject;
  reason: string;
}

/**
 * OSM-imported roads that the importer would now leave out. Only roads carrying
 * their original OSM tags are judged: hand-drawn roads, flyovers and roads
 * without a recorded highway tag are never selected.
 */
export function findNonDrivableOsmRoads(objects: readonly CityObject[]): NonDrivableRoad[] {
  const found: NonDrivableRoad[] = [];
  for (const o of objects) {
    if (o.type !== 'road') continue;
    const tags = o.osmProvenance?.originalTags;
    if (!tags?.highway) continue;
    const decision = classifyOsmWay(tags);
    if (!decision.include) found.push({ road: o, reason: decision.reason });
  }
  return found;
}

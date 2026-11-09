import type { CityObject, JunctionObject, RoadObject } from '../objects/types';
import type { ObjectManager } from '../objects/ObjectManager';
import type { HistoryManager } from '../history/HistoryManager';
import type { DrivableObject } from '../simulation/StudyAreaExplorer';
import { isDrivable } from '../simulation/StudyAreaExplorer';
import { TrafficNetworkBuilder } from '../simulation/TrafficNetworkBuilder';
import { groupJunctions, junctionNear, junctionsOfRoad, type LogicalJunction } from '../simulation/junctionGroups';
import { cycleOf, junctionEditObjectId, type JunctionEditSpec } from '../simulation/junctionControl';
import type { TrafficNetwork } from '../objects/trafficTypes';

/**
 * Build: finding the logical junction of an imported road network around a
 * point or a road, and applying a whole-junction edit as one Undo step
 * (docs/OVERHAUL.md §23).
 */

const M_PER_DEG_LAT = 111320;
/** Roads within this distance of the point are compiled to find the junction (m). */
const LOCAL_RADIUS_M = 350;
/** Signals loaded for a study area serve a junction's local grouping only when its whole radius lies inside the area (§26). */
export const LOCAL_SIGNAL_MARGIN_M = LOCAL_RADIUS_M + 50;

/** Whether the bounds hold every point within marginM of `at`. */
export function boundsCover(b: { minLng: number; maxLng: number; minLat: number; maxLat: number }, at: readonly number[], marginM: number): boolean {
  const kx = M_PER_DEG_LAT * Math.cos(at[1] * Math.PI / 180);
  return (at[0] - b.minLng) * kx >= marginM && (b.maxLng - at[0]) * kx >= marginM && (at[1] - b.minLat) * M_PER_DEG_LAT >= marginM && (b.maxLat - at[1]) * M_PER_DEG_LAT >= marginM;
}

export interface LocalJunctions {
  network: TrafficNetwork;
  junctions: LogicalJunction[];
  roads: Map<string, DrivableObject>;
}

/** The logical junctions around a point, from the roads near it (a small network, compiled on the spot). */
export function junctionsAround(objects: readonly CityObject[], at: readonly number[], signalPoints?: readonly (readonly [number, number])[], radiusM = LOCAL_RADIUS_M): LocalJunctions {
  const kx = M_PER_DEG_LAT * Math.cos(at[1] * Math.PI / 180);
  const near = (c: readonly number[]) => Math.abs((c[0] - at[0]) * kx) < radiusM && Math.abs((c[1] - at[1]) * M_PER_DEG_LAT) < radiusM;
  const roads = objects.filter((o): o is DrivableObject => isDrivable(o) && o.coordinates.some(near));
  const { network } = new TrafficNetworkBuilder().build(roads as RoadObject[]);
  const map = new Map(roads.map(r => [r.id, r]));
  // Junctions whose nodes are well inside the compiled roads (their arms are complete)
  const junctions = groupJunctions(network, map, { signalPoints, near: { lng: at[0], lat: at[1], radiusM: radiusM - 150 } });
  return { network, junctions, roads: map };
}

/** The junction at a point (within maxM of a member node or its centre). */
export function junctionAt(objects: readonly CityObject[], at: readonly number[], signalPoints?: readonly (readonly [number, number])[], maxM = 40): { junction: LogicalJunction; local: LocalJunctions } | null {
  const local = junctionsAround(objects, at, signalPoints);
  const junction = junctionNear(local.junctions.filter(j => j.nodeIds.length > 1 || j.approaches.length + j.exits.length >= 3), local.network, at, maxM);
  return junction ? { junction, local } : null;
}

/**
 * The junction a selected road belongs to: one with a piece of the road inside
 * it first (an internal piece of a big junction), else one the road enters or
 * leaves (the nearest end of the road). Null for a road between junctions far
 * from both ends.
 */
export function junctionOfRoad(objects: readonly CityObject[], road: DrivableObject, signalPoints?: readonly (readonly [number, number])[]): { junction: LogicalJunction; local: LocalJunctions; inside: boolean } | null {
  const cs = road.coordinates;
  const mid = cs[Math.floor(cs.length / 2)];
  const local = junctionsAround(objects, mid, signalPoints, Math.max(LOCAL_RADIUS_M, lengthM(cs) / 2 + 250));
  const inside = junctionsOfRoad(local.junctions, road.id, false).filter(j => j.nodeIds.length > 1);
  if (inside.length) return { junction: inside[0], local, inside: true };
  // A short piece (under 60 m) next to a junction: offer that junction
  if (lengthM(cs) <= 60) {
    const touching = junctionsOfRoad(local.junctions, road.id, true).filter(j => j.nodeIds.length > 1 || j.signalised);
    if (touching.length) return { junction: touching[0], local, inside: false };
  }
  return null;
}

/**
 * Camera framing for an opened junction: the sphere around everything the
 * junction preview draws (member nodes, internal pieces, approach and exit
 * stubs), and the camera distance that keeps it on screen with a margin for
 * the editor panel (a 60 degree field of view needs 2 x radius; 2.6 x leaves room).
 */
export function junctionFrame(points: readonly (readonly number[])[]): { centre: [number, number, number]; radiusM: number; rangeM: number } {
  const pts = points.filter(p => p.length >= 2 && Number.isFinite(p[0]) && Number.isFinite(p[1]));
  if (!pts.length) return { centre: [0, 0, 0], radiusM: 0, rangeM: 0 };
  const lngs = pts.map(p => p[0]), lats = pts.map(p => p[1]);
  const centre: [number, number, number] = [(Math.min(...lngs) + Math.max(...lngs)) / 2, (Math.min(...lats) + Math.max(...lats)) / 2, pts.reduce((n, p) => n + (p[2] || 0), 0) / pts.length];
  const kx = M_PER_DEG_LAT * Math.cos(centre[1] * Math.PI / 180);
  const radiusM = Math.max(...pts.map(p => Math.hypot((p[0] - centre[0]) * kx, (p[1] - centre[1]) * M_PER_DEG_LAT)));
  return { centre, radiusM, rangeM: Math.min(1500, Math.max(FRAME_MIN_RANGE_M, radiusM * FRAME_RANGE_PER_RADIUS)) };
}
export const FRAME_RANGE_PER_RADIUS = 2.6;
export const FRAME_MIN_RANGE_M = 150;

function lengthM(cs: readonly (readonly number[])[]) {
  let n = 0;
  for (let i = 1; i < cs.length; i++) n += Math.hypot((cs[i][0] - cs[i - 1][0]) * M_PER_DEG_LAT * Math.cos(cs[i][1] * Math.PI / 180), (cs[i][1] - cs[i - 1][1]) * M_PER_DEG_LAT);
  return n;
}

/** The scenario object holding a junction edit. */
export function junctionEditObject(spec: JunctionEditSpec, scenarioId: string, centre: readonly number[], now = new Date().toISOString()): JunctionObject {
  return {
    id: junctionEditObjectId(spec.junctionId, scenarioId), type: 'junction', name: spec.label, layerId: 'junctions', scenarioId,
    createdAt: now, updatedAt: now, coordinates: [centre[0], centre[1], 0], connectedRoads: [],
    hasSignals: spec.control === 'signal', signalTiming: spec.control === 'signal' && spec.signal ? cycleOf(spec.signal) : 0, hasPedestrianCrossing: false,
    importedJunction: structuredClone(spec),
  };
}

/** The edit of a junction in force in a scenario (its own, else the base scenario's), or null. */
export function junctionEditOf(objects: ObjectManager, junctionId: string, scenarioId: string): JunctionObject | null {
  for (const sid of [scenarioId, 'base']) {
    const o = objects.getById(junctionEditObjectId(junctionId, sid));
    if (o?.type === 'junction' && o.importedJunction) return o;
  }
  return null;
}

/** Applies a whole-junction edit: one object added or updated, one Undo step. */
export function applyJunctionEdit(objects: ObjectManager, history: HistoryManager, spec: JunctionEditSpec, scenarioId: string, centre: readonly number[]): JunctionObject {
  const next = junctionEditObject(spec, scenarioId, centre);
  const before = objects.getById(next.id);
  if (before) {
    const after = { ...next, createdAt: before.createdAt } as JunctionObject;
    history.recordUpdate(before, after, `Edit junction ${spec.label}`);
    objects.update(next.id, after);
    return after;
  }
  history.recordAdd(next, `Edit junction ${spec.label}`);
  objects.add(next);
  return next;
}

/** Back to the imported junction as OpenStreetMap has it (the edit removed; one Undo step). */
export function removeJunctionEdit(objects: ObjectManager, history: HistoryManager, junctionId: string, scenarioId: string): boolean {
  const o = objects.getById(junctionEditObjectId(junctionId, scenarioId));
  if (!o) return false;
  history.recordDelete(o, `Reset junction ${o.name}`);
  objects.delete(o.id);
  return true;
}

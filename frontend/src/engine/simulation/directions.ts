import type { TrafficNetwork } from '../objects/trafficTypes';
import type { DrivableObject } from './StudyAreaExplorer';
import { isGenericRoadName, roadKeys } from './roadSection';

/**
 * Which way a direction of travel on the selected road goes, in words the
 * user can match to the map: a compass bearing from the geometry, and where
 * a reliable name exists, the road the carriageway leads into.
 *
 * Bearings are degrees clockwise from true north, measured on a local
 * equirectangular projection (east offsets scaled by cos(latitude)), which is
 * exact enough over the few hundred metres of a road section.
 */

type LngLat = readonly number[];

/** Compass bearing (degrees clockwise from north, 0-360) from a to b. */
export function bearingBetween(a: LngLat, b: LngLat): number {
  const dx = (b[0] - a[0]) * Math.cos(a[1] * Math.PI / 180), dy = b[1] - a[1];
  return ((Math.atan2(dx, dy) * 180) / Math.PI + 360) % 360;
}

/** East/north displacement in metres from a to b. */
export function displacementM(a: LngLat, b: LngLat): [number, number] {
  return [(b[0] - a[0]) * 111320 * Math.cos(a[1] * Math.PI / 180), (b[1] - a[1]) * 111320];
}

export const angleDiff = (a: number, b: number) => { const d = Math.abs(a - b) % 360; return d > 180 ? 360 - d : d; };
export const normaliseDeg = (d: number) => ((d % 360) + 360) % 360;

const COMPASS = ['north', 'north-east', 'east', 'south-east', 'south', 'south-west', 'west', 'north-west'] as const;
const COMPASS_SHORT = ['N', 'NE', 'E', 'SE', 'S', 'SW', 'W', 'NW'] as const;
const octant = (deg: number) => Math.round(normaliseDeg(deg) / 45) % 8;
/** The eight-point compass word for a bearing ("north-east"). */
export const compassWord = (deg: number) => COMPASS[octant(deg)];
export const compassShort = (deg: number) => COMPASS_SHORT[octant(deg)];
/** How the analysis text names a direction: "northbound", "towards the north-east". */
export function boundLabel(deg: number) {
  const w = compassWord(deg);
  return w.includes('-') ? `towards the ${w}` : `${w}bound`;
}

/**
 * Rotation (degrees clockwise) of an "up" arrow glyph so it points the way a
 * road with this compass bearing runs on screen, for a camera looking with
 * this heading (radians, Cesium's camera.heading: 0 = looking north,
 * clockwise). Heading 0: a north-east road points up-right (45). Rotated to
 * look east (heading 90): the same road points up-left (-45, i.e. 315).
 */
export function screenArrowDeg(bearingDeg: number, cameraHeadingRad: number): number {
  return normaliseDeg(bearingDeg - (cameraHeadingRad * 180) / Math.PI);
}

/**
 * Overall bearing of a set of directed pieces: the sum of their start-to-end
 * displacements, so a chain of pieces gives the bearing from its first point
 * to its last, and long pieces count more than short kinks.
 */
export function overallBearing(paths: readonly (readonly LngLat[])[]): number {
  let e = 0, n = 0;
  for (const p of paths) {
    if (p.length < 2) continue;
    const [de, dn] = displacementM(p[0], p[p.length - 1]);
    e += de; n += dn;
  }
  return normaliseDeg((Math.atan2(e, n) * 180) / Math.PI);
}

/** A straight-on continuation turns at most this much (degrees) from the carriageway's last heading. */
export const STRAIGHT_ON_DEG = 50;
/** Two straight-on choices this close in angle (degrees) are a fork, with no single road ahead. */
export const FORK_DEG = 15;
/** How far (m) the section's own road, or an unnamed piece, is followed to find the next named road. */
export const LANDMARK_LOOKAHEAD_M = 400;

/** A real name for the road: OSM name (or English name), never an importer placeholder. */
export function reliableRoadName(road: DrivableObject | undefined): string | null {
  if (!road) return null;
  const tags = road.type === 'road' ? road.osmProvenance?.originalTags ?? {} : {};
  for (const n of [road.name, tags['name:en'], tags.name]) if (n && !isGenericRoadName(n) && /[a-z]/i.test(n)) return n.trim();
  return null;
}

/** Name keys (not refs) of a road: a different road can share a national-highway ref with the section. */
export const nameKeys = (road: DrivableObject | undefined) => [...roadKeys(road)].filter(k => k.startsWith('n:'));

const RANK: Record<string, number> = { highway: 4, arterial: 3, collector: 2, local: 1 };
const segKey = (edgeId: string) => edgeId.replace(/_(fwd|bwd)$/, '');

export interface Landmark {
  name: string;
  /** into: the road (or signed destination) the carriageway carries on into; junction: the main road it meets at its end. */
  kind: 'into' | 'junction';
}

/** "towards Jangali Maharaj Road", "to the junction with Veer Santaji Ghorpade Marg". */
export const landmarkPhrase = (l: Landmark) => (l.kind === 'into' ? `towards ${l.name}` : `to the junction with ${l.name}`);

/**
 * Where a carriageway leads, from the network alone. Never guessed: null
 * when nothing below is found, and then only the compass direction is shown.
 *
 * 1. into: from the carriageway's downstream end, go straight on (the
 *    continuation turning at most STRAIGHT_ON_DEG, and no fork of two
 *    differently named roads within FORK_DEG). Pieces of the section's own
 *    roads and unnamed pieces are followed for up to LANDMARK_LOOKAHEAD_M; the
 *    first piece with a real name of another road gives it. A signed OSM
 *    destination on a one-way piece driven into is used first.
 * 2. junction: otherwise, the main road (collector or bigger, real name, not
 *    one of the section's) that meets the carriageway's end node.
 */
export function downstreamLandmark(network: TrafficNetwork, roads: ReadonlyMap<string, DrivableObject>, endEdgeId: string,
  sectionKeys: ReadonlySet<string>, sectionNames: ReadonlySet<string>): Landmark | null {
  const outOf = new Map<string, string[]>();
  const atNode = new Map<string, string[]>();
  for (const e of network.edges.values()) {
    (outOf.get(e.fromNodeId) ?? outOf.set(e.fromNodeId, []).get(e.fromNodeId)!).push(e.id);
    for (const n of [e.fromNodeId, e.toNodeId]) (atNode.get(n) ?? atNode.set(n, []).get(n)!).push(e.id);
  }
  const ownRoad = (road: DrivableObject | undefined) => nameKeys(road).some(k => sectionNames.has(k));
  const end = network.edges.get(endEdgeId);
  if (!end) return null;

  let cur = end;
  let walked = 0;
  const seen = new Set<string>([end.id]);
  while (walked <= LANDMARK_LOOKAHEAD_M) {
    const c = cur.coordinates;
    if (c.length < 2) break;
    const heading = bearingBetween(c[Math.max(0, c.length - 3)], c[c.length - 1]);
    const back = segKey(cur.id);
    const options = (outOf.get(cur.toNodeId) ?? [])
      .map(id => network.edges.get(id)!)
      .filter(e => e && segKey(e.id) !== back && e.coordinates.length >= 2 && !seen.has(e.id))
      .map(e => ({ e, turn: angleDiff(heading, bearingBetween(e.coordinates[0], e.coordinates[Math.min(2, e.coordinates.length - 1)])) }))
      .filter(o => o.turn <= STRAIGHT_ON_DEG)
      .sort((a, b) => a.turn - b.turn);
    if (!options.length) break;
    if (options.length > 1 && options[1].turn - options[0].turn < FORK_DEG) {
      const names = new Set(options.slice(0, 2).map(o => reliableRoadName(roads.get(o.e.roadId))));
      if (names.size > 1) break;
    }
    const next = options[0].e;
    seen.add(next.id);
    const road = roads.get(next.roadId);
    const tags = road?.type === 'road' ? road.osmProvenance?.originalTags ?? {} : {};
    // OSM destination signs apply in a way's drawn direction, so only to one-way pieces driven forwards
    const dest = tags['destination:en'] ?? tags.destination;
    if (dest && road?.isOneWay && next.id.endsWith('_fwd')) {
      const place = dest.split(';').map(x => x.trim()).find(x => x && /[a-z]/i.test(x));
      if (place) return { name: place, kind: 'into' };
    }
    const name = reliableRoadName(road);
    if (name && !sectionKeys.has(segKey(next.id)) && !ownRoad(road)) return { name, kind: 'into' };
    walked += next.length || 0;
    cur = next;
  }

  // The main road met at the carriageway's end
  const met = (atNode.get(end.toNodeId) ?? [])
    .map(id => network.edges.get(id)!)
    .filter(e => e && !sectionKeys.has(segKey(e.id)))
    .map(e => roads.get(e.roadId))
    .filter((r): r is DrivableObject => !!r && !ownRoad(r) && (RANK[r.roadClass ?? 'local'] ?? 1) >= 2 && !!reliableRoadName(r))
    .sort((a, b) => (RANK[b.roadClass ?? 'local'] ?? 1) - (RANK[a.roadClass ?? 'local'] ?? 1));
  return met.length ? { name: reliableRoadName(met[0])!, kind: 'junction' } : null;
}

/** "North-west, towards Jangali Maharaj Road", or just "North-west" without a landmark. */
export function directionTitle(compass: string, towards: Landmark | null) {
  const w = compass;
  const cap = w.charAt(0).toUpperCase() + w.slice(1);
  return towards ? `${cap}, ${landmarkPhrase(towards)}` : cap;
}

/**
 * Compass bearings for the directions of one road, labelled consistently:
 * two directions running opposite ways (within 30 degrees of it) are
 * labelled from their shared axis, so a road at 338/158 degrees reads as one
 * opposite pair (north/south) rather than "north" one way and "south-east"
 * the other when the 8-point rounding falls either side of a boundary.
 */
export function labelBearings(bearings: readonly number[]): number[] {
  if (bearings.length !== 2 || angleDiff(bearings[0], bearings[1]) < 150) return [...bearings];
  const a = bearings[0] * Math.PI / 180, b = (bearings[1] + 180) * Math.PI / 180;
  const axis = normaliseDeg((Math.atan2(Math.sin(a) + Math.sin(b), Math.cos(a) + Math.cos(b)) * 180) / Math.PI);
  return [axis, normaliseDeg(axis + 180)];
}

/** Map and panel colours for each direction of the selected road, in order. */
export const DIRECTION_COLORS = ['#fb923c', '#a78bfa', '#4ade80', '#f472b6'] as const;
export const directionColor = (i: number) => DIRECTION_COLORS[i % DIRECTION_COLORS.length];

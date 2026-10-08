import type { CityObject, RoadObject, RoadSectionProfile } from '../objects/types';
import { JOIN_TOLERANCE_DEG, GRADE_SEPARATION_M } from '../simulation/TrafficNetworkBuilder';

/**
 * Road ends that stop just short of another road, and the edit that joins them.
 *
 * Only ground roads are joined: flyover heights are derived from their ramps,
 * so adding a vertex to one would change its elevation profile.
 */

/** Gaps wider than this are left alone: at that distance they are usually real (a wall, a canal). */
export const MAX_CONNECT_GAP_M = 25;
/** A join point this close to an existing vertex of the other road reuses that vertex. */
const REUSE_VERTEX_M = 1;

export type RoadEnd = 'start' | 'end';

export interface RoadEndGap {
  roadId: string;
  end: RoadEnd;
  /** The road's end point as it was when the gap was found. */
  endPoint: [number, number, number];
  targetRoadId: string;
  /** The point on the other road the end will be joined to. */
  joinPoint: [number, number, number];
  /** Index of an existing vertex of the other road to join at, or null to insert a new one. */
  targetVertex: number | null;
  /** Segment of the other road the join point lies on (vertex inserted after its start). */
  targetSegment: number;
  gapM: number;
}

const M_PER_DEG_LAT = 111320;
const mPerDegLng = (lat: number) => M_PER_DEG_LAT * Math.cos((lat * Math.PI) / 180);

export interface ClosestPoint {
  distM: number;
  segment: number;
  t: number;
  point: [number, number, number];
}

/** Closest point on a polyline to (lng, lat), measured horizontally in metres. */
export function closestPointOnPolyline(lng: number, lat: number, coords: readonly (readonly number[])[]): ClosestPoint {
  const kx = mPerDegLng(lat);
  let best: ClosestPoint = { distM: Infinity, segment: 0, t: 0, point: [coords[0][0], coords[0][1], coords[0][2] || 0] };
  for (let i = 0; i < coords.length - 1; i++) {
    const a = coords[i];
    const b = coords[i + 1];
    const ax = (a[0] - lng) * kx, ay = (a[1] - lat) * M_PER_DEG_LAT;
    const bx = (b[0] - lng) * kx, by = (b[1] - lat) * M_PER_DEG_LAT;
    const dx = bx - ax, dy = by - ay;
    const len2 = dx * dx + dy * dy;
    const t = len2 > 0 ? Math.max(0, Math.min(1, -(ax * dx + ay * dy) / len2)) : 0;
    const d = Math.hypot(ax + t * dx, ay + t * dy);
    if (d < best.distM) {
      best = {
        distM: d,
        segment: i,
        t,
        point: [a[0] + t * (b[0] - a[0]), a[1] + t * (b[1] - a[1]), (a[2] || 0) + t * ((b[2] || 0) - (a[2] || 0))],
      };
    }
  }
  return best;
}

/**
 * Whether the traffic-network builder joins this point to the polyline: it
 * compares distances in degrees, so the check does too.
 */
function builderJoins(pt: readonly number[], coords: readonly (readonly number[])[]): boolean {
  for (let i = 0; i < coords.length - 1; i++) {
    const a = coords[i], b = coords[i + 1];
    const dx = b[0] - a[0], dy = b[1] - a[1];
    const len2 = dx * dx + dy * dy;
    const t = len2 > 0 ? Math.max(0, Math.min(1, ((pt[0] - a[0]) * dx + (pt[1] - a[1]) * dy) / len2)) : 0;
    const d = Math.hypot(pt[0] - (a[0] + t * dx), pt[1] - (a[1] + t * dy));
    const z = (a[2] || 0) + t * ((b[2] || 0) - (a[2] || 0));
    if (d < JOIN_TOLERANCE_DEG && Math.abs((pt[2] || 0) - z) <= GRADE_SEPARATION_M) return true;
  }
  return false;
}

/**
 * Ends of `road` that no other road meets, but where another ground road at
 * the same height passes within MAX_CONNECT_GAP_M.
 */
export function findRoadEndGaps(road: CityObject, others: readonly CityObject[]): RoadEndGap[] {
  if (road.type !== 'road' || road.coordinates.length < 2) return [];
  const candidates = others.filter((o): o is RoadObject => o.type === 'road' && o.id !== road.id && o.coordinates.length >= 2);
  const gaps: RoadEndGap[] = [];

  for (const end of ['start', 'end'] as RoadEnd[]) {
    const endPoint = road.coordinates[end === 'start' ? 0 : road.coordinates.length - 1];
    const z = endPoint[2] || 0;
    // Includes flyovers and metro flyovers: an end resting on one is already joined
    const joined = others.some(o =>
      o.id !== road.id &&
      (o.type === 'road' || o.type === 'flyover' || o.type === 'metro_flyover') &&
      builderJoins(endPoint, o.coordinates)
    );
    if (joined) continue;

    let best: { road: RoadObject; hit: ClosestPoint } | null = null;
    for (const other of candidates) {
      const hit = closestPointOnPolyline(endPoint[0], endPoint[1], other.coordinates);
      if (Math.abs(hit.point[2] - z) > GRADE_SEPARATION_M) continue;
      if (hit.distM <= MAX_CONNECT_GAP_M && (!best || hit.distM < best.hit.distM)) best = { road: other, hit };
    }
    if (!best) continue;

    const { hit } = best;
    const coords = best.road.coordinates;
    // Reuse the nearer end of the hit segment when the join point is right on it
    const lngK = mPerDegLng(hit.point[1]);
    const distTo = (v: readonly number[]) => Math.hypot((v[0] - hit.point[0]) * lngK, (v[1] - hit.point[1]) * M_PER_DEG_LAT);
    const nearIdx = distTo(coords[hit.segment]) <= distTo(coords[hit.segment + 1]) ? hit.segment : hit.segment + 1;
    const targetVertex = distTo(coords[nearIdx]) <= REUSE_VERTEX_M ? nearIdx : null;
    const joinPoint = targetVertex !== null
      ? [coords[targetVertex][0], coords[targetVertex][1], coords[targetVertex][2] || 0] as [number, number, number]
      : hit.point;

    gaps.push({
      roadId: road.id,
      end,
      endPoint: [endPoint[0], endPoint[1], z],
      targetRoadId: best.road.id,
      joinPoint,
      targetVertex,
      targetSegment: hit.segment,
      gapM: hit.distM,
    });
  }
  return gaps;
}

/**
 * Inserts a vertex at `index` (0 = before the first, length = after the last),
 * shifting section vertex ranges so every section still covers the same stretch
 * of road and the new vertex belongs to the section it falls inside.
 */
export function insertRoadVertex(
  road: Pick<RoadObject, 'coordinates' | 'sections'>,
  index: number,
  point: [number, number, number]
): { coordinates: [number, number, number][]; sections: RoadSectionProfile[] | undefined } {
  const n = road.coordinates.length;
  if (index < 0 || index > n) throw new Error(`Vertex index ${index} is outside the road (0-${n}).`);
  const coordinates = [...road.coordinates];
  coordinates.splice(index, 0, point);
  const sections = road.sections?.map(sec => ({
    ...sec,
    // A section starting at the very first vertex keeps it, so a new first vertex joins that section
    startNodeIndex: sec.startNodeIndex > 0 && sec.startNodeIndex >= index ? sec.startNodeIndex + 1 : sec.startNodeIndex,
    // Appending extends the section that ended at the old last vertex
    endNodeIndex: sec.endNodeIndex >= index || (index === n && sec.endNodeIndex === n - 1) ? sec.endNodeIndex + 1 : sec.endNodeIndex,
  }));
  return { coordinates, sections };
}

/** Marks a road's sections as hand-edited geometry. */
export function markGeometryEdited(sections: RoadSectionProfile[] | undefined): RoadSectionProfile[] | undefined {
  return sections?.map(sec => ({
    ...sec,
    provenance: { ...sec.provenance, geometryModified: true, lastModifiedBy: 'manual' as const },
  }));
}

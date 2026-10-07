/**
 * Joins the ends of a new road to the road network.
 *
 * A road the user draws usually stops a few metres short of, or past, the
 * road it is meant to meet. Each end that comes within AUTO_CONNECT_M of
 * another road at the same level is carried onto that road, so the new road
 * is part of the network for routing and simulation from the start.
 */

type Pt = [number, number, number];

/** How far an end may be from a road and still be joined to it (m). */
export const AUTO_CONNECT_M = 25;
/** Ends this close already join (the network builder's tolerance is about 6 m). */
const TOUCHING_M = 0.5;
/** Closer than this, the end point is moved onto the road instead of a short connector being added. */
const MOVE_END_M = 3;
/** Roads further apart vertically pass over each other (matches the network builder). */
const SAME_LEVEL_M = 3;

const M_PER_DEG_LAT = 111320;

export interface ConnectTarget {
  id: string;
  coordinates: readonly (readonly number[])[];
}

/** Nearest point on a polyline to `p`, with its height, in metres. */
function nearestOnPolyline(p: readonly number[], line: readonly (readonly number[])[]) {
  const kx = M_PER_DEG_LAT * Math.cos((p[1] * Math.PI) / 180);
  let best = { distM: Infinity, point: [0, 0, 0] as Pt };
  for (let i = 0; i < line.length - 1; i++) {
    const a = line[i], b = line[i + 1];
    const ax = (a[0] - p[0]) * kx, ay = (a[1] - p[1]) * M_PER_DEG_LAT;
    const bx = (b[0] - p[0]) * kx, by = (b[1] - p[1]) * M_PER_DEG_LAT;
    const dx = bx - ax, dy = by - ay;
    const len2 = dx * dx + dy * dy;
    const t = len2 > 0 ? Math.max(0, Math.min(1, -(ax * dx + ay * dy) / len2)) : 0;
    const d = Math.hypot(ax + t * dx, ay + t * dy);
    if (d < best.distM) {
      best = {
        distM: d,
        point: [a[0] + t * (b[0] - a[0]), a[1] + t * (b[1] - a[1]), (a[2] || 0) + t * ((b[2] || 0) - (a[2] || 0))],
      };
    }
  }
  return best;
}

/**
 * Where an end point should join: the nearest point on another road within
 * reach and at the same level. Null when it already touches a road or none
 * is near.
 */
export interface ConnectOptions {
  /** Roads an end may be joined to (default: any). Others still count when deciding whether the end already joins. */
  canJoin?: (roadId: string) => boolean;
  /** An end with any road this close already joins (m). */
  touchingM?: number;
}

export function connectionFor(end: readonly number[], candidates: Iterable<ConnectTarget>, excludeId?: string, options: ConnectOptions = {}): { point: Pt; roadId: string; distM: number } | null {
  const touching = options.touchingM ?? TOUCHING_M;
  let best: { point: Pt; roadId: string; distM: number } | null = null;
  for (const c of candidates) {
    if (c.id === excludeId || c.coordinates.length < 2) continue;
    const hit = nearestOnPolyline(end, c.coordinates);
    if (Math.abs(hit.point[2] - (end[2] || 0)) > SAME_LEVEL_M) continue;
    if (hit.distM < touching) return null;
    if (options.canJoin && !options.canJoin(c.id)) continue;
    if (hit.distM <= AUTO_CONNECT_M && (!best || hit.distM < best.distM)) best = { point: hit.point, roadId: c.id, distM: hit.distM };
  }
  return best;
}

/**
 * The road's coordinates with each loose end carried onto the nearest road
 * within reach, or null when both ends already join (or nothing is near).
 */
export function connectEnds(coordinates: readonly Pt[], candidates: readonly ConnectTarget[], excludeId?: string, options: ConnectOptions = {}): Pt[] | null {
  if (coordinates.length < 2) return null;
  const out = [...coordinates];
  let changed = false;
  const join = (endIdx: number) => {
    const hit = connectionFor(out[endIdx], candidates, excludeId, options);
    if (!hit) return;
    changed = true;
    if (hit.distM <= MOVE_END_M) {
      out[endIdx] = hit.point;
    } else if (endIdx === 0) {
      out.unshift(hit.point);
    } else {
      out.push(hit.point);
    }
  };
  join(out.length - 1);
  join(0);
  return changed ? out : null;
}

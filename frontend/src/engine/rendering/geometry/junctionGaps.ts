/**
 * Where a road's raised and painted parts (footpaths, kerbs, medians, lane
 * markings) must stop because another road meets or crosses it. Leaving
 * those stretches as plain asphalt gives clean junctions instead of
 * footpaths and lane lines running across the other road.
 *
 * Distances are metres along the road's centre line.
 */

type Pt = readonly number[];
export type Gap = [number, number];

const M_PER_DEG_LAT = 111320;
/** Roads further apart in height than this pass over each other (as the traffic network). */
const SAME_LEVEL_M = 3;
/** Extra clear space on each side of a crossing road (m). */
const CLEARANCE_M = 1.5;

export interface CrossingRoad {
  coordinates: readonly Pt[];
  /** Overall width (m). */
  width: number;
}

/** Local metric frame centred on the path's first point. */
function frame(path: readonly Pt[]) {
  const kx = M_PER_DEG_LAT * Math.cos((path[0][1] * Math.PI) / 180);
  const x0 = path[0][0], y0 = path[0][1];
  return (p: Pt) => [(p[0] - x0) * kx, (p[1] - y0) * M_PER_DEG_LAT] as const;
}

export function pathLength(path: readonly Pt[]): number {
  const xy = frame(path);
  let len = 0;
  for (let i = 1; i < path.length; i++) {
    const [ax, ay] = xy(path[i - 1]);
    const [bx, by] = xy(path[i]);
    len += Math.hypot(bx - ax, by - ay);
  }
  return len;
}

/**
 * Stretches of `path` to keep clear of footpaths and markings: where `other`
 * crosses it, or where one of `other`'s ends lies on it (a T-junction), at
 * the same level, widened by half of `other`'s width plus clearance.
 */
export function crossingGaps(path: readonly Pt[], other: CrossingRoad): Gap[] {
  const xy = frame(path);
  const half = other.width / 2 + CLEARANCE_M;
  const gaps: Gap[] = [];
  const o = other.coordinates.map(xy);
  const oz = other.coordinates.map(p => p[2] || 0);
  let along = 0;
  for (let i = 1; i < path.length; i++) {
    const [ax, ay] = xy(path[i - 1]);
    const [bx, by] = xy(path[i]);
    const dx = bx - ax, dy = by - ay;
    const segLen = Math.hypot(dx, dy);
    if (segLen < 1e-6) continue;
    const za = path[i - 1][2] || 0, zb = path[i][2] || 0;
    const at = (t: number) => along + t * segLen;
    const levelAt = (t: number) => za + t * (zb - za);

    // Crossings with each piece of the other road
    for (let j = 1; j < o.length; j++) {
      const [cx, cy] = o[j - 1];
      const [ex, ey] = o[j];
      const fx = ex - cx, fy = ey - cy;
      const denom = dx * fy - dy * fx;
      if (Math.abs(denom) < 1e-9) continue;
      const t = ((cx - ax) * fy - (cy - ay) * fx) / denom;
      const u = ((cx - ax) * dy - (cy - ay) * dx) / denom;
      if (t < 0 || t > 1 || u < 0 || u > 1) continue;
      if (Math.abs(levelAt(t) - (oz[j - 1] + u * (oz[j] - oz[j - 1]))) > SAME_LEVEL_M) continue;
      // A crossing at an angle needs a longer gap along this road
      const sin = Math.abs(denom) / (segLen * Math.hypot(fx, fy));
      const reach = half / Math.max(sin, 0.35);
      gaps.push([at(t) - reach, at(t) + reach]);
    }

    // The other road's ends lying on this piece (T-junctions)
    for (const k of [0, o.length - 1]) {
      const [px, py] = o[k];
      const t = Math.max(0, Math.min(1, ((px - ax) * dx + (py - ay) * dy) / (segLen * segLen)));
      const d = Math.hypot(ax + t * dx - px, ay + t * dy - py);
      if (d > other.width / 2 + 6 || Math.abs(levelAt(t) - oz[k]) > SAME_LEVEL_M) continue;
      gaps.push([at(t) - half, at(t) + half]);
    }
    along += segLen;
  }

  // This road's own ends on the other road (this road is the stem of a T, or they meet end to end)
  const total = along;
  for (const [end, k] of [[path[0], 0], [path[path.length - 1], 1]] as const) {
    const [px, py] = xy(end);
    for (let j = 1; j < o.length; j++) {
      const [cx, cy] = o[j - 1];
      const [ex, ey] = o[j];
      const fx = ex - cx, fy = ey - cy;
      const len2 = fx * fx + fy * fy;
      const u = len2 > 0 ? Math.max(0, Math.min(1, ((px - cx) * fx + (py - cy) * fy) / len2)) : 0;
      if (Math.hypot(cx + u * fx - px, cy + u * fy - py) > other.width / 2 + 6) continue;
      if (Math.abs((end[2] || 0) - (oz[j - 1] + u * (oz[j] - oz[j - 1]))) > SAME_LEVEL_M) continue;
      gaps.push(k === 0 ? [0, half] : [total - half, total]);
      break;
    }
  }
  return gaps;
}

/** Sorts and joins overlapping gaps, clipped to [0, length]. */
export function mergeGaps(gaps: Gap[], length: number): Gap[] {
  const sorted = gaps
    .map(([a, b]) => [Math.max(0, a), Math.min(length, b)] as Gap)
    .filter(([a, b]) => b > a)
    .sort((p, q) => p[0] - q[0]);
  const out: Gap[] = [];
  for (const g of sorted) {
    const last = out[out.length - 1];
    if (last && g[0] <= last[1]) last[1] = Math.max(last[1], g[1]);
    else out.push([g[0], g[1]]);
  }
  return out;
}

/** The part of `path` between distances d0 and d1 along it. */
export function slicePath<T extends Pt>(path: readonly T[], d0: number, d1: number): number[][] {
  const xy = frame(path);
  const out: number[][] = [];
  const lerp = (a: Pt, b: Pt, t: number) => [a[0] + t * (b[0] - a[0]), a[1] + t * (b[1] - a[1]), (a[2] || 0) + t * ((b[2] || 0) - (a[2] || 0))];
  let along = 0;
  for (let i = 1; i < path.length; i++) {
    const [ax, ay] = xy(path[i - 1]);
    const [bx, by] = xy(path[i]);
    const len = Math.hypot(bx - ax, by - ay);
    const s = along, e = along + len;
    if (e >= d0 && s <= d1 && len > 0) {
      if (out.length === 0) out.push(lerp(path[i - 1], path[i], Math.max(0, (d0 - s) / len)));
      if (e <= d1) out.push([path[i][0], path[i][1], path[i][2] || 0]);
      else {
        out.push(lerp(path[i - 1], path[i], (d1 - s) / len));
        break;
      }
    }
    along = e;
  }
  return out;
}

/** The pieces of `path` outside the gaps, each at least `minLen` long. */
export function piecesBetween<T extends Pt>(path: readonly T[], gaps: Gap[], minLen = 2): number[][][] {
  const length = pathLength(path);
  const merged = mergeGaps(gaps, length);
  const pieces: number[][][] = [];
  let from = 0;
  for (const [a, b] of [...merged, [length, length] as Gap]) {
    if (a - from >= minLen) {
      const piece = slicePath(path, from, a);
      if (piece.length >= 2) pieces.push(piece);
    }
    from = Math.max(from, b);
  }
  return pieces;
}

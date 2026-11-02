/**
 * Clipping map features to a drawn study-area polygon ("Map Selected Area").
 *
 * The polygon may be concave. Its bounding box is only used to fetch data;
 * these functions decide what is kept. Coordinates are [lng, lat, z]; edges
 * are treated as straight lines in lng/lat, which at study-area scale (a few
 * km) is the same as straight on the ground to well under a centimetre.
 *
 * A road crossing the boundary is cut exactly where it meets the boundary.
 * The cut ends are flagged, so later steps can treat them as places where
 * the mapped network continues outside the area (gateway candidates), and so
 * nothing joins two different roads just because both were cut nearby.
 */

export type Pt = [number, number, number];
type Ring = readonly (readonly number[])[];

const EPS = 1e-12;

const closedRing = (ring: Ring): Ring => {
  if (ring.length === 0) return ring;
  const a = ring[0], b = ring[ring.length - 1];
  return a[0] === b[0] && a[1] === b[1] ? ring : [...ring, ring[0]];
};

/** Whether `p` lies on the segment a-b (within floating-point tolerance). */
function onSegment(p: readonly number[], a: readonly number[], b: readonly number[]): boolean {
  const cross = (p[0] - a[0]) * (b[1] - a[1]) - (p[1] - a[1]) * (b[0] - a[0]);
  const scale = Math.max(Math.abs(b[0] - a[0]), Math.abs(b[1] - a[1]), 1e-9);
  if (Math.abs(cross) > 1e-12 * scale) return false;
  return p[0] >= Math.min(a[0], b[0]) - EPS && p[0] <= Math.max(a[0], b[0]) + EPS &&
    p[1] >= Math.min(a[1], b[1]) - EPS && p[1] <= Math.max(a[1], b[1]) + EPS;
}

/** Point in polygon (even-odd rule); points on the boundary count as inside. Works for concave rings. */
export function pointInPolygon(p: readonly number[], polygon: Ring): boolean {
  const ring = closedRing(polygon);
  let inside = false;
  for (let i = 1; i < ring.length; i++) {
    const a = ring[i - 1], b = ring[i];
    if (onSegment(p, a, b)) return true;
    if ((a[1] > p[1]) !== (b[1] > p[1]) && p[0] < ((b[0] - a[0]) * (p[1] - a[1])) / (b[1] - a[1]) + a[0]) inside = !inside;
  }
  return inside;
}

/** Strictly inside: on-boundary points do not count. */
function strictlyInside(p: readonly number[], polygon: Ring): boolean {
  const ring = closedRing(polygon);
  for (let i = 1; i < ring.length; i++) if (onSegment(p, ring[i - 1], ring[i])) return false;
  return pointInPolygon(p, ring);
}

/** Parameters t in (0, 1) at which segment a-b crosses or touches the polygon's edges. */
function boundaryParams(a: readonly number[], b: readonly number[], ring: Ring): number[] {
  const ts: number[] = [];
  const dx = b[0] - a[0], dy = b[1] - a[1];
  for (let i = 1; i < ring.length; i++) {
    const c = ring[i - 1], d = ring[i];
    const ex = d[0] - c[0], ey = d[1] - c[1];
    const denom = dx * ey - dy * ex;
    if (Math.abs(denom) < 1e-20) {
      // Collinear overlap: the segment runs along the boundary. Cut at the overlap ends.
      for (const q of [c, d]) {
        if (onSegment(q, a, b)) {
          const len2 = dx * dx + dy * dy;
          if (len2 > 0) ts.push(((q[0] - a[0]) * dx + (q[1] - a[1]) * dy) / len2);
        }
      }
      continue;
    }
    const t = ((c[0] - a[0]) * ey - (c[1] - a[1]) * ex) / denom;
    const u = ((c[0] - a[0]) * dy - (c[1] - a[1]) * dx) / denom;
    if (t > -1e-12 && t < 1 + 1e-12 && u > -1e-12 && u < 1 + 1e-12) ts.push(Math.min(1, Math.max(0, t)));
  }
  return ts.filter(t => t > 1e-9 && t < 1 - 1e-9);
}

const lerp = (a: readonly number[], b: readonly number[], t: number): Pt =>
  [a[0] + t * (b[0] - a[0]), a[1] + t * (b[1] - a[1]), (a[2] || 0) + t * ((b[2] || 0) - (a[2] || 0))];

export interface ClippedPiece {
  coordinates: Pt[];
  /** For each output vertex, the index of the input vertex it is, or null for a point made by the cut. */
  sourceIndices: (number | null)[];
  /** The road continues outside the polygon past this end (it was cut here, or ends on the boundary mid-road). */
  startCut: boolean;
  endCut: boolean;
}

/**
 * The parts of a polyline inside a (possibly concave) polygon, cut at the
 * boundary. Pieces keep the input's vertices in order; cut points are
 * interpolated (height included). Parts that only touch the boundary, and
 * pieces shorter than `minLengthDeg`, are dropped.
 */
export function clipPolylineToPolygon(coords: readonly (readonly number[])[], polygon: Ring, minLengthDeg = 1e-7): ClippedPiece[] {
  const ring = closedRing(polygon);
  if (coords.length < 2 || ring.length < 4) return [];
  const pieces: ClippedPiece[] = [];
  let current: ClippedPiece | null = null;
  const last = coords.length - 1;

  const push = (p: Pt, src: number | null) => {
    if (!current) return;
    const prev = current.coordinates[current.coordinates.length - 1];
    if (prev && prev[0] === p[0] && prev[1] === p[1]) {
      // Same place: prefer the input vertex over a cut point there
      if (src !== null && current.sourceIndices[current.sourceIndices.length - 1] === null) current.sourceIndices[current.sourceIndices.length - 1] = src;
      return;
    }
    current.coordinates.push(p);
    current.sourceIndices.push(src);
  };
  const close = (cutHere: boolean) => {
    if (!current) return;
    current.endCut = cutHere;
    if (current.coordinates.length >= 2 && lengthDeg(current.coordinates) >= minLengthDeg) pieces.push(current);
    current = null;
  };

  for (let i = 0; i < last; i++) {
    const a = coords[i], b = coords[i + 1];
    const ts = [0, ...boundaryParams(a, b, ring).sort((x, y) => x - y), 1];
    for (let k = 0; k < ts.length - 1; k++) {
      const t0 = ts[k], t1 = ts[k + 1];
      if (t1 - t0 < 1e-12) continue;
      const mid = lerp(a, b, (t0 + t1) / 2);
      const p0 = t0 === 0 ? ([a[0], a[1], a[2] || 0] as Pt) : lerp(a, b, t0);
      const p1 = t1 === 1 ? ([b[0], b[1], b[2] || 0] as Pt) : lerp(a, b, t1);
      if (strictlyInside(mid, ring)) {
        if (!current) {
          // Entering: at the road's own start, or at a cut
          const atStart = i === 0 && t0 === 0;
          current = { coordinates: [], sourceIndices: [], startCut: !atStart, endCut: false };
          push(p0, t0 === 0 ? i : null);
        }
        push(p1, t1 === 1 ? i + 1 : null);
      } else if (current) {
        // Leaving at p0: the road goes on outside
        close(true);
      }
    }
  }
  close(false);
  return pieces;
}

function lengthDeg(coords: readonly (readonly number[])[]): number {
  let len = 0;
  for (let i = 1; i < coords.length; i++) len += Math.hypot(coords[i][0] - coords[i - 1][0], coords[i][1] - coords[i - 1][1]);
  return len;
}

/** Area-weighted centroid of a ring (falls back to the vertex mean for degenerate rings). */
export function ringCentroid(ring: Ring): [number, number] {
  const r = closedRing(ring);
  let a = 0, cx = 0, cy = 0;
  const x0 = r[0][0], y0 = r[0][1];
  for (let i = 1; i < r.length; i++) {
    const p = [r[i - 1][0] - x0, r[i - 1][1] - y0], q = [r[i][0] - x0, r[i][1] - y0];
    const f = p[0] * q[1] - q[0] * p[1];
    a += f; cx += (p[0] + q[0]) * f; cy += (p[1] + q[1]) * f;
  }
  if (Math.abs(a) < 1e-18) {
    const n = Math.max(1, r.length - 1);
    let sx = 0, sy = 0;
    for (let i = 0; i < n; i++) { sx += r[i][0]; sy += r[i][1]; }
    return [sx / n, sy / n];
  }
  return [x0 + cx / (3 * a), y0 + cy / (3 * a)];
}

/** Whether a building footprint belongs to the polygon: its centroid lies inside it. */
export function footprintInPolygon(footprint: Ring, polygon: Ring): boolean {
  return footprint.length >= 3 && pointInPolygon(ringCentroid(footprint), polygon);
}

/** Whether a closed ring crosses itself (a drawn boundary must not). */
export function ringSelfIntersects(polygon: Ring): boolean {
  const r = closedRing(polygon);
  const n = r.length - 1;
  if (n < 4) return false;
  const orient = (a: readonly number[], b: readonly number[], c: readonly number[]) => (b[0] - a[0]) * (c[1] - a[1]) - (b[1] - a[1]) * (c[0] - a[0]);
  for (let i = 0; i < n; i++) {
    for (let j = i + 1; j < n; j++) {
      if (j === i + 1 || (i === 0 && j === n - 1)) continue; // neighbouring edges share a vertex
      const a = r[i], b = r[i + 1], c = r[j], d = r[j + 1];
      if (orient(a, b, c) * orient(a, b, d) < 0 && orient(c, d, a) * orient(c, d, b) < 0) return true;
    }
  }
  return false;
}

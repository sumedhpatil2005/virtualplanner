/**
 * Planar geometry for feasibility screening. Coordinates are WGS84 [lng, lat];
 * everything is projected to a local equirectangular plane (metres) around a
 * reference latitude. Over a few kilometres in Pune (~18.5°N) the projection
 * error is well under 1 % — far below the uncertainty of the data it screens.
 */

export type LngLat = [number, number];
export type XY = [number, number];

const R = 6371008.8; // mean Earth radius, m (IUGG)

export interface Projector { toXY(p: LngLat): XY; refLat: number }

export function projector(refLng: number, refLat: number): Projector {
  const kx = (Math.PI / 180) * R * Math.cos((refLat * Math.PI) / 180);
  const ky = (Math.PI / 180) * R;
  return { refLat, toXY: ([lng, lat]) => [(lng - refLng) * kx, (lat - refLat) * ky] };
}

export function lineLengthM(line: LngLat[]): number {
  if (line.length < 2) return 0;
  const pr = projector(line[0][0], line[0][1]);
  let s = 0;
  for (let i = 1; i < line.length; i++) {
    const a = pr.toXY(line[i - 1]), b = pr.toXY(line[i]);
    s += Math.hypot(b[0] - a[0], b[1] - a[1]);
  }
  return s;
}

export function centroid(line: LngLat[]): LngLat {
  const n = line.length || 1;
  return [line.reduce((s, p) => s + p[0], 0) / n, line.reduce((s, p) => s + p[1], 0) / n];
}

/** Bounding box [minLng, minLat, maxLng, maxLat] of a line grown by `marginM`. */
export function bboxAround(line: LngLat[], marginM: number): [number, number, number, number] {
  const lat = centroid(line)[1];
  const dLat = marginM / ((Math.PI / 180) * R);
  const dLng = marginM / ((Math.PI / 180) * R * Math.cos((lat * Math.PI) / 180));
  const xs = line.map(p => p[0]), ys = line.map(p => p[1]);
  return [Math.min(...xs) - dLng, Math.min(...ys) - dLat, Math.max(...xs) + dLng, Math.max(...ys) + dLat];
}

function pointSegDist(p: XY, a: XY, b: XY): number {
  const dx = b[0] - a[0], dy = b[1] - a[1];
  const L2 = dx * dx + dy * dy;
  let t = L2 === 0 ? 0 : ((p[0] - a[0]) * dx + (p[1] - a[1]) * dy) / L2;
  t = Math.max(0, Math.min(1, t));
  return Math.hypot(p[0] - (a[0] + t * dx), p[1] - (a[1] + t * dy));
}

function orient(a: XY, b: XY, c: XY): number {
  return (b[0] - a[0]) * (c[1] - a[1]) - (b[1] - a[1]) * (c[0] - a[0]);
}

export function segmentsIntersect(a: XY, b: XY, c: XY, d: XY): boolean {
  const o1 = orient(a, b, c), o2 = orient(a, b, d), o3 = orient(c, d, a), o4 = orient(c, d, b);
  return ((o1 > 0) !== (o2 > 0)) && ((o3 > 0) !== (o4 > 0)) && o1 !== 0 && o2 !== 0 && o3 !== 0 && o4 !== 0;
}

export function pointInPolygon(p: XY, ring: XY[]): boolean {
  let inside = false;
  for (let i = 0, j = ring.length - 1; i < ring.length; j = i++) {
    const [xi, yi] = ring[i], [xj, yj] = ring[j];
    if ((yi > p[1]) !== (yj > p[1]) && p[0] < ((xj - xi) * (p[1] - yi)) / (yj - yi) + xi) inside = !inside;
  }
  return inside;
}

/** Minimum distance (m) between two polylines (projected). 0 when they cross. */
export function polylineDistance(a: XY[], b: XY[]): number {
  if (a.length === 0 || b.length === 0) return Infinity;
  if (a.length === 1 && b.length === 1) return Math.hypot(a[0][0] - b[0][0], a[0][1] - b[0][1]);
  let best = Infinity;
  const segsA = a.length === 1 ? [[a[0], a[0]]] : a.slice(1).map((p, i) => [a[i], p]);
  const segsB = b.length === 1 ? [[b[0], b[0]]] : b.slice(1).map((p, i) => [b[i], p]);
  for (const [p, q] of segsA) {
    for (const [r, s] of segsB) {
      if (segmentsIntersect(p, q, r, s)) return 0;
      best = Math.min(best, pointSegDist(p, r, s), pointSegDist(q, r, s), pointSegDist(r, p, q), pointSegDist(s, p, q));
    }
  }
  return best;
}

/** Distance (m) from a polyline to a polygon ring; 0 if the line touches or enters it. */
export function polylineToPolygonDistance(line: XY[], ring: XY[]): number {
  if (line.some(p => pointInPolygon(p, ring))) return 0;
  return polylineDistance(line, ring);
}

export function polylineCrosses(a: XY[], b: XY[]): boolean {
  return polylineDistance(a, b) === 0;
}

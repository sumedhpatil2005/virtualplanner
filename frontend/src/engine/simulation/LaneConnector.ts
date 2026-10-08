/** A lane movement in local metres, parameterised by travelled distance. */
export interface LanePose { lng: number; lat: number; z: number; heading: number; pitch: number }
export interface LaneConnector {
  start: number;
  entry: number;
  length: number;
  points: LanePose[];
  distances: number[];
  /** A turn (driven at turning speed) rather than straight on. */
  turn?: boolean;
}
const M = 111320;

export function makeLaneConnector(a: LanePose, b: LanePose, start: number, entry: number): LaneConnector {
  const kx = M * Math.cos(a.lat * Math.PI / 180);
  const dx = (b.lng - a.lng) * kx, dy = (b.lat - a.lat) * M;
  const handle = Math.max(0.5, Math.hypot(dx, dy) * 0.42);
  const p = [[0, 0], [Math.cos(a.heading) * handle, Math.sin(a.heading) * handle],
    [dx - Math.cos(b.heading) * handle, dy - Math.sin(b.heading) * handle], [dx, dy]];
  const points: LanePose[] = [], distances = [0];
  for (let i = 0; i <= 48; i++) {
    const t = i / 48, u = 1 - t;
    const x = u ** 3 * p[0][0] + 3 * u * u * t * p[1][0] + 3 * u * t * t * p[2][0] + t ** 3 * dx;
    const y = u ** 3 * p[0][1] + 3 * u * u * t * p[1][1] + 3 * u * t * t * p[2][1] + t ** 3 * dy;
    const tx = 3 * u * u * p[1][0] + 6 * u * t * (p[2][0] - p[1][0]) + 3 * t * t * (dx - p[2][0]);
    const ty = 3 * u * u * p[1][1] + 6 * u * t * (p[2][1] - p[1][1]) + 3 * t * t * (dy - p[2][1]);
    // Hermite elevation preserves the grades at both lane ends.
    const dz0 = Math.tan(a.pitch) * handle * 3, dz1 = Math.tan(b.pitch) * handle * 3;
    const z = (2 * t ** 3 - 3 * t * t + 1) * a.z + (t ** 3 - 2 * t * t + t) * dz0
      + (-2 * t ** 3 + 3 * t * t) * b.z + (t ** 3 - t * t) * dz1;
    const tz = (6 * t * t - 6 * t) * a.z + (3 * t * t - 4 * t + 1) * dz0
      + (-6 * t * t + 6 * t) * b.z + (3 * t * t - 2 * t) * dz1;
    points.push({ lng: a.lng + x / kx, lat: a.lat + y / M, z, heading: Math.atan2(ty, tx), pitch: Math.atan2(tz, Math.hypot(tx, ty)) });
    if (i > 0) {
      const last = points[i - 1];
      distances.push(distances[i - 1] + Math.hypot((points[i].lng - last.lng) * kx, (points[i].lat - last.lat) * M));
    }
  }
  return { start, entry, length: distances[distances.length - 1], points, distances };
}

export function sampleLaneConnector<T extends LanePose>(c: LaneConnector, distance: number, out: T): T {
  const d = Math.max(0, Math.min(c.length, distance));
  let i = 1;
  while (i < c.distances.length - 1 && c.distances[i] < d) i++;
  const a = c.points[i - 1], b = c.points[i];
  const t = (d - c.distances[i - 1]) / Math.max(1e-9, c.distances[i] - c.distances[i - 1]);
  out.lng = a.lng + (b.lng - a.lng) * t; out.lat = a.lat + (b.lat - a.lat) * t;
  out.z = a.z + (b.z - a.z) * t;
  out.heading = a.heading + Math.atan2(Math.sin(b.heading - a.heading), Math.cos(b.heading - a.heading)) * t;
  out.pitch = a.pitch + (b.pitch - a.pitch) * t;
  return out;
}

/** Conservative swept-path conflict test. Parallel opposing lanes remain independent. */
export function connectorsConflict(a: LaneConnector, b: LaneConnector): boolean {
  const kx = M * Math.cos(a.points[0].lat * Math.PI / 180);
  for (let i = 0; i < a.points.length; i += 2) {
    for (let j = 0; j < b.points.length; j += 2) {
      const p = a.points[i], q = b.points[j];
      if (Math.abs(p.z - q.z) > 3) continue;
      if (Math.hypot((p.lng - q.lng) * kx, (p.lat - q.lat) * M) < 2.3) return true;
    }
  }
  return false;
}

import type { RoadObject, FlyoverObject, MetroFlyoverObject } from './types';

type Point = [number, number, number];
type Road = RoadObject | FlyoverObject | MetroFlyoverObject;
export interface JunctionArm {
  roadId: string;
  /** Unit vector pointing away from the centre, east/north. */
  dx: number;
  dy: number;
  width: number;
  reach: number;
}
export interface JunctionLayout {
  arms: JunctionArm[];
  roadIds: string[];
  boundary: Point[];
  elevation: number;
  valid: boolean;
}
const M = 111320;

/** Shared by the placement preview and the committed junction mesh. Never joins different decks. */
export function junctionLayout(centre: Point, roads: readonly Road[]): JunctionLayout {
  const kx = M * Math.cos(centre[1] * Math.PI / 180);
  const arms: JunctionArm[] = [];
  const heights: number[] = [];
  for (const road of roads) {
    const cs = road.coordinates;
    let nearest: { i: number; t: number; d: number; z: number } | null = null;
    for (let i = 1; i < cs.length; i++) {
      const a = cs[i - 1], b = cs[i];
      const ax = (a[0] - centre[0]) * kx, ay = (a[1] - centre[1]) * M;
      const dx = (b[0] - a[0]) * kx, dy = (b[1] - a[1]) * M;
      const len2 = dx * dx + dy * dy;
      if (len2 < 0.01) continue;
      const t = Math.max(0, Math.min(1, -(ax * dx + ay * dy) / len2));
      const d = Math.hypot(ax + t * dx, ay + t * dy);
      const z = (a[2] || 0) + t * ((b[2] || 0) - (a[2] || 0));
      const end = (i === 1 && t < 0.01) || (i === cs.length - 1 && t > 0.99);
      // A nearby parallel carriageway is not an intersection. Loose ends have a wider reach.
      if (d > (end ? 8 : 3) || Math.abs(z - centre[2]) > 3) continue;
      if (!nearest || d < nearest.d) nearest = { i, t, d, z };
    }
    if (!nearest) continue;
    heights.push(nearest.z);
    const width = Math.max(3, Math.min(45, road.laneCount * (road.laneWidth || 3.5) + (road.hasDivider ? road.dividerWidth || 0 : 0)));
    const reach = Math.max(6, width * 0.65 + 2);
    const a = cs[nearest.i - 1], b = cs[nearest.i];
    const projectedX = a[0] + nearest.t * (b[0] - a[0]);
    const projectedY = a[1] + nearest.t * (b[1] - a[1]);
    for (const direction of [-1, 1]) {
      let i = direction < 0 ? nearest.i - 1 : nearest.i;
      // Measure along the road from its projection, so an offset cursor cannot create a false arm.
      for (; i >= 0 && i < cs.length; i += direction) {
        const dx = (cs[i][0] - projectedX) * kx, dy = (cs[i][1] - projectedY) * M;
        const d = Math.hypot(dx, dy);
        if (d < 1) continue;
        const ux = dx / d, uy = dy / d;
        if (!arms.some(a => a.roadId === road.id && a.dx * ux + a.dy * uy > 0.98)) {
          arms.push({ roadId: road.id, dx: ux, dy: uy, width, reach });
        }
        break;
      }
    }
  }
  // The approaches set the height; the cursor may have picked something above the deck.
  const elevation = heights.length ? Math.max(...heights) : centre[2];
  const points: [number, number][] = arms.flatMap(a => [-1, 1].map(s => [a.dx * a.reach - a.dy * a.width / 2 * s, a.dy * a.reach + a.dx * a.width / 2 * s] as [number, number]));
  const hull = convexHull(points);
  const boundary: Point[] = hull.map(([x, y]) => [centre[0] + x / kx, centre[1] + y / M, elevation]);
  return { arms, roadIds: [...new Set(arms.map(a => a.roadId))], boundary, elevation, valid: arms.length >= 2 && boundary.length >= 3 };
}

function convexHull(points: [number, number][]): [number, number][] {
  const ps = points.sort((a, b) => a[0] - b[0] || a[1] - b[1]);
  if (ps.length < 3) return ps;
  const turn = (a: number[], b: number[], c: number[]) => (b[0] - a[0]) * (c[1] - a[1]) - (b[1] - a[1]) * (c[0] - a[0]);
  const half = (list: [number, number][]) => {
    const out: [number, number][] = [];
    for (const p of list) {
      while (out.length >= 2 && turn(out[out.length - 2], out[out.length - 1], p) <= 0) out.pop();
      out.push(p);
    }
    return out.slice(0, -1);
  };
  return [...half(ps), ...half([...ps].reverse())];
}

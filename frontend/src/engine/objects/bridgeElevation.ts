import type { CityObject, RoadObject } from './types';
import { MinHeap } from '../simulation/Pathfinder';

/**
 * Heights for OpenStreetMap bridges and flyovers.
 *
 * OSM gives roads a layer (bridge=yes, layer=1) but no height, so imported
 * flyovers lie flat on the roads they cross: decks and the roads below draw
 * on top of each other, and so do the vehicles on them. This raises every
 * road on a layer above the ground to a deck height for its layer, ramping
 * up from wherever it meets a ground-level road at a realistic grade.
 */

/** Deck height per layer above ground (m), as a typical Indian city flyover. */
export const DECK_HEIGHT_PER_LAYER_M = 6.5;
const MAX_LAYERS = 3;
/** Ramp slope: 5%, a common flyover approach grade. */
export const RAMP_GRADE = 0.05;
/** Long straight pieces are split so the deck can rise along them. */
const MAX_VERTEX_SPACING_M = 12;

const M_PER_DEG_LAT = 111320;
const key = (p: readonly number[]) => `${p[0].toFixed(7)},${p[1].toFixed(7)}`;
const distM = (a: readonly number[], b: readonly number[]) =>
  Math.hypot((b[0] - a[0]) * M_PER_DEG_LAT * Math.cos((a[1] * Math.PI) / 180), (b[1] - a[1]) * M_PER_DEG_LAT);

/** The layer an OSM road is on above the ground, or 0. */
export function elevatedLayer(o: CityObject): number {
  if (o.type !== 'road' || !o.osmProvenance) return 0;
  const { layer, bridge } = o.osmProvenance;
  const l = typeof layer === 'number' && layer > 0 ? layer : bridge ? 1 : 0;
  return Math.min(MAX_LAYERS, l);
}

/** Inserts points so no piece is longer than MAX_VERTEX_SPACING_M. Original points are kept as they are. */
function densify(coords: readonly [number, number, number][]): [number, number, number][] {
  const out: [number, number, number][] = [coords[0]];
  for (let i = 1; i < coords.length; i++) {
    const a = coords[i - 1], b = coords[i];
    const n = Math.ceil(distM(a, b) / MAX_VERTEX_SPACING_M);
    for (let k = 1; k < n; k++) {
      const t = k / n;
      out.push([a[0] + t * (b[0] - a[0]), a[1] + t * (b[1] - a[1]), 0]);
    }
    out.push(b);
  }
  return out;
}

/**
 * Deck heights for the elevated OSM roads among `objects`: for each road
 * whose points should change, its new points (the objects themselves are not
 * changed). Points shared with a ground-level road stay on the ground;
 * elsewhere the deck rises at RAMP_GRADE from the nearest such point, up to
 * its layer's height. A deck that meets the ground nowhere is level at full
 * height. Applying the result and running it again changes nothing.
 */
export function bridgeHeights(objects: Iterable<CityObject>): Map<RoadObject, [number, number, number][]> {
  const elevated: RoadObject[] = [];
  const groundKeys = new Set<string>();
  for (const o of objects) {
    if (o.type !== 'road' && o.type !== 'flyover' && o.type !== 'metro_flyover') continue;
    if (elevatedLayer(o) > 0) {
      elevated.push(o as RoadObject);
    } else if (o.type === 'road') {
      for (const p of o.coordinates) if (Math.abs(p[2] || 0) < 1) groundKeys.add(key(p));
    }
  }
  const changed = new Map<RoadObject, [number, number, number][]>();
  if (elevated.length === 0) return changed;

  // Graph of deck points: neighbours along each road, and points shared between decks
  const coords = new Map<RoadObject, [number, number, number][]>();
  const height = new Map<string, number>();
  const links = new Map<string, { to: string; m: number }[]>();
  const link = (a: string, b: string, m: number) => {
    if (!links.has(a)) links.set(a, []);
    links.get(a)!.push({ to: b, m });
  };
  for (const r of elevated) {
    const pts = densify(r.coordinates);
    coords.set(r, pts);
    const h = elevatedLayer(r) * DECK_HEIGHT_PER_LAYER_M;
    for (let i = 0; i < pts.length; i++) {
      const k = key(pts[i]);
      height.set(k, Math.max(height.get(k) ?? 0, h));
      if (i > 0) {
        const m = distM(pts[i - 1], pts[i]);
        link(key(pts[i - 1]), k, m);
        link(k, key(pts[i - 1]), m);
      }
    }
  }

  // Distance from each deck point to the nearest place it touches the ground
  const dist = new Map<string, number>();
  const heap = new MinHeap();
  for (const k of height.keys()) {
    if (groundKeys.has(k)) {
      dist.set(k, 0);
      heap.insert(k, 0);
    }
  }
  while (!heap.isEmpty()) {
    const { nodeId: k, score: d } = heap.extractMin()!;
    if (d > (dist.get(k) ?? Infinity)) continue;
    for (const { to, m } of links.get(k) ?? []) {
      const nd = d + m;
      if (nd < (dist.get(to) ?? Infinity)) {
        dist.set(to, nd);
        heap.insert(to, nd);
      }
    }
  }

  for (const r of elevated) {
    const next = coords.get(r)!.map(p => {
      const k = key(p);
      return [p[0], p[1], Math.min(height.get(k)!, (dist.get(k) ?? Infinity) * RAMP_GRADE)] as [number, number, number];
    });
    const same = next.length === r.coordinates.length && next.every((p, i) => {
      const q = r.coordinates[i];
      return p[0] === q[0] && p[1] === q[1] && Math.abs(p[2] - (q[2] || 0)) < 1e-9;
    });
    if (!same) changed.set(r, next);
  }
  return changed;
}

/** Applies bridgeHeights to the objects in place (for building scenes outside the ObjectManager, e.g. tests). */
export function liftOsmBridges(objects: Iterable<CityObject>): RoadObject[] {
  const changed = bridgeHeights(objects);
  changed.forEach((coordinates, r) => (r.coordinates = coordinates));
  return [...changed.keys()];
}

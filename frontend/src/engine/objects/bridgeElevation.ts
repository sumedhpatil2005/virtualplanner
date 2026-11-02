import type { CityObject, OSMProvenance, RoadObject } from './types';
import { MinHeap } from '../simulation/Pathfinder';
import { remapRoadSections, repairRoadSections } from './roadSections';

/**
 * Heights for OpenStreetMap bridges and flyovers.
 *
 * OSM gives roads a layer (bridge=yes, layer=1) but no height, so imported
 * flyovers would lie flat on the roads they cross: decks and the roads below
 * draw on top of each other, and so do the vehicles on them.
 *
 * A deck that passes over something known (a road on a lower level that
 * crosses it without sharing an OSM node; a shared node is a junction, so
 * the two are at the same level there) stands at its layer's height along
 * its whole span. In OSM the bridge way usually covers only the span; the
 * ramp is on the approach road (an embankment, tagged as an ordinary road),
 * so the descent at RAMP_GRADE continues onto the ground OSM roads that
 * carry on from the deck. It stops at the first at-grade junction (where
 * other ground roads join): there the height is 0, and the deck (or its
 * approach) rises from it at the grade, so a junction right at the end of a
 * span still pulls that end down. Roads the user drew or edited are never
 * raised.
 *
 * A deck over nothing known (a nala, a river, a railway, or a road not
 * loaded yet) keeps the conservative profile used before: it ramps up from
 * wherever it meets the ground within its own span, so a short bridge over a
 * stream stays near road level instead of becoming a hump.
 */

/** Deck height per layer above ground (m), as a typical Indian city flyover (about 5.5 m clearance + deck). */
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

/** Whether OSM tags this way as a bridge. Any bridge=* value except "no" counts (yes, viaduct, cantilever, ...). */
export function isOsmBridge(p: Pick<OSMProvenance, 'bridge'> & { originalTags?: Record<string, string> } | undefined): boolean {
  if (!p) return false;
  const tag = p.originalTags?.bridge?.trim().toLowerCase();
  return !!p.bridge || (!!tag && tag !== 'no');
}

/** Whether OSM tags this way as a tunnel (any tunnel=* value except "no"), or puts it below ground (layer < 0). */
export function isOsmTunnel(p: Pick<OSMProvenance, 'tunnel' | 'layer'> & { originalTags?: Record<string, string> } | undefined): boolean {
  if (!p) return false;
  const tag = p.originalTags?.tunnel?.trim().toLowerCase();
  return !!p.tunnel || (!!tag && tag !== 'no') || (typeof p.layer === 'number' && p.layer < 0);
}

/**
 * The level an OSM bridge is on above the ground (1 to 3), or 0.
 *
 * Only bridges are raised. OSM's layer tag orders crossing features; it is
 * not a height, and plenty of ground roads carry layer=1 (over a culvert, or
 * relative to something below them), so layer alone never raises a road.
 * On a bridge it gives the deck's level (a bridge over a bridge).
 */
export function elevatedLayer(o: CityObject): number {
  if (o.type !== 'road' || !o.osmProvenance || !isOsmBridge(o.osmProvenance)) return 0;
  const { layer } = o.osmProvenance;
  return Math.min(MAX_LAYERS, typeof layer === 'number' && layer > 1 ? layer : 1);
}

/**
 * How many levels an OSM road runs below the ground (1 to 3), or 0: tunnels
 * and roads in a cut (layer < 0, e.g. an underpass road below a highway).
 * A building passage is at street level.
 */
export function depressedLevel(o: CityObject): number {
  if (o.type !== 'road' || !o.osmProvenance || isOsmBridge(o.osmProvenance)) return 0;
  const p = o.osmProvenance;
  const tunnel = p.originalTags?.tunnel?.trim().toLowerCase();
  if (tunnel === 'building_passage') return 0;
  if (typeof p.layer === 'number' && p.layer < 0) return Math.min(MAX_LAYERS, -p.layer);
  return isOsmTunnel(p) ? 1 : 0;
}

/** Inserts points so no piece is longer than MAX_VERTEX_SPACING_M. Original points are kept as they are. */
function densify(coords: readonly [number, number, number][]): BridgeGeometry {
  const out: [number, number, number][] = [coords[0]];
  const originalIndices = [0];
  for (let i = 1; i < coords.length; i++) {
    const a = coords[i - 1], b = coords[i];
    const n = Math.ceil(distM(a, b) / MAX_VERTEX_SPACING_M);
    for (let k = 1; k < n; k++) {
      const t = k / n;
      out.push([a[0] + t * (b[0] - a[0]), a[1] + t * (b[1] - a[1]), 0]);
    }
    out.push(b);
    originalIndices.push(out.length - 1);
  }
  return { coordinates: out, originalIndices };
}

const identity = (coords: readonly [number, number, number][]): BridgeGeometry => ({
  coordinates: coords.map(p => [p[0], p[1], p[2] || 0] as [number, number, number]),
  originalIndices: coords.map((_, i) => i),
});

export interface BridgeGeometry {
  coordinates: [number, number, number][];
  /** New index of each original vertex, so profiles follow the same segments. */
  originalIndices: number[];
}

/** A place where a deck must have clearance: it passes over a lower road there. */
export interface DeckCrossing {
  deckId: string;
  underId: string;
  /** Deck segment (start vertex index in the deck's coordinates) and fraction along it. */
  segment: number;
  t: number;
  point: [number, number];
}

/** A raised OSM road can be lifted; so can the OSM ground roads that lead onto it, unless edited by hand. */
const isLiftableGround = (o: RoadObject) =>
  !!o.osmProvenance && elevatedLayer(o) === 0 && depressedLevel(o) === 0 &&
  !o.sections?.some(s => s.provenance?.geometryModified);

function segmentCrossing(a: readonly number[], b: readonly number[], c: readonly number[], d: readonly number[]): { t: number; u: number } | null {
  const dx = b[0] - a[0], dy = b[1] - a[1], ex = d[0] - c[0], ey = d[1] - c[1];
  const denom = dx * ey - dy * ex;
  if (Math.abs(denom) < 1e-20) return null;
  const t = ((c[0] - a[0]) * ey - (c[1] - a[1]) * ex) / denom;
  const u = ((c[0] - a[0]) * dy - (c[1] - a[1]) * dx) / denom;
  return t >= 0 && t <= 1 && u >= 0 && u <= 1 ? { t, u } : null;
}

type Box = { minX: number; minY: number; maxX: number; maxY: number };
const boxOf = (cs: readonly (readonly number[])[]): Box => {
  const b = { minX: Infinity, minY: Infinity, maxX: -Infinity, maxY: -Infinity };
  for (const p of cs) { b.minX = Math.min(b.minX, p[0]); b.maxX = Math.max(b.maxX, p[0]); b.minY = Math.min(b.minY, p[1]); b.maxY = Math.max(b.maxY, p[1]); }
  return b;
};
const boxesMeet = (a: Box, b: Box) => a.minX <= b.maxX && a.maxX >= b.minX && a.minY <= b.maxY && a.maxY >= b.minY;

/**
 * Places where an elevated OSM road passes over a lower road without a
 * shared node: the deck needs clearance there. Roads in a cut or tunnel and
 * roads on the same or a higher level are not "under" the deck.
 */
export function deckCrossings(objects: Iterable<CityObject>): DeckCrossing[] {
  const roads = [...objects].filter((o): o is RoadObject => o.type === 'road' && o.coordinates.length >= 2);
  return structureCrossings(roads, roads.filter(r => elevatedLayer(r) > 0), (deck, other) =>
    elevatedLayer(other) < elevatedLayer(deck) && depressedLevel(other) === 0);
}

/** Places where a road passes over an OSM road in a cut or tunnel without a shared node. */
export function cutCrossings(objects: Iterable<CityObject>): DeckCrossing[] {
  const roads = [...objects].filter((o): o is RoadObject => o.type === 'road' && o.coordinates.length >= 2);
  return structureCrossings(roads, roads.filter(r => depressedLevel(r) > 0), (cut, other) => depressedLevel(other) < depressedLevel(cut));
}

function structureCrossings(roads: readonly RoadObject[], structures: readonly RoadObject[], crosses: (s: RoadObject, other: RoadObject) => boolean): DeckCrossing[] {
  if (structures.length === 0) return [];
  const boxes = new Map(roads.map(r => [r, boxOf(r.coordinates)]));
  const out: DeckCrossing[] = [];
  for (const deck of structures) {
    const db = boxes.get(deck)!;
    const deckKeys = new Set(deck.coordinates.map(key));
    for (const under of roads) {
      if (under === deck || !crosses(deck, under)) continue;
      if (!boxesMeet(db, boxes.get(under)!)) continue;
      const dc = deck.coordinates, uc = under.coordinates;
      for (let i = 1; i < dc.length; i++) {
        for (let j = 1; j < uc.length; j++) {
          const hit = segmentCrossing(dc[i - 1], dc[i], uc[j - 1], uc[j]);
          if (!hit) continue;
          const point: [number, number] = [dc[i - 1][0] + hit.t * (dc[i][0] - dc[i - 1][0]), dc[i - 1][1] + hit.t * (dc[i][1] - dc[i - 1][1])];
          // Meeting at a node both ways share is a junction, not a pass-over
          if (deckKeys.has(key(point)) && uc.some(p => key(p) === key(point))) continue;
          out.push({ deckId: deck.id, underId: under.id, segment: i - 1, t: hit.t, point });
        }
      }
    }
  }
  return out;
}

/**
 * Deck heights for the elevated OSM roads among `objects`, depths for the
 * OSM roads in cuts under other roads, and ramp heights for the OSM ground
 * roads leading onto either: for each road whose points should change, its
 * new points (the objects themselves are not changed). Applying the result
 * and running it again changes nothing.
 */
export function bridgeGeometry(objects: Iterable<CityObject>): Map<RoadObject, BridgeGeometry> {
  const roads = [...objects].filter((o): o is RoadObject => o.type === 'road' && o.coordinates.length >= 2);
  const changed = new Map<RoadObject, BridgeGeometry>();
  const level = (r: RoadObject) => elevatedLayer(r) || -depressedLevel(r);
  const structures = roads.filter(r => level(r) !== 0);
  const ground = roads.filter(r => level(r) === 0);
  const liftable = ground.filter(isLiftableGround);
  if (structures.length === 0) {
    lowerStale(changed, liftable);
    return changed;
  }

  // Arms at each place: a vertex inside a road is two arms, a road's end is one
  const groundArms = new Map<string, number>();
  const allArms = new Map<string, number>();
  const fixedGround = new Set<string>();
  const addArms = (r: RoadObject, isGround: boolean) => {
    const cs = r.coordinates;
    cs.forEach((p, i) => {
      const k = key(p);
      const n = i === 0 || i === cs.length - 1 ? 1 : 2;
      allArms.set(k, (allArms.get(k) ?? 0) + n);
      if (isGround) groundArms.set(k, (groundArms.get(k) ?? 0) + n);
    });
  };
  const liftableSet = new Set(liftable);
  for (const r of structures) addArms(r, false);
  for (const r of ground) {
    addArms(r, true);
    if (!liftableSet.has(r)) for (const p of r.coordinates) fixedGround.add(key(p));
  }
  // At-grade junctions (other ground roads join, not just a continuation) and roads that may not move stay at 0
  const pinned = (k: string) => fixedGround.has(k) || ((groundArms.get(k) ?? 0) >= 2 && (allArms.get(k) ?? 0) >= 3);

  const groundOfKey = new Map<string, RoadObject[]>();
  for (const r of liftable) for (const p of r.coordinates) {
    const k = key(p);
    if (!groundOfKey.has(k)) groundOfKey.set(k, []);
    groundOfKey.get(k)!.push(r);
  }
  const results: Map<RoadObject, BridgeGeometry>[] = [];
  for (const sign of [1, -1] as const) {
    const decks = structures.filter(r => Math.sign(level(r)) === sign);
    if (decks.length === 0) continue;
    const mag = (r: RoadObject) => Math.abs(level(r)) * DECK_HEIGHT_PER_LAYER_M;
    const components = connectedStructures(decks);
    // A structure passes over (or under) something known when a road on the other side of it crosses it without a shared node
    const crossings = sign > 0 ? deckCrossings(roads) : cutCrossings(roads);
    const deckById = new Map(decks.map(d => [d.id, d]));
    const hard = new Set(crossings.map(c => components.get(deckById.get(c.deckId)!)).filter((c): c is number => c !== undefined));
    const hardDecks = decks.filter(d => hard.has(components.get(d)!));
    const softDecks = decks.filter(d => !hard.has(components.get(d)!));
    const out = new Map<RoadObject, BridgeGeometry>();
    results.push(out);

    // A bridge over nothing known ramps up from where it meets the ground, within its span. A cut under nothing stays at grade.
    if (sign > 0 && softDecks.length) {
      const groundKeys = new Set<string>();
      for (const r of ground) for (const p of r.coordinates) groundKeys.add(key(p));
      const geo = new Map(softDecks.map(r => [r, densify(r.coordinates)]));
      const { links, cap } = graphOf(geo, new Set(softDecks), mag);
      const dist = dijkstra([...cap.keys()].filter(k => groundKeys.has(k)).map(k => [k, 0]), links);
      geo.forEach((g, r) => out.set(r, { coordinates: g.coordinates.map(p => [p[0], p[1], Math.min(cap.get(key(p))!, (dist.get(key(p)) ?? Infinity) * RAMP_GRADE)]), originalIndices: g.originalIndices }));
    } else if (sign < 0) {
      for (const r of softDecks) out.set(r, identity(r.coordinates.map(p => [p[0], p[1], 0] as [number, number, number])));
    }

    if (hardDecks.length) {
      const hardSet = new Set(hardDecks);
      const geo = new Map<RoadObject, BridgeGeometry>(hardDecks.map(r => [r, densify(r.coordinates)]));
      // Approaches: ground OSM roads reached from the structure's ends within ramp reach, up to at-grade junctions
      const reach = Math.max(...hardDecks.map(mag)) / RAMP_GRADE;
      for (const r of approachRoads(hardDecks, groundOfKey, pinned, reach)) geo.set(r, densify(r.coordinates));
      const { links, cap } = graphOf(geo, hardSet, mag);
      const down = dijkstra([...links.keys()].filter(pinned).map(k => [k, 0]), links);
      const up = dijkstra([...cap].map(([k, h]) => [k, -h / RAMP_GRADE]), links);
      const heightOf = (k: string) => Math.max(0, Math.min(-(up.get(k) ?? Infinity) * RAMP_GRADE, (down.get(k) ?? Infinity) * RAMP_GRADE, cap.get(k) ?? Infinity));
      geo.forEach((g, r) => out.set(r, { coordinates: g.coordinates.map(p => [p[0], p[1], heightOf(key(p))]), originalIndices: g.originalIndices }));
    }
    // Signed heights
    if (sign < 0) out.forEach(g => g.coordinates.forEach(p => { p[2] = p[2] === 0 ? 0 : -p[2]; }));
  }

  // A ground approach shared by a bridge and a cut takes the larger change in height
  const merged = new Map<RoadObject, BridgeGeometry>();
  for (const res of results) res.forEach((g, r) => {
    const prev = merged.get(r);
    if (!prev) { merged.set(r, g); return; }
    const size = (x: BridgeGeometry) => Math.max(...x.coordinates.map(p => Math.abs(p[2])));
    if (size(g) > size(prev)) merged.set(r, g);
  });
  merged.forEach((g, r) => record(changed, r, g, level(r) === 0));
  lowerStale(changed, liftable.filter(r => !merged.has(r)));
  return changed;
}

/** Index of the connected group (by shared points) each structure belongs to. */
function connectedStructures(decks: readonly RoadObject[]): Map<RoadObject, number> {
  const byKey = new Map<string, RoadObject[]>();
  for (const d of decks) for (const p of d.coordinates) {
    const k = key(p);
    if (!byKey.has(k)) byKey.set(k, []);
    byKey.get(k)!.push(d);
  }
  const component = new Map<RoadObject, number>();
  let n = 0;
  for (const d of decks) {
    if (component.has(d)) continue;
    const stack = [d];
    component.set(d, n);
    while (stack.length) {
      const cur = stack.pop()!;
      for (const p of cur.coordinates) for (const o of byKey.get(key(p)) ?? []) {
        if (!component.has(o)) { component.set(o, n); stack.push(o); }
      }
    }
    n++;
  }
  return component;
}

/** Links between neighbouring points of the given roads, and each structure point's full height. */
function graphOf(geo: Map<RoadObject, BridgeGeometry>, structures: Set<RoadObject>, mag: (r: RoadObject) => number) {
  const links = new Map<string, { to: string; m: number }[]>();
  const cap = new Map<string, number>();
  const link = (a: string, b: string, m: number) => { if (!links.has(a)) links.set(a, []); links.get(a)!.push({ to: b, m }); };
  geo.forEach((g, r) => {
    const pts = g.coordinates;
    const h = structures.has(r) ? mag(r) : 0;
    for (let i = 0; i < pts.length; i++) {
      const k = key(pts[i]);
      if (!links.has(k)) links.set(k, []);
      if (h > 0) cap.set(k, Math.max(cap.get(k) ?? 0, h));
      if (i > 0) { const m = distM(pts[i - 1], pts[i]); link(key(pts[i - 1]), k, m); link(k, key(pts[i - 1]), m); }
    }
  });
  return { links, cap };
}

/**
 * Ground roads a ramp from the structures can reach: walked along from the
 * structures' points, no further than `reach` metres and never past an
 * at-grade junction.
 */
function approachRoads(structures: readonly RoadObject[], groundOfKey: Map<string, RoadObject[]>, pinned: (k: string) => boolean, reach: number): Set<RoadObject> {
  const found = new Set<RoadObject>();
  const best = new Map<string, number>();
  const frontier: { k: string; d: number }[] = [];
  for (const s of structures) for (const p of s.coordinates) {
    const k = key(p);
    if (groundOfKey.has(k) && !pinned(k)) frontier.push({ k, d: 0 });
  }
  while (frontier.length) {
    const { k, d } = frontier.pop()!;
    if (d > reach || (best.get(k) ?? Infinity) <= d) continue;
    best.set(k, d);
    for (const r of groundOfKey.get(k) ?? []) {
      found.add(r);
      const cs = r.coordinates;
      cs.forEach((p, idx) => {
        if (key(p) !== k) return;
        for (const dir of [-1, 1]) {
          let acc = d;
          for (let i = idx + dir; i >= 0 && i < cs.length; i += dir) {
            acc += distM(cs[i - dir], cs[i]);
            const kk = key(cs[i]);
            if (acc > reach || pinned(kk)) break;
            if ((groundOfKey.get(kk)?.length ?? 0) > 1 || i === 0 || i === cs.length - 1) frontier.push({ k: kk, d: acc });
          }
        }
      });
    }
  }
  return found;
}

/** Ground roads that are no longer approaches but were raised before (e.g. the deck was deleted) go back down. */
function lowerStale(changed: Map<RoadObject, BridgeGeometry>, notApproaches: readonly RoadObject[]) {
  for (const r of notApproaches) {
    if (changed.has(r)) continue;
    if (r.coordinates.some(p => Math.abs(p[2] || 0) > 1e-9)) {
      record(changed, r, identity(r.coordinates.map(p => [p[0], p[1], 0] as [number, number, number])));
    }
  }
}

/**
 * Adds the geometry when it differs from the road's points. A ground
 * approach that stays flat keeps its points as they are (no densified
 * vertices are added to roads that do not rise).
 */
function record(changed: Map<RoadObject, BridgeGeometry>, r: RoadObject, g: BridgeGeometry, groundApproach = false) {
  if (groundApproach && g.coordinates.every(p => p[2] < 1e-6)) {
    if (r.coordinates.every(p => Math.abs(p[2] || 0) < 1e-9)) return;
    g = identity(r.coordinates.map(p => [p[0], p[1], 0] as [number, number, number]));
  }
  const same = g.coordinates.length === r.coordinates.length && g.coordinates.every((p, i) => {
    const q = r.coordinates[i];
    return p[0] === q[0] && p[1] === q[1] && Math.abs(p[2] - (q[2] || 0)) < 1e-9;
  });
  if (!same) changed.set(r, g);
}

/** Multi-source shortest distances with given start values (which may be negative). */
function dijkstra(sources: [string, number][], links: Map<string, { to: string; m: number }[]>): Map<string, number> {
  const dist = new Map<string, number>();
  const heap = new MinHeap();
  for (const [k, d] of sources) {
    if (d < (dist.get(k) ?? Infinity)) { dist.set(k, d); heap.insert(k, d); }
  }
  while (!heap.isEmpty()) {
    const { nodeId: k, score: d } = heap.extractMin()!;
    if (d > (dist.get(k) ?? Infinity)) continue;
    for (const { to, m } of links.get(k) ?? []) {
      const nd = d + m;
      if (nd < (dist.get(to) ?? Infinity)) { dist.set(to, nd); heap.insert(to, nd); }
    }
  }
  return dist;
}

/** Compatibility API for callers that only need coordinates. */
export function bridgeHeights(objects: Iterable<CityObject>): Map<RoadObject, [number, number, number][]> {
  return new Map([...bridgeGeometry(objects)].map(([road, geometry]) => [road, geometry.coordinates]));
}

/** Applies bridgeHeights to the objects in place (for building scenes outside the ObjectManager, e.g. tests). */
export function liftOsmBridges(objects: Iterable<CityObject>): RoadObject[] {
  const changed = bridgeGeometry(objects);
  changed.forEach(({ coordinates, originalIndices }, r) => {
    if (r.sections?.length) r.sections = remapRoadSections(repairRoadSections(r), r.coordinates, coordinates, originalIndices);
    r.sourceCoordinates ??= r.coordinates.map(point => [...point] as [number, number, number]);
    r.coordinates = coordinates;
  });
  return [...changed.keys()];
}

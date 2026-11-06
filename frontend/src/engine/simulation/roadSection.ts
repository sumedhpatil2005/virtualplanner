import type { StudyArea, DrivableObject, StudySegment } from './StudyAreaExplorer';

/**
 * The road section a click means.
 *
 * A click lands on one OpenStreetMap way, which is often a short piece of the
 * road (Veer Santaji Ghorpade Road is 13 ways, the clicked one 152 m long), and
 * on a divided road only one carriageway: one direction of travel. Counting
 * that piece alone reported a fraction of the road's traffic, and nothing at
 * all in the peak running the other way.
 *
 * The section is the clicked road followed along pieces of the same road (same
 * name, alternative name or ref, ignoring "Road"/"Marg"-type suffixes) in both
 * directions, until it meets another main road (collector or bigger, of a
 * different name) or SECTION_MAX_M from the click; plus the other carriageway
 * running alongside it. This is the planning unit, a link between major
 * junctions, both directions.
 */
export const SECTION_MAX_M = 900;
/** A placeholder name the importer gives an unnamed way from its OSM class ("Secondary_link Road", "Residential Road"). */
export const isGenericRoadName = (name: string | undefined) =>
  !name || /^(unnamed|residential|service|primary|secondary|tertiary|trunk|motorway|living_street|unclassified|road|track)(_link)? road$/i.test(name.trim());
/** Another carriageway of the same road this close (m) runs alongside the section. */
const ALONGSIDE_M = 45;

const SUFFIXES = /\b(road|rd|marg|path|rasta|rasta|street|st|avenue|ave|highway|hwy|chowk road)\b\.?/g;
export const normaliseRoadName = (name: string) =>
  name.toLowerCase().replace(/[()|,.'’-]/g, ' ').replace(SUFFIXES, ' ').replace(/\s+/g, ' ').trim();

/** Names a road goes by, normalised (name, alt_name, official_name, ref). */
export function roadKeys(road: DrivableObject | undefined): Set<string> {
  const keys = new Set<string>();
  if (!road) return keys;
  const tags = road.type === 'road' ? road.osmProvenance?.originalTags ?? {} : {};
  const names = [road.name, tags.name, tags.alt_name, tags.official_name, tags.old_name].filter((n): n is string => !!n && !isGenericRoadName(n));
  for (const n of names) for (const part of n.split(';')) { const k = normaliseRoadName(part); if (k.length >= 3) keys.add('n:' + k); }
  if (tags.ref) for (const r of tags.ref.split(';')) keys.add('r:' + r.trim().toUpperCase());
  return keys;
}

const RANK: Record<string, number> = { highway: 4, arterial: 3, collector: 2, local: 1 };
const M_PER_DEG_LAT = 111320;

const midpoint = (c: readonly (readonly number[])[]) => c[Math.floor(c.length / 2)];
const endKey = (p: readonly number[]) => `${p[0].toFixed(7)},${p[1].toFixed(7)}`;

/** Distance (m) from p to a polyline, and the polyline's end point when that is the nearest point (else null). */
function pointToPolylineEnd(p: readonly number[], line: readonly (readonly number[])[]): { d: number; end: readonly number[] | null } {
  const kx = M_PER_DEG_LAT * Math.cos(p[1] * Math.PI / 180);
  let best = Infinity, end: readonly number[] | null = null;
  const last = line.length - 2;
  for (let i = 0; i < line.length - 1; i++) {
    const ax = (line[i][0] - p[0]) * kx, ay = (line[i][1] - p[1]) * M_PER_DEG_LAT;
    const bx = (line[i + 1][0] - p[0]) * kx, by = (line[i + 1][1] - p[1]) * M_PER_DEG_LAT;
    const dx = bx - ax, dy = by - ay, l2 = dx * dx + dy * dy;
    const raw = l2 > 0 ? -(ax * dx + ay * dy) / l2 : 0;
    const t = Math.max(0, Math.min(1, raw));
    const d = Math.hypot(ax + t * dx, ay + t * dy);
    if (d < best) { best = d; end = i === 0 && raw <= 0 ? line[0] : i === last && raw >= 1 ? line[line.length - 1] : null; }
  }
  return { d: best, end };
}

export interface RoadSection {
  /** Study-area stretches (segment keys) of the section, both carriageways. */
  segmentKeys: string[];
  roadIds: string[];
  name: string;
  lengthM: number;
  /** Junctions the section ends at, by the main roads met there (empty when it stops at SECTION_MAX_M or the area edge). */
  endsAt: string[];
  /** Carriageways: one for a two-way road, two for a divided road mapped as one-way pieces. */
  carriageways: number;
}

/** The section of road the seed roads stand for, inside the study area. */
export function roadSection(area: StudyArea, roads: ReadonlyMap<string, DrivableObject>, seedRoadIds: readonly string[]): RoadSection {
  const segs = area.segments;
  const seedSet = new Set(seedRoadIds);
  const seedSegs = segs.filter(s => seedSet.has(s.roadId));
  const keys = new Set<string>();
  for (const id of seedRoadIds) for (const k of roadKeys(roads.get(id))) keys.add(k);
  const same = (s: StudySegment) => seedSet.has(s.roadId) || [...roadKeys(roads.get(s.roadId))].some(k => keys.has(k));

  // Stretches by end node, from the study graph
  const ends = new Map<string, [string, string]>();
  const byNode = new Map<string, StudySegment[]>();
  const nodesOf = (s: StudySegment) => {
    if (ends.has(s.key)) return ends.get(s.key)!;
    const e = area.network.edges.get(s.key + '_fwd') ?? area.network.edges.get(s.key + '_bwd') ?? area.network.edges.get(s.key);
    const pair: [string, string] = e ? [e.fromNodeId, e.toNodeId] : ['', ''];
    ends.set(s.key, pair);
    return pair;
  };
  for (const s of segs) for (const n of nodesOf(s)) if (n) (byNode.get(n) ?? byNode.set(n, []).get(n)!).push(s);
  /** A main road of another name meets the section here: a major junction. */
  const majorJunction = (node: string) => (byNode.get(node) ?? []).some(s => !same(s) && (RANK[roads.get(s.roadId)?.roadClass ?? 'local'] ?? 1) >= 2);

  const chosen = new Map<string, StudySegment>(seedSegs.map(s => [s.key, s]));
  const endNames = new Set<string>();
  // Grow along the same road from each end of the seed pieces, up to a major junction or the length limit
  const queue: { node: string; dist: number }[] = [];
  for (const s of seedSegs) for (const n of nodesOf(s)) if (n) queue.push({ node: n, dist: 0 });
  const seen = new Set<string>();
  while (queue.length) {
    const { node, dist } = queue.shift()!;
    if (seen.has(node)) continue;
    seen.add(node);
    if (majorJunction(node)) {
      // Name the junction by a real road name where one meets there
      const met = (byNode.get(node) ?? []).filter(s => !same(s)).map(s => roads.get(s.roadId)?.name);
      const real = met.filter(n => !isGenericRoadName(n));
      for (const n of real.length ? real : met) endNames.add(n || 'a main road');
      continue;
    }
    for (const s of byNode.get(node) ?? []) {
      if (chosen.has(s.key) || !same(s)) continue;
      const d = dist + s.lengthM;
      if (d > SECTION_MAX_M) continue;
      chosen.set(s.key, s);
      for (const n of nodesOf(s)) if (n && n !== node) queue.push({ node: n, dist: d });
    }
  }
  // The other carriageway of a divided road, running alongside. Alongside means beside the section's
  // line, not beyond one of its ends: a piece of the same road whose nearest point on the section is a
  // free end lies past that end (Nyaymurti Ranade Path's 11 m stub across Shivaji Road's median, 5 m
  // past the section's end at that major junction, was taken in and set the capacity; docs/OVERHAUL.md §21)
  const lines = [...chosen.values()].map(s => s.coordinates);
  const endUse = new Map<string, number>();
  for (const l of lines) for (const p of [l[0], l[l.length - 1]]) endUse.set(endKey(p), (endUse.get(endKey(p)) ?? 0) + 1);
  const freeEnds = new Set([...endUse].filter(([, n]) => n === 1).map(([k]) => k));
  for (const s of segs) {
    if (chosen.has(s.key) || !same(s)) continue;
    const m = midpoint(s.coordinates);
    let best = Infinity, atFreeEnd = false;
    for (const l of lines) {
      const { d, end } = pointToPolylineEnd(m, l);
      if (d < best) { best = d; atFreeEnd = end !== null && freeEnds.has(endKey(end)); }
    }
    if (best < ALONGSIDE_M && !atFreeEnd) chosen.set(s.key, s);
  }
  const list = [...chosen.values()];
  const roadIds = [...new Set(list.map(s => s.roadId))];
  const oneWay = roadIds.filter(id => { const r = roads.get(id); return r?.type === 'road' ? r.isOneWay : false; }).length;
  const seedRoad = roads.get(seedRoadIds[0]);
  // Length of the road, not of both carriageways
  const total = list.reduce((n, s) => n + s.lengthM, 0);
  const carriageways = oneWay > 0 && oneWay === roadIds.length && list.length > 1 ? 2 : 1;
  return { segmentKeys: list.map(s => s.key), roadIds, name: seedRoad?.name || 'Unnamed road', lengthM: total / carriageways, endsAt: [...endNames].slice(0, 4), carriageways };
}

// ── Carriageway ─────────────────────────────────────────────────────────────

/** Whether a road is an OSM slip road or ramp (highway=*_link). */
export const isLinkRoad = (r: DrivableObject) =>
  r.type === 'road' && /_link$/.test(r.osmProvenance?.originalTags?.highway ?? '');

/** One piece of a carriageway: the road, and whether travel on it runs the way it is drawn. */
export interface CarriagewayPiece { road: DrivableObject; along: boolean }

const wayEndKey = (p: readonly number[]) => `${p[0].toFixed(6)},${p[1].toFixed(6)}`;
const wayLengthM = (c: readonly (readonly number[])[]) => {
  let n = 0;
  for (let i = 1; i < c.length; i++) n += Math.hypot((c[i][0] - c[i - 1][0]) * M_PER_DEG_LAT * Math.cos(c[i][1] * Math.PI / 180), (c[i][1] - c[i - 1][1]) * M_PER_DEG_LAT);
  return n;
};

/**
 * A carriageway: one direction of travel on one road, as the analysis measures it (sectionDirections in
 * RoadAnalysis.ts) and as a Build lane edit with "Entire carriageway" changes it (roadEdits.ts). Both use this
 * function, so the stretch a direction's capacity is read from is the stretch the edit reaches
 * (docs/OVERHAUL.md §21).
 *
 * From the given way, travelled along its drawing (`along`) or against it, the run is followed end to end, both
 * downstream and upstream, over OpenStreetMap ways that:
 *  - are the same road (same name, alternative name or ref: roadKeys);
 *  - are of the same kind, one-way or two-way (a road turning one-way, or splitting into two one-way
 *    carriageways, is a different carriageway from there on);
 *  - can be travelled the same way from the shared end node (a one-way piece only along its drawing), so the
 *    run is contiguous in the direction of travel and never turns onto the opposite carriageway;
 *  - are slip roads exactly when the start is (a ramp is not part of the main carriageway, nor the reverse);
 *  - are the only way of that road travel can continue on from the shared node, of any kind (a fork, such as
 *    a flyover and its at-grade road of one name, or a slip road of the same name leaving or joining, ends it);
 *  - do not turn back on the way travelled (more than 135°: a U-turn onto the opposite carriageway);
 *  - and are reached without passing a junction with a main road (collector or above) of another name, at
 *    the shared node or inside the piece (a main road may pass through either way's node without ending
 *    there), and within SECTION_MAX_M of the start's midpoint.
 * `accept` may end the run earlier (a lane edit stops where the lanes in the edited direction change).
 * Returns the start first, then the downstream pieces, then the upstream ones.
 */
export function carriagewayRun(roads: readonly DrivableObject[], roadId: string, along: boolean, accept?: (p: CarriagewayPiece) => boolean): CarriagewayPiece[] {
  const sel = roads.find(r => r.id === roadId);
  if (!sel || sel.coordinates.length < 2) return [];
  const start: CarriagewayPiece = { road: sel, along };
  const keys = roadKeys(sel);
  if (keys.size === 0) return [start];
  const oneWay = (r: DrivableObject) => r.type === 'road' && r.isOneWay;
  const pool = roads.filter(r => r.type === 'road' && r.scenarioId === sel.scenarioId && r.coordinates.length >= 2);
  const byNode = new Map<string, DrivableObject[]>(), atVertex = new Map<string, DrivableObject[]>();
  for (const r of pool) {
    for (const p of [r.coordinates[0], r.coordinates[r.coordinates.length - 1]]) {
      const k = wayEndKey(p);
      (byNode.get(k) ?? byNode.set(k, []).get(k)!).push(r);
    }
    for (const p of r.coordinates) {
      const k = wayEndKey(p), l = atVertex.get(k) ?? atVertex.set(k, []).get(k)!;
      if (l[l.length - 1] !== r) l.push(r);
    }
  }
  const same = (r: DrivableObject) => [...roadKeys(r)].some(k => keys.has(k));
  /** A main road (collector or above) of another name passes through this node, at an end of it or not. */
  const majorAt = (k: string, except: DrivableObject) => (atVertex.get(k) ?? []).some(r => r !== except && !same(r) && (RANK[r.type === 'road' ? r.roadClass : 'arterial'] ?? 1) >= 2);
  const travelBearing = (p: CarriagewayPiece) => {
    const c = p.road.coordinates, a = p.along ? c[0] : c[c.length - 1], b = p.along ? c[c.length - 1] : c[0];
    return (Math.atan2((b[0] - a[0]) * Math.cos(a[1] * Math.PI / 180), b[1] - a[1]) * 180 / Math.PI + 360) % 360;
  };
  const link = isLinkRoad(sel);
  const out = new Map<string, CarriagewayPiece>([[sel.id, start]]);
  for (const downstream of [true, false]) {
    let cur = start, dist = wayLengthM(sel.coordinates) / 2;
    for (;;) {
      const c = cur.road.coordinates;
      // Downstream we leave a piece by the end travel heads for; upstream by the end it comes from
      const node = wayEndKey(cur.along === downstream ? c[c.length - 1] : c[0]);
      const meeting = (byNode.get(node) ?? []).filter(r => r.id !== cur.road.id);
      if (majorAt(node, cur.road)) break;
      // Every way of the same road that travel can continue on from here (downstream: drawn from here, or
      // two-way and drawn towards here; upstream the reverse), of whatever kind
      const next = meeting.filter(r => same(r) && !out.has(r.id))
        .map(r => {
          const drawnFromHere = wayEndKey(r.coordinates[0]) === node;
          return { road: r, along: drawnFromHere === downstream };
        })
        .filter(p => !(oneWay(p.road) && !p.along));
      // A fork (the road splits: a flyover and its at-grade road, a slip road leaving or joining) or the end of the road
      if (next.length !== 1) break;
      const piece = next[0];
      // The road turns one-way or two-way, or the way is a slip road and the start is not (or the reverse)
      if (oneWay(piece.road) !== oneWay(sel) || isLinkRoad(piece.road) !== link) break;
      // Travel turns back on itself: a U-turn onto the opposite carriageway of a divided road
      const turn = Math.abs(travelBearing(piece) - travelBearing(cur)) % 360;
      if (Math.min(turn, 360 - turn) > 135) break;
      // The piece runs on through a main road of another name: the edit would reach past that junction
      if (piece.road.coordinates.slice(1, -1).some(p => majorAt(wayEndKey(p), piece.road))) break;
      if (accept && !accept(piece)) break;
      dist += wayLengthM(piece.road.coordinates);
      if (dist > SECTION_MAX_M) break;
      out.set(piece.road.id, piece);
      cur = piece;
    }
  }
  return [...out.values()];
}

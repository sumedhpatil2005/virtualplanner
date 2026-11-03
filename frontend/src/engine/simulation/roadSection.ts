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
  const names = [road.name, tags.name, tags.alt_name, tags.official_name, tags.old_name].filter((n): n is string => !!n && !/^(unnamed|residential|service) road$/i.test(n));
  for (const n of names) for (const part of n.split(';')) { const k = normaliseRoadName(part); if (k.length >= 3) keys.add('n:' + k); }
  if (tags.ref) for (const r of tags.ref.split(';')) keys.add('r:' + r.trim().toUpperCase());
  return keys;
}

const RANK: Record<string, number> = { highway: 4, arterial: 3, collector: 2, local: 1 };
const M_PER_DEG_LAT = 111320;

function pointToPolylineM(p: readonly number[], line: readonly (readonly number[])[]): number {
  const kx = M_PER_DEG_LAT * Math.cos(p[1] * Math.PI / 180);
  let best = Infinity;
  for (let i = 0; i < line.length - 1; i++) {
    const ax = (line[i][0] - p[0]) * kx, ay = (line[i][1] - p[1]) * M_PER_DEG_LAT;
    const bx = (line[i + 1][0] - p[0]) * kx, by = (line[i + 1][1] - p[1]) * M_PER_DEG_LAT;
    const dx = bx - ax, dy = by - ay, l2 = dx * dx + dy * dy;
    const t = l2 > 0 ? Math.max(0, Math.min(1, -(ax * dx + ay * dy) / l2)) : 0;
    best = Math.min(best, Math.hypot(ax + t * dx, ay + t * dy));
  }
  return best;
}
const midpoint = (c: readonly (readonly number[])[]) => c[Math.floor(c.length / 2)];

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
      for (const s of byNode.get(node) ?? []) if (!same(s)) endNames.add(roads.get(s.roadId)?.name || 'a main road');
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
  // The other carriageway of a divided road, running alongside
  const lines = [...chosen.values()].map(s => s.coordinates);
  for (const s of segs) {
    if (chosen.has(s.key) || !same(s)) continue;
    const m = midpoint(s.coordinates);
    if (lines.some(l => pointToPolylineM(m, l) < ALONGSIDE_M)) chosen.set(s.key, s);
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

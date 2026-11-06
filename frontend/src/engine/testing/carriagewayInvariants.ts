/**
 * Properties every "Entire carriageway" lane edit scope must have (docs/OVERHAUL.md §21), checked
 * independently of how carriagewayRun walks: from the scope's pieces and the roads round them.
 */
import type { RoadObject } from '../objects/types';
import { laneEditPlan, laneEditPreview, laneEditPieces, type LaneField } from '../editing/roadEdits';
import { roadKeys } from '../simulation/roadSection';

const isLinkRoad = (r: RoadObject) => /_link$/.test(r.osmProvenance?.originalTags?.highway ?? '');

const RANK: Record<string, number> = { highway: 4, arterial: 3, collector: 2, local: 1 };
const key = (p: readonly number[]) => `${p[0].toFixed(6)},${p[1].toFixed(6)}`;
const M = 111320;
const xy = (p: readonly number[], lat0: number) => [p[0] * M * Math.cos(lat0 * Math.PI / 180), p[1] * M];
function distToLineM(p: readonly number[], line: readonly (readonly number[])[]) {
  const [px, py] = xy(p, p[1]);
  let best = Infinity;
  for (let i = 0; i < line.length - 1; i++) {
    const [ax, ay] = xy(line[i], p[1]), [bx, by] = xy(line[i + 1], p[1]);
    const dx = bx - ax, dy = by - ay, l2 = dx * dx + dy * dy;
    const t = l2 > 0 ? Math.max(0, Math.min(1, ((px - ax) * dx + (py - ay) * dy) / l2)) : 0;
    best = Math.min(best, Math.hypot(ax + t * dx - px, ay + t * dy - py));
  }
  return best;
}
const bearing = (a: readonly number[], b: readonly number[]) => {
  const [ax, ay] = xy(a, a[1]), [bx, by] = xy(b, a[1]);
  return (Math.atan2(bx - ax, by - ay) * 180 / Math.PI + 360) % 360;
};
const angleDiff = (a: number, b: number) => { const d = Math.abs(a - b) % 360; return d > 180 ? 360 - d : d; };

export interface Violation { roadId: string; field: LaneField; rule: string; detail: string }

/** Index of every road by end node and by any vertex. */
export function indexRoads(roads: readonly RoadObject[]) {
  const ends = new Map<string, RoadObject[]>(), verts = new Map<string, RoadObject[]>();
  for (const r of roads) {
    if (r.type !== 'road' || r.coordinates.length < 2) continue;
    for (const p of [r.coordinates[0], r.coordinates[r.coordinates.length - 1]]) (ends.get(key(p)) ?? ends.set(key(p), []).get(key(p))!).push(r);
    for (const p of r.coordinates) { const k = key(p); const l = verts.get(k) ?? verts.set(k, []).get(k)!; if (!l.includes(r)) l.push(r); }
  }
  return { ends, verts };
}

export function checkCarriagewayScope(roads: readonly RoadObject[], idx: ReturnType<typeof indexRoads>, roadId: string, field: LaneField): Violation[] {
  const out: Violation[] = [];
  const bad = (rule: string, detail: string) => out.push({ roadId, field, rule, detail });
  const sel = roads.find(r => r.id === roadId)!;
  const pieces = laneEditPieces(roads, roadId, field, 'carriageway');
  const preview = laneEditPreview(roads, roadId, field, 'carriageway');
  const plan = laneEditPlan(roads, roadId, field, 3, () => [], 'carriageway');
  if (preview.roadIds.join() !== plan.map(p => p.id).join() || preview.roadIds.join() !== pieces.map(p => p.road.id).join()) bad('preview == edit', `${preview.roadIds} vs ${plan.map(p => p.id)}`);
  const seg = laneEditPreview(roads, roadId, field, 'segment');
  if (seg.roadIds.join() !== roadId || laneEditPlan(roads, roadId, field, 3, () => [], 'segment').map(p => p.id).join() !== roadId) bad('segment scope', seg.roadIds.join());
  if (pieces[0]?.road.id !== roadId) bad('selected first', pieces.map(p => p.road.id).join());
  if (pieces.length <= 1) return out;
  const keys = roadKeys(sel), link = isLinkRoad(sel);
  // Travel order of each piece
  const trav = pieces.map(p => {
    const twoWay = !p.road.isOneWay;
    if (!twoWay && p.field !== 'lanesForward') bad('direction of travel', `${p.road.id}: one-way edited ${p.field}`);
    const along = p.field === 'lanesForward';
    const c = along ? p.road.coordinates : [...p.road.coordinates].reverse();
    return { road: p.road, c, from: key(c[0]), to: key(c[c.length - 1]) };
  });
  for (const t of trav) {
    if (![...roadKeys(t.road)].some(k => keys.has(k))) bad('same road', `${t.road.id} "${t.road.name}" vs "${sel.name}"`);
    if (t.road.isOneWay !== sel.isOneWay) bad('same kind', t.road.id);
    if (isLinkRoad(t.road) !== link) bad('link/ramp', `${t.road.id} ${t.road.osmProvenance?.originalTags?.highway}`);
  }
  // Contiguous in the direction of travel: one simple path, each piece's end the next one's start
  const byFrom = new Map(trav.map(t => [t.from, t]));
  const tos = new Set(trav.map(t => t.to));
  const heads = trav.filter(t => !tos.has(t.from));
  let path: typeof trav = [];
  if (heads.length !== 1 || byFrom.size !== trav.length) bad('contiguous', `heads ${heads.length}, distinct starts ${byFrom.size}/${trav.length}`);
  else {
    for (let t: (typeof trav)[number] | undefined = heads[0]; t && !path.includes(t); t = byFrom.get(t.to)) path.push(t);
    if (path.length !== trav.length) bad('contiguous', `path covers ${path.length}/${trav.length}`);
  }
  // At every joint: no main road of another name meets there; the road does not fork (no other way of
  // the same road continues in the direction of travel, whatever its kind or level)
  for (let i = 0; i + 1 < path.length; i++) {
    const node = path[i].to, a = path[i].road, b = path[i + 1].road;
    const here = idx.ends.get(node) ?? [];
    const major = (idx.verts.get(node) ?? []).filter(r => r !== a && r !== b && ![...roadKeys(r)].some(k => keys.has(k)) && (RANK[r.roadClass] ?? 1) >= 2);
    if (major.length) bad('major junction', `${a.id}->${b.id} at ${node} meets ${major.map(r => `${r.id} "${r.name}" ${r.roadClass}`).join(', ')}`);
    // Crossed downstream (the selected piece is at or before this joint): a way leaving here is a fork;
    // crossed upstream: a way arriving here is
    const downstream = i >= path.findIndex(t => t.road.id === roadId);
    const other = here.filter(r => r !== a && r !== b && [...roadKeys(r)].some(k => keys.has(k)))
      .filter(r => !r.isOneWay || (key(downstream ? r.coordinates[0] : r.coordinates[r.coordinates.length - 1]) === node));
    if (other.length) bad('fork', `${a.id}->${b.id} at ${node}: also ${other.map(r => `${r.id}${r.osmProvenance?.bridge ? ' (bridge)' : ''}`).join(', ')}`);
  }
  // A piece other than the selected one must not run through a main road junction at one of its inner points
  for (const t of trav.slice(1)) {
    for (const p of t.road.coordinates.slice(1, -1)) {
      const cross = (idx.verts.get(key(p)) ?? []).filter(r => r !== t.road && ![...roadKeys(r)].some(k => keys.has(k)) && (RANK[r.roadClass] ?? 1) >= 2);
      if (cross.length) { bad('major junction inside a piece', `${t.road.id} at ${key(p)} with ${cross.map(r => `${r.id} "${r.name}"`).join(', ')}`); break; }
    }
  }
  // Never the opposite carriageway: no two pieces running opposite ways side by side
  for (let i = 0; i < trav.length; i++) for (let j = i + 1; j < trav.length; j++) {
    const A = trav[i], B = trav[j];
    const mid = B.c[Math.floor(B.c.length / 2)];
    if (distToLineM(mid, A.c) < 40 && angleDiff(bearing(A.c[0], A.c[A.c.length - 1]), bearing(B.c[0], B.c[B.c.length - 1])) > 135) bad('opposite carriageway', `${A.road.id} / ${B.road.id}`);
  }
  return out;
}

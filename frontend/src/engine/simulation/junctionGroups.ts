import type { TrafficNetwork, TrafficEdge } from '../objects/trafficTypes';
import type { DrivableObject } from './StudyAreaExplorer';
import { reliableRoadName, compassWord, bearingBetween, angleDiff, normaliseDeg } from './directions';

/**
 * Logical junctions of an imported (OpenStreetMap) network (docs/OVERHAUL.md §23).
 *
 * OSM draws one real junction as several nodes: a divided road crossing
 * another divided road gives a square of four nodes joined by 5-15 m pieces,
 * slip lanes (`*_link`) add nodes further out, and every piece is its own way.
 * Build showed only the piece that was clicked. This module groups the nodes
 * and short internal pieces into one junction with its approaches (traffic
 * entering) and exits (traffic leaving), each grouped by road name and the
 * side they come from. It never changes geometry.
 *
 * Rule (all three must hold for two nodes to join):
 *  1. both are junction nodes: at least three distinct road stretches meet
 *     there, or a mapped signal (highway=traffic_signals) stands within
 *     SIGNAL_NODE_M;
 *  2. a road stretch joins them that is at most INTERNAL_MAX_M long
 *     (shortest stretches first);
 *  3. the joined group still spans at most MAX_SPAN_M.
 * Then slip lanes: a `*_link` stretch of at most SLIP_MAX_M whose two ends
 * both lie within SLIP_RADIUS_M of a group's centre pulls those ends in (with
 * the end nodes alone: a side road meeting a slip lane's end stays its own junction).
 * Then enclosed plain nodes: a road that leaves a group and comes back into it
 * through plain (two-stretch) nodes only, within ENCLOSED_CHAIN_M and
 * SLIP_RADIUS_M of the centre, is inside the junction (OSM splits a
 * carriageway where its name changes or a signal stands; when no signal is
 * loaded that node is plain, and leaving it out cut one approach into a false
 * exit and a false approach).
 *
 * Two separate junctions 60 m apart stay separate: the stretch between them is
 * longer than INTERNAL_MAX_M, and a group could not span them anyway.
 */

export const INTERNAL_MAX_M = 30;
export const MAX_SPAN_M = 50;
export const SLIP_MAX_M = 120;
export const SLIP_RADIUS_M = 70;
export const SIGNAL_NODE_M = 12;
/** The simulator's junction fold (TrafficMicroSim JOIN_JUNCTION_M, and its 30 m limit across): nodes it folds into one simulated junction are one logical junction (§26). */
export const SIM_FOLD_M = 16;
const SIM_FOLD_SPAN_M = 30;
/** A roundabout ring at most this long (m) is one junction whatever its span (§26). */
export const ROUNDABOUT_MAX_M = 130;
/** A road leaving a junction and coming back into it through plain nodes within this length (m) is inside it. */
export const ENCLOSED_CHAIN_M = 60;
/** An approach's direction is taken from a point this far back along it (m). */
const ARM_LOOKBACK_M = 40;
/** Pieces of an approach followed back through plain (two-stretch) nodes up to this length (m). */
const ARM_CHAIN_M = 60;
/** Approaches of the same road from within this angle (degrees) are one approach. */
const ARM_GROUP_DEG = 45;

const M_PER_DEG_LAT = 111320;
const distM = (a: readonly number[], b: readonly number[]) =>
  Math.hypot((a[0] - b[0]) * M_PER_DEG_LAT * Math.cos(a[1] * Math.PI / 180), (a[1] - b[1]) * M_PER_DEG_LAT);
const segKey = (edgeId: string) => edgeId.replace(/_(fwd|bwd)$/, '');
/** An OSM node's identity: its position to 7 decimals, as OSM stores it (nodes shared by two ways have the same key in both). */
export const nodeKey = (c: readonly number[]) => `${c[0].toFixed(7)},${c[1].toFixed(7)}`;
/** Identity of a stretch entering the junction: its road and the node it ends at. */
export const inKey = (net: TrafficNetwork, e: TrafficEdge) => `${legacyInKey(net, e)}~${nodeKey(e.coordinates[Math.max(0, e.coordinates.length - 2)])}`;
/**
 * Before §26 a stretch key was the road and the node only. A two-way road that runs on through a junction
 * node enters it from both sides with the same road and node, so its two approaches (and its two exits)
 * had one key, and an edit compiled one of them as the other (1,051 of 10,895 junctions of the database
 * network). The key now also holds the vertex next to the node (where the stretch comes from, or goes
 * to), which tells the two sides apart and is the same in any network built from the same roads.
 */
export const legacyInKey = (net: TrafficNetwork, e: TrafficEdge) => `${e.roadId}>${nodeKey(net.nodes.get(e.toNodeId)!.coordinates)}`;
/** Identity of a stretch leaving the junction: its road and the node it starts at. */
export const outKey = (net: TrafficNetwork, e: TrafficEdge) => `${legacyOutKey(net, e)}~${nodeKey(e.coordinates[Math.min(1, e.coordinates.length - 1)])}`;
export const legacyOutKey = (net: TrafficNetwork, e: TrafficEdge) => `${e.roadId}<${nodeKey(net.nodes.get(e.fromNodeId)!.coordinates)}`;

export function hashText(text: string): string {
  let hash = 2166136261;
  for (let i = 0; i < text.length; i++) hash = Math.imul(hash ^ text.charCodeAt(i), 16777619);
  return (hash >>> 0).toString(16).padStart(8, '0');
}

export type TurnKind = 'left' | 'straight' | 'right' | 'u_turn';

export interface JunctionArm {
  /** Stable: from the stretches it is made of. */
  id: string;
  kind: 'in' | 'out';
  label: string;
  /** Road name, or null for an unnamed road. */
  name: string | null;
  /** Bearing from the junction centre to the arm (where an approach comes from, where an exit goes). */
  bearingDeg: number;
  /** The stretches entering (or leaving) the junction, one per carriageway piece. */
  edgeIds: string[];
  /** inKey / outKey of those stretches (stable across a rebuilt network). */
  keys: string[];
  /** Upstream (downstream for exits) pieces through plain nodes, for matching a network whose short pieces were folded. */
  chainKeys: string[];
  lanes: number;
  roadIds: string[];
  /** Highest road class rank among its roads (highway 4 ... local 1). */
  rank: number;
}

export interface JunctionMovement {
  key: string;
  approachId: string;
  exitId: string;
  turn: TurnKind;
  /** Entering and leaving stretch ids that make this movement. */
  edgePairs: [string, string][];
}

export interface LogicalJunction {
  /** Stable id from the OSM node positions of its members: jx_<hash>. */
  id: string;
  label: string;
  nodeIds: string[];
  nodeKeys: string[];
  centre: [number, number];
  /** Furthest member node from the centre (m). */
  radiusM: number;
  internalEdgeIds: string[];
  /** Roads with a piece inside the junction. */
  internalRoadIds: string[];
  approaches: JunctionArm[];
  exits: JunctionArm[];
  movements: JunctionMovement[];
  /** A mapped traffic signal stands at or inside it. */
  signalised: boolean;
  /** Grouped from more than one node, or by a slip lane. */
  slipLaneRoadIds: string[];
}

const RANK: Record<string, number> = { highway: 4, arterial: 3, collector: 2, local: 1 };

export interface GroupOptions {
  signalPoints?: readonly (readonly [number, number])[];
  /** Only junctions with a node inside these bounds (cheaper on a large network). */
  near?: { lng: number; lat: number; radiusM: number };
}

/** Groups the network's nodes into logical junctions (only junctions of two or more arms each way are returned). */
export function groupJunctions(net: TrafficNetwork, roads: ReadonlyMap<string, DrivableObject>, o: GroupOptions = {}): LogicalJunction[] {
  const signals = o.signalPoints ?? [];
  // Distinct stretches at each node
  const arms = new Map<string, Set<string>>();
  const segLen = new Map<string, { a: string; b: string; len: number; roadId: string }>();
  for (const e of net.edges.values()) {
    for (const n of [e.fromNodeId, e.toNodeId]) (arms.get(n) ?? arms.set(n, new Set()).get(n)!).add(segKey(e.id));
    const k = segKey(e.id);
    if (!segLen.has(k)) segLen.set(k, { a: e.fromNodeId, b: e.toNodeId, len: e.length, roadId: e.roadId });
  }
  const coord = (id: string) => net.nodes.get(id)!.coordinates;
  const hasSignal = (id: string) => signals.some(p => distM(p, coord(id)) <= SIGNAL_NODE_M);
  const isJunctionNode = (id: string) => (arms.get(id)?.size ?? 0) >= 3 || ((arms.get(id)?.size ?? 0) >= 2 && hasSignal(id));
  const inScope = (id: string) => !o.near || distM(coord(id), [o.near.lng, o.near.lat]) <= o.near.radiusM;

  // Union-find with member lists
  const groupOf = new Map<string, string>();
  const members = new Map<string, string[]>();
  const find = (id: string) => groupOf.get(id) ?? id;
  const membersOf = (g: string) => members.get(g) ?? [g];
  const span = (ids: string[]) => {
    let m = 0;
    for (let i = 0; i < ids.length; i++) for (let j = i + 1; j < ids.length; j++) m = Math.max(m, distM(coord(ids[i]), coord(ids[j])));
    return m;
  };
  const centreOf = (ids: string[]) => {
    const cs = ids.map(coord);
    return [cs.reduce((a, c) => a + c[0], 0) / cs.length, cs.reduce((a, c) => a + c[1], 0) / cs.length] as [number, number];
  };
  const detach = (id: string) => {
    const g = find(id);
    if (g === id && !members.has(id)) return;
    const rest = membersOf(g).filter(m => m !== id);
    groupOf.delete(id);
    if (g === id) {
      members.delete(id);
      if (rest.length) { const head = rest[0]; members.set(head, rest); for (const m of rest) groupOf.set(m, head); }
    } else members.set(g, rest);
  };
  const merge = (a: string, b: string) => {
    const ga = find(a), gb = find(b);
    if (ga === gb) return;
    const all = [...membersOf(ga), ...membersOf(gb)];
    members.set(ga, all);
    members.delete(gb);
    for (const m of all) groupOf.set(m, ga);
  };

  const adj = new Map<string, { other: string; len: number; seg: string }[]>();
  for (const [k, sg] of segLen) {
    if (sg.a === sg.b) continue;
    (adj.get(sg.a) ?? adj.set(sg.a, []).get(sg.a)!).push({ other: sg.b, len: sg.len, seg: k });
    (adj.get(sg.b) ?? adj.set(sg.b, []).get(sg.b)!).push({ other: sg.a, len: sg.len, seg: k });
  }
  const isPlain = (id: string) => (arms.get(id)?.size ?? 0) === 2 && !isJunctionNode(id);
  // 1-3: short stretches between junction nodes, shortest first, within the span limit. A stretch may run
  // through plain (two-stretch) nodes, which OSM leaves where two ways of one road meet (a name, lane or
  // tag change): the chain counts as one stretch of its total length and its plain nodes join with its
  // ends (§26: two junction nodes 7-15 m apart with a plain node between were two junctions, while the
  // simulator folds them into one, so an edit of either set the other's control too).
  const core: { a: string; b: string; len: number; via: string[] }[] = [];
  const seenChain = new Set<string>();
  for (const a of arms.keys()) {
    if (!isJunctionNode(a) || !inScope(a)) continue;
    for (const first of adj.get(a) ?? []) {
      let prev = a, cur = first.other, len = first.len;
      const via: string[] = [];
      while (isPlain(cur) && len <= INTERNAL_MAX_M && via.length < 8) {
        via.push(cur);
        const step = (adj.get(cur) ?? []).find(x => x.other !== prev);
        if (!step) break;
        prev = cur; cur = step.other; len += step.len;
      }
      if (cur === a || len > INTERNAL_MAX_M || !isJunctionNode(cur)) continue;
      const key = a < cur ? `${a}|${cur}|${via.join(',')}` : `${cur}|${a}|${[...via].reverse().join(',')}`;
      if (seenChain.has(key)) continue;
      seenChain.add(key);
      core.push({ a: a < cur ? a : cur, b: a < cur ? cur : a, len, via: a < cur ? via : [...via].reverse() });
    }
  }
  core.sort((x, y) => x.len - y.len || (x.a < y.a ? -1 : x.a > y.a ? 1 : x.b < y.b ? -1 : x.b > y.b ? 1 : x.via.join(',') < y.via.join(',') ? -1 : 1));
  for (const s of core) {
    const ga = find(s.a), gb = find(s.b);
    if (ga === gb && s.via.every(v => find(v) === ga)) continue;
    if (span([...new Set([...membersOf(ga), ...membersOf(gb), ...s.via])]) > MAX_SPAN_M) continue;
    merge(s.a, s.b);
    for (const v of s.via) if (find(v) === v && !members.has(v)) merge(s.a, v);
  }
  // Roundabouts (§26): the junction nodes of one roundabout ring (`junction=roundabout|circular`) of at most
  // ROUNDABOUT_MAX_M round are one junction, whatever the span (the span limit cut a 75 m ring in two).
  const isRing = (roadId: string) => {
    const r = roads.get(roadId);
    const j = r?.type === 'road' ? r.osmProvenance?.originalTags?.junction : undefined;
    return j === 'roundabout' || j === 'circular';
  };
  const ringOf = new Map<string, string>();
  const ringFind = (x: string): string => { let r = x; while (ringOf.has(r) && ringOf.get(r) !== r) r = ringOf.get(r)!; return r; };
  for (const sg of segLen.values()) if (sg.a !== sg.b && isRing(sg.roadId)) {
    const ra = ringFind(sg.a), rb = ringFind(sg.b);
    if (!ringOf.has(ra)) ringOf.set(ra, ra);
    if (!ringOf.has(rb)) ringOf.set(rb, rb);
    if (ra !== rb) ringOf.set(rb, ra);
  }
  const rings = new Map<string, { nodes: string[]; len: number }>();
  for (const id of ringOf.keys()) { const r = ringFind(id); (rings.get(r) ?? rings.set(r, { nodes: [], len: 0 }).get(r)!).nodes.push(id); }
  for (const sg of segLen.values()) if (sg.a !== sg.b && isRing(sg.roadId)) rings.get(ringFind(sg.a))!.len += sg.len;
  for (const ring of [...rings.values()].sort((x, y) => (x.nodes[0] < y.nodes[0] ? -1 : 1))) {
    const js = ring.nodes.filter(id => isJunctionNode(id) && (inScope(id) || ring.nodes.some(inScope))).sort();
    if (ring.len > ROUNDABOUT_MAX_M || js.length < 2) continue;
    for (const id of js.slice(1)) merge(js[0], id);
  }
  // Slip lanes (§26): a short at-grade `*_link` stretch between an approach road and an exit road of one
  // junction. Targets are the groups formed above (two or more nodes), fixed before any slip is taken,
  // so a group grown from slip-lane ends alone never becomes a junction of its own and the result does
  // not depend on the order slips are visited. A slip is taken when
  //  - both ends lie within SLIP_RADIUS_M of the target's centre (the largest such group, then the nearest),
  //  - it is at grade (not a bridge, tunnel or other layer: a ramp onto a flyover deck is not a slip lane),
  //  - each end leads into the target along other roads (not the slip) within SLIP_RADIUS_M, through
  //    nodes within SLIP_RADIUS_M of its centre: the approach before the slip leaves it and the exit
  //    after it rejoins. An end whose roads lead elsewhere is a junction on a service or link road;
  //  - neither end belongs to a group at least as large as the target, nor was pulled into another one.
  // Each end comes alone: a side road meeting the slip lane's end at another node stays its own junction.
  const isLink = (roadId: string) => {
    const r = roads.get(roadId);
    return r?.type === 'road' && /_link$/.test(r.osmProvenance?.originalTags?.highway ?? '');
  };
  const isGraded = (roadId: string) => {
    const r = roads.get(roadId);
    const t = r?.type === 'road' ? r.osmProvenance?.originalTags ?? {} : {};
    return (t.bridge !== undefined && t.bridge !== 'no') || (t.tunnel !== undefined && t.tunnel !== 'no') || (t.layer !== undefined && t.layer !== '0');
  };
  const coreTargets = [...members.keys()].filter(g => membersOf(g).length >= 2).map(g => ({ g, ids: new Set(membersOf(g)), c: centreOf(membersOf(g)) }));
  const coreOf = new Map<string, string>();
  for (const t of coreTargets) for (const id of t.ids) coreOf.set(id, t.g);
  /** Other roads at `end` (not the slip) reach a node of the target within SLIP_RADIUS_M, staying near it. */
  const leadsInto = (end: string, slipSeg: string, target: { ids: Set<string>; c: number[] }) => {
    const best = new Map<string, number>([[end, 0]]);
    const q: [string, number][] = [[end, 0]];
    while (q.length) {
      const [n, d] = q.shift()!;
      if (d > (best.get(n) ?? Infinity)) continue;
      for (const x of adj.get(n) ?? []) {
        if (x.seg === slipSeg) continue;
        const nd = d + x.len;
        if (nd > SLIP_RADIUS_M || distM(coord(x.other), target.c) > SLIP_RADIUS_M) continue;
        if (target.ids.has(x.other)) return true;
        if (nd < (best.get(x.other) ?? Infinity)) { best.set(x.other, nd); q.push([x.other, nd]); }
      }
    }
    return false;
  };
  const slipRoads = new Map<string, Set<string>>();
  const pulled = new Map<string, string>();
  const slips = [...segLen.entries()].filter(([, s]) => s.a !== s.b && s.len <= SLIP_MAX_M && isLink(s.roadId) && !isGraded(s.roadId) && isJunctionNode(s.a) && isJunctionNode(s.b) && (inScope(s.a) || inScope(s.b)))
    .sort(([, x], [, y]) => x.len - y.len || (x.a < y.a ? -1 : 1));
  for (const [k, s] of slips) {
    const target = coreTargets.filter(t => distM(t.c, coord(s.a)) <= SLIP_RADIUS_M && distM(t.c, coord(s.b)) <= SLIP_RADIUS_M)
      .sort((x, y) => y.ids.size - x.ids.size || distM(x.c, coord(s.a)) - distM(y.c, coord(s.a)) || (x.g < y.g ? -1 : 1))[0];
    if (!target) continue;
    const ok = [s.a, s.b].every(end => {
      if (target.ids.has(end) || pulled.get(end) === target.g) return true;
      if (pulled.has(end)) return false;
      const own = coreOf.get(end);
      if (own !== undefined && coreTargets.find(t => t.g === own)!.ids.size >= target.ids.size) return false;
      return leadsInto(end, k, target);
    });
    if (!ok) continue;
    for (const end of [s.a, s.b]) if (find(end) !== find(target.g)) { detach(end); merge(target.g, end); pulled.set(end, target.g); }
    (slipRoads.get(target.g) ?? slipRoads.set(target.g, new Set()).get(target.g)!).add(s.roadId);
  }
  // The simulator's own junctions (§26): TrafficMicroSim folds nodes joined by stretches shorter than
  // JOIN_JUNCTION_M (16 m) into one simulated junction (shortest first, at most 30 m across) with one
  // control. Junction nodes it folds together are one logical junction here too, whatever the span:
  // otherwise an edit of one set the control of its neighbour's approaches as well (a side road 8 m past
  // a slip lane's end, a T 10 m from a square's corner).
  {
    const foldOf = new Map<string, string>(), foldMembers = new Map<string, string[]>();
    const fFind = (x: string) => foldOf.get(x) ?? x;
    const bbox = (ids: string[]) => {
      const cs = ids.map(coord), lats = cs.map(c => c[1]), lngs = cs.map(c => c[0]);
      return Math.hypot((Math.max(...lngs) - Math.min(...lngs)) * M_PER_DEG_LAT * Math.cos(lats[0] * Math.PI / 180), (Math.max(...lats) - Math.min(...lats)) * M_PER_DEG_LAT);
    };
    const shortEdges = [...net.edges.values()].filter(e => e.length < SIM_FOLD_M).sort((x, y) => x.length - y.length);
    for (const e of shortEdges) {
      const a = fFind(e.fromNodeId), b = fFind(e.toNodeId);
      if (a === b) continue;
      const all = [...(foldMembers.get(a) ?? [a]), ...(foldMembers.get(b) ?? [b])];
      if (bbox(all) > SIM_FOLD_SPAN_M) continue;
      foldMembers.set(a, all); foldMembers.delete(b);
      for (const m of all) foldOf.set(m, a);
    }
    for (const ids of [...foldMembers.values()].sort((x, y) => (x[0] < y[0] ? -1 : 1))) {
      const js = ids.filter(id => isJunctionNode(id) || members.has(find(id))).sort();
      if (js.length < 2 || !js.some(inScope)) continue;
      for (const id of js.slice(1)) merge(js[0], id);
    }
  }
  // Enclosed plain nodes: a road leaving a group and coming back into it through plain (two-stretch) nodes
  // only, short and near the centre, is inside the junction (OSM splits a carriageway where its name
  // changes or a signal stands; with no signal loaded such a node is plain and would cut one approach
  // into a false exit and a false approach)
  for (const g of [...members.keys()]) {
    if (!members.has(g)) continue;
    const ids = membersOf(g), inGroup = new Set(ids), c = centreOf(ids);
    const absorb: string[] = [];
    for (const m of ids) for (const first of adj.get(m) ?? []) {
      if (inGroup.has(first.other) || !isPlain(first.other)) continue;
      let prev = m, cur = first.other, len = first.len;
      const chain: string[] = [];
      while (isPlain(cur) && !inGroup.has(cur) && len <= ENCLOSED_CHAIN_M && distM(coord(cur), c) <= SLIP_RADIUS_M && chain.length < 8) {
        chain.push(cur);
        const step = (adj.get(cur) ?? []).find(x => x.other !== prev);
        if (!step) break;
        prev = cur; cur = step.other; len += step.len;
      }
      if (chain.length && inGroup.has(cur) && len <= ENCLOSED_CHAIN_M) absorb.push(...chain);
    }
    for (const n of new Set(absorb)) if (find(n) === n && !members.has(n)) merge(g, n);
  }
  // Every junction node not grouped is a junction of its own
  const groups = new Map<string, string[]>();
  for (const id of net.nodes.keys()) {
    if ((!isJunctionNode(id) && !members.has(find(id))) || !inScope(id)) continue;
    const g = find(id);
    if (!groups.has(g)) groups.set(g, membersOf(g));
  }
  const out: LogicalJunction[] = [];
  for (const [g, ids] of groups) {
    const j = describe(net, roads, ids, signals, [...new Set([...slipRoads].filter(([t]) => find(t) === g).flatMap(([, r]) => [...r]))]);
    if (j) out.push(j);
  }
  return out.sort((a, b) => (a.id < b.id ? -1 : 1));
}

/** Point `along` metres back from the end of an entering stretch (or forward from the start of a leaving one), following plain nodes. */
function armPoint(net: TrafficNetwork, e: TrafficEdge, kind: 'in' | 'out', along: number, members: Set<string>): number[] {
  let left = along;
  let edge: TrafficEdge | undefined = e;
  let last = kind === 'in' ? e.coordinates[e.coordinates.length - 1] : e.coordinates[0];
  for (let hops = 0; edge && hops < 8; hops++) {
    const pts = kind === 'in' ? [...edge.coordinates].reverse() : edge.coordinates;
    for (let i = 1; i < pts.length; i++) {
      const d = distM(pts[i - 1], pts[i]);
      if (d >= left) {
        const t = left / Math.max(d, 1e-9);
        return [pts[i - 1][0] + t * (pts[i][0] - pts[i - 1][0]), pts[i - 1][1] + t * (pts[i][1] - pts[i - 1][1])];
      }
      left -= d;
      last = pts[i];
    }
    edge = nextOnChain(net, edge, kind, members);
  }
  return last;
}

/** The piece before an entering stretch (after a leaving one) when the node between is plain: only this road goes on. */
function nextOnChain(net: TrafficNetwork, e: TrafficEdge, kind: 'in' | 'out', members: Set<string>): TrafficEdge | undefined {
  const nodeId = kind === 'in' ? e.fromNodeId : e.toNodeId;
  if (members.has(nodeId)) return undefined;
  const node = net.nodes.get(nodeId);
  if (!node) return undefined;
  const cand = (kind === 'in' ? node.incomingSegments : node.outgoingSegments).map(id => net.edges.get(id)!).filter(x => x && segKey(x.id) !== segKey(e.id));
  const stretches = new Set([...node.incomingSegments, ...node.outgoingSegments].map(segKey));
  return stretches.size === 2 && cand.length === 1 ? cand[0] : undefined;
}

function describe(net: TrafficNetwork, roads: ReadonlyMap<string, DrivableObject>, ids: string[], signals: readonly (readonly [number, number])[], slipLaneRoadIds: string[]): LogicalJunction | null {
  const set = new Set(ids);
  const cs = ids.map(id => net.nodes.get(id)!.coordinates);
  const centre: [number, number] = [cs.reduce((a, c) => a + c[0], 0) / cs.length, cs.reduce((a, c) => a + c[1], 0) / cs.length];
  const radiusM = Math.max(0, ...cs.map(c => distM(c, centre)));
  const internal: TrafficEdge[] = [], entering: TrafficEdge[] = [], leaving: TrafficEdge[] = [];
  for (const id of ids) {
    const n = net.nodes.get(id)!;
    for (const eid of n.outgoingSegments) {
      const e = net.edges.get(eid);
      if (!e) continue;
      if (set.has(e.toNodeId)) internal.push(e); else leaving.push(e);
    }
    for (const eid of n.incomingSegments) {
      const e = net.edges.get(eid);
      if (e && !set.has(e.fromNodeId)) entering.push(e);
    }
  }
  const nameOf = (roadId: string) => reliableRoadName(roads.get(roadId));
  const rankOf = (roadId: string) => RANK[roads.get(roadId)?.roadClass ?? 'local'] ?? 1;
  const groupArms = (edges: TrafficEdge[], kind: 'in' | 'out'): JunctionArm[] => {
    const arms: { name: string | null; bearings: number[]; edges: TrafficEdge[] }[] = [];
    for (const e of [...edges].sort((a, b) => (a.id < b.id ? -1 : 1))) {
      const b = bearingBetween(centre, armPoint(net, e, kind, ARM_LOOKBACK_M, set));
      const name = nameOf(e.roadId);
      const arm = arms.find(a => a.name === name && angleDiff(a.bearings[0], b) < ARM_GROUP_DEG);
      if (arm) { arm.bearings.push(b); arm.edges.push(e); } else arms.push({ name, bearings: [b], edges: [e] });
    }
    return arms.map(a => {
      const keys = a.edges.map(e => (kind === 'in' ? inKey(net, e) : outKey(net, e))).sort();
      const chainKeys: string[] = [];
      for (const e of a.edges) {
        let len = e.length, cur = nextOnChain(net, e, kind, set);
        while (cur && len < ARM_CHAIN_M) {
          chainKeys.push(kind === 'in' ? inKey(net, cur) : outKey(net, cur));
          len += cur.length;
          cur = nextOnChain(net, cur, kind, set);
        }
      }
      // Mean bearing of the pieces (unit vectors)
      const sx = a.bearings.reduce((s, d) => s + Math.sin(d * Math.PI / 180), 0), sy = a.bearings.reduce((s, d) => s + Math.cos(d * Math.PI / 180), 0);
      const bearingDeg = normaliseDeg(Math.atan2(sx, sy) * 180 / Math.PI);
      const where = compassWord(bearingDeg);
      const label = `${a.name ?? 'Unnamed road'} ${kind === 'in' ? `from the ${where}` : `to the ${where}`}`;
      return { id: `${kind}_${hashText(keys.join('|'))}`, kind, label, name: a.name, bearingDeg, edgeIds: a.edges.map(e => e.id), keys, chainKeys: [...new Set(chainKeys)].sort(),
        lanes: a.edges.reduce((n, e) => n + Math.max(1, e.lanes || 1), 0), roadIds: [...new Set(a.edges.map(e => e.roadId))], rank: Math.max(...a.edges.map(e => rankOf(e.roadId))) };
    }).sort((x, y) => x.bearingDeg - y.bearingDeg);
  };
  const approaches = groupArms(entering, 'in');
  const exits = groupArms(leaving, 'out');
  if (approaches.length + exits.length < 3) return null;
  // Movements: an entering stretch reaches a leaving one through the internal pieces
  const outOf = new Map<string, TrafficEdge[]>();
  for (const e of internal) (outOf.get(e.fromNodeId) ?? outOf.set(e.fromNodeId, []).get(e.fromNodeId)!).push(e);
  const reach = (start: string) => {
    const seen = new Set([start]);
    const q = [start];
    while (q.length) { const n = q.shift()!; for (const e of outOf.get(n) ?? []) if (!seen.has(e.toNodeId)) { seen.add(e.toNodeId); q.push(e.toNodeId); } }
    return seen;
  };
  const armOfEdge = new Map<string, JunctionArm>();
  for (const a of [...approaches, ...exits]) for (const id of a.edgeIds) armOfEdge.set(id, a);
  const moves = new Map<string, JunctionMovement>();
  for (const e of entering) {
    const reached = reach(e.toNodeId);
    for (const x of leaving) {
      if (!reached.has(x.fromNodeId)) continue;
      // Straight back along the same stretch is not a movement
      if (segKey(x.id) === segKey(e.id)) continue;
      const a = armOfEdge.get(e.id)!, xa = armOfEdge.get(x.id)!;
      const key = `${a.id}>${xa.id}`;
      const m = moves.get(key) ?? moves.set(key, { key, approachId: a.id, exitId: xa.id, turn: turnOf(a.bearingDeg, xa.bearingDeg), edgePairs: [] }).get(key)!;
      m.edgePairs.push([e.id, x.id]);
    }
  }
  const nodeKeys = ids.map(id => nodeKey(net.nodes.get(id)!.coordinates)).sort();
  const names = [...new Set([...approaches, ...exits].sort((a, b) => b.rank - a.rank).map(a => a.name).filter((n): n is string => !!n))];
  const label = names.length >= 2 ? names.slice(0, 3).join(' / ') : names.length ? `${names[0]} (junction)` : 'Unnamed junction';
  const signalised = signals.some(p => distM(p, centre) <= radiusM + SIGNAL_NODE_M);
  return {
    id: `jx_${hashText(nodeKeys.join('|'))}`, label, nodeIds: [...ids].sort(), nodeKeys, centre, radiusM,
    internalEdgeIds: internal.map(e => e.id).sort(), internalRoadIds: [...new Set(internal.map(e => e.roadId))].sort(),
    approaches, exits, movements: [...moves.values()].sort((a, b) => (a.key < b.key ? -1 : 1)), signalised, slipLaneRoadIds: slipLaneRoadIds.sort(),
  };
}

/** Turn from an approach (bearing it comes from) to an exit (bearing it goes to). India drives on the left: a right turn crosses oncoming traffic. */
export function turnOf(approachFromDeg: number, exitToDeg: number): TurnKind {
  const heading = normaliseDeg(approachFromDeg + 180);
  let d = normaliseDeg(exitToDeg - heading);
  if (d > 180) d -= 360;
  if (Math.abs(d) <= 35) return 'straight';
  if (Math.abs(d) >= 150) return 'u_turn';
  return d > 0 ? 'right' : 'left';
}

/** The logical junction containing a node, or the one nearest a point (within maxM of a member node or its centre). */
export function junctionNear(js: readonly LogicalJunction[], net: TrafficNetwork, at: readonly number[], maxM = 40): LogicalJunction | null {
  let best: LogicalJunction | null = null, bestD = maxM;
  for (const j of js) {
    const d = Math.min(distM(j.centre, at), ...j.nodeIds.map(id => distM(net.nodes.get(id)!.coordinates, at)));
    if (d < bestD) { bestD = d; best = j; }
  }
  return best;
}

/** The logical junction a road belongs to: one of its pieces is inside the junction, or (when `ends`) it enters or leaves it. */
export function junctionsOfRoad(js: readonly LogicalJunction[], roadId: string, ends = true): LogicalJunction[] {
  return js.filter(j => j.internalRoadIds.includes(roadId) || (ends && [...j.approaches, ...j.exits].some(a => a.roadIds.includes(roadId))));
}

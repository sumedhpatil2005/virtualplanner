import type { StudyArea, DrivableObject } from './StudyAreaExplorer';
import type { MicroDemandTrip, VehicleKind } from './TrafficMicroSim';
import { VEHICLE_TYPES } from './TrafficMicroSim';
import { midblockCapacityPcu } from './roadParameters';
import { indoHcmSaturationFlow } from './signalTiming';
import { RESTRICTED_ENTRY_S, isAccessRestricted } from './accessRestriction';
import { compileJunctionEdits, armGreenRatio, connectedEntryLanes, turnBansFor, cycleOf, type JunctionEditSpec, type CompiledJunction, type TurnBans } from './junctionControl';
import { STARTUP_LOST_S } from './signalTiming';

/**
 * Area-wide static traffic assignment (deterministic user equilibrium).
 *
 * Why (docs/OVERHAUL.md §9): the micro-simulator alone cannot carry a 2 km
 * study area's demand. Little's law puts about 28,000 veh/h x 9 min mean trip
 * time = 4,200 vehicles on the roads at once even with no congestion, against
 * the simulator's 5,000-vehicle limit, so half the demand waited outside the
 * area, the selected road ran nearly empty and every result was "demand
 * exceeds capacity". Route choice also came from one jammed run.
 *
 * The planning-standard answer (Sheffi 1985, Urban Transportation Networks,
 * ch. 5) is used for the whole area: Frank-Wolfe user equilibrium with BPR
 * link costs. It gives every road's volume and volume/capacity ratio, the
 * bottlenecks of the area, where a road's traffic comes from and goes
 * (select-link, from stored path flows) and the demand that crosses any
 * smaller sub-area, deterministically and in seconds. The micro-simulator is
 * then run on the neighbourhood of the selected road only (analysisJob.ts),
 * fed by the paths this assignment sends through it, where queues, signals
 * and spill-back are modelled vehicle by vehicle.
 *
 * Link cost: t = t0 (1 + 0.15 (x/c)^4) (BPR 1964, Traffic Assignment Manual),
 * t0 = length / free-flow speed + uniform signal delay at a signalised
 * approach (Webster: C (1 - g/C)^2 / 2). Capacity c in PCU/h = the smaller of
 * the IRC:106-1990 mid-block capacity and the stop-line capacity of a
 * signalised approach (Indo-HCM width-based saturation flow x g/C). Flows are
 * in PCU (IRC:106 factors of VEHICLE_TYPES); vehicles are carried alongside.
 * Not modelled here: queues and spill-back (a link over capacity just costs
 * more), turn bans, signal coordination. Those are what the corridor
 * micro-simulation is for.
 *
 * Access restrictions (docs/OVERHAUL.md §17): a road OpenStreetMap tags as
 * not open to the public (access, vehicle or motor_vehicle = private,
 * destination, delivery, customers, permit, residents; a campus or gated
 * service road) is used only at the start or the end of a trip, never as a
 * through route. This is the OSRM car profile's routability rule (a turn from
 * an unrestricted onto a restricted way costs max_turn_weight): entering a
 * restricted run from a public road costs RESTRICTED_ENTRY_S, a prohibitive
 * but finite cost, so a trip that can only reach its destination through one
 * still gets a route.
 */

export const BPR_ALPHA = 0.15;
export const BPR_BETA = 4;
/** Assumed cycle and lost time per phase for signalised approaches in the assignment (s). The corridor simulation times signals by Webster. */
export const ASSIGN_CYCLE_S = 120;
export const ASSIGN_LOST_PER_PHASE_S = 4;
export { RESTRICTED_ACCESS, RESTRICTED_ENTRY_S, isAccessRestricted } from './accessRestriction';
/** A signal belongs to a node within this distance (m), as in the micro-simulator. */
const SIGNAL_MATCH_M = 35;
const LANE_WIDTH_M = 3.5;

const PCU: Record<string, number> = Object.fromEntries(VEHICLE_TYPES.map(t => [t.kind, t.pcu]));

export interface AssignLink {
  index: number;
  id: string;
  segmentKey: string;
  roadId: string;
  from: number;
  to: number;
  lengthM: number;
  lanes: number;
  /** Free-flow running time plus uniform signal delay (s). */
  t0: number;
  freeSpeedKmh: number;
  midblockPcu: number;
  /** Stop-line capacity at a signalised approach (PCU/h), else null. */
  stopLinePcu: number | null;
  gC: number | null;
  capacityPcu: number;
  /** On a road open only for local access (isAccessRestricted): usable at the start or end of a trip, not through. */
  restricted: boolean;
}

export interface AssignOd { from: number; to: number; veh: number; pcu: number; kinds: Map<VehicleKind, number> }

export interface AssignmentResult {
  nodes: string[];
  nodeCoords: [number, number, number][];
  links: AssignLink[];
  volPcu: Float64Array;
  volVeh: Float64Array;
  timeS: Float64Array;
  ods: AssignOd[];
  /** Path table (link indices) and, per OD, its paths with their share of the OD flow. */
  paths: Int32Array[];
  odPaths: { pathId: number; share: number }[][];
  iterations: number;
  relativeGap: number;
  gapHistory: number[];
  unroutedVeh: number;
  elapsedMs: number;
}

export interface AssignmentOptions {
  signalPoints?: readonly (readonly [number, number])[];
  /** Edits to imported junctions (junctionControl.ts): their signal plans, connected lanes and banned turns. */
  junctionEdits?: readonly JunctionEditSpec[];
  maxIterations?: number;
  targetGap?: number;
  /** Stop after this long (ms) and report the gap reached. */
  maxMs?: number;
}

const M_PER_DEG_LAT = 111320;
const distM = (a: readonly number[], b: readonly number[]) =>
  Math.hypot((a[0] - b[0]) * M_PER_DEG_LAT * Math.cos(a[1] * Math.PI / 180), (a[1] - b[1]) * M_PER_DEG_LAT);
const segKey = (id: string) => id.replace(/_(fwd|bwd)$/, '');

export const bprTime = (t0: number, x: number, c: number) => t0 * (1 + BPR_ALPHA * Math.pow(Math.max(0, x) / Math.max(1, c), BPR_BETA));

/** The area's links as an assignment network, with free-flow times and capacities. */
export function buildAssignmentNetwork(area: StudyArea, roads: ReadonlyMap<string, DrivableObject>, signalPoints?: readonly (readonly [number, number])[], junctionEdits?: readonly JunctionEditSpec[]) {
  const included = new Set(area.segments.map(s => s.key));
  const edges = [...area.network.edges.values()].filter(e => included.has(segKey(e.id)));
  const nodeIndex = new Map<string, number>();
  const nodes: string[] = [];
  const nodeCoords: [number, number, number][] = [];
  const idx = (id: string) => {
    let i = nodeIndex.get(id);
    if (i === undefined) { i = nodes.length; nodeIndex.set(id, i); nodes.push(id); nodeCoords.push([...(area.network.nodes.get(id)?.coordinates ?? [0, 0, 0])] as [number, number, number]); }
    return i;
  };
  // Signalised nodes: within SIGNAL_MATCH_M of a mapped signal and where 3+ distinct stretches meet
  const arms = new Map<string, Set<string>>();
  for (const e of edges) for (const n of [e.fromNodeId, e.toNodeId]) (arms.get(n) ?? arms.set(n, new Set()).get(n)!).add(segKey(e.id));
  const signalNear = (id: string) => {
    if (!signalPoints?.length) return false;
    const c = area.network.nodes.get(id)?.coordinates;
    if (!c) return false;
    return signalPoints.some(p => distM(p, c) < SIGNAL_MATCH_M);
  };
  // Edited junctions (docs/OVERHAUL.md §23) are controlled as edited, not by the mapped signals
  const compiled = compileJunctionEdits(area.network, junctionEdits);
  const editedAt = new Map<string, CompiledJunction>();
  for (const c of compiled) for (const n of c.nodeIds) editedAt.set(n, c);
  const signalised = new Set<string>();
  for (const [id, s] of arms) if (!editedAt.has(id) && s.size >= 3 && signalNear(id)) signalised.add(id);
  // Approaches per signalised node: links ending there whose start is not itself signalised (not an internal link of the junction)
  const approaches = new Map<string, number>();
  for (const e of edges) if (signalised.has(e.toNodeId) && !signalised.has(e.fromNodeId)) approaches.set(e.toNodeId, (approaches.get(e.toNodeId) ?? 0) + 1);

  const links: AssignLink[] = edges.map((e, index) => {
    const road = roads.get(e.roadId);
    const lanes = Math.max(1, e.lanes || 1);
    const oneWay = road?.type === 'road' ? !!road.isOneWay : true;
    const hw = road?.type === 'road' ? road.osmProvenance?.originalTags?.highway ?? '' : '';
    // One-way main roads are taken to be carriageways of divided roads (OSM maps those as two one-way ways); one-way minor roads as one-way streets (assumption)
    const divided = oneWay && /^(motorway|trunk|primary|secondary)/.test(hw);
    const midblockPcu = midblockCapacityPcu(road, lanes, !oneWay, divided);
    const speed = Math.max(10, e.speedLimit || 30);
    let stopLinePcu: number | null = null, gC: number | null = null, sigDelay = 0;
    const edited = editedAt.get(e.toNodeId);
    if (edited) {
      // An approach of an edited signal: its green from the plan (effective green = green + amber - start-up lost time, per phase serving it),
      // saturation flow from the entry lanes that feed an exit
      const arm = edited.nodeIds.has(e.fromNodeId) ? undefined : edited.approachOfEdge.get(e.id) ?? edited.chainOfEdge.get(e.id);
      const plan = edited.spec.signal;
      const ratio = arm ? armGreenRatio(edited, arm) : null;
      if (arm && plan && ratio !== null) {
        const cyc = cycleOf(plan);
        const phasesServing = plan.phases.filter(p => p.arms.includes(arm)).length;
        gC = Math.max(0.02, Math.min(1, ratio + phasesServing * (plan.amberS - STARTUP_LOST_S) / cyc));
        stopLinePcu = indoHcmSaturationFlow(connectedEntryLanes(edited.spec, arm, lanes) * LANE_WIDTH_M) * gC;
        sigDelay = cyc * (1 - gC) ** 2 / 2;
      }
    } else if (signalised.has(e.toNodeId) && !signalised.has(e.fromNodeId)) {
      const n = Math.min(4, Math.max(2, approaches.get(e.toNodeId) ?? 2));
      gC = Math.max(0.1, (ASSIGN_CYCLE_S - n * ASSIGN_LOST_PER_PHASE_S) / ASSIGN_CYCLE_S / n);
      stopLinePcu = indoHcmSaturationFlow(lanes * LANE_WIDTH_M) * gC;
      sigDelay = ASSIGN_CYCLE_S * (1 - gC) ** 2 / 2;
    }
    const t0 = e.length / (speed / 3.6) + sigDelay;
    return { index, id: e.id, segmentKey: segKey(e.id), roadId: e.roadId, from: idx(e.fromNodeId), to: idx(e.toNodeId), lengthM: e.length, lanes,
      t0, freeSpeedKmh: speed, midblockPcu, stopLinePcu, gC, capacityPcu: Math.min(midblockPcu, stopLinePcu ?? Infinity), restricted: isAccessRestricted(road) };
  });
  // Outgoing links per node (CSR)
  const outStart = new Int32Array(nodes.length + 1);
  for (const l of links) outStart[l.from + 1]++;
  for (let i = 0; i < nodes.length; i++) outStart[i + 1] += outStart[i];
  const outLinks = new Int32Array(links.length);
  const fill = outStart.slice(0, nodes.length);
  for (const l of links) outLinks[fill[l.from]++] = l.index;
  // Banned turns of edited junctions, over the numbered graph
  const bans = turnBansFor(compiled, nodes, links.map(l => l.id), Int32Array.from(links, l => l.from), Int32Array.from(links, l => l.to));
  return { nodes, nodeIndex, nodeCoords, links, outStart, outLinks, signalised, bans: bans && !bans.empty ? bans : null };
}

class Heap {
  private k = new Float64Array(1024); private v = new Int32Array(1024); size = 0;
  push(key: number, val: number) {
    if (this.size === this.k.length) { const k = new Float64Array(this.size * 2); k.set(this.k); this.k = k; const v = new Int32Array(this.size * 2); v.set(this.v); this.v = v; }
    let i = this.size++;
    while (i > 0) { const p = (i - 1) >> 1; if (this.k[p] <= key) break; this.k[i] = this.k[p]; this.v[i] = this.v[p]; i = p; }
    this.k[i] = key; this.v[i] = val;
  }
  pop(): number {
    const top = this.v[0], key = this.k[--this.size], val = this.v[this.size];
    let i = 0;
    for (;;) { let c = 2 * i + 1; if (c >= this.size) break; if (c + 1 < this.size && this.k[c + 1] < this.k[c]) c++; if (this.k[c] >= key) break; this.k[i] = this.k[c]; this.v[i] = this.v[c]; i = c; }
    this.k[i] = key; this.v[i] = val;
    return top;
  }
  topKey() { return this.k[0]; }
}

/**
 * Frank-Wolfe user-equilibrium assignment of the trips on the area network.
 * Deterministic: the same inputs give the same flows.
 */
export function assignTraffic(area: StudyArea, roads: ReadonlyMap<string, DrivableObject>, trips: readonly MicroDemandTrip[], o: AssignmentOptions = {}): AssignmentResult {
  const t0 = Date.now();
  const net = buildAssignmentNetwork(area, roads, o.signalPoints, o.junctionEdits);
  const { links, outStart, outLinks, nodes } = net;
  const L = links.length, N = nodes.length;
  // OD pairs (by node), vehicles and PCU, kinds kept for the corridor demand
  const odIndex = new Map<string, number>();
  const ods: AssignOd[] = [];
  let unroutedVeh = 0;
  for (const t of trips) {
    const f = net.nodeIndex.get(t.fromNodeId), d = net.nodeIndex.get(t.toNodeId);
    if (f === undefined || d === undefined || f === d) { unroutedVeh += t.vehiclesPerHour; continue; }
    const key = f + '>' + d;
    let i = odIndex.get(key);
    if (i === undefined) { i = ods.length; odIndex.set(key, i); ods.push({ from: f, to: d, veh: 0, pcu: 0, kinds: new Map() }); }
    const od = ods[i];
    od.veh += t.vehiclesPerHour; od.pcu += t.vehiclesPerHour * (PCU[t.kind] ?? 1);
    od.kinds.set(t.kind, (od.kinds.get(t.kind) ?? 0) + t.vehiclesPerHour);
  }
  const byOrigin = new Map<number, number[]>();
  ods.forEach((od, i) => (byOrigin.get(od.from) ?? byOrigin.set(od.from, []).get(od.from)!).push(i));
  const origins = [...byOrigin.keys()];

  const x = new Float64Array(L), xv = new Float64Array(L), y = new Float64Array(L), yv = new Float64Array(L), cost = new Float64Array(L);
  // Search states per node: 0 = on public roads, 1 = on a restricted run entered at the trip's start or paid for
  const S = links.some(l => l.restricted) ? 2 : 1;
  const restricted = Uint8Array.from(links, l => (l.restricted ? 1 : 0));
  const dist = new Float64Array(N * S), pred = new Int32Array(N * S), predState = new Int32Array(N * S);
  const cap = links.map(l => l.capacityPcu), base = links.map(l => l.t0);
  const pathKey = new Map<string, number>();
  const paths: Int32Array[] = [];
  const odPaths: Map<number, number>[] = ods.map(() => new Map());
  const reachable = new Uint8Array(ods.length);
  const heap = new Heap();
  const scratch: number[] = [];

  // With banned turns the search runs over (node, restricted run, link the path entered a junction by): see turnSearch
  const turnSearch = net.bans ? bannedTurnSearch(net.bans, N, S, links, outStart, outLinks) : null;
  /** All-or-nothing load on the current costs; returns each OD's path id (or -1). */
  const allOrNothing = (target: Float64Array, targetVeh: Float64Array): Int32Array => {
    target.fill(0); targetVeh.fill(0);
    if (turnSearch) {
      const chosen = new Int32Array(ods.length).fill(-1);
      for (const orig of origins) {
        const tree = turnSearch(orig, cost);
        for (const oi of byOrigin.get(orig)!) {
          const od = ods[oi];
          const p = tree(od.to);
          if (!p) continue;
          reachable[oi] = 1;
          for (const li of p) { target[li] += od.pcu; targetVeh[li] += od.veh; }
          const key = p.join(',');
          let pid = pathKey.get(key);
          if (pid === undefined) { pid = paths.length; pathKey.set(key, pid); paths.push(Int32Array.from(p)); }
          chosen[oi] = pid;
        }
      }
      return chosen;
    }
    const chosen = new Int32Array(ods.length).fill(-1);
    for (const orig of origins) {
      dist.fill(Infinity); pred.fill(-1);
      // A trip starts on a restricted run only where every road out of its origin is restricted (it starts inside)
      let startState = 0;
      if (S === 2 && outStart[orig + 1] > outStart[orig]) {
        startState = 1;
        for (let k = outStart[orig]; k < outStart[orig + 1]; k++) if (!restricted[outLinks[k]]) { startState = 0; break; }
      }
      const start = orig * S + startState;
      dist[start] = 0; heap.size = 0; heap.push(0, start);
      while (heap.size) {
        const dk = heap.topKey(), us = heap.pop();
        if (dk > dist[us]) continue;
        const u = S === 2 ? us >> 1 : us, inRestricted = S === 2 && (us & 1) === 1;
        for (let k = outStart[u]; k < outStart[u + 1]; k++) {
          const li = outLinks[k], r = restricted[li];
          const vs = links[li].to * S + r;
          const nd = dk + cost[li] + (r && !inRestricted ? RESTRICTED_ENTRY_S : 0);
          if (nd < dist[vs]) { dist[vs] = nd; pred[vs] = li; predState[vs] = us; heap.push(nd, vs); }
        }
      }
      for (const oi of byOrigin.get(orig)!) {
        const od = ods[oi];
        let end = od.to * S;
        if (S === 2 && dist[end + 1] < dist[end]) end++;
        if (!Number.isFinite(dist[end])) continue;
        reachable[oi] = 1;
        scratch.length = 0;
        for (let vs = end; vs !== start; vs = predState[vs]) scratch.push(pred[vs]);
        scratch.reverse();
        for (const li of scratch) { target[li] += od.pcu; targetVeh[li] += od.veh; }
        const key = scratch.join(',');
        let pid = pathKey.get(key);
        if (pid === undefined) { pid = paths.length; pathKey.set(key, pid); paths.push(Int32Array.from(scratch)); }
        chosen[oi] = pid;
      }
    }
    return chosen;
  };
  const setCosts = (flow: Float64Array) => { for (let i = 0; i < L; i++) cost[i] = bprTime(base[i], flow[i], cap[i]); };

  // Initial all-or-nothing on free-flow costs
  setCosts(x);
  const first = allOrNothing(x, xv);
  first.forEach((pid, oi) => { if (pid >= 0) odPaths[oi].set(pid, 1); });
  const maxIt = o.maxIterations ?? 60, targetGap = o.targetGap ?? 1e-3, maxMs = o.maxMs ?? 20000;
  const gapHistory: number[] = [];
  let it = 0, gap = Infinity;
  for (it = 1; it <= maxIt; it++) {
    setCosts(x);
    const chosen = allOrNothing(y, yv);
    // Relative gap: (current total cost - shortest-path cost) / current total cost
    let tc = 0, sp = 0;
    for (let i = 0; i < L; i++) { tc += x[i] * cost[i]; sp += y[i] * cost[i]; }
    gap = tc > 0 ? (tc - sp) / tc : 0;
    gapHistory.push(gap);
    if (gap < targetGap || Date.now() - t0 > maxMs) break;
    // Line search (bisection on the derivative of the Beckmann objective)
    let lo = 0, hi = 1;
    for (let s = 0; s < 24; s++) {
      const m = (lo + hi) / 2;
      let g = 0;
      for (let i = 0; i < L; i++) { const d = y[i] - x[i]; if (d !== 0) g += d * bprTime(base[i], x[i] + m * d, cap[i]); }
      if (g > 0) hi = m; else lo = m;
    }
    const lambda = (lo + hi) / 2;
    if (lambda <= 1e-9) break;
    for (let i = 0; i < L; i++) { x[i] += lambda * (y[i] - x[i]); xv[i] += lambda * (yv[i] - xv[i]); }
    chosen.forEach((pid, oi) => {
      if (pid < 0) return;
      const m = odPaths[oi];
      m.forEach((w, k) => m.set(k, w * (1 - lambda)));
      m.set(pid, (m.get(pid) ?? 0) + lambda);
    });
  }
  setCosts(x);
  ods.forEach((od, oi) => { if (!reachable[oi]) unroutedVeh += od.veh; });
  return {
    nodes, nodeCoords: net.nodeCoords, links, volPcu: x, volVeh: xv, timeS: Float64Array.from(cost), ods,
    paths, odPaths: odPaths.map(m => [...m].filter(([, w]) => w > 1e-4).map(([pathId, share]) => ({ pathId, share }))),
    iterations: Math.min(it, maxIt), relativeGap: gap, gapHistory, unroutedVeh, elapsedMs: Date.now() - t0,
  };
}

/**
 * One-to-all shortest paths that make no banned turn (TurnBans), with the same
 * restricted-run rule as the plain search. States: per node, S restricted
 * states times (1 + the junction's entry links that take part in a ban); only
 * nodes of junctions with bans get more than S. Returns a function from an
 * origin and the link costs to a path lookup by destination.
 */
function bannedTurnSearch(bans: TurnBans, N: number, S: number, links: readonly AssignLink[], outStart: Int32Array, outLinks: Int32Array) {
  const L = links.length;
  // Entry links per junction (those in a banned pair), numbered within the junction
  const entryLocal = new Map<number, number>();
  const entriesOf = new Map<number, number[]>();
  for (const key of bans.banned) {
    const a = Math.floor(key / L);
    const k = bans.nodeJunction[links[a].to];
    const list = entriesOf.get(k) ?? entriesOf.set(k, []).get(k)!;
    if (!entryLocal.has(a)) { entryLocal.set(a, list.length); list.push(a); }
  }
  const width = new Int32Array(N), base = new Int32Array(N + 1);
  for (let n = 0; n < N; n++) { const k = bans.nodeJunction[n]; width[n] = 1 + (k >= 0 ? entriesOf.get(k)?.length ?? 0 : 0); base[n + 1] = base[n] + S * width[n]; }
  const total = base[N];
  const stateNode = new Int32Array(total), stateR = new Uint8Array(total), stateE = new Int32Array(total);
  for (let n = 0; n < N; n++) for (let r = 0; r < S; r++) for (let e = 0; e < width[n]; e++) { const st = base[n] + r * width[n] + e; stateNode[st] = n; stateR[st] = r; stateE[st] = e - 1; }
  const restricted = Uint8Array.from(links, l => (l.restricted ? 1 : 0));
  const dist = new Float64Array(total), pred = new Int32Array(total), predState = new Int32Array(total);
  const heap = new Heap();
  return (orig: number, cost: Float64Array) => {
    dist.fill(Infinity); pred.fill(-1);
    let startR = 0;
    if (S === 2 && outStart[orig + 1] > outStart[orig]) {
      startR = 1;
      for (let k = outStart[orig]; k < outStart[orig + 1]; k++) if (!restricted[outLinks[k]]) { startR = 0; break; }
    }
    const start = base[orig] + startR * width[orig];
    dist[start] = 0; heap.size = 0; heap.push(0, start);
    while (heap.size) {
      const dk = heap.topKey(), us = heap.pop();
      if (dk > dist[us]) continue;
      const u = stateNode[us], inRestricted = S === 2 && stateR[us] === 1;
      const eLocal = stateE[us], ku = bans.nodeJunction[u];
      const entry = eLocal >= 0 ? entriesOf.get(ku)![eLocal] : -1;
      for (let k = outStart[u]; k < outStart[u + 1]; k++) {
        const li = outLinks[k];
        const ne = bans.step(entry, li);
        if (ne === -2) continue;
        const v = links[li].to, r = S === 2 ? restricted[li] : 0;
        const local = ne >= 0 ? entryLocal.get(ne) ?? -1 : -1;
        const vs = base[v] + r * width[v] + (local + 1 < width[v] ? local + 1 : 0);
        const nd = dk + cost[li] + (r && !inRestricted ? RESTRICTED_ENTRY_S : 0);
        if (nd < dist[vs]) { dist[vs] = nd; pred[vs] = li; predState[vs] = us; heap.push(nd, vs); }
      }
    }
    return (to: number): number[] | null => {
      let end = -1;
      for (let st = base[to]; st < base[to + 1]; st++) if (dist[st] < (end < 0 ? Infinity : dist[end])) end = st;
      if (end < 0 || !Number.isFinite(dist[end])) return null;
      const p: number[] = [];
      for (let vs = end; vs !== start; vs = predState[vs]) p.push(pred[vs]);
      return p.reverse();
    };
  };
}

/** Per link, the share of its stored path flow, for links in `linkSet`: who uses them (select-link analysis). */
export function selectLink(res: AssignmentResult, linkSet: ReadonlySet<number>) {
  const linkVeh = new Float64Array(res.links.length);
  const byOd: { od: number; veh: number }[] = [];
  res.odPaths.forEach((ps, oi) => {
    let veh = 0;
    for (const { pathId, share } of ps) {
      const p = res.paths[pathId];
      let uses = false;
      for (const li of p) if (linkSet.has(li)) { uses = true; break; }
      if (!uses) continue;
      const f = share * res.ods[oi].veh;
      veh += f;
      for (const li of p) linkVeh[li] += f;
    }
    if (veh > 0) byOd.push({ od: oi, veh });
  });
  return { linkVeh, byOd };
}

/**
 * The demand that crosses a sub-area: every stored path cut to its runs of
 * links inside `insideSegments`, as trips from where it enters to where it
 * leaves (coordinates, so they snap onto the sub-area's own network), with
 * the links it takes inside. Vehicle kinds keep their OD shares.
 */
export function subareaDemand(res: AssignmentResult, insideSegments: ReadonlySet<string>, hourFactor = 1) {
  const agg = new Map<string, { from: number; to: number; via: number[]; kinds: Map<VehicleKind, number> }>();
  res.odPaths.forEach((ps, oi) => {
    const od = res.ods[oi];
    for (const { pathId, share } of ps) {
      const p = res.paths[pathId];
      let run: number[] = [];
      const flush = () => {
        if (!run.length) return;
        const from = res.links[run[0]].from, to = res.links[run[run.length - 1]].to;
        const key = run.join(',');
        const e = agg.get(key) ?? agg.set(key, { from, to, via: [...run], kinds: new Map() }).get(key)!;
        od.kinds.forEach((v, k) => e.kinds.set(k, (e.kinds.get(k) ?? 0) + v * share * hourFactor));
        run = [];
      };
      for (const li of p) { if (insideSegments.has(res.links[li].segmentKey)) run.push(li); else flush(); }
      flush();
    }
  });
  const trips: { from: [number, number, number]; to: [number, number, number]; vehiclesPerHour: number; kind: VehicleKind; viaLinkIds: string[] }[] = [];
  for (const e of agg.values()) {
    if (e.from === e.to) continue;
    e.kinds.forEach((vph, kind) => { if (vph > 1e-3) trips.push({ from: res.nodeCoords[e.from], to: res.nodeCoords[e.to], vehiclesPerHour: vph, kind, viaLinkIds: e.via.map(i => res.links[i].id) }); });
  }
  return trips;
}

import type { TrafficNetwork } from '../objects/trafficTypes';
import type { JunctionObject } from '../objects/types';
import type { LogicalJunction, JunctionArm } from './junctionGroups';
import { nodeKey, inKey, outKey } from './junctionGroups';

/**
 * Edits to an imported (OpenStreetMap) junction as a whole (docs/OVERHAUL.md §23):
 * how it is controlled, its signal plan, which approaches are major, which
 * movements are banned and which entry lanes feed which exit lanes.
 *
 * An edit is stored on the scenario as a junction object (`importedJunction`),
 * keyed by the logical junction's stable id (from the OSM node positions of its
 * members), so it is saved, keyed into the network, undone and redone like any
 * other Build edit. It holds its own copy of the junction's arms (the stretches
 * entering and leaving, by road and node), so it can be matched to any network
 * built from the same roads, the whole city or a study area.
 *
 * The engine reads the compiled form: the area assignment (signal green
 * ratios, stop-line capacity from the connected lanes, banned turns in route
 * search) and the micro-simulation (control, fixed-time plan, priority,
 * banned turns in routing, lane connections at the stop line).
 */

export type JunctionControlKind = 'none' | 'priority' | 'signal';

export interface JunctionEditArm {
  id: string;
  kind: 'in' | 'out';
  label: string;
  /** inKey (approach) / outKey (exit) of its stretches. */
  keys: string[];
  /** Pieces further out along the same road through plain nodes (matched when a network folded the first piece). */
  chainKeys: string[];
  lanes: number;
}

export interface SignalPhase {
  greenS: number;
  /** Approach arm ids that have green in this phase. */
  arms: string[];
}

export interface SignalPlan {
  amberS: number;
  allRedS: number;
  phases: SignalPhase[];
}

export interface JunctionEditSpec {
  junctionId: string;
  label: string;
  nodeKeys: string[];
  arms: JunctionEditArm[];
  control: JunctionControlKind;
  /**
   * The control and timing are what the engine ran here by itself (the
   * editor's starting values, untouched): the engine keeps its own control
   * (mapped or estimated signals, Webster timing, priority by road class) and
   * only the bans and lane connections apply, so applying the starting values
   * changes nothing. Any change to the control, plan or major approaches clears it.
   */
  asRun?: boolean;
  signal?: SignalPlan;
  /** Approach arms with priority (control 'priority'). */
  majorArms?: string[];
  /** "approachArmId>exitArmId" movements nobody may make. */
  bannedMovements?: string[];
  /** Per movement "approachArmId>exitArmId": [entry lane, exit lane] pairs, lane 0 on the median side. Absent: the engine's default (lanes in order). */
  laneConnections?: Record<string, [number, number][]>;
}

/** Signal defaults: the micro-simulator's (TrafficMicroSim SIGNAL_GREEN_S, SIGNAL_AMBER_S, SIGNAL_ALL_RED_S). */
export const DEFAULT_GREEN_S = 25;
export const DEFAULT_AMBER_S = 3;
export const DEFAULT_ALL_RED_S = 2;
export const MIN_GREEN_EDIT_S = 5;
export const MAX_CYCLE_EDIT_S = 300;

export const cycleOf = (plan: SignalPlan) => plan.phases.reduce((n, p) => n + p.greenS + plan.amberS + plan.allRedS, 0);

/** Green time (s) an approach gets per cycle: the sum over the phases that serve it. */
export const armGreenS = (plan: SignalPlan, armId: string) => plan.phases.reduce((n, p) => n + (p.arms.includes(armId) ? p.greenS : 0), 0);

const armOf = (a: JunctionArm): JunctionEditArm => ({ id: a.id, kind: a.kind, label: a.label, keys: [...a.keys], chainKeys: [...a.chainKeys], lanes: a.lanes });

/**
 * The editor's starting values: what the engine does at this junction by
 * itself, as an editable spec marked `asRun` (applying it unchanged keeps the
 * engine's own control, so the results are identical).
 *  - `lastRun` with a plan (junctionDraft.lastRunControl): the signal plan the
 *    last analysis ran, greens as run, approaches no signal held always green;
 *  - `lastRun` without a plan: the run had no signal here: priority to the
 *    highest-class approaches;
 *  - no `lastRun`: a mapped signal gives one phase per approach (the
 *    simulator's approach-wise plan: 25 s green, 3 s amber, 2 s all-red, which
 *    it retimes by Webster from its flows); otherwise priority.
 * Once the plan is changed it runs as entered (fixed time, not retimed).
 */
export function defaultEdit(j: LogicalJunction, lastRun?: { plan: SignalPlan | null } | null): JunctionEditSpec {
  const topRank = Math.max(0, ...j.approaches.map(a => a.rank));
  const major = j.approaches.filter(a => a.rank === topRank).map(a => a.id);
  const approachWise: SignalPlan = { amberS: DEFAULT_AMBER_S, allRedS: DEFAULT_ALL_RED_S, phases: j.approaches.map(a => ({ greenS: DEFAULT_GREEN_S, arms: [a.id] })) };
  const signal = lastRun?.plan ? structuredClone(lastRun.plan) : approachWise;
  const control: JunctionControlKind = lastRun ? (lastRun.plan ? 'signal' : 'priority') : j.signalised ? 'signal' : 'priority';
  return {
    junctionId: j.id, label: j.label, nodeKeys: [...j.nodeKeys], arms: [...j.approaches, ...j.exits].map(armOf),
    control, asRun: true, signal, majorArms: major, bannedMovements: [], laneConnections: {},
  };
}

/** Problems that stop an edit being applied (empty when it can be). */
export function validateEdit(e: JunctionEditSpec): string[] {
  const out: string[] = [];
  if (e.control === 'signal') {
    const plan = e.signal;
    if (!plan || plan.phases.length === 0) out.push('A signal needs at least one phase.');
    else {
      const approaches = e.arms.filter(a => a.kind === 'in');
      for (const a of approaches) if (!plan.phases.some(p => p.arms.includes(a.id))) out.push(`${a.label} has no green in any phase.`);
      if (plan.phases.some(p => !(p.greenS >= MIN_GREEN_EDIT_S))) out.push(`Each green must be at least ${MIN_GREEN_EDIT_S} s.`);
      if (!(plan.amberS >= 0) || !(plan.allRedS >= 0)) out.push('Amber and all-red cannot be negative.');
      if (cycleOf(plan) > MAX_CYCLE_EDIT_S) out.push(`The cycle is over ${MAX_CYCLE_EDIT_S} s.`);
    }
  }
  if (e.control === 'priority' && !(e.majorArms?.length)) out.push('Pick at least one major approach, or choose no control.');
  return out;
}

// ── Compiled against a network ──────────────────────────────────────────────

export interface CompiledJunction {
  spec: JunctionEditSpec;
  nodeIds: Set<string>;
  /** Network stretches entering (approach) or leaving (exit) the junction, with their arm. */
  approachOfEdge: Map<string, string>;
  exitOfEdge: Map<string, string>;
  /** Upstream pieces of approaches / downstream pieces of exits (through plain nodes), with their arm. */
  chainOfEdge: Map<string, string>;
  internalEdges: Set<string>;
  bannedArmPairs: Set<string>;
  /** The engine keeps its own control here (spec.asRun): only bans and lane connections apply. */
  controlAsRun: boolean;
}

/** Matches each edit to the network: its member nodes (by OSM node position) and the stretches of its arms. Edits whose nodes are not in the network are left out. */
export function compileJunctionEdits(net: TrafficNetwork, edits: readonly JunctionEditSpec[] | undefined): CompiledJunction[] {
  if (!edits?.length) return [];
  const nodesByKey = new Map<string, string[]>();
  for (const [id, n] of net.nodes) { const k = nodeKey(n.coordinates); (nodesByKey.get(k) ?? nodesByKey.set(k, []).get(k)!).push(id); }
  const out: CompiledJunction[] = [];
  for (const spec of edits) {
    const nodeIds = new Set(spec.nodeKeys.flatMap(k => nodesByKey.get(k) ?? []));
    if (!nodeIds.size) continue;
    const armByKey = new Map<string, string>(), chainByKey = new Map<string, string>();
    for (const a of spec.arms) { for (const k of a.keys) armByKey.set(k, a.id); for (const k of a.chainKeys) chainByKey.set(k, a.id); }
    const approachOfEdge = new Map<string, string>(), exitOfEdge = new Map<string, string>(), chainOfEdge = new Map<string, string>(), internalEdges = new Set<string>();
    for (const e of net.edges.values()) {
      const fi = nodeIds.has(e.fromNodeId), ti = nodeIds.has(e.toNodeId);
      if (fi && ti) { internalEdges.add(e.id); continue; }
      if (ti) { const a = armByKey.get(inKey(net, e)); if (a) approachOfEdge.set(e.id, a); }
      else if (fi) { const a = armByKey.get(outKey(net, e)); if (a) exitOfEdge.set(e.id, a); }
      else {
        const a = chainByKey.get(inKey(net, e)) ?? chainByKey.get(outKey(net, e));
        if (a) chainOfEdge.set(e.id, a);
      }
    }
    out.push({ spec, nodeIds, approachOfEdge, exitOfEdge, chainOfEdge, internalEdges, bannedArmPairs: new Set(spec.bannedMovements ?? []), controlAsRun: !!spec.asRun });
  }
  return out;
}

/** Green ratio g/C of an approach arm (signal control), or null. */
export function armGreenRatio(c: CompiledJunction, armId: string): number | null {
  const plan = c.spec.signal;
  if (c.controlAsRun || c.spec.control !== 'signal' || !plan) return null;
  const cyc = cycleOf(plan);
  return cyc > 0 ? armGreenS(plan, armId) / cyc : null;
}

/** Entry lanes of an approach that feed any exit (lanes are listed per movement; a movement without a list uses every lane). */
export function connectedEntryLanes(spec: JunctionEditSpec, armId: string, lanes: number): number {
  const lc = spec.laneConnections ?? {};
  const moves = Object.keys(lc).filter(k => k.startsWith(`${armId}>`) && !(spec.bannedMovements ?? []).includes(k));
  if (!moves.length) return lanes;
  // Movements of this approach not listed use every lane
  const exits = spec.arms.filter(a => a.kind === 'out').map(a => `${armId}>${a.id}`).filter(k => !(spec.bannedMovements ?? []).includes(k));
  if (exits.some(k => !(k in lc))) return lanes;
  const used = new Set<number>();
  for (const k of moves) for (const [i] of lc[k]) if (i >= 0 && i < lanes) used.add(i);
  return Math.max(1, used.size);
}

// ── Banned turns in route search ───────────────────────────────────────────

/**
 * Turn bans over a numbered graph (nodes and links as integers), for the
 * routers of the assignment and the micro-simulation. A banned movement is a
 * pair (link entering a junction, link leaving it), possibly with internal
 * pieces between, so the search carries the link a path entered the junction
 * by while it is inside.
 */
export class TurnBans {
  readonly L: number;
  /** Junction index of each node, or -1. */
  readonly nodeJunction: Int32Array;
  readonly banned: Set<number>;
  readonly linkFrom: Int32Array;
  readonly linkTo: Int32Array;

  constructor(nodeCount: number, linkFrom: Int32Array, linkTo: Int32Array, nodeJunction: Int32Array, bannedPairs: readonly [number, number][]) {
    this.linkFrom = linkFrom;
    this.linkTo = linkTo;
    this.L = linkFrom.length;
    this.nodeJunction = nodeJunction.length === nodeCount ? nodeJunction : new Int32Array(nodeCount).fill(-1);
    this.banned = new Set(bannedPairs.map(([a, x]) => a * this.L + x));
  }

  get empty() { return this.banned.size === 0; }

  /** The entry link after taking `link` with entry `entry` (-1 outside a junction), or -2 when the move is banned. */
  step(entry: number, link: number): number {
    const cu = this.nodeJunction[this.linkFrom[link]], cv = this.nodeJunction[this.linkTo[link]];
    if (cu >= 0 && cv !== cu && entry >= 0 && this.banned.has(entry * this.L + link)) return -2;
    if (cv >= 0 && cv !== cu) return link;
    if (cv >= 0 && cv === cu) return entry;
    return -1;
  }

  /** Whether a path (links in order) makes a banned movement. */
  violates(path: readonly number[], startEntry = -1): boolean {
    let e = startEntry;
    for (const l of path) { e = this.step(e, l); if (e === -2) return true; }
    return false;
  }

  /** Fastest path from node to node that makes no banned movement (Dijkstra over (node, entry link)), or null. */
  path(from: number, to: number, outStart: Int32Array, outLinks: Int32Array, cost: Float64Array | ((l: number) => number)): number[] | null {
    const c = typeof cost === 'function' ? cost : (l: number) => cost[l];
    const key = (n: number, e: number) => n * (this.L + 1) + (e + 1);
    const dist = new Map<number, number>(), pred = new Map<number, [number, number]>();
    const heap: [number, number, number][] = [];
    const push = (d: number, n: number, e: number) => {
      heap.push([d, n, e]);
      let i = heap.length - 1;
      while (i > 0) { const p = (i - 1) >> 1; if (heap[p][0] <= heap[i][0]) break; [heap[p], heap[i]] = [heap[i], heap[p]]; i = p; }
    };
    const pop = () => {
      const top = heap[0], last = heap.pop()!;
      if (heap.length) {
        heap[0] = last;
        let i = 0;
        for (;;) { const l = 2 * i + 1, r = l + 1; let m = i; if (l < heap.length && heap[l][0] < heap[m][0]) m = l; if (r < heap.length && heap[r][0] < heap[m][0]) m = r; if (m === i) break; [heap[m], heap[i]] = [heap[i], heap[m]]; i = m; }
      }
      return top;
    };
    dist.set(key(from, -1), 0);
    push(0, from, -1);
    while (heap.length) {
      const [d, u, e] = pop();
      const ku = key(u, e);
      if (d > (dist.get(ku) ?? Infinity)) continue;
      if (u === to) {
        const out: number[] = [];
        for (let k = ku; pred.has(k); ) { const [pk, l] = pred.get(k)!; out.push(l); k = pk; }
        return out.reverse();
      }
      for (let k = outStart[u]; k < outStart[u + 1]; k++) {
        const l = outLinks[k];
        const ne = this.step(e, l);
        if (ne === -2) continue;
        const v = this.linkTo[l], kv = key(v, ne), nd = d + c(l);
        if (nd < (dist.get(kv) ?? Infinity)) { dist.set(kv, nd); pred.set(kv, [ku, l]); push(nd, v, ne); }
      }
    }
    return null;
  }
}

/** Out-links per node in compressed rows. */
export function outRows(nodeCount: number, linkFrom: Int32Array): { outStart: Int32Array; outLinks: Int32Array } {
  const outStart = new Int32Array(nodeCount + 1);
  for (let l = 0; l < linkFrom.length; l++) outStart[linkFrom[l] + 1]++;
  for (let n = 0; n < nodeCount; n++) outStart[n + 1] += outStart[n];
  const outLinks = new Int32Array(linkFrom.length);
  const fill = outStart.slice(0, nodeCount);
  for (let l = 0; l < linkFrom.length; l++) outLinks[fill[linkFrom[l]]++] = l;
  return { outStart, outLinks };
}

/**
 * Builds the turn bans of the compiled junctions over a numbered graph whose
 * links carry network edge ids (`linkIds`) and whose nodes carry node ids
 * (`nodeIds`; a node may stand for several network nodes, as the simulator's
 * joined junctions do: `membersOf`). A link enters a junction when it ends on
 * one of its nodes and starts outside; its arm is found from the stretch or
 * the pieces further out along it.
 */
export function turnBansFor(compiled: readonly CompiledJunction[], nodeIds: readonly string[], linkIds: readonly string[], linkFrom: Int32Array, linkTo: Int32Array,
  membersOf: (nodeId: string) => readonly string[] = id => [id]): TurnBans | null {
  const withBans = compiled.filter(c => c.bannedArmPairs.size > 0);
  if (!withBans.length) return null;
  const nodeJunction = new Int32Array(nodeIds.length).fill(-1);
  nodeIds.forEach((id, i) => {
    const ms = membersOf(id);
    const k = withBans.findIndex(c => ms.some(m => c.nodeIds.has(m)));
    if (k >= 0) nodeJunction[i] = k;
  });
  const pairs: [number, number][] = [];
  const entering: { link: number; arm: string }[][] = withBans.map(() => []), leaving: { link: number; arm: string }[][] = withBans.map(() => []);
  for (let l = 0; l < linkIds.length; l++) {
    const cu = nodeJunction[linkFrom[l]], cv = nodeJunction[linkTo[l]];
    if (cv >= 0 && cv !== cu) {
      const c = withBans[cv];
      const arm = c.approachOfEdge.get(linkIds[l]) ?? c.chainOfEdge.get(linkIds[l]);
      if (arm) entering[cv].push({ link: l, arm });
    }
    if (cu >= 0 && cv !== cu) {
      const c = withBans[cu];
      const arm = c.exitOfEdge.get(linkIds[l]) ?? c.chainOfEdge.get(linkIds[l]);
      if (arm) leaving[cu].push({ link: l, arm });
    }
  }
  withBans.forEach((c, k) => {
    for (const a of entering[k]) for (const x of leaving[k]) if (c.bannedArmPairs.has(`${a.arm}>${x.arm}`)) pairs.push([a.link, x.link]);
  });
  return new TurnBans(nodeIds.length, linkFrom, linkTo, nodeJunction, pairs);
}

/**
 * What the micro-simulator needs at each of its junctions touched by an edit
 * (its junction ids may join several network nodes; a logical junction may
 * span several of its junctions): the control, the phase of each incoming
 * link (-1: a piece inside the logical junction, never stopped), the major
 * links, the lane connections per (link in, link out) and the fixed plan.
 */
export interface SimJunctionSetup {
  simNode: string;
  junctionId: string;
  control: JunctionControlKind;
  phaseOfLink: Map<number, number>;
  greensS: number[];
  amberS: number;
  allRedS: number;
  cycleS: number;
  majorLinks: Set<number>;
}

export interface SimLinkView { index: number; id: string; from: string; to: string; roadId: string; lanes: number }

export function simJunctionSetups(compiled: readonly CompiledJunction[], links: readonly SimLinkView[], membersOf: (simNode: string) => readonly string[]):
  { setups: SimJunctionSetup[]; laneMap: Map<string, Map<number, [number, number]>> } {
  const setups: SimJunctionSetup[] = [];
  const laneMap = new Map<string, Map<number, [number, number]>>();
  const simNodes = [...new Set(links.flatMap(l => [l.from, l.to]))];
  for (const c of compiled) {
    const mine = simNodes.filter(n => membersOf(n).some(m => c.nodeIds.has(m)));
    if (!mine.length) continue;
    const inside = new Set(mine);
    const plan = c.spec.signal;
    // An approach in one phase stops outside it; one in every phase never stops (-1); one in some phases gets the first of them (the simulator has one phase per link)
    const phaseOfArm = new Map<string, number>();
    plan?.phases.forEach((p, i) => p.arms.forEach(a => { if (!phaseOfArm.has(a)) phaseOfArm.set(a, i); }));
    if (plan && plan.phases.length > 1) for (const a of phaseOfArm.keys()) if (plan.phases.every(p => p.arms.includes(a))) phaseOfArm.set(a, -1);
    const armOfIn = (l: SimLinkView) => c.approachOfEdge.get(l.id) ?? c.chainOfEdge.get(l.id);
    const armOfOut = (l: SimLinkView) => c.exitOfEdge.get(l.id) ?? c.chainOfEdge.get(l.id);
    const majors = new Set(c.spec.majorArms ?? []);
    // The engine's own control stays (lane connections below still apply)
    if (!c.controlAsRun) for (const node of mine) {
      const incoming = links.filter(l => l.to === node);
      const phaseOfLink = new Map<number, number>();
      const majorLinks = new Set<number>();
      for (const l of incoming) {
        if (inside.has(l.from)) { phaseOfLink.set(l.index, -1); majorLinks.add(l.index); continue; }
        const arm = armOfIn(l);
        phaseOfLink.set(l.index, arm !== undefined ? phaseOfArm.get(arm) ?? 0 : 0);
        if (arm !== undefined && majors.has(arm)) majorLinks.add(l.index);
      }
      setups.push({ simNode: node, junctionId: c.spec.junctionId, control: c.spec.control, phaseOfLink, greensS: plan?.phases.map(p => p.greenS) ?? [],
        amberS: plan?.amberS ?? DEFAULT_AMBER_S, allRedS: plan?.allRedS ?? DEFAULT_ALL_RED_S, cycleS: plan ? cycleOf(plan) : 0, majorLinks });
    }
    // Lane connections where an approach link meets an exit link at one simulated junction
    const lc = c.spec.laneConnections ?? {};
    for (const [move, pairs] of Object.entries(lc)) {
      if (!pairs.length) continue;
      const [aArm, xArm] = move.split('>');
      for (const a of links) {
        if (!inside.has(a.to) || inside.has(a.from) || armOfIn(a) !== aArm) continue;
        for (const x of links) {
          if (x.from !== a.to || inside.has(x.to) || armOfOut(x) !== xArm) continue;
          const m = new Map<number, [number, number]>();
          const valid = pairs.filter(([i, o]) => i >= 0 && i < a.lanes && o >= 0 && o < x.lanes);
          for (let lane = 0; lane < a.lanes; lane++) {
            // A lane with no connection to this exit is served by the nearest lane that has one (it moves across before the line)
            let src = valid.filter(([i]) => i === lane);
            if (!src.length && valid.length) {
              const near = valid.reduce((b, p) => (Math.abs(p[0] - lane) < Math.abs(b[0] - lane) ? p : b), valid[0])[0];
              src = valid.filter(([i]) => i === near);
            }
            if (!src.length) continue;
            const outs = src.map(([, o]) => o);
            m.set(lane, [Math.min(...outs), Math.max(...outs)]);
          }
          if (m.size) laneMap.set(`${a.index}>${x.index}`, m);
        }
      }
    }
  }
  return { setups, laneMap };
}

/** Placed junctions (the Junction tool) and edits of imported junctions, from the scenario's junction objects. */
export function splitJunctionObjects(junctions: readonly JunctionObject[] | undefined): { placed: JunctionObject[]; edits: JunctionEditSpec[] } {
  const placed: JunctionObject[] = [], edits: JunctionEditSpec[] = [];
  for (const j of junctions ?? []) {
    if (j.importedJunction) edits.push(j.importedJunction); else placed.push(j);
  }
  edits.sort((a, b) => (a.junctionId < b.junctionId ? -1 : a.junctionId > b.junctionId ? 1 : 0));
  return { placed, edits };
}

/** Id of the scenario object that holds a junction edit. */
export const junctionEditObjectId = (junctionId: string, scenarioId: string) => `${junctionId}__${scenarioId}`;

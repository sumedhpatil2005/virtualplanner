import type { LogicalJunction } from '../simulation/junctionGroups';
import type { RoadAnalysisResult } from '../simulation/RoadAnalysis';
import { defaultEdit, compileJunctionEdits, MIN_GREEN_EDIT_S, DEFAULT_AMBER_S, DEFAULT_ALL_RED_S, DEFAULT_GREEN_S, type JunctionEditSpec, type SignalPlan, type SignalPhase } from '../simulation/junctionControl';
import type { TrafficNetwork } from '../objects/trafficTypes';

/**
 * The junction editor's draft (docs/OVERHAUL.md §23): pure changes to a
 * JunctionEditSpec, so the panel only renders and the rules are testable.
 */

/**
 * The control the last analysis ran at this junction, as the editor shows it
 * (docs/OVERHAUL.md §23). The simulator may cover one logical junction with
 * several of its own junctions, each with its own control; a signal often
 * stands on a piece inside the junction rather than on the approach itself.
 * So each approach is followed to the first signal that held it in the run:
 * its own stop line, else the piece before it (the simulator joined the
 * approach's first node into a junction), else the pieces inside the junction
 * it drives on to (nearest first). The plan: the phases, greens, amber and
 * all-red of the signal that held the most approaches (a phase that held only
 * pieces inside the junction is kept with no approach, so the cycle and every
 * approach's green are as run), then the phases of any other signal that held
 * approaches. An approach no signal held is in every phase: always green, as
 * it ran. Null when the run did not cover the junction; `signalHeld` 0 when it
 * ran with no signal here.
 */
export interface RunControl {
  plan: SignalPlan | null;
  /** Approaches held by a signal in the run. */
  signalHeld: number;
  /** Approaches no signal held (always green in the plan). */
  alwaysGreen: string[];
  /** The run's signals that held approaches: simulated junction, its cycle, the approaches it held. The first is the plan's base. */
  signals: { node: string; cycleS: number; arms: string[] }[];
}

export function lastRunControl(j: LogicalJunction, r: RoadAnalysisResult | null | undefined, net: TrafficNetwork | null | undefined): RunControl | null {
  if (!r || !net || !r.signalLinks || !r.signalGreens || !r.signalCycles) return null;
  const spec0 = { junctionId: j.id, label: j.label, nodeKeys: [...j.nodeKeys], arms: [...j.approaches, ...j.exits].map(a => ({ id: a.id, kind: a.kind, label: a.label, keys: [...a.keys], chainKeys: [...a.chainKeys], lanes: a.lanes })), control: 'priority' as const };
  const c = compileJunctionEdits(net, [spec0])[0];
  if (!c) return null;
  // The run simulated only its own area (the corridor round the road, smaller than the area the
  // network was explored in): a junction none of whose pieces it ran was not covered, so its
  // control is the engine's default (a mapped signal, else priority), not "ran without a signal"
  const ran = (id: string) => r.linkVph.has(id);
  if (r.linkVph && ![...c.approachOfEdge.keys(), ...c.internalEdges].some(ran)) return null;
  const sl = r.signalLinks;
  const internalFrom = new Map<string, string[]>();
  for (const id of c.internalEdges) { const e = net.edges.get(id)!; (internalFrom.get(e.fromNodeId) ?? internalFrom.set(e.fromNodeId, []).get(e.fromNodeId)!).push(id); }
  const held = new Map<string, { node: string; phase: number }[]>();
  for (const a of j.approaches) {
    const own = [...c.approachOfEdge].filter(([, x]) => x === a.id).map(([id]) => id);
    const hitsOf = (ids: readonly string[]) => ids.map(id => sl.get(id)).filter((h): h is { node: string; phase: number } => !!h && h.phase >= 0);
    let hits = hitsOf(own);
    // The piece before it, when the simulator joined the approach's first node into its junction
    if (!hits.length) hits = hitsOf([...c.chainOfEdge].filter(([, x]) => x === a.id).map(([id]) => id));
    // Inside the junction: breadth first from where the approach enters, the nearest signals
    let frontier = own.map(id => net.edges.get(id)!.toNodeId);
    const seen = new Set(frontier);
    for (let depth = 0; !hits.length && frontier.length && depth < 8; depth++) {
      const next: string[] = [], ids: string[] = [];
      for (const n of frontier) for (const id of internalFrom.get(n) ?? []) {
        ids.push(id);
        const to = net.edges.get(id)!.toNodeId;
        if (!seen.has(to)) { seen.add(to); next.push(to); }
      }
      hits = hitsOf(ids);
      frontier = next;
    }
    if (hits.length) held.set(a.id, hits);
  }
  const alwaysGreen = j.approaches.filter(a => !held.has(a.id)).map(a => a.id);
  if (!held.size) return { plan: null, signalHeld: 0, alwaysGreen, signals: [] };
  // The run's signals, the one that held the most approaches first
  const byNode = new Map<string, Set<string>>();
  held.forEach((hs, arm) => hs.forEach(h => (byNode.get(h.node) ?? byNode.set(h.node, new Set()).get(h.node)!).add(arm)));
  const nodes = [...byNode.keys()].sort((x, y) => byNode.get(y)!.size - byNode.get(x)!.size || (r.signalGreens!.get(y)?.length ?? 0) - (r.signalGreens!.get(x)?.length ?? 0) || (x < y ? -1 : 1));
  const base = nodes[0];
  const greensOf = (n: string) => r.signalGreens!.get(n) ?? [];
  const g0 = greensOf(base), cyc0 = r.signalCycles.get(base) ?? 0;
  const lost = g0.length ? Math.max(0, (cyc0 - g0.reduce((x, y) => x + y, 0)) / g0.length) : DEFAULT_AMBER_S + DEFAULT_ALL_RED_S;
  const amberS = Math.round(Math.min(DEFAULT_AMBER_S, lost)), allRedS = Math.max(0, Math.round(lost) - amberS);
  const green = (g: number) => Math.max(MIN_GREEN_EDIT_S, Math.round(g));
  const phases: SignalPhase[] = g0.map((g, i) => ({ greenS: green(g), arms: j.approaches.filter(a => held.get(a.id)?.some(h => h.node === base && h.phase === i)).map(a => a.id) }));
  // Approaches held only by another signal: that signal's phases that held them
  const extra = new Map<string, SignalPhase>();
  for (const a of j.approaches) {
    const hs = held.get(a.id);
    if (!hs || hs.some(h => h.node === base)) continue;
    for (const h of hs) {
      const k = `${h.node}#${h.phase}`;
      const p = extra.get(k) ?? extra.set(k, { greenS: green(greensOf(h.node)[h.phase] ?? DEFAULT_GREEN_S), arms: [] }).get(k)!;
      if (!p.arms.includes(a.id)) p.arms.push(a.id);
    }
  }
  phases.push(...extra.values());
  for (const p of phases) p.arms.push(...alwaysGreen);
  return { plan: { amberS, allRedS, phases }, signalHeld: held.size, alwaysGreen,
    signals: nodes.map(n => ({ node: n, cycleS: r.signalCycles!.get(n) ?? 0, arms: [...byNode.get(n)!] })) };
}

/** The draft to start from: the edit in force (if its arms still match the junction), else what the last analysis ran (else what the engine does). */
export function startingDraft(j: LogicalJunction, existing: JunctionEditSpec | null, last: RoadAnalysisResult | null | undefined, runNet?: TrafficNetwork | null):
  { draft: JunctionEditSpec; source: 'edit' | 'last-run' | 'default'; stale: boolean; run: RunControl | null } {
  const armIds = new Set([...j.approaches, ...j.exits].map(a => a.id));
  if (existing) {
    const stale = existing.arms.some(a => !armIds.has(a.id)) || existing.arms.length !== armIds.size;
    return { draft: structuredClone(existing), source: 'edit', stale, run: null };
  }
  const run = lastRunControl(j, last, runNet);
  return { draft: defaultEdit(j, run), source: run ? 'last-run' : 'default', stale: false, run };
}

/** What the starting values are, in a sentence (the editor shows it under Control). */
export function startingNote(j: LogicalJunction, start: { source: 'edit' | 'last-run' | 'default'; run: RunControl | null }): string {
  if (start.source === 'edit') return 'Values: the edit applied to this junction.';
  const keep = ' Applying them unchanged keeps the simulation exactly as it was.';
  const run = start.run;
  if (!run) return `Starting values: what the simulation does here now (${j.signalised ? 'mapped signal, one phase per approach; the simulation times it from its flows' : 'no mapped signal: priority to the main roads'}).${keep}`;
  if (!run.plan) return `Starting values: the last analysis ran this junction without a signal (priority to the main roads).${keep}`;
  const label = (id: string) => j.approaches.find(a => a.id === id)?.label ?? id;
  const parts = [`Starting values: the signal plan the last analysis ran here (${j.signalised ? 'mapped signal' : 'no signal mapped: estimated from the road classes'}), greens as run.`];
  if (run.signals.length > 1) parts.push(`The run had ${run.signals.length} separate signals inside this junction (cycles ${run.signals.map(s => `${Math.round(s.cycleS)} s`).join(', ')}); they are shown as one plan, the signal holding the most approaches first.`);
  if (run.alwaysGreen.length) parts.push(`No signal held ${run.alwaysGreen.map(label).join(', ')} in that run: shown in every phase (always green).`);
  return parts.join(' ') + keep;
}

/** The draft with its control changed by hand: the engine no longer keeps its own control here. */
const own = (d: JunctionEditSpec): JunctionEditSpec => { const { asRun: _asRun, ...rest } = d; return rest; };

export const setControl = (d: JunctionEditSpec, control: JunctionEditSpec['control']): JunctionEditSpec => (control === d.control ? d : { ...own(d), control });

export function setGreen(d: JunctionEditSpec, phase: number, greenS: number): JunctionEditSpec {
  if (!d.signal || d.signal.phases[phase]?.greenS === Math.max(MIN_GREEN_EDIT_S, Math.round(greenS))) return d;
  const phases = d.signal.phases.map((p, i) => (i === phase ? { ...p, greenS: Math.max(MIN_GREEN_EDIT_S, Math.round(greenS)) } : p));
  return { ...own(d), signal: { ...d.signal, phases } };
}

export function setTiming(d: JunctionEditSpec, field: 'amberS' | 'allRedS', value: number): JunctionEditSpec {
  if (!d.signal || d.signal[field] === Math.max(0, Math.min(10, Math.round(value)))) return d;
  return { ...own(d), signal: { ...d.signal, [field]: Math.max(0, Math.min(10, Math.round(value))) } };
}

export function toggleArmInPhase(d: JunctionEditSpec, phase: number, armId: string): JunctionEditSpec {
  if (!d.signal) return d;
  const phases = d.signal.phases.map((p, i) => (i !== phase ? p : { ...p, arms: p.arms.includes(armId) ? p.arms.filter(a => a !== armId) : [...p.arms, armId] }));
  return { ...own(d), signal: { ...d.signal, phases } };
}

export function addPhase(d: JunctionEditSpec): JunctionEditSpec {
  if (!d.signal) return d;
  return { ...own(d), signal: { ...d.signal, phases: [...d.signal.phases, { greenS: 20, arms: [] }] } };
}

export function removePhase(d: JunctionEditSpec, phase: number): JunctionEditSpec {
  if (!d.signal || d.signal.phases.length <= 1) return d;
  return { ...own(d), signal: { ...d.signal, phases: d.signal.phases.filter((_, i) => i !== phase) } };
}

export function toggleMajor(d: JunctionEditSpec, armId: string): JunctionEditSpec {
  const m = new Set(d.majorArms ?? []);
  if (m.has(armId)) m.delete(armId); else m.add(armId);
  return { ...own(d), majorArms: [...m] };
}

export function toggleBan(d: JunctionEditSpec, move: string): JunctionEditSpec {
  const b = new Set(d.bannedMovements ?? []);
  if (b.has(move)) b.delete(move); else b.add(move);
  return { ...d, bannedMovements: [...b].sort() };
}

/** Entry lane -> exit lane connection on or off for a movement; the first change starts from the default (lanes in order). */
export function toggleLane(d: JunctionEditSpec, move: string, entry: number, exit: number, entryLanes: number, exitLanes: number): JunctionEditSpec {
  const lc = { ...(d.laneConnections ?? {}) };
  const cur = lc[move] ?? defaultLanePairs(entryLanes, exitLanes);
  const has = cur.some(([i, o]) => i === entry && o === exit);
  const next = has ? cur.filter(([i, o]) => !(i === entry && o === exit)) : [...cur, [entry, exit] as [number, number]];
  lc[move] = next.sort((a, b) => a[0] - b[0] || a[1] - b[1]);
  return { ...d, laneConnections: lc };
}

export function resetLanes(d: JunctionEditSpec, move: string): JunctionEditSpec {
  const lc = { ...(d.laneConnections ?? {}) };
  delete lc[move];
  return { ...d, laneConnections: lc };
}

/** The engine's default lane connections (lanes in order across the junction, as TrafficMicroSim.mappedLanes). */
export function defaultLanePairs(m: number, n: number): [number, number][] {
  const out: [number, number][] = [];
  for (let lane = 0; lane < m; lane++) {
    if (m === n) { out.push([lane, lane]); continue; }
    const lo = Math.min(n - 1, Math.floor((lane * n) / m));
    const hi = Math.max(lo, Math.min(n - 1, Math.ceil(((lane + 1) * n) / m) - 1));
    for (let k = lo; k <= hi; k++) out.push([lane, k]);
  }
  return out;
}

/** Whether two drafts would compile to the same engine input. */
export const sameEdit = (a: JunctionEditSpec | null, b: JunctionEditSpec | null) => JSON.stringify(a) === JSON.stringify(b);

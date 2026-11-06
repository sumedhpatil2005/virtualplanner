import type { LogicalJunction } from '../simulation/junctionGroups';
import type { RoadAnalysisResult } from '../simulation/RoadAnalysis';
import { defaultEdit, MIN_GREEN_EDIT_S, type JunctionEditSpec } from '../simulation/junctionControl';

/**
 * The junction editor's draft (docs/OVERHAUL.md §23): pure changes to a
 * JunctionEditSpec, so the panel only renders and the rules are testable.
 */

/** Green ratios the last analysis ran at this junction (per approach arm) and its cycle, or null. */
export function lastRunTiming(j: LogicalJunction, r: RoadAnalysisResult | null | undefined): { cycleS: number; greenRatioByArm: Map<string, number> } | null {
  if (!r?.linkDelay || !r.signalCycles) return null;
  const cycle = j.nodeIds.map(n => r.signalCycles!.get(n)).find((c): c is number => c !== undefined);
  if (cycle === undefined) return null;
  const greenRatioByArm = new Map<string, number>();
  for (const a of j.approaches) {
    const gs = a.edgeIds.map(id => r.linkDelay!.get(id)?.gC).filter((g): g is number => g !== null && g !== undefined);
    if (gs.length) greenRatioByArm.set(a.id, Math.max(...gs));
  }
  return { cycleS: cycle, greenRatioByArm };
}

/** The draft to start from: the edit in force (if its arms still match the junction), else what the engine does now. */
export function startingDraft(j: LogicalJunction, existing: JunctionEditSpec | null, last: RoadAnalysisResult | null | undefined): { draft: JunctionEditSpec; source: 'edit' | 'last-run' | 'default'; stale: boolean } {
  const armIds = new Set([...j.approaches, ...j.exits].map(a => a.id));
  if (existing) {
    const stale = existing.arms.some(a => !armIds.has(a.id)) || existing.arms.length !== armIds.size;
    return { draft: structuredClone(existing), source: 'edit', stale };
  }
  const timing = lastRunTiming(j, last);
  return { draft: defaultEdit(j, timing), source: timing ? 'last-run' : 'default', stale: false };
}

export const setControl = (d: JunctionEditSpec, control: JunctionEditSpec['control']): JunctionEditSpec => ({ ...d, control });

export function setGreen(d: JunctionEditSpec, phase: number, greenS: number): JunctionEditSpec {
  if (!d.signal) return d;
  const phases = d.signal.phases.map((p, i) => (i === phase ? { ...p, greenS: Math.max(MIN_GREEN_EDIT_S, Math.round(greenS)) } : p));
  return { ...d, signal: { ...d.signal, phases } };
}

export function setTiming(d: JunctionEditSpec, field: 'amberS' | 'allRedS', value: number): JunctionEditSpec {
  if (!d.signal) return d;
  return { ...d, signal: { ...d.signal, [field]: Math.max(0, Math.min(10, Math.round(value))) } };
}

export function toggleArmInPhase(d: JunctionEditSpec, phase: number, armId: string): JunctionEditSpec {
  if (!d.signal) return d;
  const phases = d.signal.phases.map((p, i) => (i !== phase ? p : { ...p, arms: p.arms.includes(armId) ? p.arms.filter(a => a !== armId) : [...p.arms, armId] }));
  return { ...d, signal: { ...d.signal, phases } };
}

export function addPhase(d: JunctionEditSpec): JunctionEditSpec {
  if (!d.signal) return d;
  return { ...d, signal: { ...d.signal, phases: [...d.signal.phases, { greenS: 20, arms: [] }] } };
}

export function removePhase(d: JunctionEditSpec, phase: number): JunctionEditSpec {
  if (!d.signal || d.signal.phases.length <= 1) return d;
  return { ...d, signal: { ...d.signal, phases: d.signal.phases.filter((_, i) => i !== phase) } };
}

export function toggleMajor(d: JunctionEditSpec, armId: string): JunctionEditSpec {
  const m = new Set(d.majorArms ?? []);
  if (m.has(armId)) m.delete(armId); else m.add(armId);
  return { ...d, majorArms: [...m] };
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

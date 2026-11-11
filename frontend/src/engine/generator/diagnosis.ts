import type { RoadAnalysisResult, DelayBreakdown } from '../simulation/RoadAnalysis';
import type { StudyArea, DrivableObject } from '../simulation/StudyAreaExplorer';
import type { TrafficNetwork } from '../objects/trafficTypes';
import { groupJunctions, junctionNear, type LogicalJunction } from '../simulation/junctionGroups';
import { lastRunControl } from '../editing/junctionDraft';
import { cycleOf, type SignalPlan } from '../simulation/junctionControl';
import { indoHcmSaturationFlow, websterOptimumCycle, MAX_FLOW_RATIO_SUM, STARTUP_LOST_S } from '../simulation/signalTiming';
import { VEHICLE_TYPES } from '../simulation/TrafficMicroSim';

/**
 * Bottleneck diagnosis (mission §8, §11 steps 1-3; docs/SCENARIO_GENERATOR.md §2).
 *
 * Classifies each problem location of one analysis run by CAUSE, with the
 * metric that supports it, the threshold it was compared with and a
 * confidence. Everything here is MODEL OUTPUT (ESTIMATED): it reads the area
 * assignment and the corridor micro-simulation of the run, not measurements.
 *
 * Two layers, so the rules can be tested on synthetic fixtures:
 *  - `LocationEvidence`: plain numbers about one place (built from a run by
 *    `evidenceFromAnalysis`);
 *  - `classifyLocation`: the rules, evidence in, causes out.
 */

export type BottleneckCause =
  | 'signal_timing' | 'uncoordinated_signals' | 'turning_conflict' | 'merge'
  | 'downstream_spillback' | 'excessive_demand' | 'poor_connectivity';

export const CAUSE_LABEL: Record<BottleneckCause, string> = {
  signal_timing: 'Signal timing',
  uncoordinated_signals: 'Uncoordinated signals',
  turning_conflict: 'Turning conflicts',
  merge: 'Merge bottleneck',
  downstream_spillback: 'Downstream spillback',
  excessive_demand: 'Excessive demand',
  poor_connectivity: 'Poor connectivity',
};

export type Confidence = 'high' | 'medium' | 'low';

export interface CauseMetric {
  name: string;
  value: number;
  unit: string;
  /** The value the rule compared it with, and where that value comes from. */
  threshold: number;
  thresholdBasis: string;
}

export interface CauseFinding {
  cause: BottleneckCause;
  confidence: Confidence;
  metric: CauseMetric;
  /** Further numbers that support (or weaken) it. */
  supporting: CauseMetric[];
  text: string;
  certainty: 'model output (ESTIMATED)';
}

export interface PhaseEvidence {
  /** Green (s) the run gave the phase. */
  greenS: number;
  /** Critical flow of the phase (PCU/h): the highest-flow-ratio approach it serves (assigned demand). */
  flowPcu: number;
  /** Saturation flow of that approach (PCU/h; Indo-HCM width-based). */
  satFlowPcu: number;
  arms: string[];
}

export interface LocationEvidence {
  id: string;
  label: string;
  coordinates: [number, number];
  /** 'corridor' evidence comes from the micro-simulation; 'area' only from the assignment. */
  scope: 'corridor' | 'area';
  /** Logical junction id at the place, when one was matched. */
  junctionId?: string | null;
  /** Approach road ids (for candidate building). */
  roadIds?: string[];
  /** Direction label of the selected road this concerns, if any. */
  direction?: string | null;
  seeds: number;
  delay?: DelayBreakdown | null;
  /** Signal plan the run used here, with demand by phase. */
  signal?: { cycleS: number; lostTimeS: number; amberS: number; allRedS: number; phases: PhaseEvidence[] } | null;
  /** Demand / capacity on the approach or stretch (PCU/h), and what capacity is. */
  demandPcu?: number;
  capacityPcu?: number;
  capacityBasis?: 'midblock' | 'signal' | 'assignment';
  /** A queue on the selected road traced to a junction further on. */
  spillback?: { rootLabel: string; rootCoordinates: [number, number]; agreement: number; seeds: number; blockedShare: number } | null;
  /** Lanes entering and leaving at the node (lane drop = merge). */
  lanesIn?: number;
  lanesOut?: number;
  /** Signals within COORDINATION_RANGE_M upstream: their cycle and the observed / random-arrival delay ratio here. */
  coordination?: { neighbourLabel: string; distanceM: number; ownCycleS: number; neighbourCycleS: number; observedSignalDelayS: number; randomArrivalDelayS: number } | null;
  /** Share of the stretch's assigned traffic without another route (assignment). */
  noAlternativeShare?: number;
  /** Shortest alternative route around the stretch / straight distance (network detour ratio). */
  detourRatio?: number | null;
}

// ── Thresholds ──────────────────────────────────────────────────────────────
// Thresholds marked HYPOTHETICAL are this tool's screening choices, not values from a standard (docs/SCENARIO_GENERATOR.md §2.2).

/** Degree of saturation above 1 = the phase cannot clear its queue every cycle (cycle failure). Definition, not a choice. */
export const CYCLE_FAILURE_X = 1.0;
/** Sum of critical flow ratios up to which Webster's method is used (signalTiming.MAX_FLOW_RATIO_SUM, 0.9). */
export const WEBSTER_Y_LIMIT = MAX_FLOW_RATIO_SUM;
/** HYPOTHETICAL: the run's cycle differs from Webster's optimum by more than this share. */
export const CYCLE_MISMATCH = 0.3;
/** HYPOTHETICAL: share of delay from giving way / opposed movements that names turning conflicts. */
export const CONFLICT_SHARE = 0.4;
/** HYPOTHETICAL: share of delay spent stopped behind a full road ahead (RoadAnalysis traces chains from 0.25). */
export const BLOCKED_SHARE = 0.25;
/** HYPOTHETICAL: observed signal delay / random-arrival uniform delay above which progression is called unfavourable. */
export const PROGRESSION_RATIO = 1.3;
/** HYPOTHETICAL: signals closer than this can interact (platoons arrive before they disperse). */
export const COORDINATION_RANGE_M = 400;
/** HYPOTHETICAL: detour ratio of the best alternative route around a stretch. */
export const DETOUR_RATIO = 1.6;
/** RoadAnalysis.NO_ALTERNATIVE_LABEL_SHARE (0.5). */
export const NO_ALTERNATIVE_SHARE = 0.5;
/** Minimum delay (s/veh) before a delay share is read as a cause (HYPOTHETICAL; RoadAnalysis traces chains above 5 s). */
export const MIN_DELAY_S = 10;

const r2 = (x: number) => Math.round(x * 100) / 100;
const pct = (x: number) => `${Math.round(100 * x)}%`;

/** Webster uniform delay (s/veh) for random arrivals: d1 = C(1-λ)² / (2(1-λ·min(1,x))), λ = g/C (Webster 1958). */
export function randomArrivalDelay(cycleS: number, gC: number, x: number): number {
  const lam = Math.max(0, Math.min(1, gC));
  return (cycleS * (1 - lam) ** 2) / (2 * Math.max(1e-6, 1 - lam * Math.min(1, x)));
}

/** Per-phase degree of saturation x = y·C/g, and the flow-ratio sum Y. */
export function phaseSaturation(s: NonNullable<LocationEvidence['signal']>): { x: number[]; y: number[]; Y: number; websterC0: number } {
  const y = s.phases.map(p => (p.satFlowPcu > 0 ? p.flowPcu / p.satFlowPcu : 0));
  // Effective green g = G + amber - start-up lost time (signalTiming.ts header)
  const x = s.phases.map((p, i) => { const g = Math.max(1, p.greenS + s.amberS - STARTUP_LOST_S); return y[i] * s.cycleS / g; });
  const Y = y.reduce((a, b) => a + b, 0);
  return { x, y, Y, websterC0: websterOptimumCycle(s.lostTimeS, Y) };
}

const finding = (cause: BottleneckCause, confidence: Confidence, metric: CauseMetric, text: string, supporting: CauseMetric[] = []): CauseFinding =>
  ({ cause, confidence, metric, supporting, text, certainty: 'model output (ESTIMATED)' });

/** The rules: which causes the evidence supports, strongest first. A location can have several. */
export function classifyLocation(e: LocationEvidence): CauseFinding[] {
  const out: CauseFinding[] = [];
  const d = e.delay;
  const total = d?.total ?? 0;

  // Signal: timing (a phase fails while the junction as a whole could serve its demand) vs excessive demand (Y too high for any timing)
  if (e.signal && e.signal.phases.length) {
    const { x, Y, websterC0 } = phaseSaturation(e.signal);
    const xMax = Math.max(...x), worst = x.indexOf(xMax);
    const yMetric: CauseMetric = { name: 'Sum of critical flow ratios Y', value: r2(Y), unit: '', threshold: WEBSTER_Y_LIMIT, thresholdBasis: 'Webster (1958) optimum cycle is valid for Y < 1; signalTiming.ts uses it up to 0.9' };
    if (Y >= WEBSTER_Y_LIMIT) {
      out.push(finding('excessive_demand', Y >= 1 ? 'high' : 'medium', yMetric,
        `Even with optimal fixed-time timing the junction cannot serve its assigned demand: Y = ${r2(Y)} (critical demand / saturation flow over all phases). Retiming alone cannot fix this.`,
        [{ name: `Degree of saturation, phase ${worst + 1}`, value: r2(xMax), unit: '', threshold: CYCLE_FAILURE_X, thresholdBasis: 'x > 1: arrivals exceed what the green can discharge (definition)' }]));
    } else if (xMax > CYCLE_FAILURE_X) {
      out.push(finding('signal_timing', xMax > 1.1 && Y < 0.8 ? 'high' : 'medium',
        { name: `Degree of saturation, phase ${worst + 1}`, value: r2(xMax), unit: '', threshold: CYCLE_FAILURE_X, thresholdBasis: 'x > 1: cycle failure (definition)' },
        `Phase ${worst + 1} fails (x = ${r2(xMax)}) although the junction as a whole has spare capacity (Y = ${r2(Y)} < ${WEBSTER_Y_LIMIT}): the green split, not the demand, limits it.`,
        [yMetric, { name: 'Run cycle / Webster optimum cycle', value: r2(e.signal.cycleS / websterC0), unit: '', threshold: 1, thresholdBasis: 'Webster C0 = (1.5L + 5)/(1 - Y)' }]));
    } else if (d && total >= MIN_DELAY_S && d.signal / total >= 0.5 && Number.isFinite(websterC0) && Math.abs(e.signal.cycleS - websterC0) / websterC0 > CYCLE_MISMATCH) {
      out.push(finding('signal_timing', 'low',
        { name: 'Run cycle / Webster optimum cycle', value: r2(e.signal.cycleS / websterC0), unit: '', threshold: 1 + CYCLE_MISMATCH, thresholdBasis: `HYPOTHETICAL screening band ±${pct(CYCLE_MISMATCH)} around Webster C0` },
        `Signal waiting is ${pct(d.signal / total)} of the delay and the cycle (${Math.round(e.signal.cycleS)} s) is far from Webster's optimum for the assigned demand (${Math.round(websterC0)} s). No phase fails, so the evidence is weak.`,
        [{ name: 'Signal share of delay', value: r2(d.signal / total), unit: '', threshold: 0.5, thresholdBasis: 'HYPOTHETICAL' }]));
    }
  }

  // Downstream spillback: the queue on the road starts at a junction further on
  if (e.spillback && e.spillback.blockedShare >= BLOCKED_SHARE) {
    const s = e.spillback;
    const conf: Confidence = s.agreement === s.seeds && s.seeds >= 2 ? 'high' : s.agreement * 2 > s.seeds ? 'medium' : 'low';
    out.push(finding('downstream_spillback', conf,
      { name: 'Share of delay stopped behind a full road ahead', value: r2(s.blockedShare), unit: '', threshold: BLOCKED_SHARE, thresholdBasis: 'HYPOTHETICAL (RoadAnalysis traces queues from this share)' },
      `${pct(s.blockedShare)} of the delay is queueing behind traffic that cannot leave; the queue was traced to ${s.rootLabel} in ${s.agreement} of ${s.seeds} runs. Fix the place where the queue starts, not this one.`,
      [{ name: 'Runs in which the same queue origin was found', value: s.agreement, unit: `of ${s.seeds}`, threshold: Math.ceil(s.seeds / 2), thresholdBasis: 'majority of seeds' }]));
  }

  // Turning conflicts: delay from giving way / waiting for opposed movements
  if (d && total >= MIN_DELAY_S) {
    const share = (d.giveWay + d.conflict) / total;
    if (share >= CONFLICT_SHARE) out.push(finding('turning_conflict', share >= 0.6 ? 'high' : 'medium',
      { name: 'Share of delay giving way / waiting for opposed movements', value: r2(share), unit: '', threshold: CONFLICT_SHARE, thresholdBasis: 'HYPOTHETICAL screening threshold' },
      `${pct(share)} of the delay (${Math.round(d.giveWay + d.conflict)} of ${Math.round(total)} s per vehicle) is waiting for gaps in or claims of conflicting movements.`));
  }

  // Merge: more lanes enter than leave and the place is loaded
  if (e.lanesIn !== undefined && e.lanesOut !== undefined && e.lanesIn > e.lanesOut) {
    const vc = e.demandPcu !== undefined && e.capacityPcu ? e.demandPcu / e.capacityPcu : null;
    const mergeDelay = d && total > 0 ? (d.giveWay + d.conflict + d.blocked) / total : null;
    if ((vc !== null && vc >= 0.85) || (mergeDelay !== null && total >= MIN_DELAY_S && mergeDelay >= 0.5)) {
      out.push(finding('merge', vc !== null && vc >= 1 ? 'high' : 'medium',
        { name: 'Lanes in / lanes out', value: e.lanesIn, unit: `→ ${e.lanesOut}`, threshold: e.lanesOut, thresholdBasis: 'lane drop (network geometry)' },
        `${e.lanesIn} lanes feed ${e.lanesOut} at this point${vc !== null ? ` and the demand is ${pct(vc)} of the downstream capacity` : ''}.`,
        vc !== null ? [{ name: 'Demand / capacity', value: r2(vc), unit: '', threshold: 0.85, thresholdBasis: 'IRC:106 design service volume band used by RoadAnalysis (0.85)' }] : []));
    }
  }

  // Excessive demand on a stretch (no signal evidence): demand above capacity
  if (!out.some(f => f.cause === 'excessive_demand') && e.demandPcu !== undefined && e.capacityPcu) {
    const vc = e.demandPcu / e.capacityPcu;
    if (vc >= 1) out.push(finding('excessive_demand', e.scope === 'corridor' && vc >= 1.2 ? 'high' : 'medium',
      { name: 'Demand / capacity', value: r2(vc), unit: '', threshold: 1, thresholdBasis: `capacity: ${e.capacityBasis === 'signal' ? 'stop line (Indo-HCM saturation × g/C)' : e.capacityBasis === 'midblock' ? 'mid-block (IRC:106-1990)' : 'assignment link capacity'}` },
      `The demand assigned to it is ${pct(vc)} of its capacity: more traffic wants to use it than it can carry in the hour.`));
  }

  // Uncoordinated signals: an upstream signal close by and arrivals that wait longer than random arrivals would
  if (e.coordination) {
    const c = e.coordination;
    const ratio = c.randomArrivalDelayS > 0 ? c.observedSignalDelayS / c.randomArrivalDelayS : 0;
    const cycleDiff = Math.abs(c.ownCycleS - c.neighbourCycleS);
    if (ratio >= PROGRESSION_RATIO) out.push(finding('uncoordinated_signals', cycleDiff > 10 && ratio >= 1.6 ? 'medium' : 'low',
      { name: 'Signal delay / random-arrival delay', value: r2(ratio), unit: '', threshold: PROGRESSION_RATIO, thresholdBasis: 'HYPOTHETICAL; ratio > 1 means platoons arrive on red more than random arrivals would (cf. HCM progression factor)' },
      `Vehicles wait ${Math.round(c.observedSignalDelayS)} s at the signal against ${Math.round(c.randomArrivalDelayS)} s expected for random arrivals, with ${c.neighbourLabel} ${Math.round(c.distanceM)} m upstream (cycles ${Math.round(c.ownCycleS)} s and ${Math.round(c.neighbourCycleS)} s). Arrival on red is inferred, not counted.`,
      [{ name: 'Cycle difference to the upstream signal', value: Math.round(cycleDiff), unit: 's', threshold: 10, thresholdBasis: 'HYPOTHETICAL; signals with different cycles cannot keep a fixed offset' }]));
  }

  // Poor connectivity: traffic has no other route, or the alternative is a long detour
  const noAlt = e.noAlternativeShare ?? 0, det = e.detourRatio ?? null;
  if (noAlt >= NO_ALTERNATIVE_SHARE || (det !== null && det >= DETOUR_RATIO)) {
    const useDetour = det !== null && det >= DETOUR_RATIO;
    out.push(finding('poor_connectivity', useDetour && noAlt >= NO_ALTERNATIVE_SHARE ? 'medium' : 'low',
      useDetour ? { name: 'Detour ratio of the best alternative route', value: r2(det!), unit: '', threshold: DETOUR_RATIO, thresholdBasis: 'HYPOTHETICAL; route directness as in Dill (2004)' }
        : { name: 'Share of traffic with no other route', value: r2(noAlt), unit: '', threshold: NO_ALTERNATIVE_SHARE, thresholdBasis: 'RoadAnalysis NO_ALTERNATIVE_LABEL_SHARE' },
      useDetour ? `The best route around this stretch is ${r2(det!)}× the straight-line distance${noAlt ? `, and ${pct(noAlt)} of its traffic has no other route in the model` : ''}.`
        : `${pct(noAlt)} of its assigned traffic has no other route in the model network.`,
      useDetour && noAlt ? [{ name: 'Share of traffic with no other route', value: r2(noAlt), unit: '', threshold: NO_ALTERNATIVE_SHARE, thresholdBasis: 'RoadAnalysis NO_ALTERNATIVE_LABEL_SHARE' }] : []));
  }

  const rank: Record<Confidence, number> = { high: 3, medium: 2, low: 1 };
  return out.sort((a, b) => rank[b.confidence] - rank[a.confidence]);
}

export interface DiagnosedLocation {
  evidence: LocationEvidence;
  causes: CauseFinding[];
  /** Delay (veh·h/h) or a proxy used to rank locations. */
  severity: number;
}

export interface Diagnosis {
  locations: DiagnosedLocation[];
  notes: string[];
  label: 'ESTIMATED — model output';
}

// ── From a run ──────────────────────────────────────────────────────────────

/** Mean PCU of the simulated fleet (shares × PCU, TrafficMicroSim.VEHICLE_TYPES: IRC:106 factors). */
export const FLEET_MEAN_PCU = (() => {
  const t = VEHICLE_TYPES.filter(v => v.share > 0);
  const s = t.reduce((n, v) => n + v.share, 0);
  return t.reduce((n, v) => n + v.share * v.pcu, 0) / s;
})();

const M = 111320;
const distM = (a: readonly number[], b: readonly number[]) => Math.hypot((a[0] - b[0]) * M * Math.cos(a[1] * Math.PI / 180), (a[1] - b[1]) * M);

/** Signal evidence for a junction from the plan the run used and the assigned demand on its approaches. */
export function signalEvidence(j: LogicalJunction, r: RoadAnalysisResult, net: TrafficNetwork): { evidence: NonNullable<LocationEvidence['signal']>; plan: SignalPlan } | null {
  const run = lastRunControl(j, r, net);
  if (!run?.plan || !run.plan.phases.length) return null;
  const plan = run.plan;
  const armFlow = new Map<string, { flow: number; sat: number }>();
  for (const a of j.approaches) {
    const veh = a.edgeIds.reduce((n, id) => n + (r.areaLinkVph.get(id) ?? 0), 0);
    armFlow.set(a.id, { flow: veh * FLEET_MEAN_PCU, sat: indoHcmSaturationFlow(Math.max(1, a.lanes) * 3.5) });
  }
  const phases: PhaseEvidence[] = plan.phases.map(p => {
    // Critical stream of the phase: its arm with the highest flow ratio. An arm green in several phases is counted in each (conservative).
    let best = { flow: 0, sat: 1 };
    for (const id of p.arms) { const f = armFlow.get(id); if (f && f.flow / f.sat > best.flow / best.sat) best = f; }
    return { greenS: p.greenS, flowPcu: best.flow, satFlowPcu: best.sat, arms: [...p.arms] };
  });
  return { evidence: { cycleS: cycleOf(plan), lostTimeS: plan.phases.length * (STARTUP_LOST_S + plan.allRedS), amberS: plan.amberS, allRedS: plan.allRedS, phases }, plan };
}

/** Lanes in and out at the network node nearest a point (for merges). */
function lanesAt(net: TrafficNetwork, at: readonly number[]): { lanesIn: number; lanesOut: number } | null {
  let best: string | null = null, bd = 30;
  for (const n of net.nodes.values()) { const dd = distM(n.coordinates, at); if (dd < bd) { bd = dd; best = n.id; } }
  if (!best) return null;
  const node = net.nodes.get(best)!;
  const lanes = (ids: string[]) => ids.reduce((s, id) => s + (net.edges.get(id)?.lanes ?? 0), 0);
  // Only meaningful at a node without crossing traffic: two or more in, one out, or one in one out
  if (node.outgoingSegments.length !== 1) return null;
  return { lanesIn: lanes(node.incomingSegments), lanesOut: lanes(node.outgoingSegments) };
}

/** Dijkstra distance (m) from a node to another, optionally avoiding some edges. */
export function networkDistance(net: TrafficNetwork, from: string, to: string, avoid: ReadonlySet<string> = new Set(), maxM = 20000): number | null {
  const dist = new Map<string, number>([[from, 0]]);
  const done = new Set<string>();
  const queue: [number, string][] = [[0, from]];
  while (queue.length) {
    queue.sort((a, b) => a[0] - b[0]);
    const [dcur, n] = queue.shift()!;
    if (done.has(n)) continue;
    if (n === to) return dcur;
    if (dcur > maxM) return null;
    done.add(n);
    for (const eid of net.nodes.get(n)?.outgoingSegments ?? []) {
      if (avoid.has(eid)) continue;
      const e = net.edges.get(eid); if (!e) continue;
      const nd = dcur + e.length;
      if (nd < (dist.get(e.toNodeId) ?? Infinity)) { dist.set(e.toNodeId, nd); queue.push([nd, e.toNodeId]); }
    }
  }
  return null;
}

/**
 * Detour ratio around a stretch: walk ~`reachM` upstream and downstream along the busiest links, then the shortest
 * path between those points that avoids the stretch, over their straight-line distance. Null when no detour exists
 * within the area (that is reported through noAlternativeShare instead).
 */
export function detourRatioAround(net: TrafficNetwork, edgeIds: readonly string[], vph: ReadonlyMap<string, number>, reachM = 300): number | null {
  const es = edgeIds.map(id => net.edges.get(id)).filter((e): e is NonNullable<typeof e> => !!e);
  if (!es.length) return null;
  const busiest = (ids: string[]) => ids.map(id => net.edges.get(id)).filter((e): e is NonNullable<typeof e> => !!e).sort((a, b) => (vph.get(b.id) ?? 0) - (vph.get(a.id) ?? 0))[0];
  let u = es[0].fromNodeId, back = 0;
  for (let i = 0; i < 20 && back < reachM; i++) { const e = busiest(net.nodes.get(u)?.incomingSegments ?? []); if (!e || e.fromNodeId === es[es.length - 1].toNodeId) break; back += e.length; u = e.fromNodeId; }
  let v = es[es.length - 1].toNodeId, fwd = 0;
  for (let i = 0; i < 20 && fwd < reachM; i++) { const e = busiest(net.nodes.get(v)?.outgoingSegments ?? []); if (!e || e.toNodeId === es[0].fromNodeId) break; fwd += e.length; v = e.toNodeId; }
  const straight = distM(net.nodes.get(u)!.coordinates, net.nodes.get(v)!.coordinates);
  if (straight < 50) return null;
  const alt = networkDistance(net, u, v, new Set(edgeIds), straight * 5);
  return alt === null ? null : alt / straight;
}

/**
 * Builds the evidence for the run's problem locations: the selected road's directions (at their downstream end,
 * from the micro-simulation) and the area's worst places (assignment). Then classifies each. `maxArea`: how many
 * of the area's bottlenecks to include.
 */
export function diagnoseAnalysis(r: RoadAnalysisResult, area: StudyArea, roads: ReadonlyMap<string, DrivableObject>, maxArea = 3): Diagnosis {
  const net = area.network;
  const js = groupJunctions(net, roads);
  const notes: string[] = [
    'Model output (ESTIMATED): causes are inferred from the run\'s own delay attribution, signal plans and assigned demand, not from measurements.',
    `Demand in PCU uses the simulated fleet's mean PCU (${FLEET_MEAN_PCU.toFixed(2)}, IRC:106-1990 factors by class share) and Indo-HCM saturation flow on 3.5 m lanes (assumed lane width).`,
  ];
  const locations: DiagnosedLocation[] = [];
  const seeds = r.perSeed.length;

  for (const d of r.directions) {
    if (!d.delay || d.vph <= 0) continue;
    const end = d.paths.at(-1)?.at(-1);
    if (!end) continue;
    const j = junctionNear(js, net, end, 40);
    const sig = j ? signalEvidence(j, r, net) : null;
    const chain = r.cause.chain && r.cause.chain.direction === d.label ? r.cause.chain : null;
    const ev: LocationEvidence = {
      id: `dir:${d.label}`, label: `${r.section.name} ${d.label}${j ? ` at ${j.label}` : ''}`, coordinates: [end[0], end[1]], scope: 'corridor',
      junctionId: j?.id ?? null, roadIds: d.roadIds ?? [], direction: d.label, seeds, delay: d.delay, signal: sig?.evidence ?? null,
      demandPcu: d.demandPcu, capacityPcu: d.capacityPcu, capacityBasis: d.capacityBasis,
      spillback: chain?.root ? { rootLabel: chain.root.label, rootCoordinates: chain.root.coordinates, agreement: chain.agreement, seeds: chain.seeds, blockedShare: d.delay.total > 0 ? d.delay.blocked / d.delay.total : chain.blockedShare } : null,
    };
    const la = lanesAt(net, end); if (la) { ev.lanesIn = la.lanesIn; ev.lanesOut = la.lanesOut; }
    // Coordination: another signalised junction of the run upstream of this direction's end, within range
    if (sig && d.delay.signal > 0) {
      const own = r.junctions.find(x => x.signalised && distM(x.coordinates, end) < 60);
      const upstream = r.junctions.filter(x => x.signalised && x !== own && distM(x.coordinates, end) < COORDINATION_RANGE_M && distM(x.coordinates, end) > 60
        && d.paths.some(p => p.some(q => distM(q, x.coordinates) < 40)));
      const nb = upstream.sort((a, b) => distM(a.coordinates, end) - distM(b.coordinates, end))[0];
      const ownCycle = sig.evidence.cycleS;
      const nbCycle = nb ? (r.signalCycles?.get(nb.id) ?? null) : null;
      if (nb && nbCycle !== null) {
        const ph = sig.evidence.phases.find(p => p.arms.length) ?? sig.evidence.phases[0];
        const { x } = phaseSaturation(sig.evidence);
        const gC = Math.max(0.05, (ph.greenS + sig.evidence.amberS - STARTUP_LOST_S) / ownCycle);
        ev.coordination = { neighbourLabel: nb.label, distanceM: distM(nb.coordinates, end), ownCycleS: ownCycle, neighbourCycleS: nbCycle, observedSignalDelayS: d.delay.signal, randomArrivalDelayS: randomArrivalDelay(ownCycle, gC, Math.max(...x)) };
      }
    }
    // Connectivity of the stretch the direction runs on
    const dirEdges = [...r.areaLinkVph.keys()].filter(id => (d.roadIds ?? []).some(rid => id.startsWith(`${rid}_`)) && net.edges.get(id) && d.paths.some(p => p.some(q => distM(q, net.edges.get(id)!.coordinates[0]) < 5)));
    if (dirEdges.length) ev.detourRatio = detourRatioAround(net, dirEdges, r.areaLinkVph);
    const severity = (d.delay.total * d.vph) / 3600;
    locations.push({ evidence: ev, causes: classifyLocation(ev), severity });
  }

  for (const b of [...r.areaBottlenecks].sort((a, b2) => b2.delayVehH - a.delayVehH).slice(0, maxArea)) {
    if (locations.some(l => distM(l.evidence.coordinates, b.coordinates) < 60)) continue;
    const edges = b.segmentKeys.flatMap(k => [`${k}_fwd`, `${k}_bwd`, k]).filter(id => net.edges.has(id));
    const cap = edges.reduce((m, id) => Math.max(m, net.edges.get(id)!.capacity), 0);
    const vph = edges.reduce((m, id) => Math.max(m, r.areaLinkVph.get(id) ?? 0), 0);
    const j = b.atJunction ? junctionNear(js, net, b.coordinates, 40) : null;
    const sig = j ? signalEvidence(j, r, net) : null;
    const ev: LocationEvidence = {
      id: `area:${b.segmentKeys[0] ?? b.label}`, label: b.label, coordinates: [b.coordinates[0], b.coordinates[1]], scope: 'area', junctionId: j?.id ?? null,
      roadIds: [...new Set(edges.map(id => net.edges.get(id)!.roadId))], seeds,
      // Assignment: demand over the link capacity it was assigned against (veh/h, as the assignment's v/c)
      demandPcu: cap > 0 ? b.vc * cap : vph, capacityPcu: cap > 0 ? cap : undefined, capacityBasis: 'assignment',
      signal: sig?.evidence ?? null, noAlternativeShare: b.noAlternativeShare,
    };
    const end = edges.length ? net.edges.get(edges[0])!.coordinates.at(-1)! : b.coordinates;
    const la = lanesAt(net, end); if (la) { ev.lanesIn = la.lanesIn; ev.lanesOut = la.lanesOut; }
    const busy = edges.filter(id => (r.areaLinkVph.get(id) ?? 0) > 0);
    if (busy.length) ev.detourRatio = detourRatioAround(net, busy, r.areaLinkVph);
    locations.push({ evidence: ev, causes: classifyLocation(ev), severity: b.delayVehH });
  }
  if (r.areaBottlenecks.length) notes.push('Area locations come from the static assignment only (no delay attribution): their causes are rated at most medium unless signal evidence exists.');
  locations.sort((a, b) => b.severity - a.severity);
  return { locations, notes, label: 'ESTIMATED — model output' };
}

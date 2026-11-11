import type { RoadAnalysisResult } from '../simulation/RoadAnalysis';
import type { InputCheck } from '../simulation/ScenarioComparison';
import type { OrdinalClass } from './candidates';

/**
 * Multi-objective comparison of scenarios (mission §13; research decision A7 in
 * docs/RESEARCH_AND_TECHNICAL_DECISIONS.md; docs/SCENARIO_GENERATOR.md §5).
 *
 *  1. A metric registry: definition, unit, direction, source, noise threshold.
 *  2. The Pareto (non-dominated) set over the objectives the user selects.
 *     Dominance needs every selected value KNOWN for both scenarios: an unknown
 *     value can neither dominate nor be dominated (the pair is "incomparable").
 *     A simulated difference counts only if it exceeds the noise threshold AND
 *     every seed shows it (the rule ScenarioComparison.ts uses for its verdict).
 *  3. An optional weighted ranking shown BESIDE the Pareto set, with its weights
 *     and normalisation, never instead of it. No TOPSIS/AHP (rank reversal).
 */

export type MetricId = 'meanTravelTime' | 'meanDelay' | 'throughput' | 'servedShare' | 'maxQueue' | 'sectionSpeed' | 'areaVehHours' | 'fuel' | 'co2' | 'costClass' | 'landTake' | 'disruption';

export interface MetricDef {
  id: MetricId;
  label: string;
  unit: string;
  better: 'lower' | 'higher';
  definition: string;
  source: string;
  /** Relative difference below which two values are a tie. */
  noise: number;
  kind: 'simulated' | 'assignment' | 'ordinal' | 'emissions';
}

export const METRICS: MetricDef[] = [
  { id: 'meanTravelTime', label: 'Mean trip time', unit: 's', better: 'lower', kind: 'simulated', noise: 0.03, definition: 'Mean travel time of trips completed in the simulated neighbourhood during the measured window (incl. time waiting to enter).', source: 'Corridor micro-simulation, mean over seeds (RoadAnalysisResult.perSeed.meanTravelTimeS). Model output (ESTIMATED).' },
  { id: 'meanDelay', label: 'Mean delay per trip', unit: 's', better: 'lower', kind: 'simulated', noise: 0.05, definition: 'Trip time minus free-flow time, mean over completed trips.', source: 'Corridor micro-simulation (perSeed.meanDelayS). Model output.' },
  { id: 'throughput', label: 'Trips completed', unit: 'trips', better: 'higher', kind: 'simulated', noise: 0.03, definition: 'Trips that finished in the neighbourhood in the measured window (network throughput, not demand and not a count).', source: 'Corridor micro-simulation (perSeed.completedTrips). Model output.' },
  { id: 'servedShare', label: 'Share of routed traffic served', unit: '%', better: 'higher', kind: 'simulated', noise: 0.03, definition: 'Vehicles released into the neighbourhood / vehicles routed to it.', source: 'Corridor micro-simulation (perSeed.servedShare). Model output.' },
  { id: 'maxQueue', label: 'Longest junction queue', unit: 'm', better: 'lower', kind: 'simulated', noise: 0.1, definition: 'Longest queue measured at any of the 10 busiest junctions near the road (mean over seeds; per-seed values are not kept, so only the noise threshold applies).', source: 'Corridor micro-simulation (junctionStats maxQueueM). Model output.' },
  { id: 'sectionSpeed', label: 'Speed on the selected road', unit: 'km/h', better: 'higher', kind: 'simulated', noise: 0.05, definition: 'Section length / mean time to drive it.', source: 'Corridor micro-simulation (perSeed.sectionTimeS). Model output.' },
  { id: 'areaVehHours', label: 'Total time in the area', unit: 'veh·h', better: 'lower', kind: 'assignment', noise: 0.01, definition: 'Vehicle-hours over the whole study area at user equilibrium (includes re-routed trips).', source: 'Static assignment (Frank-Wolfe, BPR). Model output, deterministic.' },
  { id: 'fuel', label: 'Fuel', unit: 'L/h', better: 'lower', kind: 'emissions', noise: 0.03, definition: 'Fuel use from a vehicle-specific instantaneous model (speed, acceleration, idling).', source: 'Corridor micro-simulation, SUMO HBEFA4 coefficients (engine/emissions); two- and three-wheelers use stand-in classes. Per hour of the measured window, mean of seeds.' },
  { id: 'co2', label: 'CO₂', unit: 'kg/h', better: 'lower', kind: 'emissions', noise: 0.03, definition: 'CO₂ from the same model as fuel.', source: 'Corridor micro-simulation, SUMO HBEFA4 coefficients (engine/emissions). Per hour of the measured window, mean of seeds.' },
  { id: 'costClass', label: 'Works cost class', unit: '1–5', better: 'lower', kind: 'ordinal', noise: 0, definition: 'Ordinal class of the type of works (0 = no works). Not money.', source: 'Generator classes by works type (docs/SCENARIO_GENERATOR.md §3.3).' },
  { id: 'landTake', label: 'Land take', unit: 'class', better: 'lower', kind: 'ordinal', noise: 0, definition: '0 = no physical works; 1 = feasibility screening infers works outside the existing right of way; unknown otherwise.', source: 'Feasibility engine findings (outsideExistingRoW) with their certainty.' },
  { id: 'disruption', label: 'Construction disruption class', unit: '1–5', better: 'lower', kind: 'ordinal', noise: 0, definition: 'Ordinal class of the type of works (0 = none). Not a programme.', source: 'Generator classes by works type.' },
];
export const METRIC_BY_ID = new Map(METRICS.map(m => [m.id, m]));

export interface MetricValue {
  value: number | null;
  perSeed?: (number | null)[];
  status: 'model_output' | 'ordinal' | 'unknown' | 'not_available';
  note?: string;
}

export interface ScenarioRow {
  id: string;
  name: string;
  isBaseline: boolean;
  values: Partial<Record<MetricId, MetricValue>>;
  /** Fair-comparison check against the baseline run (same frozen inputs). */
  inputs?: InputCheck | null;
}

const mean = (xs: (number | null)[]) => { const v = xs.filter((x): x is number => x !== null && Number.isFinite(x)); return v.length ? v.reduce((a, b) => a + b, 0) / v.length : null; };

/** Metric values of one analysis run, plus the ordinal classes of the works (baseline: no works). */
export function metricsOfRun(r: RoadAnalysisResult, works: { cost: OrdinalClass | null; disruption: OrdinalClass | null; landTake: 'none' | 'unknown' | 'possible' | 'outside_row' } | null): Partial<Record<MetricId, MetricValue>> {
  const seeds = r.perSeed;
  const sim = (pick: (s: RoadAnalysisResult['perSeed'][number]) => number | null): MetricValue => { const ps = seeds.map(pick); const v = mean(ps); return { value: v, perSeed: ps, status: v === null ? 'unknown' : 'model_output' }; };
  const len = r.section.lengthM;
  const em = r.emissions ?? null;
  const k = em && em.windowS > 0 ? 3600 / em.windowS : null;
  const emVal = (pick: (s: NonNullable<typeof em>['perSeed'][number]) => number, scale: number): MetricValue => {
    if (!em || k === null) return { value: null, status: 'not_available', note: 'No emissions result in this run.' };
    const ps = em.perSeed.map(s => pick(s) * k * scale);
    return { value: mean(ps), perSeed: ps, status: 'model_output', note: em.label };
  };
  const out: Partial<Record<MetricId, MetricValue>> = {
    meanTravelTime: sim(s => s.meanTravelTimeS),
    meanDelay: sim(s => s.meanDelayS),
    throughput: sim(s => s.completedTrips),
    servedShare: (() => { const v = sim(s => s.servedShare); return { ...v, value: v.value === null ? null : 100 * v.value, perSeed: v.perSeed?.map(x => (x === null ? null : 100 * x)) }; })(),
    maxQueue: { value: r.junctions.length ? Math.max(...r.junctions.map(j => j.maxQueueM)) : null, status: r.junctions.length ? 'model_output' : 'unknown' },
    sectionSpeed: sim(s => (s.sectionTimeS ? (len / s.sectionTimeS) * 3.6 : null)),
    areaVehHours: { value: r.assignment.totalVehHours, status: 'model_output' },
    fuel: emVal(s => s.fuelL, 1),
    co2: emVal(s => s.co2G, 0.001),
  };
  if (!works) {
    out.costClass = { value: 0, status: 'ordinal', note: 'No works.' };
    out.disruption = { value: 0, status: 'ordinal', note: 'No works.' };
    out.landTake = { value: 0, status: 'ordinal', note: 'No works.' };
  } else {
    out.costClass = works.cost?.level ? { value: works.cost.level, status: 'ordinal', note: `${works.cost.label}. ${works.cost.basis}` } : { value: null, status: 'unknown', note: works.cost?.basis };
    out.disruption = works.disruption?.level ? { value: works.disruption.level, status: 'ordinal', note: `${works.disruption.label}. ${works.disruption.basis}` } : { value: null, status: 'unknown' };
    out.landTake = works.landTake === 'none' ? { value: 0, status: 'ordinal', note: 'No physical works.' }
      : works.landTake === 'outside_row' ? { value: 1, status: 'ordinal', note: 'Feasibility screening: works outside the existing right of way (inferred/estimated, see findings).' }
      : { value: null, status: 'unknown', note: 'Right-of-way data not available; land need unknown until surveyed.' };
  }
  return out;
}

export type Relation = 'better' | 'worse' | 'tie' | 'unknown';

/** How scenario a compares with b on one metric (noise threshold; every seed must agree when both have per-seed values). */
export function compareOn(def: MetricDef, a: MetricValue | undefined, b: MetricValue | undefined): Relation {
  if (!a || !b || a.value === null || b.value === null) return 'unknown';
  const sign = def.better === 'lower' ? -1 : 1;
  const diff = (a.value - b.value) * sign;
  const scale = Math.max(Math.abs(b.value), Math.abs(a.value), 1e-9);
  if (def.noise === 0 ? diff === 0 : Math.abs(a.value - b.value) <= def.noise * scale) return 'tie';
  if (a.perSeed && b.perSeed && a.perSeed.length === b.perSeed.length && a.perSeed.length > 1) {
    const agree = a.perSeed.every((x, i) => { const y = b.perSeed![i]; return x !== null && y !== null && (x - y) * sign * Math.sign(diff) > 0; });
    if (!agree) return 'tie';
  }
  return diff > 0 ? 'better' : 'worse';
}

export interface DominanceInfo {
  id: string;
  inPareto: boolean;
  /** Scenarios that dominate it, and on which objectives they are strictly better. */
  dominatedBy: { id: string; betterOn: MetricId[] }[];
  /** Scenarios it cannot be compared with because a selected value is unknown, and which. */
  incomparable: { id: string; unknown: MetricId[] }[];
}

/** a dominates b: on every objective a is better or tied, strictly better on at least one; any unknown → no dominance. */
export function dominates(a: ScenarioRow, b: ScenarioRow, objectives: readonly MetricId[]): { dominates: boolean; betterOn: MetricId[]; unknown: MetricId[] } {
  const unknown: MetricId[] = [], betterOn: MetricId[] = [];
  let worse = false;
  for (const id of objectives) {
    const rel = compareOn(METRIC_BY_ID.get(id)!, a.values[id], b.values[id]);
    if (rel === 'unknown') unknown.push(id);
    else if (rel === 'worse') worse = true;
    else if (rel === 'better') betterOn.push(id);
  }
  return { dominates: !unknown.length && !worse && betterOn.length > 0, betterOn, unknown };
}

export function paretoSet(rows: readonly ScenarioRow[], objectives: readonly MetricId[]): DominanceInfo[] {
  return rows.map(b => {
    const dominatedBy: DominanceInfo['dominatedBy'] = [], incomparable: DominanceInfo['incomparable'] = [];
    for (const a of rows) {
      if (a === b) continue;
      const d = dominates(a, b, objectives);
      if (d.dominates) dominatedBy.push({ id: a.id, betterOn: d.betterOn });
      else if (d.unknown.length) incomparable.push({ id: a.id, unknown: d.unknown });
    }
    return { id: b.id, inPareto: dominatedBy.length === 0, dominatedBy, incomparable };
  });
}

export interface WeightedRanking {
  weights: Partial<Record<MetricId, number>>;
  normalisation: string;
  ranked: { id: string; score: number }[];
  notRanked: { id: string; unknown: MetricId[] }[];
  caveat: string;
}

/** Optional weighted sum of min-max normalised values (1 = best in the set). Rows with an unknown weighted value are not ranked. */
export function weightedRanking(rows: readonly ScenarioRow[], weights: Partial<Record<MetricId, number>>): WeightedRanking {
  const ids = (Object.keys(weights) as MetricId[]).filter(k => (weights[k] ?? 0) > 0);
  const notRanked = rows.map(r => ({ id: r.id, unknown: ids.filter(k => r.values[k]?.value === null || r.values[k]?.value === undefined) })).filter(x => x.unknown.length);
  const ok = rows.filter(r => !notRanked.some(n => n.id === r.id));
  const wSum = ids.reduce((n, k) => n + (weights[k] ?? 0), 0) || 1;
  const ranked = ok.map(r => {
    let s = 0;
    for (const k of ids) {
      const vals = ok.map(x => x.values[k]!.value as number);
      const lo = Math.min(...vals), hi = Math.max(...vals);
      const v = r.values[k]!.value as number;
      const norm = hi > lo ? (METRIC_BY_ID.get(k)!.better === 'lower' ? (hi - v) / (hi - lo) : (v - lo) / (hi - lo)) : 1;
      s += (weights[k] ?? 0) / wSum * norm;
    }
    return { id: r.id, score: Math.round(s * 1000) / 1000 };
  }).sort((a, b) => b.score - a.score);
  return { weights: Object.fromEntries(ids.map(k => [k, weights[k]])), normalisation: 'min-max over the ranked scenarios (1 = best value in this set, 0 = worst); weights divided by their sum', ranked, notRanked,
    caveat: 'A weighted sum depends on the weights and on which scenarios are in the set, and cannot reach trade-offs on non-convex parts of the Pareto front (Das & Dennis 1997). It is shown beside the Pareto set, not instead of it. Seed noise is ignored here; the Pareto set applies it.' };
}

export interface ScenarioExplanation {
  id: string;
  improved: string[];
  worse: string[];
  assumptions: string[];
  missing: string[];
  confidence: { level: 'low' | 'medium' | 'high'; text: string };
  investigation: string[];
}

/** Plain-language explanation of one scenario against the baseline row. */
export function explainScenario(row: ScenarioRow, baseline: ScenarioRow, extra: { assumptions?: string[]; limitations?: string[]; investigations?: string[]; comparisonConfidence?: { level: 'low' | 'medium' | 'high'; text: string } } = {}): ScenarioExplanation {
  const improved: string[] = [], worse: string[] = [], missing: string[] = [];
  for (const m of METRICS) {
    const a = row.values[m.id], b = baseline.values[m.id];
    if (!a || a.value === null) { missing.push(`${m.label}: ${a?.status === 'not_available' ? 'not available' : 'unknown'}${a?.note ? ` (${a.note})` : ''}`); continue; }
    const rel = compareOn(m, a, b);
    const txt = `${m.label} ${fmt(b?.value ?? null)} → ${fmt(a.value)} ${m.unit}`;
    if (rel === 'better') improved.push(txt); else if (rel === 'worse') worse.push(txt);
  }
  const assumptions = [...(extra.assumptions ?? [])];
  if (row.inputs && !row.inputs.matched) for (const d of row.inputs.differences) assumptions.unshift(`DIFFERS from the baseline run: ${d.input}: ${d.before} vs ${d.after}.`);
  else if (row.inputs?.matched) assumptions.unshift('Same frozen demand, hour, seeds, warm-up, measured period, signal settings and corrections as the baseline run.');
  let confidence = extra.comparisonConfidence ?? { level: 'low' as const, text: 'No comparison confidence available.' };
  if (row.inputs && !row.inputs.matched) confidence = { level: 'low', text: `Inputs differ from the baseline (${row.inputs.mismatches.join(', ')}): not like with like.` };
  return { id: row.id, improved, worse, assumptions, missing, confidence, investigation: [...(extra.limitations ?? []), ...(extra.investigations ?? [])] };
}

const fmt = (v: number | null) => (v === null ? '—' : Math.abs(v) >= 100 ? Math.round(v).toLocaleString() : String(Math.round(v * 10) / 10));

/**
 * Scaling OD flows toward observed movement counts.
 *
 * Each OD trip follows a fixed route, so the counted movements it passes are
 * known. The flow the trips put on movement m is  A_m = sum_t f_t v_t  over
 * trips t through m (v_t its flow, f_t its scale factor). Iterative
 * proportional fitting visits each counted movement in turn and multiplies the
 * factors of the trips through it by (O_m / A_m)^damping, then clamps every
 * factor to [minFactor, maxFactor]. Repeating this converges when the counts
 * are mutually consistent; when they are not (or a factor hits its bound) it
 * settles on a compromise, and the result says so.
 *
 * Guards against over-fitting: factors are bounded (default 0.25-4), a trip
 * through no counted movement is left as it is, and the result reports how
 * many factors hit a bound and the fit at every iteration.
 */
import { geh, summarizeGeh, type GehSummary } from './geh';

export interface IpfOptions { maxIterations?: number; tolerance?: number; minFactor?: number; maxFactor?: number; damping?: number }
export interface IpfIteration { iteration: number; maxRelativeError: number; geh: GehSummary }
export interface IpfResult {
  factors: number[];
  iterations: number;
  converged: boolean;
  history: IpfIteration[];
  /** Trips whose factor ended at minFactor or maxFactor. */
  cappedTrips: number;
  /** Counted movements no trip passes through (cannot be fitted by scaling). */
  unreachable: string[];
  before: Map<string, number>;
  after: Map<string, number>;
}

export function assignedFlows(flows: readonly number[], factors: readonly number[], incidence: readonly (readonly string[])[]): Map<string, number> {
  const out = new Map<string, number>();
  flows.forEach((v, t) => { for (const m of incidence[t]) out.set(m, (out.get(m) ?? 0) + v * factors[t]); });
  return out;
}

export function gehAgainst(observed: ReadonlyMap<string, number>, modelled: ReadonlyMap<string, number>): GehSummary {
  return summarizeGeh([...observed].map(([m, o]) => geh(modelled.get(m) ?? 0, o)));
}

export function calibrateFlows(
  flows: readonly number[],
  incidence: readonly (readonly string[])[],
  observed: ReadonlyMap<string, number>,
  options: IpfOptions = {},
): IpfResult {
  const { maxIterations = 50, tolerance = 0.01, minFactor = 0.25, maxFactor = 4, damping = 1 } = options;
  const factors = flows.map(() => 1);
  const tripsOf = new Map<string, number[]>();
  incidence.forEach((ms, t) => { for (const m of new Set(ms)) if (observed.has(m)) { if (!tripsOf.has(m)) tripsOf.set(m, []); tripsOf.get(m)!.push(t); } });
  const unreachable = [...observed.keys()].filter(m => !(tripsOf.get(m) ?? []).some(t => flows[t] > 0));
  const before = assignedFlows(flows, factors, incidence);
  const history: IpfIteration[] = [];
  let converged = false, iteration = 0;
  const relErr = () => {
    const a = assignedFlows(flows, factors, incidence);
    let worst = 0;
    for (const [m, o] of observed) if (tripsOf.has(m) && !unreachable.includes(m)) worst = Math.max(worst, Math.abs((a.get(m) ?? 0) - o) / Math.max(o, 1));
    return { worst, a };
  };
  for (iteration = 1; iteration <= maxIterations; iteration++) {
    for (const [m, o] of observed) {
      const ts = tripsOf.get(m);
      if (!ts) continue;
      const a = ts.reduce((n, t) => n + flows[t] * factors[t], 0);
      if (a <= 0) continue;
      const r = Math.pow(o / a, damping);
      for (const t of ts) factors[t] = Math.min(maxFactor, Math.max(minFactor, factors[t] * r));
    }
    const { worst, a } = relErr();
    history.push({ iteration, maxRelativeError: worst, geh: gehAgainst(observed, a) });
    if (worst <= tolerance) { converged = true; break; }
    // Stalled (bounds or inconsistent counts): stop rather than spin
    if (history.length > 3 && Math.abs(history[history.length - 4].maxRelativeError - worst) < tolerance / 10) break;
  }
  const capped = factors.filter((f, t) => incidence[t].some(m => observed.has(m)) && (f <= minFactor + 1e-9 || f >= maxFactor - 1e-9)).length;
  return { factors, iterations: Math.min(iteration, maxIterations), converged, history, cappedTrips: capped, unreachable, before, after: assignedFlows(flows, factors, incidence) };
}

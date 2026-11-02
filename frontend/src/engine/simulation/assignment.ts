/**
 * Route choice with congestion feedback: the simulator routes each OD trip on
 * its usual (free-flow, class-weighted) link costs; this runs the demand,
 * measures each link's congested travel time, and feeds the ratio of
 * congested to free-flow time back into route costs, averaged over the
 * iterations by the method of successive averages (MSA: the factor after
 * iteration k is the mean of the measured ratios so far, so it settles
 * instead of flip-flopping between routes). This is the standard iterative
 * scheme for simulation-based assignment (e.g. DTA "simulation-assignment"
 * loops; Sheffi 1985, Urban Transportation Networks, on MSA).
 */
import type { DemandPlan } from './StudyDemand';
import { STEP_S, type TrafficMicroSim } from './TrafficMicroSim';
import { buildSim, type SimSetup } from '../calibration/calibration';

export interface AssignmentIteration {
  iteration: number;
  /** Mean ratio of congested to free-flow time over used links. */
  meanCongestion: number;
  /** Share of OD flow whose route changed from the previous iteration. */
  rerouted: number;
  completedTrips: number;
  meanSpeedKmh: number | null;
}

export interface AssignmentResult { linkCostFactors: Map<string, number>; history: AssignmentIteration[] }

/** Cap on a link's cost factor: a link that is jammed in one run is not made unusable. */
export const MAX_COST_FACTOR = 10;

export async function assignWithFeedback(setup: SimSetup, plan: DemandPlan, o: { iterations: number; warmupS: number; measureS: number;
  /** Called after each iteration's run with the measured congestion ratios (for tests and reports). */
  onIteration?: (k: number, measured: ReadonlyMap<string, number>, sim: TrafficMicroSim) => void }): Promise<AssignmentResult> {
  const factors = new Map<string, number>();
  const history: AssignmentIteration[] = [];
  let lastRoutes: Map<number, string> | null = null;
  for (let k = 1; k <= o.iterations; k++) {
    const sim = buildSim({ ...setup, options: { ...setup.options, linkCostFactors: factors } }, plan);
    const routes = new Map(sim.demandRouteFlows().map(f => [f.index, f.route.join(',')]));
    const flowOf = new Map(sim.demandRouteFlows().map(f => [f.index, f.vehiclesPerHour]));
    let changed = 0, total = 0;
    if (lastRoutes) routes.forEach((r, i) => { const q = flowOf.get(i) ?? 0; total += q; if (lastRoutes!.get(i) !== r) changed += q; });
    lastRoutes = routes;
    const steps = Math.round((o.warmupS + o.measureS) / STEP_S);
    for (let i = 0; i < steps; i++) {
      sim.step();
      if (i % 2000 === 1999) await new Promise<void>(r => setTimeout(r, 0));
    }
    const times = sim.linkTravelTimes();
    const measured = new Map<string, number>();
    times.forEach((t, id) => measured.set(id, Math.min(MAX_COST_FACTOR, Math.max(1, t.meanS / Math.max(t.freeFlowS, 0.1)))));
    // MSA: each factor is the running mean of the ratios measured so far. A link
    // nobody used in this iteration ran at free flow (ratio 1), so links used
    // earlier relax back towards 1 instead of keeping their last congested value.
    new Set([...factors.keys(), ...measured.keys()]).forEach(id => {
      const ratio = measured.get(id) ?? 1;
      const prev = factors.get(id) ?? 1;
      factors.set(id, prev + (ratio - prev) / k);
    });
    o.onIteration?.(k, measured, sim);
    let sum = 0;
    measured.forEach(r => { sum += r; });
    const n = measured.size;
    const m = sim.getMetrics();
    history.push({ iteration: k, meanCongestion: n ? sum / n : 1, rerouted: total ? changed / total : 0, completedTrips: m.completedTrips, meanSpeedKmh: m.meanSpeedKmh });
  }
  return { linkCostFactors: factors, history };
}

import type { StudyArea, DrivableObject } from './StudyAreaExplorer';
import { TrafficMicroSim, STEP_S, MAX_VEHICLES, type MicroSimOptions } from './TrafficMicroSim';
import { snapDemandPlan, type DemandPlan } from './StudyDemand';
import { analyseRoad, countChecks, type RoadAnalysisResult, type CountCheck } from './RoadAnalysis';
import type { RoadSection } from './roadSection';
import type { CountJunction } from '../calibration/observedCounts';
/** Cap on a link's cost factor (as assignment.ts): a link jammed in one run is not made unusable. */
const MAX_COST_FACTOR = 10;

/**
 * One repeatable analysis run of a study area: fixed OD demand (the plan's
 * coordinates, snapped onto the network as it is now), fixed seed, fixed hour.
 * With feedbackIterations > 0, drivers first adapt their routes to the
 * congestion they meet (MSA over congested/free-flow link times, as in
 * assignment.ts), so a change to the roads can move traffic onto or off them.
 * Then a fresh run from an empty network is measured.
 *
 * Plain data in and out: runs in a Web Worker (analysis.worker.ts) or, where
 * there is none (tests), on the calling thread in slices.
 */
export interface AnalysisJob {
  area: StudyArea;
  roads: ReadonlyMap<string, DrivableObject>;
  options: Omit<MicroSimOptions, 'demandTrips' | 'linkCostFactors' | 'watchRoadIds' | 'watchSegmentKeys'>;
  plan: DemandPlan;
  section: RoadSection;
  hourFactor: number;
  feedbackIterations: number;
  warmupS: number;
  measureS: number;
  countJunctions?: readonly CountJunction[];
}

export interface AnalysisOutput {
  result: RoadAnalysisResult;
  counts: CountCheck[];
  /** Share of OD flow on a different route after route adaptation, per iteration. */
  rerouted: number[];
  /** Whether drivers' routes were adapted to the congestion of a first run, and why not when they were not. */
  adaptation: { applied: boolean; reason: string | null };
  /** Planned vehicles per hour actually given a route (the rest cannot reach their destination on this network). */
  routedVph: number;
  unroutedVph: number;
  elapsedMs: number;
}

export const DEFAULT_ANALYSIS = { feedbackIterations: 1, warmupS: 300, measureS: 900 } as const;

export async function runAnalysisJob(job: AnalysisJob, onProgress?: (share: number) => void, yieldEveryMs = 25, cancelled?: () => boolean): Promise<AnalysisOutput> {
  const t0 = Date.now();
  const trips = snapDemandPlan(job.plan, job.area.network, 250, new Set(job.area.segments.map(s => s.key)));
  const build = (factors: Map<string, number>) => {
    const sim = new TrafficMicroSim(job.area, job.roads, { ...job.options, watchSegmentKeys: job.section.segmentKeys, linkCostFactors: factors, demandTrips: trips });
    sim.setHourFactor(job.hourFactor);
    return sim;
  };
  const runSteps = Math.round((job.warmupS + job.measureS) / STEP_S);
  const total = runSteps * (job.feedbackIterations + 1);
  let done = 0, last = Date.now();
  const tick = async () => {
    done++;
    if (Date.now() - last > yieldEveryMs) {
      onProgress?.(done / total);
      await new Promise<void>(r => setTimeout(r, 0));
      if (cancelled?.()) throw new Error('cancelled');
      last = Date.now();
    }
  };

  const factors = new Map<string, number>();
  const rerouted: number[] = [];
  let adaptation: AnalysisOutput['adaptation'] = { applied: job.feedbackIterations > 0, reason: null };
  let lastRoutes: Map<number, string> | null = null;
  for (let k = 1; k <= job.feedbackIterations; k++) {
    const sim = build(factors);
    const flows = sim.demandRouteFlows();
    const routes = new Map(flows.map(f => [f.index, f.route.join(',')]));
    if (lastRoutes) {
      let changed = 0, sum = 0;
      for (const f of flows) { sum += f.vehiclesPerHour; if (lastRoutes.get(f.index) !== routes.get(f.index)) changed += f.vehiclesPerHour; }
      rerouted.push(sum ? changed / sum : 0);
    }
    lastRoutes = routes;
    for (let i = 0; i < runSteps; i++) { sim.step(); await tick(); }
    // Travel times from a network past its capacity measure gridlock, not route choice: routes on jammed links would
    // all get the maximum cost and traffic would be pushed onto side streets to no purpose. Keep the routes then, and say so.
    const m = sim.getMetrics(), tripsInRun = m.inflowVph * (job.warmupS + job.measureS) / 3600;
    const overloaded = m.onNetwork >= 0.98 * MAX_VEHICLES || (tripsInRun > 0 && (m.gridlockRemovals > 0.05 * tripsInRun || m.waitingToEnter > 0.1 * tripsInRun));
    if (overloaded) {
      adaptation = { applied: false, reason: 'Routes were not adapted to congestion: the network was past its modelled capacity, so measured delays reflect gridlock rather than route choice. Drivers take the fastest free-flow routes.' };
      break;
    }
    const measured = new Map<string, number>();
    sim.linkTravelTimes().forEach((t, id) => measured.set(id, Math.min(MAX_COST_FACTOR, Math.max(1, t.meanS / Math.max(t.freeFlowS, 0.1)))));
    new Set([...factors.keys(), ...measured.keys()]).forEach(id => {
      const prev = factors.get(id) ?? 1;
      factors.set(id, prev + ((measured.get(id) ?? 1) - prev) / k);
    });
  }
  const sim = build(factors);
  const flows = sim.demandRouteFlows();
  if (lastRoutes && adaptation.applied) {
    let changed = 0, sum = 0;
    for (const f of flows) { sum += f.vehiclesPerHour; if (lastRoutes.get(f.index) !== f.route.join(',')) changed += f.vehiclesPerHour; }
    rerouted.push(sum ? changed / sum : 0);
  }
  const routedVph = flows.filter(f => f.route.length).reduce((n, f) => n + f.vehiclesPerHour, 0);
  const unroutedVph = flows.filter(f => !f.route.length).reduce((n, f) => n + f.vehiclesPerHour, 0);
  const layouts = job.countJunctions?.length ? sim.setCountZones(job.countJunctions.map(j => ({ id: j.id, lng: j.location.lon, lat: j.location.lat, radiusM: j.location.matched?.kind === 'roundabout' ? 70 : 60 }))) : [];
  const warm = Math.round(job.warmupS / STEP_S);
  for (let i = 0; i < warm; i++) { sim.step(); await tick(); }
  sim.startAnalysis();
  for (let i = warm; i < runSteps; i++) { sim.step(); await tick(); }
  const result = analyseRoad(sim, job.area, job.roads, job.section, job.plan.provenance);
  onProgress?.(1);
  return { result, counts: job.countJunctions?.length ? countChecks(sim, layouts, job.countJunctions) : [], rerouted, adaptation, routedVph, unroutedVph, elapsedMs: Date.now() - t0 };
}

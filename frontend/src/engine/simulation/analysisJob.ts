import type { StudyArea, DrivableObject } from './StudyAreaExplorer';
import { TrafficMicroSim, STEP_S, type MicroSimOptions } from './TrafficMicroSim';
import { snapDemandPlan, type DemandPlan } from './StudyDemand';
import { countChecks, sectionDirections, readCorridorRun, areaContext, combineAnalysis, type RoadAnalysisResult, type CountCheck, type CorridorRun } from './RoadAnalysis';
import type { RoadSection } from './roadSection';
import type { CountJunction } from '../calibration/observedCounts';
import { assignTraffic, subareaDemand } from './staticAssignment';

/**
 * One repeatable analysis of a selected road (docs/OVERHAUL.md §9):
 *
 *  1. the area's demand at the chosen hour is assigned to the whole study
 *     area by user equilibrium (staticAssignment.ts): every road's volume,
 *     v/c, the select-link analysis and the area's bottlenecks;
 *  2. the paths that cross the selected road's neighbourhood (the corridor,
 *     CORRIDOR_RANGE_M along the roads from it) become the corridor's demand,
 *     each trip entering where its path enters and taking the same links;
 *  3. the corridor is micro-simulated with several random seeds (warm-up,
 *     then a counted window), with delay attribution and queue tracing.
 *
 * Same inputs, same result. Plain data in and out: runs in a Web Worker
 * (analysis.worker.ts) or, without one (tests), on the calling thread in
 * slices.
 */
export interface AnalysisJob {
  area: StudyArea;
  /** The selected road's neighbourhood (same network, smaller range), simulated vehicle by vehicle. */
  corridor: StudyArea;
  roads: ReadonlyMap<string, DrivableObject>;
  options: Omit<MicroSimOptions, 'demandTrips' | 'linkCostFactors' | 'watchRoadIds' | 'watchSegmentKeys' | 'seed'> & { seed?: number };
  plan: DemandPlan;
  section: RoadSection;
  hourFactor: number;
  seeds: readonly number[];
  warmupS: number;
  measureS: number;
  countJunctions?: readonly CountJunction[];
}

export interface AnalysisOutput {
  result: RoadAnalysisResult;
  counts: CountCheck[];
  /** The corridor's demand (veh/h at the run's hour), frozen, for the live view and comparisons. */
  corridorPlan: DemandPlan;
  /** Planned vehicles per hour given a route in the area, and those that cannot reach their destination. */
  routedVph: number;
  unroutedVph: number;
  timings: { assignmentMs: number; simulationMs: number };
  elapsedMs: number;
}

export const DEFAULT_SEEDS = [42, 7, 11] as const;
export const CORRIDOR_RANGE_M = 700;
export const DEFAULT_ANALYSIS = { warmupS: 300, measureS: 900, seeds: DEFAULT_SEEDS } as const;

/** The corridor's demand from an assignment: paths cut to the corridor, as a plan. */
export function corridorPlanOf(job: AnalysisJob, assignment: ReturnType<typeof assignTraffic>): DemandPlan {
  const inside = new Set(job.corridor.segments.map(s => s.key));
  const trips = subareaDemand(assignment, inside);
  const vph = trips.reduce((n, t) => n + t.vehiclesPerHour, 0);
  return { trips, provenance: { ...job.plan.provenance, vehiclesPerHour: vph, pairCount: trips.length,
    label: `Traffic the area assignment routes through the neighbourhood of the selected road (${Math.round(vph).toLocaleString()} veh/h at this hour), each vehicle entering where its route enters and taking the same roads. ${job.plan.provenance.label}` } };
}

export async function runAnalysisJob(job: AnalysisJob, onProgress?: (share: number) => void, yieldEveryMs = 25, cancelled?: () => boolean): Promise<AnalysisOutput> {
  // Never report progress before the caller holds the run (main-thread fallback runs synchronously up to the first await)
  await new Promise<void>(r => setTimeout(r, 0));
  if (cancelled?.()) throw new Error('cancelled');
  const t0 = Date.now();
  const segs = new Set(job.area.segments.map(s => s.key));
  const trips = snapDemandPlan(job.plan, job.area.network, 250, segs).map(t => ({ ...t, vehiclesPerHour: t.vehiclesPerHour * job.hourFactor }));
  const assignment = assignTraffic(job.area, job.roads, trips, { signalPoints: job.options.signalPoints });
  const assignmentMs = Date.now() - t0;
  await new Promise<void>(r => setTimeout(r, 0));
  if (cancelled?.()) throw new Error('cancelled');
  onProgress?.(0.15);

  const dirs = sectionDirections(job.area, job.section);
  const demandVph = job.plan.provenance.vehiclesPerHour * job.hourFactor;
  const ctx = areaContext(assignment, job.area, job.roads, job.section, dirs, demandVph);
  const corridorPlan = corridorPlanOf(job, assignment);
  const corridorSegs = new Set(job.corridor.segments.map(s => s.key));
  const microTrips = snapDemandPlan(corridorPlan, job.corridor.network, 60, corridorSegs);

  const runSteps = Math.round((job.warmupS + job.measureS) / STEP_S);
  const total = runSteps * job.seeds.length;
  let done = 0, last = Date.now();
  const tick = async () => {
    done++;
    if (Date.now() - last > yieldEveryMs) {
      onProgress?.(0.15 + 0.85 * done / total);
      await new Promise<void>(r => setTimeout(r, 0));
      if (cancelled?.()) throw new Error('cancelled');
      last = Date.now();
    }
  };
  const runs: CorridorRun[] = [];
  let counts: CountCheck[] = [];
  const t1 = Date.now();
  for (const seed of job.seeds) {
    const sim = new TrafficMicroSim(job.corridor, job.roads, { ...job.options, seed, watchSegmentKeys: job.section.segmentKeys, demandTrips: microTrips });
    sim.setHourFactor(1);
    const layouts = job.countJunctions?.length && seed === job.seeds[0] ? sim.setCountZones(job.countJunctions.map(j => ({ id: j.id, lng: j.location.lon, lat: j.location.lat, radiusM: j.location.matched?.kind === 'roundabout' ? 70 : 60 }))) : [];
    const warm = Math.round(job.warmupS / STEP_S);
    for (let i = 0; i < warm; i++) { sim.step(); await tick(); }
    sim.startAnalysis();
    for (let i = warm; i < runSteps; i++) { sim.step(); await tick(); }
    runs.push(readCorridorRun(sim, seed, job.corridor, job.roads, job.section, dirs, corridorPlan.provenance.vehiclesPerHour));
    if (layouts.length) counts = countChecks(sim, layouts, job.countJunctions!);
  }
  const result = combineAnalysis(ctx, runs, dirs, job.section, { roads: new Set(job.corridor.segments.map(s => s.roadId)).size, demandVph: corridorPlan.provenance.vehiclesPerHour, rangeM: job.corridor.rangeMeters }, job.plan.provenance);
  onProgress?.(1);
  const routedVph = trips.reduce((n, t) => n + t.vehiclesPerHour, 0) - assignment.unroutedVeh;
  return { result, counts, corridorPlan, routedVph, unroutedVph: assignment.unroutedVeh, timings: { assignmentMs, simulationMs: Date.now() - t1 }, elapsedMs: Date.now() - t0 };
}

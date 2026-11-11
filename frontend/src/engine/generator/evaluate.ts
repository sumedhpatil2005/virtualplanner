import type { AnalysisJob, AnalysisOutput } from '../simulation/analysisJob';
import type { StudyArea, DrivableObject } from '../simulation/StudyAreaExplorer';
import type { RoadSection } from '../simulation/roadSection';
import type { JunctionEditSpec } from '../simulation/junctionControl';
import { checkRunInputs, type RunInputs, type InputCheck } from '../simulation/ScenarioComparison';
import { contentKey } from '../simulation/StudyDemand';
import type { Candidate } from './candidates';
import { metricsOfRun, type ScenarioRow } from './compare';

/**
 * Batch evaluation on FROZEN inputs (mission §13 "Fair comparison"). A
 * candidate's run differs from the baseline's only in the network (roads and
 * junction edits); demand plan, hour factor, seeds, warm-up and measured period
 * are taken from the baseline job by construction. In the app the same holds
 * through SimulationMode.runComparison (frozen baseline plan and seeds), and
 * every row is checked with checkRunInputs against the baseline run.
 */

/** The fingerprint of a job's non-network inputs (what a comparison holds fixed). */
export function jobInputs(job: AnalysisJob, extra: Partial<RunInputs> = {}): RunInputs {
  return { demandKey: contentKey(job.plan), trips: job.plan.trips.length, plannedVph: job.plan.provenance.vehiclesPerHour, hour: extra.hour ?? 0, hourFactor: job.hourFactor,
    seeds: [...job.seeds], measureS: job.measureS, warmupS: job.warmupS, ...extra };
}

/** The candidate's job: the baseline job with the candidate network; nothing else may change. */
export function evaluationJob(base: AnalysisJob, net: { area: StudyArea; corridor?: StudyArea; roads: ReadonlyMap<string, DrivableObject>; section: RoadSection; junctionEdits?: readonly JunctionEditSpec[] }): AnalysisJob {
  return { ...base, area: net.area, corridor: net.corridor ?? net.area, roads: net.roads, section: net.section,
    options: { ...base.options, junctionEdits: net.junctionEdits?.length ? structuredClone([...net.junctionEdits]) : undefined },
    plan: base.plan, seeds: base.seeds, hourFactor: base.hourFactor, warmupS: base.warmupS, measureS: base.measureS };
}

export interface EvaluatedCandidate {
  candidate: Candidate;
  scenarioId: string;
  output: AnalysisOutput | null;
  inputs: RunInputs | null;
  error?: string;
  landTake?: 'none' | 'unknown' | 'possible' | 'outside_row';
}

/** Table rows: baseline first, each candidate with its fair-comparison check against the baseline's inputs. */
export function buildRows(baseline: { name: string; output: AnalysisOutput; inputs: RunInputs | null }, evaluated: readonly EvaluatedCandidate[]): ScenarioRow[] {
  const rows: ScenarioRow[] = [{ id: 'baseline', name: baseline.name, isBaseline: true, values: metricsOfRun(baseline.output.result, null), inputs: null }];
  for (const e of evaluated) {
    if (!e.output) continue;
    const inputs: InputCheck | null = baseline.inputs && e.inputs ? checkRunInputs(baseline.inputs, e.inputs) : null;
    rows.push({ id: e.scenarioId, name: e.candidate.title, isBaseline: false, inputs,
      values: metricsOfRun(e.output.result, { cost: e.candidate.costClass, disruption: e.candidate.disruptionClass, landTake: e.landTake ?? e.candidate.landTake.value }) });
  }
  return rows;
}

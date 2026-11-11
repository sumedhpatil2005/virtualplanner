import type { TwinCityEngine } from '../TwinCityEngine';
import type { CityObject } from '../objects/types';
import { BASE_SCENARIO_ID } from '../scenarios/ScenarioManager';
import type { TrafficRunSnapshot } from '../simulation/SimulationMode';
import type { ComparisonResult } from '../simulation/ScenarioComparison';
import { diagnoseAnalysis, type Diagnosis } from './diagnosis';
import { generateCandidates, type Candidate, type CandidateEdit } from './candidates';
import { applyCandidate, checkCandidateTopology, type TopologyReport } from './apply';
import { buildRows, type EvaluatedCandidate } from './evaluate';
import type { ScenarioRow } from './compare';
import { proposalFromObject, cityContext } from '../feasibility/proposal';
import { assessFeasibility, siteBBox, nearBBox } from '../feasibility/siteAssessment';
import { fetchSiteData, saveAssessment } from '../feasibility/feasibilityApi';
import type { FeasibilityAssessment } from '../feasibility/types';

/**
 * The generator's browser workflow (docs/SCENARIO_GENERATOR.md §4): diagnose
 * the analysis on show → candidates → one proposal scenario per candidate
 * (created with the scenario system, edits copied on write, a version saved
 * with the rationale) → each run with SimulationMode.runComparison on the
 * baseline's frozen demand, hour and seeds → comparison rows.
 *
 * The baseline scenario is active again after every step. Candidate scenarios
 * are ordinary proposals: the user opens, edits, revalidates, reruns and
 * versions them with the existing tools.
 */

export interface CreatedCandidate {
  candidate: Candidate;
  scenarioId: string;
  versionId: string | null;
  changedIds: string[];
  drawnIds: string[];
  topology: TopologyReport | null;
  feasibility: { assessmentId: string | null; findings: number; investigations: number; critical: number; outsideRoW: 'true' | 'unknown' | 'false'; certainty: string; summary: string[] } | null;
  error?: string;
}

export interface GeneratorState {
  status: 'idle' | 'diagnosed' | 'creating' | 'created' | 'evaluating' | 'evaluated' | 'error';
  message: string | null;
  progress: { done: number; of: number } | null;
  diagnosis: Diagnosis | null;
  candidates: Candidate[];
  created: CreatedCandidate[];
  evaluated: (EvaluatedCandidate & { comparison: ComparisonResult | null })[];
  baselineName: string | null;
  rows: ScenarioRow[];
}

const initial = (): GeneratorState => ({ status: 'idle', message: null, progress: null, diagnosis: null, candidates: [], created: [], evaluated: [], baselineName: null, rows: [] });

export class GeneratorSession {
  private state: GeneratorState = initial();
  private listeners = new Set<() => void>();
  private baselineSnap: TrafficRunSnapshot | null = null;
  private readonly engine: TwinCityEngine;
  constructor(engine: TwinCityEngine) { this.engine = engine; }

  subscribe = (cb: () => void) => { this.listeners.add(cb); return () => { this.listeners.delete(cb); }; };
  getState = () => this.state;
  private set(patch: Partial<GeneratorState>) { this.state = { ...this.state, ...patch }; this.listeners.forEach(l => l()); }

  /** Step 1: diagnosis and candidates from the analysis on show (baseline active). */
  diagnose(maxCandidates = 6): GeneratorState {
    const ctx = this.engine.simMode.generatorContext();
    if (!ctx) { this.set({ status: 'error', message: 'Run the road analysis first (select a road in Simulate and wait for its result).' }); return this.state; }
    if (this.engine.scenarios.getActiveScenarioId() !== BASE_SCENARIO_ID) { this.set({ status: 'error', message: 'Switch to the baseline: the generator diagnoses the existing network.' }); return this.state; }
    const diagnosis = diagnoseAnalysis(ctx.output.result, ctx.area, ctx.roads);
    const candidates = generateCandidates(diagnosis, { result: ctx.output.result, area: ctx.area, roads: ctx.roads }, maxCandidates);
    this.set({ ...initial(), status: 'diagnosed', diagnosis, candidates,
      message: candidates.length ? null : 'No candidate: the diagnosis found no cause with enough evidence for an intervention. Investigate on site (counts, queue observation).' });
    return this.state;
  }

  /** Step 2: one isolated proposal per candidate. */
  async createScenarios(ids?: readonly string[]): Promise<CreatedCandidate[]> {
    const list = this.state.candidates.filter(c => !ids || ids.includes(c.id));
    const eng = this.engine;
    const created: CreatedCandidate[] = [];
    this.set({ status: 'creating', progress: { done: 0, of: list.length }, message: null });
    for (const c of list) {
      let sid = '';
      try {
        const sc = await eng.createScenarioFrom(null, { name: `Generated: ${c.title}`.slice(0, 120), description: `${c.rationale} [scenario generator; category ${c.category}]`, year: new Date().getFullYear() });
        sid = sc.id;
        const res = applyCandidate(eng.objects, eng.history, sid, c, (e, s) => this.drawWithBuildTool(e, s));
        const topology = res.drawnIds.length ? checkCandidateTopology(eng.objects.viewOf(sid), res.drawnIds) : null;
        const feasibility = c.physical ? await this.screen(c, sid, res.drawnIds[0] ?? res.changedIds[0]).catch(err => ({ assessmentId: null, findings: 0, investigations: 0, critical: 0, outsideRoW: 'unknown' as const, certainty: 'unknown', summary: [`Feasibility screening failed: ${err instanceof Error ? err.message : String(err)}`] })) : null;
        // The versions API keeps a note of at most 1,000 characters: the essentials, the rationale cut to fit
        const head = `Generated by the scenario generator. ${c.category}/${c.kind}; causes: ${c.causes.join(', ')}; cost class ${c.costClass.level ?? '?'}, disruption ${c.disruptionClass.level ?? '?'}, land ${c.landTake.value}`
          + `${topology ? `; topology ${topology.ok ? 'connected' : 'issues'}` : ''}${feasibility ? `; feasibility ${feasibility.investigations} investigations, outside RoW ${feasibility.outsideRoW}` : ''}. Model output (ESTIMATED). `;
        const note = (head + c.rationale).slice(0, 1000);
        const version = await eng.saveScenarioVersion('Generated (v1)', note).catch(() => null);
        created.push({ candidate: c, scenarioId: sid, versionId: version?.id ?? null, changedIds: res.changedIds, drawnIds: res.drawnIds, topology, feasibility });
      } catch (err) {
        created.push({ candidate: c, scenarioId: sid, versionId: null, changedIds: [], drawnIds: [], topology: null, feasibility: null, error: err instanceof Error ? err.message : String(err) });
      } finally {
        eng.scenarios.setActiveScenario(BASE_SCENARIO_ID);
      }
      this.set({ created: [...created], progress: { done: created.length, of: list.length } });
    }
    this.set({ status: 'created', progress: null });
    return created;
  }

  /** A drawn candidate through the Build drawing path (auto-connect, crossing reconstruction, flyover ramp capacity cut, one Undo step). */
  private drawWithBuildTool(e: Extract<CandidateEdit, { op: 'draw' }>, scenarioId: string): string | null {
    const ed = this.engine.editing;
    const before = new Set(this.engine.objects.viewOf(scenarioId).map(o => o.id));
    const prevClass = ed.roadClass;
    try {
      ed.setMode(e.mode);
      ed.roadClass = e.roadClass;
      for (const p of e.points) ed.addDrawingPoint(p);
      ed.finalizeDrawing(scenarioId);
    } finally {
      ed.roadClass = prevClass;
      ed.clearDrawing();
      ed.setMode('select');
    }
    const added = this.engine.objects.viewOf(scenarioId).filter(o => !before.has(o.id) && (o.type === 'road' || o.type === 'flyover'));
    const obj = added[0];
    if (!obj) return null;
    this.engine.objects.update(obj.id, { name: e.name, laneCount: e.laneCount, isOneWay: e.isOneWay } as Partial<CityObject>);
    return obj.id;
  }

  /** Feasibility screening of a physical candidate (the same engine and storage as the Feasibility panel). */
  private async screen(c: Candidate, scenarioId: string, objectId: string | undefined): Promise<NonNullable<CreatedCandidate['feasibility']>> {
    const obj = objectId ? this.engine.objects.viewOf(scenarioId).find(o => o.id === objectId) : undefined;
    if (!obj || !c.feasibilityType) return { assessmentId: null, findings: 0, investigations: 0, critical: 0, outsideRoW: 'unknown', certainty: 'unknown', summary: ['No object to screen.'] };
    const p = proposalFromObject(obj, c.feasibilityType);
    const site = await fetchSiteData(siteBBox(p), nearBBox(p));
    const a: FeasibilityAssessment = assessFeasibility(p, site, cityContext(this.engine.objects.viewOf(scenarioId)));
    const saved = await saveAssessment(a, 'scenario-generator').catch(() => null);
    const row = a.siteAttributes.outsideExistingRoW;
    const critical = a.plan.flags.filter(f => f.severity === 'critical').length;
    return { assessmentId: saved?.id ?? null, findings: a.findings.length, investigations: a.plan.investigations.length, critical,
      outsideRoW: row?.value === true ? 'true' : row?.value === false ? 'false' : 'unknown', certainty: row?.certainty ?? 'unknown',
      summary: a.findings.filter(f => f.kind === 'constraint').slice(0, 4).map(f => `${f.statement} (${f.certainty})`) };
  }

  /** Step 3: every created candidate on the baseline's frozen demand, hour and seeds. */
  async evaluate(): Promise<ScenarioRow[]> {
    const eng = this.engine, sm = eng.simMode;
    const todo = this.state.created.filter(c => c.scenarioId && !c.error);
    if (!todo.length) { this.set({ status: 'error', message: 'Create the candidate scenarios first.' }); return []; }
    this.set({ status: 'evaluating', progress: { done: 0, of: todo.length + 1 }, message: null });
    const evaluated: GeneratorState['evaluated'] = [];
    sm.suspendAutoAnalysis = true;
    try {
      eng.scenarios.setActiveScenario(BASE_SCENARIO_ID);
      // The baseline run freezes demand and seeds (the existing Compare flow); reuse a baseline already saved for this road
      let baseline = sm.getState().comparison.baseline;
      if (!baseline) baseline = await sm.captureBaseline();
      if (!baseline) throw new Error(sm.getState().comparison.staleReason ?? 'The baseline run failed.');
      this.baselineSnap = baseline;
      this.set({ progress: { done: 1, of: todo.length + 1 }, baselineName: 'Existing network (baseline)' });
      for (const c of todo) {
        eng.scenarios.setActiveScenario(c.scenarioId);
        const cur = await sm.runComparison();
        const st = sm.getState().comparison;
        const landTake = c.candidate.landTake.value === 'none' ? 'none' as const : c.feasibility?.outsideRoW === 'true' ? 'outside_row' as const : 'unknown' as const;
        evaluated.push({ candidate: c.candidate, scenarioId: c.scenarioId, output: cur?.analysis ?? null, inputs: cur?.inputs ?? null, landTake, comparison: cur ? st.result : null,
          ...(cur ? {} : { error: st.staleReason ?? 'The run failed.' }) });
        this.set({ evaluated: [...evaluated], progress: { done: evaluated.length + 1, of: todo.length + 1 } });
      }
    } catch (err) {
      this.set({ status: 'error', message: err instanceof Error ? err.message : String(err) });
    } finally {
      eng.scenarios.setActiveScenario(BASE_SCENARIO_ID);
      sm.suspendAutoAnalysis = false;
    }
    if (!this.baselineSnap) return [];
    const rows = buildRows({ name: 'Existing network (baseline)', output: this.baselineSnap.analysis, inputs: this.baselineSnap.inputs }, evaluated);
    this.set({ status: this.state.status === 'error' ? 'error' : 'evaluated', rows, progress: null });
    return rows;
  }
}

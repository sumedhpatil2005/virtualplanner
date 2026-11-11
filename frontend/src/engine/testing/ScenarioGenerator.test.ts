import { afterEach, describe, expect, it, vi } from 'vitest';
import type { BuildingObject, CityObject, RoadObject } from '../objects/types';
import { ObjectManager } from '../objects/ObjectManager';
import { HistoryManager } from '../history/HistoryManager';
import { StudyAreaExplorer } from '../simulation/StudyAreaExplorer';
import { compileAreaDemand } from '../simulation/AreaDemand';
import { roadSection } from '../simulation/roadSection';
import { runAnalysisJob, type AnalysisJob } from '../simulation/analysisJob';
import { checkRunInputs } from '../simulation/ScenarioComparison';
import { splitJunctionObjects } from '../simulation/junctionControl';
import { groupJunctions } from '../simulation/junctionGroups';
import { classifyLocation, diagnoseAnalysis, randomArrivalDelay, type LocationEvidence, type Diagnosis } from '../generator/diagnosis';
import { generateCandidates, websterPlan } from '../generator/candidates';
import { applyCandidate, checkCandidateTopology } from '../generator/apply';
import { evaluationJob, jobInputs, buildRows } from '../generator/evaluate';
import { paretoSet, dominates, weightedRanking, compareOn, METRIC_BY_ID, explainScenario, type ScenarioRow, type MetricValue } from '../generator/compare';
import { canon } from './editHarness';

/**
 * Scenario generator (docs/SCENARIO_GENERATOR.md). SYNTHETIC fixtures only: hand-made evidence records for the
 * cause rules, and a small synthetic grid (a signalised crossing of a 4-lane arterial and a collector) for the
 * end-to-end path diagnosis → candidates → isolated proposals → frozen-input runs.
 */

const ev = (over: Partial<LocationEvidence>): LocationEvidence => ({ id: 'x', label: 'synthetic', coordinates: [73.8, 18.5], scope: 'corridor', seeds: 3, ...over });
const delay = (o: Partial<{ signal: number; blocked: number; giveWay: number; conflict: number; other: number }>) => {
  const d = { signal: 0, blocked: 0, giveWay: 0, conflict: 0, other: 0, ...o };
  return { ...d, total: d.signal + d.blocked + d.giveWay + d.conflict + d.other };
};
const causesOf = (e: LocationEvidence) => classifyLocation(e).map(f => f.cause);

describe('bottleneck diagnosis: one synthetic fixture per cause', () => {
  it('signal timing: a phase fails (x > 1) while Y < 0.9', () => {
    // Phase 1 gets 15 s of a 70 s cycle for flow ratio 0.35; phase 2 gets 45 s for 0.2. Y = 0.55.
    const e = ev({ signal: { cycleS: 70, lostTimeS: 8, amberS: 3, allRedS: 2, phases: [{ greenS: 15, flowPcu: 1400, satFlowPcu: 4000, arms: ['a'] }, { greenS: 45, flowPcu: 800, satFlowPcu: 4000, arms: ['b'] }] }, delay: delay({ signal: 40, other: 5 }) });
    const f = classifyLocation(e);
    expect(f[0].cause).toBe('signal_timing');
    expect(f[0].metric.value).toBeGreaterThan(1);
    expect(f[0].certainty).toMatch(/ESTIMATED/);
    expect(f.map(x => x.cause)).not.toContain('excessive_demand');
  });
  it('excessive demand: Y >= 0.9 even though the split is proportional', () => {
    const e = ev({ signal: { cycleS: 150, lostTimeS: 8, amberS: 3, allRedS: 2, phases: [{ greenS: 70, flowPcu: 2200, satFlowPcu: 4000, arms: ['a'] }, { greenS: 62, flowPcu: 1900, satFlowPcu: 4000, arms: ['b'] }] } });
    const f = classifyLocation(e);
    expect(f[0].cause).toBe('excessive_demand');
    expect(f[0].confidence).toBe('high'); // Y = 1.025
    expect(causesOf(e)).not.toContain('signal_timing');
  });
  it('excessive demand on a stretch: demand / capacity >= 1', () => {
    expect(causesOf(ev({ demandPcu: 2600, capacityPcu: 2000, capacityBasis: 'midblock' }))).toEqual(['excessive_demand']);
    expect(causesOf(ev({ demandPcu: 1500, capacityPcu: 2000, capacityBasis: 'midblock' }))).toEqual([]);
  });
  it('uncoordinated signals: delay well above the random-arrival delay with a different upstream cycle', () => {
    const d1 = randomArrivalDelay(90, 0.45, 0.7);
    const e = ev({ coordination: { neighbourLabel: 'Up St', distanceM: 250, ownCycleS: 90, neighbourCycleS: 120, observedSignalDelayS: 2 * d1, randomArrivalDelayS: d1 } });
    const f = classifyLocation(e);
    expect(f.map(x => x.cause)).toEqual(['uncoordinated_signals']);
    expect(f[0].confidence).toBe('medium');
    // Random-like arrivals: no finding
    expect(causesOf(ev({ coordination: { ...e.coordination!, observedSignalDelayS: d1 } }))).toEqual([]);
  });
  it('turning conflicts: most delay is giving way / opposed movements', () => {
    expect(causesOf(ev({ delay: delay({ conflict: 20, giveWay: 10, other: 10 }) }))).toEqual(['turning_conflict']);
    expect(causesOf(ev({ delay: delay({ conflict: 2, other: 30 }) }))).toEqual([]);
    // Too little delay to read a share
    expect(causesOf(ev({ delay: delay({ conflict: 4, other: 1 }) }))).toEqual([]);
  });
  it('merge: lanes drop and the place is loaded', () => {
    expect(causesOf(ev({ lanesIn: 4, lanesOut: 3, demandPcu: 2900, capacityPcu: 3000, capacityBasis: 'assignment' }))).toEqual(['merge']);
    expect(causesOf(ev({ lanesIn: 3, lanesOut: 3, demandPcu: 2900, capacityPcu: 3000 }))).toEqual([]);
  });
  it('downstream spillback: confidence follows how many seeds found the same origin', () => {
    const sp = (agreement: number) => classifyLocation(ev({ spillback: { rootLabel: 'Root Chowk', rootCoordinates: [73.81, 18.5], agreement, seeds: 3, blockedShare: 0.6 } }));
    expect(sp(3)[0]).toMatchObject({ cause: 'downstream_spillback', confidence: 'high' });
    expect(sp(2)[0].confidence).toBe('medium');
    expect(sp(1)[0].confidence).toBe('low');
  });
  it('poor connectivity: detour ratio or no alternative route', () => {
    expect(causesOf(ev({ detourRatio: 2.4, noAlternativeShare: 0.7 }))).toEqual(['poor_connectivity']);
    expect(classifyLocation(ev({ detourRatio: 2.4, noAlternativeShare: 0.7 }))[0].confidence).toBe('medium');
    expect(causesOf(ev({ detourRatio: 1.2, noAlternativeShare: 0.1 }))).toEqual([]);
  });
  it('no evidence, no cause', () => {
    expect(classifyLocation(ev({}))).toEqual([]);
  });
});

describe('Webster retiming plan', () => {
  it('keeps the phase structure and splits greens by flow ratio', () => {
    const plan = { amberS: 3, allRedS: 2, phases: [{ greenS: 15, arms: ['a'] }, { greenS: 45, arms: ['b'] }] };
    const w = websterPlan(plan, [{ flowPcu: 1400, satFlowPcu: 4000 }, { flowPcu: 800, satFlowPcu: 4000 }]);
    expect(w.plan.phases.map(p => p.arms)).toEqual([['a'], ['b']]);
    expect(w.plan.phases[0].greenS).toBeGreaterThan(w.plan.phases[1].greenS);
    expect(w.Y).toBeCloseTo(0.55, 6);
    expect(w.oversaturated).toBe(false);
  });
});

// ── Pareto ───────────────────────────────────────────────────────────────────
const v = (value: number | null, perSeed?: number[]): MetricValue => ({ value, perSeed, status: value === null ? 'unknown' : 'model_output' });
const row = (id: string, values: ScenarioRow['values']): ScenarioRow => ({ id, name: id, isBaseline: id === 'base', values });

describe('Pareto set', () => {
  it('finds the non-dominated set and names who dominates whom on what', () => {
    const rows = [
      row('base', { meanTravelTime: v(300), costClass: v(0) }),
      row('A', { meanTravelTime: v(250), costClass: v(1) }),
      row('B', { meanTravelTime: v(260), costClass: v(2) }), // dominated by A
      row('C', { meanTravelTime: v(200), costClass: v(5) }),
    ];
    const p = paretoSet(rows, ['meanTravelTime', 'costClass']);
    expect(p.filter(x => x.inPareto).map(x => x.id)).toEqual(['base', 'A', 'C']);
    expect(p.find(x => x.id === 'B')!.dominatedBy).toEqual([{ id: 'A', betterOn: ['meanTravelTime', 'costClass'] }]);
    // One objective: only the fastest
    expect(paretoSet(rows, ['meanTravelTime']).filter(x => x.inPareto).map(x => x.id)).toEqual(['C']);
  });
  it('an unknown value can neither dominate nor be dominated', () => {
    const rows = [row('A', { meanTravelTime: v(200), landTake: v(0) }), row('B', { meanTravelTime: v(300), landTake: v(null) })];
    const p = paretoSet(rows, ['meanTravelTime', 'landTake']);
    expect(p.every(x => x.inPareto)).toBe(true);
    expect(p.find(x => x.id === 'B')!.incomparable).toEqual([{ id: 'A', unknown: ['landTake'] }]);
    expect(dominates(rows[0], rows[1], ['meanTravelTime', 'landTake']).dominates).toBe(false);
    // Without the unknown objective A dominates B
    expect(dominates(rows[0], rows[1], ['meanTravelTime']).dominates).toBe(true);
  });
  it('differences inside the noise band, or not shown by every seed, are ties', () => {
    const m = METRIC_BY_ID.get('meanTravelTime')!;
    expect(compareOn(m, v(295), v(300))).toBe('tie'); // 1.7% < 3%
    expect(compareOn(m, v(250, [240, 260, 250]), v(300, [300, 250, 350]))).toBe('tie'); // seed 2 disagrees
    expect(compareOn(m, v(250, [240, 240, 270]), v(300, [300, 290, 310]))).toBe('better');
    const rows = [row('A', { meanTravelTime: v(295) }), row('B', { meanTravelTime: v(300) })];
    expect(paretoSet(rows, ['meanTravelTime']).every(x => x.inPareto)).toBe(true);
  });
  it('the weighted ranking lists its weights, skips unknowns and is not the Pareto set', () => {
    const rows = [row('A', { meanTravelTime: v(200), costClass: v(5) }), row('B', { meanTravelTime: v(260), costClass: v(1) }), row('C', { meanTravelTime: v(230), costClass: v(null) })];
    const w = weightedRanking(rows, { meanTravelTime: 1, costClass: 1 });
    expect(w.weights).toEqual({ meanTravelTime: 1, costClass: 1 });
    expect(w.notRanked).toEqual([{ id: 'C', unknown: ['costClass'] }]);
    expect(w.ranked.map(x => x.id).sort()).toEqual(['A', 'B']);
    expect(w.caveat).toMatch(/beside the Pareto set/);
  });
  it('explanations list improvements, losses, missing data and differing inputs', () => {
    const base = row('base', { meanTravelTime: v(300), costClass: v(0) });
    const cand: ScenarioRow = { ...row('A', { meanTravelTime: v(250), costClass: v(3), fuel: { value: null, status: 'not_available' } }),
      inputs: checkRunInputs({ demandKey: 'k', trips: 1, plannedVph: 1, hour: 9, hourFactor: 1, seeds: [1], measureS: 900 }, { demandKey: 'k', trips: 1, plannedVph: 1, hour: 10, hourFactor: 1, seeds: [1], measureS: 900 }) };
    const x = explainScenario(cand, base, { comparisonConfidence: { level: 'medium', text: 'ok' } });
    expect(x.improved.join()).toMatch(/Mean trip time/);
    expect(x.worse.join()).toMatch(/Works cost class/);
    expect(x.missing.join()).toMatch(/Fuel: not available/);
    expect(x.assumptions[0]).toMatch(/DIFFERS.*hour/);
    expect(x.confidence.level).toBe('low');
  });
});

// ── End to end on a synthetic grid ───────────────────────────────────────────
const pt = (x: number, y = 0, z = 0): [number, number, number] => [73.8 + x / (111320 * Math.cos(18.5 * Math.PI / 180)), 18.5 + y / 111320, z];
const mkRoad = (id: string, a: [number, number], b: [number, number], extra: Partial<RoadObject> = {}): RoadObject =>
  ({ id, type: 'road', name: id, layerId: 'roads', coordinates: [pt(...a), pt(...b)], roadClass: 'arterial', laneCount: 4, laneWidth: 3.5, width: 14, hasDivider: false, dividerWidth: 0, hasFootpath: false, footpathWidth: 0,
    speedLimit: 50, isOneWay: false, trafficCapacity: 4000, connectedJunctions: [], scenarioId: 'base', createdAt: 'synthetic', updatedAt: 'synthetic', ...extra } as RoadObject);
const building = (id: string, x: number, y: number, residents = 0, employees = 0) =>
  ({ id, type: 'building', coordinates: [pt(x - 1, y - 1), pt(x + 1, y - 1), pt(x + 1, y + 1), pt(x - 1, y + 1)], residents, employees } as BuildingObject);
const ROADS = [
  mkRoad('w1', [-900, 0], [0, 0], { name: 'Main Road' }), mkRoad('m1', [0, 0], [400, 0], { name: 'Main Road' }), mkRoad('e1', [400, 0], [1300, 0], { name: 'Main Road' }),
  mkRoad('s1', [400, -700], [400, 0], { name: 'Cross Road', roadClass: 'collector', laneCount: 2, width: 7 }), mkRoad('n1', [400, 0], [400, 700], { name: 'Cross Road', roadClass: 'collector', laneCount: 2, width: 7 }),
  mkRoad('stub', [0, 400], [0, 150], { name: 'Stub Lane', roadClass: 'collector', laneCount: 2, width: 7 }),
];

function store() {
  const om = new ObjectManager();
  vi.spyOn(om, 'syncPost').mockImplementation(async () => {});
  vi.spyOn(om, 'syncPostMultiple').mockImplementation(async () => {});
  vi.spyOn(om, 'syncDelete').mockImplementation(async () => {});
  vi.spyOn(om, 'syncDeleteMultiple').mockImplementation(async () => {});
  vi.spyOn(om as any, 'syncChanges').mockImplementation(async () => {});
  (om as any).deletedOsm = new Set<string>();
  om.addMultiple(structuredClone(ROADS), true);
  return { om, history: new HistoryManager(om) };
}
const viewKey = (om: ObjectManager, id: string) => canon([...om.viewOf(id)].sort((a, b) => a.id.localeCompare(b.id)).map(o => ({ ...o, updatedAt: undefined, createdAt: undefined })));
afterEach(() => vi.restoreAllMocks());

describe('generator end to end (synthetic grid)', () => {
  const roads = (objs: CityObject[]) => objs.filter((o): o is RoadObject => o.type === 'road' || (o.type as string) === 'flyover') as RoadObject[];
  const explore = (rs: RoadObject[], rev: number) => new StudyAreaExplorer().explore(rs, rev, { seedRoadIds: ['m1'], rangeMeters: 900, direction: 'both' });
  const signalAt = pt(400, 0);
  const area0 = explore(ROADS, 1);
  const map0 = new Map(ROADS.map(r => [r.id, r]));
  const plan = compileAreaDemand({ buildings: [building('home', -800, 20, 6000), building('work', 1200, 20, 0, 6000), building('n', 380, 650, 0, 3000)] }, area0, map0)!;
  const baseJob: AnalysisJob = { area: area0, corridor: area0, roads: map0, options: { demandLevel: 0.35, signalPoints: [[signalAt[0], signalAt[1]]] }, plan, section: roadSection(area0, map0, ['m1']),
    hourFactor: 1, seeds: [42, 7], warmupS: 120, measureS: 300 };

  it('diagnoses the run, generates isolated, topology-valid candidates and evaluates them on identical inputs', async () => {
    const base = await runAnalysisJob(baseJob, undefined, 1e9);
    const diag = diagnoseAnalysis(base.result, area0, map0);
    expect(diag.label).toMatch(/ESTIMATED/);
    for (const l of diag.locations) for (const c of l.causes) { expect(c.metric.thresholdBasis.length).toBeGreaterThan(3); expect(['high', 'medium', 'low']).toContain(c.confidence); }

    // Forced evidence at the crossing (so every builder runs whatever the synthetic run showed): demand beyond any timing, conflicts, connectivity
    const js = groupJunctions(area0.network, map0);
    const j = js.find(x => Math.hypot(x.centre[0] - signalAt[0], x.centre[1] - signalAt[1]) < 1e-4)!;
    expect(j).toBeTruthy();
    const dirE = base.result.directions.find(d => Math.abs(((d.bearingDeg - 90 + 540) % 360) - 180) < 30)!;
    expect(dirE).toBeTruthy();
    const real = diag.locations.find(l => l.evidence.junctionId === j.id);
    const sigEv = real?.evidence.signal ?? { cycleS: 90, lostTimeS: 8, amberS: 3, allRedS: 2, phases: [{ greenS: 40, flowPcu: 2400, satFlowPcu: 2500, arms: [j.approaches[0].id] }, { greenS: 40, flowPcu: 2000, satFlowPcu: 2500, arms: [j.approaches[1].id] }] };
    const forcedEv: LocationEvidence = { id: 'forced', label: 'Main Road at Cross Road', coordinates: [j.centre[0], j.centre[1]], scope: 'corridor', junctionId: j.id, roadIds: dirE.roadIds, direction: dirE.label, seeds: 2,
      signal: { ...sigEv, phases: sigEv.phases.map(p => ({ ...p, flowPcu: p.satFlowPcu * 0.6 })) }, delay: delay({ conflict: 30, giveWay: 10, signal: 10 }), demandPcu: 3000, capacityPcu: 2500, capacityBasis: 'signal', detourRatio: 2.5, noAlternativeShare: 0.8 };
    const forced: Diagnosis = { locations: [{ evidence: forcedEv, causes: classifyLocation(forcedEv), severity: 1 }], notes: [], label: 'ESTIMATED — model output' };
    expect(forced.locations[0].causes.map(c => c.cause)).toEqual(expect.arrayContaining(['excessive_demand', 'turning_conflict', 'poor_connectivity']));
    const r = { ...base.result, networkGaps: [{ roadId: 'stub', roadName: 'Stub Lane', title: 'ends without a connection', kind: 'dead-end', coordinates: pt(0, 150) }] };
    const cands = generateCandidates(forced, { result: r, area: area0, roads: map0, junctions: js }, 10);
    const kinds = cands.map(c => c.kind);
    expect(kinds).toEqual(expect.arrayContaining(['signal_retiming', 'turn_ban', 'widening', 'flyover', 'new_connector', 'bus_priority_lane']));
    // Management first, physical last; every candidate explains itself; physical ones carry a feasibility type and unknown land
    const firstPhysical = cands.findIndex(c => c.physical);
    expect(cands.slice(firstPhysical).every(c => c.physical)).toBe(true);
    for (const c of cands) {
      expect(c.rationale.length).toBeGreaterThan(20); expect(c.assumptions.length).toBeGreaterThan(0); expect(c.limitations.length).toBeGreaterThan(0);
      expect(c.costClass.basis).toMatch(/Not a cost estimate/);
      if (c.physical) { expect(c.feasibilityType).toBeTruthy(); expect(c.landTake.value).toBe('unknown'); } else expect(c.landTake.value).toBe('none');
    }

    // Each candidate in its own proposal: the baseline and the other proposals never change
    const { om, history } = store();
    const base0 = viewKey(om, 'base');
    const views = new Map<string, string>();
    const applied: { id: string; drawn: string[] }[] = [];
    for (const c of cands) {
      const sid = `gen_${c.id}`;
      om.setActiveScenario(sid);
      const res = applyCandidate(om, history, sid, c);
      expect(res.changedIds.length).toBeGreaterThan(0);
      expect(viewKey(om, 'base')).toBe(base0);
      for (const [other, key] of views) expect(viewKey(om, other)).toBe(key);
      views.set(sid, viewKey(om, sid));
      applied.push({ id: sid, drawn: res.drawnIds });
      // Drawn geometry is joined to the network at both ends, with routes on and off it
      if (res.drawnIds.length) {
        const topo = checkCandidateTopology(om.viewOf(sid), res.drawnIds);
        expect(topo.problems).toEqual([]);
        expect(topo.ok).toBe(true);
      }
    }
    om.setActiveScenario('base');
    expect(() => applyCandidate(om, history, 'base', cands[0])).toThrow(/own active proposal/);
    expect(viewKey(om, 'base')).toBe(base0);
    expect(om.getAllStored().filter(o => o.scenarioId === 'base').map(o => o.id).sort()).toEqual(ROADS.map(r => r.id).sort());

    // Evaluation on the baseline's frozen inputs: two management candidates
    const evaluated = [];
    for (const k of ['signal_retiming', 'turn_ban']) {
      const c = cands.find(x => x.kind === k)!;
      const sid = `gen_${c.id}`;
      const view = om.viewOf(sid);
      const rs = roads(view);
      const area = explore(rs, 10 + evaluated.length);
      const map = new Map(rs.map(x => [x.id, x]));
      const job = evaluationJob(baseJob, { area, roads: map, section: roadSection(area, map, ['m1']), junctionEdits: splitJunctionObjects(view.filter(o => o.type === 'junction') as never).edits });
      expect(jobInputs(job)).toEqual(jobInputs(baseJob));
      expect(job.plan).toBe(baseJob.plan);
      expect(job.options.junctionEdits?.length).toBe(1);
      const out = await runAnalysisJob(job, undefined, 1e9);
      // Reproducible: same inputs, same result
      const again = await runAnalysisJob(evaluationJob(baseJob, { area, roads: map, section: roadSection(area, map, ['m1']), junctionEdits: job.options.junctionEdits }), undefined, 1e9);
      expect(again.result.perSeed).toEqual(out.result.perSeed);
      evaluated.push({ candidate: c, scenarioId: sid, output: out, inputs: jobInputs(job) });
    }
    const rows = buildRows({ name: 'Existing', output: base, inputs: jobInputs(baseJob) }, evaluated);
    expect(rows).toHaveLength(3);
    for (const x of rows.slice(1)) expect(x.inputs?.matched).toBe(true);
    expect(rows[0].values.costClass?.value).toBe(0);
    expect(rows[1].values.fuel?.status).toBe('not_available');
    const p = paretoSet(rows, ['meanTravelTime', 'costClass']);
    expect(p.some(x => x.inPareto)).toBe(true);
    // A run on other inputs is flagged
    const odd = buildRows({ name: 'Existing', output: base, inputs: jobInputs(baseJob) }, [{ ...evaluated[0], inputs: { ...evaluated[0].inputs!, seeds: [1, 2] } }]);
    expect(odd[1].inputs?.matched).toBe(false);
  }, 120_000);
});

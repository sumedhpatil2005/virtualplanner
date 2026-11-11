/**
 * ODME (demand/odme.ts, demand/odmeAssignment.ts): Spiess (1990) gradient estimation on the
 * app's own user-equilibrium assignment. All networks, matrices and counts here are SYNTHETIC
 * (a 4 x 4 grid with a known "true" matrix); none of them is an observation.
 * docs/ODME_AND_EMISSIONS.md.
 */
import { describe, it, expect } from 'vitest';
import type { RoadObject } from '../objects/types';
import { StudyAreaExplorer } from '../simulation/StudyAreaExplorer';
import { snapDemandPlan, contentKey, type DemandPlan } from '../simulation/StudyDemand';
import { estimateOd, matrixChangeStats, regression, HeldOutCountError, type OdCellInfo } from '../demand/odme';
import { areaOdProblem, constraintsToCounts, countsBeforeAfter, estimateAreaDemand } from '../demand/odmeAssignment';
import { countsToConstraints } from '../data/odmeConstraints';
import type { EngineCountRow } from '../data/trafficData';

const LAT0 = 18.53;
const M_LAT = 1 / 111320;
const M_LNG = 1 / (111320 * Math.cos((LAT0 * Math.PI) / 180));
const pt = (x: number, y: number): [number, number, number] => [73.85 + x * M_LNG, LAT0 + y * M_LAT, 0];
let nextOsm = 1;
const road = (id: string, a: [number, number], b: [number, number]): RoadObject => ({
  id, type: 'road', name: id, layerId: 'roads', scenarioId: 'base', coordinates: [pt(...a), pt(...b)],
  roadClass: 'arterial', width: 7, laneCount: 1, laneWidth: 3.5,
  hasDivider: false, dividerWidth: 0, hasFootpath: false, footpathWidth: 0,
  speedLimit: 40, isOneWay: false, trafficCapacity: 1000,
  connectedJunctions: [], createdAt: '', updatedAt: '',
  osmProvenance: { osmId: nextOsm++, osmElementType: 'way', osmSourceId: `way/${id}`, originalTags: { highway: 'secondary', lanes: '1' }, layer: 0, bridge: false, tunnel: false, roundabout: false },
} as RoadObject);

/** SYNTHETIC 4 x 4 grid, 400 m spacing, one lane each way. */
function grid() {
  const S = 400, N = 4, roads: RoadObject[] = [];
  for (let i = 0; i < N; i++) for (let j = 0; j < N; j++) {
    if (i + 1 < N) roads.push(road(`h${i}_${j}`, [i * S, j * S], [(i + 1) * S, j * S]));
    if (j + 1 < N) roads.push(road(`v${i}_${j}`, [i * S, j * S], [i * S, (j + 1) * S]));
  }
  const map = new Map(roads.map(r => [r.id, r]));
  const area = new StudyAreaExplorer().explore(roads, 1, { seedRoadIds: ['h1_1'], rangeMeters: 5000, direction: 'both' });
  return { roads, map, area, S };
}

/** Corners and mid-edge points as zones; a SYNTHETIC true matrix between them. */
const ZONES: [number, number][] = [[0, 0], [1200, 0], [0, 1200], [1200, 1200], [400, 0], [800, 1200], [0, 800], [1200, 400]];
function trueMatrix(): number[] {
  const m: number[] = [];
  ZONES.forEach((_, a) => ZONES.forEach((__, b) => { if (a !== b) m.push(60 + ((a * 7 + b * 13) % 9) * 40); }));
  return m;
}
const pairs = () => { const p: [number, number][] = []; ZONES.forEach((_, a) => ZONES.forEach((__, b) => { if (a !== b) p.push([a, b]); })); return p; };
function planOf(m: readonly number[]): DemandPlan {
  const trips = pairs().map(([a, b], i) => ({ from: pt(...ZONES[a]), to: pt(...ZONES[b]), vehiclesPerHour: m[i], kind: 'car' as const }));
  return { trips, provenance: { source: 'synthetic', label: 'SYNTHETIC test matrix', period: 'AM_Peak', vehiclesPerHour: trips.reduce((n, t) => n + t.vehiclesPerHour, 0), pairCount: trips.length } };
}
const snap = (g: ReturnType<typeof grid>, plan: DemandPlan) => snapDemandPlan(plan, g.area.network, 60, new Set(g.area.segments.map(s => s.key)));

/** Prior = true matrix perturbed by a fixed SYNTHETIC pattern (±35%). */
const perturb = (m: readonly number[]) => m.map((v, i) => v * (1 + 0.35 * Math.sin(i * 2.3)));

function setup() {
  const g = grid();
  const truth = trueMatrix();
  const prior = perturb(truth);
  const truthProblem = areaOdProblem(g.area, g.map, snap(g, planOf(truth)), { maxIterations: 200, targetGap: 1e-5 });
  const trueLoad = truthProblem.assign(truthProblem.prior);
  const plan = planOf(prior);
  const trips = snap(g, plan);
  return { g, truth, prior, plan, trips, trueLoad, truthProblem };
}

/** Link counts from the TRUE assignment on every k-th road (SYNTHETIC), as Traffic Data rows. */
function rowsFrom(s: ReturnType<typeof setup>, pick: (roadIdx: number) => boolean, role: 'calibration' | 'validation', dataset: string): EngineCountRow[] {
  const flow = new Map(s.truthProblem.linkIds.map((id, i) => [id, s.trueLoad.linkFlow[i]]));
  const rows: EngineCountRow[] = [];
  s.g.roads.forEach((r, k) => {
    if (!pick(k)) return;
    for (const dir of ['fwd', 'bwd'] as const) {
      let v = -1;
      flow.forEach((f, id) => { if (id.startsWith(`${r.id}_seg_`) && id.endsWith(`_${dir}`)) v = Math.max(v, f); });
      if (v <= 0) continue;
      rows.push({ dataset_id: dataset, dataset_name: `SYNTHETIC ${role}`, kind: 'measured', synthetic: true, role, ref_kind: 'road_direction', road_id: r.id, direction: dir,
        junction_ref: null, approach_road_id: null, from_road_id: null, to_road_id: null, day_type: 'weekday', count_date: null, hour: 9, period: '09:00-10:00', minutes: 60, complete: true, span: false,
        veh_h: Math.round(v), pcu_h: null, pcu_set_name: null, class_counts: {} });
    }
  });
  return rows;
}

const meanGeh = (fit: { gehBefore: number; gehAfter: number }[], k: 'gehBefore' | 'gehAfter') => fit.reduce((n, f) => n + f[k], 0) / fit.length;

describe('ODME on a synthetic grid with a known true matrix (SYNTHETIC)', () => {
  it('moves the assigned flows toward the calibration counts and reports every iteration', () => {
    const s = setup();
    const rows = rowsFrom(s, k => k % 2 === 0, 'calibration', 'cal');
    const { constraints, heldOutDatasetIds } = countsToConstraints(rows, s.truthProblem.linkIds, { hour: 9 });
    const r = estimateAreaDemand({ area: s.g.area, roads: s.g.map, plan: s.plan, trips: s.trips, constraints, heldOutDatasetIds, hour: 9, hourFactor: 1, assignment: { maxIterations: 200, targetGap: 1e-5 } });
    const before = meanGeh(r.estimate.fit, 'gehBefore'), after = meanGeh(r.estimate.fit, 'gehAfter');
    expect(r.counts.length).toBeGreaterThan(10);
    expect(after).toBeLessThan(before * 0.5);
    if (process.env.ODME_PRINT) console.log(JSON.stringify({ before, after, its: r.estimate.iterations.map(i => [i.objective.toFixed(0), i.meanAbsGeh.toFixed(2), i.halvings]), stop: r.estimate.stopReason, change: r.plan.provenance.odme!.change.map(c => [c.name, c.value?.toFixed(3), c.within]) }));
    expect(r.estimate.iterations[0].iteration).toBe(0);
    const zs = r.estimate.iterations.map(i => i.objective);
    expect(zs[zs.length - 1]).toBeLessThan(zs[0]);
    // Closer to the true matrix than the prior was (cell-wise RMSE)
    const rmse = (m: ArrayLike<number>) => Math.sqrt(s.truth.reduce((n, t, i) => n + (m[i] - t) ** 2, 0) / s.truth.length);
    expect(rmse(r.estimate.matrix)).toBeLessThan(rmse(s.prior));
  });

  it('never creates an OD pair absent from the prior and respects cell factor bounds', () => {
    const s = setup();
    const prior = [...s.prior]; prior[3] = 0; prior[17] = 0;
    const plan = planOf(prior);
    const rows = rowsFrom(s, () => true, 'calibration', 'cal');
    const problem = areaOdProblem(s.g.area, s.g.map, snap(s.g, plan), { maxIterations: 200, targetGap: 1e-5 });
    const { counts } = constraintsToCounts(countsToConstraints(rows, problem.linkIds, { hour: 9 }).constraints, problem.linkIndex);
    const est = estimateOd(problem, counts, { cellFactorBounds: [0.9, 1.1] });
    expect(est.matrix[3]).toBe(0);
    expect(est.matrix[17]).toBe(0);
    for (let i = 0; i < est.factors.length; i++) if (problem.prior[i] > 0) { expect(est.factors[i]).toBeGreaterThanOrEqual(0.9 - 1e-9); expect(est.factors[i]).toBeLessThanOrEqual(1.1 + 1e-9); }
  });

  it('refuses validation (held-out) counts and is unaffected by them', () => {
    const s = setup();
    const cal = rowsFrom(s, k => k % 2 === 0, 'calibration', 'cal');
    const val = rowsFrom(s, k => k % 2 === 1, 'validation', 'val');
    const run = (valRows: EngineCountRow[]) => {
      const b = countsToConstraints([...cal, ...valRows], s.truthProblem.linkIds, { hour: 9 });
      expect(b.heldOutDatasetIds).toEqual(['val']);
      expect(b.constraints.every(c => c.datasetId === 'cal')).toBe(true);
      return estimateAreaDemand({ area: s.g.area, roads: s.g.map, plan: s.plan, trips: s.trips, constraints: b.constraints, heldOutDatasetIds: b.heldOutDatasetIds, hour: 9, hourFactor: 1, assignment: { maxIterations: 200, targetGap: 1e-5 } });
    };
    const a = run(val);
    // Wildly different validation values change nothing in the estimate
    const b = run(val.map(r => ({ ...r, veh_h: (r.veh_h ?? 0) * 5 })));
    expect(Array.from(b.estimate.matrix)).toEqual(Array.from(a.estimate.matrix));
    // A held-out count passed to the estimator directly is refused
    const problem = areaOdProblem(s.g.area, s.g.map, s.trips);
    const valCounts = constraintsToCounts(countsToConstraints(val.map(r => ({ ...r, role: 'calibration' as const })), problem.linkIds, { hour: 9 }).constraints, problem.linkIndex).counts;
    expect(() => estimateOd(problem, valCounts, { heldOutDatasetIds: ['val'] })).toThrow(HeldOutCountError);
    // Independent check on the held-out half is reported before and after, not fitted
    const valCounts2 = valCounts.map(c => c);
    const check = countsBeforeAfter(valCounts2, a.estimate.priorLoad, a.estimate.load);
    expect(check.length).toBe(valCounts.length);
  });

  it('returns a new demand version with provenance and leaves the prior plan untouched', () => {
    const s = setup();
    const before = JSON.stringify(s.plan);
    const rows = rowsFrom(s, k => k % 3 === 0, 'calibration', 'cal');
    const b = countsToConstraints(rows, s.truthProblem.linkIds, { hour: 9 });
    const r = estimateAreaDemand({ area: s.g.area, roads: s.g.map, plan: s.plan, trips: s.trips, constraints: b.constraints, heldOutDatasetIds: [], hour: 9, hourFactor: 1 });
    expect(JSON.stringify(s.plan)).toBe(before);
    const p = r.plan.provenance.odme!;
    expect(p.priorKey).toBe(contentKey(s.plan));
    expect(p.calibrationDatasetIds).toEqual(['cal']);
    expect(p.iterations).toBe(r.estimate.iterations.filter(i => i.iteration > 0 && i.accepted).length);
    expect(p.change.map(c => c.name)).toContain('Cell values: R²');
    expect(r.plan.provenance.label).toMatch(/ESTIMATED FROM CALIBRATION COUNTS/);
    expect(contentKey(r.plan)).not.toBe(contentKey(s.plan));
    expect(r.plan.trips.length).toBe(s.plan.trips.length);
  });

  it('regularisation toward the prior keeps the matrix closer to it (μ > 0)', () => {
    const s = setup();
    const rows = rowsFrom(s, () => true, 'calibration', 'cal');
    const go = (mu: number) => {
      const problem = areaOdProblem(s.g.area, s.g.map, s.trips, { maxIterations: 200, targetGap: 1e-5 });
      const { counts } = constraintsToCounts(countsToConstraints(rows, problem.linkIds, { hour: 9 }).constraints, problem.linkIndex);
      const est = estimateOd(problem, counts, { priorWeight: mu });
      return est.factors.reduce((n, f) => n + Math.abs(f - 1), 0);
    };
    expect(go(50)).toBeLessThan(go(0));
  });
});

describe('TAG M3.1 Table 5 change statistics (hand-checkable fixture)', () => {
  const cells: OdCellInfo[] = [
    { origin: 'a', destination: 'b', originSector: 'N', destinationSector: 'S', lengthM: 1000 },
    { origin: 'a', destination: 'c', originSector: 'N', destinationSector: 'E', lengthM: 2000 },
    { origin: 'b', destination: 'c', originSector: 'S', destinationSector: 'E', lengthM: 3000 },
    { origin: 'c', destination: 'a', originSector: 'E', destinationSector: 'N', lengthM: 4000 },
  ];
  const prior = [100, 200, 300, 400];
  it('unchanged matrix: slopes 1, R² 1, no change in trip length or sectors, all within', () => {
    const st = matrixChangeStats(prior, prior, cells);
    const by = Object.fromEntries(st.map(s => [s.name, s]));
    expect(by['Cell values: slope (estimated on prior)'].value).toBeCloseTo(1, 12);
    expect(by['Cell values: R²'].value).toBeCloseTo(1, 12);
    expect(by['Trip length: change in mean'].value).toBeCloseTo(0, 12);
    expect(st.every(s => s.within !== false)).toBe(true);
    expect(by['Cell values: intercept'].within).toBeNull();
  });
  it('a 10% uniform increase breaches the slope and sector limits but not trip length or R²', () => {
    const st = matrixChangeStats(prior, prior.map(v => v * 1.1), cells);
    const by = Object.fromEntries(st.map(s => [s.name, s]));
    expect(by['Cell values: slope (estimated on prior)'].value).toBeCloseTo(1.1, 12);
    expect(by['Cell values: slope (estimated on prior)'].within).toBe(false);
    expect(by['Cell values: R²'].within).toBe(true);
    expect(by['Trip length: change in mean'].value).toBeCloseTo(0, 9);
    expect(by['Sector to sector: largest change'].value).toBeCloseTo(10, 9);
    expect(by['Sector to sector: largest change'].within).toBe(false);
  });
  it('trip-length mean by hand: doubling the longest cell', () => {
    // prior mean = (100*1 + 200*2 + 300*3 + 400*4)/1000 = 3.0 km; post = (100 + 400 + 900 + 3200)/1400 = 3.2857 km → +9.52%
    const st = matrixChangeStats(prior, [100, 200, 300, 800], cells);
    expect(st.find(s => s.name === 'Trip length: change in mean')!.value).toBeCloseTo(100 * (3.2857142857 - 3) / 3, 6);
  });
  it('regression helper matches a hand computation', () => {
    const r = regression([1, 2, 3], [2, 4, 6.5]);
    expect(r.slope).toBeCloseTo(2.25, 12);
    expect(r.intercept).toBeCloseTo(4.1666666667 - 2.25 * 2, 9);
  });
});

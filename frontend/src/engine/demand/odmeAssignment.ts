/**
 * ODME on the app's own area assignment (staticAssignment.ts): the OD cells are the
 * assignment's node-to-node pairs of the demand plan, the counts are Traffic Data
 * Manager calibration constraints (data/odmeConstraints.ts), and the result is a NEW
 * demand version (a DemandPlan with ODME provenance). The prior plan is never changed.
 * docs/ODME_AND_EMISSIONS.md.
 */
import type { StudyArea, DrivableObject } from '../simulation/StudyAreaExplorer';
import type { MicroDemandTrip } from '../simulation/TrafficMicroSim';
import { assignTraffic, type AssignmentOptions } from '../simulation/staticAssignment';
import { contentKey, type DemandPlan } from '../simulation/StudyDemand';
import type { CountConstraint, LinkCountConstraint } from '../data/odmeConstraints';
import { estimateOd, matrixChangeStats, modelledAt, gehOf, type OdmeCount, type OdmeEstimate, type OdmeLoad, type OdmeOptions, type OdCellInfo, type ChangeStat, type OdmeFit } from './odme';

export interface AreaOdProblem {
  prior: Float64Array;
  cells: OdCellInfo[];
  /** Per trip of the plan: its OD cell, or -1 (not routable in the area: kept unchanged). */
  cellOfTrip: Int32Array;
  linkIds: string[];
  linkIndex: Map<string, number>;
  assign(matrix: Float64Array): OdmeLoad;
  /** Number of assignments run so far (each ODME iteration costs at least one). */
  assignments(): number;
}

const SECTORS = ['N', 'E', 'S', 'W'] as const;

/**
 * The area's OD cells from snapped trips (veh/h at the modelled hour) and an assign()
 * that runs the model's own user-equilibrium assignment on any matrix of them.
 */
export function areaOdProblem(area: StudyArea, roads: ReadonlyMap<string, DrivableObject>, trips: readonly MicroDemandTrip[], o: AssignmentOptions = {}): AreaOdProblem {
  const keyOf = new Map<string, number>();
  const cellOfTrip = new Int32Array(trips.length).fill(-1);
  const priorList: number[] = [];
  const ends: [string, string][] = [];
  trips.forEach((t, j) => {
    if (!t.fromNodeId || !t.toNodeId || t.fromNodeId === t.toNodeId) return;
    const k = t.fromNodeId + '>' + t.toNodeId;
    let c = keyOf.get(k);
    if (c === undefined) { c = priorList.length; keyOf.set(k, c); priorList.push(0); ends.push([t.fromNodeId, t.toNodeId]); }
    priorList[c] += t.vehiclesPerHour;
    cellOfTrip[j] = c;
  });
  const prior = Float64Array.from(priorList);
  const cx = (area.bounds.minLng + area.bounds.maxLng) / 2, cy = (area.bounds.minLat + area.bounds.maxLat) / 2;
  // Sector = compass quadrant of the node seen from the area's centre (the app's sector definition; TAG leaves sectors to the modeller)
  const sector = (node: string) => {
    const c = area.network.nodes.get(node)?.coordinates;
    if (!c) return '?';
    const dx = (c[0] - cx) * Math.cos(cy * Math.PI / 180), dy = c[1] - cy;
    return Math.abs(dy) >= Math.abs(dx) ? (dy >= 0 ? SECTORS[0] : SECTORS[2]) : (dx >= 0 ? SECTORS[1] : SECTORS[3]);
  };
  let runs = 0;
  let linkIds: string[] = [];
  let linkLen: Float64Array = new Float64Array(0);
  const assign = (m: Float64Array): OdmeLoad => {
    runs++;
    const scaled = trips.map((t, j) => { const c = cellOfTrip[j]; return c < 0 || prior[c] <= 0 ? t : { ...t, vehiclesPerHour: t.vehiclesPerHour * m[c] / prior[c] }; });
    const res = assignTraffic(area, roads, scaled, o);
    if (!linkIds.length) { linkIds = res.links.map(l => l.id); linkLen = Float64Array.from(res.links, l => l.lengthM); }
    const byPair = new Map<string, number>();
    res.ods.forEach((od, k) => byPair.set(res.nodes[od.from] + '>' + res.nodes[od.to], k));
    const odPaths = ends.map(([f, d]) => {
      const k = byPair.get(f + '>' + d);
      return k === undefined ? [] : res.odPaths[k].map(p => ({ links: res.paths[p.pathId], share: p.share }));
    });
    return { linkFlow: res.volVeh, odPaths, gap: res.relativeGap };
  };
  // One assignment of the prior fixes link order and cell lengths
  const first = assign(prior);
  const cells: OdCellInfo[] = ends.map(([f, d], i) => {
    let len = 0;
    for (const p of first.odPaths[i]) { let s = 0; for (const li of p.links) s += linkLen[li]; len += p.share * s; }
    return { origin: f, destination: d, originSector: sector(f), destinationSector: sector(d), lengthM: len };
  });
  const linkIndex = new Map(linkIds.map((id, i) => [id, i]));
  let cachedFirst: OdmeLoad | null = first;
  return {
    prior, cells, cellOfTrip, linkIds, linkIndex,
    // The estimator's first call is the prior: reuse the assignment already made
    assign: (m: Float64Array) => { if (cachedFirst && m.every((v, i) => v === prior[i])) { const f = cachedFirst; cachedFirst = null; return f; } return assign(m); },
    assignments: () => runs,
  };
}

/** Link constraints → estimator counts (link ids → indices; 'both' = two groups). Turn constraints are not mapped yet and are returned as skipped. */
export function constraintsToCounts(constraints: readonly CountConstraint[], linkIndex: ReadonlyMap<string, number>) {
  const counts: OdmeCount[] = [], skipped: { id: string; reason: string }[] = [];
  for (const c of constraints) {
    if (c.type !== 'link') { skipped.push({ id: c.id, reason: 'turning counts are not yet matched to assignment movements' }); continue; }
    const lc = c as LinkCountConstraint;
    const fwd = lc.linkIds.filter(id => id.endsWith('_fwd')).map(id => linkIndex.get(id)).filter((x): x is number => x !== undefined);
    const bwd = lc.linkIds.filter(id => id.endsWith('_bwd')).map(id => linkIndex.get(id)).filter((x): x is number => x !== undefined);
    const groups = [fwd, bwd].filter(g => g.length);
    if (!groups.length) { skipped.push({ id: c.id, reason: 'road not in this study area' }); continue; }
    counts.push({ id: c.id, groups, observed: c.observed, weight: c.weight, datasetId: c.datasetId });
  }
  return { counts, skipped };
}

/** Counts against two assignments (before/after): for independent (held-out) validation, never fitted. */
export function countsBeforeAfter(counts: readonly OdmeCount[], before: OdmeLoad, after: OdmeLoad): OdmeFit[] {
  return counts.map(c => {
    const b = modelledAt(c, before.linkFlow).value, a = modelledAt(c, after.linkFlow).value;
    return { id: c.id, datasetId: c.datasetId, observed: c.observed, before: b, after: a, gehBefore: gehOf(b, c.observed), gehAfter: gehOf(a, c.observed) };
  });
}

export interface OdmeProvenance {
  method: 'Spiess (1990) gradient ODME on the app\'s user-equilibrium assignment';
  source: string;
  priorKey: string;
  priorLabel: string;
  hour: number;
  hourFactor: number;
  calibrationDatasetIds: string[];
  constraintIds: string[];
  heldOutDatasetIds: string[];
  iterations: number;
  assignments: number;
  converged: boolean;
  stopReason: string;
  options: OdmeEstimate['options'];
  cells: number;
  boundedCells: number;
  change: ChangeStat[];
  changeWithinTag: boolean;
  fit: OdmeFit[];
  priorVph: number;
  estimatedVph: number;
  createdAt: string;
}

/**
 * The estimated demand as a new demand version: the prior plan's trips, each scaled by its
 * OD cell's factor (a trip in no cell is unchanged), with ODME provenance. Plan values stay
 * in the prior plan's unit (veh/h at the plan's reference hour); factors are dimensionless.
 */
export function odmeDemandVersion(priorPlan: DemandPlan, problem: AreaOdProblem, est: OdmeEstimate, meta: { hour: number; hourFactor: number; constraintIds: string[]; heldOutDatasetIds: string[]; datasetIds: string[] }): DemandPlan {
  const trips = priorPlan.trips.map((t, j) => { const c = problem.cellOfTrip[j]; return c < 0 ? { ...t } : { ...t, vehiclesPerHour: t.vehiclesPerHour * est.factors[c] }; });
  const vph = trips.reduce((n, t) => n + t.vehiclesPerHour, 0);
  const change = matrixChangeStats(problem.prior, est.matrix, problem.cells);
  const odme: OdmeProvenance = {
    method: 'Spiess (1990) gradient ODME on the app\'s user-equilibrium assignment', source: 'http://www.spiess.ch/emme2/demadj/demadj.html',
    priorKey: contentKey(priorPlan), priorLabel: priorPlan.provenance.label, hour: meta.hour, hourFactor: meta.hourFactor,
    calibrationDatasetIds: meta.datasetIds, constraintIds: meta.constraintIds, heldOutDatasetIds: meta.heldOutDatasetIds,
    iterations: est.iterations.filter(i => i.iteration > 0 && i.accepted).length, assignments: problem.assignments(), converged: est.converged, stopReason: est.stopReason, options: est.options,
    cells: problem.prior.length, boundedCells: est.boundedCells, change, changeWithinTag: change.every(c => c.within !== false), fit: est.fit,
    priorVph: priorPlan.provenance.vehiclesPerHour, estimatedVph: vph, createdAt: new Date().toISOString(),
  };
  return { trips, provenance: { ...priorPlan.provenance, source: 'calibrated', vehiclesPerHour: vph, pairCount: trips.length,
    label: `ESTIMATED FROM CALIBRATION COUNTS (ODME, ${odme.iterations} iterations, ${meta.datasetIds.length} dataset${meta.datasetIds.length === 1 ? '' : 's'}; valid for ${String(meta.hour).padStart(2, '0')}:00). Matrix change ${odme.changeWithinTag ? 'within' : 'OUTSIDE'} TAG M3.1 Table 5 limits. Prior: ${priorPlan.provenance.label}`,
    odme } };
}

/** Runs the estimator on an area and returns the estimate, the new demand version and both loads. */
export function estimateAreaDemand(args: {
  area: StudyArea; roads: ReadonlyMap<string, DrivableObject>; plan: DemandPlan; trips: readonly MicroDemandTrip[];
  constraints: readonly CountConstraint[]; heldOutDatasetIds: string[]; hour: number; hourFactor: number;
  assignment?: AssignmentOptions; options?: OdmeOptions;
}) {
  const problem = areaOdProblem(args.area, args.roads, args.trips, args.assignment);
  const { counts, skipped } = constraintsToCounts(args.constraints, problem.linkIndex);
  const est = estimateOd(problem, counts, { ...args.options, heldOutDatasetIds: args.heldOutDatasetIds });
  const plan = odmeDemandVersion(args.plan, problem, est, { hour: args.hour, hourFactor: args.hourFactor, constraintIds: counts.map(c => c.id), heldOutDatasetIds: args.heldOutDatasetIds, datasetIds: [...new Set(counts.map(c => c.datasetId))] });
  return { problem, counts, skipped, estimate: est, plan };
}

export type { OdmeLoad };

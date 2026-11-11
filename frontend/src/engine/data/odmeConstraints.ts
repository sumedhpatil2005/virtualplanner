/**
 * Interface between the Traffic Data Manager and a future OD matrix estimator
 * (ODME, docs/RESEARCH_AND_TECHNICAL_DECISIONS.md A2). No estimator is
 * implemented here: this file only turns stored counts into typed constraints
 * and fixes the contract an estimator must honour.
 *
 * Rules carried into the contract:
 * - Only datasets whose role is 'calibration' become estimation constraints.
 *   'validation' datasets are held out and must never be fed to the estimator
 *   (TAG M3.1 §3.3.8: report fitted and independent counts separately).
 * - Estimated datasets are used only when the caller allows it explicitly; each
 *   constraint carries its dataset kind, so measured and estimated stay distinguishable.
 * - Counts are hourly flows at one place. They constrain link/turn volumes of the
 *   assignment; they are not demand and are never written into the matrix.
 * - The estimator reports TAG M3.1 Table 5 change statistics and does not hide a breach.
 */
import type { DatasetKind, EngineCountRow } from './trafficData';

export type CountUnit = 'veh/h' | 'pcu/h';

export interface LinkCountConstraint {
  type: 'link';
  id: string;
  /** Edge ids of the road in the counted direction (`${roadId}_seg_${i}_fwd|bwd`); the count is at one of them. */
  linkIds: string[];
  /** 'both' counts constrain fwd + bwd together. */
  direction: 'fwd' | 'bwd' | 'both';
  observed: number;
  unit: CountUnit;
  hour: number;
  dayType: string;
  datasetId: string;
  kind: DatasetKind;
  /** Relative weight (1 = default). Estimator-specific weighting by count quality is left to the estimator. */
  weight: number;
}

export interface TurnCountConstraint {
  type: 'turn';
  id: string;
  junctionRef: string;
  fromRoadId: string;
  toRoadId: string;
  observed: number;
  unit: CountUnit;
  hour: number;
  dayType: string;
  datasetId: string;
  kind: DatasetKind;
  weight: number;
}

export type CountConstraint = LinkCountConstraint | TurnCountConstraint;

/** TAG M3.1 (May 2026) Table 5 significance limits for matrix change; see research doc A2. */
export interface MatrixChangeLimits {
  cellSlope: [number, number]; cellR2Min: number;
  tripEndSlope: [number, number]; tripEndR2Min: number;
  tripLengthMeanPct: number; tripLengthSdPct: number; sectorPct: number;
}
export const TAG_M31_TABLE5: MatrixChangeLimits = {
  cellSlope: [0.98, 1.02], cellR2Min: 0.95, tripEndSlope: [0.99, 1.01], tripEndR2Min: 0.98,
  tripLengthMeanPct: 5, tripLengthSdPct: 5, sectorPct: 5,
};

export interface OdmeInput<Matrix> {
  prior: Matrix;
  constraints: CountConstraint[];
  limits: MatrixChangeLimits;
  /** Ids of datasets held out for validation: an estimator must reject any constraint from them. */
  heldOutDatasetIds: string[];
}

export interface OdmeResult<Matrix> {
  matrix: Matrix;
  /** Per constraint: observed vs assigned after estimation. */
  fit: { id: string; observed: number; modelled: number; geh: number }[];
  /** Change statistics vs the prior and whether each Table 5 limit holds; a breach is reported, never hidden. */
  change: { name: string; value: number; limit: string; within: boolean }[];
}

export interface OdmeEstimator<Matrix> {
  estimate(input: OdmeInput<Matrix>): Promise<OdmeResult<Matrix>>;
}

export interface ConstraintOptions {
  hour: number;
  /** Day types the modelled hour stands for. */
  dayTypes?: readonly string[];
  unit?: CountUnit;
  allowEstimated?: boolean;
}

export interface ConstraintBuild { constraints: CountConstraint[]; heldOutDatasetIds: string[]; skipped: { row: EngineCountRow; reason: string }[] }

/** Count rows → estimation constraints for one modelled hour, with every skipped row and its reason. */
export function countsToConstraints(rows: readonly EngineCountRow[], edgeIds: Iterable<string>, o: ConstraintOptions): ConstraintBuild {
  const unit = o.unit ?? 'veh/h';
  const days = new Set(o.dayTypes ?? ['weekday', 'all_days']);
  const byRoad = new Map<string, string[]>();
  for (const id of edgeIds) {
    const m = /^(.*)_seg_\d+_(fwd|bwd)$/.exec(id);
    if (m) (byRoad.get(m[1]) ?? byRoad.set(m[1], []).get(m[1])!).push(id);
  }
  const constraints: CountConstraint[] = [], skipped: ConstraintBuild['skipped'] = [];
  const heldOut = new Set<string>();
  for (const r of rows) {
    if (r.role === 'validation') { heldOut.add(r.dataset_id); skipped.push({ row: r, reason: 'validation dataset: held out' }); continue; }
    if (r.role !== 'calibration') { skipped.push({ row: r, reason: 'dataset not chosen for calibration' }); continue; }
    if (r.kind === 'estimated' && !o.allowEstimated) { skipped.push({ row: r, reason: 'estimated data not allowed for this estimation' }); continue; }
    if (!r.complete || r.span || r.hour !== o.hour) { skipped.push({ row: r, reason: 'not a complete count of the modelled hour' }); continue; }
    if (!days.has(r.day_type)) { skipped.push({ row: r, reason: `${r.day_type} count does not match the modelled day type` }); continue; }
    const observed = unit === 'veh/h' ? r.veh_h : r.pcu_h;
    if (observed === null) { skipped.push({ row: r, reason: unit === 'pcu/h' ? 'no PCU value (unclassified or no factor set)' : 'no flow' }); continue; }
    const base = { observed, unit, hour: r.hour, dayType: r.day_type, datasetId: r.dataset_id, kind: r.kind, weight: 1 };
    if (r.ref_kind === 'road_direction' && r.road_id && r.direction) {
      const all = byRoad.get(r.road_id) ?? [];
      const linkIds = r.direction === 'both' ? all : all.filter(id => id.endsWith(`_${r.direction}`));
      if (!linkIds.length) { skipped.push({ row: r, reason: 'road not in the network' }); continue; }
      constraints.push({ type: 'link', id: `${r.dataset_id}:${r.road_id}:${r.direction}:${r.hour}`, linkIds: linkIds.sort(), direction: r.direction, ...base });
    } else if (r.ref_kind === 'turn' && r.junction_ref && r.from_road_id && r.to_road_id) {
      constraints.push({ type: 'turn', id: `${r.dataset_id}:${r.junction_ref}:${r.from_road_id}>${r.to_road_id}:${r.hour}`, junctionRef: r.junction_ref, fromRoadId: r.from_road_id, toRoadId: r.to_road_id, ...base });
    } else {
      skipped.push({ row: r, reason: 'junction approach totals are not used as constraints (turns or links are)' });
    }
  }
  return { constraints, heldOutDatasetIds: [...heldOut], skipped };
}

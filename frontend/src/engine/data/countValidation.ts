/**
 * User traffic counts (Traffic Data Manager) against a finished road analysis:
 * observed vs model flow and GEH per count. Evidence only — nothing here
 * changes demand (docs/TRAFFIC_DATA.md §4).
 *
 * Three different quantities are kept apart (mission §5):
 *   observed  = the dataset's count at the place and hour (veh/h)
 *   assigned  = the area routing's volume on that road-direction (demand routed, static assignment)
 *   simulated = vehicles that got through that link in the corridor micro-simulation (throughput)
 * GEH uses calibration/geh.ts. Rows from different datasets are never merged.
 */
import { geh, summarizeGeh, type GehSummary } from '../calibration/geh';
import type { EngineCountRow } from './trafficData';

export interface ModelFlows {
  /** Assigned volume per area link (edge id `${roadId}_seg_${i}_fwd|bwd`), veh/h. */
  areaLinkVph: ReadonlyMap<string, number>;
  /** Simulated volume per corridor link, veh/h (mean over seeds). */
  linkVph: ReadonlyMap<string, number>;
}

export interface CountCheckRow {
  count: EngineCountRow;
  observedVph: number;
  assignedVph: number | null;
  simulatedVph: number | null;
  gehAssigned: number | null;
  gehSimulated: number | null;
}

export interface SkippedCount { count: EngineCountRow; reason: string }

export interface CountCheckResult { rows: CountCheckRow[]; skipped: SkippedCount[]; simulated: GehSummary; assigned: GehSummary }

/** Busiest piece of a road in one direction (as screenlines.ts does), or null when the road is not in the result. */
export function roadDirectionFlow(vph: ReadonlyMap<string, number>, roadId: string, dir: 'fwd' | 'bwd' | 'both'): number | null {
  const prefix = `${roadId}_seg_`;
  let f = 0, b = 0, hasF = false, hasB = false;
  vph.forEach((v, id) => {
    if (!id.startsWith(prefix)) return;
    const rest = id.slice(prefix.length);
    if (!/^\d+_(fwd|bwd)$/.test(rest)) return; // another road whose id extends this one
    if (rest.endsWith('_bwd')) { hasB = true; b = Math.max(b, v); } else { hasF = true; f = Math.max(f, v); }
  });
  // A direction with no link in the result is unknown (null), not zero
  if (dir === 'fwd') return hasF ? f : null;
  if (dir === 'bwd') return hasB ? b : null;
  return hasF || hasB ? f + b : null;
}

/** Day types the model's hour stands for (the diurnal profile is a weekday profile). */
const MODEL_DAY_TYPES = new Set(['weekday', 'all_days']);

export function checkCounts(rows: readonly EngineCountRow[], flows: ModelFlows | null | undefined, hour: number | null): CountCheckResult {
  const out: CountCheckRow[] = [], skipped: SkippedCount[] = [];
  for (const c of rows) {
    if (c.ref_kind !== 'road_direction' || !c.road_id || !c.direction) { skipped.push({ count: c, reason: 'junction approach and turning counts are not compared yet (needs junction movement matching)' }); continue; }
    if (!flows) { skipped.push({ count: c, reason: 'no analysis result' }); continue; }
    if (c.veh_h === null || !c.complete) { skipped.push({ count: c, reason: `incomplete hour (${c.minutes} min counted)` }); continue; }
    if (c.span) { skipped.push({ count: c, reason: `count covers ${c.period}, not one clock hour` }); continue; }
    if (hour === null || c.hour !== hour) { skipped.push({ count: c, reason: `counted at ${c.period}; the run is for ${hour === null ? 'no hour' : `${String(hour).padStart(2, '0')}:00`}` }); continue; }
    if (!MODEL_DAY_TYPES.has(c.day_type)) { skipped.push({ count: c, reason: `${c.day_type} count; the model hour is a weekday hour` }); continue; }
    const assignedVph = roadDirectionFlow(flows.areaLinkVph, c.road_id, c.direction);
    const simulatedVph = roadDirectionFlow(flows.linkVph, c.road_id, c.direction);
    if (assignedVph === null && simulatedVph === null) { skipped.push({ count: c, reason: 'road is not in this study area' }); continue; }
    out.push({
      count: c, observedVph: c.veh_h, assignedVph, simulatedVph,
      gehAssigned: assignedVph === null ? null : geh(assignedVph, c.veh_h),
      gehSimulated: simulatedVph === null ? null : geh(simulatedVph, c.veh_h),
    });
  }
  return {
    rows: out, skipped,
    simulated: summarizeGeh(out.map(r => r.gehSimulated).filter((g): g is number => g !== null)),
    assigned: summarizeGeh(out.map(r => r.gehAssigned).filter((g): g is number => g !== null)),
  };
}

export function countChecksCsv(r: CountCheckResult): string {
  const f = (v: number | null) => (v === null ? '' : v.toFixed(1));
  return ['dataset,kind,synthetic,road_id,direction,day_type,period,observed_veh_h,assigned_veh_h,simulated_veh_h,geh_assigned,geh_simulated',
    ...r.rows.map(x => [`"${x.count.dataset_name.replace(/"/g, '""')}"`, x.count.kind, x.count.synthetic, x.count.road_id, x.count.direction, x.count.day_type, x.count.period,
      f(x.observedVph), f(x.assignedVph), f(x.simulatedVph), f(x.gehAssigned), f(x.gehSimulated)].join(','))].join('\n');
}

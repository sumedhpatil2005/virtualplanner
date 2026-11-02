/**
 * Scenario report: a printable HTML page (print to PDF from the browser) and
 * CSV tables, built only from what the run produced and the cited data files.
 * Every figure carries its data source, as in the app.
 */
import type { CountDataset } from '../calibration/observedCounts';
import type { CalibrationRow } from '../calibration/calibration';
import type { GehSummary } from '../calibration/geh';
import type { MicroSimMetrics } from '../simulation/TrafficMicroSim';
import type { DemandProvenance } from '../simulation/StudyDemand';

export type Los = 'A' | 'B' | 'C' | 'D' | 'E' | 'F';
/**
 * HCM 6th ed. LOS thresholds on control delay (s/veh). Control delay is
 * approximated as 1.3 x stopped delay (the classic HCM stopped-to-control
 * delay ratio), so this LOS is indicative, not an HCM analysis.
 */
export const STOPPED_TO_CONTROL = 1.3;
const SIGNAL_LOS: [number, Los][] = [[10, 'A'], [20, 'B'], [35, 'C'], [55, 'D'], [80, 'E']];
const PRIORITY_LOS: [number, Los][] = [[10, 'A'], [15, 'B'], [25, 'C'], [35, 'D'], [50, 'E']];
export function losFromStoppedDelay(stoppedDelayS: number, signalised: boolean): Los {
  const control = stoppedDelayS * STOPPED_TO_CONTROL;
  for (const [limit, los] of signalised ? SIGNAL_LOS : PRIORITY_LOS) if (control <= limit) return los;
  return 'F';
}

export interface JunctionKpi { name: string; signalised: boolean; vehicles: number; meanStoppedDelayS: number; los: Los; counted: boolean }

export interface ScenarioReportInput {
  generatedAt: string;
  scenarioName: string;
  studyArea: { roads: string[]; rangeM: number; bounds: { minLng: number; minLat: number; maxLng: number; maxLat: number }; roadCount: number; lengthKm: number };
  demand: DemandProvenance | null;
  metrics: MicroSimMetrics | null;
  dataset: CountDataset | null;
  calibration: { rows: CalibrationRow[]; before: GehSummary | null; after: GehSummary | null; fitNote: string | null };
  junctions: JunctionKpi[];
}

const esc = (s: unknown) => String(s ?? '').replace(/[&<>"]/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' }[c]!));
const num = (v: number | null | undefined, d = 0) => (v == null || !Number.isFinite(v) ? '–' : v.toLocaleString('en-IN', { maximumFractionDigits: d, minimumFractionDigits: d }));
const pct = (s: GehSummary | null) => (s?.share == null ? '–' : `${Math.round(s.share * 100)}% (${s.pass}/${s.n})`);
const csvCell = (v: unknown) => { const t = String(v ?? ''); return /[",\n]/.test(t) ? `"${t.replace(/"/g, '""')}"` : t; };
export const toCsv = (header: string[], rows: unknown[][]) => [header, ...rows].map(r => r.map(csvCell).join(',')).join('\n');

export function throughputVph(m: MicroSimMetrics | null): number | null {
  return m && m.timeS > 0 ? (m.completedTrips * 3600) / m.timeS : null;
}

export function reportCsvs(r: ScenarioReportInput): Record<string, string> {
  return {
    'calibration_geh.csv': toCsv(['junction', 'approach', 'turn', 'observed_veh_h', 'simulated_before_veh_h', 'simulated_after_veh_h', 'geh_before', 'geh_after'],
      r.calibration.rows.map(x => [x.junctionName, x.approach, x.turn, x.observed, x.before?.toFixed(1) ?? '', x.after?.toFixed(1) ?? '', x.gehBefore?.toFixed(2) ?? '', x.gehAfter?.toFixed(2) ?? ''])),
    'junction_los.csv': toCsv(['junction', 'control', 'vehicles_crossed', 'mean_stopped_delay_s', 'approx_control_delay_s', 'los_indicative', 'counted'],
      r.junctions.map(j => [j.name, j.signalised ? 'signal' : 'priority', j.vehicles, j.meanStoppedDelayS.toFixed(1), (j.meanStoppedDelayS * STOPPED_TO_CONTROL).toFixed(1), j.los, j.counted ? 'yes' : 'no'])),
    'kpis.csv': toCsv(['kpi', 'value', 'unit', 'source'], [
      ['simulated_time', r.metrics?.timeS ?? '', 's', 'simulated'],
      ['mean_delay', r.metrics?.meanDelayS?.toFixed(1) ?? '', 's/trip', 'simulated'],
      ['mean_travel_time', r.metrics?.meanTravelTimeS?.toFixed(1) ?? '', 's/trip', 'simulated'],
      ['throughput_completed_trips', throughputVph(r.metrics)?.toFixed(0) ?? '', 'veh/h', 'simulated'],
      ['mean_speed', r.metrics?.meanSpeedKmh?.toFixed(1) ?? '', 'km/h', 'simulated'],
      ['demand_entering', r.metrics?.inflowVph ?? '', 'veh/h', r.demand?.source ?? ''],
      ['waiting_to_enter', r.metrics?.waitingToEnter ?? '', 'veh', 'simulated'],
    ]),
  };
}

export function reportHtml(r: ScenarioReportInput): string {
  const ds = r.dataset, m = r.metrics, c = r.calibration;
  const badge = (t: string) => `<span class="b b-${t.toLowerCase()}">${esc(t)}</span>`;
  const demandBadge = r.demand?.source === 'calibrated' ? 'Calibrated' : r.demand?.source === 'synthetic' ? 'Synthetic' : 'Estimated';
  const byJ = new Map<string, CalibrationRow[]>();
  for (const x of c.rows) { if (!byJ.has(x.junctionName)) byJ.set(x.junctionName, []); byJ.get(x.junctionName)!.push(x); }
  return `<!doctype html><html lang="en"><head><meta charset="utf-8"><title>${esc(r.scenarioName)} – TwinCity scenario report</title>
<style>
body{font:13px/1.45 system-ui,-apple-system,Segoe UI,Roboto,sans-serif;color:#111;max-width:900px;margin:24px auto;padding:0 16px}
h1{font-size:22px;margin:0 0 4px}h2{font-size:16px;margin:22px 0 6px;border-bottom:1px solid #ccc;padding-bottom:3px}h3{font-size:13px;margin:12px 0 4px}
table{border-collapse:collapse;width:100%;margin:4px 0 8px}th,td{border:1px solid #ccc;padding:3px 6px;text-align:right}th:first-child,td:first-child{text-align:left}th{background:#f2f2f2}
.muted{color:#555}.b{display:inline-block;font-size:10px;font-weight:600;text-transform:uppercase;border-radius:4px;padding:0 5px;border:1px solid}
.b-observed{color:#05603a;border-color:#05603a}.b-estimated{color:#93370d;border-color:#93370d}.b-calibrated{color:#5925dc;border-color:#5925dc}.b-simulated{color:#3538cd;border-color:#3538cd}.b-synthetic{color:#475467;border-color:#475467}
.pass{color:#05603a}.fail{color:#b42318}@media print{body{margin:0}h2{break-after:avoid}table{break-inside:avoid}}
</style></head><body>
<h1>${esc(r.scenarioName)}</h1>
<p class="muted">TwinCity scenario report · generated ${esc(r.generatedAt)}</p>
<h2>Study area</h2>
<p>Roads studied: ${esc(r.studyArea.roads.join(', ') || '–')}; traffic within ${num(r.studyArea.rangeM)} m along the roads (${num(r.studyArea.roadCount)} roads, ${num(r.studyArea.lengthKm, 1)} km).
Bounds ${r.studyArea.bounds.minLat.toFixed(5)}–${r.studyArea.bounds.maxLat.toFixed(5)} N, ${r.studyArea.bounds.minLng.toFixed(5)}–${r.studyArea.bounds.maxLng.toFixed(5)} E.</p>
<h2>Data sources</h2>
<p>${badge(demandBadge)} Demand: ${esc(r.demand?.label ?? 'none')} ${r.demand ? `(${esc(r.demand.period.replace('_', ' '))}, ${num(r.demand.vehiclesPerHour)} veh/h over ${num(r.demand.pairCount)} OD streams)` : ''}</p>
${ds ? `<p>${badge('Observed')} Junction counts: ${esc(ds.title)} (dataset ${esc(ds.dataset_id)} v${esc(ds.version)}). ${esc(ds.survey.method)} ${esc(ds.survey.peak_hour_note ?? '')} ${esc(ds.survey.date_note ?? '')}</p>
<ul>${ds.sources.map(s => `<li>${esc(s.citation)} ${s.doi ? `doi:${esc(s.doi)}` : esc(s.url ?? '')}</li>`).join('')}</ul>
<p class="muted">PCU: ${esc(ds.pcu.standard)} (LV ${ds.pcu.factors.LV}, HV ${ds.pcu.factors.HV}, TW ${ds.pcu.factors.TW}). ${esc(ds.pcu.rationale ?? '')}</p>` : '<p>No observed counts were loaded.</p>'}
<p>${badge('Simulated')} Traffic: TwinCity microsimulation (IDM car-following, OSM road network and mapped signals).</p>
<h2>Key results ${badge('Simulated')}</h2>
<table><tr><th>Indicator</th><th>Value</th></tr>
<tr><td>Simulated time</td><td>${num(m?.timeS)} s</td></tr>
<tr><td>Average delay per completed trip</td><td>${num(m?.meanDelayS, 1)} s</td></tr>
<tr><td>Average travel time</td><td>${num(m?.meanTravelTimeS, 1)} s</td></tr>
<tr><td>Throughput (completed trips)</td><td>${num(throughputVph(m))} veh/h</td></tr>
<tr><td>Mean speed on the network</td><td>${num(m?.meanSpeedKmh, 1)} km/h</td></tr>
<tr><td>Demand entering</td><td>${num(m?.inflowVph)} veh/h</td></tr>
<tr><td>Vehicles waiting to enter at the end</td><td>${num(m?.waitingToEnter)}</td></tr></table>
<h3>Level of service by junction (indicative)</h3>
<p class="muted">Mean stopped delay on the approach of vehicles that crossed each junction; LOS from HCM 6 thresholds on control delay ≈ ${STOPPED_TO_CONTROL} × stopped delay. Not an HCM capacity analysis.</p>
<table><tr><th>Junction</th><th>Control</th><th>Vehicles</th><th>Stopped delay (s)</th><th>LOS</th></tr>
${r.junctions.map(j => `<tr><td>${esc(j.name)}${j.counted ? ' ' + badge('Observed') : ''}</td><td>${j.signalised ? 'Signal' : 'Priority'}</td><td>${num(j.vehicles)}</td><td>${num(j.meanStoppedDelayS, 1)}</td><td>${j.los}</td></tr>`).join('') || '<tr><td colspan="5">No junction data yet: run traffic first.</td></tr>'}</table>
<h2>Calibration against observed counts</h2>
${c.rows.length ? `<p>Movements with GEH &lt; 5 (target 85%, UK DMRB / FHWA): before ${pct(c.before)}, after ${pct(c.after)}.</p>
${c.fitNote ? `<p class="muted">${esc(c.fitNote)}</p>` : ''}
${[...byJ].map(([name, rows]) => `<h3>${esc(name)}</h3><table><tr><th>Approach · turn</th><th>Observed ${badge('Observed')}</th><th>Simulated</th><th>GEH</th><th>Calibrated</th><th>GEH</th></tr>
${rows.map(x => `<tr><td>${x.approach} · ${x.turn}</td><td>${num(x.observed)}</td><td>${num(x.before)}</td><td class="${(x.gehBefore ?? 99) < 5 ? 'pass' : 'fail'}">${num(x.gehBefore, 1)}</td><td>${num(x.after)}</td><td class="${(x.gehAfter ?? 99) < 5 ? 'pass' : 'fail'}">${num(x.gehAfter, 1)}</td></tr>`).join('')}</table>`).join('')}` : '<p>No calibration run in this study area.</p>'}
<p class="muted">Values marked Observed come from the cited publications; everything else is modelled. The after-calibration GEH is measured on the counts that were fitted (goodness of fit, not independent validation).</p>
</body></html>`;
}

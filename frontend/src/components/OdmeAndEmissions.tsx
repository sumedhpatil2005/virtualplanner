import React, { useState } from 'react';
import { AlertTriangle, Loader2, Sigma, Fuel } from 'lucide-react';
import { engineInstance } from '../engine/TwinCityEngine';
import type { SimulationModeState } from '../engine/simulation/SimulationMode';
import { trafficApi, type DatasetKind } from '../engine/data/trafficData';
import type { OdmeFit } from '../engine/demand/odme';
import type { RoadAnalysisResult } from '../engine/simulation/RoadAnalysis';
import type { ComparisonResult } from '../engine/simulation/ScenarioComparison';
import { GEH_PASS } from '../engine/calibration/geh';
import { Button, Notice } from './ui/kit';
import { DeltaRows } from './ScenarioDeltaTable';

const fmt = (v: number, d = 0) => v.toLocaleString(undefined, { maximumFractionDigits: d, minimumFractionDigits: d });
const gehCls = (g: number) => (g < GEH_PASS ? 'text-emerald-300' : g < 10 ? 'text-amber-300' : 'text-rose-300');
const summary = (f: OdmeFit[], k: 'gehBefore' | 'gehAfter') => {
  if (!f.length) return '–';
  const pass = f.filter(x => x[k] < GEH_PASS).length, mean = f.reduce((n, x) => n + x[k], 0) / f.length;
  return `${pass}/${f.length} under ${GEH_PASS} · mean ${mean.toFixed(1)}`;
};

const FitTable: React.FC<{ title: string; rows: OdmeFit[]; testId: string; note: string }> = ({ title, rows, testId, note }) => (
  <div data-testid={testId}>
    <p className="text-slate-300 font-medium">{title}</p>
    <p className="text-[11px]">GEH before → after: <span className="tabular-nums text-slate-200">{summary(rows, 'gehBefore')} → {summary(rows, 'gehAfter')}</span></p>
    {rows.length > 0 && (
      <table className="w-full tabular-nums mt-1"><thead><tr className="text-slate-500"><th className="text-left font-medium">Count</th><th className="text-right font-medium">Observed veh/h</th><th className="text-right font-medium">Before</th><th className="text-right font-medium">After</th><th className="text-right font-medium">GEH</th></tr></thead>
        <tbody>{rows.map(r => (
          <tr key={r.id} className="border-t border-white/5">
            <td className="py-0.5 text-slate-300 truncate max-w-[9rem]" title={r.id}>{r.id.split(':').slice(1, 3).join(' ')}</td>
            <td className="text-right">{fmt(r.observed)}</td><td className="text-right">{fmt(r.before)}</td><td className="text-right">{fmt(r.after)}</td>
            <td className="text-right"><span className={gehCls(r.gehBefore)}>{r.gehBefore.toFixed(1)}</span> → <span className={gehCls(r.gehAfter)}>{r.gehAfter.toFixed(1)}</span></td>
          </tr>))}</tbody></table>
    )}
    <p className="text-[11px] text-slate-500 leading-snug mt-0.5">{note}</p>
  </div>
);

/**
 * "Estimate demand from calibration counts" (ODME, docs/ODME_AND_EMISSIONS.md): runs the estimator on the
 * Traffic data counts whose role is Calibration, shows the TAG M3.1 Table 5 change statistics and GEH before/after
 * on the calibration counts (fitted) and on the validation counts (held out), and lets the user choose to run on it.
 */
export const OdmeCard: React.FC<{ sim: SimulationModeState }> = ({ sim }) => {
  const mode = engineInstance.simMode;
  const [kinds, setKinds] = useState<DatasetKind[]>(['measured', 'manual']);
  const o = sim.odme, r = o.report, p = r?.provenance;
  const run = async () => {
    try {
      const rows = await trafficApi.counts({ kinds });
      await mode.estimateDemandFromCounts(rows, { allowEstimated: kinds.includes('estimated') });
    } catch (e) {
      // The estimator reports its own errors in state; this is the count fetch failing
      console.warn('[OdmeCard] counts not read', e);
    }
  };
  const usedNow = o.used && sim.analysis.output?.result.evidence.demand?.odme?.createdAt === p?.createdAt;
  return (
    <div className="space-y-2 text-xs text-slate-400 rounded-lg border border-cyan-400/20 bg-cyan-500/5 p-2" data-testid="odme-card">
      <p className="flex items-center gap-2 text-cyan-100 font-medium"><Sigma size={13} /> Estimate demand from calibration counts</p>
      <p className="leading-snug">Adjusts the area's OD demand so the routed volumes come closer to your <strong>Calibration</strong> counts at {String(sim.timeOfDay.hour).padStart(2, '0')}:00 (Spiess 1990 gradient method on this app's equilibrium routing; cells change by a factor of 0.25–4 at most; no new OD pairs; no extra regularisation toward the estimate). <strong>Validation</strong> counts are never used for fitting; they are checked before and after. The result is a separate demand version: the baseline demand is not changed, and you choose whether to run on it.</p>
      <div className="flex items-center gap-2 flex-wrap">
        <label className="flex items-center gap-1 cursor-pointer"><input type="checkbox" checked={kinds.includes('estimated')} onChange={e => setKinds(e.target.checked ? ['measured', 'manual', 'estimated'] : ['measured', 'manual'])} /> include estimated datasets</label>
      </div>
      <Button size="sm" icon={o.status === 'running' ? Loader2 : Sigma} spin={o.status === 'running'} disabled={o.status === 'running' || !sim.area} onClick={() => void run()} data-testid="odme-run">{r ? 'Estimate again' : 'Estimate demand from calibration counts'}</Button>
      {o.status === 'running' && <p>Estimating… each iteration re-runs the area routing; the page may pause.</p>}
      {o.error && <Notice tone="warn" icon={AlertTriangle}>{o.error}</Notice>}
      {o.staleReason && <Notice tone="warn" icon={AlertTriangle}>{o.staleReason}</Notice>}
      {r && p && (
        <div className="space-y-2" data-testid="odme-report">
          <p className="leading-snug">ESTIMATED demand version: {p.iterations} iteration{p.iterations === 1 ? '' : 's'} ({p.assignments} routings, {(r.elapsedMs / 1000).toFixed(1)} s), {p.converged ? 'stopped' : 'not converged'}: {p.stopReason}. Demand {fmt(p.priorVph)} → {fmt(p.estimatedVph)} veh/h (reference hour), {p.cells} OD cells, {p.boundedCells} at a bound. Datasets: {p.calibrationDatasetIds.join(', ')}.</p>
          <div data-testid="odme-change">
            <p className="text-slate-300 font-medium">Change against the demand estimate (TAG M3.1 Table 5) {p.changeWithinTag ? <span className="text-emerald-300">within limits</span> : <span className="text-rose-300">OUTSIDE limits</span>}</p>
            <table className="w-full tabular-nums"><tbody>{p.change.map(c => (
              <tr key={c.name} className="border-t border-white/5"><td className="py-0.5 text-slate-300">{c.name}</td>
                <td className="text-right">{c.value === null ? '–' : Math.abs(c.value) >= 100 ? fmt(c.value) : c.value.toFixed(3)}{c.name.includes('change') ? '%' : ''}</td>
                <td className="text-right text-slate-500 pl-2">{c.within === null ? '≈ 0' : c.limit}</td>
                <td className={`text-right pl-2 ${c.within === false ? 'text-rose-300' : c.within ? 'text-emerald-300' : 'text-slate-500'}`}>{c.within === null ? 'reported' : c.within ? 'ok' : 'breach'}</td></tr>))}</tbody></table>
            <p className="text-[11px] text-slate-500 leading-snug">Intercepts: TAG asks "near zero" without a number, so they are reported, not judged. TAG M3.1 asks that estimation not change the prior demand significantly; a breach means the counts pull the demand far from the estimate, which usually points at the network or the demand model rather than at the counts. Source: DfT TAG M3.1 (May 2026), Table 5.</p>
          </div>
          <FitTable title="Calibration counts (fitted: not independent evidence)" rows={r.calibration} testId="odme-calibration" note="Routed volume of the area assignment before and after, at the count's road and direction. These counts were used for fitting, so a better fit here is expected." />
          <FitTable title="Validation counts (held out, never fitted)" rows={r.validation} testId="odme-validation" note={r.validation.length ? 'Independent check: only these say whether the estimate generalises. Routed volume (assignment), not throughput.' : 'No validation count matches this area and hour, so the estimate has no independent check.'} />
          {r.skipped.length > 0 && <p className="text-[11px] text-slate-500">{r.skipped.length} calibration row{r.skipped.length === 1 ? '' : 's'} not used: {[...new Set(r.skipped.map(s => s.reason))].join('; ')}.</p>}
          <label className="flex items-center gap-2 text-slate-200 cursor-pointer"><input type="checkbox" data-testid="odme-use" checked={o.used} onChange={e => mode.useOdmeDemand(e.target.checked)} /> Run the analysis on this estimated demand</label>
          {o.used && <p className="text-[11px] text-slate-500">{usedNow ? 'The analysis on show uses it.' : 'The analysis will re-run on it.'} Comparisons freeze whichever demand is in use when the baseline is saved.</p>}
          <p className="text-[11px] text-slate-500">Not validated: with few counts many matrices fit equally well (Spiess 1990), and edge-to-edge area demand limits what any count can fix.</p>
        </div>
      )}
    </div>
  );
};

const kg = (g: number) => fmt(g / 1000, 1);

/** Fuel and emissions of the analysis: corridor (speed/acceleration-based) and, separately, the ARAI area cross-check. */
export const EmissionsCard: React.FC<{ result: RoadAnalysisResult | null | undefined }> = ({ result }) => {
  const e = result?.emissions, a = result?.areaEmissions;
  if (!e && !a) return <p className="text-xs text-slate-500">Run the analysis to see fuel and emissions.</p>;
  return (
    <div className="space-y-2 text-xs text-slate-400" data-testid="emissions-card">
      {e && (
        <div>
          <p className="flex items-center gap-2 text-slate-300 font-medium"><Fuel size={13} /> Neighbourhood (simulated, per hour) <span className="text-[10px] uppercase tracking-wide text-amber-300">estimated</span></p>
          <table className="w-full tabular-nums mt-1"><tbody>
            <tr><td>Fuel</td><td className="text-right text-slate-200" data-testid="emissions-fuel">{fmt(e.perHour.fuelL, 1)} L/h</td></tr>
            <tr><td>CO₂</td><td className="text-right text-slate-200">{kg(e.perHour.co2G)} kg/h</td></tr>
            <tr><td>NOx</td><td className="text-right text-slate-200">{fmt(e.perHour.noxG, 0)} g/h</td></tr>
            <tr><td>PM (exhaust + non-exhaust)</td><td className="text-right text-slate-200">{fmt(e.perHour.pmG, 1)} g/h</td></tr>
            <tr><td>Standing still, engine idling</td><td className="text-right text-slate-200">{fmt(e.perHour.idleS / 3600, 1)} veh·h/h ({fmt(e.perHour.idleFuelG / Math.max(1e-9, e.perHour.fuelG) * 100, 0)}% of fuel)</td></tr>
            <tr><td>Distance driven</td><td className="text-right text-slate-200">{fmt(e.perHour.vkm, 0)} veh·km/h</td></tr>
          </tbody></table>
          <table className="w-full tabular-nums mt-1"><thead><tr className="text-slate-500"><th className="text-left font-medium">Class (model class)</th><th className="text-right font-medium pl-2">L/h</th><th className="text-right font-medium pl-2">CO₂ kg/h</th></tr></thead>
            <tbody>{e.byKind.map(k => { const f = e.windowS > 0 ? 3600 / e.windowS : 0; return (
              <tr key={k.kind} className="border-t border-white/5" title={k.note}><td className="py-0.5">{k.kind.replace('_', ' ')} <span className="text-slate-500">({k.hbefaClass}{/STAND-IN/.test(k.note) ? ', stand-in' : ''})</span></td>
                <td className="text-right pl-2">{fmt(k.totals.fuelL * f, 1)}</td><td className="text-right pl-2">{kg(k.totals.co2G * f)}</td></tr>); })}</tbody></table>
          <p className="text-[11px] text-slate-500 leading-snug mt-1">{e.label} Measured window {Math.round(e.windowS)} s × {e.perSeed.length} runs. Model: <a className="underline" href={e.model.url} target="_blank" rel="noreferrer">{e.model.model}</a>.</p>
        </div>
      )}
      {a && (
        <div data-testid="emissions-arai">
          <p className="text-slate-300 font-medium">Whole study area, distance-based cross-check (ARAI 2007)</p>
          <p className="tabular-nums">{fmt(a.vkmPerHour, 0)} veh·km/h · CO₂ {fmt(a.co2KgPerHour, 0)} kg/h · NOx {fmt(a.noxGPerHour / 1000, 1)} kg/h · PM {a.pmGPerHour === null ? '–' : `${fmt(a.pmGPerHour / 1000, 2)} kg/h`}{a.pmMissingKinds.length ? ` (no ARAI PM factor for ${a.pmMissingKinds.join(', ')})` : ''}</p>
          <p className="text-[11px] text-slate-500 leading-snug">{a.label} Source: <a className="underline" href={a.source.url} target="_blank" rel="noreferrer">{a.source.report}</a>.</p>
        </div>
      )}
    </div>
  );
};

/** Compare: corridor fuel and emissions, same frozen demand and seeds; never part of the verdict. */
export const EmissionsCompare: React.FC<{ c: ComparisonResult }> = ({ c }) => !c.emissions ? null : (
  <div className="space-y-1" data-testid="emissions-compare">
    <p className="flex items-center gap-2 text-[11px] font-semibold text-slate-300"><Fuel size={12} /> Fuel and emissions in the neighbourhood <span className="text-[10px] uppercase tracking-wide text-amber-300">estimated</span></p>
    <DeltaRows rows={c.emissions.deltas} />
    <p className="text-[11px] text-slate-500 leading-snug">{c.emissions.note} Model: <a className="underline" href={c.emissions.source} target="_blank" rel="noreferrer">{c.emissions.model}</a>.</p>
  </div>
);

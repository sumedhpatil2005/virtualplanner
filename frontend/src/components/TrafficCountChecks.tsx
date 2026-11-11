import React, { useEffect, useState } from 'react';
import { AlertTriangle, Download, Loader2 } from 'lucide-react';
import type { SimulationModeState } from '../engine/simulation/SimulationMode';
import { trafficApi, type DatasetKind, type EngineCountRow } from '../engine/data/trafficData';
import { checkCounts, countChecksCsv } from '../engine/data/countValidation';
import { GEH_PASS, GEH_TARGET_SHARE, type GehSummary } from '../engine/calibration/geh';
import { Notice, Button } from './ui/kit';
import { ProvenanceBadge } from './TrafficDataPanel';

const fmt = (v: number | null) => (v === null ? '–' : Math.round(v).toLocaleString());
const gehCls = (g: number | null) => (g === null ? 'text-slate-500' : g < GEH_PASS ? 'text-emerald-300' : g < 10 ? 'text-amber-300' : 'text-rose-300');
const share = (s: GehSummary) => (s.share === null ? '–' : `${s.pass}/${s.n} (${Math.round(s.share * 100)}%)`);

type Choice = 'measured' | 'estimated' | 'both';
const KINDS: Record<Choice, DatasetKind[]> = { measured: ['measured', 'manual'], estimated: ['estimated'], both: ['measured', 'manual', 'estimated'] };

/**
 * The user's validation counts (Traffic data, role "Validation") against the
 * finished analysis: observed vs routed (assignment) vs got through
 * (micro-simulation), with GEH. Evidence only; nothing is fitted.
 */
export const TrafficCountChecks: React.FC<{ sim: SimulationModeState }> = ({ sim }) => {
  const [choice, setChoice] = useState<Choice>('measured');
  const [rows, setRows] = useState<EngineCountRow[] | null>(null);
  const [error, setError] = useState<string | null>(null);
  useEffect(() => {
    let live = true;
    setRows(null);
    trafficApi.counts({ role: 'validation', kinds: KINDS[choice] })
      .then(r => { if (live) { setRows(r); setError(null); } })
      .catch(e => live && setError(e instanceof Error ? e.message : String(e)));
    return () => { live = false; };
  }, [choice]);
  const result = sim.analysis.output?.result;
  const hour = sim.analysis.hour ?? null;
  const res = rows ? checkCounts(rows, result ?? null, hour) : null;
  const download = () => {
    if (!res) return;
    const a = document.createElement('a');
    a.href = URL.createObjectURL(new Blob([countChecksCsv(res)], { type: 'text/csv' }));
    a.download = 'traffic_data_validation.csv';
    a.click();
  };
  return (
    <div className="space-y-2 text-xs text-slate-400" data-testid="user-count-checks">
      <div className="flex items-center justify-between gap-2">
        <p className="text-slate-300 font-medium">Your traffic data (validation datasets)</p>
        <div role="radiogroup" aria-label="Which data" className="flex gap-1">
          {(['measured', 'estimated', 'both'] as Choice[]).map(c => (
            <button key={c} role="radio" aria-checked={choice === c} onClick={() => setChoice(c)}
              className={`rounded-md border px-1.5 py-0.5 cursor-pointer ${choice === c ? 'border-cyan-300 bg-cyan-500/20 text-white' : 'border-white/10 text-slate-300 hover:text-white'}`}>
              {c === 'measured' ? 'Measured + manual' : c === 'estimated' ? 'Estimated' : 'All (kept apart)'}
            </button>
          ))}
        </div>
      </div>
      {error && <Notice tone="warn" icon={AlertTriangle}>Traffic data could not be read: {error}</Notice>}
      {!rows && !error && <p className="flex items-center gap-1"><Loader2 size={12} className="animate-spin" /> Reading counts…</p>}
      {res && !result && <p>Run the analysis to compare.</p>}
      {res && result && res.rows.length === 0 && <p>No validation count matches this area and hour{res.skipped.length ? ` (${res.skipped.length} not compared, reasons below)` : ''}.</p>}
      {res && res.rows.length > 0 && (
        <>
          <table className="w-full tabular-nums [&_td]:px-1 [&_th]:px-1" data-testid="observed-vs-simulated">
            <thead><tr className="text-slate-500">
              <th className="text-right font-medium" title="The dataset's count, veh/h">Observed</th>
              <th className="text-right font-medium" title="Demand routed on this road-direction by the area assignment">Routed</th><th className="text-right font-medium" title="GEH of routed vs observed">GEH</th>
              <th className="text-right font-medium" title="Vehicles that got through in the micro-simulation (corridor only)">Simulated</th><th className="text-right font-medium" title="GEH of simulated vs observed">GEH</th>
            </tr></thead>
            <tbody>{res.rows.map((r, i) => (
              <React.Fragment key={i}>
                <tr className="border-t border-white/5">
                  <td colSpan={5} className="pt-1.5 text-slate-300"><span className="flex flex-wrap items-center gap-1.5"><span className="truncate max-w-[12rem]" title={r.count.road_id ?? ''}>{r.count.road_id}</span>
                    <span className="text-[10px] text-slate-500">{r.count.direction} · {r.count.period}</span><ProvenanceBadge kind={r.count.kind} synthetic={r.count.synthetic} />
                    <span className="text-[10px] text-slate-500 truncate max-w-[10rem]" title={r.count.dataset_name}>{r.count.dataset_name}</span></span></td>
                </tr>
                <tr>
                  <td className="text-right text-slate-100 pb-1">{fmt(r.observedVph)}</td>
                  <td className="text-right">{fmt(r.assignedVph)}</td><td className={`text-right ${gehCls(r.gehAssigned)}`}>{r.gehAssigned === null ? '–' : r.gehAssigned.toFixed(1)}</td>
                  <td className="text-right">{fmt(r.simulatedVph)}</td><td className={`text-right ${gehCls(r.gehSimulated)}`}>{r.gehSimulated === null ? '–' : r.gehSimulated.toFixed(1)}</td>
                </tr>
              </React.Fragment>
            ))}</tbody>
          </table>
          <p>GEH &lt; {GEH_PASS}: routed {share(res.assigned)}, simulated {share(res.simulated)}. TAG M3.1 asks for {Math.round(GEH_TARGET_SHARE * 100)}% of counts; {res.simulated.meetsTarget ? 'the simulated flows meet it' : 'not met'}{res.rows.length < 5 ? ' (too few counts to judge)' : ''}.
            Observed, routed and simulated are different quantities: a count is what passed a point, routed is demand on the road, simulated is what got through. Nothing is fitted to these counts.</p>
          <Button size="sm" variant="ghost" icon={Download} onClick={download}>CSV</Button>
        </>
      )}
      {res && res.skipped.length > 0 && result && (
        <details><summary className="cursor-pointer">{res.skipped.length} count{res.skipped.length === 1 ? '' : 's'} not compared</summary>
          <ul className="mt-1 space-y-0.5">{res.skipped.slice(0, 30).map((s, i) => <li key={i}>{s.count.road_id ?? s.count.junction_ref} {s.count.direction ?? ''} {s.count.period} ({s.count.dataset_name}): {s.reason}</li>)}</ul>
        </details>
      )}
    </div>
  );
};

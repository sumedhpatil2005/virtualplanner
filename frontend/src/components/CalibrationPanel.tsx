import React, { useEffect, useState } from 'react';
import { Loader2, AlertTriangle, CheckCircle2, XCircle, Gauge, Eraser, Download, MapPin, ChevronDown, ExternalLink } from 'lucide-react';
import { engineInstance } from '../engine/TwinCityEngine';
import type { SimulationModeState } from '../engine/simulation/SimulationMode';
import { shortCitation, type CountDataset } from '../engine/calibration/observedCounts';
import { rowsToCsv, nearestCounted, type CalibrationRow } from '../engine/calibration/calibration';
import { GEH_PASS, GEH_TARGET_SHARE, type GehSummary } from '../engine/calibration/geh';
import { Section, Button, Notice } from './ui/kit';
import { SourceBadge } from './ui/SourceBadge';

const TURN_LABEL = { left: 'L', straight: 'T', right: 'R' } as const;
const fmt = (v: number | null) => (v === null ? '–' : Math.round(v).toLocaleString());
const pct = (s: GehSummary | null) => (s?.share == null ? '–' : `${Math.round(s.share * 100)}%`);

/** Observed counts vs simulated turning flows at counted junctions in the study area, with GEH and calibration. */
export const CalibrationPanel: React.FC<{ sim: SimulationModeState }> = ({ sim }) => {
  const mode = engineInstance.simMode;
  const c = sim.calibration;
  useEffect(() => { void mode.ensureCountData(); }, [mode]);
  const busy = c.status === 'measuring' || c.status === 'fitting';
  const ds = c.dataset;
  const blocked = sim.osmRoads.status === 'loading' || sim.signals.status === 'loading' || !sim.area;

  return (
    <Section title="Observed counts" aside={ds ? <SourceBadge source="observed" /> : undefined}>
      <div data-testid="calibration-panel" className="space-y-2.5">
        {c.datasetStatus === 'loading' && <Notice icon={Loader2} spin>Loading the observed count file…</Notice>}
        {c.datasetStatus === 'error' && (
          <Notice tone="warn" icon={AlertTriangle} action={<Button variant="ghost" onClick={() => void mode.ensureCountData()}>Retry</Button>}>
            The observed counts could not be loaded. {c.datasetError}
          </Notice>
        )}
        {ds && <Citation ds={ds} />}
        {ds && !c.junctions.length && <NoCountsHere ds={ds} sim={sim} />}
        {ds && c.junctions.length > 0 && (
          <>
            <p className="text-xs text-slate-300">
              Counted here: {c.junctions.map(j => <span key={j.id} className="font-semibold text-white">{j.name}</span>).reduce<React.ReactNode[]>((a, n, i) => (i ? [...a, ', ', n] : [n]), [])}.
            </p>
            {c.junctions.filter(j => j.problem).map(j => (
              <Notice key={j.id} tone="warn" icon={AlertTriangle}>{j.name}: {j.problem} Not compared.</Notice>
            ))}
            <div className="flex flex-wrap gap-2">
              <Button size="sm" icon={busy && c.status === 'measuring' && !c.applied ? Loader2 : Gauge} spin={busy} disabled={busy || blocked} onClick={() => void mode.runCalibration(false)}>Compare with counts</Button>
              <Button size="sm" variant="primary" disabled={busy || blocked} onClick={() => void mode.runCalibration(true)}>Calibrate demand</Button>
              {c.applied && <Button size="sm" variant="ghost" icon={Eraser} disabled={busy} onClick={() => mode.clearCalibration()}>Undo calibration</Button>}
            </div>
            {busy && (
              <div className="space-y-1" aria-live="polite">
                <div className="h-1.5 rounded bg-white/10 overflow-hidden"><div className="h-full bg-cyan-400 transition-all" style={{ width: `${Math.round(c.progress * 100)}%` }} /></div>
                <p className="text-xs text-slate-400">{c.status === 'fitting' ? 'Fitting trip factors to the counts…' : 'Running the simulation from an empty network (5 min warm-up, 15 min counted)…'}</p>
              </div>
            )}
          </>
        )}
        {c.staleReason && !c.rows.length && <p className="text-xs text-slate-500">Earlier results were cleared: {c.staleReason}</p>}
        {c.status === 'error' && <Notice tone="bad" icon={XCircle}>{c.error}</Notice>}
        {c.rows.length > 0 && <Results sim={sim} />}
      </div>
    </Section>
  );
};

const Citation: React.FC<{ ds: CountDataset }> = ({ ds }) => {
  const [open, setOpen] = useState(false);
  return (
    <div className="rounded-lg border border-emerald-400/20 bg-emerald-500/5 p-2.5 text-xs text-slate-300 space-y-1">
      <button className="w-full flex items-start justify-between gap-2 text-left cursor-pointer" onClick={() => setOpen(o => !o)} aria-expanded={open}>
        <span><span className="font-semibold text-emerald-200">{ds.title}</span> · {shortCitation(ds)}</span>
        <ChevronDown size={14} className={`shrink-0 mt-0.5 transition ${open ? 'rotate-180' : ''}`} />
      </button>
      <p className="text-slate-400">Peak hour, veh/h. {ds.survey.peak_hour_note ?? ''} {ds.survey.date ? `Surveyed ${ds.survey.date}.` : ds.survey.date_note ?? ''}</p>
      {open && (
        <div className="space-y-1.5 pt-1">
          {ds.sources.map(s => (
            <p key={s.id} className="leading-snug">
              {s.citation}{' '}
              {(s.doi || s.url) && <a className="inline-flex items-center gap-0.5 text-cyan-300 hover:underline" href={s.doi ? `https://doi.org/${s.doi}` : s.url} target="_blank" rel="noreferrer">{s.doi ? `doi:${s.doi}` : 'link'}<ExternalLink size={10} /></a>}
              <span className="block text-slate-500">{s.role}</span>
            </p>
          ))}
          <p className="text-slate-500">PCU: {ds.pcu.standard} (LV {ds.pcu.factors.LV}, HV {ds.pcu.factors.HV}, TW {ds.pcu.factors.TW}). {ds.pcu.rationale}</p>
          {ds.missing?.length ? <p className="text-slate-500">Not in the sources: {ds.missing.map(m => m.field).join(', ')}.</p> : null}
        </div>
      )}
    </div>
  );
};

/** Offers to move the study to a counted junction when none is in range. */
const NoCountsHere: React.FC<{ ds: CountDataset; sim: SimulationModeState }> = ({ ds, sim }) => {
  const mode = engineInstance.simMode;
  const centre = sim.area ? [(sim.area.bounds.minLng + sim.area.bounds.maxLng) / 2, (sim.area.bounds.minLat + sim.area.bounds.maxLat) / 2] : null;
  const near = centre ? nearestCounted(ds, centre[0], centre[1]) : null;
  return (
    <div className="space-y-1.5">
      <p className="text-xs text-slate-400">
        No counted junction lies in this study area{near ? `; the nearest is ${near.junction.name}, ${(near.distanceM / 1000).toFixed(1)} km away` : ''}. Counted junctions:
      </p>
      <div className="flex flex-wrap gap-1.5">
        {ds.junctions.map(j => (
          <button key={j.id} title={`Study the roads at ${j.name}`} onClick={() => {
            const road = mode.pickRoadAt(j.location.lon, j.location.lat, 80);
            if (road) mode.selectRoad(road, false); else mode.flyTo([j.location.lon, j.location.lat, 0]);
          }} className="inline-flex items-center gap-1 rounded-md border border-white/10 bg-white/5 px-2 py-1 text-xs text-slate-200 hover:bg-white/10 cursor-pointer">
            <MapPin size={11} /> {j.name}
          </button>
        ))}
      </div>
      <p className="text-[11px] text-slate-500">A junction's roads must be imported first; if nothing happens, the map flies there so you can import them.</p>
    </div>
  );
};

const Summary: React.FC<{ label: string; s: GehSummary | null; source: 'estimated' | 'synthetic' | 'calibrated' }> = ({ label, s, source }) => (
  <div className={`rounded-lg border p-2 ${s?.meetsTarget ? 'border-emerald-400/30 bg-emerald-500/5' : 'border-white/10 bg-white/5'}`}>
    <div className="flex items-center justify-between gap-1"><span className="text-[11px] uppercase tracking-wide text-slate-400">{label}</span><SourceBadge source={source} /></div>
    <p className="mt-1 text-lg font-semibold text-white tabular-nums">{pct(s)}</p>
    <p className="text-[11px] text-slate-400">{s ? `${s.pass}/${s.n} movements GEH<${GEH_PASS}` : 'not run'}{s ? ` · mean ${s.meanGeh?.toFixed(1)}` : ''}</p>
    {s && <p className={`text-[11px] font-semibold ${s.meetsTarget ? 'text-emerald-300' : 'text-amber-300'}`}>{s.meetsTarget ? 'Meets' : 'Below'} the {Math.round(GEH_TARGET_SHARE * 100)}% target</p>}
  </div>
);

const Results: React.FC<{ sim: SimulationModeState }> = ({ sim }) => {
  const c = sim.calibration;
  const baseSource = sim.traffic.demand?.source === 'synthetic' || (sim.traffic.demand?.source === 'calibrated' && /Synthetic/.test(sim.traffic.demand.label)) ? 'synthetic' : 'estimated';
  const byJunction = new Map<string, CalibrationRow[]>();
  for (const r of c.rows) { if (!byJunction.has(r.junctionId)) byJunction.set(r.junctionId, []); byJunction.get(r.junctionId)!.push(r); }
  const hasAfter = c.rows.some(r => r.after !== null);
  const download = () => {
    const blob = new Blob([rowsToCsv(c.rows)], { type: 'text/csv' });
    const a = document.createElement('a');
    a.href = URL.createObjectURL(blob);
    a.download = 'calibration_geh.csv';
    a.click();
    URL.revokeObjectURL(a.href);
  };
  return (
    <div className="space-y-2.5" data-testid="calibration-results">
      <div className="grid grid-cols-2 gap-2">
        <Summary label="Before" s={c.before} source={baseSource} />
        <Summary label="After calibration" s={c.after} source="calibrated" />
      </div>
      {c.fit && (
        <div className="rounded-lg border border-violet-400/20 bg-violet-500/5 p-2.5 text-xs text-slate-300 space-y-1">
          <p className="font-semibold text-violet-200 flex items-center gap-1">{c.fit.converged ? <CheckCircle2 size={13} /> : <AlertTriangle size={13} />} Calibration: bounded IPF, {c.fit.iterations} iteration{c.fit.iterations === 1 ? '' : 's'}{c.fit.converged ? ', converged' : ', stopped before converging'}</p>
          <p>Trip factors {c.fit.factorMin.toFixed(2)}–{c.fit.factorMax.toFixed(2)} (allowed 0.25–4){c.fit.cappedTrips ? `; ${c.fit.cappedTrips} trip(s) at a bound` : ''}.</p>
          <p>Assigned flows (routes, no congestion): {pct(c.fit.assignedBefore)} → {pct(c.fit.assignedAfter)} of movements GEH&lt;5.</p>
          {c.fit.seeds > 0 && <p className="text-amber-200/90">{c.fit.seeds} count-seeded trip(s) added ({c.fit.seedVph.toLocaleString()} veh/h before fitting) for counted movements no estimated trip used.</p>}
          {c.fit.unreachable > 0 && <p className="text-amber-200/90">{c.fit.unreachable} counted movement(s) cannot be reached by any route in this network.</p>}
          <p className="text-slate-500">Where simulated flows stay below the fitted assignment, vehicles are queuing (junction capacity or control), which scaling demand cannot fix.</p>
          <p className="text-slate-500">"After" is measured on the same counts that were fitted: it shows goodness of fit, not independent validation. Calibrated at the {Math.round(c.fit.demandLevel * 100)}% volume setting; changing volume clears it.</p>
        </div>
      )}
      <p className="text-[11px] text-slate-500">Simulated: {c.windowS ? Math.round(c.windowS / 60) : '–'} min counted after a 5 min warm-up, scaled to veh/h. Compared with the observed peak hour (clock time not published).</p>
      {[...byJunction].map(([id, rows]) => (
        <div key={id} className="rounded-lg border border-white/10 overflow-hidden">
          <p className="px-2 py-1.5 bg-white/5 text-xs font-semibold text-white flex justify-between"><span>{rows[0].junctionName}</span><span className="font-normal text-slate-400">{rows.filter(r => (hasAfter ? r.gehAfter : r.gehBefore)! < GEH_PASS).length}/{rows.length} pass</span></p>
          <table className="w-full text-[11px] tabular-nums">
            <thead className="text-slate-400">
              <tr><th className="text-left px-2 py-1 font-medium">Move</th><th className="text-right px-1 font-medium" title="Observed (cited)">Obs</th><th className="text-right px-1 font-medium">Sim</th><th className="text-right px-1 font-medium">GEH</th>{hasAfter && <><th className="text-right px-1 font-medium">Cal</th><th className="text-right px-2 font-medium">GEH</th></>}</tr>
            </thead>
            <tbody>
              {rows.map(r => (
                <tr key={`${r.approach}${r.turn}`} className="border-t border-white/5">
                  <td className="px-2 py-0.5 text-slate-300">{r.approach}·{TURN_LABEL[r.turn]}</td>
                  <td className="text-right px-1 text-emerald-200">{fmt(r.observed)}</td>
                  <td className="text-right px-1 text-slate-300">{fmt(r.before)}</td>
                  <td className={`text-right px-1 ${r.gehBefore! < GEH_PASS ? 'text-emerald-300' : 'text-rose-300'}`}>{r.gehBefore?.toFixed(1)}</td>
                  {hasAfter && <><td className="text-right px-1 text-slate-300">{fmt(r.after)}</td><td className={`text-right px-2 ${r.gehAfter! < GEH_PASS ? 'text-emerald-300' : 'text-rose-300'}`}>{r.gehAfter?.toFixed(1)}</td></>}
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      ))}
      <p className="text-[11px] text-slate-500">Move = approach · L left, T straight, R right (left-hand traffic). Obs <SourceBadge source="observed" className="ml-0.5" />, Sim <SourceBadge source="simulated" className="ml-0.5" />.</p>
      <Button size="sm" variant="ghost" icon={Download} onClick={download}>Download table (CSV)</Button>
    </div>
  );
};

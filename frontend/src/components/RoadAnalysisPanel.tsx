import React, { useState } from 'react';
import {
  Loader2, AlertTriangle, CheckCircle2, Eye, Hammer, Flag, GitCompareArrows, MapPin, ArrowDownRight, ArrowUpRight, Info, TrendingDown, TrendingUp, Minus, Route,
} from 'lucide-react';
import { engineInstance } from '../engine/TwinCityEngine';
import type { SimulationModeState } from '../engine/simulation/SimulationMode';
import type { RoadAnalysisResult, RoadStatus, JunctionUse } from '../engine/simulation/RoadAnalysis';
import { improvementsFor } from '../engine/simulation/improvements';
import type { ComparisonResult, Delta, Verdict } from '../engine/simulation/ScenarioComparison';
import { hourLabel } from '../engine/simulation/timeOfDay';
import { formatDistanceM } from '../lib/format';
import { Section, Button, Notice } from './ui/kit';
import { SourceBadge } from './ui/SourceBadge';
import { sourceOf } from './ui/dataSource';

/**
 * The default view of a selected road, answering in order: what is happening
 * on it, is there a problem, why, what could improve it, and (after a change in
 * Build) did the change help. Every figure comes from a fixed, repeatable
 * analysis run (analysisJob.ts), not from the live animation.
 */

const STATUS: Record<RoadStatus, { label: string; cls: string; dot: string }> = {
  underused: { label: 'Under-used', cls: 'text-sky-200 bg-sky-500/15 border-sky-400/30', dot: 'bg-sky-400' },
  normal: { label: 'Flowing', cls: 'text-emerald-200 bg-emerald-500/15 border-emerald-400/30', dot: 'bg-emerald-400' },
  busy: { label: 'Busy', cls: 'text-amber-200 bg-amber-500/15 border-amber-400/30', dot: 'bg-amber-400' },
  congested: { label: 'Congested', cls: 'text-rose-200 bg-rose-500/15 border-rose-400/30', dot: 'bg-rose-400' },
  no_traffic: { label: 'Almost no traffic', cls: 'text-slate-200 bg-slate-500/20 border-slate-400/30', dot: 'bg-slate-400' },
};

const peakName = (hour: number) => (hour >= 7 && hour <= 11 ? 'morning peak' : hour >= 17 && hour <= 21 ? 'evening peak' : hour < 6 ? 'night' : 'off-peak');

export const RoadAnalysisView: React.FC<{ sim: SimulationModeState }> = ({ sim }) => {
  const { analysis, section } = sim;
  const out = analysis.output;
  const r = out?.result ?? null;
  const running = analysis.status === 'running';
  return (
    <>
      <Section title="What's happening" aside={analysis.hour !== null ? `${hourLabel(analysis.hour)} · ${peakName(analysis.hour)}` : undefined}>
        {running && (
          <div role="status" className="space-y-1.5">
            <p className="flex items-center gap-2 text-sm text-cyan-200"><Loader2 size={15} className="animate-spin" /> {r ? 'Updating the analysis…' : 'Analysing an hour of traffic on this road…'}</p>
            <div className="h-1.5 rounded-full bg-white/10 overflow-hidden"><div className="h-full bg-cyan-400 transition-all" style={{ width: `${Math.round(analysis.progress * 100)}%` }} /></div>
            {!r && <p className="text-xs text-slate-500">A repeatable run: same demand, same random seed, drivers adapting their routes once. Live traffic on the map is only for watching.</p>}
          </div>
        )}
        {analysis.status === 'error' && <Notice tone="warn" icon={AlertTriangle}>{analysis.error}</Notice>}
        {r && <Summary r={r} demandSource={r.evidence.demand?.source ?? null} sectionLength={section?.lengthM ?? r.section.lengthM} stale={running} />}
      </Section>
      {r && r.status !== 'no_traffic' && <Sources r={r} />}
      {r && <Influences r={r} />}
      {r && <Improvements r={r} sim={sim} />}
      <ScenarioTest sim={sim} />
    </>
  );
};

const fmt = (n: number) => Math.round(n).toLocaleString();

const Summary: React.FC<{ r: RoadAnalysisResult; demandSource: string | null; sectionLength: number; stale: boolean }> = ({ r, demandSource, sectionLength, stale }) => {
  const st = STATUS[r.status];
  const maxCap = Math.max(1, ...r.directions.map(d => Math.max(d.capacityVph, d.demandVph, d.vph)));
  return (
    <div className={`space-y-3 ${stale ? 'opacity-60' : ''}`} data-testid="road-summary">
      <div className="flex items-center gap-2 flex-wrap">
        <span className={`inline-flex items-center gap-1.5 rounded-full border px-2.5 py-0.5 text-sm font-semibold ${st.cls}`}><span className={`h-2 w-2 rounded-full ${st.dot}`} />{st.label}</span>
        <span className="text-sm text-slate-300 tabular-nums">{fmt(r.totalVph)} veh/h</span>
        <SourceBadge source={demandSource === 'hypothetical' ? 'hypothetical' : 'simulated'} className="ml-auto" />
      </div>
      <ul className="space-y-2">
        {r.directions.map(d => (
          <li key={d.label} className="space-y-1">
            <div className="flex items-baseline justify-between gap-2 text-sm">
              <span className="text-slate-200">{d.label.charAt(0).toUpperCase() + d.label.slice(1)}</span>
              <span className="tabular-nums text-white">{fmt(d.vph)} <span className="text-slate-500 text-xs">veh/h</span></span>
            </div>
            <div className="relative h-2 rounded-full bg-white/5 overflow-hidden" title={`Capacity ${fmt(d.capacityVph)} veh/h (assumed, ${d.lanes} lane${d.lanes === 1 ? '' : 's'})`}>
              <div className="absolute inset-y-0 left-0 bg-slate-500/30" style={{ width: `${(100 * d.capacityVph) / maxCap}%` }} />
              {d.demandVph > d.vph && <div className="absolute inset-y-0 left-0 bg-rose-400/30" style={{ width: `${(100 * d.demandVph) / maxCap}%` }} />}
              <div className={`absolute inset-y-0 left-0 ${d.vc > 0.9 ? 'bg-rose-400' : d.vc > 0.6 ? 'bg-amber-400' : 'bg-emerald-400'}`} style={{ width: `${(100 * d.vph) / maxCap}%` }} />
            </div>
            <p className="text-xs text-slate-500 tabular-nums">
              {Math.round(d.vc * 100)}% of capacity · {d.meanSpeedKmh === null ? 'no speed sample' : `${Math.round(d.meanSpeedKmh)} km/h (free flow ${Math.round(d.freeSpeedKmh)})`}
              {d.demandVph > 1.1 * d.vph && d.demandVph - d.vph > 50 ? ` · ${fmt(d.demandVph)} veh/h want to use it` : ''}
            </p>
          </li>
        ))}
      </ul>
      {r.load?.message && <div data-testid="overload"><Notice tone="warn" icon={AlertTriangle}>{r.load.message}</Notice></div>}
      <div className="space-y-1.5">
        {r.reasons.filter(x => x !== r.load?.message).map((x, i) => <p key={i} className="text-sm text-slate-300 leading-snug">{x}</p>)}
      </div>
      <p className="text-xs text-slate-500">{formatDistanceM(sectionLength)} section{r.section.carriageways === 2 ? ', both carriageways' : ''}{r.section.endsAt.length ? `, from ${r.section.endsAt.slice(0, 2).join(' to ')}` : ''}. Estimated traffic, not counted on this road.</p>
    </div>
  );
};

const Sources: React.FC<{ r: RoadAnalysisResult }> = ({ r }) => {
  const [shown, setShown] = useState(false);
  const mode = engineInstance.simMode;
  const through = Math.round(r.composition.throughShare * 100);
  return (
    <Section title="Where its traffic comes from and goes" aside={<button className="text-xs text-cyan-300 hover:text-white cursor-pointer" onClick={() => { mode.showSelectLink(!shown); setShown(!shown); }}>{shown ? 'Hide on map' : 'Show on map'}</button>}>
      <div className="space-y-2" data-testid="select-link">
        <div>
          <div className="flex h-2 rounded-full overflow-hidden bg-white/5"><div className="bg-violet-400" style={{ width: `${through}%` }} /><div className="bg-teal-400" style={{ width: `${100 - through}%` }} /></div>
          <p className="mt-1 text-xs text-slate-400"><span className="text-violet-300">{through}% passing through</span> the area · <span className="text-teal-300">{100 - through}% starting or ending</span> in it</p>
        </div>
        <PlaceList title="Comes from" icon={ArrowDownRight} places={r.origins} />
        <PlaceList title="Goes to" icon={ArrowUpRight} places={r.destinations} />
      </div>
    </Section>
  );
};

const PlaceList: React.FC<{ title: string; icon: typeof ArrowDownRight; places: RoadAnalysisResult['origins'] }> = ({ title, icon: Icon, places }) => (
  <div>
    <p className="text-xs font-semibold text-slate-400 flex items-center gap-1"><Icon size={13} />{title}</p>
    <ul className="mt-1 space-y-0.5">
      {places.slice(0, 3).map(p => (
        <li key={p.label} className="flex justify-between gap-2 text-xs">
          <button className="text-left text-slate-300 hover:text-white cursor-pointer truncate" title={p.label} onClick={() => engineInstance.simMode.flyTo(p.coordinates)}>{p.label}</button>
          <span className="tabular-nums text-slate-400 shrink-0">{Math.round(p.share * 100)}%</span>
        </li>
      ))}
    </ul>
  </div>
);

const Influences: React.FC<{ r: RoadAnalysisResult }> = ({ r }) => {
  const js = r.junctions.slice(0, 3);
  const roads = r.nearby.slice(0, 3);
  if (!js.length && !roads.length) return null;
  return (
    <Section title="Junctions and roads around it">
      <ul className="space-y-1.5">
        {js.map(j => <JunctionRow key={j.id} j={j} />)}
      </ul>
      {roads.length > 0 && (
        <ul className="space-y-1 pt-1">
          {roads.map(n => (
            <li key={n.roadName + n.roadClass} className="flex justify-between gap-2 text-xs">
              <span className="text-slate-300 truncate">{n.roadName}</span>
              <span className="tabular-nums text-slate-400 shrink-0">{fmt(n.vph)} veh/h · {Math.round((n.vc ?? 0) * 100)}%</span>
            </li>
          ))}
        </ul>
      )}
    </Section>
  );
};

const LOS_CLS: Record<string, string> = { A: 'text-emerald-300', B: 'text-emerald-300', C: 'text-lime-300', D: 'text-amber-300', E: 'text-orange-300', F: 'text-rose-300' };
const JunctionRow: React.FC<{ j: JunctionUse }> = ({ j }) => (
  <li className="flex items-center gap-2 text-xs">
    <span className={`w-5 font-bold ${LOS_CLS[j.los] ?? 'text-slate-300'}`} title="Level of service (A free flow ... F breakdown)">{j.los}</span>
    <span className="flex-1 text-slate-300 truncate" title={j.label}>{j.label}{j.atSection ? ' (on the road)' : ''}</span>
    <span className="tabular-nums text-slate-400">{Math.round(j.delayS)} s</span>
    <button aria-label={`Show ${j.label}`} className="p-1 text-slate-400 hover:text-white cursor-pointer" onClick={() => engineInstance.simMode.flyTo([j.coordinates[0], j.coordinates[1], 0])}><Eye size={13} /></button>
  </li>
);

const Improvements: React.FC<{ r: RoadAnalysisResult; sim: SimulationModeState }> = ({ r, sim }) => {
  const list = improvementsFor(r, sim.section?.roadIds ?? sim.seedRoadIds, null);
  if (!list.length) return null;
  return (
    <Section title="Improvements to explore">
      <ul className="space-y-2">
        {list.map(s => (
          <li key={s.title} className="rounded-xl border border-white/10 bg-white/[0.03] p-2.5 space-y-1">
            <p className="text-sm font-medium text-white">{s.title}</p>
            <p className="text-xs text-slate-400 leading-snug">{s.why}</p>
            {s.action && <Button size="sm" variant="ghost" icon={Hammer} onClick={() => engineInstance.editInBuild(s.action!.roadIds, s.action!.at)}>{s.action.label}</Button>}
          </li>
        ))}
      </ul>
      {!sim.comparison.baseline && <p className="text-xs text-slate-500">Before changing anything, save the existing city below so the change can be compared on the same traffic.</p>}
    </Section>
  );
};

const VERDICT: Record<Verdict, { label: string; cls: string; icon: typeof TrendingUp }> = {
  better: { label: 'Better', cls: 'text-emerald-200 bg-emerald-500/15 border-emerald-400/30', icon: TrendingUp },
  worse: { label: 'Worse', cls: 'text-rose-200 bg-rose-500/15 border-rose-400/30', icon: TrendingDown },
  mixed: { label: 'Mixed', cls: 'text-amber-200 bg-amber-500/15 border-amber-400/30', icon: Route },
  no_change: { label: 'No clear change', cls: 'text-slate-200 bg-slate-500/20 border-slate-400/30', icon: Minus },
};

const fmtDelta = (d: Delta) => (v: number | null) => (v === null ? '—' : `${d.unit === 's' || d.unit === 'km/h' ? Math.round(v) : fmt(v)}${d.unit === 's' ? ' s' : d.unit === 'km/h' ? ' km/h' : ''}`);

const DeltaRows: React.FC<{ rows: Delta[] }> = ({ rows }) => (
  <table className="w-full text-xs tabular-nums">
    <thead><tr className="text-slate-500"><th className="text-left font-medium pb-1">Measure</th><th className="text-right font-medium pb-1">Existing</th><th className="text-right font-medium pb-1">Proposal</th></tr></thead>
    <tbody>
      {rows.map(d => (
        <tr key={d.label} className="border-t border-white/5">
          <th className="py-1.5 text-left font-normal text-slate-400">{d.label}</th>
          <td className="text-right text-slate-300">{fmtDelta(d)(d.before)}</td>
          <td className={`text-right ${d.good === true ? 'text-emerald-300' : d.good === false ? 'text-rose-300' : 'text-white'}`}>{fmtDelta(d)(d.after)}{d.change !== null && Math.abs(d.change) >= 0.005 ? <span className="text-slate-500"> ({d.change > 0 ? '+' : ''}{Math.round(d.change * 100)}%)</span> : null}</td>
        </tr>
      ))}
    </tbody>
  </table>
);

/** Existing city against a proposal on the same frozen demand. */
export const ScenarioTest: React.FC<{ sim: SimulationModeState }> = ({ sim }) => {
  const mode = engineInstance.simMode;
  const { baseline, result, staleReason, running, progress, demandChanged } = sim.comparison;
  const busy = running || sim.osmRoads.status === 'loading' || sim.signals.status === 'loading';
  return (
    <Section title="Test a change">
      <div className="rounded-2xl border border-indigo-400/25 bg-gradient-to-br from-indigo-500/10 to-slate-900/50 p-3 space-y-2.5" data-testid="scenario-test">
        <ol className="space-y-1 text-xs text-slate-300">
          <li className={baseline ? 'text-emerald-300' : ''}>1. Save the existing city {baseline ? `(saved at ${hourLabel(baseline.hour)}, ${fmt(baseline.demandVph)} veh/h of demand)` : ''}</li>
          <li>2. Change roads, junctions or signals in Build</li>
          <li>3. Come back and compare: same trips, same seed, same hour</li>
        </ol>
        <div className="flex gap-2 flex-wrap">
          <Button size="sm" icon={running && !baseline ? Loader2 : Flag} spin={running && !baseline} disabled={busy} onClick={() => void mode.captureBaseline()}>{baseline ? 'Save again' : 'Save existing city'}</Button>
          <Button size="sm" variant="primary" icon={running && baseline ? Loader2 : GitCompareArrows} spin={running && !!baseline} disabled={busy || !baseline} onClick={() => void mode.runComparison()}>Compare</Button>
        </div>
        {running && <div className="h-1 rounded-full bg-white/10 overflow-hidden"><div className="h-full bg-indigo-400" style={{ width: `${Math.round(progress * 100)}%` }} /></div>}
        {staleReason && <p role="status" className="text-xs text-amber-300">{staleReason}</p>}
        {demandChanged && !running && (
          <Notice tone="info" icon={Info} action={<Button size="sm" variant="ghost" onClick={() => void mode.runComparison({ withNewDemand: true })}>Include it</Button>}>
            Land use changed since the baseline. Compare keeps the baseline's demand (road changes alone); include the new land use for a development scenario.
          </Notice>
        )}
        {result && <ComparisonView c={result} />}
      </div>
    </Section>
  );
};

const ComparisonView: React.FC<{ c: ComparisonResult }> = ({ c }) => {
  const road = VERDICT[c.verdict.section], area = VERDICT[c.verdict.network];
  return (
    <div className="space-y-2.5 pt-1" data-testid="comparison-result">
      {c.kind === 'development' && <p className="text-xs font-semibold uppercase tracking-wide text-fuchsia-300">Development scenario: demand changed too</p>}
      <div className="flex gap-2 flex-wrap">
        <span className={`inline-flex items-center gap-1 rounded-full border px-2 py-0.5 text-xs font-semibold ${road.cls}`}><road.icon size={12} />Road: {road.label}</span>
        <span className={`inline-flex items-center gap-1 rounded-full border px-2 py-0.5 text-xs font-semibold ${area.cls}`}><area.icon size={12} />Area: {area.label}</span>
      </div>
      <p className="text-sm text-slate-200">{c.verdict.summary}</p>
      <DeltaRows rows={c.section} />
      <DeltaRows rows={c.network} />
      {c.rerouting.length > 0 && (
        <div>
          <p className="text-xs font-semibold text-slate-400 flex items-center gap-1"><MapPin size={12} />Where traffic moved</p>
          <ul className="mt-1 space-y-0.5">
            {c.rerouting.slice(0, 5).map(x => <li key={x.roadName} className="flex justify-between text-xs"><span className="text-slate-300 truncate">{x.roadName}</span><span className={`tabular-nums ${x.change > 0 ? 'text-amber-300' : 'text-sky-300'}`}>{x.change > 0 ? '+' : ''}{fmt(x.change)} veh/h</span></li>)}
          </ul>
        </div>
      )}
      {c.caveats.map((x, i) => <p key={i} className="text-[11px] text-slate-500 leading-snug">{x}</p>)}
    </div>
  );
};

/** Demand behind the analysis: what it is made of, and where each part comes from. */
export const DemandEvidence: React.FC<{ sim: SimulationModeState }> = ({ sim }) => {
  const mode = engineInstance.simMode;
  const d = sim.analysis.output?.result.evidence.demand ?? sim.traffic.demand;
  const comp = d?.components;
  const counts = sim.analysis.output?.counts ?? [];
  const scale = sim.demandSettings.hypotheticalScale;
  return (
    <div className="space-y-2 text-xs text-slate-400">
      {d && (
        <div className="flex items-center justify-between gap-2"><span className="text-slate-300">{fmt(d.vehiclesPerHour)} veh/h planned · {d.period.replace('_', ' ')}</span><SourceBadge source={sourceOf(d.source)} /></div>
      )}
      {comp && (
        <ul className="space-y-0.5 tabular-nums">
          <li>Inside the area: {fmt(comp.internal)} veh/h</li>
          <li>Between the area and beyond: {fmt(comp.outbound + comp.inbound)} veh/h</li>
          <li>Through on main roads: {fmt(comp.through)} veh/h{comp.throughIncluded ? '' : ' (off)'}</li>
          {(comp.noEdgeRoute ?? 0) >= 1 && <li className="text-amber-300/80">Left out, no drivable way to the area's edge: {fmt(comp.noEdgeRoute!)} veh/h</li>}
          {comp.outsideArea >= 1 && <li className="text-slate-500">Left out, beyond reach of the area's roads: {fmt(comp.outsideArea)} veh/h</li>}
        </ul>
      )}
      {d && <p className="leading-snug">{d.label}</p>}
      {counts.length > 0 && (
        <div>
          <p className="text-slate-300 font-medium">Against counted junctions in the area (peak hour, entering veh/h)</p>
          <table className="w-full tabular-nums mt-1"><thead><tr className="text-slate-500"><th className="text-left font-medium">Junction</th><th className="text-right font-medium">Counted</th><th className="text-right font-medium">Demand</th><th className="text-right font-medium">Served</th></tr></thead>
            <tbody>{counts.map(c => <tr key={c.id} className="border-t border-white/5"><td className="py-1 text-slate-300">{c.name}{c.problem ? ' *' : ''}</td><td className="text-right">{fmt(c.observedVph)}</td><td className="text-right">{c.problem ? '—' : fmt(c.demandVph)}</td><td className="text-right">{c.problem ? '—' : fmt(c.servedVph)}</td></tr>)}</tbody></table>
          <p className="mt-1 leading-snug">Demand is what the model routes through each junction; served is what got through in the run. Served below demand means the simulated junction passes less than the real one (see docs/CALIBRATION.md).</p>
        </div>
      )}
      <label className="flex items-center gap-2 text-slate-300 cursor-pointer"><input type="checkbox" checked={sim.demandSettings.through} onChange={e => mode.setDemandSettings({ through: e.target.checked })} /> Include traffic passing through on main roads</label>
      <div className="rounded-lg border border-fuchsia-400/30 bg-fuchsia-500/5 p-2 space-y-1.5">
        <p className="flex items-center gap-2 text-fuchsia-200 font-medium">What-if demand <SourceBadge source="hypothetical" /></p>
        <p className="leading-snug">Explore more or less traffic than estimated. Results are labelled hypothetical; they are neither observed nor a forecast.</p>
        <div className="flex gap-1 flex-wrap">
          {[0.5, 0.75, 1, 1.25, 1.5].map(v => (
            <button key={v} onClick={() => mode.setDemandSettings({ hypotheticalScale: v === 1 ? null : v })}
              className={`rounded-md border px-2 py-0.5 cursor-pointer ${((scale ?? 1) === v) ? 'border-fuchsia-300 text-white bg-fuchsia-500/20' : 'border-white/10 text-slate-300 hover:text-white'}`}>{v === 1 ? 'Estimate' : `${Math.round(v * 100)}%`}</button>
          ))}
        </div>
      </div>
      {sim.analysis.output && <p className="text-slate-500">Analysis: {Math.round(sim.analysis.output.result.windowS / 60)} min counted after a 5 min warm-up; {sim.analysis.output.adaptation && !sim.analysis.output.adaptation.applied ? `${sim.analysis.output.adaptation.reason ?? 'Routes were not adapted to congestion.'} ` : `${Math.round((sim.analysis.output.rerouted.at(-1) ?? 0) * 100)}% of trips changed route after adapting to congestion; `}{fmt(sim.analysis.output.unroutedVph)} veh/h could not be routed. <CheckCircle2 size={11} className="inline" /> Same inputs give the same result.</p>}
    </div>
  );
};

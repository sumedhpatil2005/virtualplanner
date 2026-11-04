import React from 'react';
import {
  Loader2, AlertTriangle, ArrowDownRight, ArrowUpRight, Hammer, Flag, GitCompareArrows, TrendingUp, TrendingDown, Minus, Route, MapPin, Info, Map as MapIcon, Clock, Search, CheckCircle2, Gauge,
} from 'lucide-react';
import { engineInstance } from '../engine/TwinCityEngine';
import type { SimulationModeState } from '../engine/simulation/SimulationMode';
import { DAY_PERIODS, periodOfHour } from '../engine/simulation/SimulationMode';
import { STATUS_WORD, VC_BANDS, type RoadAnalysisResult, type RoadStatus, type DirectionFlow } from '../engine/simulation/RoadAnalysis';
import type { ComparisonResult, Verdict, RoadChange } from '../engine/simulation/ScenarioComparison';
import { improvementsFor } from '../engine/simulation/improvements';
import { screenlineChecks } from '../engine/calibration/screenlines';
import { hourLabel } from '../engine/simulation/timeOfDay';
import { Section, Button, Notice } from './ui/kit';
import { SourceBadge } from './ui/SourceBadge';
import { sourceOf } from './ui/dataSource';
import { DeltaRows, ProposalBadge } from './ScenarioDeltaTable';

/**
 * The analysis of the selected road, in the order a planner works:
 * what is wrong (and how sure we are), why, where its traffic comes from,
 * then what to try and how it compares. Every number shown is from the
 * repeatable analysis (area assignment + corridor runs), never from the
 * live animation.
 */

const STATUS: Record<RoadStatus, { label: string; short: string; cls: string; dot: string }> = {
  flowing: { label: 'Flowing', short: 'Flowing', cls: 'text-emerald-200 bg-emerald-500/15 border-emerald-400/30', dot: 'bg-emerald-400' },
  moderate: { label: 'Some delay', short: 'Some delay', cls: 'text-lime-200 bg-lime-500/15 border-lime-400/30', dot: 'bg-lime-400' },
  slow: { label: 'Slow', short: 'Slow', cls: 'text-amber-200 bg-amber-500/15 border-amber-400/30', dot: 'bg-amber-400' },
  congested: { label: 'Congested', short: 'Congested', cls: 'text-orange-200 bg-orange-500/15 border-orange-400/30', dot: 'bg-orange-400' },
  severe: { label: 'Severely congested', short: 'Severe', cls: 'text-rose-200 bg-rose-500/15 border-rose-400/30', dot: 'bg-rose-400' },
  no_traffic: { label: 'Almost no traffic', short: 'Empty', cls: 'text-slate-200 bg-slate-500/20 border-slate-400/30', dot: 'bg-slate-400' },
};
const LOS_CLS: Record<string, string> = { A: 'text-emerald-300', B: 'text-emerald-300', C: 'text-lime-300', D: 'text-amber-300', E: 'text-orange-300', F: 'text-rose-300' };
const fmt = (n: number) => Math.round(n).toLocaleString();
const capital = (s: string) => s.charAt(0).toUpperCase() + s.slice(1);

/** Progress / error / stale states shared by both tabs; null when a result is ready to show. */
const AnalysisGate: React.FC<{ sim: SimulationModeState }> = ({ sim }) => {
  const a = sim.analysis;
  if (a.status === 'error') return <Notice tone="bad" icon={AlertTriangle}>The analysis could not run: {a.error}</Notice>;
  if (!a.output) return (
    <div className="rounded-2xl border border-white/10 bg-white/[0.03] p-4 space-y-2" role="status">
      <p className="text-sm text-slate-200 flex items-center gap-2"><Loader2 size={15} className="animate-spin text-cyan-300" />Analysing {hourLabel(sim.timeOfDay.hour)}…</p>
      <div className="h-1.5 rounded-full bg-white/10 overflow-hidden"><div className="h-full bg-cyan-400 transition-all" style={{ width: `${Math.round(a.progress * 100)}%` }} /></div>
      <p className="text-xs text-slate-500">Routing the area's traffic, then simulating the road's neighbourhood {engineInstance.simMode.analysisSeeds.length} times with different random seeds. About a minute.</p>
    </div>
  );
  return null;
};

export const UnderstandView: React.FC<{ sim: SimulationModeState; goImprove: () => void }> = ({ sim, goImprove }) => {
  const gate = <AnalysisGate sim={sim} />;
  const out = sim.analysis.output;
  if (!out) return gate;
  const r = out.result;
  const stale = sim.analysis.status === 'running';
  const hour = sim.analysis.hour ?? sim.timeOfDay.hour;
  const period = DAY_PERIODS.find(p => p.id === periodOfHour(hour))?.label ?? hourLabel(hour);
  return (
    <div className={`space-y-5 ${stale ? 'opacity-60' : ''}`} data-testid="understand-view">
      {sim.comparison.showingProposal && <ProposalBadge />}
      <StatusCard r={r} period={period} hour={hour} sim={sim} />
      <Directions r={r} />
      <Cause r={r} overlay={sim.overlay} />
      <Measured sim={sim} r={r} />
      <TrafficSources r={r} overlay={sim.overlay} />
      <AreaHotspots r={r} overlay={sim.overlay} />
      {r.load.message && <Notice tone="warn" icon={AlertTriangle}>{r.load.message}</Notice>}
      <Button variant="primary" className="w-full" onClick={goImprove}>Next: what could be improved →</Button>
    </div>
  );
};

const StatusCard: React.FC<{ r: RoadAnalysisResult; period: string; hour: number; sim: SimulationModeState }> = ({ r, period, hour, sim }) => {
  const s = STATUS[r.status];
  const demand = r.evidence.demand;
  return (
    <section className="rounded-2xl border border-white/10 bg-white/[0.03] p-3.5 space-y-2.5" data-testid="road-status" data-status={r.status}>
      <div className="flex items-center gap-2 flex-wrap">
        <span className={`inline-flex items-center gap-1.5 rounded-full border px-2.5 py-1 text-sm font-semibold ${s.cls}`}><span className={`h-2 w-2 rounded-full ${s.dot}`} />{s.label}</span>
        <span className="text-xs text-slate-400">{period} · {hourLabel(hour)} {sim.timeOfDay.day}</span>
      </div>
      <p className="text-sm text-slate-100 leading-snug">{r.headline}</p>
      <div className="flex flex-wrap gap-1.5 items-center text-[11px]">
        <span className={`rounded-md border px-1.5 py-px ${r.statusConsistent ? 'border-white/10 text-slate-400' : 'border-amber-400/40 text-amber-200'}`} data-testid="status-consistency">
          {r.statusConsistent ? `Same in all ${r.seeds.length} runs` : `Runs disagree: ${r.statusBySeed.map(x => STATUS_WORD[x]).join(' / ')}`}
        </span>
        {demand && <SourceBadge source={sourceOf(demand.source)} />}
        <span className="text-slate-500">demand {demand?.source === 'calibrated' ? 'fitted to counts' : 'estimated, not counted'}</span>
      </div>
    </section>
  );
};

const VcBar: React.FC<{ vc: number }> = ({ vc }) => (
  <div className="h-1.5 w-full rounded-full bg-white/10 overflow-hidden" title={`${Math.round(vc * 100)}% of capacity`}>
    <div className="h-full rounded-full" style={{ width: `${Math.min(100, Math.round(vc * 100))}%`, background: VC_BANDS.find(b => vc <= b.max)!.css }} />
  </div>
);

const Directions: React.FC<{ r: RoadAnalysisResult }> = ({ r }) => (
  <Section title="Each direction" aside={`${r.seeds.length} runs, mean`}>
    <div className="space-y-2" data-testid="directions">
      {r.directions.map(d => <DirectionCard key={d.label} d={d} />)}
    </div>
  </Section>
);

const DirectionCard: React.FC<{ d: DirectionFlow }> = ({ d }) => (
  <div className="rounded-xl border border-white/5 bg-white/[0.03] p-2.5 space-y-1.5">
    <div className="flex items-baseline justify-between gap-2">
      <span className="text-sm font-medium text-white">{capital(d.label)}</span>
      <span className="text-xs text-slate-400">level of service <strong className={`text-sm ${LOS_CLS[d.los ?? ''] ?? 'text-slate-300'}`}>{d.los ?? '—'}</strong></span>
    </div>
    <div className="grid grid-cols-3 gap-2 text-xs">
      <div><div className="text-slate-500">Speed</div><div className="text-slate-100 tabular-nums">{d.meanSpeedKmh === null ? '—' : `${Math.round(d.meanSpeedKmh)} km/h`}</div><div className="text-[11px] text-slate-500">free-flow {Math.round(d.freeSpeedKmh)}</div></div>
      <div><div className="text-slate-500">Traffic</div><div className="text-slate-100 tabular-nums">{fmt(d.vph)} veh/h</div><div className="text-[11px] text-slate-500">{fmt(d.demandVph)} routed here</div></div>
      <div><div className="text-slate-500">Time to drive it</div><div className="text-slate-100 tabular-nums">{d.travelTimeS === null ? '—' : `${Math.round(d.travelTimeS)} s`}</div><div className="text-[11px] text-slate-500">{Math.round(d.freeTimeS)} s free-flow</div></div>
    </div>
    <div className="space-y-0.5">
      <VcBar vc={d.vc} />
      <p className="text-[11px] text-slate-500">{Math.round(d.vc * 100)}% of capacity ({fmt(d.capacityPcu)} PCU/h {d.capacityBasis === 'signal' ? 'at the signal at its end' : `mid-block, ${d.lanes} lane${d.lanes === 1 ? '' : 's'}`})</p>
      {(d.los === 'E' || d.los === 'F') && d.vc < 0.85 && (
        <p className="text-[11px] text-amber-200/90" data-testid="slow-below-capacity">Slow although the road itself has room: the hold-up is further on, not its width (see Why).</p>
      )}
    </div>
  </div>
);

const DelayBar: React.FC<{ d: NonNullable<DirectionFlow['delay']> }> = ({ d }) => {
  const parts = [
    { k: 'Waiting at a signal', v: d.signal, c: '#60a5fa' },
    { k: 'Stopped behind a queue from further on', v: d.blocked, c: '#f43f5e' },
    { k: 'Giving way / crossing traffic', v: d.giveWay + d.conflict, c: '#facc15' },
    { k: 'Slow in moving traffic', v: d.other, c: '#94a3b8' },
  ];
  const total = Math.max(1e-9, d.total);
  return (
    <div className="space-y-1">
      <div className="flex h-2 rounded-full overflow-hidden bg-white/10">{parts.map(p => <div key={p.k} style={{ width: `${(100 * p.v) / total}%`, background: p.c }} title={`${p.k}: ${Math.round(p.v)} s`} />)}</div>
      <ul className="flex flex-wrap gap-x-3 gap-y-0.5 text-[11px] text-slate-400">{parts.map(p => <li key={p.k} className="flex items-center gap-1 whitespace-nowrap"><span className="h-2 w-2 rounded-full shrink-0" style={{ background: p.c }} />{p.k}: <span className="text-slate-200 tabular-nums">{Math.round(p.v)} s</span></li>)}</ul>
    </div>
  );
};

const Cause: React.FC<{ r: RoadAnalysisResult; overlay: string }> = ({ r, overlay }) => {
  const mode = engineInstance.simMode;
  const worst = [...r.directions].sort((a, b) => (b.delay?.total ?? 0) - (a.delay?.total ?? 0))[0];
  return (
    <Section title="Why" aside={worst?.delay ? `delay ${Math.round(worst.delay.total)} s per vehicle, ${worst.label}` : undefined}>
      <div className="rounded-xl border border-white/10 bg-white/[0.03] p-3 space-y-2" data-testid="cause" data-kind={r.cause.kind}>
        <p className={`text-sm leading-snug ${r.cause.kind === 'insufficient' ? 'text-amber-100' : 'text-slate-100'}`}>{r.cause.kind === 'insufficient' && <Search size={13} className="inline mr-1 -mt-0.5" />}{r.cause.text || 'No delay worth explaining.'}</p>
        {worst?.delay && worst.delay.total > 3 && <DelayBar d={worst.delay} />}
        {r.cause.chain?.root && <Button size="sm" icon={MapIcon} variant={overlay === 'cause' ? 'primary' : 'secondary'} onClick={() => mode.setOverlay(overlay === 'cause' ? 'none' : 'cause')}>{overlay === 'cause' ? 'Hide the queue on the map' : 'Show the queue on the map'}</Button>}
        {r.reasons.length > 0 && (
          <ul className="space-y-1 text-xs text-slate-400 leading-snug list-disc pl-4">{r.reasons.map((x, i) => <li key={i}>{x}</li>)}</ul>
        )}
      </div>
    </Section>
  );
};

/** Measured traffic on this road, where a published count exists. */
const Measured: React.FC<{ sim: SimulationModeState; r: RoadAnalysisResult }> = ({ sim, r }) => {
  const ids = new Set((sim.section?.roadIds ?? sim.seedRoadIds).map(id => Number(/^osm_(\d+)/.exec(id)?.[1])));
  const checks = screenlineChecks(sim.screenlines, r, sim.analysis.hour).filter(c => c.station.osmWays.some(w => ids.has(w)));
  if (!checks.length) return null;
  const c = checks[0], src = sim.screenlines!.source;
  const ratio = c.station.peakVehicles > 0 ? c.modelVph / c.station.peakVehicles : 0;
  return (
    <Section title="Counted traffic on this road">
      <div className="rounded-xl border border-emerald-400/20 bg-emerald-500/5 p-3 space-y-1.5 text-xs" data-testid="measured">
        <p className="text-sm text-emerald-50"><SourceBadge source="observed" /> {fmt(c.station.peakVehicles)} veh/h both directions, {c.station.peakHour} ({src.surveyYear} count)</p>
        <p className="text-slate-300">The model routes {fmt(c.modelVph)} veh/h over it at {hourLabel(sim.analysis.hour ?? 0)}{c.simulatedVph !== null ? ` (${fmt(c.simulatedVph)} got through in the simulation)` : ''}: {Math.round(100 * ratio)}% of the count{c.sameHour ? '' : ', at a different hour than the count'}.</p>
        {(ratio < 0.5 || ratio > 2) && <p className="text-amber-200">The model's volume here is far from the counted one, so its volumes and level of service on this road should not be relied on. The likely reason is the demand estimate (trips to and from the area are missing or misplaced), not the road itself.</p>}
        {!c.station.comparable && <p className="text-slate-400">{c.station.note}</p>}
        <p className="text-slate-500">{src.title}, {src.tables}. The count is from {src.surveyYear}; traffic has changed since.</p>
      </div>
    </Section>
  );
};

const TrafficSources: React.FC<{ r: RoadAnalysisResult; overlay: string }> = ({ r, overlay }) => {
  const mode = engineInstance.simMode;
  const through = Math.round(100 * r.composition.throughShare);
  return (
    <Section title="Where its traffic comes from and goes">
      <div className="space-y-2">
        <div className="space-y-1">
          <div className="flex h-2 rounded-full overflow-hidden bg-white/10"><div className="bg-violet-400" style={{ width: `${through}%` }} /><div className="bg-cyan-400" style={{ width: `${100 - through}%` }} /></div>
          <p className="text-xs text-slate-400"><span className="text-violet-300">{through}% passing through</span> the area · <span className="text-cyan-300">{100 - through}% starting or ending</span> inside it</p>
        </div>
        <PlaceList title="Comes from" icon={ArrowDownRight} places={r.origins} />
        <PlaceList title="Goes to" icon={ArrowUpRight} places={r.destinations} />
        <Button size="sm" icon={MapIcon} variant={overlay === 'select-link' ? 'primary' : 'secondary'} onClick={() => mode.setOverlay(overlay === 'select-link' ? 'none' : 'select-link')}>{overlay === 'select-link' ? 'Hide routes' : 'Show its routes on the map'}</Button>
      </div>
    </Section>
  );
};

const PlaceList: React.FC<{ title: string; icon: typeof ArrowDownRight; places: RoadAnalysisResult['origins'] }> = ({ title, icon: Icon, places }) => (
  <div>
    <p className="text-xs font-semibold text-slate-400 flex items-center gap-1"><Icon size={12} />{title}</p>
    <ul className="mt-1 space-y-0.5">
      {places.slice(0, 3).map(p => (
        <li key={p.label} className="flex items-center justify-between gap-2 text-xs">
          <button className="text-left text-slate-300 hover:text-white truncate cursor-pointer" onClick={() => engineInstance.simMode.flyTo(p.coordinates)}>{p.label}</button>
          <span className="tabular-nums text-slate-400 shrink-0">{Math.round(p.share * 100)}%</span>
        </li>
      ))}
    </ul>
  </div>
);

const AreaHotspots: React.FC<{ r: RoadAnalysisResult; overlay: string }> = ({ r, overlay }) => {
  const mode = engineInstance.simMode;
  return (
    <Section title="Worst places in the wider area" aside={`${r.assignment.overCapacityLinks} stretches over capacity`}>
      {r.areaBottlenecks.length === 0 ? <p className="text-xs text-slate-400">No road in the area is over 90% of its capacity at this hour.</p> : (
        <ol className="space-y-1">
          {r.areaBottlenecks.slice(0, 4).map((b, i) => (
            <li key={b.label} className="flex items-center justify-between gap-2 text-xs">
              <button className="text-left text-slate-300 hover:text-white cursor-pointer truncate" onClick={() => mode.flyTo(b.coordinates)}>{i + 1}. {b.label}</button>
              <span className="tabular-nums text-rose-300 shrink-0">{Math.round(b.vc * 100)}%</span>
            </li>
          ))}
        </ol>
      )}
      <div className="flex items-center gap-2 flex-wrap">
        <Button size="sm" icon={Gauge} variant={overlay === 'area-vc' ? 'primary' : 'secondary'} onClick={() => mode.setOverlay(overlay === 'area-vc' ? 'none' : 'area-vc')}>{overlay === 'area-vc' ? 'Hide load map' : 'Show how full every road is'}</Button>
        {overlay === 'area-vc' && <span className="flex flex-wrap gap-x-2 text-[11px] text-slate-400">{VC_BANDS.map(b => <span key={b.label} className="inline-flex items-center gap-1"><span className="h-2 w-2 rounded-full" style={{ background: b.css }} />{b.label}</span>)}</span>}
      </div>
      <p className="text-[11px] text-slate-500">From routing all of the area's demand (volume over capacity per stretch). Queues are not modelled at this level; the selected road's neighbourhood is simulated for that.</p>
    </Section>
  );
};

// ── Improve & compare ──────────────────────────────────────────────────────

export const ImproveView: React.FC<{ sim: SimulationModeState }> = ({ sim }) => {
  const out = sim.analysis.output;
  return (
    <div className="space-y-5" data-testid="improve-view">
      {out ? <Suggestions r={out.result} sim={sim} /> : <AnalysisGate sim={sim} />}
      <TimesOfDay sim={sim} />
      <ScenarioTest sim={sim} />
    </div>
  );
};

const Suggestions: React.FC<{ r: RoadAnalysisResult; sim: SimulationModeState }> = ({ r, sim }) => {
  const list = improvementsFor(r, sim.section?.roadIds ?? sim.seedRoadIds, null);
  return (
    <Section title="What to try, and why">
      <ul className="space-y-2" data-testid="suggestions">
        {list.map(s => (
          <li key={s.title} className="rounded-xl border border-white/10 bg-white/[0.03] p-2.5 space-y-1">
            <p className="text-sm font-medium text-white">{s.title}</p>
            <p className="text-xs text-slate-300 leading-snug"><span className="text-slate-500">Evidence: </span>{s.evidence}</p>
            <p className="text-xs text-slate-400 leading-snug">{s.why}</p>
            {s.action && <Button size="sm" variant="ghost" icon={Hammer} onClick={() => engineInstance.editInBuild(s.action!.roadIds, s.action!.at)}>{s.action.label}</Button>}
          </li>
        ))}
      </ul>
      <p className="text-[11px] text-slate-500">These are options to test with the comparison below, not results.</p>
    </Section>
  );
};

const TimesOfDay: React.FC<{ sim: SimulationModeState }> = ({ sim }) => {
  const mode = engineInstance.simMode;
  const tl = sim.timeline;
  return (
    <Section title="Through the day">
      <div className="rounded-xl border border-white/10 bg-white/[0.03] p-3 space-y-2" data-testid="timeline">
        {tl.status !== 'running' && tl.rows.every(r => !r.result) && <p className="text-xs text-slate-400">Analyse the road at the morning peak, midday, the evening peak and night, on the same network, to see when it is a problem.</p>}
        <div className="flex gap-2 items-center">
          <Button size="sm" icon={tl.status === 'running' ? Loader2 : Clock} spin={tl.status === 'running'} disabled={tl.status === 'running'} onClick={() => void mode.runTimeline()}>{tl.rows.some(r => r.result) ? 'Run again' : 'Compare times of day'}</Button>
          {tl.status === 'running' && <><span className="text-xs text-slate-400 tabular-nums">{Math.round(tl.progress * 100)}%</span><Button size="sm" variant="ghost" onClick={() => mode.cancelTimeline()}>Stop</Button></>}
        </div>
        {tl.rows.some(r => r.result) && (
          <table className="w-full text-xs tabular-nums">
            <thead><tr className="text-slate-500 whitespace-nowrap"><th className="text-left font-medium">Period</th><th className="text-right font-medium pl-2" title="Vehicles per hour routed over the whole area">Area veh/h</th><th className="text-right font-medium pl-3" title="Vehicles per hour through the road, both directions">Road veh/h</th><th className="text-right font-medium pl-2" title="Mean speed of the busier direction">km/h</th><th className="text-right font-medium pl-2">Status</th></tr></thead>
            <tbody>{tl.rows.map(row => {
              const r = row.result, top = r?.directions[0];
              return (
                <tr key={row.period} className="border-t border-white/5">
                  <td className="py-1 text-slate-300">{row.label} <span className="text-slate-500">{hourLabel(row.hour)}</span></td>
                  <td className="text-right pl-2">{r ? fmt(row.demandVph) : '…'}</td>
                  <td className="text-right pl-3">{r ? fmt(r.totalVph) : ''}</td>
                  <td className="text-right">{top?.meanSpeedKmh ? `${Math.round(top.meanSpeedKmh)}` : r ? '—' : ''}</td>
                  <td className="text-right pl-2 whitespace-nowrap">{r ? <span className={`inline-flex items-center gap-1 rounded px-1 ${STATUS[r.status].cls}`}><span className={`h-1.5 w-1.5 rounded-full ${STATUS[r.status].dot}`} />{STATUS[r.status].short}</span> : ''}</td>
                </tr>
              );
            })}</tbody>
          </table>
        )}
        {tl.status === 'error' && <p className="text-xs text-rose-300">{tl.error}</p>}
        {(() => { const am = tl.rows.find(r => r.period === 'am'), pm = tl.rows.find(r => r.period === 'pm');
          return am?.result && pm?.result && Math.abs(am.demandVph - pm.demandVph) < 1
            ? <p className="text-[11px] text-amber-200/90" data-testid="peaks-identical">The morning and evening peaks carry the same estimated demand here, so their results match: the traffic crossing the area's edge is estimated per lane from counts, without a morning or evening direction pattern (see Details). Real tidal flows would make them differ.</p>
            : null; })()}
        {tl.rows.some(r => r.result) && <p className="text-[11px] text-slate-500">One run per period (seed 42): differences under about 10% are within run-to-run noise. Each period is analysed on its own, from a warm-up; speed is the busier direction's. Pick a period above to see it in full.</p>}
      </div>
    </Section>
  );
};

const VERDICT: Record<Verdict, { label: string; cls: string; icon: typeof TrendingUp }> = {
  better: { label: 'Better', cls: 'text-emerald-200 bg-emerald-500/15 border-emerald-400/30', icon: TrendingUp },
  worse: { label: 'Worse', cls: 'text-rose-200 bg-rose-500/15 border-rose-400/30', icon: TrendingDown },
  mixed: { label: 'Mixed', cls: 'text-amber-200 bg-amber-500/15 border-amber-400/30', icon: Route },
  no_change: { label: 'No clear change', cls: 'text-slate-200 bg-slate-500/20 border-slate-400/30', icon: Minus },
};

/** Existing city against a proposal on the same frozen demand, hour and seeds. */
export const ScenarioTest: React.FC<{ sim: SimulationModeState }> = ({ sim }) => {
  const mode = engineInstance.simMode;
  const { baseline, result, staleReason, running, progress, demandChanged } = sim.comparison;
  const busy = running || sim.osmRoads.status === 'loading' || sim.signals.status === 'loading';
  return (
    <Section title="Test a change">
      <div className="rounded-2xl border border-indigo-400/25 bg-gradient-to-br from-indigo-500/10 to-slate-900/50 p-3 space-y-2.5" data-testid="scenario-test">
        <ol className="space-y-1 text-xs text-slate-300">
          <li className={baseline ? 'text-emerald-300' : ''}>{baseline ? <CheckCircle2 size={12} className="inline mr-1" /> : '1. '}Save the existing city {baseline ? `(at ${hourLabel(baseline.hour)}, ${fmt(baseline.demandVph)} veh/h of demand)` : ''}</li>
          <li>2. Change roads, junctions or signals in Build</li>
          <li>3. Compare: the same trips, hour and {mode.analysisSeeds.length} seeds on both</li>
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
        {result && <ComparisonView c={result} overlay={sim.overlay} />}
      </div>
    </Section>
  );
};

const RoadChanges: React.FC<{ title: string; rows: RoadChange[]; tone: 'good' | 'bad' }> = ({ title, rows, tone }) => rows.length === 0 ? null : (
  <div>
    <p className={`text-xs font-semibold ${tone === 'good' ? 'text-emerald-300' : 'text-rose-300'}`}>{title}</p>
    <ul className="mt-1 space-y-0.5">{rows.map(x => <li key={x.roadName} className="flex justify-between text-xs gap-2"><span className="text-slate-300 truncate">{x.roadName}</span><span className="tabular-nums text-slate-400 shrink-0">{Math.round(x.vcBefore * 100)}% → <span className={tone === 'good' ? 'text-emerald-300' : 'text-rose-300'}>{Math.round(x.vcAfter * 100)}%</span> of capacity</span></li>)}</ul>
  </div>
);

const ComparisonView: React.FC<{ c: ComparisonResult; overlay: string }> = ({ c, overlay }) => {
  const mode = engineInstance.simMode;
  const v = VERDICT[c.verdict.overall];
  return (
    <div className="space-y-3 pt-1" data-testid="comparison-result" data-verdict={c.verdict.overall}>
      {c.kind === 'development' && <p className="text-xs font-semibold uppercase tracking-wide text-fuchsia-300">Development scenario: demand changed too</p>}
      <div className="flex items-center gap-2 flex-wrap">
        <span className={`inline-flex items-center gap-1 rounded-full border px-2.5 py-1 text-sm font-semibold ${v.cls}`}><v.icon size={14} />{v.label}</span>
        <span className="text-[11px] text-slate-400">road: {VERDICT[c.verdict.section].label.toLowerCase()} · neighbourhood: {VERDICT[c.verdict.network].label.toLowerCase()} · area: {VERDICT[c.verdict.area].label.toLowerCase()}</span>
      </div>
      <p className="text-sm text-slate-200">{c.verdict.summary}</p>
      <p className={`text-xs rounded-lg border px-2 py-1.5 ${c.confidence.level === 'low' ? 'border-amber-400/30 text-amber-100' : 'border-white/10 text-slate-300'}`} data-testid="confidence">Confidence: <strong>{c.confidence.level}</strong>. {c.confidence.text}</p>
      <div className="grid grid-cols-1 gap-2">
        <RoadChanges title="Roads that gain (less loaded)" rows={c.winners} tone="good" />
        <RoadChanges title="Roads that lose (more loaded)" rows={c.losers} tone="bad" />
        {c.newBottlenecks.length > 0 && <p className="text-xs text-rose-200">New bottleneck{c.newBottlenecks.length > 1 ? 's' : ''}: {c.newBottlenecks.map(b => `${b.roadName} (${Math.round(b.vc * 100)}%)`).join(', ')}</p>}
        <Button size="sm" icon={MapIcon} variant={overlay === 'comparison' ? 'primary' : 'secondary'} onClick={() => mode.setOverlay(overlay === 'comparison' ? 'none' : 'comparison')}>{overlay === 'comparison' ? 'Hide changes on the map' : 'Show gains and losses on the map'}</Button>
      </div>
      <p className="text-xs font-semibold text-slate-400">The selected road</p>
      <DeltaRows rows={c.section} />
      <p className="text-xs font-semibold text-slate-400">Its neighbourhood (simulated)</p>
      <DeltaRows rows={c.network} />
      <p className="text-xs font-semibold text-slate-400">The whole area (routed)</p>
      <DeltaRows rows={c.area} />
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

// ── Details ────────────────────────────────────────────────────────────────

/** Demand behind the analysis: what it is made of, and where each part comes from. */
export const DemandEvidence: React.FC<{ sim: SimulationModeState }> = ({ sim }) => {
  const mode = engineInstance.simMode;
  const out = sim.analysis.output;
  const d = out?.result.evidence.demand ?? sim.traffic.demand;
  const comp = d?.components;
  const scale = sim.demandSettings.hypotheticalScale;
  return (
    <div className="space-y-2 text-xs text-slate-400" data-testid="demand-evidence">
      {d && <div className="flex items-center justify-between gap-2"><span className="text-slate-300">{fmt(d.vehiclesPerHour * sim.timeOfDay.factor)} veh/h in the area at {hourLabel(sim.timeOfDay.hour)}</span><SourceBadge source={sourceOf(d.source)} /></div>}
      {comp && (
        <ul className="space-y-0.5 tabular-nums">
          <li>Trips inside the area: {fmt(comp.internal)} veh/h</li>
          <li>Between the area's buildings and beyond: {fmt(comp.outbound + comp.inbound)} veh/h</li>
          <li>Through traffic, edge to edge: {fmt(comp.through)} veh/h{comp.throughIncluded ? '' : ' (off)'}</li>
          {(comp.noEdgeRoute ?? 0) >= 1 && <li className="text-amber-300/80">Left out, no drivable way to the area's edge: {fmt(comp.noEdgeRoute!)} veh/h</li>}
          {comp.outsideArea >= 1 && <li className="text-slate-500">Left out, beyond reach of the area's roads: {fmt(comp.outsideArea)} veh/h</li>}
        </ul>
      )}
      {comp && comp.internal + comp.outbound + comp.inbound < 1 && (
        <Notice tone="warn" icon={AlertTriangle}>The project holds no buildings or zones here, so all the area's traffic is through traffic between its edges, at an assumed {fmt(500)} veh/h per entering lane (an assumption, not a count). Roads that mostly serve local trips will carry too little.</Notice>
      )}
      {d && <p className="leading-snug">{d.label}</p>}
      {out && <p className="text-slate-500">Area routing: {out.result.assignment.iterations} iterations, relative gap {(out.result.assignment.relativeGap * 100).toFixed(2)}%, {(out.timings.assignmentMs / 1000).toFixed(1)} s. Neighbourhood: {fmt(out.result.corridor.demandVph)} veh/h routed through it, simulated {out.result.seeds.length} times ({(out.timings.simulationMs / 1000).toFixed(0)} s). {fmt(out.unroutedVph)} veh/h could not be routed. Same inputs give the same result.</p>}
      <label className="flex items-center gap-2 text-slate-300 cursor-pointer"><input type="checkbox" checked={sim.demandSettings.through} onChange={e => mode.setDemandSettings({ through: e.target.checked })} /> Include traffic passing through the area</label>
      <div className="rounded-lg border border-fuchsia-400/30 bg-fuchsia-500/5 p-2 space-y-1.5">
        <p className="flex items-center gap-2 text-fuchsia-200 font-medium">What-if demand <SourceBadge source="hypothetical" /></p>
        <p className="leading-snug">Try more or less traffic than estimated, to see how sensitive the result is. Results are labelled hypothetical; they are neither observed nor a forecast.</p>
        <div className="flex gap-1 flex-wrap">
          {[0.5, 0.75, 1, 1.25, 1.5].map(v => (
            <button key={v} onClick={() => mode.setDemandSettings({ hypotheticalScale: v === 1 ? null : v })}
              className={`rounded-md border px-2 py-0.5 cursor-pointer ${((scale ?? 1) === v) ? 'border-fuchsia-300 text-white bg-fuchsia-500/20' : 'border-white/10 text-slate-300 hover:text-white'}`}>{v === 1 ? 'Estimate' : `${Math.round(v * 100)}%`}</button>
          ))}
        </div>
      </div>
    </div>
  );
};

/** Model against published counts in the area: river bridges (mid-block) and counted junctions. */
export const CountChecks: React.FC<{ sim: SimulationModeState }> = ({ sim }) => {
  const out = sim.analysis.output;
  const checks = screenlineChecks(sim.screenlines, out?.result, sim.analysis.hour);
  const counts = out?.counts ?? [];
  return (
    <div className="space-y-3 text-xs text-slate-400" data-testid="count-checks">
      {checks.length > 0 ? (
        <div>
          <p className="text-slate-300 font-medium">River bridges in the area (both directions, veh/h)</p>
          <table className="w-full tabular-nums mt-1"><thead><tr className="text-slate-500"><th className="text-left font-medium">Bridge</th><th className="text-right font-medium">Counted</th><th className="text-right font-medium">Model</th><th className="text-right font-medium">GEH</th></tr></thead>
            <tbody>{checks.map(c => <tr key={c.station.id} className="border-t border-white/5"><td className="py-1 text-slate-300">{c.station.name}<span className="block text-[10px] text-slate-500">{c.station.peakHour}{c.station.comparable ? '' : ' · not comparable'}</span></td><td className="text-right">{fmt(c.station.peakVehicles)}</td><td className="text-right">{fmt(c.modelVph)}</td><td className={`text-right ${c.geh > 10 ? 'text-rose-300' : c.geh > 5 ? 'text-amber-300' : 'text-emerald-300'}`}>{c.geh.toFixed(0)}</td></tr>)}</tbody></table>
          <p className="mt-1 leading-snug">Counted: {sim.screenlines?.source.title}, {sim.screenlines?.source.surveyYear} (peak hour of each bridge). Model: the area routing at {hourLabel(sim.analysis.hour ?? 0)}. GEH under 5 is a good match in practice; these counts are old and at their own peak hours, so read large gaps as "the demand is incomplete here", not as precise errors. Nothing is fitted to them.</p>
        </div>
      ) : <p>No counted bridge lies in this area.</p>}
      {counts.length > 0 && (
        <div>
          <p className="text-slate-300 font-medium">Counted junctions in the simulated neighbourhood (peak hour, entering veh/h)</p>
          <table className="w-full tabular-nums mt-1"><thead><tr className="text-slate-500"><th className="text-left font-medium">Junction</th><th className="text-right font-medium">Counted</th><th className="text-right font-medium">Routed</th><th className="text-right font-medium">Got through</th></tr></thead>
            <tbody>{counts.map(c => <tr key={c.id} className="border-t border-white/5"><td className="py-1 text-slate-300">{c.name}{c.problem ? ' *' : ''}</td><td className="text-right">{fmt(c.observedVph)}</td><td className="text-right">{c.problem ? '—' : fmt(c.demandVph)}</td><td className="text-right">{c.problem ? '—' : fmt(c.servedVph)}</td></tr>)}</tbody></table>
        </div>
      )}
    </div>
  );
};

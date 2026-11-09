import React from 'react';
import {
  Loader2, AlertTriangle, Flag, GitCompareArrows, TrendingUp, TrendingDown, Minus, Route, MapPin, Info, Map as MapIcon, Clock, CheckCircle2,
} from 'lucide-react';
import { engineInstance } from '../engine/TwinCityEngine';
import type { SimulationModeState, TimelineState } from '../engine/simulation/SimulationMode';
import { DAY_PERIODS, periodOfHour } from '../engine/simulation/SimulationMode';
import { STATUS_WORD, type RoadAnalysisResult } from '../engine/simulation/RoadAnalysis';
import { DEFAULT_ANALYSIS } from '../engine/simulation/analysisJob';
import { dayRowView, daySummary } from './timeOfDayView';
import type { ComparisonResult, Verdict, RoadChange } from '../engine/simulation/ScenarioComparison';
import { improvementsFor } from '../engine/simulation/improvements';
import { screenlineChecks } from '../engine/calibration/screenlines';
import { hourLabel } from '../engine/simulation/timeOfDay';
import { Button, Notice } from './ui/kit';
import { Card, Chip, Disclosure, InfoToggle, Meter } from './ui/viz';
import { TONE_FILL, TONE_TEXT, type Tone } from './ui/vizTones';
import { STATUS } from './roadAnalysisView';
import { SourceBadge } from './ui/SourceBadge';
import { sourceOf } from './ui/dataSource';
import { DeltaKpi, DeltaRows, ProposalBadge } from './ScenarioDeltaTable';
import { useCameraHeading } from '../hooks/useCameraHeading';
import { CapacityStretchCard, LaneInsightCard } from './LaneBottleneckCard';
import { JunctionCompareCard } from './JunctionCompareCard';
import {
  StatusChip, StatusHeader, WorstKpis, DirectionsGrid, WhyCard, LoadCard, AccountingCard, SourcesCard, BottlenecksCard, SuggestionCard, PerRunDetail, MethodNote, type AnalysisActions,
} from './RoadAnalysisPieces';

/**
 * The analysis of the selected road, in the order a planner works:
 * what is wrong (and how sure we are), why, where its traffic comes from,
 * then what to try and how it compares. Every number shown is from the
 * repeatable analysis (area assignment + corridor runs), never from the
 * live animation.
 */

const fmt = (n: number) => Math.round(n).toLocaleString();

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

/** The panel's actions on the engine, for the engine-free pieces. */
const useActions = (): AnalysisActions => {
  const mode = engineInstance.simMode;
  return {
    hoverDirection: i => mode.hoverDirection(i),
    pinDirection: i => mode.pinDirection(i, true),
    flyTo: c => mode.flyTo(c),
    setOverlay: o => mode.setOverlay(o),
    editInBuild: (ids, at, junction) => engineInstance.editInBuild(ids, at, { junction }),
  };
};

/** Small source badges: where the demand comes from, and that speeds and delays are simulated. */
const DataBadges: React.FC<{ r: RoadAnalysisResult; proposal: boolean }> = ({ r, proposal }) => {
  const demand = r.evidence.demand;
  return (
    <>
      {proposal && <ProposalBadge />}
      {demand && (
        <span className="inline-flex items-center gap-1 text-[11px] text-slate-500" title={demand.source === 'calibrated' ? 'Demand fitted to traffic counts' : 'Demand estimated, not counted'}>
          demand <SourceBadge source={sourceOf(demand.source)} />
        </span>
      )}
      <span className="inline-flex items-center gap-1 text-[11px] text-slate-500">speeds <SourceBadge source="simulated" /></span>
    </>
  );
};

export const UnderstandView: React.FC<{ sim: SimulationModeState; goImprove: () => void; goDetails?: () => void }> = ({ sim, goImprove, goDetails }) => {
  const actions = useActions();
  const heading = useCameraHeading();
  const gate = <AnalysisGate sim={sim} />;
  const out = sim.analysis.output;
  if (!out) return gate;
  const r = out.result;
  const stale = sim.analysis.status === 'running' || !!sim.analysis.outdated;
  const hour = sim.analysis.hour ?? sim.timeOfDay.hour;
  const period = DAY_PERIODS.find(p => p.id === periodOfHour(hour))?.label ?? hourLabel(hour);
  const suggestions = improvementsFor(r, sim.section?.roadIds ?? sim.seedRoadIds, null);
  return (
    <div className="space-y-5">
      {/* Outside the dimmed result, so the notice itself keeps full contrast */}
      {sim.analysis.outdated && (
        <p role="status" data-testid="analysis-outdated" className="rounded-md border border-amber-400/40 bg-amber-400/10 px-3 py-2 text-xs text-amber-200">
          The network changed since this result. It is being re-run on the edited roads.
        </p>
      )}
    <div className={`space-y-5 ${stale ? 'opacity-60' : ''}`} data-testid="understand-view">
      <StatusHeader r={r} when={`${period} · ${hourLabel(hour)} ${sim.timeOfDay.day}`} badges={<DataBadges r={r} proposal={sim.comparison.showingProposal} />} />
      <WorstKpis r={r} />
      <DirectionsGrid r={r} heading={heading} focus={sim.directionFocus} actions={actions} />
      <CapacityStretchCard r={r} onShow={ids => engineInstance.highlightRoads(ids, 'binding')} />
      <WhyCard r={r} overlay={sim.overlay} actions={actions} />
      <LoadCard r={r} />
      <AccountingCard r={r} />
      <Measured sim={sim} r={r} />
      <SourcesCard r={r} overlay={sim.overlay} actions={actions} />
      <BottlenecksCard r={r} overlay={sim.overlay} actions={actions} />
      {suggestions.length > 0 && (
        <section className="space-y-2">
          <div className="flex items-baseline justify-between gap-2">
            <h3 className="text-xs font-semibold uppercase tracking-wide text-slate-400">What to try</h3>
            <span className="text-[11px] text-slate-500">options to test, not results</span>
          </div>
          <ul className="space-y-2" data-testid="suggestions-preview">
            {suggestions.slice(0, 3).map(s => <SuggestionCard key={s.title} s={s} onTest={goImprove} actions={actions} />)}
          </ul>
        </section>
      )}
      <div className="space-y-2">
        <PerRunDetail r={r} />
        <MethodNote onDetails={goDetails} />
      </div>
      <Button variant="primary" className="w-full" onClick={goImprove}>Next: improve &amp; compare →</Button>
    </div>
    </div>
  );
};

/** Measured traffic on this road, where a published count exists: counted, routed and got through as bars. */
const Measured: React.FC<{ sim: SimulationModeState; r: RoadAnalysisResult }> = ({ sim, r }) => {
  const ids = new Set((sim.section?.roadIds ?? sim.seedRoadIds).map(id => Number(/^osm_(\d+)/.exec(id)?.[1])));
  const checks = screenlineChecks(sim.screenlines, r, sim.analysis.hour).filter(c => c.station.osmWays.some(w => ids.has(w)));
  if (!checks.length) return null;
  const c = checks[0], src = sim.screenlines!.source;
  const ratio = c.station.peakVehicles > 0 ? c.modelVph / c.station.peakVehicles : 0;
  const far = ratio < 0.5 || ratio > 2;
  const max = Math.max(1, c.station.peakVehicles, c.modelVph, c.simulatedVph ?? 0);
  const rows: { k: string; v: number; color: string; badge: React.ReactNode; title: string }[] = [
    { k: 'Counted', v: c.station.peakVehicles, color: '#34d399', badge: <SourceBadge source="observed" />, title: `${fmt(c.station.peakVehicles)} veh/h both directions, ${c.station.peakHour} (${src.surveyYear} count)` },
    { k: 'Model routes', v: c.modelVph, color: '#a78bfa', badge: <SourceBadge source={sourceOf(r.evidence.demand?.source)} />, title: `The area routing at ${hourLabel(sim.analysis.hour ?? 0)}` },
    ...(c.simulatedVph !== null ? [{ k: 'Got through', v: c.simulatedVph, color: '#818cf8', badge: <SourceBadge source="simulated" />, title: 'What got through in the simulation' }] : []),
  ];
  return (
    <section className="space-y-2">
      <div className="flex items-baseline justify-between gap-2">
        <h3 className="text-xs font-semibold uppercase tracking-wide text-slate-400">Counted traffic on this road</h3>
        <Chip tone={far ? 'warn' : 'good'} title="Model's routed volume as a share of the count">{Math.round(100 * ratio)}% of count</Chip>
      </div>
      <Card testId="measured" tone="good">
        <ul className="space-y-1.5">
          {rows.map(x => (
            <li key={x.k} className="grid grid-cols-[5.5rem_1fr_3rem_4.75rem] items-center gap-2 text-[11px]" title={x.title}>
              <span className="text-slate-400 whitespace-nowrap">{x.k}</span>
              <Meter value={x.v} max={max} color={x.color} height="md" />
              <span className="tabular-nums text-slate-200 text-right">{fmt(x.v)}</span>
              <span>{x.badge}</span>
            </li>
          ))}
        </ul>
        <p className="text-[11px] text-slate-500">veh/h, both directions · count {c.station.peakHour}, {src.surveyYear}{c.sameHour ? '' : ' · different hour than the model'}</p>
        {far && <p className="text-[11px] text-amber-200 flex items-center gap-1"><AlertTriangle size={12} />Far from the count: don't rely on this road's volumes and LOS.</p>}
        <Disclosure title="Source and caveats" tone="subtle">
          <p>The model routes {fmt(c.modelVph)} veh/h over it at {hourLabel(sim.analysis.hour ?? 0)}{c.simulatedVph !== null ? ` (${fmt(c.simulatedVph)} got through in the simulation)` : ''}: {Math.round(100 * ratio)}% of the count{c.sameHour ? '' : ', at a different hour than the count'}.</p>
          {far && <p className="text-amber-200/90">The model's volume here is far from the counted one, so its volumes and level of service on this road should not be relied on. The likely reason is the demand estimate (trips to and from the area are missing or misplaced), not the road itself.</p>}
          {!c.station.comparable && <p>{c.station.note}</p>}
          <p>{src.title}, {src.tables}. The count is from {src.surveyYear}; traffic has changed since.</p>
        </Disclosure>
      </Card>
    </section>
  );
};

// ── Improve & compare ──────────────────────────────────────────────────────

export const ImproveView: React.FC<{ sim: SimulationModeState }> = ({ sim }) => {
  const out = sim.analysis.output;
  return (
    <div className="space-y-5" data-testid="improve-view">
      {sim.comparison.showingProposal && <ProposalBadge />}
      <ScenarioTest sim={sim} />
      {out ? <Suggestions r={out.result} sim={sim} /> : <AnalysisGate sim={sim} />}
      <TimesOfDay sim={sim} />
    </div>
  );
};

const Suggestions: React.FC<{ r: RoadAnalysisResult; sim: SimulationModeState }> = ({ r, sim }) => {
  const actions = useActions();
  const list = improvementsFor(r, sim.section?.roadIds ?? sim.seedRoadIds, null);
  return (
    <section className="space-y-2">
      <div className="flex items-baseline justify-between gap-2">
        <h3 className="text-xs font-semibold uppercase tracking-wide text-slate-400">What to try</h3>
        <span className="text-[11px] text-slate-500">test each with Compare</span>
      </div>
      <ul className="space-y-2" data-testid="suggestions">
        {list.map(s => <SuggestionCard key={s.title} s={s} full actions={actions} />)}
      </ul>
    </section>
  );
};

const DayRow: React.FC<{ row: TimelineState['rows'][number]; maxVph: number }> = ({ row, maxVph }) => {
  const v = dayRowView(row);
  if (!v) return <li className="text-[11px] text-slate-500" data-testid="timeline-row" data-period={row.period}>{row.label} <span className="tabular-nums">{hourLabel(row.hour)}</span> …</li>;
  const tone = TONE_FILL[STATUS[v.status].tone];
  return (
    <li className="space-y-1 text-[11px]" data-testid="timeline-row" data-period={row.period} data-status={v.status}>
      <div className="flex items-center justify-between gap-2">
        <span className="text-slate-200">{row.label} <span className="text-slate-500 tabular-nums">{v.hourText}</span> <span className="text-slate-500 tabular-nums" data-testid="timeline-factor">{v.factorText}</span></span>
        <StatusChip status={v.status} short />
      </div>
      <div className="grid grid-cols-[5.2rem_1fr_auto] items-center gap-x-2 gap-y-0.5 tabular-nums">
        <span className="text-slate-400">Demand</span>
        <Meter value={v.demandVph} max={maxVph} color="#64748b" height="xs" title="Routed onto the road by the area assignment (both directions)" />
        <span className="text-slate-300 justify-self-end" data-testid="timeline-demand">{fmt(v.demandVph)} veh/h</span>
        <span className="text-slate-400">Got through</span>
        <Meter value={v.throughputVph} max={maxVph} color={tone} height="xs" title="Vehicles the simulation got along the road in the counted window (both directions)" />
        <span className="text-slate-300 justify-self-end" data-testid="timeline-throughput">{fmt(v.throughputVph)} veh/h</span>
      </div>
      <p className="text-slate-400" data-testid="timeline-metric">
        {v.direction ? <>{v.direction}: {v.speedKmh !== null ? `${Math.round(v.speedKmh)} of ${Math.round(v.freeSpeedKmh ?? 0)} km/h` : 'no speed'} · </> : null}{v.metric}
        {v.seeds > 1 && !v.statusConsistent ? <span className="text-amber-200/90"> · runs disagree ({v.statusBySeed.map(x => STATUS_WORD[x]).join(', ')})</span> : null}
      </p>
      {v.unservedVph !== null && <p className="text-amber-200/90" data-testid="timeline-unserved">{fmt(v.unservedVph)} veh/h of the demand did not get along it in the counted window{v.unservedWhy ? `: ${v.unservedWhy}` : ' (queued behind it or held further back)'}.</p>}
      {v.heldBy && <p className="text-rose-200/90" data-testid="timeline-held">Held by a queue traced to {v.heldBy}.</p>}
    </li>
  );
};

export const TimesOfDay: React.FC<{ sim: SimulationModeState }> = ({ sim }) => {
  const mode = engineInstance.simMode;
  const tl = sim.timeline;
  const maxVph = Math.max(1, ...tl.rows.flatMap(r => { const v = dayRowView(r); return v ? [v.demandVph, v.throughputVph] : []; }));
  const summary = tl.status !== 'running' ? daySummary(tl.rows) : [];
  const seeds = tl.rows.find(r => r.seeds)?.seeds ?? mode.analysisSeeds;
  return (
    <section className="space-y-2">
      <h3 className="text-xs font-semibold uppercase tracking-wide text-slate-400">Through the day</h3>
      <Card testId="timeline">
        {tl.status !== 'running' && tl.rows.every(r => !r.result) && <p className="text-xs text-slate-400">Analyse the road at the morning peak, midday, the evening peak and night, on the same network, to see when it is a problem.</p>}
        <div className="flex gap-2 items-center">
          <Button size="sm" icon={tl.status === 'running' ? Loader2 : Clock} spin={tl.status === 'running'} disabled={tl.status === 'running'} onClick={() => void mode.runTimeline()}>{tl.rows.some(r => r.result) ? 'Run again' : 'Compare times of day'}</Button>
          {tl.status === 'running' && <><span className="text-xs text-slate-400 tabular-nums">{Math.round(tl.progress * 100)}%</span><Button size="sm" variant="ghost" onClick={() => mode.cancelTimeline()}>Stop</Button></>}
        </div>
        {tl.outdated && <p className="text-[11px] text-amber-200 flex items-center gap-1" role="status" data-testid="timeline-outdated"><AlertTriangle size={12} />{tl.status === 'running'
          ? 'The network or demand changed after these runs started: they describe the earlier case. Run again when they finish.'
          : 'The network or demand changed since these were computed: they describe the earlier case. Run again.'}</p>}
        {/* Everything read from the rows (rows, day summary, per-run table) is dimmed together when they describe another case (docs/OVERHAUL.md §25) */}
        <div className={`space-y-2 ${tl.outdated ? 'opacity-60' : ''}`} data-testid="timeline-results" data-outdated={tl.outdated ? 'true' : 'false'}>
        {tl.rows.some(r => r.result) && (
          <ul className="space-y-2.5" data-testid="timeline-rows">
            {tl.rows.map(row => <DayRow key={row.period} row={row} maxVph={maxVph} />)}
          </ul>
        )}
        {summary.length > 0 && <div className="text-[11px] text-slate-200 space-y-1 border-t border-white/10 pt-2" data-testid="timeline-summary">{summary.map(t => <p key={t}>{t}</p>)}</div>}
        {tl.status === 'error' && <p className="text-xs text-rose-300">{tl.error}</p>}
        {(() => { const am = tl.rows.find(r => r.period === 'am'), pm = tl.rows.find(r => r.period === 'pm');
          return am?.result && pm?.result && Math.abs(am.demandVph - pm.demandVph) < 1
            ? <div className="text-[11px] text-amber-200/90 space-y-1" data-testid="peaks-identical"><p className="flex items-center gap-1"><AlertTriangle size={12} />Morning and evening peaks match: same estimated demand.</p><InfoToggle label="Why"><p>The morning and evening peaks carry the same estimated demand here, so their results match: the traffic crossing the area's edge is estimated per lane from counts, without a morning or evening direction pattern (see Details). Each peak is taken as the peak of its half of the day (09:00 and 19:00), so both get factor 1. Real tidal flows would make them differ.</p></InfoToggle></div>
            : null; })()}
        {tl.rows.some(r => r.result) && (
          <Disclosure title="Per direction and per run" tone="subtle" testId="timeline-detail">
            <table className="w-full text-[10px] tabular-nums" data-testid="timeline-table">
              <thead className="text-slate-500"><tr><th className="text-left font-normal pr-2">Hour</th><th className="text-left font-normal">Direction</th><th className="text-right font-normal pl-2">Demand</th><th className="text-right font-normal pl-2">Got through</th><th className="text-right font-normal pl-2">km/h</th><th className="text-right font-normal pl-2">LOS</th></tr></thead>
              <tbody className="text-slate-300">
                {tl.rows.flatMap(row => { const v = dayRowView(row); return v ? v.directions.map((d, i) => (
                  <tr key={`${row.period}-${d.label}`} className="align-top">
                    <td className="pr-2">{i === 0 ? `${v.hourText}` : ''}</td><td>{d.label}</td><td className="text-right pl-2">{fmt(d.demandVph)}</td>
                    <td className="text-right pl-2">{fmt(d.throughputVph)}{d.vphBySeed.length > 1 && <span className="block whitespace-nowrap text-slate-500">{d.vphBySeed.map(fmt).join('/')}</span>}</td>
                    <td className="text-right pl-2">{d.speedKmh === null ? '—' : Math.round(d.speedKmh)}{d.speedBySeed.length > 1 && <span className="block whitespace-nowrap text-slate-500">{d.speedBySeed.map(x => x === null ? '—' : Math.round(x)).join('/')}</span>}</td>
                    <td className="text-right pl-2">{d.los ?? '—'}{d.losBySeed.length > 1 && <span className="block text-slate-500">{d.losBySeed.map(x => x ?? '—').join('')}</span>}</td>
                  </tr>)) : []; })}
              </tbody>
            </table>
            <p className="text-[10px] text-slate-500">Grey: each run (seeds {seeds.join(', ')}). Demand is the same in every run (the routing is deterministic); only the simulation varies.</p>
          </Disclosure>
        )}
        </div>
        {tl.rows.some(r => r.result) && <InfoToggle label="How to read this"><p>Each period is computed on its own: the demand for its half of the day times the hour's share of daily traffic (the factor, from the Pune hour profile; measured counts 08:00–19:00, estimated other hours), a fresh routing of the whole area and {seeds.length} fresh simulation runs (seeds {seeds.join(', ')}) from an empty network after a {Math.round(DEFAULT_ANALYSIS.warmupS / 60)}-minute warm-up, counted over {Math.round(DEFAULT_ANALYSIS.measureS / 60)} minutes. Demand is what the routing sends along the road; got through is what the simulation actually moved along it. Where got through is well below demand, traffic is held, by the road or by a queue reaching back from further on. Speed and level of service are for the direction the status comes from (Indo-HCM: travel speed as a share of free-flow speed; F as well when demand exceeds capacity and under 90% of it gets through). Pick a period above to see it in full.</p></InfoToggle>}
      </Card>
    </section>
  );
};

const VERDICT: Record<Verdict, { label: string; tone: Tone; icon: typeof TrendingUp }> = {
  better: { label: 'Better', tone: 'good', icon: TrendingUp },
  worse: { label: 'Worse', tone: 'bad', icon: TrendingDown },
  mixed: { label: 'Mixed', tone: 'warn', icon: Route },
  no_change: { label: 'No clear change', tone: 'neutral', icon: Minus },
};

/** Existing city against a proposal on the same frozen demand, hour and seeds. */
export const ScenarioTest: React.FC<{ sim: SimulationModeState }> = ({ sim }) => {
  const mode = engineInstance.simMode;
  const { baseline, result, staleReason, running, progress, demandChanged } = sim.comparison;
  const busy = running || sim.osmRoads.status === 'loading' || sim.signals.status === 'loading';
  const steps = [
    { n: 1, label: 'Save existing city', done: !!baseline, title: baseline ? `Saved at ${hourLabel(baseline.hour)}, ${fmt(baseline.demandVph)} veh/h of demand` : 'Save the existing city as the baseline' },
    { n: 2, label: 'Edit in Build', done: false, title: 'Change roads, junctions or signals in Build' },
    { n: 3, label: 'Compare', done: !!result, title: `The same trips, hour and ${mode.analysisSeeds.length} seeds on both` },
  ];
  return (
    <section className="space-y-2">
      <h3 className="text-xs font-semibold uppercase tracking-wide text-slate-400">Before vs after</h3>
      <div className="rounded-2xl border border-indigo-400/25 bg-gradient-to-br from-indigo-500/10 to-slate-900/50 p-3 space-y-2.5" data-testid="scenario-test">
        <ol className="grid grid-cols-3 gap-1.5 text-[11px]">
          {steps.map(s => (
            <li key={s.n} title={s.title} className={`flex items-center gap-1.5 rounded-lg border px-1.5 py-1 ${s.done ? 'border-emerald-400/30 text-emerald-200' : 'border-white/10 text-slate-300'}`}>
              {s.done ? <CheckCircle2 size={12} className="shrink-0" /> : <span className="inline-flex h-4 w-4 shrink-0 items-center justify-center rounded-full bg-white/10 text-[10px]">{s.n}</span>}
              <span className="leading-tight">{s.label}</span>
            </li>
          ))}
        </ol>
        {baseline && <p className="text-[11px] text-slate-500">Baseline: {hourLabel(baseline.hour)}, {fmt(baseline.demandVph)} veh/h of demand · {mode.analysisSeeds.length} seeds on both</p>}
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
    </section>
  );
};

/** A road's load before and after, as two bars on one scale with the 100% line. */
const RoadChanges: React.FC<{ title: string; rows: RoadChange[]; tone: 'good' | 'bad' }> = ({ title, rows, tone }) => rows.length === 0 ? null : (
  <div className="space-y-1.5">
    <p className={`text-[11px] font-semibold ${tone === 'good' ? 'text-emerald-300' : 'text-rose-300'}`}>{title}</p>
    <ul className="space-y-1.5">{rows.map(x => (
      <li key={x.roadName} className="space-y-0.5" title={`${x.roadName}: ${Math.round(x.vcBefore * 100)}% → ${Math.round(x.vcAfter * 100)}% of capacity on its busiest stretch`}>
        <div className="flex justify-between gap-2 text-[11px]"><span className="text-slate-300 truncate">{x.roadName}</span><span className="tabular-nums text-slate-400 shrink-0">{Math.round(x.vcBefore * 100)}% → <span className={tone === 'good' ? 'text-emerald-300' : 'text-rose-300'}>{Math.round(x.vcAfter * 100)}%</span></span></div>
        <div className="space-y-px"><Meter value={Math.min(1.5, x.vcBefore)} max={1.5} marker={1} color="#64748b" height="xs" /><Meter value={Math.min(1.5, x.vcAfter)} max={1.5} marker={1} color={tone === 'good' ? '#34d399' : '#f43f5e'} height="xs" /></div>
      </li>
    ))}</ul>
  </div>
);

const LEVEL_KPI: Record<string, string> = { 'Time to drive it': 'Time to drive', 'Speed on it': 'Speed', 'Worst junction delay at its ends': 'End junction delay', 'Traffic through the road': 'Traffic through' };

const ComparisonView: React.FC<{ c: ComparisonResult; overlay: string }> = ({ c, overlay }) => {
  const mode = engineInstance.simMode;
  const v = VERDICT[c.verdict.overall];
  const kpis = ['Time to drive it', 'Speed on it', 'Worst junction delay at its ends', 'Traffic through the road'].map(l => c.section.find(d => d.label === l)).filter((d): d is NonNullable<typeof d> => !!d);
  const otherSection = c.section.filter(d => !kpis.includes(d));
  const sim = [...c.section, ...c.network].filter(d => d.agreement && d.change !== null && Math.abs(d.change) >= 0.05);
  const agreeing = sim.filter(d => d.agreement!.same === d.agreement!.of).length;
  const maxShift = Math.max(1, ...c.rerouting.map(x => Math.abs(x.change)));
  return (
    <div className="space-y-3 pt-1" data-testid="comparison-result" data-verdict={c.verdict.overall}>
      {c.kind === 'development' && <Chip tone="accent" className="!text-fuchsia-200 !border-fuchsia-400/40 !bg-fuchsia-500/15">Development scenario: demand changed too</Chip>}
      <div className="rounded-xl border border-white/10 bg-slate-950/40 p-2.5 space-y-2">
        <div className="flex items-center gap-2 flex-wrap">
          <Chip tone={v.tone} icon={v.icon} size="md" testId="verdict">{v.label}</Chip>
          <Chip tone={c.confidence.level === 'low' ? 'warn' : c.confidence.level === 'high' ? 'good' : 'neutral'} testId="confidence" title={c.confidence.text}>Confidence: {c.confidence.level}</Chip>
          {sim.length > 0 && <Chip tone={agreeing === sim.length ? 'neutral' : 'warn'} title={`Simulated changes of 5% or more: ${agreeing} of ${sim.length} show the same direction in every run`}>runs agree on {agreeing}/{sim.length} changes</Chip>}
        </div>
        <div className="grid grid-cols-3 gap-1.5" data-testid="verdict-levels">
          {([['Road', c.verdict.section], ['Neighbourhood', c.verdict.network], ['Area', c.verdict.area]] as const).map(([k, vv]) => (
            <div key={k} className="rounded-lg border border-white/5 bg-white/[0.03] px-2 py-1">
              <div className="text-[10px] uppercase tracking-wide text-slate-500">{k}</div>
              <div className={`text-xs font-semibold ${TONE_TEXT[VERDICT[vv].tone]}`}>{VERDICT[vv].label}</div>
            </div>
          ))}
        </div>
        <p className="text-xs text-slate-300 leading-snug">{c.verdict.summary}</p>
        <InfoToggle label="About the confidence"><p>{c.confidence.text}</p></InfoToggle>
      </div>
      <div className="grid grid-cols-2 gap-1.5" data-testid="delta-kpis">
        {kpis.map(d => <DeltaKpi key={d.label} d={d} label={LEVEL_KPI[d.label]} />)}
      </div>
      <LaneInsightCard insights={c.laneInsights ?? []} onShow={ids => engineInstance.highlightRoads(ids, 'binding')} />
      <JunctionCompareCard items={mode.junctionComparisons()} />
      {otherSection.length > 0 && <DeltaRows rows={otherSection} />}
      {c.newBottlenecks.length > 0 && (
        <div className="flex flex-wrap gap-1.5 items-center"><span className="text-[11px] text-rose-200">New bottleneck{c.newBottlenecks.length > 1 ? 's' : ''}:</span>{c.newBottlenecks.map(b => <Chip key={b.label} tone="bad" title={b.label}>{b.roadName} {Math.round(b.vc * 100)}%</Chip>)}</div>
      )}
      <RoadChanges title="Roads that gain (less loaded)" rows={c.winners} tone="good" />
      <RoadChanges title="Roads that lose (more loaded)" rows={c.losers} tone="bad" />
      <Button size="sm" icon={MapIcon} variant={overlay === 'comparison' ? 'primary' : 'secondary'} onClick={() => mode.setOverlay(overlay === 'comparison' ? 'none' : 'comparison')}>{overlay === 'comparison' ? 'Hide changes on the map' : 'Show gains and losses on the map'}</Button>
      <div className="space-y-1">
        <p className="text-[11px] font-semibold uppercase tracking-wide text-slate-500">Its neighbourhood (simulated)</p>
        <DeltaRows rows={c.network} />
      </div>
      <div className="space-y-1">
        <p className="text-[11px] font-semibold uppercase tracking-wide text-slate-500">The whole area (routed)</p>
        <DeltaRows rows={c.area} />
      </div>
      {c.rerouting.length > 0 && (
        <div className="space-y-1.5">
          <p className="text-[11px] font-semibold text-slate-400 flex items-center gap-1"><MapPin size={12} />Where traffic moved</p>
          <ul className="space-y-1">
            {c.rerouting.slice(0, 5).map(x => (
              <li key={x.roadName} className="grid grid-cols-[1fr_6rem_auto] items-center gap-2 text-[11px]" title={`${x.roadName}: ${fmt(x.before)} → ${fmt(x.after)} veh/h on its busiest stretch`}>
                <span className="text-slate-300 truncate">{x.roadName}</span>
                <div className="relative h-1.5 rounded-full bg-white/5">
                  <div className="absolute top-0 bottom-0 w-px bg-white/30 left-1/2" />
                  <div className={`absolute top-0 bottom-0 rounded-full ${x.change > 0 ? 'bg-amber-400 left-1/2' : 'bg-sky-400 right-1/2'}`} style={{ width: `${(50 * Math.abs(x.change)) / maxShift}%` }} />
                </div>
                <span className={`tabular-nums text-right ${x.change > 0 ? 'text-amber-300' : 'text-sky-300'}`}>{x.change > 0 ? '+' : ''}{fmt(x.change)} veh/h</span>
              </li>
            ))}
          </ul>
        </div>
      )}
      {c.caveats.length > 0 && (
        <Disclosure title="Assumptions of this comparison" testId="comparison-caveats">
          {c.caveats.map((x, i) => <p key={i}>{x}</p>)}
        </Disclosure>
      )}
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

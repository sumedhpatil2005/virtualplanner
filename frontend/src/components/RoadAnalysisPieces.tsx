import React from 'react';
import {
  ArrowUp, AlertTriangle, CheckCircle2, Hammer, Map as MapIcon, MapPin, Search, Gauge, TrafficCone, Users, Signal, Construction, Split, ChevronRight, ListOrdered, Info, ArrowDownRight, ArrowUpRight,
} from 'lucide-react';
import { VC_BANDS, vcColour, type RoadAnalysisResult, type RoadStatus, type DirectionFlow } from '../engine/simulation/RoadAnalysis';
import type { MapOverlay } from '../engine/simulation/SimulationMode';
import type { Suggestion } from '../engine/simulation/improvements';
import { compassWord, directionColor, landmarkPhrase, screenArrowDeg } from '../engine/simulation/directions';
import { Button } from './ui/kit';
import { Card, Chip, Disclosure, InfoToggle, KpiCard, LosBadge, Meter, StackedBar } from './ui/viz';
import { TONE_FILL, losTone, type Tone } from './ui/vizTones';
import { STATUS, explainedDirection, overloadedRuns, delayParts, causeLine } from './roadAnalysisView';

/**
 * The visual pieces of the road analysis ("What's wrong"), rendered from the
 * analysis result's structured fields. No engine instance is imported, so
 * the pieces can be rendered in tests; the panel passes in the actions.
 * The prose the analysis also produces (headline, cause text, reasons, load
 * message) is kept, but behind a collapsed disclosure or an info toggle.
 */

export interface AnalysisActions {
  hoverDirection: (index: number | null) => void;
  pinDirection: (index: number) => void;
  flyTo: (c: [number, number, number]) => void;
  setOverlay: (o: MapOverlay) => void;
  editInBuild: (roadIds: string[], at: [number, number, number] | null) => void;
}

const STATUS_DOT: Record<Tone, string> = { neutral: 'bg-slate-400', good: 'bg-emerald-400', ok: 'bg-lime-400', warn: 'bg-amber-400', alert: 'bg-orange-400', bad: 'bg-rose-400', info: 'bg-cyan-400', accent: 'bg-indigo-400' };
export const StatusChip: React.FC<{ status: RoadStatus; size?: 'sm' | 'md'; short?: boolean }> = ({ status, size = 'sm', short }) => {
  const s = STATUS[status];
  return <Chip tone={s.tone} size={size}><span className={`h-2 w-2 rounded-full ${STATUS_DOT[s.tone]}`} />{short ? s.short : s.label}</Chip>;
};

const fmt = (n: number) => Math.round(n).toLocaleString();
const capital = (s: string) => s.charAt(0).toUpperCase() + s.slice(1);
const STATUS_WORD_SHORT: Record<RoadStatus, string> = { flowing: 'flowing', moderate: 'some delay', slow: 'slow', congested: 'congested', severe: 'severe', no_traffic: 'empty' };
const dirName = (d: DirectionFlow) => capital(d.compass ?? compassWord(d.labelBearingDeg ?? d.bearingDeg));

// ── Status ─────────────────────────────────────────────────────────────────

export const StatusHeader: React.FC<{ r: RoadAnalysisResult; when: string; badges?: React.ReactNode }> = ({ r, when, badges }) => {
  const w = explainedDirection(r);
  const d = w?.d;
  return (
    <section className="space-y-2" data-testid="road-status" data-status={r.status}>
      <div className="flex items-center gap-2 flex-wrap">
        <StatusChip status={r.status} size="md" />
        <span className="text-xs text-slate-400">{when}</span>
      </div>
      <p className="text-sm text-slate-200 leading-snug" title={r.headline} data-testid="status-line">
        {r.status === 'no_traffic' || !d ? 'Almost no simulated traffic uses this road.' : (
          <>
            <span className="inline-block h-2 w-2 rounded-full mr-1.5 align-middle" style={{ background: directionColor(w!.index) }} />
            {dirName(d)}: <strong className="text-white tabular-nums">{d.meanSpeedKmh === null ? 'no speed' : `${Math.round(d.meanSpeedKmh)} km/h`}</strong>
            <span className="text-slate-400"> vs {Math.round(d.freeSpeedKmh)} free-flow</span>
          </>
        )}
      </p>
      <div className="flex flex-wrap gap-1.5 items-center">
        <Chip tone={r.statusConsistent ? 'neutral' : 'warn'} icon={r.statusConsistent ? CheckCircle2 : AlertTriangle} testId="status-consistency"
          title={r.statusConsistent ? `All ${r.seeds.length} runs (seeds ${r.seeds.join(', ')}) give the same status` : `The runs give different statuses: ${r.statusBySeed.map(x => STATUS_WORD_SHORT[x]).join(' / ')}. The road is near a boundary between levels of service.`}>
          {r.statusConsistent ? `${r.seeds.length}/${r.seeds.length} runs agree` : `Runs disagree: ${r.statusBySeed.map(x => STATUS_WORD_SHORT[x]).join(' / ')}`}
        </Chip>
        {badges}
      </div>
    </section>
  );
};

/** Headline figures of the direction the analysis explains. */
export const WorstKpis: React.FC<{ r: RoadAnalysisResult }> = ({ r }) => {
  const w = explainedDirection(r);
  if (!w || r.status === 'no_traffic') return null;
  const d = w.d;
  const vcTone: Tone = d.vc > 1 ? 'bad' : d.vc > 0.85 ? 'alert' : d.vc > 0.6 ? 'warn' : 'good';
  return (
    <div className="space-y-1.5" data-testid="kpis">
      <div className="flex items-center justify-between text-[11px] text-slate-500">
        <span className="font-semibold uppercase tracking-wide">Worst direction</span>
        <span className="inline-flex items-center gap-1"><span className="h-2 w-2 rounded-full" style={{ background: directionColor(w.index) }} />{dirName(d)} · {Math.round(d.labelBearingDeg ?? d.bearingDeg)}°</span>
      </div>
      <div className="grid grid-cols-4 gap-1.5">
        <KpiCard label="Speed" value={d.meanSpeedKmh === null ? '—' : Math.round(d.meanSpeedKmh)} unit="km/h" sub={`free-flow ${Math.round(d.freeSpeedKmh)}`} tone={losTone(d.los)} testId="kpi-speed"
          title="Mean travel speed over the section, including the wait at the junction at its end (mean of the runs), against its free-flow speed">
          {d.speedRatio !== null && <div className="mt-1"><Meter value={d.speedRatio} color={TONE_FILL[losTone(d.los)]} height="xs" /></div>}
        </KpiCard>
        <KpiCard label="Delay" value={d.delay ? Math.round(d.delay.total) : '—'} unit="s/veh" sub={d.travelTimeS !== null ? `${Math.round(d.travelTimeS)} s vs ${Math.round(d.freeTimeS)} s` : 'no time measured'} testId="kpi-delay"
          title="Delay per vehicle: time to drive the section minus its free-flow time (mean of the runs)" />
        <KpiCard label="Load v/c" value={`${Math.round(d.vc * 100)}%`} sub={`of ${fmt(d.capacityPcu)}`} tone={vcTone} testId="kpi-vc"
          title={`Traffic routed along it (assignment, ${fmt(d.demandPcu)} PCU/h) over its capacity (${fmt(d.capacityPcu)} PCU/h, ${d.capacityBasis === 'signal' ? 'stop line of the signal at its end, Indo-HCM' : `mid-block, ${d.lanes} lane${d.lanes === 1 ? '' : 's'}${d.lanesRange && d.lanesRange[0] !== d.lanesRange[1] ? ` on its narrowest ${fmt(d.narrowestM)} of ${fmt(d.lengthM)} m` : ''}, IRC:106-1990`})`}>
          <div className="mt-1"><Meter value={Math.min(1, d.vc)} color={vcColour(d.vc)} height="xs" /></div>
        </KpiCard>
        <KpiCard label="LOS" value={d.los ?? '—'} sub="Indo-HCM" tone={losTone(d.los)} testId="kpi-los"
          title="Level of service, Indo-HCM 2017 urban streets: travel speed as a share of free-flow speed. A > 84%, B > 76%, C > 59%, D > 41%, E > 22%, F below or when demand exceeds capacity" />
      </div>
    </div>
  );
};

// ── Directions ─────────────────────────────────────────────────────────────

/** Swatch and arrow for a direction: the arrow points the way it runs on screen for the current camera heading. */
export const DirectionGlyph: React.FC<{ index: number; bearingDeg: number; heading: number }> = ({ index, bearingDeg, heading }) => {
  const rot = screenArrowDeg(bearingDeg, heading);
  return (
    <span className="relative inline-flex h-6 w-6 shrink-0 items-center justify-center rounded-full" style={{ background: `${directionColor(index)}26`, boxShadow: `inset 0 0 0 1.5px ${directionColor(index)}` }} data-testid="direction-glyph" data-rotation={Math.round(rot)}>
      <ArrowUp size={14} strokeWidth={2.75} style={{ color: directionColor(index), transform: `rotate(${rot}deg)` }} aria-hidden />
    </span>
  );
};

const Metric: React.FC<{ label: string; value: React.ReactNode; sub?: React.ReactNode; title?: string; children?: React.ReactNode }> = ({ label, value, sub, title, children }) => (
  <div className="space-y-0.5" title={title}>
    <div className="flex items-baseline justify-between gap-1 text-[11px]">
      <span className="text-slate-500">{label}</span>
      <span className="tabular-nums text-slate-100 whitespace-nowrap">{value}{sub && <span className="text-slate-500"> {sub}</span>}</span>
    </div>
    {children}
  </div>
);

export const DirectionCard: React.FC<{ d: DirectionFlow; index: number; heading: number; active: boolean; dimmed: boolean; pinned: boolean; actions: Pick<AnalysisActions, 'hoverDirection' | 'pinDirection'> }> = ({ d, index, heading, active, dimmed, pinned, actions }) => {
  const labelDeg = d.labelBearingDeg ?? d.bearingDeg;
  const compass = d.compass ?? compassWord(labelDeg);
  const tone = losTone(d.los);
  return (
    <div
      role="button" tabIndex={0} aria-pressed={pinned}
      data-testid="direction-card" data-direction={index} data-active={active ? 'true' : 'false'}
      title={pinned ? 'Click again to show both directions alike' : 'Click to pick this direction out on the map and fly to it'}
      onMouseEnter={() => actions.hoverDirection(index)} onMouseLeave={() => actions.hoverDirection(null)}
      onFocus={() => actions.hoverDirection(index)} onBlur={() => actions.hoverDirection(null)}
      onClick={() => actions.pinDirection(index)}
      onKeyDown={e => { if (e.key === 'Enter' || e.key === ' ') { e.preventDefault(); actions.pinDirection(index); } }}
      className={`rounded-xl border p-2.5 space-y-2 cursor-pointer transition min-w-0 ${active ? 'bg-white/[0.06]' : 'border-white/5 bg-white/[0.03] hover:bg-white/[0.05]'} ${dimmed ? 'opacity-60' : ''}`}
      style={active ? { borderColor: directionColor(index) } : { borderTop: `2px solid ${directionColor(index)}99` }}
    >
      <div className="flex items-start gap-2">
        <DirectionGlyph index={index} bearingDeg={labelDeg} heading={heading} />
        <div className="min-w-0 flex-1">
          <div className="flex items-start justify-between gap-1">
            <div className="text-[13px] font-medium text-white leading-tight min-w-0" data-testid="direction-title">{capital(compass)}<span className="text-[11px] text-slate-500 font-normal tabular-nums whitespace-nowrap" title="Compass bearing of travel (on a road with two opposite directions, the axis they share)"> · {Math.round(labelDeg)}°</span></div>
            <LosBadge los={d.los} />
          </div>
          {d.towards && <div className="text-[11px] text-slate-400 leading-tight line-clamp-2 mt-0.5" data-testid="direction-landmark" title={`${landmarkPhrase(d.towards)}. ${d.towards.kind === 'into' ? 'The named road this direction carries on into' : 'The main road this direction meets at its end'}`}>{landmarkPhrase(d.towards)}</div>}
        </div>
      </div>
      <Metric label="Speed" value={d.meanSpeedKmh === null ? '—' : `${Math.round(d.meanSpeedKmh)}`} sub={`/ ${Math.round(d.freeSpeedKmh)} km/h`} title="Mean speed (runs' mean) against free-flow speed">
        <Meter value={d.meanSpeedKmh ?? 0} max={Math.max(1, d.freeSpeedKmh)} color={TONE_FILL[tone]} />
      </Metric>
      <Metric label="Load" value={`${Math.round(d.vc * 100)}%`} sub={`of ${fmt(d.capacityPcu)}`} title={`${Math.round(d.vc * 100)}% of capacity (${fmt(d.capacityPcu)} PCU/h ${d.capacityBasis === 'signal' ? 'at the signal at its end' : `mid-block, ${d.lanes} lane${d.lanes === 1 ? '' : 's'}`})`}>
        <Meter value={Math.min(1, d.vc)} color={vcColour(d.vc)} />
      </Metric>
      <div className="grid grid-cols-2 gap-1 text-[11px]">
        <div title="Vehicles per hour that got through in the simulation (mean of the runs), and the vehicles per hour the area routing sends along it">
          <div className="text-slate-500">Traffic</div>
          <div className="tabular-nums text-slate-100">{fmt(d.vph)}<span className="text-slate-500"> veh/h</span></div>
          <div className="tabular-nums text-slate-500">{fmt(d.demandVph)} routed</div>
        </div>
        <div title="Time to drive the section (mean of the runs) and its free-flow time">
          <div className="text-slate-500">Time</div>
          <div className="tabular-nums text-slate-100">{d.travelTimeS === null ? '—' : `${Math.round(d.travelTimeS)} s`}</div>
          <div className="tabular-nums text-slate-500">{Math.round(d.freeTimeS)} s free</div>
        </div>
      </div>
      {(d.los === 'E' || d.los === 'F') && d.vc < 0.85 && (
        <p className="text-[11px] text-amber-200/90 leading-snug" data-testid="slow-below-capacity" title="Slow although the road itself has room: the hold-up is further on, not its width (see Why).">Slow with room to spare: the hold-up is further on.</p>
      )}
    </div>
  );
};

export const DirectionsGrid: React.FC<{ r: RoadAnalysisResult; heading: number; focus: { hover: number | null; pinned: number | null }; actions: AnalysisActions }> = ({ r, heading, focus, actions }) => {
  const active = focus.hover ?? focus.pinned;
  return (
    <section className="space-y-2">
      <div className="flex items-baseline justify-between gap-2">
        <h3 className="text-xs font-semibold uppercase tracking-wide text-slate-400">Each direction</h3>
        <span className="text-[11px] text-slate-500" title="Arrows on the map show each direction in its colour; the arrow by each name points the way it runs on screen now. Click a card to pick it out on the map.">mean of {r.seeds.length} runs · hover to find on map</span>
      </div>
      <div className={`grid gap-2 ${r.directions.length === 1 ? 'grid-cols-1' : 'grid-cols-2'}`} data-testid="directions">
        {r.directions.map((d, i) => <DirectionCard key={d.label} d={d} index={i} heading={heading} active={active === i} dimmed={active !== null && active !== i} pinned={focus.pinned === i} actions={actions} />)}
      </div>
    </section>
  );
};

// ── Why ───────────────────────────────────────────────────────────────────

export const WhyCard: React.FC<{ r: RoadAnalysisResult; overlay: MapOverlay; actions: AnalysisActions }> = ({ r, overlay, actions }) => {
  const w = explainedDirection(r);
  const delay = w?.d.delay ?? null;
  const line = causeLine(r);
  const loadMessages = new Set(overloadedRuns(r).runs.map(l => l.message).filter(Boolean).concat(r.load.message ?? []));
  const reasons = r.reasons.filter(x => !loadMessages.has(x));
  return (
    <section className="space-y-2">
      <div className="flex items-baseline justify-between gap-2">
        <h3 className="text-xs font-semibold uppercase tracking-wide text-slate-400">Why</h3>
        {delay && w && <span className="text-[11px] text-slate-500 tabular-nums">{Math.round(delay.total)} s delay per vehicle · {dirName(w.d)}</span>}
      </div>
      <Card testId="cause" data={{ kind: r.cause.kind }}>
        <div className="flex items-start gap-2">
          {r.cause.kind === 'insufficient' ? <Search size={14} className="text-amber-300 mt-0.5 shrink-0" /> : <TrafficCone size={14} className="mt-0.5 shrink-0" style={{ color: TONE_FILL[line.tone] }} />}
          <p className="flex-1 text-sm text-slate-100 leading-snug" data-testid="cause-line">{line.text}</p>
          {line.agreement && <Chip tone="neutral" title="Runs in which the queue was traced to the same junction">{line.agreement}</Chip>}
        </div>
        {delay && delay.total > 3 && <StackedBar parts={delayParts(delay)} unit=" s" total={delay.total} testId="delay-breakdown" />}
        {r.cause.chain?.root && <Button size="sm" icon={MapIcon} variant={overlay === 'cause' ? 'primary' : 'secondary'} onClick={() => actions.setOverlay(overlay === 'cause' ? 'none' : 'cause')}>{overlay === 'cause' ? 'Hide the queue on the map' : 'Show the queue on the map'}</Button>}
        {(r.cause.text || reasons.length > 0) && (
          <Disclosure title="Explanation in full" tone="subtle" testId="cause-detail">
            {r.cause.text && <p className="text-slate-300">{r.cause.text}</p>}
            {reasons.length > 0 && <ul className="space-y-1 list-disc pl-4">{reasons.map((x, i) => <li key={i}>{x}</li>)}</ul>}
          </Disclosure>
        )}
      </Card>
    </section>
  );
};

// ── Demand against throughput ─────────────────────────────────────────────

/** One card, shown once, when more traffic is routed into the neighbourhood than its simulated junctions pass. */
export const LoadCard: React.FC<{ r: RoadAnalysisResult }> = ({ r }) => {
  const { runs, of, message } = overloadedRuns(r);
  if (!runs.length) return null;
  const majority = r.load.overloaded;
  const rows = (r.loadBySeed ?? [r.load]).map((l, i) => ({ l, seed: r.seeds[i] }));
  const waiting = Math.max(...runs.map(l => l.waitingToEnter));
  const capShare = Math.max(...runs.map(l => l.atVehicleLimit));
  const gridlock = Math.max(...runs.map(l => l.gridlockRemovalsVph));
  return (
    <Card tone={majority ? 'warn' : 'plain'} testId="load-warning" data={{ runs: String(runs.length) }}>
      <div className="flex items-start gap-2">
        <AlertTriangle size={15} className="text-amber-300 mt-0.5 shrink-0" />
        <div className="flex-1 min-w-0">
          <p className="text-sm text-amber-50 leading-snug">More traffic routed here than the junctions pass</p>
          <p className="text-[11px] text-slate-400">Volumes shown are what got through.</p>
        </div>
        <Chip tone={majority ? 'warn' : 'neutral'} title="Runs in which the simulated neighbourhood was overloaded">{runs.length}/{of} runs</Chip>
      </div>
      <div className="flex items-baseline gap-2">
        <span className="text-2xl font-semibold tabular-nums text-amber-200">{Math.round(100 * r.load.servedShare)}%</span>
        <span className="text-xs text-slate-400">of routed traffic got onto its roads{of > 1 ? ` (mean of ${of} runs)` : ''}</span>
      </div>
      <ul className="space-y-1" data-testid="load-runs">
        {rows.map(({ l, seed }, i) => (
          <li key={i} className="grid grid-cols-[3.5rem_1fr_auto] items-center gap-2 text-[11px]" title={`Seed ${seed}: ${fmt(l.enteredVph)} of ${fmt(l.demandVph)} veh/h routed into the neighbourhood got onto its roads`}>
            <span className="text-slate-500">seed {seed}</span>
            <Meter value={l.enteredVph} max={Math.max(1, l.demandVph)} color={l.overloaded ? '#fbbf24' : '#34d399'} height="md" />
            <span className="tabular-nums text-slate-300 whitespace-nowrap">{fmt(l.enteredVph)} <span className="text-slate-500">/ {fmt(l.demandVph)}</span></span>
          </li>
        ))}
      </ul>
      <div className="flex flex-wrap gap-1.5">
        {waiting > 0 && <Chip tone="neutral" title="Vehicles still queued at the edge of the neighbourhood at the end of the run (largest over the overloaded runs)">{fmt(waiting)} queued at edge</Chip>}
        {capShare > 0.05 && <Chip tone="neutral" title="Share of the run spent at the simulator's vehicle limit (largest over the overloaded runs)">{Math.round(100 * capShare)}% at vehicle limit</Chip>}
        {gridlock > 0 && <Chip tone="neutral" title="Vehicles per hour removed after gridlock (largest over the overloaded runs)">{fmt(gridlock)} veh/h removed (gridlock)</Chip>}
      </div>
      <InfoToggle label="Model limit: what this means" testId="load-info">
        {message && <p>{message}</p>}
        {!majority && <p>Only {runs.length} of {of} runs were overloaded, so the result is not reported as capacity-limited overall.</p>}
      </InfoToggle>
    </Card>
  );
};

// ── Where the traffic comes from ──────────────────────────────────────────

const PlaceBars: React.FC<{ title: string; icon: typeof ArrowDownRight; places: RoadAnalysisResult['origins']; actions: AnalysisActions }> = ({ title, icon: Icon, places, actions }) => (
  <div className="space-y-1.5">
    <p className="text-[11px] font-semibold text-slate-400 flex items-center gap-1"><Icon size={12} />{title}</p>
    <ul className="space-y-1.5">
      {places.slice(0, 3).map(p => (
        <li key={p.label} className="space-y-0.5">
          <div className="flex items-baseline justify-between gap-2 text-[11px]">
            <button className="text-left text-slate-300 hover:text-white cursor-pointer leading-tight" title={`${p.label} (${fmt(p.vph)} veh/h). Click to fly there.`} onClick={() => actions.flyTo(p.coordinates)}>{p.label}</button>
            <span className="tabular-nums text-slate-200 shrink-0">{Math.round(p.share * 100)}%</span>
          </div>
          <Meter value={p.share} color={p.edge ? '#a78bfa' : '#22d3ee'} height="xs" />
        </li>
      ))}
    </ul>
  </div>
);

export const SourcesCard: React.FC<{ r: RoadAnalysisResult; overlay: MapOverlay; actions: AnalysisActions }> = ({ r, overlay, actions }) => {
  const through = Math.round(100 * r.composition.throughShare);
  return (
    <section className="space-y-2">
      <h3 className="text-xs font-semibold uppercase tracking-wide text-slate-400">Where its traffic comes from</h3>
      <Card testId="sources">
        <div className="space-y-1" title="Of the traffic routed over the road: share that starts and ends beyond the area (through), and share with one end inside it (local)">
          <div className="flex h-3 rounded-full overflow-hidden bg-white/10"><div className="bg-violet-400" style={{ width: `${through}%` }} /><div className="bg-cyan-400" style={{ width: `${100 - through}%` }} /></div>
          <div className="flex justify-between text-[11px]"><span className="text-violet-300"><strong className="tabular-nums">{through}%</strong> through</span><span className="text-cyan-300"><strong className="tabular-nums">{100 - through}%</strong> local</span></div>
        </div>
        <div className="space-y-3">
          <PlaceBars title="Comes from" icon={ArrowDownRight} places={r.origins} actions={actions} />
          <PlaceBars title="Goes to" icon={ArrowUpRight} places={r.destinations} actions={actions} />
        </div>
        <Button size="sm" icon={MapIcon} variant={overlay === 'select-link' ? 'primary' : 'secondary'} onClick={() => actions.setOverlay(overlay === 'select-link' ? 'none' : 'select-link')}>{overlay === 'select-link' ? 'Hide routes' : 'Show its routes on the map'}</Button>
      </Card>
    </section>
  );
};

// ── Worst places in the area ──────────────────────────────────────────────

export const BottlenecksCard: React.FC<{ r: RoadAnalysisResult; overlay: MapOverlay; actions: AnalysisActions }> = ({ r, overlay, actions }) => {
  // One scale for the list, at least to 150%, so the ranking stays visible beyond capacity; the line marks 100%
  const vcMax = Math.max(1.5, ...r.areaBottlenecks.slice(0, 4).map(b => b.vc));
  return (
  <section className="space-y-2">
    <div className="flex items-baseline justify-between gap-2">
      <h3 className="text-xs font-semibold uppercase tracking-wide text-slate-400">Worst places in the area</h3>
      <Chip tone={r.assignment.overCapacityLinks > 0 ? 'bad' : 'good'} title="Road stretches in the study area whose routed traffic exceeds capacity (area assignment)">{fmt(r.assignment.overCapacityLinks)} over capacity</Chip>
    </div>
    <Card testId="bottlenecks">
      {r.areaBottlenecks.length === 0 ? <p className="text-xs text-slate-400">No road in the area is over 90% of its capacity at this hour.</p> : (
        <ol className="space-y-2">
          {r.areaBottlenecks.slice(0, 4).map((b, i) => (
            <li key={b.label} className="grid grid-cols-[1.25rem_1fr_auto] items-start gap-2">
              <span className="mt-px inline-flex h-5 w-5 items-center justify-center rounded-full bg-white/[0.06] text-[10px] font-semibold text-slate-300">{i + 1}</span>
              <div className="min-w-0 space-y-1">
                <div className="flex items-baseline justify-between gap-2 text-[11px]">
                  <span className="text-slate-200 leading-tight line-clamp-2" title={`${b.label}. ${Math.round(b.delayVehH)} vehicle-hours of extra delay`}>{b.label}</span>
                  <span className="tabular-nums shrink-0" style={{ color: vcColour(b.vc) }}>{Math.round(b.vc * 100)}%</span>
                </div>
                <Meter value={b.vc} max={vcMax} marker={1} color={vcColour(b.vc)} title={`${Math.round(b.vc * 100)}% of capacity (the line marks 100%)`} />
              </div>
              <button className="p-1 -m-1 rounded text-slate-400 hover:text-cyan-200 hover:bg-white/5 cursor-pointer" title="Show on map" aria-label={`Show ${b.roadName} on the map`} onClick={() => actions.flyTo(b.coordinates)}><MapPin size={14} /></button>
            </li>
          ))}
        </ol>
      )}
      <div className="flex items-center gap-2 flex-wrap">
        <Button size="sm" icon={Gauge} variant={overlay === 'area-vc' ? 'primary' : 'secondary'} onClick={() => actions.setOverlay(overlay === 'area-vc' ? 'none' : 'area-vc')}>{overlay === 'area-vc' ? 'Hide load map' : 'Show how full every road is'}</Button>
        {overlay === 'area-vc' && <span className="flex flex-wrap gap-x-2 text-[11px] text-slate-400">{VC_BANDS.map(b => <span key={b.label} className="inline-flex items-center gap-1"><span className="h-2 w-2 rounded-full" style={{ background: b.css }} />{b.label}</span>)}</span>}
      </div>
      <InfoToggle label="How this is ranked">
        <p>From routing all of the area's demand (volume over capacity per stretch), ranked by the extra vehicle-hours each causes. Queues are not modelled at this level; the selected road's neighbourhood is simulated for that.</p>
      </InfoToggle>
    </Card>
  </section>
  );
};

// ── Suggestions ───────────────────────────────────────────────────────────

const KIND_ICON: Record<Suggestion['kind'], typeof Hammer> = { junction: Split, signal: Signal, widen: Construction, divert: Users, investigate: Search, none: CheckCircle2, times: CheckCircle2 };
/** Suggestions that are a change to make and compare (not an investigation or "no problem"). */
const TESTABLE = new Set<Suggestion['kind']>(['junction', 'signal', 'widen', 'divert']);
const KIND_TONE: Record<Suggestion['kind'], Tone> = { junction: 'info', signal: 'info', widen: 'info', divert: 'info', investigate: 'warn', none: 'good', times: 'good' };

/** A suggestion as a card: what to try, its headline number, and the actions. Full shows the evidence and what to check. */
export const SuggestionCard: React.FC<{ s: Suggestion; full?: boolean; onTest?: () => void; actions: Pick<AnalysisActions, 'editInBuild'> }> = ({ s, full, onTest, actions }) => {
  const Icon = KIND_ICON[s.kind];
  const tone = KIND_TONE[s.kind];
  return (
    <li className="rounded-xl border border-white/10 bg-white/[0.03] p-2.5 space-y-2" data-testid="suggestion" data-kind={s.kind}>
      <div className="flex items-start gap-2">
        <span className="inline-flex h-7 w-7 shrink-0 items-center justify-center rounded-lg" style={{ background: `${TONE_FILL[tone]}22`, color: TONE_FILL[tone] }}><Icon size={15} /></span>
        <div className="min-w-0 flex-1">
          <p className="text-sm font-medium text-white leading-snug">{s.title}</p>
          {s.figure && <p className="text-[11px] text-slate-400 leading-snug mt-0.5"><strong className="text-sm text-cyan-200 tabular-nums mr-1">{s.figure.value}</strong>{s.figure.label}</p>}
        </div>
      </div>
      {full && <p className="text-xs text-slate-300 leading-snug">{s.why}</p>}
      {full ? (
        <Disclosure title="Evidence" tone="subtle"><p>{s.evidence}</p></Disclosure>
      ) : !s.figure && <p className="text-[11px] text-slate-400 leading-snug line-clamp-2" title={s.evidence}>{s.evidence}</p>}
      {((onTest && (TESTABLE.has(s.kind) || s.kind === 'times')) || s.action) && (
        <div className="flex gap-1.5 flex-wrap">
          {onTest && TESTABLE.has(s.kind) && <Button size="sm" variant="primary" onClick={onTest} title="Go to Improve & compare: save the existing city, make the change in Build, then compare">Test it<ChevronRight size={13} /></Button>}
          {onTest && s.kind === 'times' && <Button size="sm" variant="secondary" onClick={onTest} title="Go to Improve & compare, where the road can be analysed at other times of day">Other times of day<ChevronRight size={13} /></Button>}
          {s.action && <Button size="sm" variant={onTest ? 'secondary' : 'secondary'} icon={Hammer} onClick={() => actions.editInBuild(s.action!.roadIds, s.action!.at)}>{s.action.label}</Button>}
        </div>
      )}
    </li>
  );
};

// ── Per-run detail ────────────────────────────────────────────────────────

export const PerRunDetail: React.FC<{ r: RoadAnalysisResult }> = ({ r }) => (
  <Disclosure title="Per-run detail" icon={ListOrdered} testId="per-run" aside={`${r.seeds.length} seeds`}>
    <table className="w-full tabular-nums">
      <thead><tr className="text-slate-500"><th className="text-left font-medium">Seed</th><th className="text-right font-medium" title="Vehicles per hour through the road, both directions">veh/h</th><th className="text-right font-medium" title="Time to drive it, mean of the directions">Time</th><th className="text-right font-medium" title="Share of routed traffic that got onto the neighbourhood's roads">Got on</th><th className="text-right font-medium" title="Worst junction delay at the road's ends">End delay</th><th className="text-right font-medium">Status</th></tr></thead>
      <tbody>{r.perSeed.map((s, i) => (
        <tr key={s.seed} className="border-t border-white/5">
          <td className="py-1">{s.seed}</td><td className="text-right">{fmt(s.sectionVph)}</td><td className="text-right">{s.sectionTimeS === null ? '—' : `${Math.round(s.sectionTimeS)} s`}</td>
          <td className="text-right">{Math.round(100 * s.servedShare)}%</td><td className="text-right">{s.endDelayS === null ? '—' : `${Math.round(s.endDelayS)} s`}</td><td className="text-right">{r.statusBySeed[i] ? STATUS[r.statusBySeed[i]].short : ''}</td>
        </tr>
      ))}</tbody>
    </table>
    {r.directions.map((d, i) => (
      <p key={d.label}><span className="inline-block h-2 w-2 rounded-full mr-1" style={{ background: directionColor(i) }} /><span className="text-slate-300">{capital(d.label)}</span>: {fmt(d.vphRange[0])}–{fmt(d.vphRange[1])} veh/h got through (routed {fmt(d.demandVph)}){d.speedRange ? `; speed ${Math.round(d.speedRange[0])}–${Math.round(d.speedRange[1])} km/h` : ''}; level of service by run {d.losBySeed.map(x => x ?? '—').join(' / ')}.</p>
    ))}
    <p className="text-slate-500">Each run simulates the neighbourhood with its own random seed after a 5-minute warm-up and counts {Math.round(r.windowS / 60)} minutes; the panel shows their mean.</p>
  </Disclosure>
);

export const MethodNote: React.FC<{ onDetails?: () => void }> = ({ onDetails }) => (
  <p className="flex items-center gap-1.5 text-[11px] text-slate-500"><Info size={12} />Methodology, assumptions and data sources are under {onDetails ? <button className="text-cyan-300 hover:text-cyan-200 cursor-pointer" onClick={onDetails}>Details</button> : 'Details'}.</p>
);

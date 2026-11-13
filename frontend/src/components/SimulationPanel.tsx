import React, { useState } from 'react';
import {
  MousePointerClick, Pause, Play, RotateCcw, Square, Loader2, AlertTriangle, AlertOctagon, CheckCircle2, Maximize2, Eye, Hammer, ChevronDown, Crosshair, X, Info,
} from 'lucide-react';
import { engineInstance } from '../engine/TwinCityEngine';
import { useSimulationMode } from '../hooks/useSimulationMode';
import {
  STUDY_DISTANCES_M, TRAFFIC_SPEEDS, DAY_PERIODS, periodOfHour, type SimulationModeState, type TrafficRunState, type SignalsState, type DayPeriodId,
} from '../engine/simulation/SimulationMode';
import type { StudyProblem } from '../engine/simulation/StudyAreaExplorer';
import { GRIDLOCK_S, VEHICLE_TYPES } from '../engine/simulation/TrafficMicroSim';
import { URBAN_DEFAULT_SPEED_KMH, URBAN_SPEED_CEILING_KMH } from '../engine/simulation/roadParameters';
import { BPR_ALPHA, BPR_BETA } from '../engine/simulation/staticAssignment';
import { CORRIDOR_RANGE_M } from '../engine/simulation/analysisJob';
import { SPEED_COLORS } from '../engine/rendering/renderers/MicroTrafficVisualizer';
import { formatDistanceM } from '../lib/format';
import { hourLabel } from '../engine/simulation/timeOfDay';
import { SidePanel, PanelHeader, PanelBody, Section, Figure, Button, Segmented, Notice } from './ui/kit';
import { UnderstandView, ImproveView, DemandEvidence } from './RoadAnalysisPanel';
import { openSimulateDrawer, type SimulateDrawerTabId } from '../shell/contexts/SimulateDrawerNav';

const roadName = (id: string) => engineInstance.objects.getById(id)?.name || 'Unnamed road';

const formatClock = (s: number) => {
  const m = Math.floor(s / 60), sec = Math.floor(s % 60);
  return `${m}:${String(sec).padStart(2, '0')}`;
};

const DISTANCE_OPTIONS = STUDY_DISTANCES_M.map(m => ({ value: m, label: formatDistanceM(m) }));
const SPEED_OPTIONS = TRAFFIC_SPEEDS.map(s => ({ value: s, label: `${s}×` }));
const PERIOD_OPTIONS = DAY_PERIODS.map(p => ({ value: p.id as DayPeriodId, label: p.label }));

type Tab = 'understand' | 'improve' | 'details';
const TABS: { id: Tab; label: string; hint: string }[] = [
  { id: 'understand', label: '1 · What\'s wrong', hint: 'Conditions, bottlenecks and their causes' },
  { id: 'improve', label: '2 · Improve & compare', hint: 'Options to test, before and after' },
  { id: 'details', label: 'Details', hint: 'Demand, assumptions, checks against counts' },
];

/**
 * Simulate: pick a road; read what is wrong with it and why; test changes
 * and compare them with the existing city. The controls that run things
 * (time of day, the live view) sit above the tabs and stay in view.
 */
export const SimulationPanel: React.FC = () => {
  const sim = useSimulationMode();
  const mode = engineInstance.simMode;
  const hasRoad = sim.seedRoadIds.length > 0;
  const [tab, setTab] = useState<Tab>('understand');

  return (
    <SidePanel label="Simulate traffic" wide>
      <PanelHeader
        title={hasRoad ? (sim.section?.name ?? sim.seedRoadIds.map(roadName).join(' + ')) : 'Study a road'}
        subtitle={hasRoad ? `${sim.section ? `${formatDistanceM(sim.section.lengthM)}${sim.section.carriageways === 2 ? ', both carriageways' : ''} · ` : ''}area ${formatDistanceM(sim.rangeMeters)} around it` : 'Click a road, bridge or flyover on the map'}
        onBack={hasRoad ? () => mode.clearSeeds() : undefined}
        backLabel="Choose another road"
        onClose={() => engineInstance.setAppMode('view')}
        closeLabel="Close Simulate (stops all simulation)"
      />
      {hasRoad && sim.area && <RunBar sim={sim} />}
      {hasRoad && sim.area && (
        <nav role="tablist" aria-label="Study steps" className="flex border-b border-white/10 px-2 shrink-0">
          {TABS.map(t => (
            <button key={t.id} role="tab" aria-selected={tab === t.id} title={t.hint} onClick={() => setTab(t.id)}
              className={`flex-auto whitespace-nowrap px-2 py-2 text-[13px] font-medium border-b-2 -mb-px cursor-pointer transition ${tab === t.id ? 'border-cyan-400 text-white' : 'border-transparent text-slate-400 hover:text-slate-200'}`}>
              {t.label}
            </button>
          ))}
        </nav>
      )}
      <PanelBody>
        {sim.notice && <Notice tone="info" icon={Info} action={<button aria-label="Dismiss" className="text-cyan-200 hover:text-white cursor-pointer" onClick={() => mode.dismissNotice()}><X size={14} /></button>}>{sim.notice}</Notice>}
        {!hasRoad ? <PickRoad sim={sim} /> : <Study sim={sim} tab={tab} setTab={setTab} />}
      </PanelBody>
    </SidePanel>
  );
};

const PickRoad: React.FC<{ sim: SimulationModeState }> = ({ sim }) => {
  const mode = engineInstance.simMode;
  return (
    <>
      <div className="rounded-2xl border border-dashed border-cyan-400/30 bg-cyan-500/5 px-4 py-5 text-center space-y-2">
        <MousePointerClick size={28} className="mx-auto text-cyan-300" />
        <p className="text-base font-semibold text-white">Click a road on the map</p>
        <p className="text-sm text-slate-300 leading-relaxed">
          Any road, bridge or flyover. You will see how well it works at different times of day, where its traffic comes from, what holds it up, and what a change would do.
        </p>
        <p className="text-xs text-slate-500">Shift+click adds more roads, for a corridor.</p>
      </div>
      <Section title="How much of the city around it">
        <Segmented label="Distance around the road" options={DISTANCE_OPTIONS} value={sim.rangeMeters as (typeof STUDY_DISTANCES_M)[number]} onChange={m => mode.setRange(m)} />
        <p className="text-xs text-slate-500">Traffic is routed over every road within this distance; the road's own neighbourhood ({formatDistanceM(CORRIDOR_RANGE_M)}) is simulated vehicle by vehicle.</p>
      </Section>
    </>
  );
};

/** Always-visible controls: which time of day, and the live view (start, pause, resume, restart, stop, speed). */
const RunBar: React.FC<{ sim: SimulationModeState }> = ({ sim }) => {
  const mode = engineInstance.simMode;
  const t = sim.traffic, a = sim.analysis;
  const period = periodOfHour(sim.timeOfDay.hour);
  const waiting = sim.osmRoads.status === 'loading' ? 'Loading roads…' : sim.signals.status === 'loading' ? 'Loading signals…' : null;
  return (
    <div className="px-4 py-3 border-b border-white/10 space-y-2.5 shrink-0 bg-slate-950/60" data-testid="run-bar">
      <div className="space-y-1">
        <div className="flex items-baseline justify-between text-xs"><span className="font-semibold uppercase tracking-wide text-slate-400">When</span>
          <span className="text-slate-500 tabular-nums">{hourLabel(sim.timeOfDay.hour)}{period ? '' : ' (custom hour)'} · {sim.timeOfDay.day}</span></div>
        <div role="radiogroup" aria-label="Time of day" className="grid grid-cols-4 gap-1 rounded-xl bg-white/[0.04] border border-white/10 p-1">
          {PERIOD_OPTIONS.map(o => (
            <button key={o.value} role="radio" aria-checked={o.value === period} onClick={() => mode.setPeriod(o.value)}
              className={`rounded-lg px-1 py-1.5 text-xs font-medium transition cursor-pointer ${o.value === period ? 'bg-white text-slate-950 shadow' : 'text-slate-300 hover:text-white'}`}>{o.label}</button>
          ))}
        </div>
        {sim.timeOfDay.status === 'error' && (
          <p className="text-[11px] text-amber-300/90" data-testid="time-profile-missing">
            Hour-of-day profile not loaded: demand is the peak hour's (×1), whatever the hour. <button className="underline cursor-pointer" onClick={() => void mode.ensureTimeProfile()}>Retry</button>
          </p>
        )}
      </div>
      <div className="flex items-center gap-2 flex-wrap" data-testid="live-controls">
        <LiveStatus traffic={t} />
        <div className="ml-auto flex gap-1.5">
          {t.status === 'idle' && <Button size="sm" variant="primary" icon={waiting ? Loader2 : Play} spin={!!waiting} disabled={!!waiting} onClick={() => mode.startTraffic()} title="Simulate and show the traffic around this road, starting from a 5-minute warm-up">{waiting ?? 'Watch live traffic'}</Button>}
          {t.status === 'running' && <Button size="sm" icon={Pause} onClick={() => mode.pauseTraffic()}>Pause</Button>}
          {t.status === 'paused' && <Button size="sm" variant="primary" icon={Play} onClick={() => mode.resumeTraffic()}>Resume</Button>}
          {(t.status === 'running' || t.status === 'paused') && <Button size="sm" icon={RotateCcw} onClick={() => mode.restartTraffic()} title="Clear the vehicles and start again from the warm-up">Restart</Button>}
          {t.status !== 'idle' && <Button size="sm" icon={Square} onClick={() => mode.stopTraffic()} title="Stop the live view and release it">Stop</Button>}
        </div>
      </div>
      {(t.status === 'running' || t.status === 'paused') && (
        <div className="grid grid-cols-[auto_1fr] items-center gap-x-3">
          <span className="text-xs text-slate-400">Speed</span>
          <Segmented label="Playback speed" options={SPEED_OPTIONS} value={t.speed as (typeof TRAFFIC_SPEEDS)[number]} onChange={s => mode.setTrafficSpeed(s)} />
        </div>
      )}
      {t.error && <p className="text-xs text-amber-300">{t.error}</p>}
      {a.status === 'running' && <p className="text-xs text-cyan-200 flex items-center gap-1.5" role="status"><Loader2 size={12} className="animate-spin" />Analysing {hourLabel(sim.timeOfDay.hour)}: {Math.round(a.progress * 100)}% ({mode.analysisSeeds.length} runs)</p>}
    </div>
  );
};

const LiveStatus: React.FC<{ traffic: TrafficRunState }> = ({ traffic: t }) => {
  const dot = t.status === 'running' ? 'bg-emerald-400 animate-pulse' : t.status === 'paused' ? 'bg-amber-400' : t.status === 'preparing' ? 'bg-cyan-400 animate-pulse' : 'bg-slate-500';
  const text = t.status === 'running' ? `Live · ${t.metrics ? formatClock(t.metrics.timeS - t.warmupS) : '0:00'} shown`
    : t.status === 'paused' ? `Paused · ${t.metrics ? formatClock(t.metrics.timeS - t.warmupS) : ''}`
    : t.status === 'preparing' ? (t.preparing?.stage === 'analysis' ? `Waiting for the analysis ${Math.round(100 * (t.preparing?.progress ?? 0))}%` : `Warming up ${Math.round(100 * (t.preparing?.progress ?? 0))}%`)
    : 'Live view off';
  return <span className="inline-flex items-center gap-1.5 text-xs text-slate-300" data-testid="live-status" data-status={t.status}><span className={`h-2 w-2 rounded-full ${dot}`} />{text}</span>;
};

const Study: React.FC<{ sim: SimulationModeState; tab: Tab; setTab: (t: Tab) => void }> = ({ sim, tab, setTab }) => {
  const mode = engineInstance.simMode;
  const { area, osmRoads } = sim;
  return (
    <>
      {osmRoads.status === 'loading' && (
        <Notice icon={Loader2} spin action={<Button variant="ghost" size="sm" onClick={() => mode.cancelOsmRoads()}>Cancel</Button>}>
          Checking the roads around this area against OpenStreetMap and adding any that are missing.
        </Notice>
      )}
      {osmRoads.status === 'error' && (
        <Notice tone="warn" icon={AlertTriangle} action={<Button variant="ghost" size="sm" onClick={() => mode.retryOsmRoads()}>Retry</Button>}>
          Some roads around this area could not be loaded, so it may stop short. {osmRoads.error}
        </Notice>
      )}
      {sim.error && <Notice tone="bad" icon={AlertOctagon}>{sim.error}</Notice>}
      {area && tab === 'understand' && <UnderstandView sim={sim} goImprove={() => setTab('improve')} goDetails={() => setTab('details')} />}
      {area && tab === 'improve' && <ImproveView sim={sim} onThroughTheDay={() => openSimulateDrawer('day')} />}
      {area && tab === 'details' && <DetailsView sim={sim} />}
    </>
  );
};

/** An optional section, closed until opened (pass open to start it open). Only used under Details. */
const Advanced: React.FC<{ title: string; children: React.ReactNode; open?: boolean }> = ({ title, children, open }) => (
  <details className="group rounded-xl border border-white/10 bg-white/[0.02]" open={open}>
    <summary className="flex cursor-pointer items-center justify-between px-3 py-2 text-sm text-slate-300 hover:text-white list-none">
      {title}<ChevronDown size={15} className="transition group-open:rotate-180" />
    </summary>
    <div className="space-y-3 border-t border-white/5 px-3 py-3">{children}</div>
  </details>
);

const DetailsView: React.FC<{ sim: SimulationModeState }> = ({ sim }) => {
  const mode = engineInstance.simMode;
  const { area, traffic, signals, osmRoads } = sim;
  if (!area) return null;
  return (
    <div className="space-y-2">
      <p className="text-xs text-slate-400 leading-relaxed">Everything behind the figures, closed until opened. Nothing here is needed to read the results.</p>
      <DrawerLinks />
      <Advanced title="Assumptions & data sources: the demand">
        <DemandEvidence sim={sim} />
      </Advanced>
      <Advanced title="Live view figures">
        <VehicleInspector sim={sim} />
        {traffic.metrics ? <LiveFigures traffic={traffic} seedRoadIds={sim.seedRoadIds} /> : <p className="text-xs text-slate-500">Start the live view to see its figures. The results in the other tabs come from the repeatable analysis, not from the animation.</p>}
      </Advanced>
      <Advanced title="Study area, signals and network checks">
        <div className="flex items-center justify-between gap-2 text-sm text-slate-300">
          <span><strong className="text-white tabular-nums">{area.stats.roads.toLocaleString()}</strong> roads · <strong className="text-white tabular-nums">{area.stats.entries}</strong> ways in · <strong className="text-white tabular-nums">{area.stats.exits}</strong> ways out</span>
          <span className="flex gap-0.5">
            <button onClick={() => mode.focusView()} title="Close in on the selected road" aria-label="Close in on the selected road" className="p-1.5 rounded-lg text-slate-400 hover:text-white hover:bg-white/5 cursor-pointer"><Crosshair size={16} /></button>
            <button onClick={() => mode.fitView()} title="Fit the area in view" aria-label="Fit the area in view" className="p-1.5 rounded-lg text-slate-400 hover:text-white hover:bg-white/5 cursor-pointer"><Maximize2 size={16} /></button>
          </span>
        </div>
        <Section title="Distance around the road">
          <Segmented label="Distance around the road" options={DISTANCE_OPTIONS} value={sim.rangeMeters as (typeof STUDY_DISTANCES_M)[number]} onChange={m => mode.setRange(m)} />
        </Section>
        {sim.corridor && <p className="text-xs text-slate-500">Simulated vehicle by vehicle: {sim.corridor.stats.roads.toLocaleString()} roads within {formatDistanceM(sim.corridor.rangeMeters)} of the selected road.</p>}
        <SignalsNote signals={signals} />
        {sim.speeds && <p className="text-xs text-slate-500">Free-flow speeds: {sim.speeds.tagged.toLocaleString()} roads from their OSM speed limit, {sim.speeds.inherited.toLocaleString()} from another piece of the same road, {sim.speeds.urbanDefault.toLocaleString()} from urban defaults (at most {URBAN_SPEED_CEILING_KMH} km/h).</p>}
        <NetworkChecks problems={area.problems} provisional={osmRoads.status === 'loading'} />
      </Advanced>
      <Advanced title="How this is calculated">
        <Assumptions seeds={mode.analysisSeeds} />
      </Advanced>
    </div>
  );
};

const DRAWER_LINKS: { id: SimulateDrawerTabId; label: string }[] = [
  { id: 'calibration', label: 'Calibration' }, { id: 'odme', label: 'ODME' }, { id: 'emissions', label: 'Emissions' },
  { id: 'counts', label: 'Count checks' }, { id: 'day', label: 'Through the day' },
];

/** The checks against counts, ODME, emissions and the day profile live in the bottom drawer (rendered once, there). */
const DrawerLinks: React.FC = () => (
  <div className="rounded-xl border border-white/10 bg-white/[0.02] px-3 py-2 space-y-1.5" data-testid="details-drawer-links">
    <p className="text-xs text-slate-400">Checks and estimates, in the drawer below the map:</p>
    <div className="flex flex-wrap gap-1">
      {DRAWER_LINKS.map(l => <Button key={l.id} size="sm" variant="ghost" onClick={() => openSimulateDrawer(l.id)}>{l.label}</Button>)}
    </div>
  </div>
);

const SignalsNote: React.FC<{ signals: SignalsState }> = ({ signals }) => {
  if (signals.status === 'off') return null;
  const text =
    signals.status === 'loading' ? 'Loading the real traffic signals from OpenStreetMap…'
    : signals.status === 'error' ? 'OpenStreetMap could not be reached, so signals are placed where two main roads cross.'
    : signals.count === 0 ? 'No signals mapped in OpenStreetMap here. Your placed junction controls take precedence.'
    : `${signals.count} mapped traffic signal${signals.count === 1 ? '' : 's'} found. Your placed junction controls take precedence.`;
  return <p className={`text-xs ${signals.status === 'error' ? 'text-amber-300/80' : 'text-slate-500'}`}>{text}</p>;
};

const VehicleInspector: React.FC<{ sim: SimulationModeState }> = ({ sim }) => {
  if (sim.selectedVehicleId === null) return <p className="text-xs text-slate-500">While the live view runs, click a vehicle to inspect it.</p>;
  const mode = engineInstance.simMode;
  const vehicle = mode.inspectVehicle(sim.selectedVehicleId);
  return <section className="rounded-xl border border-cyan-400/25 bg-cyan-500/5 p-3 space-y-2">
    <div className="flex justify-between items-center"><span className="text-sm font-semibold text-cyan-100">{vehicle ? vehicle.kind.replaceAll('_', ' ') : 'Vehicle'} #{sim.selectedVehicleId}</span><button aria-label="Close vehicle inspector" onClick={() => mode.selectVehicle(null)} className="cursor-pointer text-slate-400 hover:text-white"><X size={15} /></button></div>
    {vehicle ? <><p className="text-xs text-slate-300">{Math.round(vehicle.speedKmh)} km/h · {Math.round(vehicle.speedRatio * 100)}% of the road's free-flow speed · {vehicle.focus ? 'uses the selected road' : 'other traffic'}</p><Button size="sm" variant="ghost" icon={Crosshair} onClick={() => mode.flyTo([vehicle.lng, vehicle.lat, vehicle.z])}>Locate vehicle</Button></> : <p className="text-xs text-slate-400">This vehicle has left the simulated neighbourhood.</p>}
  </section>;
};

const LiveFigures: React.FC<{ traffic: TrafficRunState; seedRoadIds: string[] }> = ({ traffic, seedRoadIds }) => {
  const m = traffic.metrics!;
  return (
    <>
      <Section title="Simulated neighbourhood, now">
        <div className="grid grid-cols-2 gap-2">
          <Figure label="Vehicles on the roads" value={m.onNetwork.toLocaleString()} hint={m.waitingToEnter > 0 ? `${m.waitingToEnter.toLocaleString()} queued at its edge` : undefined} tone={m.waitingToEnter > 50 ? 'warn' : undefined} />
          <Figure label="Average speed" value={m.meanSpeedKmh === null ? '—' : `${Math.round(m.meanSpeedKmh)} km/h`} />
          <Figure label="Trips completed" value={m.completedTrips.toLocaleString()} hint="since the warm-up began" />
          <Figure label="Mean trip time" value={m.meanTravelTimeS === null ? '—' : `${Math.round(m.meanTravelTimeS)} s`} />
        </div>
      </Section>
      <Section title={seedRoadIds.length === 1 ? 'On the selected road now' : 'On the selected roads now'}>
        <div className="grid grid-cols-2 gap-2">
          <Figure label="Vehicles on it" value={m.watched.onRoad.toLocaleString()} />
          <Figure label="Their speed" value={m.watched.meanSpeedKmh === null ? '—' : `${Math.round(m.watched.meanSpeedKmh)} km/h`} />
        </div>
      </Section>
      <div className="flex flex-wrap gap-x-4 gap-y-1 text-xs text-slate-400">
        <span className="text-slate-500">Road colour:</span>
        <Dot color={SPEED_COLORS.free} label="Moving freely" /><Dot color={SPEED_COLORS.slow} label="Slow" /><Dot color={SPEED_COLORS.stopped} label="Stopped" />
      </div>
      {m.accounting && <p className="text-[11px] text-slate-500 tabular-nums" data-testid="live-accounting">Since the warm-up began: {m.accounting.spawned.toLocaleString()} entered = {(m.accounting.exitedAtEdge + m.accounting.completedAtDestination).toLocaleString()} finished + {m.accounting.stuckRemovals.toLocaleString()} removed + {m.accounting.inNetwork.toLocaleString()} on the roads.</p>}
      {(m.accounting?.gridlockedNow ?? 0) > 0 && <Notice tone="warn" icon={AlertTriangle}>{m.accounting.gridlockedNow} vehicle{m.accounting.gridlockedNow > 1 ? 's are' : ' is'} gridlocked: stuck over {GRIDLOCK_S / 60} minutes at the front of a queue{m.accounting.stuckRemovalEnabled ? '' : ' (left on the roads, not removed)'}.</Notice>}
      {m.gridlockRemovals > 0 && <Notice tone="warn" icon={AlertTriangle}>{m.gridlockRemovals} vehicle{m.gridlockRemovals > 1 ? 's were' : ' was'} removed after being stuck for {GRIDLOCK_S / 60} minutes.</Notice>}
    </>
  );
};

const Dot: React.FC<{ color: string; label: string }> = ({ color, label }) => (
  <span className="inline-flex items-center gap-1.5"><span className="w-2.5 h-2.5 rounded-full" style={{ background: color }} />{label}</span>
);

const NetworkChecks: React.FC<{ problems: StudyProblem[]; provisional: boolean }> = ({ problems, provisional }) => {
  const [open, setOpen] = useState(false);
  const shown = problems.filter(p => p.severity !== 'info');
  if (shown.length === 0) return <Notice tone="good" icon={CheckCircle2}>{provisional ? 'No connection problems found so far.' : 'No connection problems found by the network checks.'}</Notice>;
  return (
    <section className="rounded-xl border border-amber-400/20 bg-amber-500/5">
      <button onClick={() => setOpen(o => !o)} aria-expanded={open} className="w-full flex items-center gap-2.5 px-3 py-2.5 text-left cursor-pointer">
        <AlertTriangle size={16} className="text-amber-300 shrink-0" />
        <span className="flex-1 text-sm text-amber-100">{shown.length} connection problem{shown.length > 1 ? 's' : ''} to check{provisional ? ' (rechecked when the roads load)' : ''}</span>
        <ChevronDown size={16} className={`text-amber-200 transition ${open ? 'rotate-180' : ''}`} />
      </button>
      {open && (
        <ul className="border-t border-amber-400/10 divide-y divide-white/5">
          {shown.map(p => (
            <li key={p.id} className="px-3 py-2.5 space-y-1.5">
              <p className="text-sm text-slate-100 leading-snug">{p.title}</p>
              <p className="text-xs text-slate-400 leading-snug">{p.detail}</p>
              <div className="flex gap-1">
                <Button variant="ghost" icon={Eye} size="sm" onClick={() => engineInstance.simMode.flyTo(p.location)}>Show</Button>
                {p.kind !== 'no_alternative' && <Button variant="ghost" icon={Hammer} size="sm" onClick={() => engineInstance.editProblemInPlanMode(p)}>Fix in Build</Button>}
              </div>
            </li>
          ))}
        </ul>
      )}
    </section>
  );
};

const Assumptions: React.FC<{ seeds: readonly number[] }> = ({ seeds }) => {
  const NAMES: Record<string, string> = { two_wheeler: 'two-wheelers', car: 'cars', auto: 'autos', bus: 'buses', truck: 'goods vehicles' };
  const fleet = VEHICLE_TYPES.filter(t => t.share > 0).map(t => `${Math.round(t.share * 100)}% ${NAMES[t.kind] ?? t.kind} (${t.pcu} PCU)`).join(', ');
  return (
    <ul className="list-disc pl-5 space-y-1.5 text-xs leading-relaxed text-slate-400">
      <li><strong className="text-slate-300">Two models.</strong> The whole study area: user-equilibrium traffic assignment (Frank–Wolfe; link time BPR t₀(1 + {BPR_ALPHA}(v/c)^{BPR_BETA})), which routes all the demand and gives every road's volume and volume/capacity. The selected road's neighbourhood ({formatDistanceM(CORRIDOR_RANGE_M)}): vehicle-by-vehicle simulation (IDM car following, Indian mixed traffic, signals timed by Webster's method), fed by the routes the assignment sends through it.</li>
      <li><strong className="text-slate-300">Repeatable.</strong> Every analysis runs the neighbourhood with {seeds.length} random seeds ({seeds.join(', ')}) after a 5-minute warm-up and counts 15 minutes; figures are their mean, with the spread shown. The same inputs always give the same result.</li>
      <li><strong className="text-slate-300">Capacity.</strong> Mid-block: IRC:106-1990 Table 2 design service volumes divided by 0.70 (LOS C, clause 8.1), by road type and lanes. Signalised ends: Indo-HCM width-based saturation flow × green ratio.</li>
      <li><strong className="text-slate-300">Free-flow speed.</strong> The road's OSM speed limit, or one tagged on another piece of the same road, or an urban default ({Object.entries(URBAN_DEFAULT_SPEED_KMH).filter(([k]) => ['primary', 'tertiary', 'residential'].includes(k)).map(([k, v]) => `${k} ${v}`).join(', ')} km/h), never above {URBAN_SPEED_CEILING_KMH} km/h (Maharashtra municipal limits, 2019; MoRTH S.O. 1522(E), 2018).</li>
      <li><strong className="text-slate-300">Level of service.</strong> Travel speed (including the wait at the junction at the end) as a share of the free-flow speed, Indo-HCM 2017 urban streets: A &gt; 84%, B &gt; 76%, C &gt; 59%, D &gt; 41%, E &gt; 22%, F below or when demand exceeds capacity.</li>
      <li><strong className="text-slate-300">Causes.</strong> Each queued vehicle's waiting time is charged to why the vehicle at the front of its queue waits: a red signal, a full road ahead (then followed to where that queue starts), giving way, or a conflicting turn. A cause is named only when the runs support it.</li>
      <li><strong className="text-slate-300">Fleet</strong> (edge and through traffic): {fleet}. Traffic keeps left; two-wheelers ride two abreast.</li>
      <li>No traffic is pushed onto the selected road: it carries what the routes choose.</li>
    </ul>
  );
};

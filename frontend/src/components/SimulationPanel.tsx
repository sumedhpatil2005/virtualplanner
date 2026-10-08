import React, { useState } from 'react';
import {
  MousePointerClick, Pause, Play, RotateCcw, Loader2, AlertTriangle, AlertOctagon, CheckCircle2, Maximize2, Eye, Hammer, ChevronDown, Crosshair, Target, GitCompareArrows, Flag, X,
} from 'lucide-react';
import { engineInstance } from '../engine/TwinCityEngine';
import { useSimulationMode } from '../hooks/useSimulationMode';
import {
  STUDY_DISTANCES_M, TRAFFIC_LEVELS, TRAFFIC_SPEEDS, FOCUS_LOAD_PER_LEVEL, type SimulationModeState, type TrafficRunState, type SignalsState,
} from '../engine/simulation/SimulationMode';
import type { StudyProblem } from '../engine/simulation/StudyAreaExplorer';
import {
  GRIDLOCK_S, SIGNAL_GREEN_S, SIGNAL_AMBER_S, SIGNAL_ALL_RED_S, LANE_CAPACITY_VPH, VEHICLE_TYPES,
} from '../engine/simulation/TrafficMicroSim';
import { SPEED_COLORS } from '../engine/rendering/renderers/MicroTrafficVisualizer';
import { formatDistanceM } from '../lib/format';
import { SidePanel, PanelHeader, PanelBody, Section, Figure, Button, Segmented, Notice } from './ui/kit';

const roadName = (id: string) => engineInstance.objects.getById(id)?.name || 'Unnamed road';

const formatClock = (s: number) => {
  const h = Math.floor(s / 3600);
  const m = Math.floor((s % 3600) / 60);
  const sec = Math.floor(s % 60);
  return h > 0 ? `${h}:${String(m).padStart(2, '0')}:${String(sec).padStart(2, '0')}` : `${m}:${String(sec).padStart(2, '0')}`;
};

const DISTANCE_OPTIONS = STUDY_DISTANCES_M.map(m => ({ value: m, label: formatDistanceM(m) }));
const SPEED_OPTIONS = TRAFFIC_SPEEDS.map(s => ({ value: s, label: `${s}×` }));
const LEVEL_OPTIONS = TRAFFIC_LEVELS.map(l => ({ value: l.value, label: l.label }));
const ROUTE_OPTIONS = [
  { value: 'focus', label: 'Through this road' },
  { value: 'natural', label: 'Natural' },
] as const;

/**
 * Simulate mode: choose how far around the road to look, click a road, and
 * traffic runs on everything within that distance.
 */
export const SimulationPanel: React.FC = () => {
  const sim = useSimulationMode();
  const mode = engineInstance.simMode;
  const hasRoad = sim.seedRoadIds.length > 0;

  return (
    <SidePanel label="Simulate traffic">
      <PanelHeader
        title={hasRoad ? sim.seedRoadIds.map(roadName).join(' + ') : 'Traffic lab'}
        subtitle={hasRoad ? `Traffic within ${formatDistanceM(sim.rangeMeters)} along the roads` : 'Pick a distance, then click a road'}
        onBack={hasRoad ? () => mode.clearSeeds() : undefined}
        backLabel="Choose another road"
        onClose={() => engineInstance.setAppMode('view')}
        closeLabel="Leave Simulate"
      />
      <PanelBody>
        <Section title="Distance around the road">
          <Segmented label="Distance around the road" options={DISTANCE_OPTIONS} value={sim.rangeMeters as (typeof STUDY_DISTANCES_M)[number]} onChange={m => mode.setRange(m)} />
        </Section>

        {!hasRoad ? <PickRoad rangeMeters={sim.rangeMeters} /> : <Study sim={sim} />}
      </PanelBody>
    </SidePanel>
  );
};

const PickRoad: React.FC<{ rangeMeters: number }> = ({ rangeMeters }) => (
  <div className="rounded-2xl border border-dashed border-cyan-400/30 bg-cyan-500/5 px-4 py-5 text-center space-y-2">
    <MousePointerClick size={28} className="mx-auto text-cyan-300" />
    <p className="text-base font-semibold text-white">Click a road on the map</p>
    <p className="text-sm text-slate-300 leading-relaxed">
      Any road, flyover or bridge. Every road within {formatDistanceM(rangeMeters)} is mapped, the places where traffic enters and leaves are found, and traffic starts.
    </p>
    <p className="text-xs text-slate-500">Shift+click adds more roads, for a corridor.</p>
  </div>
);

const Study: React.FC<{ sim: SimulationModeState }> = ({ sim }) => {
  const mode = engineInstance.simMode;
  const { area, traffic, osmRoads, signals } = sim;

  return (
    <>
      {osmRoads.status === 'loading' && (
        <Notice icon={Loader2} spin action={<Button variant="ghost" onClick={() => mode.cancelOsmRoads()}>Cancel</Button>}>
          Checking the roads around this area against OpenStreetMap and adding any that are missing. Traffic starts when they are in.
        </Notice>
      )}
      {osmRoads.status === 'error' && (
        <Notice tone="warn" icon={AlertTriangle} action={<Button variant="ghost" onClick={() => mode.retryOsmRoads()}>Retry</Button>}>
          Some roads around this area could not be loaded, so it may stop short. {osmRoads.error}
        </Notice>
      )}
      {osmRoads.status === 'idle' && !!osmRoads.added && (
        <Notice tone="good" icon={CheckCircle2}>
          Added {osmRoads.added.toLocaleString()} road{osmRoads.added === 1 ? '' : 's'} from OpenStreetMap that were missing here.
        </Notice>
      )}
      {sim.error && <Notice tone="bad" icon={AlertOctagon}>{sim.error}</Notice>}

      {area && (
        <>
          <div className="flex items-center justify-between gap-2 text-sm text-slate-300">
            <span>
              <strong className="text-white tabular-nums">{area.stats.roads.toLocaleString()}</strong> roads ·{' '}
              <strong className="text-white tabular-nums">{area.stats.entries}</strong> ways in ·{' '}
              <strong className="text-white tabular-nums">{area.stats.exits}</strong> ways out
            </span>
            <span className="flex gap-0.5">
              <button onClick={() => mode.focusView()} title="Close in on the selected road" aria-label="Close in on the selected road" className="p-1.5 rounded-lg text-slate-400 hover:text-white hover:bg-white/5 cursor-pointer">
                <Crosshair size={16} />
              </button>
              <button onClick={() => mode.fitView()} title="Fit the area in view" aria-label="Fit the area in view" className="p-1.5 rounded-lg text-slate-400 hover:text-white hover:bg-white/5 cursor-pointer">
                <Maximize2 size={16} />
              </button>
            </span>
          </div>
          <TrafficControls traffic={traffic} waiting={osmRoads.status === 'loading' ? 'Waiting for roads' : signals.status === 'loading' ? 'Loading signals' : null} />
          {traffic.demand && <div className="rounded-xl border border-indigo-400/20 bg-indigo-500/5 p-3"><p className="text-xs font-semibold uppercase tracking-wide text-indigo-300">{traffic.demand.source === 'project-estimate' ? `Project demand · ${traffic.demand.period.replace('_', ' ').replace('Peak', 'peak')}` : 'Synthetic traffic'}</p><p className="mt-1 text-xs leading-relaxed text-slate-400">{traffic.demand.label}</p></div>}
          <SignalsNote signals={signals} />
          <VehicleInspector sim={sim} />
          <ScenarioExperiment sim={sim} />
          {traffic.metrics && <LiveFigures traffic={traffic} seedRoadIds={sim.seedRoadIds} />}
          <NetworkChecks problems={area.problems} provisional={osmRoads.status === 'loading'} />
          <Assumptions seed={traffic.seed} />
        </>
      )}
    </>
  );
};

/** Where the junction signals come from. */
const SignalsNote: React.FC<{ signals: SignalsState }> = ({ signals }) => {
  if (signals.status === 'off') return null;
  const text =
    signals.status === 'loading' ? 'Loading the real traffic signals from OpenStreetMap…'
    : signals.status === 'error' ? 'OpenStreetMap could not be reached, so signals are placed where two main roads cross.'
    : signals.count === 0 ? 'No signals mapped in OpenStreetMap here. Your placed junction controls take precedence.'
    : `${signals.count} mapped traffic signal${signals.count === 1 ? '' : 's'} found. Your placed junction controls take precedence.`;
  return <p className={`text-xs ${signals.status === 'error' ? 'text-amber-300/80' : 'text-slate-500'}`}>{text}</p>;
};

const TrafficControls: React.FC<{ traffic: TrafficRunState; waiting: string | null }> = ({ traffic, waiting }) => {
  const mode = engineInstance.simMode;
  const { status, metrics: m } = traffic;
  return (
    <Section title="Traffic" aside={m ? `${formatClock(m.timeS)} simulated` : undefined}>
      <div className="flex gap-2">
        {status === 'running' && <Button className="flex-1" icon={Pause} onClick={() => mode.pauseTraffic()}>Pause</Button>}
        {status === 'paused' && <Button className="flex-1" variant="primary" icon={Play} onClick={() => mode.resumeTraffic()}>Resume</Button>}
        {status === 'idle' && (
          <Button className="flex-1" variant="primary" icon={waiting ? Loader2 : Play} spin={!!waiting} disabled={!!waiting} onClick={() => mode.restartTraffic()}>
            {waiting ?? 'Start traffic'}
          </Button>
        )}
        {status !== 'idle' && <Button icon={RotateCcw} onClick={() => mode.restartTraffic()} title="Clear the vehicles and start again">Restart</Button>}
      </div>
      {traffic.error && <Notice tone="warn" icon={AlertTriangle}>{traffic.error}</Notice>}
      <div className="grid grid-cols-[auto_1fr] items-center gap-x-3 gap-y-2 pt-1">
        <span className="text-sm text-slate-400">Routes</span>
        {traffic.demand?.source === 'project-estimate' ? <span className="text-xs text-indigo-300">Project origins and destinations</span> : <Segmented label="Where traffic goes" options={ROUTE_OPTIONS} value={traffic.focus ? 'focus' : 'natural'} onChange={v => mode.setFocus(v === 'focus')} />}
        <span className="text-sm text-slate-400">Volume</span>
        <Segmented label="Traffic volume" options={LEVEL_OPTIONS} value={nearestLevel(traffic.demandLevel)} onChange={v => mode.setDemandLevel(v)} />
        <span className="text-sm text-slate-400">Speed</span>
        <Segmented label="Playback speed" options={SPEED_OPTIONS} value={traffic.speed as (typeof TRAFFIC_SPEEDS)[number]} onChange={s => mode.setTrafficSpeed(s)} />
      </div>
      {m && (
        <p className="text-xs text-slate-500">
          About {m.inflowVph.toLocaleString()} vehicles an hour enter the area
          {m.focusVph > 0 ? `, ${m.focusVph.toLocaleString()} of them sent through the selected road` : ''}.
        </p>
      )}
    </Section>
  );
};

const nearestLevel = (v: number) =>
  TRAFFIC_LEVELS.reduce((best, l) => (Math.abs(l.value - v) < Math.abs(best.value - v) ? l : best)).value;

const VehicleInspector: React.FC<{ sim: SimulationModeState }> = ({ sim }) => {
  if (sim.selectedVehicleId === null) return <p className="text-xs text-slate-500">Click a moving vehicle to inspect it. Shift+click adds a road to the study.</p>;
  const mode = engineInstance.simMode;
  const vehicle = mode.inspectVehicle(sim.selectedVehicleId);
  return <section className="rounded-xl border border-cyan-400/25 bg-cyan-500/5 p-3 space-y-2">
    <div className="flex justify-between items-center"><span className="text-sm font-semibold text-cyan-100">{vehicle ? vehicle.kind.replaceAll('_', ' ') : 'Vehicle'} #{sim.selectedVehicleId}</span><button aria-label="Close vehicle inspector" onClick={() => mode.selectVehicle(null)} className="cursor-pointer text-slate-400 hover:text-white"><X size={15} /></button></div>
    {vehicle ? <><p className="text-xs text-slate-300">{Math.round(vehicle.speedKmh)} km/h · {Math.round(vehicle.speedRatio * 100)}% of road speed limit · {vehicle.focus ? 'Uses selected road' : 'Area traffic'}</p><Button size="sm" variant="ghost" icon={Crosshair} onClick={() => mode.flyTo([vehicle.lng, vehicle.lat, vehicle.z])}>Locate vehicle</Button></> : <p className="text-xs text-slate-400">This vehicle has left the active simulation.</p>}
  </section>;
};

/** Both columns come from fresh, equal-duration runs with the same frozen trips. */
const ScenarioExperiment: React.FC<{ sim: SimulationModeState }> = ({ sim }) => {
  const mode = engineInstance.simMode;
  const { baseline, current, staleReason, running } = sim.comparison;
  const [error, setError] = useState<string | null>(null);
  const run = async (baselineRun: boolean) => {
    setError(null);
    try { await (baselineRun ? mode.captureBaseline(300) : mode.runComparison()); }
    catch (e) { setError(e instanceof Error ? e.message : 'The experiment could not finish.'); }
  };
  const busy = running || sim.osmRoads.status === 'loading' || sim.signals.status === 'loading';
  const before = baseline?.metrics, after = current?.metrics;
  const delayReduction = before?.meanDelayS != null && after?.meanDelayS != null && before.meanDelayS > 0.1
    ? (before.meanDelayS - after.meanDelayS) / before.meanDelayS * 100 : null;
  const complete = !!before && !!after && delayReduction !== null && delayReduction >= 10 && after.completedTrips >= before.completedTrips && after.onNetwork + after.waitingToEnter <= before.onNetwork + before.waitingToEnter && after.gridlockRemovals <= before.gridlockRemovals && after.unroutable <= before.unroutable;
  const scenarioName = (id: string) => engineInstance.scenarios.getAll().find(s => s.id === id)?.name ?? id;
  const rows: [string, string, string][] = before && after ? [
    ['Trips completed', String(before.completedTrips), String(after.completedTrips)],
    ['Mean trip time', before.meanTravelTimeS === null ? '—' : `${before.meanTravelTimeS.toFixed(1)} s`, after.meanTravelTimeS === null ? '—' : `${after.meanTravelTimeS.toFixed(1)} s`],
    ['Mean delay', before.meanDelayS === null ? '—' : `${before.meanDelayS.toFixed(1)} s`, after.meanDelayS === null ? '—' : `${after.meanDelayS.toFixed(1)} s`],
    ['Travel-time ratio', before.delayIndex === null ? '—' : `${before.delayIndex.toFixed(2)}×`, after.delayIndex === null ? '—' : `${after.delayIndex.toFixed(2)}×`],
    ['Stops per trip', before.stopsPerTrip === null ? '—' : before.stopsPerTrip.toFixed(1), after.stopsPerTrip === null ? '—' : after.stopsPerTrip.toFixed(1)],
    ['Unfinished trips', String(before.onNetwork + before.waitingToEnter), String(after.onNetwork + after.waitingToEnter)],
    ['Removed / unroutable', String(before.gridlockRemovals + before.unroutable), String(after.gridlockRemovals + after.unroutable)],
  ] : [];
  return <section className="overflow-hidden rounded-2xl border border-indigo-400/25 bg-gradient-to-br from-indigo-500/10 to-slate-900/50">
    <div className="p-3 space-y-3">
      <div className="flex items-center gap-2"><Target size={17} className="text-indigo-300" /><h3 className="text-sm font-semibold text-white">Make the city flow</h3><span className="ml-auto text-[10px] uppercase tracking-wide text-indigo-300">5-minute trial</span></div>
      <p className="text-xs text-slate-300 leading-relaxed">Reduce excess travel time by 10% while completing at least as many trips. Save a baseline, improve the roads or signals in Build, then test the change.</p>
      <div className="h-1.5 rounded-full bg-white/10 overflow-hidden"><div className={`h-full transition-all ${complete ? 'bg-emerald-400' : 'bg-indigo-400'}`} style={{ width: `${delayReduction === null ? 0 : Math.max(0, Math.min(100, delayReduction * 10))}%` }} /></div>
      <p className={`text-xs ${complete ? 'text-emerald-300' : 'text-slate-400'}`}>{complete ? 'Objective achieved in this modelled trial' : delayReduction === null ? 'Run both trials to measure progress' : `${delayReduction.toFixed(1)}% less excess travel time · check trip totals below`}</p>
      <div className="flex gap-2"><Button size="sm" icon={running ? Loader2 : Flag} spin={running} disabled={busy} onClick={() => void run(true)}>{baseline ? 'Replace baseline' : 'Save baseline'}</Button><Button size="sm" variant="primary" icon={GitCompareArrows} disabled={busy || !baseline} onClick={() => void run(false)}>Test change</Button></div>
      {running && <p role="status" className="text-xs text-cyan-300">Running a repeatable trial…</p>}
      {baseline && <p className="text-xs text-slate-400">Baseline: {scenarioName(baseline.scenarioId)} · {baseline.durationS / 60} min · seed {baseline.seed}</p>}
      {(error || staleReason) && <p role="status" className="text-xs text-amber-300">{error || staleReason}</p>}
    </div>
    {rows.length > 0 && <div className="border-t border-white/10 p-3"><table className="w-full text-xs tabular-nums"><caption className="text-left mb-2 text-slate-400">Same demand, duration and random seed</caption><thead><tr className="text-slate-500"><th className="text-left pb-2 font-medium">Result</th><th className="text-right pb-2 font-medium">Before</th><th className="text-right pb-2 font-medium">After</th></tr></thead><tbody>{rows.map(([label, a, b]) => <tr key={label} className="border-t border-white/5"><th className="py-2 text-left font-normal text-slate-400">{label}</th><td className="text-right text-slate-300">{a}</td><td className="text-right text-white">{b}</td></tr>)}</tbody></table><p className="mt-2 text-[11px] text-slate-500">Travel results cover completed trips. Always compare unfinished and removed trips too.</p></div>}
  </section>;
};

const LiveFigures: React.FC<{ traffic: TrafficRunState; seedRoadIds: string[] }> = ({ traffic, seedRoadIds }) => {
  const m = traffic.metrics!;
  const delayPct = m.delayIndex === null ? null : Math.round((m.delayIndex - 1) * 100);
  const hours = m.timeS / 3600;
  const perHour = m.timeS >= 120 ? Math.round(m.watched.passed / hours) : null;

  return (
    <>
      <Section title="Whole area">
        <div className="grid grid-cols-2 gap-2">
          <Figure label="Vehicles on the roads" value={m.onNetwork.toLocaleString()} hint={m.waitingToEnter > 0 ? `${m.waitingToEnter.toLocaleString()} queuing to enter` : undefined} tone={m.waitingToEnter > 50 ? 'warn' : undefined} />
          <Figure label="Average speed" value={m.meanSpeedKmh === null ? '—' : `${Math.round(m.meanSpeedKmh)} km/h`} />
          <Figure label="Trips completed" value={m.completedTrips.toLocaleString()} />
          <Figure label="Mean trip time" value={m.meanTravelTimeS === null ? '—' : `${Math.round(m.meanTravelTimeS)} s`} hint="completed trips, includes entry queues" />
          <Figure label="Mean delay" value={m.meanDelayS === null ? '—' : `${Math.round(m.meanDelayS)} s`} hint="completed trips vs. empty roads" />
          <Figure
            label="Extra travel time"
            value={delayPct === null ? '—' : `${delayPct > 0 ? '+' : ''}${delayPct}%`}
            hint="vs. empty roads"
            tone={delayPct === null ? undefined : delayPct < 25 ? 'good' : delayPct < 75 ? 'warn' : 'bad'}
          />
        </div>
      </Section>

      <Section title={seedRoadIds.length === 1 ? 'Selected road' : 'Selected roads'}>
        <div className="grid grid-cols-2 gap-2">
          <Figure label="Vehicles using it" value={perHour === null ? m.watched.passed.toLocaleString() : `${perHour.toLocaleString()}/h`} hint={perHour === null ? 'so far' : `${m.watched.passed.toLocaleString()} so far`} />
          <Figure label="Speed on it now" value={m.watched.meanSpeedKmh === null ? '—' : `${Math.round(m.watched.meanSpeedKmh)} km/h`} hint={`${m.watched.onRoad} on it now`} />
        </div>
        {traffic.focus && (
          <p className="text-xs text-slate-500">Includes the traffic sent through it. Switch Routes to Natural to see how much uses it by itself.</p>
        )}
        {!traffic.focus && m.timeS > 180 && m.watched.passed === 0 && (
          <p className="text-sm text-slate-400">No traffic uses it: routes through the area are faster without it. Check how it connects in View mode.</p>
        )}
      </Section>

      <div className="flex flex-wrap gap-x-4 gap-y-1 text-xs text-slate-400">
        <span className="text-slate-500">Road colour:</span>
        <Dot color={SPEED_COLORS.free} label="Moving freely" />
        <Dot color={SPEED_COLORS.slow} label="Slow" />
        <Dot color={SPEED_COLORS.stopped} label="Stopped" />
      </div>

      {m.gridlockRemovals > 0 && (
        <Notice tone="warn" icon={AlertTriangle}>
          {m.gridlockRemovals} vehicle{m.gridlockRemovals > 1 ? 's were' : ' was'} removed after being stuck for {GRIDLOCK_S / 60} minutes. Try a lower volume.
        </Notice>
      )}
    </>
  );
};

const Dot: React.FC<{ color: string; label: string }> = ({ color, label }) => (
  <span className="inline-flex items-center gap-1.5"><span className="w-2.5 h-2.5 rounded-full" style={{ background: color }} />{label}</span>
);

/** Connection faults worth fixing; dead ends and other notes are left out. */
const NetworkChecks: React.FC<{ problems: StudyProblem[]; provisional: boolean }> = ({ problems, provisional }) => {
  const [open, setOpen] = useState(false);
  const shown = problems.filter(p => p.severity !== 'info');

  if (shown.length === 0) {
    return (
      <Notice tone="good" icon={CheckCircle2}>
        {provisional ? 'No connection problems found so far.' : 'No connection problems found by the network checks.'}
      </Notice>
    );
  }
  return (
    <section className="rounded-xl border border-amber-400/20 bg-amber-500/5">
      <button onClick={() => setOpen(o => !o)} aria-expanded={open} className="w-full flex items-center gap-2.5 px-3 py-2.5 text-left cursor-pointer">
        <AlertTriangle size={16} className="text-amber-300 shrink-0" />
        <span className="flex-1 text-sm text-amber-100">
          {shown.length} connection problem{shown.length > 1 ? 's' : ''} to check{provisional ? ' (rechecked when the roads load)' : ''}
        </span>
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
                {p.kind !== 'no_alternative' && (
                  <Button variant="ghost" icon={Hammer} size="sm" onClick={() => engineInstance.editProblemInPlanMode(p)}>Fix in Build</Button>
                )}
              </div>
            </li>
          ))}
        </ul>
      )}
    </section>
  );
};

const Assumptions: React.FC<{ seed: number }> = ({ seed }) => {
  const fleet = VEHICLE_TYPES.map(t => `${Math.round(t.share * 100)}% ${t.kind === 'two_wheeler' ? 'two-wheelers' : t.kind === 'car' ? 'cars' : 'buses and autos'}`).join(', ');
  return (
    <details className="text-sm text-slate-400">
      <summary className="cursor-pointer text-slate-300 hover:text-white">How the traffic is modelled</summary>
      <ul className="list-disc pl-5 mt-2 space-y-1.5 text-xs leading-relaxed">
        <li>Project demand estimates trips from buildings, zones and gateways. When those inputs are absent, synthetic arrivals use a share of road capacity ({Object.entries(LANE_CAPACITY_VPH).map(([k, v]) => `${k} ${v}`).join(', ')} vehicles/h per lane): Light 5%, Normal 12%, Heavy 25%. These are planning estimates, not measured traffic counts.</li>
        <li>Fleet: {fleet}. Traffic keeps left and follows the car-following model used in research simulators (IDM).</li>
        <li>Your placed junctions control signals and cycle length. Other mapped signals use {SIGNAL_GREEN_S} s green, {SIGNAL_AMBER_S} s amber, {SIGNAL_ALL_RED_S} s all-red per direction. If the map cannot be reached, signals are estimated where two main roads cross. Elsewhere the smaller road gives way.</li>
        <li>OpenStreetMap bridges and flyovers are raised to deck height with ramps, so they pass over the roads below. Roads you build join any road their ends stop within 25 m of.</li>
        <li>The roads around the study area are checked against OpenStreetMap (once a fortnight per place) and any that are missing are loaded, so the study runs on every mapped road.</li>
        <li>With Routes set to Through this road, extra trips enter at the area edge, drive along the selected road and leave by another edge. Their volume is {Math.round(FOCUS_LOAD_PER_LEVEL * 100) / 100}× the volume share of the selected road's capacity (Light {Math.round(TRAFFIC_LEVELS[0].value * FOCUS_LOAD_PER_LEVEL * 100)}%, Normal {Math.round(TRAFFIC_LEVELS[1].value * FOCUS_LOAD_PER_LEVEL * 100)}%, Heavy {Math.round(TRAFFIC_LEVELS[2].value * FOCUS_LOAD_PER_LEVEL * 100)}%). Entries and exits for which the road is on or near the fastest way through are used most.</li>
        <li>Drivers take the fastest route and prefer main roads. The same settings always give the same run (seed {seed}).</li>
      </ul>
    </details>
  );
};

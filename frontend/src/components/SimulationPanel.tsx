import React, { useState } from 'react';
import {
  MousePointerClick, Pause, Play, RotateCcw, Loader2, AlertTriangle, AlertOctagon, CheckCircle2, Maximize2, Eye, Hammer, ChevronDown, Crosshair, X,
} from 'lucide-react';
import { engineInstance } from '../engine/TwinCityEngine';
import { useSimulationMode } from '../hooks/useSimulationMode';
import {
  STUDY_DISTANCES_M, TRAFFIC_SPEEDS, type SimulationModeState, type TrafficRunState, type SignalsState,
} from '../engine/simulation/SimulationMode';
import type { StudyProblem } from '../engine/simulation/StudyAreaExplorer';
import {
  GRIDLOCK_S, SIGNAL_GREEN_S, SIGNAL_AMBER_S, SIGNAL_ALL_RED_S, LANE_CAPACITY_VPH, VEHICLE_TYPES,
} from '../engine/simulation/TrafficMicroSim';
import { SPEED_COLORS } from '../engine/rendering/renderers/MicroTrafficVisualizer';
import { formatDistanceM } from '../lib/format';
import { SidePanel, PanelHeader, PanelBody, Section, Figure, Button, Segmented, Notice } from './ui/kit';
import { SourceBadge } from './ui/SourceBadge';
import { sourceOf } from './ui/dataSource';
import { CalibrationPanel } from './CalibrationPanel';
import { TimeOfDayPanel } from './TimeOfDayPanel';
import { RoadAnalysisView, DemandEvidence } from './RoadAnalysisPanel';

const roadName = (id: string) => engineInstance.objects.getById(id)?.name || 'Unnamed road';

const formatClock = (s: number) => {
  const h = Math.floor(s / 3600);
  const m = Math.floor((s % 3600) / 60);
  const sec = Math.floor(s % 60);
  return h > 0 ? `${h}:${String(m).padStart(2, '0')}:${String(sec).padStart(2, '0')}` : `${m}:${String(sec).padStart(2, '0')}`;
};

const DISTANCE_OPTIONS = STUDY_DISTANCES_M.map(m => ({ value: m, label: formatDistanceM(m) }));
const SPEED_OPTIONS = TRAFFIC_SPEEDS.map(s => ({ value: s, label: `${s}×` }));

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
        title={hasRoad ? (sim.section?.name ?? sim.seedRoadIds.map(roadName).join(' + ')) : 'Road analysis'}
        subtitle={hasRoad ? `${sim.section ? `${formatDistanceM(sim.section.lengthM)} section${sim.section.carriageways === 2 ? ', both carriageways' : ''} · ` : ''}area ${formatDistanceM(sim.rangeMeters)} around it` : 'Pick a distance, then click a road'}
        onBack={hasRoad ? () => mode.clearSeeds() : undefined}
        backLabel="Choose another road"
        onClose={() => engineInstance.setAppMode('view')}
        closeLabel="Leave Simulate"
      />
      <PanelBody>
        {!hasRoad && (
          <Section title="Distance around the road">
            <Segmented label="Distance around the road" options={DISTANCE_OPTIONS} value={sim.rangeMeters as (typeof STUDY_DISTANCES_M)[number]} onChange={m => mode.setRange(m)} />
          </Section>
        )}

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
      Any road, flyover or bridge. You will see how much traffic uses it, where that traffic comes from, what holds it up, and what a change would do. Every road within {formatDistanceM(rangeMeters)} is included.
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
          <RoadAnalysisView sim={sim} />
          <TimeOfDayPanel tod={sim.timeOfDay} />
          <div className="space-y-2 pt-1">
            <p className="text-xs font-semibold uppercase tracking-wide text-slate-500">Advanced</p>
            <Advanced title="Live traffic on the map">
              <TrafficControls traffic={traffic} waiting={osmRoads.status === 'loading' ? 'Waiting for roads' : signals.status === 'loading' ? 'Loading signals' : null} />
              <VehicleInspector sim={sim} />
              {traffic.metrics && <LiveFigures traffic={traffic} seedRoadIds={sim.seedRoadIds} />}
            </Advanced>
            <Advanced title="Demand, evidence and what-if">
              {traffic.demand && <DemandNote demand={traffic.demand} />}
              <DemandEvidence sim={sim} />
            </Advanced>
            <Advanced title="Calibrate to traffic counts">
              <CalibrationPanel sim={sim} />
            </Advanced>
            <Advanced title="Study area and network checks">
              <Section title="Distance around the road">
                <Segmented label="Distance around the road" options={DISTANCE_OPTIONS} value={sim.rangeMeters as (typeof STUDY_DISTANCES_M)[number]} onChange={m => mode.setRange(m)} />
              </Section>
              <SignalsNote signals={signals} />
              <NetworkChecks problems={area.problems} provisional={osmRoads.status === 'loading'} />
            </Advanced>
            <Advanced title="How the model works">
              <Assumptions seed={traffic.seed} />
            </Advanced>
          </div>
        </>
      )}
    </>
  );
};

/** An optional section, closed until opened. */
const Advanced: React.FC<{ title: string; children: React.ReactNode }> = ({ title, children }) => (
  <details className="group rounded-xl border border-white/10 bg-white/[0.02]">
    <summary className="flex cursor-pointer items-center justify-between px-3 py-2 text-sm text-slate-300 hover:text-white list-none">
      {title}<ChevronDown size={15} className="transition group-open:rotate-180" />
    </summary>
    <div className="space-y-3 border-t border-white/5 px-3 py-3">{children}</div>
  </details>
);

/** What the traffic demand is based on, labelled by data source. */
const DemandNote: React.FC<{ demand: NonNullable<TrafficRunState['demand']> }> = ({ demand }) => {
  const title = demand.source === 'project-estimate' ? 'Project demand' : demand.source === 'calibrated' ? 'Demand calibrated to counts' : 'Synthetic traffic';
  return (
    <div className="rounded-xl border border-indigo-400/20 bg-indigo-500/5 p-3">
      <p className="flex items-center justify-between gap-2 text-xs font-semibold uppercase tracking-wide text-indigo-300">
        <span>{title} · {demand.period.replace('_', ' ').replace('Peak', 'peak')}</span>
        <SourceBadge source={sourceOf(demand.source)} />
      </p>
      <p className="mt-1 text-xs leading-relaxed text-slate-400">{demand.label}</p>
      <p className="mt-1 text-xs text-slate-500 tabular-nums">{Math.round(demand.vehiclesPerHour).toLocaleString()} veh/h over {demand.pairCount.toLocaleString()} OD streams</p>
    </div>
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
        <span className="text-sm text-slate-400">Speed</span>
        <Segmented label="Playback speed" options={SPEED_OPTIONS} value={traffic.speed as (typeof TRAFFIC_SPEEDS)[number]} onChange={s => mode.setTrafficSpeed(s)} />
      </div>
      {m && (
        <p className="text-xs text-slate-500">
          About {m.inflowVph.toLocaleString()} vehicles an hour are planned in the area at this hour. The figures above come from a separate repeatable run; this animation is for watching.
        </p>
      )}
    </Section>
  );
};

const VehicleInspector: React.FC<{ sim: SimulationModeState }> = ({ sim }) => {
  if (sim.selectedVehicleId === null) return <p className="text-xs text-slate-500">Click a moving vehicle to inspect it. Shift+click adds a road to the study.</p>;
  const mode = engineInstance.simMode;
  const vehicle = mode.inspectVehicle(sim.selectedVehicleId);
  return <section className="rounded-xl border border-cyan-400/25 bg-cyan-500/5 p-3 space-y-2">
    <div className="flex justify-between items-center"><span className="text-sm font-semibold text-cyan-100">{vehicle ? vehicle.kind.replaceAll('_', ' ') : 'Vehicle'} #{sim.selectedVehicleId}</span><button aria-label="Close vehicle inspector" onClick={() => mode.selectVehicle(null)} className="cursor-pointer text-slate-400 hover:text-white"><X size={15} /></button></div>
    {vehicle ? <><p className="text-xs text-slate-300">{Math.round(vehicle.speedKmh)} km/h · {Math.round(vehicle.speedRatio * 100)}% of road speed limit · {vehicle.focus ? 'Uses selected road' : 'Area traffic'}</p><Button size="sm" variant="ghost" icon={Crosshair} onClick={() => mode.flyTo([vehicle.lng, vehicle.lat, vehicle.z])}>Locate vehicle</Button></> : <p className="text-xs text-slate-400">This vehicle has left the active simulation.</p>}
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
        {m.timeS > 180 && m.watched.passed === 0 && (
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
          {m.gridlockRemovals} vehicle{m.gridlockRemovals > 1 ? 's were' : ' was'} removed after being stuck for {GRIDLOCK_S / 60} minutes: the network is jammed at this hour.
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
  const NAMES: Record<string, string> = { two_wheeler: 'two-wheelers', car: 'cars', auto: 'autos', bus: 'buses', truck: 'goods vehicles' };
  const fleet = VEHICLE_TYPES.filter(t => t.share > 0).map(t => `${Math.round(t.share * 100)}% ${NAMES[t.kind] ?? t.kind}`).join(', ');
  return (
    <details className="text-sm text-slate-400">
      <summary className="cursor-pointer text-slate-300 hover:text-white">How the traffic is modelled</summary>
      <ul className="list-disc pl-5 mt-2 space-y-1.5 text-xs leading-relaxed">
        <li>Capacity per lane, used for the % of capacity figures (assumed): {Object.entries(LANE_CAPACITY_VPH).map(([k, v]) => `${k} ${v}`).join(', ')} vehicles/h. When an area has no roads crossing its edge and no buildings, synthetic arrivals at 12% of road capacity are used instead.</li>
        <li>Fleet: {fleet}. Traffic keeps left and follows the car-following model used in research simulators (IDM).</li>
        <li>Your placed junctions control signals and cycle length. Other mapped signals use {SIGNAL_GREEN_S} s green, {SIGNAL_AMBER_S} s amber, {SIGNAL_ALL_RED_S} s all-red per direction. If the map cannot be reached, signals are estimated where two main roads cross. Elsewhere the smaller road gives way.</li>
        <li>OpenStreetMap bridges and flyovers are raised to deck height with ramps, so they pass over the roads below. Roads you build join any road their ends stop within 25 m of.</li>
        <li>The roads around the study area are checked against OpenStreetMap (once a fortnight per place) and any that are missing are loaded, so the study runs on every mapped road.</li>
        <li>No traffic is sent through the selected road on purpose: it carries what the estimated trips choose to drive on it. Demand: the area's own trips at Pune rates and trip lengths (CMP 2018), trips crossing its edge, and through traffic on its main roads at counted Pune arterial flows; see Demand, evidence and what-if.</li>
        <li>The selected road is the clicked road followed to the next main junctions, both carriageways. The figures are from a 15-minute counted run after a 5-minute warm-up, after drivers adapt their routes to congestion once.</li>
        <li>Drivers take the fastest route and prefer main roads. The same settings always give the same run (seed {seed}).</li>
      </ul>
    </details>
  );
};

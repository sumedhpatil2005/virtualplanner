import { Activity, CheckCheck, Clock3, Pause, Play, Route } from 'lucide-react';
import { useSimulationMode } from '../hooks/useSimulationMode';
import { engineInstance } from '../engine/TwinCityEngine';

/** A small city-simulation dashboard that keeps the map, and its actual results, central. */
export function SimulationHud() {
  const { traffic, area } = useSimulationMode();
  const m = traffic.metrics;
  if (!area || !m) return null;
  const running = traffic.status === 'running';
  const clock = `${Math.floor(m.timeS / 60).toString().padStart(2, '0')}:${Math.floor(m.timeS % 60).toString().padStart(2, '0')}`;
  return (
    <section aria-label="Live simulation dashboard" className="simulation-hud absolute bottom-20 left-4 z-20 pointer-events-auto rounded-2xl border border-cyan-300/20 bg-slate-950/95 shadow-2xl backdrop-blur-xl overflow-hidden">
      <div className="h-0.5 bg-gradient-to-r from-cyan-400 via-indigo-400 to-emerald-400" />
      <div className="flex items-center gap-5 px-4 py-3">
        <button onClick={() => running ? engineInstance.simMode.pauseTraffic() : engineInstance.simMode.resumeTraffic()} aria-label={running ? 'Pause simulation' : 'Resume simulation'} className="rounded-xl bg-cyan-400/15 p-3 text-cyan-200 hover:bg-cyan-400/25 cursor-pointer">
          {running ? <Pause size={20} /> : <Play size={20} />}
        </button>
        <div>
          <div className="flex items-center gap-1.5 text-[10px] uppercase tracking-[0.18em] text-cyan-300"><span className={`h-1.5 w-1.5 rounded-full ${running ? 'bg-emerald-400 animate-pulse' : 'bg-amber-400'}`} />{running ? 'City in motion' : 'Simulation paused'}</div>
          <div className="mt-1 text-xl font-semibold tabular-nums text-white">{clock}<span className="ml-2 text-xs font-normal text-slate-400">{traffic.speed}×</span></div>
        </div>
        <HudMetric icon={Activity} label="On the roads" value={m.onNetwork.toLocaleString()} />
        <HudMetric icon={CheckCheck} label="Trips finished" value={m.completedTrips.toLocaleString()} />
        <HudMetric icon={Clock3} label="Waiting outside" value={m.waitingToEnter.toLocaleString()} warning={m.waitingToEnter > 0} />
        <div className="hidden xl:block"><HudMetric icon={Route} label="Mean speed" value={m.meanSpeedKmh === null ? '—' : `${Math.round(m.meanSpeedKmh)} km/h`} /></div>
      </div>
    </section>
  );
}

function HudMetric({ icon: Icon, label, value, warning = false }: { icon: typeof Activity; label: string; value: string; warning?: boolean }) {
  return <div className="border-l border-white/10 pl-4"><div className="flex items-center gap-1.5 text-[10px] uppercase tracking-wide text-slate-400"><Icon size={12} />{label}</div><div className={`mt-1 text-lg font-semibold tabular-nums ${warning ? 'text-amber-300' : 'text-slate-100'}`}>{value}</div></div>;
}

import { Activity, CheckCheck, Clock3, Pause, Play, Route, Square, Loader2 } from 'lucide-react';
import { useSimulationMode } from '../hooks/useSimulationMode';
import { engineInstance } from '../engine/TwinCityEngine';
import { hourLabel } from '../engine/simulation/timeOfDay';

/**
 * The live view's controls on the map: what it is doing (preparing, live,
 * paused), the simulated clock after the warm-up, and pause/resume/stop. It
 * only exists while the live view does; Stop releases it.
 */
export function SimulationHud() {
  const { traffic, area } = useSimulationMode();
  const mode = engineInstance.simMode;
  if (!area || traffic.status === 'idle') return null;
  const m = traffic.metrics;
  const running = traffic.status === 'running', preparing = traffic.status === 'preparing';
  const shown = m ? Math.max(0, m.timeS - traffic.warmupS) : 0;
  const clock = `${Math.floor(shown / 60).toString().padStart(2, '0')}:${Math.floor(shown % 60).toString().padStart(2, '0')}`;
  return (
    <section aria-label="Live simulation controls" data-testid="sim-hud" data-status={traffic.status} className="simulation-hud absolute bottom-20 left-4 z-20 pointer-events-auto rounded-2xl border border-cyan-300/20 bg-slate-950/95 shadow-2xl backdrop-blur-xl overflow-hidden">
      <div className="h-0.5 bg-gradient-to-r from-cyan-400 via-indigo-400 to-emerald-400" />
      <div className="flex items-center gap-4 px-4 py-3">
        {preparing ? <span className="rounded-xl bg-cyan-400/15 p-3 text-cyan-200"><Loader2 size={20} className="animate-spin" /></span> : (
          <button onClick={() => running ? mode.pauseTraffic() : mode.resumeTraffic()} aria-label={running ? 'Pause the live view' : 'Resume the live view'} className="rounded-xl bg-cyan-400/15 p-3 text-cyan-200 hover:bg-cyan-400/25 cursor-pointer">
            {running ? <Pause size={20} /> : <Play size={20} />}
          </button>
        )}
        <button onClick={() => mode.stopTraffic()} aria-label="Stop the live view" title="Stop and release the simulation" className="rounded-xl bg-white/5 p-3 text-slate-300 hover:bg-white/10 hover:text-white cursor-pointer"><Square size={18} /></button>
        <div>
          <div className="flex items-center gap-1.5 text-[10px] uppercase tracking-[0.18em] text-cyan-300"><span className={`h-1.5 w-1.5 rounded-full ${running ? 'bg-emerald-400 animate-pulse' : preparing ? 'bg-cyan-400 animate-pulse' : 'bg-amber-400'}`} />
            {preparing ? (traffic.preparing?.stage === 'analysis' ? 'Waiting for the analysis' : 'Warming up') : running ? 'Live' : 'Paused'}{traffic.hour !== null ? ` · ${hourLabel(traffic.hour)} traffic` : ''}</div>
          <div className="mt-1 text-xl font-semibold tabular-nums text-white">{preparing ? `${Math.round(100 * (traffic.preparing?.progress ?? 0))}%` : clock}<span className="ml-2 text-xs font-normal text-slate-400">{preparing ? '' : `${traffic.speed}×`}</span></div>
        </div>
        {m && !preparing && <>
          <HudMetric icon={Activity} label="On the roads" value={m.onNetwork.toLocaleString()} />
          <HudMetric icon={CheckCheck} label="Trips finished" value={m.completedTrips.toLocaleString()} />
          <HudMetric icon={Clock3} label="Queued at the edge" value={m.waitingToEnter.toLocaleString()} warning={m.waitingToEnter > 50} />
          <div className="hidden xl:block"><HudMetric icon={Route} label="Mean speed" value={m.meanSpeedKmh === null ? '—' : `${Math.round(m.meanSpeedKmh)} km/h`} /></div>
        </>}
      </div>
    </section>
  );
}

function HudMetric({ icon: Icon, label, value, warning = false }: { icon: typeof Activity; label: string; value: string; warning?: boolean }) {
  return <div className="border-l border-white/10 pl-4"><div className="flex items-center gap-1.5 text-[10px] uppercase tracking-wide text-slate-400"><Icon size={12} />{label}</div><div className={`mt-1 text-lg font-semibold tabular-nums ${warning ? 'text-amber-300' : 'text-slate-100'}`}>{value}</div></div>;
}

import React from 'react';
import { Clock, Play, Pause } from 'lucide-react';
import { engineInstance } from '../engine/TwinCityEngine';
import type { TimeOfDayState } from '../engine/simulation/SimulationMode';
import { periodOf, isMeasured, hourLabel, COUNT_HOURS, type TrafficPeriod } from '../engine/simulation/timeOfDay';
import { Section, Segmented, Button } from './ui/kit';
import { SourceBadge } from './ui/SourceBadge';

const PERIOD_STYLE: Record<TrafficPeriod, string> = {
  Peak: 'bg-rose-500/80',
  Moderate: 'bg-amber-400/80',
  Low: 'bg-emerald-500/70',
};
const PERIOD_TEXT: Record<TrafficPeriod, string> = { Peak: 'text-rose-300', Moderate: 'text-amber-300', Low: 'text-emerald-300' };

/**
 * Clock for the simulation: pick the hour (or play the day through) and the
 * demand follows the real Pune hour-of-day profile. Each bar is one hour's
 * share of daily traffic; solid bars are measured hours, hatched ones filled.
 */
export const TimeOfDayPanel: React.FC<{ tod: TimeOfDayState }> = ({ tod }) => {
  const mode = engineInstance.simMode;
  React.useEffect(() => { void mode.ensureTimeProfile(); }, [mode]);
  const p = tod.profile;
  if (tod.status === 'error') return <Section title="Time of day"><p className="text-xs text-amber-300/80">The hour-of-day profile could not be loaded: {tod.error}</p></Section>;
  if (!p) return <Section title="Time of day"><p className="text-xs text-slate-500">Loading the Pune hour-of-day profile…</p></Section>;
  const hours = p[tod.day].hours;
  const max = Math.max(...hours.map(h => h.share));
  const period = periodOf(p, tod.hour, tod.day);
  const measured = isMeasured(p, tod.hour, tod.day);
  const share = hours[tod.hour].share;
  return (
    <Section title="Time of day" aside={<span className="flex items-center gap-1 tabular-nums"><Clock className="h-3 w-3" />{hourLabel(tod.hour)}</span>}>
      <div data-testid="time-of-day" className="space-y-2">
        <div className="flex items-end gap-[2px] h-16" role="radiogroup" aria-label="Hour of day">
          {hours.map(h => {
            const per = periodOf(p, h.hour, tod.day);
            return (
              <button key={h.hour} role="radio" aria-checked={h.hour === tod.hour} title={`${hourLabel(h.hour)} · ${(h.share * 100).toFixed(1)}% of daily traffic · ${per}${h.measured ? ' · measured' : ' · filled (see sources)'}`}
                onClick={() => mode.setHour(h.hour)}
                className={`flex-1 rounded-t-sm ${PERIOD_STYLE[per]} ${h.hour === tod.hour ? 'ring-2 ring-white' : 'opacity-70 hover:opacity-100'}`}
                style={{ height: `${Math.max(6, (h.share / max) * 100)}%`, backgroundImage: h.measured ? undefined : 'repeating-linear-gradient(45deg, rgba(15,23,42,.45) 0 2px, transparent 2px 5px)' }} />
            );
          })}
        </div>
        <div className="flex justify-between text-[10px] text-slate-500 tabular-nums"><span>00</span><span>06</span><span>12</span><span>18</span><span>23</span></div>
        <p className="text-sm">
          <span className={`font-semibold ${PERIOD_TEXT[period]}`}>{period}</span>
          <span className="text-slate-400"> · {(share * 100).toFixed(1)}% of the day's traffic · demand ×{tod.factor.toFixed(2)} of the counted peak hour</span>
        </p>
        <div className="flex flex-wrap items-center gap-1.5">
          <SourceBadge source={measured ? 'observed' : 'estimated'} citation={measured ? 'Gunjan Chowk 2017 / Mendeley Pune CCTV 2023' : undefined} />
          {!measured && <span className="text-[11px] text-slate-500">This hour is filled from TomTom 2025 congestion (no hourly count exists).</span>}
        </div>
        <div className="grid grid-cols-[auto_1fr] items-center gap-x-3 gap-y-2 pt-1">
          <span className="text-sm text-slate-400">Day</span>
          <Segmented label="Day type" options={[{ value: 'weekday', label: 'Weekday' }, { value: 'weekend', label: 'Weekend' }]} value={tod.day} onChange={d => mode.setDayType(d as 'weekday' | 'weekend')} />
          <span className="text-sm text-slate-400">Counts are</span>
          <Segmented label="Peak the counts represent" options={[{ value: 'AM', label: `AM peak ${hourLabel(COUNT_HOURS.AM)}` }, { value: 'PM', label: `PM peak ${hourLabel(COUNT_HOURS.PM)}` }]} value={tod.countPeak} onChange={v => mode.setCountPeak(v as 'AM' | 'PM')} />
        </div>
        <Button icon={tod.playback ? Pause : Play} onClick={() => mode.setPlayback(!tod.playback)} title="Advance the clock one hour every simulated minute">
          {tod.playback ? 'Stop 24 h playback' : 'Play 24 h'}
        </Button>
        <p className="text-[11px] leading-relaxed text-slate-500">
          Hourly demand = calibrated peak-hour demand × profile[hour] ÷ profile[{hourLabel(COUNT_HOURS[tod.countPeak])}]. Peak ≥ 80% of the busiest hour, Low &lt; 40%.
          The count study does not say whether its peak hour was morning or evening; the profile's two peaks differ by under 5%.
          Sources: Gunjan Chowk hourly counts (IJETT 2017), Mendeley Pune CCTV counts (doi:10.17632/xnf2k6n288.1), TomTom Traffic Index 2025, Pune CMP 2018.
        </p>
      </div>
    </Section>
  );
};

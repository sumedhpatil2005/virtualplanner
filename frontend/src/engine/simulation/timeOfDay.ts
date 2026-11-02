/**
 * Time of day: the Pune hour-of-day traffic profile (backend/data/diurnal,
 * served at /api/diurnal-profile/<id>) and the scaling it implies.
 *
 * Hourly demand = calibrated peak-hour demand x profile[hour] / profile[count hour],
 * where the count hour is the clock hour the observed counts (and so the
 * calibrated plan) represent. The counts' sources do not say whether their peak
 * hour was morning or evening; the profile's AM (09:00) and PM (19:00) peaks
 * differ by under 5%, so the user picks which one the counts are taken to be.
 */
import { apiGet } from '../../lib/api';

export type TrafficPeriod = 'Peak' | 'Moderate' | 'Low';
export interface DiurnalHour { hour: number; share: number; period: string; measured: boolean; source: string }
export interface DiurnalProfile {
  version: number;
  weekday: { hours: DiurnalHour[]; am_peak_hour?: number; pm_peak_hour?: number; peak_hour?: number };
  weekend: { hours: DiurnalHour[] };
  /** Weekend daily volume relative to weekday (Gunjan Chowk day totals). */
  weekend_daily_vs_weekday?: number;
  sources?: { id: string; citation: string; url: string; used_for: string }[];
  period_thresholds?: Record<string, string>;
}
export type DayType = 'weekday' | 'weekend';

export const DEFAULT_PROFILE_ID = 'pune_hourly_profile_v1';
/** Peak when an hour carries at least this share of the busiest hour; Low below LOW_BELOW (as in the profile file). */
export const PEAK_AT = 0.8;
export const LOW_BELOW = 0.4;
/** Clock hours the counts may represent: the profile's weekday AM and PM peaks. */
export const COUNT_HOURS = { AM: 9, PM: 19 } as const;

export async function fetchDiurnalProfile(id = DEFAULT_PROFILE_ID): Promise<DiurnalProfile> {
  const doc = await apiGet<DiurnalProfile>(`/api/diurnal-profile/${encodeURIComponent(id)}`);
  for (const d of ['weekday', 'weekend'] as const) {
    if (doc[d]?.hours?.length !== 24) throw new Error(`Diurnal profile ${id}: ${d} must have 24 hours`);
  }
  return doc;
}

const shareAt = (p: DiurnalProfile, hour: number, day: DayType) => p[day].hours[((Math.floor(hour) % 24) + 24) % 24].share;

/**
 * Demand at `hour` relative to the count hour (a weekday hour: the hour the
 * calibrated plan represents). Shares are per day type, so a weekend hour is
 * also scaled by the weekend/weekday daily volume ratio.
 */
export function hourFactor(p: DiurnalProfile, hour: number, countHour: number, day: DayType = 'weekday'): number {
  const ref = shareAt(p, countHour, 'weekday');
  const daily = day === 'weekend' ? p.weekend_daily_vs_weekday ?? 1 : 1;
  return ref > 0 ? (shareAt(p, hour, day) * daily) / ref : 0;
}

/** Peak / Moderate / Low from the thresholds on the busiest hour of that day type. */
export function periodOf(p: DiurnalProfile, hour: number, day: DayType = 'weekday'): TrafficPeriod {
  const max = Math.max(...p[day].hours.map(h => h.share));
  const r = shareAt(p, hour, day) / max;
  return r >= PEAK_AT ? 'Peak' : r < LOW_BELOW ? 'Low' : 'Moderate';
}

export const isMeasured = (p: DiurnalProfile, hour: number, day: DayType = 'weekday') => p[day].hours[((Math.floor(hour) % 24) + 24) % 24].measured;
export const hourLabel = (h: number) => `${String(((h % 24) + 24) % 24).padStart(2, '0')}:00`;

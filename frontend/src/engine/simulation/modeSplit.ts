import type { BuildingActivityProfile, BuildingObject } from '../objects/types';
import type { ModeSplit, TimePeriod } from '../objects/demandTypes';

export const MODE_SPLIT_KEYS = ['car', 'twoWheeler', 'bus', 'metro', 'walking', 'other'] as const;

/**
 * Sets one share of a distribution and rescales the others proportionally so
 * the total stays exactly `total` (100 for percentages). Values are kept as
 * integers of `total / 100` steps using largest-remainder rounding.
 */
export function rebalanceSplit<K extends string>(
  split: Partial<Record<K, number>>,
  keys: readonly K[],
  changed: K,
  value: number,
  total = 100
): Record<K, number> {
  const unit = total / 100; // work in whole percent steps
  const target = Math.round(Math.max(0, Math.min(100, (Number(value) || 0) / unit)));
  const others = keys.filter(k => k !== changed);
  const remaining = 100 - target;
  const otherSum = others.reduce((s, k) => s + Math.max(0, (split[k] ?? 0) / unit), 0);

  const raw = others.map(k => {
    const share = otherSum > 0 ? Math.max(0, (split[k] ?? 0) / unit) / otherSum : 1 / others.length;
    return { k, exact: share * remaining };
  });
  const floored = raw.map(r => ({ ...r, int: Math.floor(r.exact) }));
  let leftover = remaining - floored.reduce((s, r) => s + r.int, 0);
  [...floored]
    .sort((a, b) => (b.exact - b.int) - (a.exact - a.int))
    .forEach(r => {
      if (leftover > 0) {
        r.int += 1;
        leftover -= 1;
      }
    });

  const result = { [changed]: target * unit } as Record<K, number>;
  floored.forEach(r => {
    result[r.k] = r.int * unit;
  });
  return result;
}

/**
 * Converts a building Activity Profile's percentage split into model fractions.
 * The panel stores walking as `walk`; the model uses `walking`. Returns null when
 * no split has been entered. Totals other than 100 are normalised.
 */
export function profileModeSplitToFractions(ms: BuildingActivityProfile['modeSplit']): ModeSplit | null {
  if (!ms) return null;
  const pct = {
    car: ms.car ?? 0,
    twoWheeler: ms.twoWheeler ?? 0,
    bus: ms.bus ?? 0,
    metro: ms.metro ?? 0,
    walking: ms.walk ?? 0,
    other: ms.other ?? 0,
  };
  const sum = Object.values(pct).reduce((s, v) => s + Math.max(0, v), 0);
  if (sum <= 0) return null;
  return {
    car: Math.max(0, pct.car) / sum,
    twoWheeler: Math.max(0, pct.twoWheeler) / sum,
    bus: Math.max(0, pct.bus) / sum,
    metro: Math.max(0, pct.metro) / sum,
    walking: Math.max(0, pct.walking) / sum,
    other: Math.max(0, pct.other) / sum,
  };
}

/** Maps a clock time ("HH:MM") to the model's time period, or null if unset/invalid. */
export function timeToPeriod(time?: string): TimePeriod | null {
  if (!time) return null;
  const m = /^(\d{1,2}):(\d{2})/.exec(time);
  if (!m) return null;
  const hour = Number(m[1]);
  if (hour < 0 || hour > 23) return null;
  if (hour >= 7 && hour < 11) return 'AM_Peak';
  if (hour >= 11 && hour < 16) return 'Midday';
  if (hour >= 16 && hour < 21) return 'PM_Peak';
  return 'Night';
}

/** Share of daily trips falling in each period (used when no explicit peak count is given). */
export const PERIOD_SHARE: Record<TimePeriod, number> = {
  AM_Peak: 0.35,
  PM_Peak: 0.40,
  Midday: 0.15,
  Night: 0.10,
};

const RESIDENT_DAILY_TRIP_RATE = 2.0;
const EMPLOYEE_DAILY_TRIP_RATE = 1.5;

export interface BuildingTripEvent {
  role: 'origin' | 'destination';
  period: TimePeriod;
  trips: number;
  modeSplit: ModeSplit;
}

/** True when the building's Activity Profile changes its trips (not just its mode split). */
export function hasTripOverrides(b: BuildingObject): boolean {
  const p = b.activityProfile;
  if (!p) return false;
  const gen = p.tripGeneration;
  return !!(
    timeToPeriod(p.peakArrivalStart) ||
    timeToPeriod(p.peakDepartureStart) ||
    (gen && ((gen.dailyTrips ?? 0) > 0 || (gen.amPeakTrips ?? 0) > 0 || (gen.pmPeakTrips ?? 0) > 0))
  );
}

/**
 * Trips a building produces (origin) and attracts (destination) per period.
 *
 * Without an Activity Profile: residents leave in the AM peak and return in the
 * PM peak; employees do the reverse (2.0 and 1.5 daily trips per person).
 *
 * With a profile: the peak departure/arrival start times choose the periods;
 * daily trips, or explicit AM/PM peak counts, set the volumes; the mode split
 * replaces the default.
 */
export function resolveBuildingTripEvents(b: BuildingObject, defaultSplit: ModeSplit): BuildingTripEvent[] {
  const profile = b.activityProfile;
  const modeSplit = profileModeSplitToFractions(profile?.modeSplit) ?? defaultSplit;
  const residents = Math.max(0, b.residents ?? 0);
  const employees = Math.max(0, b.employees ?? 0);
  const events: BuildingTripEvent[] = [];

  if (!hasTripOverrides(b)) {
    if (residents > 0) {
      const daily = residents * RESIDENT_DAILY_TRIP_RATE;
      events.push({ role: 'origin', period: 'AM_Peak', trips: daily * PERIOD_SHARE.AM_Peak, modeSplit });
      events.push({ role: 'destination', period: 'PM_Peak', trips: daily * PERIOD_SHARE.PM_Peak, modeSplit });
    }
    if (employees > 0) {
      const daily = employees * EMPLOYEE_DAILY_TRIP_RATE;
      events.push({ role: 'destination', period: 'AM_Peak', trips: daily * PERIOD_SHARE.AM_Peak, modeSplit });
      events.push({ role: 'origin', period: 'PM_Peak', trips: daily * PERIOD_SHARE.PM_Peak, modeSplit });
    }
    return events;
  }

  const gen = profile!.tripGeneration ?? {};
  // Mostly-residential buildings default to leaving in the morning; workplaces to arriving
  const residential = residents >= employees;
  const departure = timeToPeriod(profile!.peakDepartureStart) ?? (residential ? 'AM_Peak' : 'PM_Peak');
  const arrival = timeToPeriod(profile!.peakArrivalStart) ?? (residential ? 'PM_Peak' : 'AM_Peak');
  const daily = (gen.dailyTrips ?? 0) > 0
    ? gen.dailyTrips!
    : residents * RESIDENT_DAILY_TRIP_RATE + employees * EMPLOYEE_DAILY_TRIP_RATE;

  const tripsIn = (period: TimePeriod): number => {
    if (period === 'AM_Peak' && (gen.amPeakTrips ?? 0) > 0) return gen.amPeakTrips!;
    if (period === 'PM_Peak' && (gen.pmPeakTrips ?? 0) > 0) return gen.pmPeakTrips!;
    return daily * PERIOD_SHARE[period];
  };

  const out = tripsIn(departure);
  const inbound = tripsIn(arrival);
  if (out > 0) events.push({ role: 'origin', period: departure, trips: out, modeSplit });
  if (inbound > 0) events.push({ role: 'destination', period: arrival, trips: inbound, modeSplit });
  return events;
}

import type { VehicleKind } from './TrafficMicroSim';

/**
 * Real Pune / PCMC travel rates used to turn building and zone activity into
 * peak-hour VEHICLE trips (the micro-simulation moves vehicles, not people).
 *
 * Before these were applied, the study demand used 2.0 daily trips per
 * resident, put 35-40% of a day's trips into a single peak hour, and counted
 * every bus passenger as a vehicle: about 20x the real peak-hour vehicle flow,
 * which gridlocked the Wakad area.
 *
 * Sources
 *  - CMP 2018: Updation/Revision of Comprehensive Mobility Plan for Pune
 *    Metropolitan Region, Final Report (2018), Exec. Summary Table 6 (per capita
 *    trip rates) and Table 7 (mode-wise distribution of motorised trips), and
 *    p. E-5 (inner-cordon peak-hour share 6.1-9.5%, average 7.8%).
 *    https://www.punemetrorail.org/download/Updation%20of%20CMP%20for%20PMR.pdf
 *  - CMP 2008: Comprehensive Mobility Plan for Pune City (PMC, 2008), Table 4.7 /
 *    Figure 4.5, average occupancy by vehicle type at the outer cordon.
 *    https://data.opencity.in/dataset/pune-comprehensive-mobility-plan
 *  - PMPML: about 1.06 million passengers on about 20,000 bus trips a day
 *    (Pune CMP 2024, reported by Down To Earth, 30 Jun 2025).
 *    https://www.downtoearth.org.in/air/how-india-moves-punes-roads-buckle-under-an-explosion-of-two-wheeler-traffic
 */
export const PUNE_TRIP_RATES = {
  /** Motorised trips per person per day, PCMC (CMP 2018 Table 6). Wakad/Hinjewadi lie in PCMC/PMR. */
  motorisedTripsPerResident: 0.87,
  /** All-mode trips per person per day, PCMC (CMP 2018 Table 6). */
  allTripsPerResident: 1.17,
  /** Share of a day's traffic in the peak hour: CMP 2018 inner-cordon average, also the profile's weekday peak (backend/data/diurnal). */
  peakHourShare: 0.078,
  /** Motorised mode shares, PCMC (CMP 2018 Table 7); company/school bus counted with bus. */
  motorisedSplit: { two_wheeler: 0.5052, auto: 0.1863, car: 0.1634, bus: 0.1275 + 0.0176 } as Partial<Record<VehicleKind, number>>,
  /** Persons per vehicle (CMP 2008 outer-cordon averages: car 2.9, two-wheeler 1.6, auto 3.8; bus: 1.06M passengers / 20,000 trips). */
  occupancy: { two_wheeler: 1.6, auto: 3.8, car: 2.9, bus: 53 } as Partial<Record<VehicleKind, number>>,
} as const;

/** Vehicles per motorised person-trip under the PCMC split and occupancies (~0.42). */
export function vehiclesPerMotorisedTrip(): number {
  let v = 0;
  for (const [k, share] of Object.entries(PUNE_TRIP_RATES.motorisedSplit)) v += (share ?? 0) / (PUNE_TRIP_RATES.occupancy[k as VehicleKind] ?? 1);
  return v;
}

/**
 * Peak-hour vehicle trips by class for `motorisedTrips` motorised person-trips
 * in the peak hour, under the PCMC split and occupancies.
 */
export function vehicleTripsByClass(motorisedTrips: number): [VehicleKind, number][] {
  return Object.entries(PUNE_TRIP_RATES.motorisedSplit).map(([k, share]) =>
    [k as VehicleKind, motorisedTrips * (share ?? 0) / (PUNE_TRIP_RATES.occupancy[k as VehicleKind] ?? 1)]);
}

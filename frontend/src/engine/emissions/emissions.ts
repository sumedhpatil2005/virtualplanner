/**
 * Fuel and emissions of a run (docs/ODME_AND_EMISSIONS.md):
 *  1. Corridor micro-simulation: per vehicle, per 0.25 s step, from its speed and acceleration
 *     (hbefa4.ts), idling included; accumulated over the measured window only.
 *  2. Area cross-check: ARAI (2007) cycle-average g/km × vehicle-km of the area assignment by class.
 *     Distance-based, so it cannot tell smooth from stop-start traffic; shown SEPARATELY, never mixed
 *     with (1) and never used for scenario deltas.
 * Every value is ESTIMATED; units are in the field names or the `units` record.
 */
import type { VehicleKind } from '../simulation/TrafficMicroSim';
import { HBEFA4_CLASSES, CLASS_OF_KIND, POLLUTANTS, rate, HBEFA4_SOURCE, type Pollutant } from './hbefa4';

export interface ClassTotals {
  /** Grams over the window. fuel in grams too (fuelL = litres). */
  co2G: number; coG: number; hcG: number; fuelG: number; noxG: number; pmG: number;
  fuelL: number;
  /** Vehicle-seconds on the network, of which standing still (v ≤ 0.1 m/s). */
  vehS: number; idleS: number;
  /** Fuel burnt while standing still (g). */
  idleFuelG: number;
  /** Vehicle-km driven. */
  vkm: number;
}

const emptyTotals = (): ClassTotals => ({ co2G: 0, coG: 0, hcG: 0, fuelG: 0, noxG: 0, pmG: 0, fuelL: 0, vehS: 0, idleS: 0, idleFuelG: 0, vkm: 0 });
const KEY: Record<Pollutant, keyof ClassTotals> = { co2: 'co2G', co: 'coG', hc: 'hcG', fuel: 'fuelG', nox: 'noxG', pm: 'pmG' };

/** Per-vehicle-step accumulator (one per seed run). */
export class EmissionAccumulator {
  readonly byKind = new Map<VehicleKind, ClassTotals>();
  windowS = 0;
  /** Adds one vehicle over one step: speed v (m/s) at the end of the step, acceleration a (m/s²) over it, step dt (s). */
  add(kind: VehicleKind, v: number, a: number, dt: number) {
    const c = HBEFA4_CLASSES[CLASS_OF_KIND[kind]?.hbefa ?? 'PC_petrol_Euro-4'];
    const t = this.byKind.get(kind) ?? this.byKind.set(kind, emptyTotals()).get(kind)!;
    for (const p of POLLUTANTS) t[KEY[p]] += rate(c, p, v, a) * dt / 1000;
    const idle = v <= 0.1;
    t.vehS += dt;
    if (idle) { t.idleS += dt; t.idleFuelG += rate(c, 'fuel', v, a) * dt / 1000; }
    t.vkm += v * dt / 1000;
  }
  totals(): Map<VehicleKind, ClassTotals> {
    this.byKind.forEach((t, k) => { t.fuelL = t.fuelG / HBEFA4_CLASSES[CLASS_OF_KIND[k].hbefa].densityGPerL; });
    return this.byKind;
  }
}

export interface EmissionsSummary {
  model: typeof HBEFA4_SOURCE;
  /** Measured window (s) the totals cover, and the factor to an hour. */
  windowS: number;
  /** Mean over seeds, whole corridor, over the window. */
  total: ClassTotals;
  /** Same per hour (× 3600 / windowS). */
  perHour: ClassTotals;
  byKind: { kind: VehicleKind; hbefaClass: string; note: string; totals: ClassTotals }[];
  /** Per seed (for spread and seed agreement in comparisons). */
  perSeed: { seed: number; fuelL: number; co2G: number; noxG: number; pmG: number }[];
  units: Record<string, string>;
  label: string;
}

const addInto = (a: ClassTotals, b: ClassTotals, w = 1) => { (Object.keys(a) as (keyof ClassTotals)[]).forEach(k => { a[k] += b[k] * w; }); };
export const sumTotals = (list: Iterable<ClassTotals>) => { const t = emptyTotals(); for (const x of list) addInto(t, x); return t; };

/** Mean of several seed runs' accumulators. */
export function summarizeEmissions(runs: { seed: number; acc: EmissionAccumulator }[]): EmissionsSummary | null {
  if (!runs.length) return null;
  const windowS = runs[0].acc.windowS;
  const kinds = new Map<VehicleKind, ClassTotals>();
  const perSeed: EmissionsSummary['perSeed'] = [];
  for (const r of runs) {
    const t = r.acc.totals();
    t.forEach((v, k) => addInto(kinds.get(k) ?? kinds.set(k, emptyTotals()).get(k)!, v, 1 / runs.length));
    const s = sumTotals(t.values());
    perSeed.push({ seed: r.seed, fuelL: s.fuelL, co2G: s.co2G, noxG: s.noxG, pmG: s.pmG });
  }
  const total = sumTotals(kinds.values());
  const perHour = emptyTotals();
  addInto(perHour, total, windowS > 0 ? 3600 / windowS : 0);
  return {
    model: HBEFA4_SOURCE, windowS, total, perHour,
    byKind: [...kinds].map(([kind, totals]) => ({ kind, hbefaClass: CLASS_OF_KIND[kind].hbefa, note: CLASS_OF_KIND[kind].standIn, totals })),
    perSeed,
    units: { fuel: 'L (and g)', co2: 'kg', nox: 'g', pm: 'g (PM10 incl. non-exhaust, as HBEFA4/SUMO)', idle: 'veh·s at ≤ 0.1 m/s', vkm: 'veh·km' },
    label: 'ESTIMATED. Corridor micro-simulation, measured window, mean of seeds. Speed- and acceleration-based (SUMO HBEFA4), idling included. European vehicle classes as stand-ins; two-wheelers and auto-rickshaws especially uncertain.',
  };
}

// ── ARAI (2007) area cross-check ────────────────────────────────────────────

/**
 * ARAI, "Emission Factor development for Indian Vehicles", Project Rep. AFL/2006-07/IOCL/Emission Factor
 * Project/Final Rep, 17 Aug 2007, Table I (summary of finalised emission factors, g/km), opened 2026-11-11 at
 * http://learning-cleanairasia.org/lms/library/ga2/07-Air-Quality-Monitoring-Project-Indian-Clean-Air-Programme-(ICAP).pdf
 * Row chosen per app class (an app assumption; the newest vintage the table has for the category):
 *   two_wheeler: Sr 20 motorcycle 4-stroke 100–200 cc, post-2000: CO2 24.82, NOx 0.54, PM not reported
 *   car:        Sr 37 passenger car petrol 1000–1400 cc, post-2000 (MIDC): CO2 126.50, NOx 0.12, PM 0.006
 *   auto:       Sr 30 three-wheeler CNG OEM 4-stroke <200 cc, post-2000: CO2 77.70, NOx 0.50, PM 0.015
 *   bus:        Sr 59 HCV diesel bus >6000 cc, post-2005: CO2 602.01, NOx 6.53, PM 0.300
 *   truck:      Sr 62 HCV diesel truck >6000 cc, post-2000: CO2 762.39, NOx 9.30, PM 1.240
 *   bus_auto:   Sr 55 LCV diesel >3000 cc, post-2000: CO2 401.25, NOx 2.12, PM 0.475
 * The report gives no fuel consumption, so none is derived here. Factors are cycle averages (Indian Driving
 * Cycle / Modified IDC), pre-date BS-IV/BS-VI, and rest on small samples ("only one vehicle for some categories").
 */
export const ARAI_2007: Record<VehicleKind, { row: number; category: string; co2: number; nox: number; pm: number | null }> = {
  two_wheeler: { row: 20, category: 'Motorcycle 4S 100–200 cc, post-2000', co2: 24.82, nox: 0.54, pm: null },
  car: { row: 37, category: 'Passenger car petrol 1000–1400 cc, post-2000 (MIDC)', co2: 126.50, nox: 0.12, pm: 0.006 },
  auto: { row: 30, category: 'Three-wheeler CNG OEM 4S <200 cc, post-2000', co2: 77.70, nox: 0.50, pm: 0.015 },
  bus: { row: 59, category: 'HCV diesel bus >6000 cc, post-2005', co2: 602.01, nox: 6.53, pm: 0.300 },
  truck: { row: 62, category: 'HCV diesel truck >6000 cc, post-2000', co2: 762.39, nox: 9.30, pm: 1.240 },
  bus_auto: { row: 55, category: 'LCV diesel >3000 cc, post-2000', co2: 401.25, nox: 2.12, pm: 0.475 },
};
export const ARAI_SOURCE = { report: 'ARAI (2007) Emission Factor development for Indian Vehicles, Table I', url: 'http://learning-cleanairasia.org/lms/library/ga2/07-Air-Quality-Monitoring-Project-Indian-Clean-Air-Programme-(ICAP).pdf' };

export interface AraiAreaEstimate {
  source: typeof ARAI_SOURCE;
  /** Per hour at the run's hour, whole study area (assignment). */
  vkmPerHour: number;
  co2KgPerHour: number;
  noxGPerHour: number;
  /** PM of the classes ARAI reports PM for; null when none. */
  pmGPerHour: number | null;
  pmMissingKinds: VehicleKind[];
  byKind: { kind: VehicleKind; vkm: number; row: number; category: string }[];
  label: string;
}

/** ARAI g/km × vehicle-km per class (area assignment, veh/h × km = veh·km per hour). */
export function araiAreaEstimate(vkmByKind: ReadonlyMap<VehicleKind, number>): AraiAreaEstimate {
  let vkm = 0, co2 = 0, nox = 0, pm = 0, anyPm = false;
  const missing: VehicleKind[] = [], byKind: AraiAreaEstimate['byKind'] = [];
  vkmByKind.forEach((km, kind) => {
    const f = ARAI_2007[kind];
    if (!f || km <= 0) return;
    vkm += km; co2 += f.co2 * km; nox += f.nox * km;
    if (f.pm === null) missing.push(kind); else { pm += f.pm * km; anyPm = true; }
    byKind.push({ kind, vkm: km, row: f.row, category: f.category });
  });
  return { source: ARAI_SOURCE, vkmPerHour: vkm, co2KgPerHour: co2 / 1000, noxGPerHour: nox, pmGPerHour: anyPm ? pm : null, pmMissingKinds: missing, byKind,
    label: 'CROSS-CHECK ONLY. Distance × Indian cycle-average factors (ARAI 2007) over the whole study area\'s assigned traffic. Cannot reflect acceleration, idling or congestion; old vintages, small samples. Not comparable one-to-one with the corridor figures (different area and method).' };
}

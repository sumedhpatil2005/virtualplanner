/**
 * Instantaneous fuel and emissions per vehicle from speed and acceleration:
 * SUMO's HBEFA4-based model (HBEFA 4.2 fitted to continuous functions; SUMO's default
 * emission model since 1.23.0).
 *
 * Sources (opened 2026-11-11):
 *  - Model description and fit errors per class: https://sumo.dlr.de/docs/Models/Emissions/HBEFA4-based.html
 *    (docs/web/docs/Models/Emissions/HBEFA4-based.md in eclipse-sumo/sumo)
 *  - Functional form and coefficients: src/utils/emissions/HelpersHBEFA4.h / HelpersHBEFA4.cpp,
 *    https://github.com/eclipse-sumo/sumo (main; HelpersHBEFA4.cpp last changed in commit
 *    7a4786a1ff8875a87d691f08c6a7f9b035a21c97, 2026-01-09). Coefficients below are copied verbatim.
 *  - Coasting rule: PollutantsInterface::Helper::getCoastingDecel (src/utils/emissions/PollutantsInterface.cpp),
 *    with SPEED_DCEL_MIN = 10/3.6 m/s (PHEMlight V5 Constants.cpp), ZERO_SPEED_ACCURACY = 0.1 m/s
 *    (PHEMConstants.h), vehicle mass and frontal area = SUMO vClass defaults (SUMOVTypeParameter.cpp,
 *    SUMOVehicleClass.cpp: passenger 1500 kg, 1.8 x 1.5 m; motorcycle 200 kg, 0.9 x 1.5 m; bus 12000 kg,
 *    2.5 x 3.4 m; truck 4500 kg, 2.4 x 2.4 m; delivery 5000 kg, 2.16 x 2.86 m; area = w h π / 4).
 *  - Fuel density (volumetric fuel): SUMO uses 742 g/L for petrol and 836 g/L for diesel (HelpersHBEFA4.h).
 *
 * Form (HelpersHBEFA4::compute, flat road, engine running):
 *   E(v, a) = max(0, f0 + f1 v + f2 a + f3 v² + f4 v³ + f5 a v + f6 a v²)   [mg/s; v m/s, a m/s²]
 *   = 0 while coasting: v > 0.1 m/s and a < coastingDecel(v)
 * At a standstill (v ≤ 0.1 m/s) the coasting rule does not apply, so a stopped vehicle burns f0
 * (idling; SUMO's default, engines are not switched off at stops).
 *
 * STAND-INS (no Indian class exists in HBEFA): every class below is a European vehicle segment chosen
 * by the app as the nearest available, NOT calibrated for Indian vehicles. Two-wheelers and
 * auto-rickshaws are the weakest: two-wheelers use HBEFA's 4-stroke motorcycle ≤250 cc; auto-rickshaws
 * (three-wheelers, often CNG in Indian cities) have no HBEFA class at all and use the same motorcycle
 * ≤250 cc segment (engine size; a heavier body and CNG fuel are not represented). Euro-4/IV vintage is an
 * app assumption for every class (Pune's fleet vintage mix is unknown).
 */
import type { VehicleKind } from '../simulation/TrafficMicroSim';

export const POLLUTANTS = ['co2', 'co', 'hc', 'fuel', 'nox', 'pm'] as const;
export type Pollutant = typeof POLLUTANTS[number];

/** One HBEFA4 class: 6 rows (CO2, CO, HC, FC, NOx, PM incl. non-exhaust) x 7 coefficients, from HelpersHBEFA4.cpp. */
export interface HbefaClass {
  name: string;
  fuel: 'Gasoline' | 'Diesel';
  /** g/L, as SUMO uses for volumetric fuel. */
  densityGPerL: number;
  massKg: number;
  frontAreaM2: number;
  coef: Record<Pollutant, readonly number[]>;
  /** SUMO docs fit error for FC (fleet-share table). */
  fitErrorFc: string;
}

const area = (w: number, h: number) => w * h * Math.PI / 4;

export const HBEFA4_CLASSES: Record<string, HbefaClass> = {
  'PC_petrol_Euro-4': {
    name: 'PC_petrol_Euro-4', fuel: 'Gasoline', densityGPerL: 742, massKg: 1500, frontAreaM2: area(1.8, 1.5), fitErrorFc: '4.32%',
    coef: {
      co2: [1.521e+03, 1.559e+01, 6.951e+02, 0.000e+00, 1.199e-01, 1.325e+02, 3.434e+00],
      co: [0.000e+00, 0.000e+00, 0.000e+00, 0.000e+00, 3.059e-03, 0.000e+00, 1.832e-01],
      hc: [0.000e+00, 0.000e+00, 0.000e+00, 0.000e+00, 2.132e-05, 0.000e+00, 1.202e-03],
      fuel: [4.931e+02, 5.054e+00, 2.253e+02, 0.000e+00, 3.887e-02, 4.296e+01, 1.113e+00],
      nox: [6.117e-01, 0.000e+00, 0.000e+00, 0.000e+00, 5.485e-05, 4.339e-02, 2.726e-03],
      pm: [0.000e+00, 2.589e-02, 0.000e+00, 1.229e-04, 5.704e-06, 0.000e+00, 3.620e-04],
    },
  },
  'MC_4S_le250cc_Euro-4': {
    name: 'MC_4S_le250cc_Euro-4', fuel: 'Gasoline', densityGPerL: 742, massKg: 200, frontAreaM2: area(0.9, 1.5), fitErrorFc: '2.42%',
    coef: {
      co2: [2.285e+02, 1.167e+01, 1.939e+02, 0.000e+00, 5.939e-02, 3.960e-01, 1.255e+00],
      co: [0.000e+00, 0.000e+00, 0.000e+00, 0.000e+00, 2.898e-03, 0.000e+00, 4.835e-02],
      hc: [0.000e+00, 2.555e-03, 0.000e+00, 4.321e-03, 0.000e+00, 0.000e+00, 1.378e-03],
      fuel: [7.408e+01, 3.784e+00, 6.284e+01, 0.000e+00, 1.925e-02, 1.284e-01, 4.067e-01],
      nox: [0.000e+00, 3.025e-02, 3.726e-01, 0.000e+00, 0.000e+00, 0.000e+00, 0.000e+00],
      pm: [2.402e-01, 1.589e-03, 1.454e-01, 0.000e+00, 0.000e+00, 2.718e-03, 0.000e+00],
    },
  },
  'UBus_Std_gt15-18t_Euro-IV_SCR': {
    name: 'UBus_Std_gt15-18t_Euro-IV_SCR', fuel: 'Diesel', densityGPerL: 836, massKg: 12000, frontAreaM2: area(2.5, 3.4), fitErrorFc: '18.57%',
    coef: {
      co2: [2.773e+03, 7.057e+02, 2.134e+03, 0.000e+00, 0.000e+00, 1.728e+03, 0.000e+00],
      co: [2.754e+01, 0.000e+00, 4.827e+01, 0.000e+00, 0.000e+00, 0.000e+00, 0.000e+00],
      hc: [1.442e-01, 3.058e-03, 1.727e-01, 9.535e-04, 0.000e+00, 0.000e+00, 1.713e-03],
      fuel: [8.911e+02, 2.268e+02, 6.858e+02, 0.000e+00, 0.000e+00, 5.554e+02, 0.000e+00],
      nox: [3.281e+01, 1.038e+00, 0.000e+00, 2.942e-02, 0.000e+00, 3.610e+00, 8.450e-02],
      pm: [1.992e+00, 8.294e-04, 6.590e-01, 0.000e+00, 1.475e-04, 1.646e-02, 6.752e-05],
    },
  },
  'RT_le7.5t_Euro-IV_SCR': {
    name: 'RT_le7.5t_Euro-IV_SCR', fuel: 'Diesel', densityGPerL: 836, massKg: 4500, frontAreaM2: area(2.4, 2.4), fitErrorFc: '5.73%',
    coef: {
      co2: [2.073e+03, 0.000e+00, 0.000e+00, 1.642e+01, 4.710e-02, 5.527e+02, 1.323e+01],
      co: [1.038e+01, 5.021e-01, 2.514e+01, 0.000e+00, 0.000e+00, 0.000e+00, 0.000e+00],
      hc: [5.168e-02, 5.245e-03, 0.000e+00, 0.000e+00, 7.439e-06, 1.572e-02, 6.593e-06],
      fuel: [6.662e+02, 0.000e+00, 0.000e+00, 5.277e+00, 1.514e-02, 1.776e+02, 4.252e+00],
      nox: [2.024e+01, 0.000e+00, 0.000e+00, 1.517e-03, 1.760e-03, 1.009e+00, 4.956e-02],
      pm: [1.598e+00, 1.237e-02, 4.685e-01, 0.000e+00, 1.268e-04, 0.000e+00, 1.330e-04],
    },
  },
  'LCV_diesel_M+N1-I_Euro-4': {
    name: 'LCV_diesel_M+N1-I_Euro-4', fuel: 'Diesel', densityGPerL: 836, massKg: 5000, frontAreaM2: area(2.16, 2.86), fitErrorFc: '7.97%',
    coef: {
      co2: [9.648e+02, 2.843e+01, 4.683e+02, 0.000e+00, 1.068e-01, 1.117e+02, 4.959e+00],
      co: [5.395e-01, 0.000e+00, 4.476e-01, 0.000e+00, 0.000e+00, 0.000e+00, 0.000e+00],
      hc: [1.336e-01, 3.571e-04, 2.331e-02, 1.008e-04, 2.410e-06, 5.449e-03, 0.000e+00],
      fuel: [3.101e+02, 9.138e+00, 1.505e+02, 0.000e+00, 3.431e-02, 3.590e+01, 1.594e+00],
      nox: [7.716e+00, 0.000e+00, 0.000e+00, 0.000e+00, 2.385e-03, 4.265e-01, 1.237e-01],
      pm: [3.279e-01, 4.336e-02, 1.415e-01, 1.274e-04, 2.055e-05, 4.141e-02, 4.848e-06],
    },
  },
};

/** App vehicle kind → HBEFA4 class, and whether it is a stand-in (all are European segments; see header). */
export const CLASS_OF_KIND: Record<VehicleKind, { hbefa: string; standIn: string }> = {
  two_wheeler: { hbefa: 'MC_4S_le250cc_Euro-4', standIn: 'STAND-IN: European 4-stroke motorcycle ≤250 cc; not calibrated for Indian two-wheelers' },
  car: { hbefa: 'PC_petrol_Euro-4', standIn: 'European petrol car Euro-4 (fuel mix and vintage assumed)' },
  auto: { hbefa: 'MC_4S_le250cc_Euro-4', standIn: 'STAND-IN: no three-wheeler class in HBEFA; motorcycle ≤250 cc used (body weight and CNG not represented)' },
  bus: { hbefa: 'UBus_Std_gt15-18t_Euro-IV_SCR', standIn: 'European diesel city bus 15–18 t Euro-IV (fuel and vintage assumed)' },
  truck: { hbefa: 'RT_le7.5t_Euro-IV_SCR', standIn: 'European diesel rigid truck ≤7.5 t Euro-IV (assumed)' },
  bus_auto: { hbefa: 'LCV_diesel_M+N1-I_Euro-4', standIn: 'STAND-IN: European diesel light commercial vehicle Euro-4 for a shared minibus' },
};

const GRAVITY = 9.80665;
const ZERO_SPEED_ACCURACY = 0.1;
const SPEED_DCEL_MIN = 10 / 3.6;

/** SUMO PollutantsInterface::Helper::getCoastingDecel on a flat road (m/s², ≤ 0). */
export function coastingDecel(c: HbefaClass, v: number): number {
  if (v < SPEED_DCEL_MIN) return (v / SPEED_DCEL_MIN) * coastingDecel(c, SPEED_DCEL_MIN);
  const incl = (c.frontAreaM2 / c.massKg) * -9.05337017 + -0.00017774;
  return Math.min(0, incl * v + 0.00001066 * c.massKg + -0.38347107 - 20.0 * incl);
}

/** Emission rate (mg/s) of one pollutant at speed v (m/s) and acceleration a (m/s²), flat road. */
export function rate(c: HbefaClass, p: Pollutant, v: number, a: number, slopeDeg = 0): number {
  if (v > ZERO_SPEED_ACCURACY && a < coastingDecel(c, v)) return 0;
  const a2 = a + GRAVITY * Math.sin(slopeDeg * Math.PI / 180);
  const f = c.coef[p];
  return Math.max(0, f[0] + f[1] * v + f[2] * a2 + f[3] * v * v + f[4] * v * v * v + f[5] * a2 * v + f[6] * a2 * v * v);
}

export const HBEFA4_SOURCE = {
  model: 'SUMO HBEFA4-based instantaneous model (HBEFA 4.2), speed and acceleration',
  url: 'https://sumo.dlr.de/docs/Models/Emissions/HBEFA4-based.html',
  code: 'https://github.com/eclipse-sumo/sumo/blob/7a4786a1ff8875a87d691f08c6a7f9b035a21c97/src/utils/emissions/HelpersHBEFA4.cpp',
};

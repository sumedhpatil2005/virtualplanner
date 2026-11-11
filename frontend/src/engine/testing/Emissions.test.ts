/**
 * Fuel and emissions (emissions/hbefa4.ts, emissions/emissions.ts). Trajectories are SYNTHETIC.
 * Mission §13: fuel must depend on speed, acceleration and idling, not distance alone.
 */
import { describe, it, expect } from 'vitest';
import { HBEFA4_CLASSES, CLASS_OF_KIND, rate, coastingDecel } from '../emissions/hbefa4';
import { EmissionAccumulator, summarizeEmissions, sumTotals, araiAreaEstimate, ARAI_2007 } from '../emissions/emissions';
import type { VehicleKind } from '../simulation/TrafficMicroSim';

const car = HBEFA4_CLASSES['PC_petrol_Euro-4'];

/** Drives a SYNTHETIC speed profile (m/s per 0.25 s step) through an accumulator. */
function drive(kind: VehicleKind, speeds: number[], dt = 0.25) {
  const acc = new EmissionAccumulator();
  let prev = speeds[0];
  for (const v of speeds) { acc.add(kind, v, (v - prev) / dt, dt); prev = v; }
  acc.windowS = speeds.length * dt;
  return acc;
}

describe('HBEFA4-based instantaneous model (SUMO coefficients)', () => {
  it('matches a hand computation from the published coefficients (PC petrol Euro-4, fuel, 50 km/h steady)', () => {
    const v = 50 / 3.6;
    // f0 + f1 v + f4 v³ (a = 0; f3 = 0): 493.1 + 5.054 v + 0.03887 v³ mg/s
    const hand = 493.1 + 5.054 * v + 0.03887 * v ** 3;
    expect(rate(car, 'fuel', v, 0)).toBeCloseTo(hand, 9);
  });
  it('idling burns fuel and emits CO2 for every class (engine on at stops)', () => {
    for (const kind of Object.keys(CLASS_OF_KIND) as VehicleKind[]) {
      const c = HBEFA4_CLASSES[CLASS_OF_KIND[kind].hbefa];
      expect(rate(c, 'fuel', 0, 0)).toBeGreaterThan(0);
      expect(rate(c, 'co2', 0, 0)).toBeGreaterThan(0);
    }
    const idle = drive('car', new Array(240).fill(0));
    const t = idle.totals().get('car')!;
    expect(t.fuelG).toBeGreaterThan(0);
    expect(t.idleS).toBeCloseTo(60, 9);
    expect(t.idleFuelG).toBeCloseTo(t.fuelG, 9);
    expect(t.vkm).toBe(0);
  });
  it('acceleration increases fuel at the same speed', () => {
    for (const kind of ['car', 'two_wheeler', 'bus', 'truck'] as VehicleKind[]) {
      const c = HBEFA4_CLASSES[CLASS_OF_KIND[kind].hbefa];
      const v = 8;
      expect(rate(c, 'fuel', v, 1.0)).toBeGreaterThan(rate(c, 'fuel', v, 0));
      expect(rate(c, 'fuel', v, 0.5)).toBeGreaterThan(rate(c, 'fuel', v, 0));
    }
  });
  it('coasting (deceleration beyond the coasting limit while moving) gives zero, as in SUMO', () => {
    const v = 10;
    const d = coastingDecel(car, v);
    expect(d).toBeLessThan(0);
    expect(rate(car, 'fuel', v, d - 0.1)).toBe(0);
  });
  it('not distance-only: a stop-start trip burns more than a steady trip of the same distance and duration window', () => {
    // Steady 10 m/s for 100 s = 1,000 m
    const steady = new Array(400).fill(10);
    // Stop-start: accelerate 0→15 m/s at 1.5 m/s² (10 s), brake 15→0 at -3 m/s² (5 s), stand 5 s; repeat; trimmed to the same 1,000 m
    const ss: number[] = [];
    let dist = 0;
    while (dist < 1000) {
      for (let i = 1; i <= 40 && dist < 1000; i++) { const v = 1.5 * i * 0.25; ss.push(v); dist += v * 0.25; }
      for (let i = 1; i <= 20 && dist < 1000; i++) { const v = Math.max(0, 15 - 3 * i * 0.25); ss.push(v); dist += v * 0.25; }
      for (let i = 0; i < 20 && dist < 1000; i++) ss.push(0);
    }
    const a = drive('car', steady).totals().get('car')!, b = drive('car', ss).totals().get('car')!;
    expect(Math.abs(a.vkm - b.vkm)).toBeLessThan(0.01);
    expect(b.fuelG).toBeGreaterThan(a.fuelG);
    expect(b.co2G).toBeGreaterThan(a.co2G);
  });
  it('totals equal the sum of classes, per-hour scales by the window, and seeds are averaged', () => {
    const mk = (seed: number, f: number) => {
      const acc = new EmissionAccumulator();
      for (let i = 0; i < 400; i++) { acc.add('car', 10 * f, 0, 0.25); acc.add('two_wheeler', 8, 0.2, 0.25); acc.add('bus', 0, 0, 0.25); }
      acc.windowS = 100;
      return { seed, acc };
    };
    const s = summarizeEmissions([mk(1, 1), mk(2, 1.2)])!;
    const sum = sumTotals(s.byKind.map(k => k.totals));
    expect(s.total.fuelL).toBeCloseTo(sum.fuelL, 9);
    expect(s.total.co2G).toBeCloseTo(sum.co2G, 9);
    expect(s.perHour.co2G).toBeCloseTo(s.total.co2G * 36, 6);
    expect(s.total.fuelL).toBeCloseTo((s.perSeed[0].fuelL + s.perSeed[1].fuelL) / 2, 9);
    expect(s.byKind.find(k => k.kind === 'two_wheeler')!.note).toMatch(/STAND-IN/);
    expect(s.byKind.find(k => k.kind === 'car')!.totals.fuelL).toBeCloseTo(s.byKind.find(k => k.kind === 'car')!.totals.fuelG / 742, 9);
  });
});

describe('ARAI (2007) area cross-check', () => {
  it('is g/km × vehicle-km by class, with PM reported only for classes that have it', () => {
    const e = araiAreaEstimate(new Map<VehicleKind, number>([['car', 1000], ['two_wheeler', 2000]]));
    expect(e.co2KgPerHour).toBeCloseTo((1000 * ARAI_2007.car.co2 + 2000 * ARAI_2007.two_wheeler.co2) / 1000, 9);
    expect(e.pmGPerHour).toBeCloseTo(1000 * 0.006, 9);
    expect(e.pmMissingKinds).toEqual(['two_wheeler']);
    expect(e.label).toMatch(/CROSS-CHECK/);
  });
});

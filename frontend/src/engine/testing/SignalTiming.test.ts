/**
 * Webster signal timing against textbook examples, Indo-HCM saturation flow,
 * and the timing the simulator applies at a signalised crossroads.
 */
import { describe, it, expect } from 'vitest';
import { websterTiming, websterOptimumCycle, indoHcmUnitSaturationFlow, indoHcmSaturationFlow, STARTUP_LOST_S } from '../simulation/signalTiming';
import type { RoadObject } from '../objects/types';
import { StudyAreaExplorer } from '../simulation/StudyAreaExplorer';
import { TrafficMicroSim, SIGNAL_AMBER_S, SIGNAL_ALL_RED_S, STEP_S } from '../simulation/TrafficMicroSim';

describe('Webster optimum cycle', () => {
  it('reproduces the APSEd worked example: q = 400 and 250 veh/h, s = 1250 and 1000 veh/h, L = 16 s -> C0 = 67.44 s', () => {
    // https://www.apsed.in/post/traffic-signal-design-webster-s-formula-for-optimum-cycle-length
    const y = 400 / 1250 + 250 / 1000;
    expect(y).toBeCloseTo(0.57, 10);
    expect(websterOptimumCycle(16, y)).toBeCloseTo(67.44, 2);
  });

  it('reproduces the IRC-style exam example: Y = 0.50, L = 10 s -> C0 = 40 s', () => {
    // HPPSC AE 2016 (testbook): C0 = (1.5 x 10 + 5) / (1 - 0.5) = 40 s
    expect(websterOptimumCycle(10, 0.5)).toBeCloseTo(40, 10);
  });

  it('splits effective green in proportion to the flow ratios, and the phases add up to the cycle', () => {
    // Two phases, amber 3 s, all-red 2 s: L = 2 x (2 + 2) = 8 s (L = 2n + R, IJERA 9(4) 2019)
    const t = websterTiming([{ flow: 400, saturationFlow: 1250 }, { flow: 250, saturationFlow: 1000 }], { amberS: 3, allRedS: 2 });
    expect(t.lostTimeS).toBe(8);
    expect(t.optimumCycleS).toBeCloseTo((1.5 * 8 + 5) / (1 - 0.57), 6);
    expect(t.cycleS).toBe(Math.max(40, Math.round(t.optimumCycleS)));
    const eff = t.effectiveGreensS;
    expect(eff[0] / eff[1]).toBeCloseTo(0.32 / 0.25, 6);
    expect(eff[0] + eff[1]).toBeCloseTo(t.cycleS - t.lostTimeS, 6);
    // Displayed green = effective green - amber + start-up lost time (Mathew, NPTEL eq. 4)
    expect(t.greensS[0]).toBeCloseTo(eff[0] - 3 + STARTUP_LOST_S, 6);
    expect(t.greensS.reduce((a, g) => a + g + 3 + 2, 0)).toBeCloseTo(t.cycleS, 6);
    expect(t.oversaturated).toBe(false);
  });

  it('caps the cycle and reports oversaturation when the flow ratios sum past 0.9', () => {
    const t = websterTiming([{ flow: 900, saturationFlow: 1800 }, { flow: 800, saturationFlow: 1800 }], { amberS: 3, allRedS: 2, maxCycleS: 150 });
    expect(t.flowRatioSum).toBeGreaterThan(0.9);
    expect(t.oversaturated).toBe(true);
    expect(t.cycleS).toBe(150);
    expect(t.greensS[0]).toBeGreaterThan(t.greensS[1]);
  });

  it('gives a phase at least the minimum green', () => {
    const t = websterTiming([{ flow: 1000, saturationFlow: 1800 }, { flow: 10, saturationFlow: 1800 }], { amberS: 3, allRedS: 2, minGreenS: 7 });
    expect(Math.min(...t.greensS)).toBeGreaterThanOrEqual(7 - 1e-9);
    expect(t.greensS.reduce((a, g) => a + g + 5, 0)).toBeCloseTo(t.cycleS, 6);
  });
});

describe('Indo-HCM saturation flow', () => {
  it('uses the width-based unit base saturation flow', () => {
    expect(indoHcmUnitSaturationFlow(3.5)).toBe(630);
    expect(indoHcmUnitSaturationFlow(7)).toBe(1140 - 420);
    expect(indoHcmUnitSaturationFlow(10.5)).toBe(1140 - 630);
    expect(indoHcmUnitSaturationFlow(12)).toBe(500);
    expect(indoHcmSaturationFlow(7)).toBe(7 * 720);
  });
});

describe('Webster timing in the simulator', () => {
  const LAT0 = 18.5, M_LAT = 1 / 111320, M_LNG = 1 / (111320 * Math.cos((LAT0 * Math.PI) / 180));
  const pt = (x: number, y: number): [number, number, number] => [73.8 + x * M_LNG, LAT0 + y * M_LAT, 0];
  const road = (id: string, a: [number, number], b: [number, number]): RoadObject => ({
    id, type: 'road', name: id, layerId: 'roads', scenarioId: 'base', coordinates: [pt(...a), pt(...b)],
    roadClass: 'collector', width: 14, laneCount: 2, laneWidth: 3.5, hasDivider: false, dividerWidth: 0, hasFootpath: false, footpathWidth: 0,
    speedLimit: 50, isOneWay: false, trafficCapacity: 2000, connectedJunctions: [], createdAt: '', updatedAt: '',
  });
  const roads = [road('ew', [-400, 0], [400, 0]), road('ns', [0, -400], [0, 400]), road('ww', [-900, 0], [-400, 0]), road('ee', [400, 0], [900, 0]), road('ss', [0, -900], [0, -400]), road('nn', [0, 400], [0, 900])];
  const area = new StudyAreaExplorer().explore(roads, 1, { seedRoadIds: ['ew'], rangeMeters: 450, direction: 'both' });
  const map = new Map(roads.map(r => [r.id, r]));
  const signal = [pt(0, 0).slice(0, 2) as [number, number]];
  const nodeNear = (x: number, y: number) => {
    const [lng, lat] = pt(x, y);
    let best = '', d = Infinity;
    area.network.nodes.forEach(n => { const e = Math.hypot(n.coordinates[0] - lng, n.coordinates[1] - lat); if (e < d) { d = e; best = n.id; } });
    return best;
  };

  it('gives the busier approach the longer green, from the design flows', () => {
    const sim = new TrafficMicroSim(area, map, { demandLevel: 0, seed: 3, signalPoints: signal, signalTiming: 'webster' });
    const inbound = [...sim.debugLanes().keys()].filter(id => sim.signalStateOf(id) !== null);
    expect(inbound.length).toBe(4);
    // Observed design flows: the westbound approach (ending at the junction from the east) is the busiest
    const flows = new Map(inbound.map(id => [id, id.startsWith('ew') && id.endsWith('bwd') ? 900 : 200] as [string, number]));
    sim.setSignalDesignFlows(flows);
    const plan = sim.signalPlans()[0];
    expect(plan.flowRatioSum).toBeGreaterThan(0);
    const sat = indoHcmSaturationFlow(3.5); // one 3.5 m lane per approach
    const expected = websterTiming([900, 200, 200, 200].map(q => ({ flow: q, saturationFlow: sat })), { amberS: SIGNAL_AMBER_S, allRedS: SIGNAL_ALL_RED_S });
    expect(plan.cycleS).toBe(expected.cycleS);
    expect(Math.max(...plan.greensS)).toBeCloseTo(Math.max(...expected.greensS), 6);
    // The busy approach is green for its own (longest) share of the cycle
    const busy = inbound.find(id => id.startsWith('ew') && id.endsWith('bwd'))!;
    let green = 0;
    for (let i = 0; i < plan.cycleS / STEP_S; i++) { if (sim.signalStateOf(busy) === 'green') green += STEP_S; sim.step(); }
    expect(green).toBeCloseTo(Math.max(...expected.greensS), 0);
  });

  it('keeps equal greens with signalTiming equal', () => {
    const sim = new TrafficMicroSim(area, map, { demandLevel: 0, seed: 3, signalPoints: signal, signalTiming: 'equal' });
    const inbound = [...sim.debugLanes().keys()].filter(id => sim.signalStateOf(id) !== null);
    sim.setSignalDesignFlows(new Map(inbound.map((id, k) => [id, k === 0 ? 900 : 200] as [string, number])));
    const g = sim.signalPlans()[0].greensS;
    expect(Math.max(...g) - Math.min(...g)).toBeLessThan(1e-9);
  });

  it('times signals from the assigned demand when no counts are given', () => {
    const w = nodeNear(-400, 0), e = nodeNear(400, 0), s = nodeNear(0, -400), n = nodeNear(0, 400);
    const sim = new TrafficMicroSim(area, map, { demandLevel: 0.12, seed: 3, signalPoints: signal,
      demandTrips: [{ fromNodeId: w, toNodeId: e, vehiclesPerHour: 800, kind: 'car' }, { fromNodeId: s, toNodeId: n, vehiclesPerHour: 200, kind: 'car' }] });
    const plan = sim.signalPlans()[0];
    expect(plan.flowRatioSum).toBeGreaterThan(0);
    // Approach-wise phases: two approaches carry traffic, the eastbound one four times as much
    const sorted = [...plan.greensS].sort((a, b) => b - a);
    expect(sorted[0]).toBeGreaterThan(sorted[1]);
  });
});

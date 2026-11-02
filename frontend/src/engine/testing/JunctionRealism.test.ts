/**
 * Junction behaviour and demand realism:
 *  - signal discharge rate vs Indo-HCM saturation flow, with a start-up lost time;
 *  - gap acceptance at a priority junction (Indo-HCM critical gap);
 *  - no deadlock on a toy 4-way crossroads at high demand (keep-clear rule);
 *  - time-of-day scaling of arrivals;
 *  - count-driven OD seeding;
 *  - real Pune trip rates in the study demand.
 */
import { describe, it, expect } from 'vitest';
import type { RoadObject, RoadClassification, JunctionObject } from '../objects/types';
import { StudyAreaExplorer, type StudyArea } from '../simulation/StudyAreaExplorer';
import { TrafficMicroSim, STEP_S, VEHICLE_TYPES, CRITICAL_GAP_MINOR_S, losFor, OD_REFERENCE_LEVEL } from '../simulation/TrafficMicroSim';
import { compileStudyDemand } from '../simulation/StudyDemand';
import { PUNE_TRIP_RATES, vehiclesPerMotorisedTrip } from '../simulation/tripRates';
import { hourFactor, periodOf, type DiurnalProfile } from '../simulation/timeOfDay';
import { seedTrips } from '../calibration/calibration';

const LAT0 = 18.5;
const M_LAT = 1 / 111320;
const M_LNG = 1 / (111320 * Math.cos((LAT0 * Math.PI) / 180));
const pt = (x: number, y: number): [number, number, number] => [73.8 + x * M_LNG, LAT0 + y * M_LAT, 0];
const road = (id: string, a: [number, number], b: [number, number], opts: { cls?: RoadClassification; lanes?: number; speed?: number; oneWay?: boolean } = {}): RoadObject => ({
  id, type: 'road', name: id, layerId: 'roads', scenarioId: 'base', coordinates: [pt(...a), pt(...b)],
  roadClass: opts.cls ?? 'local', width: 10, laneCount: opts.lanes ?? 2, laneWidth: 3.5,
  hasDivider: false, dividerWidth: 0, hasFootpath: false, footpathWidth: 0,
  speedLimit: opts.speed ?? 50, isOneWay: opts.oneWay ?? false, trafficCapacity: 1000,
  connectedJunctions: [], createdAt: '', updatedAt: '',
});
const areaFor = (roads: RoadObject[], seed: string, range: number): { area: StudyArea; map: Map<string, RoadObject> } => ({
  area: new StudyAreaExplorer().explore(roads, 1, { seedRoadIds: [seed], rangeMeters: range, direction: 'both' }),
  map: new Map(roads.map(r => [r.id, r])),
});
const nodeAt = (area: StudyArea, x: number, y: number) => {
  const [lng, lat] = pt(x, y);
  let best = '', bestD = Infinity;
  area.network.nodes.forEach(n => {
    const d = Math.hypot(n.coordinates[0] - lng, n.coordinates[1] - lat);
    if (d < bestD) { bestD = d; best = n.id; }
  });
  return best;
};
const run = (sim: TrafficMicroSim, seconds: number, each?: (t: number) => void) => {
  for (let i = 0; i < seconds / STEP_S; i++) { sim.step(); each?.(sim.timeS); }
};

/** A signalised crossroads of two collectors, 400 m arms, signal placed by the project. */
const crossroads = (lanes = 1, cycle = 90) => {
  const c = { cls: 'collector' as const, lanes: lanes * 2 };
  const roads = [road('ew', [-400, 0], [400, 0], c), road('ns', [0, -400], [0, 400], c), road('ww', [-900, 0], [-400, 0], c), road('ee', [400, 0], [900, 0], c), road('ss', [0, -900], [0, -400], c), road('nn', [0, 400], [0, 900], c)];
  const j = { id: 'j', type: 'junction', coordinates: pt(0, 0), connectedRoads: ['ew', 'ns'], hasSignals: true, signalTiming: cycle } as JunctionObject;
  return { ...areaFor(roads, 'ew', 450), j };
};

describe('signal discharge', () => {
  it('discharges a standing queue of cars at about the Indo-HCM saturation flow, after a start-up lost time', () => {
    const { area, map, j } = crossroads(1, 120);
    const sim = new TrafficMicroSim(area, map, { demandLevel: 0, seed: 1, junctions: [j] });
    const west = nodeAt(area, -400, 0), east = nodeAt(area, 400, 0);
    const approach = sim.debugLanes();
    const linkId = [...approach.keys()].find(id => sim.signalStateOf(id) !== null && sim.linkLength(id)! > 300 && id.startsWith('ew') && id.endsWith('fwd'))!;
    // Queue 30 cars during red
    let t = 0;
    while (sim.signalStateOf(linkId) === 'green') { sim.step(); t++; if (t > 2000) break; }
    for (let i = 0; i < 30; i++) sim.spawnVehicle(west, east, 'car');
    run(sim, 10);
    while (sim.signalStateOf(linkId) !== 'green') sim.step();
    const greenAt = sim.timeS;
    const crossTimes: number[] = [];
    const seen = new Set<number>();
    run(sim, 55, now => {
      sim.debugLanes().forEach((lanes, id) => {
        if (id === linkId) return;
        for (const lane of lanes) for (const v of lane) if (!seen.has(v.id) && id.includes('ew')) { seen.add(v.id); crossTimes.push(now - greenAt); }
      });
    });
    expect(crossTimes.length).toBeGreaterThan(12);
    crossTimes.sort((a, b) => a - b);
    // Saturation headway from the 5th crossing on (HCM practice: the first four carry the start-up loss)
    const n = Math.min(crossTimes.length, 20);
    const headway = (crossTimes[n - 1] - crossTimes[4]) / (n - 5);
    const satFlowVph = 3600 / headway;
    // Indo-HCM 2017: unit base saturation flow 630 PCU/h per metre of approach width (< 7 m): one 3.5 m lane = 2205 PCU/h
    const indoHcm = 630 * 3.5;
    expect(satFlowVph).toBeGreaterThan(0.6 * indoHcm);
    expect(satFlowVph).toBeLessThan(1.25 * indoHcm);
    // Start-up lost time: the first four take longer than four saturation headways
    expect(crossTimes[3]).toBeGreaterThan(4 * headway);
    console.log(JSON.stringify({ discharge: { satFlowVph, indoHcm, firstFourS: crossTimes[3], headway, crossed: crossTimes.length } }));
  });
});

describe('mixed-traffic discharge', () => {
  /**
   * A standing queue of the Pune vehicle mix (52% two-wheelers) on a 7 m
   * two-lane approach discharges on green at close to the Indo-HCM 2017
   * saturation flow for that width: 7 m x (1140 - 60 x 7) = 5040 PCU/h. The
   * queue discharges as a platoon (followers are cleared behind the vehicle
   * ahead instead of stopping at the line) and parallel lanes keep to their own
   * lanes across the junction.
   */
  const discharge = (abreast: boolean) => {
    const { area, map, j } = crossroads(2, 240);
    const sim = new TrafficMicroSim(area, map, { demandLevel: 0, seed: 1, junctions: [j], twoWheelersAbreast: abreast, signalTiming: 'equal' });
    const west = nodeAt(area, -400, 0), east = nodeAt(area, 400, 0);
    const linkId = [...sim.debugLanes().keys()].find(id => sim.signalStateOf(id) !== null && sim.linkLength(id)! > 300 && id.startsWith('ew') && id.endsWith('fwd'))!;
    let t = 0;
    while (sim.signalStateOf(linkId) === 'green') { sim.step(); if (++t > 4000) break; }
    let seed = 7;
    const rnd = () => ((seed = (seed * 1103515245 + 12345) % 2147483648) / 2147483648);
    for (let i = 0; i < 120; i++) {
      let r = rnd(), kind = VEHICLE_TYPES[0].kind;
      for (const ty of VEHICLE_TYPES) if ((r -= ty.share) <= 0) { kind = ty.kind; break; }
      sim.spawnVehicle(west, east, kind);
    }
    run(sim, 100);
    while (sim.signalStateOf(linkId) !== 'green') sim.step();
    const greenAt = sim.timeS;
    const crossed = new Map<number, { t: number; kind: string }>();
    run(sim, 60, now => sim.debugLanes().forEach((lanes, id) => {
      if (id === linkId || !id.includes('ew')) return;
      for (const lane of lanes) for (const v of lane) if (!crossed.has(v.id)) crossed.set(v.id, { t: now - greenAt, kind: v.kind });
    }));
    // Saturated part of the green: from 10 s (start-up loss over) to 50 s
    const pcuOf = new Map(VEHICLE_TYPES.map(ty => [ty.kind as string, ty.pcu]));
    const window = [...crossed.values()].filter(c => c.t >= 10 && c.t < 50);
    return { pcuPerHour: window.reduce((n, c) => n + pcuOf.get(c.kind)!, 0) * 3600 / 40, queueLeft: sim.debugLanes().get(linkId)!.reduce((n, l) => n + l.length, 0) };
  };

  it('discharges a mixed queue on a 7 m approach at about the Indo-HCM saturation flow', () => {
    const indoHcm7m = 7 * (1140 - 60 * 7);
    for (const abreast of [false, true]) {
      const { pcuPerHour, queueLeft } = discharge(abreast);
      expect(queueLeft).toBeGreaterThan(0); // still saturated at the end of the window
      expect(pcuPerHour).toBeGreaterThan(0.8 * indoHcm7m);
      expect(pcuPerHour).toBeLessThan(1.25 * indoHcm7m);
      console.log(JSON.stringify({ mixedDischarge: { abreast, pcuPerHour: Math.round(pcuPerHour), indoHcm7m } }));
    }
  });
});

describe('gap acceptance at a priority junction', () => {
  it('a side-road vehicle waits for a gap of at least the Indo-HCM critical gap in main-road traffic', () => {
    const roads = [road('main', [-500, 0], [500, 0], { cls: 'arterial', lanes: 2 }), road('mw', [-1000, 0], [-500, 0], { cls: 'arterial' }), road('me', [500, 0], [1000, 0], { cls: 'arterial' }),
      road('side', [0, -300], [0, 0], { cls: 'local', lanes: 2 }), road('ss', [0, -700], [0, -300], { cls: 'local' })];
    const { area, map } = areaFor(roads, 'main', 600);
    const sim = new TrafficMicroSim(area, map, { demandLevel: 0, seed: 3, signalPoints: [] });
    const sideStart = nodeAt(area, 0, -300), mainEast = nodeAt(area, 500, 0), mainWest = nodeAt(area, -500, 0);
    // Steady westbound main-road stream (the near side for a vehicle coming from the south in
    // left-hand traffic) every 2.5 s, shorter than the critical gap; then the stream stops.
    // The side-road vehicle turns right (east), across that stream.
    let accepted = -1;
    sim.spawnVehicle(sideStart, mainEast, 'car');
    for (let k = 0; k < 160; k++) {
      if (k % 10 === 0 && k < 120) sim.spawnVehicle(mainEast, mainWest, 'car');
      run(sim, 0.25 * 1);
      sim.debugLanes().forEach((lanes, id) => {
        if (accepted < 0 && id.startsWith('main') && lanes.some(l => l.some(v => v.id === 1))) accepted = sim.timeS;
      });
    }
    run(sim, 60, () => {
      if (accepted < 0) sim.debugLanes().forEach((lanes, id) => { if (id.startsWith('main') && lanes.some(l => l.some(v => v.id === 1))) accepted = sim.timeS; });
    });
    // It got through eventually, but not while the 2.5 s stream was running past
    expect(accepted).toBeGreaterThan(0);
    expect(accepted).toBeGreaterThan(25);
    expect(CRITICAL_GAP_MINOR_S).toBeGreaterThan(2.5);
  });
});

describe('no deadlock', () => {
  it('a 4-way signalised crossroads at high demand keeps moving: no deadlock, nobody removed, nobody stuck in the box', () => {
    const { area, map, j } = crossroads(1, 90);
    const sim = new TrafficMicroSim(area, map, { demandLevel: 0, seed: 11, junctions: [j] });
    const ends = [nodeAt(area, -400, 0), nodeAt(area, 400, 0), nodeAt(area, 0, -400), nodeAt(area, 0, 400)];
    let k = 0;
    // ~2400 veh/h offered across all OD pairs incl. turns: well above what one lane per approach can serve
    run(sim, 900, () => {
      if (k++ % 6 === 0) {
        const a = ends[k % 4], b = ends[(k * 7 + 1) % 4];
        if (a !== b) sim.spawnVehicle(a, b, VEHICLE_TYPES[k % 5].kind);
      }
    });
    const rep = sim.deadlockReport();
    expect(rep.events).toBe(0);
    expect(rep.gridlockRemovals).toBe(0);
    expect(rep.maxStuckInBoxS).toBeLessThan(30);
    const m = sim.getMetrics();
    (globalThis as Record<string, unknown>).__deadlock = { m, rep, stats: sim.junctionStats() };
    console.log(JSON.stringify({ completed: m.completedTrips, onNetwork: m.onNetwork, waiting: m.waitingToEnter, speed: m.meanSpeedKmh, rep, j: sim.junctionStats()[0] }));
    expect(m.completedTrips).toBeGreaterThan(200);
    const stats = sim.junctionStats();
    expect(stats.length).toBeGreaterThan(0);
    expect(stats[0].meanControlDelayS).toBeGreaterThan(0);
    expect('ABCDEF').toContain(stats[0].los);
  }, 60_000);

  it('a platoon cut off by red gives back its grants: nobody waiting at a red line blocks the next phase', () => {
    // Mixed straight and turning vehicles queue on every approach; a turn starts
    // further back than the straight-on line, so a turning follower can stand past
    // its own start behind a straight leader stopped by red. Neither may keep a
    // claim on the junction while its approach is red. (The fault was found at
    // Kasturi Chowk on the real OSM geometry, where such claims cut stop-line
    // discharge to 10-25% of the Indo-HCM saturation flow; this toy guards the
    // invariant but did not reproduce the fault itself before the fix.)
    const { area, map, j } = crossroads(3, 60);
    const sim = new TrafficMicroSim(area, map, { demandLevel: 0, seed: 5, junctions: [j], signalTiming: 'equal' });
    const ends = [nodeAt(area, -400, 0), nodeAt(area, 400, 0), nodeAt(area, 0, -400), nodeAt(area, 0, 400)];
    sim.traceGrants();
    let k = 0;
    run(sim, 600, () => {
      if (k++ % 3 === 0) {
        const a = ends[k % 4], b = ends[(k * 3 + 1) % 4];
        if (a !== b) sim.spawnVehicle(a, b, VEHICLE_TYPES[k % 2].kind);
      }
    });
    let blockedByRed = 0, granted = 0;
    sim.grantOutcomes().forEach(m => m.forEach((n, reason) => {
      if (/approaching standing red/.test(reason)) blockedByRed += n;
      if (reason === 'granted') granted += n;
    }));
    expect(granted).toBeGreaterThan(100);
    expect(blockedByRed).toBe(0);
  }, 60_000);

  it('LOS bands follow HCM 2000 control-delay thresholds', () => {
    expect(losFor(5, true)).toBe('A');
    expect(losFor(30, true)).toBe('C');
    expect(losFor(90, true)).toBe('F');
    expect(losFor(30, false)).toBe('D');
  });
});

const PROFILE: DiurnalProfile = {
  version: 1,
  weekday: { hours: Array.from({ length: 24 }, (_, h) => ({ hour: h, share: [0.007, 0.0034, 0.005, 0.007, 0.009, 0.011, 0.025, 0.0425, 0.067, 0.0746, 0.061, 0.062, 0.052, 0.047, 0.054, 0.0525, 0.061, 0.0697, 0.0743, 0.078, 0.056, 0.040, 0.025, 0.014][h], period: 'Moderate', measured: h >= 8 && h <= 19, source: 'test' })) },
  weekend: { hours: Array.from({ length: 24 }, (_, h) => ({ hour: h, share: 1 / 24, period: 'Moderate', measured: false, source: 'test' })) },
};

describe('time of day', () => {
  it('hourly demand = peak-hour demand x profile[hour] / profile[count hour]', () => {
    expect(hourFactor(PROFILE, 19, 19)).toBeCloseTo(1);
    expect(hourFactor(PROFILE, 3, 19)).toBeCloseTo(0.007 / 0.078);
    expect(hourFactor(PROFILE, 9, 19, 'weekend')).toBeCloseTo((1 / 24) / 0.078);
    expect(hourFactor({ ...PROFILE, weekend_daily_vs_weekday: 0.9 }, 9, 19, 'weekend')).toBeCloseTo(0.9 * (1 / 24) / 0.078);
  });

  it('periods come from thresholds on the busiest hour', () => {
    expect(periodOf(PROFILE, 19)).toBe('Peak');
    expect(periodOf(PROFILE, 3)).toBe('Low');
    expect(periodOf(PROFILE, 15)).toBe('Moderate');
  });

  it('the simulator scales arrivals by the hour factor', () => {
    const { area, map, j } = crossroads(1, 90);
    const w = nodeAt(area, -400, 0), e = nodeAt(area, 400, 0);
    const sim = new TrafficMicroSim(area, map, { demandLevel: OD_REFERENCE_LEVEL, seed: 5, junctions: [j], demandTrips: [{ fromNodeId: w, toNodeId: e, vehiclesPerHour: 1200, kind: 'car' }] });
    expect(sim.getMetrics().inflowVph).toBe(1200);
    sim.setHourFactor(0.1);
    expect(sim.getMetrics().inflowVph).toBe(120);
    run(sim, 600);
    // ~20 arrivals expected in 10 minutes at 120 veh/h
    expect(sim.getMetrics().completedTrips + sim.getMetrics().onNetwork).toBeLessThan(45);
  });
});

describe('demand realism', () => {
  it('uses real Pune motorised trip rates, a 7.8% peak hour and occupancy, not 2 trips x 35% x 1 vehicle per person', () => {
    const square = [pt(-50, -50), pt(50, -50), pt(50, 50), pt(-50, 50)];
    const plan = compileStudyDemand({ period: 'AM_Peak', buildings: [
      { id: 'home', type: 'building', coordinates: square, residents: 1000, employees: 0 } as never,
      { id: 'work', type: 'building', coordinates: square.map(p => [p[0] + 0.01, p[1], 0] as [number, number, number]), residents: 0, employees: 1000 } as never,
    ] })!;
    const fromHome = plan.trips.filter(t => t.from[0] < 73.805).reduce((n, t) => n + t.vehiclesPerHour, 0);
    // 1000 residents x 0.87 motorised trips/day x 7.8% in the peak hour x ~0.42 vehicles per motorised trip
    expect(fromHome).toBeCloseTo(1000 * PUNE_TRIP_RATES.motorisedTripsPerResident * PUNE_TRIP_RATES.peakHourShare * vehiclesPerMotorisedTrip(), 3);
    expect(fromHome).toBeLessThan(40);
    expect(new Set(plan.trips.map(t => t.kind))).toEqual(new Set(['two_wheeler', 'auto', 'car', 'bus']));
  });

  it('count-driven OD seeds a trip per class through every counted movement at its observed volume', () => {
    const layout = { zone: { id: 'j1', lng: 0, lat: 0, radiusM: 60 }, problem: null, arms: [
      { cardinal: 'N', inbound: [0], outbound: [1] }, { cardinal: 'S', inbound: [2], outbound: [3] }, { cardinal: 'E', inbound: [4], outbound: [5] }, { cardinal: 'W', inbound: [6], outbound: [7] }] };
    const links = Array.from({ length: 8 }, (_, i) => ({ index: i, from: [i, 0, 0], to: [i, 1, 0], pts: [] }));
    const junction = { id: 'j1', name: 'J1', movements: [{ approach: 'N', turn: 'left', LV: 100, HV: 10, TW: 200 }, { approach: 'S', turn: 'straight', LV: 50, HV: 0, TW: 80 }] };
    const { trips, seeds } = seedTrips([junction as never], [layout as never], links as never, new Set());
    expect(seeds.length).toBe(5); // 3 classes + 2 non-zero classes
    expect(trips.reduce((n, t) => n + t.vehiclesPerHour, 0)).toBe(440);
    // N left (LHT) goes to the E exit: from approach N's inbound link start to exit E's outbound link end
    const nLeftCar = trips.find(t => t.kind === 'car' && t.vehiclesPerHour === 100)!;
    expect(nLeftCar.from[0]).toBe(0);
    expect(nLeftCar.to[0]).toBe(5);
  });
});

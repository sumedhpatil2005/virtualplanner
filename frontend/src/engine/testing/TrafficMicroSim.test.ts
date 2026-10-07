import { describe, it, expect } from 'vitest';
import type { RoadObject, RoadClassification } from '../objects/types';
import { StudyAreaExplorer, type StudyArea } from '../simulation/StudyAreaExplorer';
import { TrafficMicroSim, STEP_S, idmAcceleration, VEHICLE_TYPES, type MicroSimOptions } from '../simulation/TrafficMicroSim';

// Local metric frame: (x, y) metres east/north of an origin in Pune
const LAT0 = 18.5;
const M_LAT = 1 / 111320;
const M_LNG = 1 / (111320 * Math.cos((LAT0 * Math.PI) / 180));
const pt = (x: number, y: number): [number, number, number] => [73.8 + x * M_LNG, LAT0 + y * M_LAT, 0];

const road = (id: string, a: [number, number], b: [number, number], opts: { cls?: RoadClassification; lanes?: number; speed?: number; oneWay?: boolean } = {}): RoadObject => ({
  id, type: 'road', name: id, layerId: 'roads', scenarioId: 'base',
  coordinates: [pt(...a), pt(...b)],
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

/** Id of the area link running from the node nearest `a` to the node nearest `b`. */
const linkBetween = (area: StudyArea, a: [number, number], b: [number, number]) => {
  const from = nodeAt(area, ...a), to = nodeAt(area, ...b);
  const keys = new Set(area.segments.map(s => s.key));
  return [...area.network.edges.values()].find(e => e.fromNodeId === from && e.toNodeId === to && keys.has(e.id.replace(/_(fwd|bwd)$/, '')))!.id;
};

const run = (sim: TrafficMicroSim, seconds: number, each?: () => void) => {
  for (let i = 0; i < seconds / STEP_S; i++) {
    sim.step();
    each?.();
  }
};

/** Every vehicle keeps a non-negative gap to the one ahead in its lane. */
const assertNoOverlaps = (sim: TrafficMicroSim) => {
  sim.debugLanes().forEach(lanes => {
    for (const lane of lanes) {
      for (let i = 1; i < lane.length; i++) {
        const gap = lane[i - 1].pos - lane[i - 1].length - lane[i].pos;
        if (gap < -1e-6) throw new Error(`overlap of ${gap.toFixed(3)} m between vehicles ${lane[i - 1].id} and ${lane[i].id}`);
      }
    }
  });
};

/** A 1.2 km corridor with roads beyond range at both ends, so traffic enters and leaves there. */
const corridor = (midLanes: number, outerLanes: number, cls: RoadClassification = 'arterial') => areaFor([
  road('ww', [-500, 0], [0, 0], { cls, lanes: outerLanes }),
  road('w', [0, 0], [300, 0], { cls, lanes: outerLanes }),
  road('mid', [300, 0], [900, 0], { cls, lanes: midLanes }),
  road('e', [900, 0], [1200, 0], { cls, lanes: outerLanes }),
  road('ee', [1200, 0], [1700, 0], { cls, lanes: outerLanes }),
], 'mid', 200);

describe('IDM car-following', () => {
  const car = VEHICLE_TYPES.find(t => t.kind === 'car')!;

  it('accelerates on a free road and settles at the desired speed', () => {
    let v = 0;
    for (let i = 0; i < 400; i++) v += idmAcceleration(v, 14, 1e6, v, car) * STEP_S;
    expect(v).toBeGreaterThan(13.5);
    expect(v).toBeLessThanOrEqual(14.01);
  });

  it('brakes hard for a stopped obstacle close ahead', () => {
    expect(idmAcceleration(14, 14, 20, 0, car)).toBeLessThan(-car.comfortDecel);
  });
});

describe('TrafficMicroSim', () => {
  it('enters and leaves where roads cross the area edge', () => {
    const { area, map } = corridor(2, 2);
    const sim = new TrafficMicroSim(area, map, { demandLevel: 0, seed: 1 });
    expect(new Set(sim.getSourceNodes())).toEqual(new Set([nodeAt(area, 0, 0), nodeAt(area, 1200, 0)]));
    expect(new Set(sim.getSinkNodes())).toEqual(new Set([nodeAt(area, 0, 0), nodeAt(area, 1200, 0)]));
  });

  it('drives a single vehicle through at close to free-flow speed', () => {
    const { area, map } = corridor(2, 2);
    const sim = new TrafficMicroSim(area, map, { demandLevel: 0, seed: 1 });
    expect(sim.spawnVehicle(nodeAt(area, 0, 0), nodeAt(area, 1200, 0), 'car')).toBe(true);
    let maxV = 0;
    run(sim, 200, () => sim.debugLanes().forEach(lanes => lanes.flat().forEach(v => { maxV = Math.max(maxV, v.v); })));
    const m = sim.getMetrics();
    expect(m.completedTrips).toBe(1);
    expect(m.delayIndex!).toBeGreaterThan(0.9);
    expect(m.delayIndex!).toBeLessThan(1.3);
    expect(maxV).toBeLessThanOrEqual((50 / 3.6) * 1.1 + 1e-9); // never faster than the fastest driver's desired speed
  });

  it('never lets vehicles overlap under heavy demand', () => {
    const roads: RoadObject[] = [];
    for (let i = 0; i <= 6; i++) {
      roads.push(road(`h${i}`, [0, i * 100], [600, i * 100], { cls: 'collector' }));
      roads.push(road(`v${i}`, [i * 100, 0], [i * 100, 600], { cls: 'collector' }));
    }
    const { area, map } = areaFor(roads, 'h3', 250);
    const sim = new TrafficMicroSim(area, map, { demandLevel: 1, seed: 7 });
    run(sim, 600, () => assertNoOverlaps(sim));
    const m = sim.getMetrics();
    expect(m.completedTrips).toBeGreaterThan(50);
    expect(m.signals).toBeGreaterThan(0);
    // Vehicles only ever use roads in the study area
    const areaKeys = new Set(area.segments.map(s => s.key));
    sim.debugLanes().forEach((_, linkId) => expect(areaKeys.has(linkId.replace(/_(fwd|bwd)$/, ''))).toBe(true));
  });

  it('stops for red lights and only crosses on green or amber', () => {
    // Two collector roads crossing: a signalised crossroads, with roads beyond range at each end
    // Roads touching the seed road's ends join the area, so each arm needs a road beyond that too
    const c = { cls: 'collector' as const };
    const roads = [
      road('ew', [-400, 0], [400, 0], c), road('ns', [0, -400], [0, 400], c),
      road('w2', [-800, 0], [-400, 0], c), road('e2', [400, 0], [800, 0], c),
      road('w3', [-1200, 0], [-800, 0], c), road('e3', [800, 0], [1200, 0], c),
      road('s2', [0, -800], [0, -400], c), road('n2', [0, 400], [0, 800], c),
    ];
    const { area, map } = areaFor(roads, 'ew', 300);
    const sim = new TrafficMicroSim(area, map, { demandLevel: 0, seed: 3 });
    expect(sim.getMetrics().signals).toBe(1);
    const west = nodeAt(area, -800, 0), east = nodeAt(area, 800, 0);
    expect(sim.getSourceNodes()).toContain(west);
    const westArm = linkBetween(area, [-400, 0], [0, 0]);
    const eastArm = linkBetween(area, [0, 0], [400, 0]);
    const armLength = sim.linkLength(westArm)!;

    const where = new Map<number, string>();
    let stoppedAtRed = 0;
    let crossedOnRed = 0;
    for (let i = 0; i < 600 / STEP_S; i++) {
      if (i % Math.round(8 / STEP_S) === 0 && i < 300 / STEP_S) sim.spawnVehicle(west, east, 'car');
      const stateBefore = sim.signalStateOf(westArm);
      sim.step();
      sim.debugLanes().forEach((lanes, linkId) => lanes.flat().forEach(v => {
        if (where.get(v.id) === westArm && linkId === eastArm && stateBefore === 'red') crossedOnRed++;
        if (linkId === westArm && stateBefore === 'red' && v.v < 0.3 && armLength - v.pos < 3) stoppedAtRed++;
        where.set(v.id, linkId);
      }));
    }
    expect(stoppedAtRed).toBeGreaterThan(0);
    expect(crossedOnRed).toBe(0);
    expect(sim.getMetrics().completedTrips).toBeGreaterThan(30);
  });

  it('makes a side road give way to the main road', () => {
    const a = { cls: 'arterial' as const, lanes: 4 };
    const roads = [
      road('main', [-400, 0], [400, 0], a), road('side', [0, -400], [0, 0]),
      road('main_w', [-800, 0], [-400, 0], a), road('main_e', [400, 0], [800, 0], a),
      road('main_ww', [-1200, 0], [-800, 0], a), road('main_ee', [800, 0], [1200, 0], a),
      road('side_s', [0, -800], [0, -400]),
    ];
    const { area, map } = areaFor(roads, 'main', 300);
    const sim = new TrafficMicroSim(area, map, { demandLevel: 0.6, seed: 11 });
    const m0 = sim.getMetrics();
    expect([m0.signals, m0.entries, m0.exits]).toEqual([0, 3, 3]);
    // Average how freely traffic moves on each approach to the junction
    const sums = new Map<string, [number, number]>();
    run(sim, 900, () => sim.segmentSpeedRatios().forEach((r, key) => {
      const s = sums.get(key) ?? [0, 0];
      sums.set(key, [s[0] + r, s[1] + 1]);
    }));
    const mean = (prefix: string) => {
      const [a, n] = [...sums.entries()].filter(([k]) => k.startsWith(prefix)).reduce((acc, [, [s, c]]) => [acc[0] + s, acc[1] + c], [0, 0]);
      return a / n;
    };
    expect(mean('side_seg')).toBeLessThan(mean('main_seg') - 0.1);
    expect(sim.getMetrics().completedTrips).toBeGreaterThan(100);
  });

  it('widening a bottleneck measurably cuts travel time', () => {
    const measure = (midLanes: number) => {
      const { area, map } = corridor(midLanes, 6, 'highway');
      const sim = new TrafficMicroSim(area, map, { demandLevel: 1, seed: 5 });
      run(sim, 900);
      return sim.getMetrics();
    };
    const narrow = measure(2); // one lane each way
    const wide = measure(4); // two lanes each way
    expect(wide.delayIndex!).toBeLessThan(narrow.delayIndex! * 0.8);
    expect(wide.completedTrips).toBeGreaterThan(narrow.completedTrips);
  });

  it('is repeatable for a seed and varies between seeds', () => {
    const go = (seed: number) => {
      const { area, map } = corridor(2, 4);
      const sim = new TrafficMicroSim(area, map, { demandLevel: 0.7, seed } as MicroSimOptions);
      run(sim, 300);
      return sim.getMetrics();
    };
    expect(go(42)).toEqual(go(42));
    expect(go(42)).not.toEqual(go(43));
  });

  it('keeps up with a large area', () => {
    const roads: RoadObject[] = [];
    for (let i = 0; i <= 20; i++) {
      for (let j = 0; j < 20; j++) {
        roads.push(road(`h${i}_${j}`, [j * 100, i * 100], [(j + 1) * 100, i * 100], { cls: i % 5 === 0 ? 'arterial' : 'local' }));
        roads.push(road(`v${i}_${j}`, [i * 100, j * 100], [i * 100, (j + 1) * 100], { cls: i % 5 === 0 ? 'arterial' : 'local' }));
      }
    }
    const { area, map } = areaFor(roads, 'h10_10', 800);
    const sim = new TrafficMicroSim(area, map, { demandLevel: 0.8, seed: 2 });
    run(sim, 300);
    const start = performance.now();
    run(sim, 60);
    const msPerStep = (performance.now() - start) / (60 / STEP_S);
    const m = sim.getMetrics();
    console.log(`[MicroSim] ${m.onNetwork} vehicles, ${msPerStep.toFixed(2)} ms per ${STEP_S}s step`);
    expect(m.onNetwork).toBeGreaterThan(300);
    expect(msPerStep).toBeLessThan(8);
  });
});

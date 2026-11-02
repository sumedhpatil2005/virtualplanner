/**
 * Congestion feedback in route choice (assignment.ts): method of successive
 * averages on a toy network with two routes between one origin and one
 * destination. The short route crosses a signalised junction; the long route
 * goes round it with no control.
 */
import { describe, it, expect } from 'vitest';
import type { RoadObject, RoadClassification, JunctionObject } from '../objects/types';
import { StudyAreaExplorer } from '../simulation/StudyAreaExplorer';
import { OD_REFERENCE_LEVEL, type TrafficMicroSim } from '../simulation/TrafficMicroSim';
import { assignWithFeedback, MAX_COST_FACTOR } from '../simulation/assignment';
import type { DemandPlan } from '../simulation/StudyDemand';
import type { SimSetup } from '../calibration/calibration';

const LAT0 = 18.5;
const M_LAT = 1 / 111320;
const M_LNG = 1 / (111320 * Math.cos((LAT0 * Math.PI) / 180));
const pt = (x: number, y: number): [number, number, number] => [73.8 + x * M_LNG, LAT0 + y * M_LAT, 0];
const road = (id: string, pts: [number, number][], cls: RoadClassification = 'collector', lanes = 2): RoadObject => ({
  id, type: 'road', name: id, layerId: 'roads', scenarioId: 'base', coordinates: pts.map(p => pt(...p)),
  roadClass: cls, width: 7, laneCount: lanes, laneWidth: 3.5,
  hasDivider: false, dividerWidth: 0, hasFootpath: false, footpathWidth: 0,
  speedLimit: 50, isOneWay: false, trafficCapacity: 1000,
  connectedJunctions: [], createdAt: '', updatedAt: '',
});

/**
 * West feeder (-900..-600, 0), short route straight through a signalised
 * crossroads at the origin to (600, 0), long route round by y = 400, east
 * feeder (600..900, 0). Short 1800 m, long 2600 m.
 */
function toyNetwork() {
  const roads = [
    road('feed_w', [[-900, 0], [-600, 0]]),
    road('short_w', [[-600, 0], [0, 0]]), road('short_e', [[0, 0], [600, 0]]),
    road('cross_s', [[0, -500], [0, 0]]), road('cross_n', [[0, 0], [0, 500]]),
    road('long_w', [[-600, 0], [-600, 400]]), road('long_n', [[-600, 400], [600, 400]]), road('long_e', [[600, 400], [600, 0]]),
    road('feed_e', [[600, 0], [900, 0]]),
  ];
  const j = { id: 'j', type: 'junction', coordinates: pt(0, 0), connectedRoads: ['short_w', 'short_e', 'cross_s', 'cross_n'], hasSignals: true, signalTiming: 90 } as JunctionObject;
  const area = new StudyAreaExplorer().explore(roads, 1, { seedRoadIds: ['short_w'], rangeMeters: 2000, direction: 'both' });
  return { area, roads: new Map(roads.map(r => [r.id, r])), j };
}

const plan = (vph: number): DemandPlan => ({
  trips: [{ from: pt(-900, 0), to: pt(900, 0), vehiclesPerHour: vph, kind: 'car' }],
  provenance: { source: 'synthetic', label: 'toy', period: 'AM_Peak', vehiclesPerHour: vph, pairCount: 1 },
});

/** Ids of the links on the single OD route of this run. */
const routeIds = (sim: TrafficMicroSim): string[] => {
  const ids = [...sim.debugLanes().keys()];
  return sim.demandRouteFlows()[0].route.map(i => ids[i]);
};

async function run(vph: number, iterations: number) {
  const { area, roads, j } = toyNetwork();
  const setup: SimSetup = { area, roads, options: { demandLevel: OD_REFERENCE_LEVEL, seed: 3, junctions: [j], signalTiming: 'equal' } };
  const measured: Map<string, number>[] = [];
  const routes: string[][] = [];
  const result = await assignWithFeedback(setup, plan(vph), {
    iterations, warmupS: 120, measureS: 480,
    onIteration: (_k, m, sim) => { measured.push(new Map(m)); routes.push(routeIds(sim)); },
  });
  return { result, measured, routes };
}
const viaShort = (r: string[]) => r.some(id => id.startsWith('short_w'));
const viaLong = (r: string[]) => r.some(id => id.startsWith('long_n'));

describe('assignment with congestion feedback (MSA)', () => {
  it('keeps free-flow routes when nothing is congested', async () => {
    const { result, routes } = await run(150, 3);
    expect(routes.every(viaShort)).toBe(true);
    expect(result.history.slice(1).every(h => h.rerouted === 0)).toBe(true);
    // A light flow through a signal still waits on red sometimes, but far less than a jam
    const worst = Math.max(...result.linkCostFactors.values());
    expect(worst).toBeLessThan(2.5);
  }, 120_000);

  it('moves flow off the congested route and averages link costs over iterations', async () => {
    const K = 6;
    const { result, measured, routes } = await run(1100, K);
    // Iteration 1 routes on free-flow costs: the short route through the signal
    expect(viaShort(routes[0])).toBe(true);
    // The signal approach is congested, so a later iteration takes the long way round
    const firstLong = routes.findIndex(viaLong);
    expect(firstLong).toBeGreaterThan(0);
    expect(result.history[firstLong].rerouted).toBe(1);
    // MSA identity: each factor is the mean of the ratios measured in all K
    // iterations, with ratio 1 in an iteration where the link was unused
    result.linkCostFactors.forEach((f, id) => {
      const mean = measured.reduce((a, m) => a + (m.get(id) ?? 1), 0) / K;
      expect(f).toBeCloseTo(mean, 9);
      expect(f).toBeGreaterThanOrEqual(1);
      expect(f).toBeLessThanOrEqual(MAX_COST_FACTOR);
    });
    // Successive averages settle: the step k makes is (ratio - mean) / k, so the
    // largest change of any factor shrinks from the early iterations to the last
    const factorsAt = (k: number) => {
      const ids = new Set(measured.flatMap(m => [...m.keys()]));
      return new Map([...ids].map(id => [id, measured.slice(0, k).reduce((a, m) => a + (m.get(id) ?? 1), 0) / k]));
    };
    const step = (k: number) => {
      const a = factorsAt(k - 1), b = factorsAt(k);
      return Math.max(...[...b].map(([id, v]) => Math.abs(v - (a.get(id) ?? 1))));
    };
    expect(step(K)).toBeLessThan(step(2));
    expect(step(K)).toBeLessThanOrEqual((MAX_COST_FACTOR - 1) / K);
    // Route costs under the averaged factors end closer together than the
    // free-flow costs were (towards Wardrop equilibrium: used routes equal cost)
    const len = (id: string) => (id.startsWith('feed') ? 300 : id.startsWith('long_w') || id.startsWith('long_e') ? 400 : 600) * (id.startsWith('long_n') ? 2 : 1);
    const cost = (r: string[], f: (id: string) => number) => r.reduce((a, id) => a + len(id) * f(id), 0);
    const shortR = routes.find(viaShort)!, longR = routes.find(viaLong)!;
    const free = Math.abs(cost(shortR, () => 1) - cost(longR, () => 1));
    const fin = (id: string) => result.linkCostFactors.get(id) ?? 1;
    expect(Math.abs(cost(shortR, fin) - cost(longR, fin))).toBeLessThan(free);
  }, 300_000);
});

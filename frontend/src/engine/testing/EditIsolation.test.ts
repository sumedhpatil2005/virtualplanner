import { describe, it, expect } from 'vitest';
import type { RoadObject } from '../objects/types';
import { StudyAreaExplorer, type DrivableObject } from '../simulation/StudyAreaExplorer';
import { TrafficMicroSim, STEP_S, type MicroDemandTrip } from '../simulation/TrafficMicroSim';
import { runAnalysisJob, type AnalysisJob } from '../simulation/analysisJob';
import { roadSection } from '../simulation/roadSection';
import type { DemandPlan } from '../simulation/StudyDemand';

/**
 * A proposal is compared with the baseline on common random numbers
 * (docs/OVERHAUL.md §10.2): an edit must change the neighbourhood's traffic
 * only through what it changes on the network. Before the fix, each OD stream's
 * random numbers were keyed by its index in the neighbourhood's trip list, which
 * the area assignment rebuilds on every edit, so any edit that reordered that
 * list re-drew every arrival and driver, and two unrelated edits could show the
 * same large "change" in the neighbourhood.
 */

const LAT0 = 18.5;
const pt = (x: number, y: number): [number, number, number] => [73.8 + x / (111320 * Math.cos(LAT0 * Math.PI / 180)), LAT0 + y / 111320, 0];
const road = (id: string, a: [number, number], b: [number, number], extra: Partial<RoadObject> = {}): DrivableObject => ({
  id, type: 'road', name: id, layerId: 'roads', scenarioId: 'base', coordinates: [pt(...a), pt(...b)], roadClass: 'arterial', width: 10, laneCount: 2, laneWidth: 3.5,
  hasDivider: false, dividerWidth: 0, hasFootpath: false, footpathWidth: 0, speedLimit: 40, isOneWay: false, trafficCapacity: 2000, connectedJunctions: [], createdAt: '', updatedAt: '', ...extra,
} as RoadObject as DrivableObject);

/** A 5 x 5 grid, 300 m blocks; the study road is the middle of the centre row. */
function grid(): DrivableObject[] {
  const out: DrivableObject[] = [];
  for (let i = 0; i < 5; i++) for (let j = 0; j < 4; j++) {
    out.push(road(`h${i}_${j}`, [j * 300, i * 300], [(j + 1) * 300, i * 300]));
    out.push(road(`v${i}_${j}`, [i * 300, j * 300], [i * 300, (j + 1) * 300]));
  }
  // A road far away (not connected, outside every study range)
  out.push(road('far', [9000, 9000], [9300, 9000]));
  return out;
}

const corners: [number, number][] = [[0, 0], [1200, 0], [0, 1200], [1200, 1200], [0, 600], [1200, 600], [600, 0], [600, 1200]];
function plan(): DemandPlan {
  const trips: DemandPlan['trips'] = [];
  for (const a of corners) for (const b of corners) if (a !== b) trips.push({ from: pt(...a), to: pt(...b), vehiclesPerHour: 70, kind: 'car' });
  return { trips, provenance: { source: 'synthetic', label: 'test', period: 'AM_Peak', vehiclesPerHour: trips.length * 70, pairCount: trips.length } };
}

function job(roads: DrivableObject[], seeds: number[]): AnalysisJob {
  const ex = new StudyAreaExplorer();
  const area = ex.explore(roads, 1, { seedRoadIds: ['h2_1'], rangeMeters: 1500, direction: 'both' });
  const corridor = ex.explore(roads, 1, { seedRoadIds: ['h2_1'], rangeMeters: 400, direction: 'both' });
  const map = new Map(roads.map(r => [r.id, r]));
  return { area, corridor, roads: map, options: { demandLevel: 0.12, signalTiming: 'webster' }, plan: plan(), section: roadSection(area, map, ['h2_1']), hourFactor: 1, seeds, warmupS: 120, measureS: 300 };
}

const widen = (roads: DrivableObject[], id: string) => roads.map(r => (r.id === id ? { ...r, laneCount: r.laneCount + 2, trafficCapacity: r.trafficCapacity + 2000, width: r.width + 7 } : r));
const nb = (o: Awaited<ReturnType<typeof runAnalysisJob>>) => o.result.perSeed.map(s => [s.completedTrips, s.meanTravelTimeS, s.meanDelayS] as const);

describe('comparisons use common random numbers', () => {
  it('a reordered neighbourhood trip list gives the same simulation (streams keyed by OD, not by position)', () => {
    const roads = grid();
    const area = new StudyAreaExplorer().explore(roads, 1, { seedRoadIds: ['h2_1'], rangeMeters: 1500, direction: 'both' });
    const nodes = [...area.network.nodes.values()];
    const near = (p: [number, number]) => { const q = pt(...p); return nodes.reduce((b, n) => (Math.hypot(n.coordinates[0] - q[0], n.coordinates[1] - q[1]) < Math.hypot(b.coordinates[0] - q[0], b.coordinates[1] - q[1]) ? n : b)).id; };
    const trips: MicroDemandTrip[] = [];
    for (const a of corners) for (const b of corners) if (a !== b) trips.push({ fromNodeId: near(a), toNodeId: near(b), vehiclesPerHour: 80, kind: 'car' });
    const run = (list: MicroDemandTrip[]) => {
      const sim = new TrafficMicroSim(area, new Map(roads.map(r => [r.id, r])), { demandLevel: 0.12, seed: 42, demandTrips: list });
      for (let i = 0; i < Math.round(400 / STEP_S); i++) sim.step();
      const m = sim.getMetrics();
      return [m.completedTrips, m.meanTravelTimeS, m.meanDelayS];
    };
    const a = run(trips);
    // Same OD streams, other order (as an edit elsewhere in the area can leave them)
    const b = run([...trips].reverse());
    expect(a[0]).toBeGreaterThan(20);
    expect(b).toEqual(a);
  }, 60000);

  it('an edit outside the study area changes nothing; one outside the neighbourhood changes it little; unrelated edits differ', async () => {
    const seeds = [42, 7];
    const base = await runAnalysisJob(job(grid(), seeds), undefined, 1e9);
    const far = await runAnalysisJob(job(widen(grid(), 'far'), seeds), undefined, 1e9);
    expect(nb(far)).toEqual(nb(base));
    // A road in the area but outside the 400 m neighbourhood: it can re-route a little, so the
    // neighbourhood trip list changes; its own traffic must not be re-drawn
    const outside = await runAnalysisJob(job(widen(grid(), 'h0_0'), seeds), undefined, 1e9);
    const rel = (a: number | null, b: number | null) => (a && b ? Math.abs(b - a) / a : 0);
    outside.result.perSeed.forEach((s, i) => {
      expect(rel(base.result.perSeed[i].meanTravelTimeS, s.meanTravelTimeS)).toBeLessThan(0.03);
    });
    // Two different edits in the neighbourhood do not give the same change
    const a = await runAnalysisJob(job(widen(grid(), 'h2_1'), seeds), undefined, 1e9);
    const b = await runAnalysisJob(job(widen(grid(), 'v2_1'), seeds), undefined, 1e9);
    expect(nb(a)).not.toEqual(nb(b));
  }, 240000);
});

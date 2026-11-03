import { describe, expect, it } from 'vitest';
import type { BuildingObject, RoadObject } from '../objects/types';
import { StudyAreaExplorer } from '../simulation/StudyAreaExplorer';
import { compileAreaDemand, cordonOf, externalShare, EDGE_FLOW_PER_LANE_VPH } from '../simulation/AreaDemand';
import { roadSection, SECTION_MAX_M } from '../simulation/roadSection';
import { snapDemandPlan } from '../simulation/StudyDemand';
import { TrafficMicroSim, STEP_S } from '../simulation/TrafficMicroSim';
import { runAnalysisJob, type AnalysisJob } from '../simulation/analysisJob';
import { compareAnalyses } from '../simulation/ScenarioComparison';
import { loadCheck } from '../simulation/RoadAnalysis';

const pt = (x: number, y = 0, z = 0): [number, number, number] => [73.8 + x / (111320 * Math.cos(18.5 * Math.PI / 180)), 18.5 + y / 111320, z];
const road = (id: string, a: [number, number], b: [number, number], extra: Partial<RoadObject> = {}) =>
  ({ id, type: 'road', coordinates: [pt(...a), pt(...b)], roadClass: 'arterial', laneCount: 2, laneWidth: 3.5, speedLimit: 50, connectedJunctions: [], scenarioId: 'base', ...extra } as RoadObject);
const building = (id: string, x: number, y: number, residents = 0, employees = 0) =>
  ({ id, type: 'building', coordinates: [pt(x - 1, y - 1), pt(x + 1, y - 1), pt(x + 1, y + 1), pt(x - 1, y + 1)], residents, employees } as BuildingObject);

/**
 * A main road west-east (pieces named "Main Road"/"Main Marg", as OSM splits
 * one road into many ways), a collector crossing it at x=400, and a one-way
 * lane that only leads onto the main road at x=800.
 */
const roads = [
  road('w2', [-1500, 0], [-800, 0], { name: 'Main Road' }), road('w1', [-800, 0], [0, 0], { name: 'Main Road' }),
  road('m1', [0, 0], [400, 0], { name: 'Main Marg' }), road('m2', [400, 0], [800, 0], { name: 'Main Road' }),
  road('e1', [800, 0], [1600, 0], { name: 'Main Road' }), road('e2', [1600, 0], [2300, 0], { name: 'Main Road' }),
  road('cross', [400, -800], [400, 0], { name: 'Cross Road', roadClass: 'collector' }), road('cross2', [400, 0], [400, 800], { name: 'Cross Road', roadClass: 'collector' }),
  road('ow', [800, 900], [800, 0], { name: 'One Way Lane', roadClass: 'local', isOneWay: true }),
];
const roadMap = new Map(roads.map(r => [r.id, r]));
const explore = (rs: RoadObject[] = roads) => new StudyAreaExplorer().explore(rs, 1, { seedRoadIds: ['m1'], rangeMeters: 600, direction: 'both' });

describe('road section', () => {
  it('follows the same road across OSM pieces and stops at the next main road', () => {
    const s = roadSection(explore(), roadMap, ['m1']);
    // "Main Marg" and "Main Road" are one road; the collector at x=400 ends it eastwards, the length limit westwards
    expect(new Set(s.roadIds)).toEqual(new Set(['m1', 'w1']));
    expect(s.endsAt).toEqual(['Cross Road']);
    expect(s.carriageways).toBe(1);
    expect(s.lengthM).toBeGreaterThan(1150); expect(s.lengthM).toBeLessThan(400 + SECTION_MAX_M + 1);
  });
  it('takes both carriageways of a divided road and reports its length once', () => {
    const nb = road('nb', [0, 6], [800, 6], { name: 'Divided Road', isOneWay: true });
    const sb = road('sb', [800, -6], [0, -6], { name: 'Divided Road', isOneWay: true });
    const rs = [nb, sb, road('l', [-300, 6], [0, 6], { name: 'Divided Road', isOneWay: true }), road('r', [0, -6], [-300, -6], { name: 'Divided Road', isOneWay: true })];
    const a = new StudyAreaExplorer().explore(rs, 1, { seedRoadIds: ['nb'], rangeMeters: 400, direction: 'both' });
    const s = roadSection(a, new Map(rs.map(r => [r.id, r])), ['nb']);
    expect(s.roadIds).toContain('sb');
    expect(s.carriageways).toBe(2);
    expect(s.lengthM).toBeCloseTo(s.segmentKeys.reduce((n, k) => n + a.segments.find(x => x.key === k)!.lengthM, 0) / 2, 6);
  });
});

describe('area demand', () => {
  const ctx = { buildings: [building('home', 10, 5, 3000), building('work', 790, 5, 0, 3000), building('lane', 800, 880, 0, 3000)] };
  it('labels internal, edge and through parts and sizes the edge by lanes and class', () => {
    const a = explore();
    const cordon = cordonOf(a, roadMap);
    expect(cordon.map(c => c.roadId).sort()).toEqual(['e2', 'w2']);
    for (const c of cordon) { expect(c.inVph).toBe(c.inLanes * EDGE_FLOW_PER_LANE_VPH.arterial); expect(c.outVph).toBe(c.outLanes * EDGE_FLOW_PER_LANE_VPH.arterial); }
    const plan = compileAreaDemand(ctx, a, roadMap)!;
    const c = plan.provenance.components!;
    expect(c.internal).toBeGreaterThan(0); expect(c.outbound).toBeGreaterThan(0); expect(c.inbound).toBeGreaterThan(0); expect(c.through).toBeGreaterThan(0);
    // The parts add up to the plan, and each edge point carries no more than its class-typical flow
    expect(c.internal + c.outbound + c.inbound + c.through).toBeCloseTo(plan.provenance.vehiclesPerHour, 3);
    // Through traffic is only the part of an edge's flow the area's own trips leave over
    const at = (p: readonly number[], q: readonly number[]) => Math.hypot(p[0] - q[0], p[1] - q[1]) < 1e-9;
    const isCordon = (p: readonly number[]) => cordon.some(cp => at(cp.coordinates, p));
    for (const cp of cordon) {
      const from = plan.trips.filter(t => at(t.from, cp.coordinates));
      const through = from.filter(t => isCordon(t.to)).reduce((n, t) => n + t.vehiclesPerHour, 0);
      const inbound = from.filter(t => !isCordon(t.to)).reduce((n, t) => n + t.vehiclesPerHour, 0);
      expect(through).toBeLessThanOrEqual(Math.max(0, cp.inVph - inbound) + 1e-6);
    }
    expect(plan.provenance.label).toMatch(/estimated/i);
    // A small area keeps few of its trips inside: Pune trips average 4.7-8.5 km (CMP 2018)
    expect(c.internal).toBeLessThan(c.outbound);
    const noThrough = compileAreaDemand(ctx, a, roadMap, { through: false })!;
    expect(noThrough.provenance.components!.through).toBe(0);
    expect(noThrough.provenance.components!.throughIncluded).toBe(false);
  });
  it('never sends edge trips where they cannot drive, and reports them', () => {
    const a = explore();
    const plan = compileAreaDemand(ctx, a, roadMap)!;
    // Jobs up the one-way lane cannot be reached by road at all: no trip ends there, and the loss is reported
    const lane = pt(800, 900);
    const endsThere = plan.trips.filter(t => Math.hypot(t.to[0] - lane[0], t.to[1] - lane[1]) < 1e-6);
    expect(endsThere).toHaveLength(0);
    expect(plan.provenance.components!.noEdgeRoute).toBeGreaterThan(0);
    expect(plan.provenance.label).toMatch(/left out/);
    // Every trip in the plan can be routed on the network
    const sim = new TrafficMicroSim(a, roadMap, { demandLevel: 0.12, seed: 1, demandTrips: snapDemandPlan(plan, a.network, 250, new Set(a.segments.map(s => s.key))) });
    expect(sim.demandRouteFlows().every(f => f.route.length > 0)).toBe(true);
  });
  it('keeps every trip inside a closed network', () => {
    const closed = [road('a', [0, 0], [600, 0]), road('b', [600, 0], [1200, 0])];
    const a = new StudyAreaExplorer().explore(closed, 1, { seedRoadIds: ['a'], rangeMeters: 2000, direction: 'both' });
    const plan = compileAreaDemand({ buildings: [building('h', 0, 5, 3000), building('w', 1200, 5, 0, 3000)] }, a, new Map(closed.map(r => [r.id, r])))!;
    expect(plan.provenance.components).toMatchObject({ outbound: 0, inbound: 0, through: 0, noEdgeRoute: 0 });
    expect(plan.provenance.components!.internal).toBeGreaterThan(0);
  });
  it('external share grows as the area shrinks relative to the mean trip length', () => {
    const square = (m: number): [number, number][] => [pt(-m, -m), pt(m, -m), pt(m, m), pt(-m, m)].map(p => [p[0], p[1]]);
    const centre = pt(0, 0);
    expect(externalShare(centre, square(500), 7)).toBeGreaterThan(externalShare(centre, square(3000), 7));
    expect(externalShare(centre, square(500), 7)).toBeGreaterThan(0.9);
    expect(externalShare(centre, square(20000), 7)).toBeLessThan(0.05);
  });
});

describe('select-link and arrival heap', () => {
  const area = explore();
  const node = (x: number, y = 0) => [...area.network.nodes.values()].sort((p, q) => Math.hypot(p.coordinates[0] - pt(x, y)[0], p.coordinates[1] - pt(x, y)[1]) - Math.hypot(q.coordinates[0] - pt(x, y)[0], q.coordinates[1] - pt(x, y)[1]))[0].id;
  const section = roadSection(area, roadMap, ['m1']);
  it('counts on every link only the vehicles routed over the watched section', () => {
    // West to east crosses the section; north to south on the collector never touches it
    const demandTrips = [{ fromNodeId: node(-800), toNodeId: node(1600), vehiclesPerHour: 300, kind: 'car' as const },
      { fromNodeId: node(400, 800), toNodeId: node(400, -800), vehiclesPerHour: 300, kind: 'car' as const }];
    const sim = new TrafficMicroSim(area, roadMap, { demandLevel: 0.12, seed: 7, demandTrips, watchSegmentKeys: section.segmentKeys });
    sim.startAnalysis();
    for (let i = 0; i < 900 / STEP_S; i++) sim.step();
    const c = sim.analysisCounts()!;
    const at = (seg: string) => c.links.filter(l => l.segmentKey === seg);
    const sum = (ls: typeof c.links, k: 'entries' | 'selectEntries') => ls.reduce((n, l) => n + l[k], 0);
    expect(sum(at('m1_seg_1'), 'entries')).toBeGreaterThan(20);
    expect(sum(at('m1_seg_1'), 'selectEntries')).toBe(sum(at('m1_seg_1'), 'entries'));
    // Downstream of the section, the east-bound traffic is all select-link traffic
    expect(sum(at('e1_seg_1'), 'selectEntries')).toBe(sum(at('e1_seg_1'), 'entries'));
    // The collector carries traffic, none of it over the section
    expect(sum(at('cross_seg_0'), 'entries')).toBeGreaterThan(20);
    expect(sum(at('cross_seg_0'), 'selectEntries')).toBe(0);
    expect([...c.selectOd.values()].reduce((n, v) => n + v, 0)).toBeGreaterThan(0);
    expect(c.links.filter(l => l.watched).every(l => section.segmentKeys.includes(l.segmentKey))).toBe(true);
  });
  it('releases arrivals in time order and replays identically, also after the hour changes', () => {
    const many = Array.from({ length: 40 }, (_, i) => ({ fromNodeId: node(-800), toNodeId: node(i % 2 ? 1600 : 400, i % 2 ? 0 : 800), vehiclesPerHour: 20 + i, kind: 'car' as const }));
    const make = () => new TrafficMicroSim(area, roadMap, { demandLevel: 0.12, seed: 3, demandTrips: many });
    const a = make(), b = make();
    for (let i = 0; i < 300 / STEP_S; i++) { a.step(); b.step(); if (i === 100) { a.setHourFactor(0.6); b.setHourFactor(0.6); } }
    expect(a.getMetrics()).toEqual(b.getMetrics());
    expect(a.getMetrics().entries + a.getMetrics().waitingToEnter).toBeGreaterThan(0);
    // The heap pops indices in nondecreasing next-arrival order
    const h = a as unknown as { arrivalHeap: number[]; odArrivals: { nextT: number }[]; heapPop(): number };
    const order: number[] = [];
    while (h.arrivalHeap.length) order.push(h.odArrivals[h.heapPop()].nextT);
    expect(order.length).toBe(many.length);
    for (let i = 1; i < order.length; i++) expect(order[i]).toBeGreaterThanOrEqual(order[i - 1]);
    for (const t of order) expect(t).toBeGreaterThan(300 - STEP_S);
  });
});

describe('scenario comparison on frozen demand', () => {
  const area = explore();
  const plan = compileAreaDemand({ buildings: [building('home', 10, 5, 3000), building('work', 790, 5, 0, 3000)] }, area, roadMap)!;
  const job = (a = area, rs: ReadonlyMap<string, RoadObject> = roadMap): AnalysisJob => ({ area: a, roads: rs, options: { demandLevel: 0.12, seed: 42 }, plan, section: roadSection(a, rs, ['m1']), hourFactor: 1, feedbackIterations: 0, warmupS: 120, measureS: 300 });
  it('reports no change for the same network and labels a road change as infrastructure-only', async () => {
    const before = await runAnalysisJob(job(), undefined, 1e9);
    const again = await runAnalysisJob(job(), undefined, 1e9);
    expect(again.result.network).toEqual(before.result.network);
    const same = compareAnalyses(before, again, { before: roadMap, after: roadMap }, { before: plan.provenance.vehiclesPerHour, after: plan.provenance.vehiclesPerHour });
    expect(same.kind).toBe('infrastructure');
    expect(same.verdict).toMatchObject({ section: 'no_change', network: 'no_change' });
    // Close the crossing collector north of the main road: same demand, a different network
    const closedRoads = roads.filter(r => r.id !== 'cross2');
    const closedMap = new Map(closedRoads.map(r => [r.id, r]));
    const closedArea = explore(closedRoads);
    const after = await runAnalysisJob({ ...job(closedArea, closedMap) }, undefined, 1e9);
    const cmp = compareAnalyses(before, after, { before: roadMap, after: closedMap }, { before: plan.provenance.vehiclesPerHour, after: plan.provenance.vehiclesPerHour });
    expect(cmp.kind).toBe('infrastructure');
    expect(cmp.demandAfter).toBe(cmp.demandBefore);
    expect(cmp.caveats.some(c => /seed/.test(c))).toBe(true);
    // A demand change is never passed off as a road effect
    const dev = compareAnalyses(before, after, { before: roadMap, after: closedMap }, { before: 1000, after: 1500 });
    expect(dev.kind).toBe('development');
    expect(dev.caveats[0]).toMatch(/land use changed/i);
  });
});

describe('demand beyond modelled capacity', () => {
  it('states plainly when the network could not take the demand', () => {
    const ok = loadCheck(1000, { releasedVehicles: 240, capShare: 0, gridlockRemovals: 0 }, 900, 3);
    expect(ok.overloaded).toBe(false); expect(ok.message).toBeNull();
    const over = loadCheck(10000, { releasedVehicles: 1000, capShare: 0.4, gridlockRemovals: 100 }, 900, 4800);
    expect(over.overloaded).toBe(true);
    expect(over.servedShare).toBeCloseTo(0.4, 6);
    expect(over.message).toMatch(/exceeds what the modelled network can carry/);
    expect(over.message).toMatch(/4,800 vehicles were still waiting/);
    expect(over.message).toMatch(/5,000-vehicle limit/);
  });
  it('flags an overloaded run in the analysis and its comparison, and not a light one', async () => {
    const area = explore();
    const base = compileAreaDemand({ buildings: [building('home', 10, 5, 3000), building('work', 790, 5, 0, 3000)] }, area, roadMap)!;
    const heavy = { ...base, trips: base.trips.map(t => ({ ...t, vehiclesPerHour: t.vehiclesPerHour * 8 })), provenance: { ...base.provenance, vehiclesPerHour: base.provenance.vehiclesPerHour * 8 } };
    const job = (plan: typeof base): AnalysisJob => ({ area, roads: roadMap, options: { demandLevel: 0.12, seed: 42 }, plan, section: roadSection(area, roadMap, ['m1']), hourFactor: 1, feedbackIterations: 1, warmupS: 120, measureS: 300 });
    const light = await runAnalysisJob(job(base), undefined, 1e9);
    const jam = await runAnalysisJob(job(heavy), undefined, 1e9);
    expect(light.result.load.overloaded).toBe(false);
    expect(jam.result.load.overloaded).toBe(true);
    expect(jam.result.reasons[0]).toBe(jam.result.load.message);
    // Delays measured in a jammed run are not used to re-route drivers, and the panel says so
    expect(light.adaptation.applied).toBe(true);
    expect(jam.adaptation.applied).toBe(false);
    expect(jam.adaptation.reason).toMatch(/past its modelled capacity/);
    const cmp = compareAnalyses(light, jam, { before: roadMap, after: roadMap }, { before: 1, after: 1 });
    expect(cmp.caveats.some(c => /exceeds what the modelled network can carry/.test(c))).toBe(true);
  });
});

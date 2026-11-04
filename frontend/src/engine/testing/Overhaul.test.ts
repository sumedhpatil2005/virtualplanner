import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import type { RoadObject } from '../objects/types';
import type { DrivableObject } from '../simulation/StudyAreaExplorer';
import { StudyAreaExplorer } from '../simulation/StudyAreaExplorer';
import { urbanSpeeds, applyUrbanSpeeds, midblockCapacityPcu, speedLos, URBAN_SPEED_CEILING_KMH } from '../simulation/roadParameters';
import { assignTraffic, bprTime, selectLink, subareaDemand } from '../simulation/staticAssignment';
import { TrafficMicroSim, STEP_S } from '../simulation/TrafficMicroSim';
import { roadSection } from '../simulation/roadSection';
import { sectionDirections, readCorridorRun, areaContext, combineAnalysis } from '../simulation/RoadAnalysis';
import { SimulationMode } from '../simulation/SimulationMode';

/**
 * The overhaul (docs/OVERHAUL.md): urban free-flow speeds, IRC capacities and
 * level of service; the area assignment; delay attribution and queue tracing;
 * the live-view lifecycle (nothing keeps running once stopped or closed).
 */

const LAT0 = 18.5;
const pt = (x: number, y: number, z = 0): [number, number, number] => [73.8 + x / (111320 * Math.cos(LAT0 * Math.PI / 180)), LAT0 + y / 111320, z];
const osmTags = (highway: string, extra: Record<string, string> = {}) => ({ osmId: 1, originalTags: { highway, ...extra }, layer: 0, bridge: false, tunnel: false, roundabout: false });
const road = (id: string, a: [number, number], b: [number, number], extra: Partial<RoadObject> = {}): RoadObject => ({
  id, type: 'road', name: id, layerId: 'roads', scenarioId: 'base', coordinates: [pt(...a), pt(...b)], roadClass: 'arterial', width: 10, laneCount: 2, laneWidth: 3.5,
  hasDivider: false, dividerWidth: 0, hasFootpath: false, footpathWidth: 0, speedLimit: 50, isOneWay: false, trafficCapacity: 2000, connectedJunctions: [], createdAt: '', updatedAt: '', ...extra,
} as RoadObject);

describe('free-flow speeds for a city', () => {
  it('uses the OSM limit, else one tagged on the same road, else an urban default never above 50 km/h', () => {
    const roads = [
      road('osm_1', [0, 0], [100, 0], { name: 'Shivaji Road', speedLimit: 100, osmProvenance: osmTags('trunk', { maxspeed: '40' }) }),
      road('osm_2', [100, 0], [200, 0], { name: 'Shivaji Road', speedLimit: 100, osmProvenance: osmTags('trunk') }),
      road('osm_3', [200, 0], [300, 0], { name: 'Other Road', speedLimit: 100, osmProvenance: osmTags('trunk') }),
      road('osm_4', [0, 0], [0, 100], { name: 'Lane', speedLimit: 50, osmProvenance: osmTags('residential') }),
      road('built', [300, 0], [400, 0], { speedLimit: 70 }),
    ];
    const { speeds, report } = urbanSpeeds(roads);
    expect(speeds.get('osm_1')).toEqual({ kmh: 40, basis: 'tagged' });
    expect(speeds.get('osm_2')).toEqual({ kmh: 40, basis: 'inherited' });
    expect(speeds.get('osm_3')).toEqual({ kmh: URBAN_SPEED_CEILING_KMH, basis: 'urban-default' });
    expect(speeds.get('osm_4')).toEqual({ kmh: 30, basis: 'urban-default' });
    expect(speeds.get('built')).toEqual({ kmh: 70, basis: 'user' });
    expect(report).toMatchObject({ tagged: 1, inherited: 1, urbanDefault: 2, user: 1 });
    // The stored roads are not changed
    expect(applyUrbanSpeeds(roads).roads[2].speedLimit).toBe(50);
    expect(roads[2].speedLimit).toBe(100);
  });

  it('gives IRC:106-1990 mid-block capacities (design service volume / 0.70)', () => {
    const trunk = road('t', [0, 0], [1, 0], { osmProvenance: osmTags('trunk') });
    const lane = road('l', [0, 0], [1, 0], { osmProvenance: osmTags('residential') });
    // 4-lane undivided arterial: 3000 PCU/h both ways -> 1500 per direction / 0.7
    expect(midblockCapacityPcu(trunk, 2, true, false)).toBeCloseTo(1500 / 0.7, 6);
    // 2-lane two-way collector: 900 both ways
    expect(midblockCapacityPcu(lane, 1, true, false)).toBeCloseTo(450 / 0.7, 6);
    // 2-lane one-way arterial street: 2400
    expect(midblockCapacityPcu(trunk, 2, false, false)).toBeCloseTo(2400 / 0.7, 6);
  });

  it('grades level of service from speed as a share of free flow (Indo-HCM urban streets)', () => {
    expect(speedLos(0.9, null)).toBe('A');
    expect(speedLos(0.8, null)).toBe('B');
    expect(speedLos(0.6, null)).toBe('C');
    expect(speedLos(0.45, null)).toBe('D');
    expect(speedLos(0.3, null)).toBe('E');
    expect(speedLos(0.2, null)).toBe('F');
    expect(speedLos(0.9, 1.2)).toBe('F');
    // 27 km/h on a 45 km/h road is ordinary urban traffic (C), not "congested"
    expect(speedLos(27 / 45, null)).toBe('C');
  });
});

/** A road in 250 m pieces (the study area cuts between pieces, so its ends become ways in and out). */
const pieces = (prefix: string, a: [number, number], b: [number, number], extra: Partial<RoadObject> = {}): RoadObject[] => {
  const n = Math.max(1, Math.round(Math.hypot(b[0] - a[0], b[1] - a[1]) / 250));
  return Array.from({ length: n }, (_, i) => road(`${prefix}${i}`, [a[0] + (b[0] - a[0]) * i / n, a[1] + (b[1] - a[1]) * i / n], [a[0] + (b[0] - a[0]) * (i + 1) / n, a[1] + (b[1] - a[1]) * (i + 1) / n], { name: prefix, ...extra }));
};

/** Two routes from west to east: a direct road and a longer bypass. */
const twoRoutes = (): DrivableObject[] => [
  ...pieces('West', [-1500, 0], [0, 0]),
  road('direct', [0, 0], [500, 0], { name: 'Direct', laneCount: 2 }),
  road('n1', [0, 0], [0, 300], { name: 'Bypass' }), road('n2', [0, 300], [500, 300], { name: 'Bypass' }), road('n3', [500, 300], [500, 0], { name: 'Bypass' }),
  ...pieces('East', [500, 0], [2000, 0]),
];

describe('area assignment (user equilibrium)', () => {
  const roads = twoRoutes();
  const map = new Map(roads.map(r => [r.id, r]));
  const area = new StudyAreaExplorer().explore(roads, 1, { seedRoadIds: ['direct'], rangeMeters: 600, direction: 'both' });
  const byX = [...area.boundary].sort((a, b) => a.coordinates[0] - b.coordinates[0]);
  const west = byX[0], east = byX[byX.length - 1];
  const trips = [{ fromNodeId: west.nodeId, toNodeId: east.nodeId, vehiclesPerHour: 3000, kind: 'car' as const }];

  it('splits heavy demand so the used routes take the same time, and is deterministic', () => {
    const a = assignTraffic(area, map, trips);
    const b = assignTraffic(area, map, trips);
    expect(Array.from(a.volVeh)).toEqual(Array.from(b.volVeh));
    const direct = a.links.find(l => l.roadId === 'direct' && l.id.endsWith('_fwd'))!;
    const bypass = a.links.filter(l => l.roadId.startsWith('n') && (l.roadId === 'n1' ? l.id.endsWith('_fwd') : l.roadId === 'n2' ? l.id.endsWith('_fwd') : l.id.endsWith('_fwd')));
    const vd = a.volVeh[direct.index];
    expect(vd).toBeGreaterThan(0);
    expect(vd).toBeLessThan(3000); // some traffic uses the bypass at equilibrium
    expect(a.relativeGap).toBeLessThan(0.01);
    // Equal times on both routes (Wardrop): direct time vs bypass time
    const tDirect = a.timeS[direct.index];
    const tBypass = bypass.reduce((n, l) => n + (a.volVeh[l.index] > 1 ? a.timeS[l.index] : 0), 0);
    if (tBypass > 0) expect(Math.abs(tDirect - tBypass) / tDirect).toBeLessThan(0.05);
    expect(bprTime(10, 1000, 1000)).toBeCloseTo(11.5, 6);
  });

  it('knows who uses a road (select-link) and cuts paths to a sub-area', () => {
    const a = assignTraffic(area, map, trips);
    const direct = new Set(a.links.filter(l => l.roadId === 'direct').map(l => l.index));
    const sl = selectLink(a, direct);
    expect(sl.byOd.reduce((n, x) => n + x.veh, 0)).toBeCloseTo(a.volVeh[[...direct].find(i => a.links[i].id.endsWith('_fwd'))!], 3);
    // Sub-area: the direct road alone; its trips enter at its west end and leave at its east end
    const inside = new Set(area.segments.filter(s => s.roadId === 'direct').map(s => s.key));
    const sub = subareaDemand(a, inside);
    expect(sub.reduce((n, t) => n + t.vehiclesPerHour, 0)).toBeCloseTo(sl.byOd.reduce((n, x) => n + x.veh, 0), 3);
    expect(sub.every(t => t.viaLinkIds.every(id => id.startsWith('direct')))).toBe(true);
  });
});

describe('delay attribution and queue tracing', () => {
  /**
   * The section (sec, 300 m) leads onto a short link (b, 60 m) that ends at a
   * signalised crossroads. Heavy traffic through the signal backs up along b
   * and onto the section: the section's vehicles are held by a full road
   * ahead, and the queue is traced to the signal.
   */
  it('charges the section\'s waiting to the queue from the signal further on, and finds that signal', () => {
    const roads: DrivableObject[] = [
      ...pieces('Main Road', [-1500, 0], [0, 0], { laneCount: 1 }), road('sec', [0, 0], [300, 0], { name: 'Section Road', laneCount: 1 }),
      road('b', [300, 0], [360, 0], { name: 'Link Road', laneCount: 1 }), ...pieces('East Road', [360, 0], [1860, 0], { laneCount: 1 }),
      ...pieces('Cross S', [360, -1500], [360, 0], { laneCount: 1 }), ...pieces('Cross N', [360, 0], [360, 1500], { laneCount: 1 }),
    ];
    const map = new Map(roads.map(r => [r.id, r]));
    const area = new StudyAreaExplorer().explore(roads, 1, { seedRoadIds: ['sec'], rangeMeters: 700, direction: 'both' });
    const section = roadSection(area, map, ['sec']);
    const byX = [...area.boundary].sort((a, b) => a.coordinates[0] - b.coordinates[0]), byY = [...area.boundary].sort((a, b) => a.coordinates[1] - b.coordinates[1]);
    const west = byX[0], east = byX[byX.length - 1], south = byY[0], north = byY[byY.length - 1];
    const sim = new TrafficMicroSim(area, map, { demandLevel: 0.12, seed: 3, signalPoints: [[pt(360, 0)[0], pt(360, 0)[1]]], watchSegmentKeys: section.segmentKeys,
      demandTrips: [{ fromNodeId: west.nodeId, toNodeId: east.nodeId, vehiclesPerHour: 1400, kind: 'car' }, { fromNodeId: south.nodeId, toNodeId: north.nodeId, vehiclesPerHour: 900, kind: 'car' }] });
    sim.setHourFactor(1);
    for (let i = 0; i < 300 / STEP_S; i++) sim.step();
    sim.startAnalysis();
    for (let i = 0; i < 600 / STEP_S; i++) sim.step();
    const dirs = sectionDirections(area, section);
    const run = readCorridorRun(sim, 3, area, map, section, dirs, 2300);
    const east1 = run.directions.find(d => d.vph > 0)!;
    expect(east1.delay).not.toBeNull();
    expect(east1.delay!.blocked).toBeGreaterThan(0);
    const chain = run.chains.find(c => c?.root);
    expect(chain?.root?.cause).toBe('signal');
    expect(chain!.segmentKeys.some(k => k.startsWith('b_'))).toBe(true);

    // The cause is named only when most runs trace the queue to the same junction
    const trips = [{ fromNodeId: west.nodeId, toNodeId: east.nodeId, vehiclesPerHour: 1400, kind: 'car' as const }, { fromNodeId: south.nodeId, toNodeId: north.nodeId, vehiclesPerHour: 900, kind: 'car' as const }];
    const ctx = areaContext(assignTraffic(area, map, trips), area, map, section, dirs, 2300);
    const info = { roads: 1, demandVph: 2300, rangeM: 700 };
    const untraced = { ...run, seed: 4, chains: run.chains.map(() => null) };
    const one = combineAnalysis(ctx, [run], dirs, section, info, null);
    expect(one.cause.kind).toBe('spillback');
    expect(one.cause.text).toMatch(/in the one run analysed/);
    expect(combineAnalysis(ctx, [run, { ...run, seed: 5 }, untraced], dirs, section, info, null).cause.text).toMatch(/in 2 of 3 runs/);
    const minority = combineAnalysis(ctx, [run, untraced, { ...untraced, seed: 6 }], dirs, section, info, null);
    expect(minority.cause.kind).toBe('insufficient');
    expect(minority.cause.chain).toBeNull();
    expect(minority.cause.text).toMatch(/only 1 of 3 runs/);
  }, 60000);
});

describe('live view lifecycle', () => {
  let frames: FrameRequestCallback[] = [];
  beforeEach(() => {
    frames = [];
    vi.stubGlobal('requestAnimationFrame', (cb: FrameRequestCallback) => { frames.push(cb); return frames.length; });
    vi.stubGlobal('cancelAnimationFrame', () => {});
  });
  afterEach(() => vi.unstubAllGlobals());
  const corridor = (): DrivableObject[] => {
    const roads: DrivableObject[] = [road('mid', [0, 0], [600, 0])];
    for (let x = 0; x > -3000; x -= 250) roads.push(road(`w${-x}`, [x - 250, 0], [x, 0]));
    for (let x = 600; x < 3600; x += 250) roads.push(road(`e${x}`, [x, 0], [x + 250, 0]));
    return roads;
  };
  const until = async (cond: () => boolean, ms = 60000) => { const t0 = Date.now(); while (!cond()) { if (Date.now() - t0 > ms) throw new Error('timed out'); await new Promise(r => setTimeout(r, 20)); } };
  const idle = (m: SimulationMode) => { const r = m.resources(); return !r.liveSim && !r.animationFrame && !r.warmup && !r.analysisRunning && !r.comparisonRunning && !r.timelineRunning; };

  it('does not start by itself, starts on request after a warm-up, and stops completely', async () => {
    const roads = corridor();
    const mode = new SimulationMode(() => roads, null, null, () => ({}), () => Promise.reject(new Error('no counts')), null, null);
    mode.analysisSeeds = [42];
    mode.enter();
    mode.setRange(500);
    mode.selectRoad('mid', false);
    expect(mode.getState().traffic.status).toBe('idle');
    mode.startTraffic();
    expect(mode.getState().traffic.status).toBe('preparing');
    await until(() => mode.getState().traffic.status === 'running');
    expect(mode.getState().traffic.metrics!.timeS).toBeGreaterThanOrEqual(mode.getState().traffic.warmupS - STEP_S);
    expect(mode.resources().liveSim).toBe(true);
    mode.pauseTraffic();
    expect(mode.getState().traffic.status).toBe('paused');
    expect(mode.resources().animationFrame).toBe(false);
    mode.resumeTraffic();
    expect(mode.getState().traffic.status).toBe('running');
    mode.stopTraffic();
    expect(mode.getState().traffic.status).toBe('idle');
    expect(idle(mode)).toBe(true);
    mode.dispose();
  }, 120000);

  it('closing Simulate stops everything; reopening keeps the result and starts nothing', async () => {
    const roads = corridor();
    const mode = new SimulationMode(() => roads, null, null, () => ({}), () => Promise.reject(new Error('no counts')), null, null);
    mode.analysisSeeds = [42];
    mode.enter();
    mode.setRange(500);
    mode.selectRoad('mid', false);
    mode.startTraffic();
    await until(() => mode.getState().traffic.status === 'running');
    const output = mode.getState().analysis.output;
    mode.exit();
    expect(idle(mode)).toBe(true);
    expect(mode.getState().traffic.status).toBe('idle');
    await new Promise(r => setTimeout(r, 800));
    expect(idle(mode)).toBe(true);
    mode.enter();
    await new Promise(r => setTimeout(r, 800));
    expect(mode.getState().traffic.status).toBe('idle');
    expect(mode.getState().analysis.output).toBe(output);
    expect(idle(mode)).toBe(true);
    mode.dispose();
  }, 120000);

  it('closing during a running analysis stops it and says so', async () => {
    const roads = corridor();
    const mode = new SimulationMode(() => roads, null, null, () => ({}), () => Promise.reject(new Error('no counts')), null, null);
    mode.enter();
    mode.setRange(500);
    mode.selectRoad('mid', false);
    await until(() => mode.getState().analysis.status === 'running');
    mode.exit();
    expect(mode.resources().analysisRunning).toBe(false);
    expect(mode.getState().notice).toMatch(/road analysis/);
    mode.dispose();
  }, 60000);
});

import { describe, it, expect } from 'vitest';
import type { RoadObject } from '../objects/types';
import { StudyAreaExplorer } from '../simulation/StudyAreaExplorer';
import type { DemandPlan } from '../simulation/StudyDemand';
import { geh, summarizeGeh, GEH_TARGET_SHARE } from '../calibration/geh';
import { calibrateFlows, assignedFlows } from '../calibration/ipf';
import { assignCardinals, turnBetween, layoutZone, routeMovements, bearingDeg, movementKey } from '../calibration/junctionMovements';
import { validateCountDataset, movementVeh, shortCitation, type CountDataset, type CountJunction } from '../calibration/observedCounts';
import { fitPlan, measureFlows, compareRows, summarize, zoneFor, junctionsIn, rowsToCsv, buildSim } from '../calibration/calibration';

// ── GEH ────────────────────────────────────────────────────────────────────
describe('GEH statistic', () => {
  it('matches the textbook formula', () => {
    expect(geh(100, 100)).toBe(0);
    expect(geh(0, 0)).toBe(0);
    expect(geh(150, 100)).toBeCloseTo(Math.sqrt(2 * 50 ** 2 / 250), 10); // 4.472
    expect(geh(1000, 1200)).toBeCloseTo(Math.sqrt(2 * 200 ** 2 / 2200), 10); // 6.03
    expect(geh(0, 50)).toBeCloseTo(10, 10);
    expect(geh(80, 100)).toBeCloseTo(geh(100, 80), 12); // symmetric
  });
  it('rejects negative or non-finite flows rather than producing a number', () => {
    expect(geh(-1, 10)).toBeNaN();
    expect(geh(NaN, 10)).toBeNaN();
  });
  it('summarises the share under 5 against the 85% target', () => {
    const s = summarizeGeh([1, 2, 3, 4, 4.99, 6, 1, 1, 1, 1]);
    expect(s.n).toBe(10);
    expect(s.pass).toBe(9);
    expect(s.share).toBeCloseTo(0.9);
    expect(s.meetsTarget).toBe(true);
    expect(summarizeGeh([1, 6]).meetsTarget).toBe(false);
    expect(summarizeGeh([]).share).toBeNull();
    expect(GEH_TARGET_SHARE).toBe(0.85);
  });
});

// ── IPF ────────────────────────────────────────────────────────────────────
describe('bounded IPF on a toy network', () => {
  // Three OD trips over two counted movements: trip 0 uses a, trip 1 uses a and b, trip 2 uses b.
  const incidence = [['a'], ['a', 'b'], ['b']];
  it('converges when counts are consistent', () => {
    const flows = [100, 100, 100];
    const observed = new Map([['a', 300], ['b', 150]]);
    const r = calibrateFlows(flows, incidence, observed, { tolerance: 0.001 });
    expect(r.converged).toBe(true);
    expect(r.after.get('a')!).toBeCloseTo(300, 0);
    expect(r.after.get('b')!).toBeCloseTo(150, 0);
    expect(r.history[0].geh.share).toBeLessThanOrEqual(r.history[r.history.length - 1].geh.share!);
    expect(r.before.get('a')).toBe(200);
    expect(r.cappedTrips).toBe(0);
  });
  it('holds factors to their bounds and reports the trips that hit them', () => {
    const r = calibrateFlows([10, 10, 10], incidence, new Map([['a', 1000], ['b', 20]]), { maxFactor: 4 });
    expect(Math.max(...r.factors)).toBeLessThanOrEqual(4);
    expect(r.converged).toBe(false);
    expect(r.cappedTrips).toBeGreaterThan(0);
  });
  it('reports counted movements no trip passes, and leaves uncounted trips alone', () => {
    const r = calibrateFlows([50, 50], [['a'], []], new Map([['a', 100], ['z', 70]]));
    expect(r.unreachable).toEqual(['z']);
    expect(r.factors[1]).toBe(1);
    expect(assignedFlows([50, 50], r.factors, [['a'], []]).get('a')).toBeCloseTo(100, 6);
  });
});

// ── Junction layout and turns ──────────────────────────────────────────────
const LAT0 = 18.59, LNG0 = 73.74;
const KX = 111320 * Math.cos(LAT0 * Math.PI / 180);
const pt = (x: number, y: number): [number, number, number] => [LNG0 + x / KX, LAT0 + y / 111320, 0];

describe('junction arms and turns', () => {
  it('labels turns for left-hand traffic from compass labels', () => {
    expect(turnBetween('N', 'E')).toBe('left'); // heading south, east is on the left
    expect(turnBetween('N', 'S')).toBe('straight');
    expect(turnBetween('N', 'W')).toBe('right');
    expect(turnBetween('E', 'S')).toBe('left');
    expect(turnBetween('W', 'N')).toBe('left');
    expect(turnBetween('S', 'S')).toBe('u_turn');
  });
  it('assigns compass labels with the least angular error, even for a skewed junction', () => {
    const { labels, errors } = assignCardinals([20, 100, 200, 290]);
    expect(labels).toEqual(['N', 'E', 'S', 'W']);
    expect(Math.max(...errors.map(e => e!))).toBe(20);
    // A three-arm T leaves one label unused; five arms leave one arm unlabelled
    expect(assignCardinals([0, 90, 270]).labels).toEqual(['N', 'E', 'W']);
    expect(assignCardinals([0, 80, 100, 180, 270]).labels.filter(l => l === null)).toHaveLength(1);
  });
  it('finds inbound/outbound links of a divided crossing and merges carriageways into arms', () => {
    // Each arm has an inbound and an outbound carriageway 8 m apart; ends 200 m out
    const links = [] as { index: number; from: number[]; to: number[] }[];
    let i = 0;
    for (const [dx, dy] of [[0, 1], [1, 0], [0, -1], [-1, 0]]) {
      const ox = -dy * 4, oy = dx * 4; // carriageway offset
      links.push({ index: i++, from: pt(dx * 200 + ox, dy * 200 + oy), to: pt(dx * 10 + ox, dy * 10 + oy) }); // inbound
      links.push({ index: i++, from: pt(dx * 10 - ox, dy * 10 - oy), to: pt(dx * 200 - ox, dy * 200 - oy) }); // outbound
    }
    links.push({ index: i++, from: pt(5, 5), to: pt(-5, 5) }); // inside the junction: ignored
    const z = layoutZone({ id: 'x', lng: LNG0, lat: LAT0, radiusM: 40 }, links);
    expect(z.problem).toBeNull();
    expect(z.arms).toHaveLength(4);
    expect(z.approachOf.get(0)).toBe('N');
    expect(z.exitOf.get(3)).toBe('E');
    // N inbound (0) -> internal (8) -> E outbound (3): a left turn
    expect(routeMovements([0, 8, 3], [z])).toEqual([movementKey('x', 'N', 'left')]);
    expect(routeMovements([2, 7], [z])).toEqual([movementKey('x', 'E', 'straight')]);
    expect(routeMovements([2, 5], [z])).toEqual([movementKey('x', 'E', 'left')]);
  });
  it('reports a junction that does not fit four compass approaches instead of forcing it', () => {
    const links = [
      { index: 0, from: pt(0, 200), to: pt(0, 5) }, { index: 1, from: pt(0, 5), to: pt(0, 200) },
      { index: 2, from: pt(200, 0), to: pt(5, 0) }, { index: 3, from: pt(5, 0), to: pt(200, 0) },
    ];
    expect(layoutZone({ id: 'two', lng: LNG0, lat: LAT0, radiusM: 40 }, links).problem).toMatch(/arm/);
    expect(bearingDeg(LNG0, LAT0, ...pt(100, 0).slice(0, 2) as [number, number])).toBeCloseTo(90, 3);
  });
});

// ── Count file validation (frontend copy of the backend check) ─────────────
const dataset = (junctions: CountJunction[]): CountDataset => ({
  schema: 'twincity.observed_counts/v1', dataset_id: 'toy', version: '1', title: 'Toy counts', data_source_type: 'observed',
  sources: [{ id: 's', role: 'test', citation: 'Tester, A. (2026). Toy counts.', url: 'https://example.org' }],
  survey: { method: 'test', date: null, period: 'peak_hour', peak_hour_clock: null },
  units: { count: 'veh/h', classes: { LV: 'light', HV: 'heavy', TW: 'two-wheeler' } },
  pcu: { standard: 'IRC:106-1990', factors: { LV: 1, HV: 2.2, TW: 0.75 } },
  junctions,
});

describe('count file validation', () => {
  const j: CountJunction = { id: 'j', name: 'J', location: { lon: 73.74, lat: 18.59, method: 'test' }, movements: [{ approach: 'N', turn: 'left', LV: 10, TW: 5 }] };
  it('accepts a well-formed file and sums classes without zero-filling', () => {
    expect(validateCountDataset(dataset([j]))).toEqual([]);
    expect(movementVeh(j.movements[0])).toBe(15);
    expect(shortCitation(dataset([j]))).toBe('Tester et al. 2026');
  });
  it('rejects non-integer counts, duplicates and missing citations', () => {
    const bad = dataset([{ ...j, movements: [{ approach: 'N', turn: 'left', LV: 1.5 }, { approach: 'N', turn: 'left', LV: 2 }] }]);
    bad.sources = [{ id: 's', role: 'x', citation: '' }];
    const p = validateCountDataset(bad);
    expect(p.some(x => x.includes('non-negative integer'))).toBe(true);
    expect(p.some(x => x.includes('duplicate movement'))).toBe(true);
    expect(p.some(x => x.includes('citation'))).toBe(true);
    expect(validateCountDataset({ ...dataset([j]), data_source_type: 'estimated' as any }).length).toBe(1);
  });
});

// ── End to end on a simulated crossroads ───────────────────────────────────
const road = (id: string, a: [number, number], b: [number, number]): RoadObject => ({
  id, type: 'road', name: id, layerId: 'roads', scenarioId: 'base', coordinates: [pt(...a), pt(...b)],
  roadClass: 'arterial', width: 10, laneCount: 2, laneWidth: 3.5, hasDivider: false, dividerWidth: 0, hasFootpath: false, footpathWidth: 0,
  speedLimit: 50, isOneWay: false, trafficCapacity: 2000, connectedJunctions: [], createdAt: '', updatedAt: '',
});

describe('calibrating a crossroads to counts', () => {
  // A plus-shaped crossroads; arms 300 m long, cut into two pieces so the ends are entries/exits
  const roads = [
    road('n1', [0, 0], [0, 150]), road('n2', [0, 150], [0, 300]),
    road('s1', [0, 0], [0, -150]), road('s2', [0, -150], [0, -300]),
    road('e1', [0, 0], [150, 0]), road('e2', [150, 0], [300, 0]),
    road('w1', [0, 0], [-150, 0]), road('w2', [-150, 0], [-300, 0]),
  ];
  const area = new StudyAreaExplorer().explore(roads, 1, { seedRoadIds: ['n1'], rangeMeters: 400, direction: 'both' });
  const setup = { area, roads: new Map(roads.map(r => [r.id, r])), options: { demandLevel: 0.12, seed: 7 } };
  // Estimated demand: only N<->S through traffic, too little of it
  const base: DemandPlan = {
    trips: [
      { from: pt(0, 300), to: pt(0, -300), vehiclesPerHour: 100, kind: 'car' },
      { from: pt(0, -300), to: pt(0, 300), vehiclesPerHour: 100, kind: 'car' },
    ],
    provenance: { source: 'project-estimate', label: 'Toy estimate.', period: 'AM_Peak', vehiclesPerHour: 200, pairCount: 2 },
  };
  // Hypothetical counts for the test (not real data): more N->S, some N->E left turns
  const counted: CountJunction = {
    id: 'toy_x', name: 'Toy crossroads', location: { lon: pt(0, 0)[0], lat: pt(0, 0)[1], method: 'test', matched: { kind: 'intersection', arms: 4 } },
    movements: [
      { approach: 'N', turn: 'straight', LV: 300 },
      { approach: 'S', turn: 'straight', LV: 200 },
      { approach: 'N', turn: 'left', LV: 120 },
    ],
  };

  it('fits trip factors to the counts and seeds the movement no trip used', () => {
    const fit = fitPlan(setup, base, [counted]);
    expect(fit.layouts[0].problem).toBeNull();
    expect(fit.seeds.map(s => `${s.approach}:${s.turn}`)).toEqual(['N:left']);
    expect(fit.ipf.converged).toBe(true);
    expect(fit.ipf.after.get('toy_x|N|straight')).toBeCloseTo(300, 0);
    expect(fit.ipf.after.get('toy_x|N|left')).toBeCloseTo(120, 0);
    expect(fit.plan.provenance.source).toBe('calibrated');
    expect(fit.plan.trips).toHaveLength(3);
    expect(fit.unreachable).toEqual([]);
  });

  it('measures simulated turning flows, and calibration improves GEH', async () => {
    const zones = [zoneFor(counted)];
    const opts = { warmupS: 120, measureS: 1200, yieldEveryMs: 1e9 };
    const before = await measureFlows(setup, base, zones, opts);
    const fit = fitPlan(setup, base, [counted]);
    const after = await measureFlows(setup, fit.plan, zones, opts);
    const rows = compareRows([counted], before.layouts, before.flows, after.flows);
    expect(rows).toHaveLength(3);
    const sb = summarize(rows, 'gehBefore')!, sa = summarize(rows, 'gehAfter')!;
    expect(sa.meanGeh!).toBeLessThan(sb.meanGeh!);
    expect(rows.find(r => r.turn === 'left')!.before).toBe(0);
    expect(rows.find(r => r.turn === 'left')!.after!).toBeGreaterThan(60);
    // Simulated N->S flow ends within GEH 5 of the count (stochastic arrivals, fixed seed)
    expect(rows.find(r => r.approach === 'N' && r.turn === 'straight')!.gehAfter!).toBeLessThan(5);
    expect(rowsToCsv(rows).split('\n')[0]).toContain('geh_after');
  });

  it('selects only counted junctions inside the study bounds', () => {
    const ds = dataset([counted, { ...counted, id: 'far', location: { lon: 74.5, lat: 19.5, method: 't' } }]);
    expect(junctionsIn(ds, area.bounds).map(j => j.id)).toEqual(['toy_x']);
    expect(buildSim(setup, base).linkEnds().length).toBeGreaterThan(0);
  });
});

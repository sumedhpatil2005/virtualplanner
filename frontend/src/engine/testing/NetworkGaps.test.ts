/**
 * Network gaps next to flyovers (docs/OVERHAUL.md §19).
 *
 * In the COEP Road case, removing or disconnecting any one of five pieces of
 * the flyover chain beside the campus forced the area's through traffic onto
 * the one-lane campus road (887-970% of its capacity). One way a piece came
 * apart: an approach road the user had edited keeps the heights it had when it
 * was edited (stored lifted, 4.25 m at the deck), its points are then held
 * fixed and the deck was brought down to 0 there, so the two ends were 4.25 m
 * apart and the network builder (which joins only within 3 m) left them
 * unjoined, although they share an OSM node.
 */
import { describe, it, expect } from 'vitest';
import type { RoadObject } from '../objects/types';
import { osmRoad } from './OsmStudyNetwork.fixtures';
import { liftOsmBridges } from '../objects/bridgeElevation';
import { TrafficNetworkBuilder } from '../simulation/TrafficNetworkBuilder';
import { StudyAreaExplorer } from '../simulation/StudyAreaExplorer';
import { snapDemandPlan, type DemandPlan } from '../simulation/StudyDemand';
import { assignTraffic } from '../simulation/staticAssignment';
import { roadSection } from '../simulation/roadSection';
import { sectionDirections, areaContext, networkGaps, vcText, FORCED_VC } from '../simulation/RoadAnalysis';

const LAT0 = 18.53;
const M_LAT = 1 / 111320;
const M_LNG = 1 / (111320 * Math.cos((LAT0 * Math.PI) / 180));
const pt = (x: number, y: number, z = 0): [number, number, number] => [+(73.85 + x * M_LNG).toFixed(7), +(LAT0 + y * M_LAT).toFixed(7), z];

/** Approach (ground, 0..200 m), deck (bridge=yes, layer 1, 200..500 m) over a cross street at x = 350, ground beyond. */
function scene() {
  const approach = osmRoad('approach', [pt(0, 0), pt(100, 0), pt(200, 0)]);
  const deck = { ...osmRoad('deck', [pt(200, 0), pt(350, 0), pt(500, 0)]), osmProvenance: { osmId: 77, originalTags: { highway: 'trunk', bridge: 'yes', layer: '1' }, layer: 1, bridge: true, tunnel: false, roundabout: false } } as RoadObject;
  const beyond = osmRoad('beyond', [pt(500, 0), pt(700, 0)]);
  const under = osmRoad('under', [pt(350, -200), pt(350, 200)]);
  return [approach, deck, beyond, under];
}
const joined = (roads: RoadObject[], a: string, b: string) => {
  const { network } = new TrafficNetworkBuilder().build(roads);
  const nodesOf = (id: string) => new Set([...network.edges.values()].filter(e => e.roadId === id).flatMap(e => [e.fromNodeId, e.toNodeId]));
  return [...nodesOf(a)].some(n => nodesOf(b).has(n));
};

describe('Flyover approaches the user edited', () => {
  it('as imported, the approach rises onto the deck and the two join', () => {
    const roads = scene();
    liftOsmBridges(roads);
    const deck = roads.find(r => r.id === 'deck')!;
    expect(Math.max(...deck.coordinates.map(p => p[2]))).toBeGreaterThan(5);
    expect(joined(roads, 'approach', 'deck')).toBe(true);
  });

  it('an edited approach that kept its lifted heights still joins the deck, and the deck meets it at its height', () => {
    const lifted = scene();
    liftOsmBridges(lifted);
    const approach = lifted.find(r => r.id === 'approach')!;
    const endZ = approach.coordinates.at(-1)![2];
    expect(endZ).toBeGreaterThan(3);
    // The user moves a point of the approach: its shape is now theirs, saved with the heights it had
    const edited: RoadObject = { ...approach, coordinates: approach.coordinates.map((p, i) => i === 1 ? [p[0], p[1] + 0.00001, p[2]] as [number, number, number] : p),
      sections: (approach.sections ?? [{} as any]).map(s => ({ ...s, provenance: { originalSource: 'OSM', originalConfidence: 'estimated', geometryModified: true, profileModified: false, lastModifiedBy: 'manual', verificationStatus: 'unverified' } })) as any };
    // A new session: the other roads as imported (flat), the edited approach as saved
    const roads = scene().map(r => r.id === 'approach' ? edited : r);
    liftOsmBridges(roads);
    const deck = roads.find(r => r.id === 'deck')!;
    expect(deck.coordinates[0][2]).toBeCloseTo(endZ, 6);
    expect(joined(roads, 'approach', 'deck')).toBe(true);
  });

  it('two OSM ways that share a node join there even when their heights differ by more than 3 m', () => {
    const roads = scene();
    roads[0] = { ...roads[0], coordinates: roads[0].coordinates.map((p, i, a) => i === a.length - 1 ? [p[0], p[1], 6.5] as [number, number, number] : p) };
    expect(joined(roads, 'approach', 'deck')).toBe(true);
    // A road crossing under the deck without a shared node still passes beneath it
    const lifted = scene();
    liftOsmBridges(lifted);
    expect(joined(lifted, 'under', 'deck')).toBe(false);
  });
});

describe('Underpasses and their approaches', () => {
  // An underpass (layer -1) under a cross street, with ground approaches at both ends: the approaches ramp down to it.
  // Before, an approach's descent (negative heights) was taken for "stays flat" and dropped, so the approaches stayed
  // at 0 while the underpass ends were 3.5-6.5 m down, and the underpass was cut off from the network (Sadguru Morya
  // Gosavi, Bankimchandra Chatopadhyay Path, Mula Road and G. D. Madgulkar underpasses near Shivajinagar).
  it('the approaches descend to the underpass and the network joins them', () => {
    const west = osmRoad('west', [pt(-300, 0), pt(-150, 0), pt(0, 0)]);
    const cut = { ...osmRoad('cut', [pt(0, 0), pt(150, 0), pt(300, 0)]), osmProvenance: { osmId: 88, originalTags: { highway: 'trunk', layer: '-1' }, layer: -1, bridge: false, tunnel: false, roundabout: false } } as RoadObject;
    const east = osmRoad('east', [pt(300, 0), pt(450, 0), pt(600, 0)]);
    const over = osmRoad('over', [pt(150, -200), pt(150, 200)]);
    const roads = [west, cut, east, over];
    liftOsmBridges(roads);
    const z = (id: string, end: 'first' | 'last') => { const c = roads.find(r => r.id === id)!.coordinates; return (end === 'first' ? c[0] : c.at(-1)!)[2]; };
    expect(Math.min(...roads.find(r => r.id === 'cut')!.coordinates.map(p => p[2]))).toBeLessThan(-5);
    expect(z('west', 'last')).toBeCloseTo(z('cut', 'first'), 6);
    expect(z('east', 'first')).toBeCloseTo(z('cut', 'last'), 6);
    expect(joined(roads, 'west', 'cut')).toBe(true);
    expect(joined(roads, 'cut', 'east')).toBe(true);
    expect(joined(roads, 'over', 'cut')).toBe(false);
  });
});

// ── Forced overloads and the gaps behind them ────────────────────────────────


const P = (x: number, y: number): [number, number, number] => pt(x, y);
const named = (id: string, pts: [number, number][], name: string, cls: RoadObject['roadClass'], tags: Record<string, string>, lanes = 2): RoadObject => ({
  ...osmRoad(id, pts.map(([x, y]) => P(x, y))), name, roadClass: cls, laneCount: lanes, osmProvenance: { osmId: Number(id.replace(/\D/g, '')) || 5, originalTags: tags, layer: 0, bridge: false, tunnel: false, roundabout: false } } as RoadObject);

/**
 * West Road -> East Road, 3,000 veh/h. Between them a one-lane campus road (the short way) and a public ring road
 * round by y = 600, whose middle piece is missing when `gap` (as when a flyover piece is missing): the ring road's
 * two arms then end without connection 200 m apart, and all the traffic is forced over the campus road.
 */
function forcedScene(gap: boolean) {
  const roads = [
    named('w1', [[-1500, 0], [-300, 0]], 'West Road', 'arterial', { highway: 'secondary' }),
    named('e1', [[300, 0], [1500, 0]], 'East Road', 'arterial', { highway: 'secondary' }),
    named('c1', [[-300, 0], [0, 0]], 'Campus Road', 'local', { highway: 'service', access: 'private', lanes: '1' }),
    named('c2', [[0, 0], [300, 0]], 'Campus Road', 'local', { highway: 'service', access: 'private', lanes: '1' }),
    named('r1', [[-300, 0], [-300, 600], [-100, 600]], 'Ring Road', 'arterial', { highway: 'primary' }),
    ...(gap ? [] : [named('r2', [[-100, 600], [100, 600]], 'Ring Road', 'arterial', { highway: 'primary' })]),
    named('r3', [[100, 600], [300, 600], [300, 0]], 'Ring Road', 'arterial', { highway: 'primary' }),
  ];
  const map = new Map(roads.map(r => [r.id, r]));
  // The feeders' far ends lie beyond the range: traffic enters and leaves there (cordon points), as in a real area
  const area = new StudyAreaExplorer().explore(roads, 1, { seedRoadIds: ['c1'], rangeMeters: 1000, direction: 'both' });
  const plan: DemandPlan = { trips: [{ from: P(-1500, 0), to: P(1500, 0), vehiclesPerHour: 3000, kind: 'car' }],
    provenance: { source: 'synthetic', label: 'test', period: 'AM_Peak', vehiclesPerHour: 3000, pairCount: 1 } };
  const res = assignTraffic(area, map, snapDemandPlan(plan, area.network, 60, new Set(area.segments.map(s => s.key))), { maxIterations: 60 });
  const section = roadSection(area, map, ['w1']);
  return { area, map, ctx: areaContext(res, area, map, section, sectionDirections(area, section, map), 3000) };
}

describe('Network gaps and forced overloads in the ranking', () => {
  it('finds a main road that ends without a connection inside the area', () => {
    const { area, map } = forcedScene(true);
    const gaps = networkGaps(area, map);
    expect(gaps.map(g => g.roadName)).toContain('Ring Road');
    expect(networkGaps(forcedScene(false).area, forcedScene(false).map).filter(g => g.roadName === 'Ring Road')).toHaveLength(0);
  });

  it('a stretch far over capacity whose traffic has nowhere else to go is labelled as forced demand, with the gap near it', () => {
    const { ctx } = forcedScene(true);
    const campus = ctx.bottlenecks.find(b => b.roadName === 'Campus Road')!;
    expect(campus.vc).toBeGreaterThan(FORCED_VC);
    expect(campus.demandOverCapacity).toBe(true);
    expect(campus.label).toMatch(/no other route in the model for 100% of its traffic/);
    expect(campus.label).toMatch(/demand \d+(\.\d)?× its capacity/);
    expect(campus.gap?.roadName).toBe('Ring Road');
    expect(campus.label).toMatch(/network gap: Ring Road ends without a connection/);
    expect(ctx.networkGaps.length).toBeGreaterThan(0);
  });

  it('with the ring road whole, nothing is forced onto the campus road and no gap is reported', () => {
    const { ctx } = forcedScene(false);
    expect(ctx.networkGaps).toEqual([]);
    expect(ctx.bottlenecks.find(b => b.roadName === 'Campus Road')).toBeUndefined();
    expect(ctx.bottlenecks.some(b => b.gap)).toBe(false);
  });

  it('writes plausible loads as a percentage and implausible ones as demand over capacity', () => {
    expect(vcText(0.87)).toBe('87%');
    expect(vcText(1.42)).toBe('142%');
    expect(vcText(5.9)).toBe('demand 5.9× capacity');
  });
});

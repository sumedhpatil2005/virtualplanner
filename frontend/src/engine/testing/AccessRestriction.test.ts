/**
 * Roads closed to through traffic in the area assignment, and forced flows in
 * the bottleneck ranking (docs/OVERHAUL.md §17).
 *
 * COEP Road (OSM way 715551386: highway=service, access=private, lanes=1) is a
 * campus road. The area assignment used it as a through route between two
 * trunk roads at Shivajinagar, so a one-lane private road showed 199-207% of
 * its capacity in the morning, and 887-970% whenever a piece of the flyover
 * next to it was missing. Routing engines let a private road be used only at
 * the start or end of a trip (OSRM car profile: a turn from an unrestricted
 * onto a restricted way costs max_turn_weight); the assignment now does the
 * same. Where a stretch's traffic has no other route at all, the ranking says
 * so, because its v/c is then forced demand, not a congested choice.
 */
import { describe, it, expect } from 'vitest';
import type { RoadObject, RoadClassification } from '../objects/types';
import { StudyAreaExplorer } from '../simulation/StudyAreaExplorer';
import { snapDemandPlan, type DemandPlan } from '../simulation/StudyDemand';
import { assignTraffic, isAccessRestricted, RESTRICTED_ENTRY_S } from '../simulation/staticAssignment';
import { roadSection } from '../simulation/roadSection';
import { sectionDirections, areaContext, noAlternativeShare } from '../simulation/RoadAnalysis';
import { TrafficMicroSim } from '../simulation/TrafficMicroSim';

const LAT0 = 18.53;
const M_LAT = 1 / 111320;
const M_LNG = 1 / (111320 * Math.cos((LAT0 * Math.PI) / 180));
const pt = (x: number, y: number): [number, number, number] => [73.85 + x * M_LNG, LAT0 + y * M_LAT, 0];
const road = (id: string, pts: [number, number][], tags: Record<string, string>, cls: RoadClassification = 'arterial', lanes = 2): RoadObject => ({
  id, type: 'road', name: tags.name ?? id, layerId: 'roads', scenarioId: 'base', coordinates: pts.map(p => pt(...p)),
  roadClass: cls, width: 3.5 * lanes, laneCount: lanes, laneWidth: 3.5,
  hasDivider: false, dividerWidth: 0, hasFootpath: false, footpathWidth: 0,
  speedLimit: 40, isOneWay: false, trafficCapacity: 1000,
  connectedJunctions: [], createdAt: '', updatedAt: '',
  osmProvenance: { osmId: Number(id.replace(/\D/g, '')) || 1, osmElementType: 'way', osmSourceId: `way/${id}`, originalTags: tags, layer: 0, bridge: false, tunnel: false, roundabout: false },
} as RoadObject);

/**
 * West feeder (-800..-300, 0) to east feeder (300..800, 0). Between x = -300 and 300: a 600 m private campus road
 * along y = 0 (the short way), and a public road round by y = 600 (1,800 m). A side street off the campus road at
 * x = 0 leads to a car park (0, -200), also private.
 */
function network(withPublicRoute = true) {
  const roads = [
    road('w1', [[-800, 0], [-300, 0]], { highway: 'secondary', name: 'West Road' }),
    road('e1', [[300, 0], [800, 0]], { highway: 'secondary', name: 'East Road' }),
    road('campus1', [[-300, 0], [0, 0]], { highway: 'service', access: 'private', lanes: '1', name: 'Campus Road' }, 'local', 2),
    road('campus2', [[0, 0], [300, 0]], { highway: 'service', access: 'private', lanes: '1', name: 'Campus Road' }, 'local', 2),
    road('park3', [[0, 0], [0, -200]], { highway: 'service', access: 'private', name: 'Car park' }, 'local', 2),
    ...(withPublicRoute ? [
      road('p1', [[-300, 0], [-300, 600]], { highway: 'secondary', name: 'Ring Road' }),
      road('p2', [[-300, 600], [300, 600]], { highway: 'secondary', name: 'Ring Road' }),
      road('p3', [[300, 600], [300, 0]], { highway: 'secondary', name: 'Ring Road' }),
    ] : []),
  ];
  const map = new Map(roads.map(r => [r.id, r]));
  const area = new StudyAreaExplorer().explore(roads, 1, { seedRoadIds: ['w1'], rangeMeters: 3000, direction: 'both' });
  return { roads, map, area };
}

const plan = (trips: { from: [number, number]; to: [number, number]; vph: number }[]): DemandPlan => ({
  trips: trips.map(t => ({ from: pt(...t.from), to: pt(...t.to), vehiclesPerHour: t.vph, kind: 'car' as const })),
  provenance: { source: 'synthetic', label: 'test', period: 'AM_Peak', vehiclesPerHour: trips.reduce((n, t) => n + t.vph, 0), pairCount: trips.length },
});

function assign(withPublicRoute: boolean, trips: { from: [number, number]; to: [number, number]; vph: number }[]) {
  const { map, area } = network(withPublicRoute);
  const snapped = snapDemandPlan(plan(trips), area.network, 60, new Set(area.segments.map(s => s.key)));
  const res = assignTraffic(area, map, snapped, { maxIterations: 100 });
  const vol = (roadId: string) => Math.max(0, ...res.links.filter(l => l.roadId === roadId).map(l => res.volVeh[l.index]));
  return { res, map, area, vol };
}

describe('Access-restricted roads in the area assignment', () => {
  it('reads OSM access the way the importer does (motor_vehicle, then vehicle, then access)', () => {
    const { map } = network();
    expect(isAccessRestricted(map.get('campus1'))).toBe(true);
    expect(isAccessRestricted(map.get('w1'))).toBe(false);
    const r = (tags: Record<string, string>) => isAccessRestricted(road('x9', [[0, 0], [1, 0]], { highway: 'service', ...tags }));
    expect(r({ access: 'destination' })).toBe(true);
    expect(r({ access: 'private', motor_vehicle: 'yes' })).toBe(false); // the more specific tag opens it
    expect(r({ access: 'permissive' })).toBe(false);
    expect(r({})).toBe(false);
  });

  it('through traffic takes the public road round, not the private campus road, even though the campus road is 1.2 km shorter', () => {
    const { vol, res } = assign(true, [{ from: [-800, 0], to: [800, 0], vph: 400 }]);
    expect(res.unroutedVeh).toBe(0);
    expect(vol('campus1')).toBeLessThan(1);
    expect(vol('campus2')).toBeLessThan(1);
    expect(vol('p2')).toBeCloseTo(400, 0);
  });

  it('a trip to a place on the private road still drives in on it', () => {
    const { vol, res } = assign(true, [{ from: [-800, 0], to: [0, -200], vph: 100 }, { from: [0, -200], to: [800, 0], vph: 50 }]);
    expect(res.unroutedVeh).toBe(0);
    expect(vol('park3')).toBeCloseTo(100, 0);
    expect(vol('campus1')).toBeCloseTo(100, 0);
    expect(vol('campus2')).toBeCloseTo(50, 0);
    // Reported times are travel times: the entry cost is not part of them
    for (const l of res.links) expect(res.timeS[l.index]).toBeLessThan(RESTRICTED_ENTRY_S / 1000);
  });

  it('where the private road is the only connection, through traffic is still routed over it', () => {
    const { vol, res } = assign(false, [{ from: [-800, 0], to: [800, 0], vph: 400 }]);
    expect(res.unroutedVeh).toBe(0);
    expect(vol('campus2')).toBeCloseTo(400, 0);
  });
});

describe('Forced flows in the bottleneck ranking', () => {
  it('a stretch whose traffic has no other route is labelled so, and one chain is listed once', () => {
    const { res, map, area } = assign(false, [{ from: [-800, 0], to: [800, 0], vph: 3000 }]);
    const campus = res.links.find(l => l.roadId === 'campus2' && res.volVeh[l.index] > 1)!;
    expect(noAlternativeShare(res, campus.index)).toBeCloseTo(1, 6);
    const section = roadSection(area, map, ['w1']);
    const ctx = areaContext(res, area, map, section, sectionDirections(area, section, map), 3000);
    const rows = ctx.bottlenecks.filter(b => b.roadName === 'Campus Road');
    expect(rows).toHaveLength(1);
    expect(rows[0].vc).toBeGreaterThan(1);
    expect(rows[0].noAlternativeShare).toBeCloseTo(1, 6);
    expect(rows[0].label).toMatch(/no other route in the model for 100% of its traffic/);
  });

  it('a stretch with another acceptable route is not counted as forced', () => {
    // To the car park: in by the west end of the campus road, or round the ring road and in by its east end (one entry either way)
    const { res } = assign(true, [{ from: [-800, 0], to: [0, -200], vph: 100 }]);
    const west = res.links.find(l => l.roadId === 'campus1' && res.volVeh[l.index] > 1)!;
    expect(noAlternativeShare(res, west.index)).toBe(0);
    // The feeder is the only way in from the west
    const feeder = res.links.find(l => l.roadId === 'w1' && res.volVeh[l.index] > 1)!;
    expect(noAlternativeShare(res, feeder.index)).toBe(1);
  });
});

describe('Access-restricted roads in the live micro-simulation', () => {
  // The micro-simulation routes its own vehicles (Start, and trips without assigned paths): the same rule applies there
  const micro = (withPublicRoute: boolean, trips: { from: [number, number]; to: [number, number]; vph: number }[]) => {
    const { map, area, roads } = network(withPublicRoute);
    const snapped = snapDemandPlan(plan(trips), area.network, 60, new Set(area.segments.map(s => s.key)));
    const sim = new TrafficMicroSim(area, new Map(roads.map(r => [r.id, r])), { demandLevel: 1, seed: 7, demandTrips: snapped.map(t => ({ fromNodeId: t.fromNodeId, toNodeId: t.toNodeId, vehiclesPerHour: t.vehiclesPerHour, kind: 'car' as const })) });
    const roadsOf = (route: number[]) => new Set(route.map(i => sim.linkEnds()[i]?.roadId));
    return { sim, routes: sim.demandRouteFlows().map(f => roadsOf(f.route)) };
  };

  it('through traffic is routed round the public road, not through the campus', () => {
    const { routes } = micro(true, [{ from: [-800, 0], to: [800, 0], vph: 400 }]);
    expect(routes).toHaveLength(1);
    expect(routes[0].has('campus1') || routes[0].has('campus2')).toBe(false);
    expect(routes[0].has('p2')).toBe(true);
  });

  it('a trip to the car park still drives in on the private road, and a forced through trip still uses it', () => {
    const inbound = micro(true, [{ from: [-800, 0], to: [0, -200], vph: 100 }]);
    expect(inbound.routes[0].has('park3')).toBe(true);
    const forced = micro(false, [{ from: [-800, 0], to: [800, 0], vph: 400 }]);
    expect(forced.routes[0].has('campus2')).toBe(true);
  });
});

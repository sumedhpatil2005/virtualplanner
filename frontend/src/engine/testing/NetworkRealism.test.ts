import { describe, it, expect } from 'vitest';
import type { RoadObject } from '../objects/types';
import { liftOsmBridges, DECK_HEIGHT_PER_LAYER_M, RAMP_GRADE } from '../objects/bridgeElevation';
import { connectEnds, AUTO_CONNECT_M } from '../editing/autoConnect';
import { StudyAreaExplorer } from '../simulation/StudyAreaExplorer';
import { TrafficMicroSim } from '../simulation/TrafficMicroSim';

/**
 * Making the road network behave like the real one: OSM bridges stand above
 * the roads they cross, new roads join the network, roads into unmapped land
 * still carry traffic, and junctions with a mapped signal are signalised.
 */

const LAT0 = 18.5;
const M_LAT = 1 / 111320;
const M_LNG = 1 / (111320 * Math.cos((LAT0 * Math.PI) / 180));
const pt = (x: number, y: number, z = 0): [number, number, number] => [73.8 + x * M_LNG, LAT0 + y * M_LAT, z];

let osmIds = 1;
const road = (id: string, points: [number, number][], opts: { osm?: { layer?: number; bridge?: boolean }; cls?: RoadObject['roadClass'] } = {}): RoadObject => ({
  id, type: 'road', name: id, layerId: 'roads', scenarioId: 'base',
  coordinates: points.map(([x, y]) => pt(x, y)),
  roadClass: opts.cls ?? 'arterial', width: 10, laneCount: 2, laneWidth: 3.5,
  hasDivider: false, dividerWidth: 0, hasFootpath: false, footpathWidth: 0,
  speedLimit: 50, isOneWay: false, trafficCapacity: 2000,
  connectedJunctions: [], createdAt: '', updatedAt: '',
  ...(opts.osm && {
    osmProvenance: { osmId: osmIds++, originalTags: {}, layer: opts.osm.layer ?? 0, bridge: !!opts.osm.bridge, tunnel: false, roundabout: false },
  }),
});

/** A road from a to b in pieces of 250 m, so it runs on past a study range. */
const chain = (id: string, a: [number, number], b: [number, number], opts: Parameters<typeof road>[2] = {}) => {
  const n = Math.max(1, Math.round(Math.hypot(b[0] - a[0], b[1] - a[1]) / 250));
  const at = (i: number): [number, number] => [a[0] + ((b[0] - a[0]) * i) / n, a[1] + ((b[1] - a[1]) * i) / n];
  return Array.from({ length: n }, (_, i) => road(`${id}${i}`, [at(i), at(i + 1)], opts));
};

const zAt = (r: RoadObject, x: number) => {
  // Height of the point of r nearest to x metres east
  let best = r.coordinates[0];
  for (const c of r.coordinates) if (Math.abs((c[0] - 73.8) / M_LNG - x) < Math.abs((best[0] - 73.8) / M_LNG - x)) best = c;
  return best[2];
};

describe('OSM bridges stand above the roads they cross', () => {
  it('raises a flyover to deck height with ramps where it meets the ground', () => {
    const approachW = road('osm_w', [[-300, 0], [0, 0]], { osm: {} });
    const fly = road('osm_fly', [[0, 0], [400, 0]], { osm: { layer: 1, bridge: true } });
    const approachE = road('osm_e', [[400, 0], [700, 0]], { osm: {} });
    const cross = road('osm_cross', [[200, -200], [200, 200]], { osm: {} });
    liftOsmBridges([approachW, fly, approachE, cross]);

    expect(zAt(fly, 0)).toBe(0);
    expect(zAt(fly, 400)).toBe(0);
    // Mid-span, over the cross road, it is at full height
    expect(zAt(fly, 200)).toBeCloseTo(DECK_HEIGHT_PER_LAYER_M, 1);
    // Ramps rise at the grade
    expect(zAt(fly, 60)).toBeCloseTo(60 * RAMP_GRADE, 0);
    // Ground roads are untouched
    expect(cross.coordinates.every(c => c[2] === 0)).toBe(true);
  });

  it('gives the same heights when run again', () => {
    const roads = [road('osm_w', [[-300, 0], [0, 0]], { osm: {} }), road('osm_fly', [[0, 0], [400, 0]], { osm: { layer: 1, bridge: true } })];
    liftOsmBridges(roads);
    const once = JSON.stringify(roads[1].coordinates);
    liftOsmBridges(roads);
    expect(JSON.stringify(roads[1].coordinates)).toBe(once);
  });

  it('lets traffic on the flyover pass over the road below instead of joining it', () => {
    const roads = [
      ...chain('osm_w', [-1000, 0], [0, 0], { osm: {} }),
      road('osm_fly', [[0, 0], [400, 0]], { osm: { layer: 1, bridge: true } }),
      ...chain('osm_e', [400, 0], [1400, 0], { osm: {} }),
      ...chain('osm_cross', [205, -1000], [205, 1000], { osm: {} }),
    ];
    liftOsmBridges(roads);
    const area = new StudyAreaExplorer().explore(roads, 1, { seedRoadIds: ['osm_fly'], rangeMeters: 300, direction: 'both' });
    expect(area.gradeSeparations.length).toBeGreaterThan(0);
    // The cross road is not part of the flyover's area: nothing joins them
    expect(area.segments.some(s => s.roadId.startsWith('osm_cross'))).toBe(false);
  });
});

describe('New roads join the network', () => {
  it('carries a loose end onto the road it stops short of', () => {
    const main = road('main', [[0, 0], [400, 0]]);
    const coords = connectEnds([pt(200, 200), pt(200, 15)], [main])!;
    expect(coords).not.toBeNull();
    const end = coords[coords.length - 1];
    expect(Math.abs((end[1] - LAT0) / M_LAT)).toBeLessThan(0.01); // on main's centre line
    expect(coords[0]).toEqual(pt(200, 200)); // the far end is left alone
  });

  it('leaves ends that are too far away, or on another level', () => {
    const main = road('main', [[0, 0], [400, 0]]);
    expect(connectEnds([pt(200, 200), pt(200, AUTO_CONNECT_M + 5)], [main])).toBeNull();
    const deck = { id: 'deck', coordinates: [pt(0, 0, 7), pt(400, 0, 7)] };
    expect(connectEnds([pt(200, 200), pt(200, 10)], [deck])).toBeNull();
  });
});

describe('Roads into unmapped land', () => {
  it('says a new road leads nowhere, and invents no traffic at its end', () => {
    // An imported corridor, and a new road leading off it to nowhere
    const roads = [
      ...chain('osm_w', [-1500, 0], [0, 0], { osm: {} }),
      ...chain('osm_e', [0, 0], [1500, 0], { osm: {} }),
      road('new_bridge', [[0, 0], [0, 400]]),
    ];
    const area = new StudyAreaExplorer().explore(roads, 1, { seedRoadIds: ['new_bridge'], rangeMeters: 600, direction: 'both' });
    expect(area.problems.find(p => p.kind === 'open_end')?.severity).toBe('warning');
    const sim = new TrafficMicroSim(area, new Map(roads.map(r => [r.id, r])), { demandLevel: 0.1, seed: 2, watchRoadIds: ['new_bridge'] });
    // Traffic enters only along the corridor, at its two ends
    expect(sim.getMetrics().entries).toBe(2);
  });
});

describe('Mapped traffic signals', () => {
  /** A crossroads of two arterials in an OSM grid, with roads running on past the range. */
  const crossroads = () => [
    ...chain('osm_w', [-1000, 0], [0, 0], { osm: {} }),
    ...chain('osm_e', [0, 0], [1000, 0], { osm: {} }),
    ...chain('osm_s', [0, -1000], [0, 0], { osm: {} }),
    ...chain('osm_n', [0, 0], [0, 1000], { osm: {} }),
  ];
  const simWith = (signalPoints?: [number, number][]) => {
    const roads = crossroads();
    const area = new StudyAreaExplorer().explore(roads, 1, { seedRoadIds: ['osm_w3'], rangeMeters: 400, direction: 'both' });
    return new TrafficMicroSim(area, new Map(roads.map(r => [r.id, r])), { demandLevel: 0.1, seed: 1, signalPoints });
  };

  it('signalises a junction where a signal is mapped, even on its approach', () => {
    const [lng, lat] = pt(-20, 2); // on the west approach, 20 m before the junction
    expect(simWith([[lng, lat]]).getMetrics().signals).toBe(1);
  });

  it('leaves a junction unsignalised when the map has no signal there', () => {
    expect(simWith([]).getMetrics().signals).toBe(0);
    const [lng, lat] = pt(-200, 0); // too far from the junction
    expect(simWith([[lng, lat]]).getMetrics().signals).toBe(0);
  });

  it('estimates signals from the road classes when the map was not asked', () => {
    expect(simWith(undefined).getMetrics().signals).toBe(1);
  });
});

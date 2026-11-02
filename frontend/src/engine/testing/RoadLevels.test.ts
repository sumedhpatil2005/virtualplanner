import { describe, it, expect } from 'vitest';
import type { RoadObject } from '../objects/types';
import { liftOsmBridges, bridgeGeometry, deckCrossings, elevatedLayer, depressedLevel, DECK_HEIGHT_PER_LAYER_M, RAMP_GRADE } from '../objects/bridgeElevation';
import { TrafficNetworkBuilder } from '../simulation/TrafficNetworkBuilder';

/**
 * Road levels and connections from OpenStreetMap: OSM ways join only where
 * they share a node at the same level; bridge decks stand above the roads
 * they cross, with continuous ramps; layer alone never raises a road.
 */

const LAT0 = 18.59;
const M_LAT = 1 / 111320;
const M_LNG = 1 / (111320 * Math.cos((LAT0 * Math.PI) / 180));
/** Rounded like OSM coordinates (7 decimals), so shared nodes have identical keys. */
const pt = (x: number, y: number, z = 0): [number, number, number] => [+(73.76 + x * M_LNG).toFixed(7), +(LAT0 + y * M_LAT).toFixed(7), z];
const xOf = (p: readonly number[]) => (p[0] - 73.76) / M_LNG;
const yOf = (p: readonly number[]) => (p[1] - LAT0) / M_LAT;

let nextOsm = 1000;
const road = (id: string, points: [number, number][], osm?: { layer?: number; bridge?: string; tunnel?: string; oneway?: boolean }): RoadObject => ({
  id, type: 'road', name: id, layerId: 'roads', scenarioId: 'base',
  coordinates: points.map(([x, y]) => pt(x, y)),
  roadClass: 'arterial', width: 10, laneCount: 2, laneWidth: 3.5,
  hasDivider: false, dividerWidth: 0, hasFootpath: false, footpathWidth: 0,
  speedLimit: 50, isOneWay: !!osm?.oneway, trafficCapacity: 2000,
  connectedJunctions: [], createdAt: '', updatedAt: '',
  ...(osm && {
    osmProvenance: {
      osmId: nextOsm++,
      originalTags: { highway: 'primary', ...(osm.bridge && { bridge: osm.bridge }), ...(osm.tunnel && { tunnel: osm.tunnel }), ...(osm.layer !== undefined && { layer: String(osm.layer) }) },
      layer: osm.layer ?? 0, bridge: !!osm.bridge && osm.bridge !== 'no', tunnel: osm.tunnel === 'yes', roundabout: false,
    },
  }),
});

const junctions = (roads: RoadObject[]) => {
  const { network } = new TrafficNetworkBuilder().build(roads);
  return [...network.nodes.values()].filter(n => new Set([...n.incomingSegments, ...n.outgoingSegments].map(e => network.edges.get(e)!.roadId)).size >= 2);
};

describe('OSM ways join only at shared nodes on the same level', () => {
  it('joins two OSM ways at the node they share', () => {
    const a = road('a', [[-100, 0], [0, 0], [100, 0]], {});
    const b = road('b', [[0, -100], [0, 0], [0, 100]], {});
    const js = junctions([a, b]);
    expect(js).toHaveLength(1);
    expect(xOf(js[0].coordinates)).toBeCloseTo(0, 3);
  });

  it('does not invent a junction where two OSM ways cross without a shared node', () => {
    const a = road('a', [[-100, 0], [100, 0]], {});
    const b = road('b', [[0, -100], [0, 100]], {});
    const { diagnostics } = new TrafficNetworkBuilder().build([a, b]);
    expect(junctions([a, b])).toHaveLength(0);
    expect(diagnostics).toContain('OSM crossings without a shared node (not joined): 1');
  });

  it('does not join a bridge to the road beneath it, before or after heights are worked out', () => {
    const deck = road('deck', [[-150, 0], [150, 0]], { bridge: 'yes', layer: 1 });
    const below = road('below', [[0, -150], [0, 150]], {});
    expect(junctions([deck, below])).toHaveLength(0);
    liftOsmBridges([deck, below]);
    const { gradeSeparations } = new TrafficNetworkBuilder().build([deck, below]);
    expect(junctions([deck, below])).toHaveLength(0);
    expect(gradeSeparations).toHaveLength(1);
    expect(gradeSeparations[0].roadIds).toEqual(['deck', 'below']);
  });

  it('keeps OSM road ends that stop a few metres apart separate (e.g. two carriageways)', () => {
    const north = road('n', [[0, 0], [200, 0]], { oneway: true });
    const south = road('s', [[200, -4], [0, -4]], { oneway: true });
    const { network } = new TrafficNetworkBuilder().build([north, south]);
    expect(network.nodes.size).toBe(4);
  });

  it('still joins a road the user drew to an OSM road it stops just short of', () => {
    const osmRoad = road('osm', [[-100, 0], [100, 0]], {});
    const drawn = road('drawn', [[0, 100], [0, 3]]);
    expect(junctions([osmRoad, drawn])).toHaveLength(1);
  });

  it('joins at a shared node even across OSM layers (a bridge meets its approach at grade)', () => {
    const approach = road('approach', [[-200, 0], [0, 0]], {});
    const deck = road('deck', [[0, 0], [300, 0]], { bridge: 'yes', layer: 1 });
    const below = road('below', [[150, -100], [150, 100]], {});
    const roads = [approach, deck, below];
    liftOsmBridges(roads);
    const js = junctions(roads);
    expect(js).toHaveLength(1);
    expect(xOf(js[0].coordinates)).toBeCloseTo(0, 2);
  });
});

describe('bridge and underpass heights', () => {
  const flyoverScene = () => {
    // west junction (x=-400) - approach - deck over the cross road - approach - east junction (x=700)
    const westSide = road('west_side', [[-400, -100], [-400, 0]], {});
    const approachW = road('approach_w', [[-400, 0], [-200, 0], [0, 0]], {});
    const deck = road('deck', [[0, 0], [300, 0]], { bridge: 'yes', layer: 1 });
    const approachE = road('approach_e', [[300, 0], [500, 0], [700, 0]], {});
    const eastSide = road('east_side', [[700, 0], [700, 100]], {});
    const cross = road('cross', [[150, -200], [150, 200]], {});
    return { westSide, approachW, deck, approachE, eastSide, cross, all: [westSide, approachW, deck, approachE, eastSide, cross] };
  };

  it('puts the deck a full level above the road it crosses', () => {
    const s = flyoverScene();
    liftOsmBridges(s.all);
    const [c] = deckCrossings(s.all);
    expect(c.underId).toBe('cross');
    const zAtCross = Math.max(...s.deck.coordinates.filter(p => Math.abs(xOf(p) - 150) < 13).map(p => p[2]));
    expect(zAtCross).toBeCloseTo(DECK_HEIGHT_PER_LAYER_M, 6);
    expect(s.cross.coordinates.every(p => p[2] === 0)).toBe(true);
  });

  it('ramps continuously at the grade along the approaches, down to 0 at the junctions', () => {
    const s = flyoverScene();
    liftOsmBridges(s.all);
    // One profile from the west junction to the east junction
    const chain = [...s.approachW.coordinates, ...s.deck.coordinates.slice(1), ...s.approachE.coordinates.slice(1)];
    for (let i = 1; i < chain.length; i++) {
      const run = Math.abs(xOf(chain[i]) - xOf(chain[i - 1]));
      expect(run).toBeLessThanOrEqual(12 + 1e-6); // densified, so the ramp is a smooth slope
      expect(Math.abs(chain[i][2] - chain[i - 1][2])).toBeLessThanOrEqual(run * RAMP_GRADE + 1e-6);
    }
    expect(chain[0][2]).toBe(0);
    expect(chain.at(-1)![2]).toBe(0);
    // The ramp reaches full height 130 m before the deck
    const at70 = s.approachW.coordinates.find(p => Math.abs(xOf(p) + 70) < 6)!;
    expect(at70[2]).toBeCloseTo(DECK_HEIGHT_PER_LAYER_M - 70 * RAMP_GRADE, 0);
    // Roads at the junctions stay on the ground
    expect(s.westSide.coordinates.every(p => p[2] === 0)).toBe(true);
    expect(s.eastSide.coordinates.every(p => p[2] === 0)).toBe(true);
  });

  it('is stable when applied again, and puts approaches back down if the deck goes', () => {
    const s = flyoverScene();
    liftOsmBridges(s.all);
    expect(bridgeGeometry(s.all).size).toBe(0);
    const withoutDeck = s.all.filter(r => r !== s.deck);
    liftOsmBridges(withoutDeck);
    expect(s.approachW.coordinates.every(p => p[2] === 0)).toBe(true);
  });

  it('never raises a road the user drew or reshaped', () => {
    const drawn = road('drawn', [[-200, 0], [0, 0]]);
    const deck = road('deck', [[0, 0], [300, 0]], { bridge: 'yes', layer: 1 });
    const cross = road('cross', [[150, -100], [150, 100]], {});
    liftOsmBridges([drawn, deck, cross]);
    expect(drawn.coordinates.every(p => p[2] === 0)).toBe(true);
    // So the deck comes down to meet it, at the grade
    expect(deck.coordinates[0][2]).toBe(0);
    expect(Math.max(...deck.coordinates.map(p => p[2]))).toBeCloseTo(DECK_HEIGHT_PER_LAYER_M, 6);
  });

  it('treats any bridge=* value as a bridge, and layer alone as no height', () => {
    expect(elevatedLayer(road('v', [[0, 0], [1, 0]], { bridge: 'viaduct' }))).toBe(1);
    expect(elevatedLayer(road('l', [[0, 0], [1, 0]], { layer: 1 }))).toBe(0);
    expect(elevatedLayer(road('b2', [[0, 0], [1, 0]], { bridge: 'yes', layer: 2 }))).toBe(2);
    const layered = road('layered', [[-100, 0], [100, 0]], { layer: 1 });
    const other = road('other', [[0, -100], [0, 100]], {});
    liftOsmBridges([layered, other]);
    expect(layered.coordinates.every(p => p[2] === 0)).toBe(true);
  });

  it('lowers an underpass road (layer -1) where a road passes over it, and leaves a building passage at grade', () => {
    expect(depressedLevel(road('p', [[0, 0], [1, 0]], { tunnel: 'building_passage', layer: -1 }))).toBe(0);
    const under = road('under', [[0, -300], [0, 300]], { layer: -1 });
    const over = road('over', [[-200, 0], [200, 0]], {});
    liftOsmBridges([under, over]);
    const zMid = under.coordinates.find(p => Math.abs(yOf(p)) < 7)!;
    expect(zMid[2]).toBeCloseTo(-DECK_HEIGHT_PER_LAYER_M, 6);
    expect(over.coordinates.every(p => p[2] === 0)).toBe(true);
    expect(junctions([under, over])).toHaveLength(0);
  });
});

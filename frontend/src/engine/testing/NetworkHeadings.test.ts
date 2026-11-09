/**
 * Edge geometry where OSM ways join at a shared vertex (docs/OVERHAUL.md §28).
 *
 * The network builder split a way at a node it shares with another way by
 * pushing the node onto the current piece, which already ended there: every
 * edge ending at a shared interior vertex had a zero-length last piece (and
 * its reverse a zero-length first piece). The simulation takes a link's end
 * heading from its last piece, atan2(0, 0) = due east, so a quarter of all
 * approaches on the Shivajinagar network "arrived from the west": signal
 * phases grouped crossing approaches together, a signal with a mapped OSM
 * signal node ran as a give-way junction, and turns and oncoming traffic were
 * misjudged.
 */
import { describe, it, expect } from 'vitest';
import type { RoadObject } from '../objects/types';
import { TrafficNetworkBuilder } from '../simulation/TrafficNetworkBuilder';
import { StudyAreaExplorer } from '../simulation/StudyAreaExplorer';
import { TrafficMicroSim, STEP_S } from '../simulation/TrafficMicroSim';

const LAT0 = 18.52;
const M_LAT = 1 / 111320;
const M_LNG = 1 / (111320 * Math.cos((LAT0 * Math.PI) / 180));
/** Rounded like OSM coordinates (7 decimals), so shared nodes have identical keys. */
const pt = (x: number, y: number): [number, number, number] => [+(73.85 + x * M_LNG).toFixed(7), +(LAT0 + y * M_LAT).toFixed(7), 0];

let nextOsm = 5000;
const road = (id: string, points: [number, number][], o: { oneway?: boolean; cls?: RoadObject['roadClass'] } = {}): RoadObject => ({
  id, type: 'road', name: id, layerId: 'roads', scenarioId: 'base',
  coordinates: points.map(([x, y]) => pt(x, y)),
  roadClass: o.cls ?? 'arterial', width: 10, laneCount: 2, laneWidth: 3.5,
  hasDivider: false, dividerWidth: 0, hasFootpath: false, footpathWidth: 0,
  speedLimit: 50, isOneWay: !!o.oneway, trafficCapacity: 2000,
  connectedJunctions: [], createdAt: '', updatedAt: '',
  osmProvenance: { osmId: nextOsm++, originalTags: { highway: 'secondary' }, layer: 0, bridge: false, tunnel: false, roundabout: false },
});

const pieceM = (a: readonly number[], b: readonly number[]) => Math.hypot((b[0] - a[0]) / M_LNG, (b[1] - a[1]) / M_LAT);
const bearingDeg = (a: readonly number[], b: readonly number[]) => (Math.atan2((b[1] - a[1]) / M_LAT, (b[0] - a[0]) / M_LNG) * 180) / Math.PI;

describe('edges split at shared OSM vertices', () => {
  // A north-south way and an east-west way sharing their middle vertex, each with shape points either side
  const ns = road('ns', [[0, -300], [2, -150], [0, 0], [-2, 150], [0, 300]]);
  const ew = road('ew', [[-300, 0], [-150, 2], [0, 0], [150, -2], [300, 0]]);

  it('has no zero-length piece at either end of any edge, and keeps the edge ids', () => {
    const { network } = new TrafficNetworkBuilder().build([ns, ew]);
    const ids = [...network.edges.keys()].sort();
    expect(ids).toEqual(['ew_seg_0_bwd', 'ew_seg_0_fwd', 'ew_seg_1_bwd', 'ew_seg_1_fwd', 'ns_seg_0_bwd', 'ns_seg_0_fwd', 'ns_seg_1_bwd', 'ns_seg_1_fwd']);
    network.edges.forEach(e => {
      const c = e.coordinates;
      expect(pieceM(c[0], c[1]), e.id).toBeGreaterThan(1);
      expect(pieceM(c[c.length - 2], c[c.length - 1]), e.id).toBeGreaterThan(1);
      for (let i = 1; i < c.length; i++) expect(pieceM(c[i - 1], c[i]), `${e.id} piece ${i}`).toBeGreaterThan(0.001);
    });
    // The northbound approach arrives heading north, not east
    const north = network.edges.get('ns_seg_0_fwd')!.coordinates;
    expect(bearingDeg(north[north.length - 2], north[north.length - 1])).toBeGreaterThan(80);
    const southStart = network.edges.get('ns_seg_0_bwd')!.coordinates;
    expect(bearingDeg(southStart[0], southStart[1])).toBeLessThan(-80);
  });

  it('a mapped signal where two one-way streets cross at a shared vertex is a signal, with the streets in separate phases', () => {
    // The middle node of the Jayantarao Tilak Bridge / Congress Bhavan Path box (OSM signal node 12420420707):
    // two one-way carriageways crossing, so the node has just two approaches. With both end headings read
    // as due east they fell on one axis, and the signal was dropped for a give-way junction.
    const nb = road('nb', [[0, -300], [2, -150], [0, 0], [-2, 150], [0, 300]], { oneway: true });
    const eb = road('eb', [[-300, 0], [-150, 2], [0, 0], [150, -2], [300, 0]], { oneway: true });
    const roads = [nb, eb];
    const area = new StudyAreaExplorer().explore(roads, 1, { seedRoadIds: ['nb'], rangeMeters: 400, direction: 'both' });
    const sim = new TrafficMicroSim(area, new Map(roads.map(r => [r.id, r])), { demandLevel: 0, seed: 1, signalPoints: [[pt(0, 0)[0], pt(0, 0)[1]]], signalTiming: 'equal' });
    const links = sim.linkEnds();
    const into = (id: string) => links.find(l => l.id === id)!.index;
    const north = into('nb_seg_0_fwd'), east = into('eb_seg_0_fwd');
    let nGreen = 0, eGreen = 0;
    for (let i = 0; i < 240 / STEP_S; i++) {
      sim.step();
      expect(sim.signalState(north)).not.toBeNull();
      expect(sim.signalState(east)).not.toBeNull();
      const n = sim.signalState(north) === 'green', e = sim.signalState(east) === 'green';
      expect(n && e).toBe(false);
      if (n) nGreen++;
      if (e) eGreen++;
    }
    expect(nGreen).toBeGreaterThan(0);
    expect(eGreen).toBeGreaterThan(0);
  });
});

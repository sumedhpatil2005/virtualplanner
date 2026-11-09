/**
 * A mapped signal box runs from one controller (docs/OVERHAUL.md §28).
 *
 * Two one-way pairs crossing make a box of four nodes, each a stop line with a
 * mapped traffic_signals node. The pieces between them are longer than the
 * simulator joins nodes over (JOIN_JUNCTION_M), so it has four junctions. Each
 * used to run its own phases: a movement through the box stopped again at an
 * internal stop line (at the Jayantarao Tilak Bridge / Congress Bhavan Path box
 * the bridge's green never overlapped the next piece's, and a 12 m bus that
 * cannot wait on a 14 m piece stood at the bridge's line for the whole run).
 * As the junction editor groups it (junctionGroups), the box is one junction:
 * one phase per approach, the pieces inside never stopped, one cycle and offset.
 */
import { describe, it, expect } from 'vitest';
import type { RoadObject } from '../objects/types';
import { StudyAreaExplorer, type StudyArea } from '../simulation/StudyAreaExplorer';
import { TrafficMicroSim, STEP_S, OD_REFERENCE_LEVEL, type MicroDemandTrip, type VehicleKind } from '../simulation/TrafficMicroSim';

const LAT0 = 18.52;
const M_LAT = 1 / 111320;
const M_LNG = 1 / (111320 * Math.cos((LAT0 * Math.PI) / 180));
const pt = (x: number, y: number): [number, number, number] => [+(73.85 + x * M_LNG).toFixed(7), +(LAT0 + y * M_LAT).toFixed(7), 0];
let nextOsm = 7000;
const road = (id: string, points: [number, number][]): RoadObject => ({
  id, type: 'road', name: id, layerId: 'roads', scenarioId: 'base',
  coordinates: points.map(([x, y]) => pt(x, y)),
  roadClass: 'arterial', width: 7, laneCount: 2, laneWidth: 3.5,
  hasDivider: false, dividerWidth: 0, hasFootpath: false, footpathWidth: 0,
  speedLimit: 40, isOneWay: true, trafficCapacity: 2000,
  connectedJunctions: [], createdAt: '', updatedAt: '',
  osmProvenance: { osmId: nextOsm++, originalTags: { highway: 'secondary', oneway: 'yes', name: id }, layer: 0, bridge: false, tunnel: false, roundabout: false },
});
const H = 10; // half the box: pieces of 20 m between its corners
const roads = [
  road('Northbound', [[H, -400], [H, -H], [H, H], [H, 400]]),
  road('Southbound', [[-H, 400], [-H, H], [-H, -H], [-H, -400]]),
  road('Eastbound', [[-400, -H], [-H, -H], [H, -H], [400, -H]]),
  road('Westbound', [[400, H], [H, H], [-H, H], [-400, H]]),
];
const corners: [number, number][] = [[H, -H], [H, H], [-H, H], [-H, -H]];
const signals = corners.map(([x, y]) => [pt(x, y)[0], pt(x, y)[1]] as [number, number]);
const nodeAt = (area: StudyArea, x: number, y: number) => {
  const [lng, lat] = pt(x, y); let best = '', bd = Infinity;
  area.network.nodes.forEach(n => { const d = Math.hypot(n.coordinates[0] - lng, n.coordinates[1] - lat); if (d < bd) { bd = d; best = n.id; } });
  return best;
};

function make(seed: number) {
  const area = new StudyAreaExplorer().explore(roads, 1, { seedRoadIds: ['Northbound'], rangeMeters: 420, direction: 'both' });
  const mix: [VehicleKind, number][] = [['two_wheeler', 0.4], ['car', 0.3], ['auto', 0.1], ['bus', 0.12], ['truck', 0.08]];
  const S = nodeAt(area, H, -400), N = nodeAt(area, -H, 400), W = nodeAt(area, -400, -H), E = nodeAt(area, 400, H);
  const Nout = nodeAt(area, H, 400), Sout = nodeAt(area, -H, -400), Eout = nodeAt(area, 400, -H), Wout = nodeAt(area, -400, H);
  // Through traffic on all four, and turns that cross the box
  const pairs: [string, string, number][] = [[S, Nout, 400], [N, Sout, 400], [W, Eout, 400], [E, Wout, 400], [S, Wout, 80], [W, Nout, 80], [N, Eout, 80], [E, Sout, 80]];
  const trips: MicroDemandTrip[] = pairs.flatMap(([a, b, v]) => mix.map(([kind, sh]) => ({ fromNodeId: a, toNodeId: b, vehiclesPerHour: v * sh, kind })));
  return new TrafficMicroSim(area, new Map(roads.map(r => [r.id, r])), { demandLevel: OD_REFERENCE_LEVEL, seed, demandTrips: trips, signalPoints: signals, signalTiming: 'webster' });
}

describe('mapped signal box', () => {
  it('is one controller: one approach green at a time, pieces inside never stopped, buses through without standing', () => {
    for (const seed of [42, 7]) {
      const sim = make(seed);
      const links = sim.linkEnds();
      const corner = (x: number, y: number) => { const [lng, lat] = pt(x, y); return (p: readonly number[]) => Math.hypot((p[0] - lng) / M_LNG, (p[1] - lat) / M_LAT) < 1; };
      const atCorner = (p: readonly number[]) => corners.some(([x, y]) => corner(x, y)(p));
      const internal = links.filter(l => atCorner(l.from) && atCorner(l.to));
      const approaches = links.filter(l => !atCorner(l.from) && atCorner(l.to));
      expect(internal.length).toBe(4);
      expect(approaches.length).toBe(4);
      let greens = 0;
      for (let i = 0; i < 900 / STEP_S; i++) {
        sim.step();
        for (const l of internal) expect(sim.signalState(l.index), l.id).toBe('green');
        const g = approaches.filter(l => sim.signalState(l.index) === 'green').length;
        expect(g).toBeLessThanOrEqual(1);
        greens += g;
      }
      expect(greens).toBeGreaterThan(0);
      const m = sim.getMetrics();
      // Nothing stands at a line for three minutes, and traffic flows
      expect(m.accounting.gridlockEvents, JSON.stringify(m.accounting)).toBe(0);
      expect(m.completedTrips).toBeGreaterThan(300);
    }
  }, 120_000);
});

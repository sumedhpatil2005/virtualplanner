import { describe, it, expect } from 'vitest';
import type { RoadObject } from '../objects/types';
import { StudyAreaExplorer } from '../simulation/StudyAreaExplorer';
import { TrafficMicroSim, STEP_S, EDGE_FADE_M, type VehicleView } from '../simulation/TrafficMicroSim';
import { toGlb, VEHICLE_VARIANTS, variantFor } from '../rendering/vehicles/vehicleModels';

/**
 * Simulate with a selected road as the subject: extra traffic is routed
 * through it, and vehicles are placed in their lanes and carried on smoothly
 * between steps for drawing.
 */

const LAT0 = 18.5;
const M_LAT = 1 / 111320;
const M_LNG = 1 / (111320 * Math.cos((LAT0 * Math.PI) / 180));
const pt = (x: number, y: number): [number, number, number] => [73.8 + x * M_LNG, LAT0 + y * M_LAT, 0];
const toXY = (lng: number, lat: number) => [(lng - 73.8) / M_LNG, (lat - LAT0) / M_LAT];

const road = (id: string, a: [number, number], b: [number, number], extra: Partial<RoadObject> = {}): RoadObject => ({
  id, type: 'road', name: id, layerId: 'roads', scenarioId: 'base',
  coordinates: [pt(...a), pt(...b)],
  roadClass: 'arterial', width: 10, laneCount: 2, laneWidth: 3.5,
  hasDivider: false, dividerWidth: 0, hasFootpath: false, footpathWidth: 0,
  speedLimit: 50, isOneWay: false, trafficCapacity: 2000,
  connectedJunctions: [], createdAt: '', updatedAt: '',
  ...extra,
});

/**
 * A road from a to b in pieces of about 250 m. A study area takes whole
 * stretches, so a road must run on past the range in pieces for traffic to
 * enter and leave where the range ends.
 */
const chain = (id: string, a: [number, number], b: [number, number], extra: Partial<RoadObject> = {}): RoadObject[] => {
  const n = Math.max(1, Math.round(Math.hypot(b[0] - a[0], b[1] - a[1]) / 250));
  const at = (i: number): [number, number] => [a[0] + ((b[0] - a[0]) * i) / n, a[1] + ((b[1] - a[1]) * i) / n];
  return Array.from({ length: n }, (_, i) => road(`${id}${i}`, at(i), at(i + 1), extra));
};

/** A 400 m square with a long road leaving each corner, so traffic enters and leaves on every side. */
const square = (): RoadObject[] => [
  road('left', [0, 0], [0, 400]),
  road('bottom', [0, 0], [400, 0]),
  road('right', [400, 0], [400, 400]),
  road('top', [0, 400], [400, 400]),
  ...chain('sw', [0, 0], [-1500, -1500]),
  ...chain('se', [400, 0], [1900, -1500]),
  ...chain('ne', [400, 400], [1900, 1900]),
  ...chain('nw', [0, 400], [-1500, 1900]),
];

const simFor = (roads: RoadObject[], seed: string, range: number, focusLoad: number) => {
  const area = new StudyAreaExplorer().explore(roads, 1, { seedRoadIds: [seed], rangeMeters: range, direction: 'both' });
  return new TrafficMicroSim(area, new Map(roads.map(r => [r.id, r])), { demandLevel: 0.1, seed: 3, watchRoadIds: [seed], focusLoad });
};

const run = (sim: TrafficMicroSim, seconds: number) => {
  for (let i = 0; i < seconds / STEP_S; i++) sim.step();
};

describe('Focus traffic through the selected road', () => {
  it('sends traffic from the other sides through the selected edge', () => {
    const natural = simFor(square(), 'left', 900, 0);
    const focused = simFor(square(), 'left', 900, 0.4);
    run(natural, 900);
    run(focused, 900);
    const n = natural.getMetrics(), f = focused.getMetrics();
    expect(n.focusVph).toBe(0);
    // Two lanes (one each way) of arterial: 2 × 1400 veh/h, at 40%
    expect(f.focusVph).toBe(1120);
    expect(f.watched.passed).toBeGreaterThan(n.watched.passed * 2);
    expect(f.watched.passed).toBeGreaterThan(150);
  });

  it('can be turned off and on while running', () => {
    const sim = simFor(square(), 'left', 900, 0.4);
    sim.setFocusLoad(0);
    expect(sim.getMetrics().focusVph).toBe(0);
    sim.setFocusLoad(0.2);
    expect(sim.getMetrics().focusVph).toBe(560);
  });

  it('adds nothing when no road is watched', () => {
    const roads = square();
    const area = new StudyAreaExplorer().explore(roads, 1, { seedRoadIds: ['left'], rangeMeters: 900, direction: 'both' });
    const sim = new TrafficMicroSim(area, new Map(roads.map(r => [r.id, r])), { demandLevel: 0.1, seed: 3, focusLoad: 1 });
    expect(sim.getMetrics().focusVph).toBe(0);
  });
});

describe('Vehicle positions for drawing', () => {
  /** A straight east-west corridor through the selected road. */
  const corridor = (extra: Partial<RoadObject> = {}) => [
    ...chain('w', [-2000, 0], [0, 0], extra),
    road('mid', [0, 0], [600, 0], extra),
    ...chain('e', [600, 0], [2600, 0], extra),
  ];

  const snapshot = (sim: TrafficMicroSim, aheadS = 0) => {
    const out = new Map<number, VehicleView>();
    sim.forEachVehicle(v => out.set(v.id, { ...v }), aheadS);
    return out;
  };

  it('keeps vehicles in their lane: left of the centre line by half the road lane width', () => {
    const sim = simFor(corridor(), 'mid', 500, 0.3);
    run(sim, 120);
    const all = [...snapshot(sim).values()];
    expect(all.length).toBeGreaterThan(5);
    for (const v of all) {
      const [, y] = toXY(v.lng, v.lat);
      const eastbound = Math.cos(v.heading) > 0;
      // One lane each way: lane centre is 1.75 m from the centre line, on the driver's left
      expect(Math.abs(Math.abs(y) - 1.75)).toBeLessThan(0.05);
      expect(Math.sign(y)).toBe(eastbound ? 1 : -1);
    }
  });

  it('sets lanes beyond the median of a divided road', () => {
    const sim = simFor(corridor({ hasDivider: true, dividerWidth: 2, laneCount: 2 }), 'mid', 500, 0.3);
    run(sim, 120);
    for (const v of snapshot(sim).values()) {
      const [, y] = toXY(v.lng, v.lat);
      expect(Math.abs(Math.abs(y) - (1 + 1.75))).toBeLessThan(0.05);
    }
  });

  it('carries vehicles on between steps, never past the vehicle ahead', () => {
    const sim = simFor(corridor(), 'mid', 500, 0.6);
    run(sim, 180);
    const now = snapshot(sim);
    const ahead = snapshot(sim, STEP_S * 0.9);
    let moved = 0;
    ahead.forEach((v, id) => {
      const a = toXY(now.get(id)!.lng, now.get(id)!.lat), b = toXY(v.lng, v.lat);
      const d = Math.hypot(b[0] - a[0], b[1] - a[1]);
      expect(d).toBeLessThan(20 * STEP_S); // no faster than the speed limit allows
      if (d > 0.1) moved++;
    });
    expect(moved).toBeGreaterThan(0);
    // Order along each lane is unchanged, so nobody passes through the vehicle ahead
    const lanes = new Map<string, { x: number; id: number }[]>();
    ahead.forEach((v, id) => {
      const [x, y] = toXY(v.lng, v.lat);
      const key = Math.sign(y).toString();
      lanes.set(key, [...(lanes.get(key) ?? []), { x: Math.cos(v.heading) > 0 ? x : -x, id }]);
    });
    lanes.forEach(list => {
      const before = list.map(e => {
        const [x] = toXY(now.get(e.id)!.lng, now.get(e.id)!.lat);
        return { id: e.id, x: Math.cos(now.get(e.id)!.heading) > 0 ? x : -x };
      });
      const order = (l: { x: number; id: number }[]) => [...l].sort((p, q) => p.x - q.x).map(e => e.id).join();
      expect(order(list)).toBe(order(before));
    });
  });

  it('fades vehicles in where they enter and out where they leave', () => {
    const sim = simFor(corridor(), 'mid', 500, 0.6);
    run(sim, 240);
    const views = [...snapshot(sim).values()];
    expect(views.every(v => v.opacity >= 0 && v.opacity <= 1)).toBe(true);
    expect(views.some(v => v.opacity === 1)).toBe(true);
    expect(views.some(v => v.opacity < 1)).toBe(true);
    // A vehicle that has only just entered is faint
    const fresh = simFor(corridor(), 'mid', 500, 0.6);
    run(fresh, 2);
    for (const v of snapshot(fresh).values()) expect(v.opacity).toBeLessThan((2 * 20) / EDGE_FADE_M + 0.01);
  });
});

describe('Vehicle models', () => {
  it('every variant builds a valid GLB', () => {
    for (const variant of VEHICLE_VARIANTS) {
      const glb = toGlb(variant.build());
      const dv = new DataView(glb.buffer, glb.byteOffset, glb.byteLength);
      expect(dv.getUint32(0, true)).toBe(0x46546c67);
      expect(dv.getUint32(8, true)).toBe(glb.byteLength);
      const jsonLength = dv.getUint32(12, true);
      const json = JSON.parse(new TextDecoder().decode(glb.subarray(20, 20 + jsonLength)));
      const [pos, , , idx] = json.accessors;
      expect(pos.count).toBeLessThan(65536);
      expect(idx.count % 3).toBe(0);
      // Sits on the road, front towards +Z, about as long as the vehicle it stands for
      expect(pos.min[1]).toBeGreaterThanOrEqual(-0.01);
      const length = pos.max[2] - pos.min[2];
      expect(length).toBeGreaterThan(variant.kind === 'two_wheeler' ? 1.5 : 2.5);
      expect(length).toBeLessThan(9);
    }
  });

  it('gives each vehicle a fixed look of its own kind', () => {
    for (const kind of ['two_wheeler', 'car', 'bus_auto'] as const) {
      const looks = new Set<string>();
      for (let id = 1; id < 400; id++) {
        const v = variantFor(kind, id);
        expect(v.kind).toBe(kind);
        expect(variantFor(kind, id)).toBe(v);
        looks.add(v.id);
      }
      expect(looks.size).toBe(VEHICLE_VARIANTS.filter(v => v.kind === kind).length);
    }
  });
});

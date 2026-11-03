/**
 * Stop-line counting at a counted junction (junctionMovements.ts, layoutZone
 * with the junction's core nodes): a movement is the link a vehicle enters the
 * junction core by and the link it leaves by, as a manual turning count at the
 * junction records it. A side street that joins an approach inside the count
 * circle is not an arm: its traffic is counted on the approach whose stop line
 * it crosses, and count-seeded trips start on the approach road itself.
 */
import { describe, it, expect } from 'vitest';
import { layoutZone, routeMovements, movementKey, type LinkEnds } from '../calibration/junctionMovements';
import { seedTrips } from '../calibration/calibration';
import type { CountJunction } from '../calibration/observedCounts';

const LAT0 = 18.59, LNG0 = 73.74;
const kx = 111320 * Math.cos((LAT0 * Math.PI) / 180);
const pt = (x: number, y: number): [number, number] => [LNG0 + x / kx, LAT0 + y / 111320];
const P: Record<string, [number, number]> = {
  C: pt(0, 0), N: pt(0, 200), E: pt(200, 0), S: pt(0, -200), W: pt(-200, 0),
  M: pt(0, -30), // on the south approach, inside the 60 m circle
  R: pt(-130, -150), // a side street joining the south approach at M (bearing ~221 degrees)
};
/** Two-way single carriageways; rank 3 for the main roads, 1 for the side street. */
const spec: [string, string, number][] = [
  ['N', 'C', 3], ['C', 'N', 3], ['E', 'C', 3], ['C', 'E', 3],
  ['S', 'M', 3], ['M', 'C', 3], ['C', 'M', 3], ['M', 'S', 3],
  ['R', 'M', 1], ['M', 'R', 1],
  ['W', 'C', 3], ['C', 'W', 3],
];
const links: LinkEnds[] = spec.map(([a, b, rank], index) => ({
  index, id: `${a}>${b}`, from: P[a], to: P[b], pts: [P[a], P[b]], fromNode: a, toNode: b, roadId: rank === 1 ? 'side' : `${[a, b].sort().join('')}`, rank, lanes: rank === 1 ? 1 : 2,
}));
const id = (a: string, b: string) => spec.findIndex(([x, y]) => x === a && y === b);
const zone = { id: 'j', lng: P.C[0], lat: P.C[1], radiusM: 60 };

describe('stop-line counting', () => {
  it('takes the arms from the links into and out of the junction core, not from every road crossing the circle', () => {
    const edge = layoutZone(zone, links); // zone-edge layout: the side street is an arm of its own
    expect(edge.arms.length).toBe(5);
    const z = layoutZone(zone, links, new Set(['C']));
    expect(z.problem).toBeNull();
    expect(z.arms.map(a => a.cardinal).sort()).toEqual(['E', 'N', 'S', 'W']);
    const south = z.arms.find(a => a.cardinal === 'S')!;
    expect(south.inbound).toEqual([id('M', 'C')]); // the stop-line link
    expect(south.origins).toEqual([id('S', 'M')]); // traced back along its road to the circle's edge
    expect(south.destinations).toEqual([id('M', 'S')]);
    expect(z.approachOf.has(id('R', 'M'))).toBe(false);
  });

  it('counts side-street traffic on the approach whose stop line it crosses, and not traffic that turns off before it', () => {
    const z = layoutZone(zone, links, new Set(['C']));
    // From the side street, through the south stop line, out east: a right turn from S (left-hand traffic)
    expect(routeMovements([id('R', 'M'), id('M', 'C'), id('C', 'E')], [z])).toEqual([movementKey('j', 'S', 'right')]);
    // South approach turning into the side street before the stop line: no counted movement
    expect(routeMovements([id('S', 'M'), id('M', 'R')], [z])).toEqual([]);
    // The zone-edge layout takes the side street for an arm of the junction
    expect(layoutZone(zone, links).inbound).toContain(id('R', 'M'));
  });

  it('seeds counted traffic on the approach road itself, from where it enters the circle', () => {
    const z = layoutZone(zone, links, new Set(['C']));
    const j = { id: 'j', name: 'J', location: { lon: P.C[0], lat: P.C[1], method: 't' }, movements: [{ approach: 'S', turn: 'right', LV: 100 }] } as CountJunction;
    const { trips } = seedTrips([j], [z], links, new Set());
    expect(trips).toHaveLength(1);
    expect(trips[0].from.slice(0, 2)).toEqual(P.S); // start of the south road, not the side street
    expect(trips[0].to.slice(0, 2)).toEqual(P.E);
    // Pinned to the counted movement: through the south stop-line link and the east exit
    expect(trips[0].viaLinkIds).toEqual(['M>C', 'C>E']);
  });

  it('a trace never runs round a block to another arm', () => {
    // A ring road from the east arm's end round to the north: leads away from the junction
    // only at first, then back towards it, so it does not carry the east arm's bearing north
    const extra: LinkEnds[] = [...links,
      { index: 12, from: P.C, to: pt(45, 5), pts: [P.C, pt(45, 5)], fromNode: 'C', toNode: 'X', roadId: 'ring', rank: 3, lanes: 2 },
      { index: 13, from: pt(45, 5), to: pt(40, 45), pts: [pt(45, 5), pt(40, 45)], fromNode: 'X', toNode: 'Y', roadId: 'ring', rank: 3, lanes: 2 },
      { index: 14, from: pt(40, 45), to: pt(5, 190), pts: [pt(40, 45), pt(5, 190)], fromNode: 'Y', toNode: 'Z', roadId: 'ring', rank: 3, lanes: 2 },
    ];
    const z = layoutZone(zone, extra, new Set(['C']));
    const arm = z.arms.find(a => a.outbound.includes(12))!;
    // X -> Y leads round, not out (outward share well below cos 60 degrees): the trace stops at X, east of the junction
    expect(arm.cardinal).toBe('E');
  });

  it('can rotate the compass labels and widen the limit for a sensitivity run, and says when arms are too far off', () => {
    // Arm bearings as at Kokane Chowk (44, 118, 232, 323 degrees): about 45 degrees off the compass
    const at = (b: number, r: number) => pt(r * Math.sin(b * Math.PI / 180), r * Math.cos(b * Math.PI / 180));
    const Q: Record<string, [number, number]> = { C: P.C, N: at(44, 200), E: at(118, 200), S: at(232, 200), W: at(323, 200), M: at(232, 30), R: at(270, 150) };
    const skew = links.map(l => ({ ...l, from: Q[l.fromNode!], to: Q[l.toNode!], pts: [Q[l.fromNode!], Q[l.toNode!]] }));
    const z = layoutZone(zone, skew, new Set(['C']));
    expect(z.problem).toMatch(/do not line up/);
    const wide = layoutZone({ ...zone, maxCardinalErrorDeg: 65 }, skew, new Set(['C']));
    expect(wide.problem).toBeNull();
    const shifted = layoutZone({ ...zone, maxCardinalErrorDeg: 65, labelShift: 1 }, skew, new Set(['C']));
    const label = (l: typeof z) => l.approachOf.get(id('N', 'C'));
    expect(label(shifted)).toBe({ N: 'E', E: 'S', S: 'W', W: 'N' }[label(wide)!]);
  });
});

/**
 * Turning movements at a counted junction in the simulated network.
 *
 * A counted junction is a circle (a "count zone") around its located point.
 * A link that ends inside the zone and starts outside it is an *inbound* link
 * (traffic approaching); one that starts inside and ends outside is an
 * *outbound* link. Links wholly inside (a roundabout ring, the short pieces of
 * a divided-road crossing) are the junction itself. A movement is the pair
 * (inbound link a vehicle entered by, outbound link it left by), which works
 * for plain crossroads, divided-road crossings and roundabouts alike.
 *
 * Arms are found by clustering the bearings, from the zone centre, of the
 * outside ends of inbound and outbound links. The survey names approaches by
 * compass point (N/E/S/W), so the arms are given compass labels by the
 * assignment with the least total angular error. Turns then follow from the
 * labels: from approach N (heading south) left is E, straight is S, right is
 * W. A junction whose arms do not fit four compass points within
 * MAX_CARDINAL_ERROR_DEG is reported, not forced.
 */
import type { Cardinal, Turn } from './observedCounts';
import { CARDINALS } from './observedCounts';

export interface LinkEnds {
  index: number;
  from: readonly [number, number] | readonly number[];
  to: readonly [number, number] | readonly number[];
}
export interface CountZone { id: string; lng: number; lat: number; radiusM: number }
export interface ZoneArm { bearing: number; cardinal: Cardinal | null; inbound: number[]; outbound: number[]; errorDeg: number | null }
export interface ZoneLayout {
  zone: CountZone;
  inbound: number[];
  outbound: number[];
  arms: ZoneArm[];
  /** Inbound link -> approach label; outbound link -> exit label. */
  approachOf: Map<number, Cardinal>;
  exitOf: Map<number, Cardinal>;
  /** Largest angle between an arm and its compass label. */
  maxCardinalErrorDeg: number | null;
  problem: string | null;
}

const M_PER_DEG_LAT = 111_320;
/** Arms closer than this (degrees of bearing) are one arm: the two carriageways of a divided road. */
export const ARM_MERGE_DEG = 35;
export const MAX_CARDINAL_ERROR_DEG = 50;

export function distanceM(lng1: number, lat1: number, lng2: number, lat2: number) {
  const kx = M_PER_DEG_LAT * Math.cos(((lat1 + lat2) / 2) * Math.PI / 180);
  return Math.hypot((lng1 - lng2) * kx, (lat1 - lat2) * M_PER_DEG_LAT);
}

/** Compass bearing (degrees clockwise from north) from a to b. */
export function bearingDeg(aLng: number, aLat: number, bLng: number, bLat: number) {
  const kx = M_PER_DEG_LAT * Math.cos(aLat * Math.PI / 180);
  const b = Math.atan2((bLng - aLng) * kx, (bLat - aLat) * M_PER_DEG_LAT) * 180 / Math.PI;
  return (b + 360) % 360;
}

export const angleDiff = (a: number, b: number) => { const d = Math.abs(((a - b) % 360 + 360) % 360); return d > 180 ? 360 - d : d; };

const CARDINAL_BEARING: Record<Cardinal, number> = { N: 0, E: 90, S: 180, W: 270 };

/** Turn from an approach to an exit, as the driver sees it (left-hand traffic labels are the same). */
export function turnBetween(approach: Cardinal, exit: Cardinal): Turn | 'u_turn' {
  const i = CARDINALS.indexOf(approach), j = CARDINALS.indexOf(exit);
  const k = (j - i + 4) % 4;
  return k === 0 ? 'u_turn' : k === 1 ? 'left' : k === 2 ? 'straight' : 'right';
}

/** Mean of bearings on the circle. */
function meanBearing(bs: number[]) {
  const x = bs.reduce((n, b) => n + Math.cos(b * Math.PI / 180), 0), y = bs.reduce((n, b) => n + Math.sin(b * Math.PI / 180), 0);
  return (Math.atan2(y, x) * 180 / Math.PI + 360) % 360;
}

/**
 * Gives each arm a distinct compass label, or none, minimising the total
 * angular error. With more than four arms the extra arms stay unlabelled.
 */
export function assignCardinals(bearings: readonly number[]): { labels: (Cardinal | null)[]; errors: (number | null)[] } {
  const n = bearings.length;
  let best: { cost: number; labels: (Cardinal | null)[] } | null = null;
  const labels: (Cardinal | null)[] = new Array(n).fill(null);
  const used = new Set<Cardinal>();
  const labelled = Math.min(4, n);
  const walk = (i: number, count: number, cost: number) => {
    if (best && cost >= best.cost) return;
    if (i === n) {
      if (count === labelled) best = { cost, labels: [...labels] };
      return;
    }
    for (const c of CARDINALS) {
      if (used.has(c)) continue;
      used.add(c); labels[i] = c;
      walk(i + 1, count + 1, cost + angleDiff(bearings[i], CARDINAL_BEARING[c]) ** 2);
      used.delete(c); labels[i] = null;
    }
    // Leave this arm unlabelled only if the remaining arms can still fill the labels
    if (n - i - 1 >= labelled - count) walk(i + 1, count, cost);
  };
  walk(0, 0, 0);
  const chosen = (best as { cost: number; labels: (Cardinal | null)[] } | null)?.labels ?? labels;
  return { labels: chosen, errors: chosen.map((c, i) => (c ? angleDiff(bearings[i], CARDINAL_BEARING[c]) : null)) };
}

export function layoutZone(zone: CountZone, links: readonly LinkEnds[]): ZoneLayout {
  const inside = (p: readonly number[]) => distanceM(p[0], p[1], zone.lng, zone.lat) <= zone.radiusM;
  const inbound: number[] = [], outbound: number[] = [];
  const ends: { bearing: number; link: number; dir: 'in' | 'out' }[] = [];
  for (const l of links) {
    const fi = inside(l.from), ti = inside(l.to);
    if (!fi && ti) { inbound.push(l.index); ends.push({ bearing: bearingDeg(zone.lng, zone.lat, l.from[0], l.from[1]), link: l.index, dir: 'in' }); }
    else if (fi && !ti) { outbound.push(l.index); ends.push({ bearing: bearingDeg(zone.lng, zone.lat, l.to[0], l.to[1]), link: l.index, dir: 'out' }); }
  }
  // Cluster bearings: sort, then split where the gap between neighbours exceeds ARM_MERGE_DEG
  const sorted = [...ends].sort((a, b) => a.bearing - b.bearing);
  const clusters: (typeof ends)[] = [];
  for (const e of sorted) {
    const last = clusters[clusters.length - 1];
    if (last && e.bearing - last[last.length - 1].bearing <= ARM_MERGE_DEG) last.push(e);
    else clusters.push([e]);
  }
  if (clusters.length > 1) {
    const first = clusters[0], last = clusters[clusters.length - 1];
    if (first[0].bearing + 360 - last[last.length - 1].bearing <= ARM_MERGE_DEG) clusters[0] = [...clusters.pop()!, ...first];
  }
  const bearings = clusters.map(c => meanBearing(c.map(e => e.bearing)));
  const { labels, errors } = assignCardinals(bearings);
  const arms: ZoneArm[] = clusters.map((c, i) => ({
    bearing: bearings[i], cardinal: labels[i], errorDeg: errors[i],
    inbound: c.filter(e => e.dir === 'in').map(e => e.link), outbound: c.filter(e => e.dir === 'out').map(e => e.link),
  }));
  const approachOf = new Map<number, Cardinal>(), exitOf = new Map<number, Cardinal>();
  for (const a of arms) {
    if (!a.cardinal) continue;
    for (const l of a.inbound) approachOf.set(l, a.cardinal);
    for (const l of a.outbound) exitOf.set(l, a.cardinal);
  }
  const errs = errors.filter((e): e is number => e !== null);
  const maxErr = errs.length ? Math.max(...errs) : null;
  let problem: string | null = null;
  if (!inbound.length) problem = 'No simulated road enters this junction.';
  else if (arms.length < 3) problem = `Only ${arms.length} arm(s) of this junction are in the simulated network.`;
  else if (maxErr !== null && maxErr > MAX_CARDINAL_ERROR_DEG) problem = `The arms do not line up with the survey's N/E/S/W approaches (an arm is ${Math.round(maxErr)}° off).`;
  return { zone, inbound, outbound, arms, approachOf, exitOf, maxCardinalErrorDeg: maxErr, problem };
}

/** Movement key used for both observed and simulated flows. */
export const movementKey = (zoneId: string, approach: Cardinal, turn: Turn) => `${zoneId}|${approach}|${turn}`;

/**
 * The counted movements a route passes through: for each zone, the inbound
 * link it entered by and the next outbound link of that zone it left by.
 */
export function routeMovements(route: readonly number[], layouts: readonly ZoneLayout[]): string[] {
  const out: string[] = [];
  for (const z of layouts) {
    if (z.problem) continue;
    let entry: Cardinal | null = null;
    for (const link of route) {
      if (entry === null) {
        const a = z.approachOf.get(link);
        if (a) entry = a;
        continue;
      }
      const e = z.exitOf.get(link);
      if (e) {
        const t = turnBetween(entry, e);
        if (t !== 'u_turn') out.push(movementKey(z.zone.id, entry, t));
        entry = null;
      } else if (z.approachOf.has(link)) entry = z.approachOf.get(link)!; // re-entered without leaving
    }
  }
  return out;
}

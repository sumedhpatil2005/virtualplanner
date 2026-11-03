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
 *
 * Stop-line counting (when the simulator gives the junction's core nodes):
 * the survey counts vehicles as they cross the stop line of each approach
 * into the junction, so a movement is the link a vehicle *enters the core*
 * by (the junction node itself, or a roundabout's ring) and the link it
 * leaves the core by. A side street that joins an approach inside the zone
 * is not an arm of its own: its vehicles are counted on the approach whose
 * stop line they cross, and vehicles that turn off before the stop line are
 * not counted, as at a real count station. Each stop-line link is traced
 * back (or, for exits, forward) along its own road to where it crosses the
 * zone edge, and the arm's bearing is taken there.
 */
import type { Cardinal, Turn } from './observedCounts';
import { CARDINALS } from './observedCounts';

export interface LinkEnds {
  index: number;
  from: readonly [number, number] | readonly number[];
  to: readonly [number, number] | readonly number[];
  /** The whole polyline (from ... to), when known: arm bearings are then taken where it crosses the zone edge. */
  pts?: readonly (readonly number[])[];
  /** Simulator link id (stable across rebuilds of the same network). */
  id?: string;
  /** Junction node ids at either end (after the simulator joins node clusters), road id and class rank: needed for stop-line counting. */
  fromNode?: string;
  toNode?: string;
  roadId?: string;
  rank?: number;
  lanes?: number;
}
export interface CountZone {
  id: string; lng: number; lat: number; radiusM: number;
  /**
   * Sensitivity analysis only: rotate the best-fit compass labels by this many
   * positions clockwise, and accept arms up to this far off their label. For a
   * junction whose arms sit near 45 degrees from the compass, where the survey's
   * N/E/S/W naming cannot be read off the geometry.
   */
  labelShift?: number;
  maxCardinalErrorDeg?: number;
}
export interface ZoneArm {
  bearing: number; cardinal: Cardinal | null; inbound: number[]; outbound: number[]; errorDeg: number | null;
  /** Stop-line counting: for each inbound link, the link where its road enters the zone (upstream end of the approach); for each outbound link, where its road leaves the zone. */
  origins?: number[];
  destinations?: number[];
}
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
/**
 * Tracing a stop-line link back along its road, the next link must lead away
 * from the junction for at least this share of its length (cos 60°), so the
 * trace never runs round a block to another arm.
 */
export const MIN_TRACE_OUTWARD = 0.5;

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

/**
 * The links that cross into and out of a junction's core (`core`: its node
 * ids), each traced along its own road to the zone edge. Returns null when
 * the links carry no node ids or no link touches the core.
 */
export function stopLineEnds(zone: CountZone, links: readonly LinkEnds[], core: ReadonlySet<string>) {
  if (!core.size || links.some(l => l.fromNode === undefined || l.toNode === undefined)) return null;
  const outside = (p: readonly number[]) => distanceM(p[0], p[1], zone.lng, zone.lat) > zone.radiusM;
  const byTo = new Map<string, LinkEnds[]>(), byFrom = new Map<string, LinkEnds[]>();
  for (const l of links) {
    if (!byTo.has(l.toNode!)) byTo.set(l.toNode!, []);
    byTo.get(l.toNode!)!.push(l);
    if (!byFrom.has(l.fromNode!)) byFrom.set(l.fromNode!, []);
    byFrom.get(l.fromNode!)!.push(l);
  }
  const pts = (l: LinkEnds) => (l.pts && l.pts.length >= 2 ? l.pts : [l.from, l.to]);
  /** Follows a stop-line link away from the core along its road: same road first, then the higher class, then the straightest continuation. */
  const trace = (start: LinkEnds, up: boolean): LinkEnds[] => {
    const chain = [start];
    const seen = new Set([start.index]);
    let cur = start;
    for (let hop = 0; hop < 12; hop++) {
      const farEnd = up ? cur.from : cur.to;
      if (outside(farEnd)) break;
      const node = up ? cur.fromNode! : cur.toNode!;
      const r = (p: readonly number[]) => distanceM(p[0], p[1], zone.lng, zone.lat);
      const len = (c: LinkEnds) => { const q = pts(c); let m = 0; for (let k = 1; k < q.length; k++) m += distanceM(q[k - 1][0], q[k - 1][1], q[k][0], q[k][1]); return Math.max(m, 0.1); };
      /** Share of the link's length that leads away from the junction: 1 straight out, 0 round it. */
      const outward = (c: LinkEnds) => (up ? r(c.from) - r(c.to) : r(c.to) - r(c.from)) / len(c);
      const cands = (up ? byTo.get(node) : byFrom.get(node))?.filter(c => !seen.has(c.index) && !core.has(up ? c.fromNode! : c.toNode!)
        // not the opposite carriageway of the same stretch
        && !(up ? c.fromNode === cur.toNode : c.toNode === cur.fromNode)
        // leading away from the junction, not round a block towards another arm
        && outward(c) >= MIN_TRACE_OUTWARD) ?? [];
      if (!cands.length) break;
      const score = (c: LinkEnds) => (c.roadId !== undefined && c.roadId === cur.roadId ? 1e6 : 0) + (c.rank ?? 0) * 1e3 + outward(c);
      cur = cands.reduce((a, b) => (score(b) > score(a) ? b : a));
      seen.add(cur.index);
      chain.push(cur);
    }
    return chain;
  };
  /** Where the traced road leaves the zone, walking out from the core. */
  const edgePoint = (chain: LinkEnds[], up: boolean): readonly number[] => {
    let last: readonly number[] = up ? chain[0].to : chain[0].from;
    for (const l of chain) {
      const ordered = up ? [...pts(l)].reverse() : pts(l);
      for (const p of ordered) { if (outside(p)) return p; last = p; }
    }
    return last;
  };
  const ends: { bearing: number; link: number; dir: 'in' | 'out'; far: number }[] = [];
  for (const l of links) {
    const fi = core.has(l.fromNode!), ti = core.has(l.toNode!);
    if (!fi && ti) {
      const chain = trace(l, true);
      const p = edgePoint(chain, true);
      ends.push({ bearing: bearingDeg(zone.lng, zone.lat, p[0], p[1]), link: l.index, dir: 'in', far: chain[chain.length - 1].index });
    } else if (fi && !ti) {
      const chain = trace(l, false);
      const p = edgePoint(chain, false);
      ends.push({ bearing: bearingDeg(zone.lng, zone.lat, p[0], p[1]), link: l.index, dir: 'out', far: chain[chain.length - 1].index });
    }
  }
  return ends.some(e => e.dir === 'in') ? ends : null;
}

export function layoutZone(zone: CountZone, links: readonly LinkEnds[], core?: ReadonlySet<string>): ZoneLayout {
  const inside = (p: readonly number[]) => distanceM(p[0], p[1], zone.lng, zone.lat) <= zone.radiusM;
  /**
   * Where the arm leaves the zone: the first polyline point outside it,
   * walking out from the junction end. Far ends of long links can bend away
   * (two carriageways of one road ending in different directions), so the
   * far end alone would split one arm into two.
   */
  const armPoint = (l: LinkEnds, inboundLink: boolean): readonly number[] => {
    const pts = l.pts && l.pts.length >= 2 ? l.pts : [l.from, l.to];
    const ordered = inboundLink ? [...pts].reverse() : pts;
    for (const p of ordered) if (distanceM(p[0], p[1], zone.lng, zone.lat) > zone.radiusM) return p;
    return ordered[ordered.length - 1];
  };
  const inbound: number[] = [], outbound: number[] = [];
  let ends: { bearing: number; link: number; dir: 'in' | 'out'; far?: number }[] = [];
  const stopLine = core ? stopLineEnds(zone, links, core) : null;
  if (stopLine) {
    ends = stopLine;
    for (const e of ends) (e.dir === 'in' ? inbound : outbound).push(e.link);
  } else {
    for (const l of links) {
      const fi = inside(l.from), ti = inside(l.to);
      if (!fi && ti) { const p = armPoint(l, true); inbound.push(l.index); ends.push({ bearing: bearingDeg(zone.lng, zone.lat, p[0], p[1]), link: l.index, dir: 'in' }); }
      else if (fi && !ti) { const p = armPoint(l, false); outbound.push(l.index); ends.push({ bearing: bearingDeg(zone.lng, zone.lat, p[0], p[1]), link: l.index, dir: 'out' }); }
    }
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
  const best = assignCardinals(bearings);
  const shift = ((zone.labelShift ?? 0) % 4 + 4) % 4;
  const labels = best.labels.map(c => (c && shift ? CARDINALS[(CARDINALS.indexOf(c) + shift) % 4] : c));
  const errors = labels.map((c, i) => (c ? angleDiff(bearings[i], CARDINAL_BEARING[c]) : null));
  const arms: ZoneArm[] = clusters.map((c, i) => ({
    bearing: bearings[i], cardinal: labels[i], errorDeg: errors[i],
    inbound: c.filter(e => e.dir === 'in').map(e => e.link), outbound: c.filter(e => e.dir === 'out').map(e => e.link),
    ...(stopLine ? { origins: c.filter(e => e.dir === 'in').map(e => e.far!), destinations: c.filter(e => e.dir === 'out').map(e => e.far!) } : {}),
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
  else if (maxErr !== null && maxErr > (zone.maxCardinalErrorDeg ?? MAX_CARDINAL_ERROR_DEG)) problem = `The arms do not line up with the survey's N/E/S/W approaches (an arm is ${Math.round(maxErr)}° off).`;
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

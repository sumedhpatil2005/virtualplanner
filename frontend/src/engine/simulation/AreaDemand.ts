import type { TrafficNetwork } from '../objects/trafficTypes';
import { isAreaCutEnd, type StudyArea, type DrivableObject } from './StudyAreaExplorer';
import type { VehicleKind } from './TrafficMicroSim';
import { VEHICLE_TYPES } from './TrafficMicroSim';
import { roadKeys } from './roadSection';
import { activityEndpoints, type DemandPlan, type SimulationContext, type DemandComponents, type ActivityEndpoint } from './StudyDemand';

/**
 * Study-area demand with the trips that cross the area's edge.
 *
 * The earlier estimate sent every trip made by a building in the area to
 * another building in the area (gravity, 1/d², up to 32 destinations). A study
 * area is a few kilometres across, while motorised trips in Pune average 4.7 to
 * 8.5 km (CMP 2018, Table 9), so most trips made by its buildings leave it, and
 * most traffic on its main roads comes from beyond it. Leaving both out is why
 * the main roads of an area ran nearly empty (docs/ROAD_ANALYSIS.md).
 *
 * The demand now has three parts, each labelled in the plan:
 *  1. internal: trips between places inside the area (trip-length deterrence);
 *  2. land-use <-> edge: the trips of the area's buildings that start or end
 *     beyond the edge, entering or leaving by the roads that cross it;
 *  3. through: traffic crossing the area on its arterial and collector roads,
 *     the part of the edge flow not already made by the area's own trips.
 *
 * Every number is an estimate. Sources and assumptions are in DEMAND_SOURCES.
 */

/** Mean motorised trip length by vehicle (km), CMP 2018 Table 9, overall study area. */
export const MEAN_TRIP_KM: Partial<Record<VehicleKind, number>> = { two_wheeler: 7.54, auto: 4.68, car: 8.54, bus: 6.25 };
const DEFAULT_TRIP_KM = 7.0;

/**
 * Peak-hour flow per lane and direction at the area edge (veh/h), by road class.
 *
 * Arterial: the 20 approaches of the five counted junctions on primary or
 * secondary roads in west Pune (Kokane, Panchratna, Kasturi, Ganraj, Infosys
 * Circle; backend/data/observed_counts/pune_west_2026.json) carry 867-2,679
 * veh/h, median about 1,450, on approaches of 2-3 lanes (OSM): about 500-700
 * veh/h per lane. The lower end, 500, is used.
 * Collector: no counts; assumed 300 (about 60% of the arterial value).
 * Highway (OSM trunk/motorway): no counts; the arterial value is used. Local streets get no through traffic: only
 * the trips of the buildings they serve.
 */
export const EDGE_FLOW_PER_LANE_VPH: Record<string, number> = { highway: 500, arterial: 500, collector: 300, local: 0 };

/** Through trips leave by the road they came in on this many times more readily than by another (assumption). */
export const SAME_ROAD_WEIGHT = 3;

export const DEMAND_SOURCES = [
  'Trip generation: PCMC motorised trips per person 0.87/day, peak-hour share 7.8%, PCMC mode split and occupancy (CMP 2018 Tables 6-7, p. E-5; CMP 2008 Table 4.7).',
  'Trip length: mean motorised trip lengths 7.54 km two-wheeler, 4.68 km auto, 8.54 km car, 6.25 km bus (CMP 2018 Table 9, overall study area). Their spread (Erlang, shape 2) is an assumption.',
  'Edge flows on arterials: 500 veh/h per lane per direction, the low end of the counted approaches at five west-Pune junctions (NICMAR 2025 / Kureshi 2026). Collector 300 veh/h per lane is an assumption and trunk roads use the arterial value; local streets carry no through traffic.',
  'Through traffic: edge-to-edge trips balanced to the edge flows (Furness), weighted by distance across the area and three times more likely to stay on the road they came in on (assumption).',
  'Vehicle mix of edge and through traffic: Gunjan Chowk classified counts (Thakur et al. 2017).',
  'Buildings: residents and jobs as imported (OpenStreetMap buildings: floors x 12 people by category). OSM rarely tags workplaces, so jobs are under-counted; trips with no destination inside the area leave it.',
] as const;

export interface CordonPoint {
  nodeId: string;
  coordinates: [number, number, number];
  roadId: string;
  roadClass: string;
  roadName: string;
  /** Lanes arriving from outside / leaving to outside. */
  inLanes: number;
  outLanes: number;
  /** Class-typical peak-hour flow entering / leaving here (veh/h). */
  inVph: number;
  outVph: number;
}

/**
 * Edge flow per lane for a road: by class, but none on slip roads and ramps
 * (OSM *_link): traffic crossing the edge is counted on the main carriageway,
 * and a ramp at the edge would count it twice.
 */
export function edgeFlowPerLane(road: DrivableObject | undefined): number {
  const hw = road?.type === 'road' ? road.osmProvenance?.originalTags?.highway ?? '' : '';
  if (hw.endsWith('_link') || hw === 'service') return 0;
  return EDGE_FLOW_PER_LANE_VPH[road?.roadClass ?? 'local'] ?? 0;
}

const segmentKey = (edgeId: string) => edgeId.replace(/_(fwd|bwd)$/, '');
const M_PER_DEG_LAT = 111320;
const distM = (a: readonly number[], b: readonly number[]) =>
  Math.hypot((a[0] - b[0]) * M_PER_DEG_LAT * Math.cos(a[1] * Math.PI / 180), (a[1] - b[1]) * M_PER_DEG_LAT);

/** Where roads cross the area's edge, with their lanes and class-typical flows. */
export function cordonOf(area: StudyArea, roads: ReadonlyMap<string, DrivableObject>): CordonPoint[] {
  const net = area.network;
  const included = new Set(area.segments.map(s => s.key));
  const out: CordonPoint[] = [];
  const seen = new Set<string>(), cut = new Set<string>();
  for (const b of area.boundary) {
    const node = net.nodes.get(b.nodeId);
    if (!node) continue;
    let inLanes = 0, outLanes = 0, inVph = 0, outVph = 0;
    let best: { roadId: string; rank: number } | null = null;
    const rank: Record<string, number> = { highway: 4, arterial: 3, collector: 2, local: 1 };
    const visit = (ids: string[], dir: 'in' | 'out') => {
      for (const id of ids) {
        const e = net.edges.get(id);
        if (!e || included.has(segmentKey(id))) continue;
        const cls = roads.get(e.roadId)?.roadClass ?? 'local';
        const lanes = Math.max(1, e.lanes || 1);
        const vph = lanes * edgeFlowPerLane(roads.get(e.roadId));
        if (dir === 'in') { inLanes += lanes; inVph += vph; } else { outLanes += lanes; outVph += vph; }
        const r = rank[cls] ?? 1;
        if (!best || r > best.rank) best = { roadId: e.roadId, rank: r };
      }
    };
    visit(node.incomingSegments, 'in');
    visit(node.outgoingSegments, 'out');
    // An edge with no outside road (a cut end) carries nothing until a gateway is placed there
    if (!best || (inLanes === 0 && outLanes === 0)) continue;
    const road = roads.get((best as { roadId: string }).roadId);
    seen.add(b.nodeId);
    out.push({ nodeId: b.nodeId, coordinates: [...node.coordinates] as [number, number, number], roadId: (best as { roadId: string }).roadId,
      roadClass: road?.roadClass ?? 'local', roadName: road?.name || 'Unnamed road', inLanes, outLanes, inVph, outVph });
  }
  // Roads cut where they cross a mapped area's boundary ("Map Selected Area") go on outside it:
  // traffic enters and leaves there too, by the road's own lanes
  for (const e of net.edges.values()) {
    if (!included.has(segmentKey(e.id))) continue;
    const road = roads.get(e.roadId);
    for (const [nodeId, dir] of [[e.fromNodeId, 'in'], [e.toNodeId, 'out']] as const) {
      const node = net.nodes.get(nodeId);
      if (!node || !isAreaCutEnd(road, node.coordinates)) continue;
      // Another road meeting at the cut point means the network goes on there
      if (node.incomingSegments.length + node.outgoingSegments.length > (e.direction === 'forward' ? 1 : 2)) continue;
      let p = out.find(x => x.nodeId === nodeId);
      if (!p) {
        if (seen.has(nodeId)) continue;
        p = { nodeId, coordinates: [...node.coordinates] as [number, number, number], roadId: e.roadId, roadClass: road?.roadClass ?? 'local', roadName: road?.name || 'Unnamed road', inLanes: 0, outLanes: 0, inVph: 0, outVph: 0 };
        out.push(p);
        cut.add(nodeId);
      }
      if (!cut.has(nodeId)) continue;
      const lanes = Math.max(1, e.lanes || 1), vph = lanes * edgeFlowPerLane(road);
      if (dir === 'in') { p.inLanes += lanes; p.inVph += vph; } else { p.outLanes += lanes; p.outVph += vph; }
    }
  }
  return out;
}

/**
 * Directed reachability between road nodes: strongly connected components
 * (iterative Tarjan), then reachable components per origin component over the
 * condensed graph, memoised. Most of a road network is one component, so this
 * costs one pass plus a few small searches.
 */
function reachability(adj: ReadonlyMap<string, string[]>): (from: string, to: string) => boolean {
  const index = new Map<string, number>(), low = new Map<string, number>(), comp = new Map<string, number>();
  const onStack = new Set<string>(), stack: string[] = [];
  let next = 0, comps = 0;
  const nodes = new Set<string>([...adj.keys(), ...[...adj.values()].flat()]);
  for (const root of nodes) {
    if (index.has(root)) continue;
    const work: { v: string; i: number }[] = [{ v: root, i: 0 }];
    index.set(root, next); low.set(root, next); next++; stack.push(root); onStack.add(root);
    while (work.length) {
      const top = work[work.length - 1];
      const out = adj.get(top.v) ?? [];
      if (top.i < out.length) {
        const w = out[top.i++];
        if (!index.has(w)) { index.set(w, next); low.set(w, next); next++; stack.push(w); onStack.add(w); work.push({ v: w, i: 0 }); }
        else if (onStack.has(w)) low.set(top.v, Math.min(low.get(top.v)!, index.get(w)!));
        continue;
      }
      work.pop();
      if (work.length) { const p = work[work.length - 1].v; low.set(p, Math.min(low.get(p)!, low.get(top.v)!)); }
      if (low.get(top.v) === index.get(top.v)) {
        let w: string;
        do { w = stack.pop()!; onStack.delete(w); comp.set(w, comps); } while (w !== top.v);
        comps++;
      }
    }
  }
  const dag = new Map<number, Set<number>>();
  adj.forEach((outs, v) => { for (const w of outs) { const a = comp.get(v)!, b = comp.get(w)!; if (a !== b) (dag.get(a) ?? dag.set(a, new Set()).get(a)!).add(b); } });
  const memo = new Map<number, Set<number>>();
  const reachableFrom = (c: number) => {
    let r = memo.get(c);
    if (r) return r;
    r = new Set([c]);
    const st = [c];
    while (st.length) for (const d of dag.get(st.pop()!) ?? []) if (!r.has(d)) { r.add(d); st.push(d); }
    memo.set(c, r);
    return r;
  };
  return (from, to) => {
    const a = comp.get(from), b = comp.get(to);
    return a !== undefined && b !== undefined && reachableFrom(a).has(b);
  };
}

/** Erlang-2 survival: share of trips with mean length L longer than r. */
const longerThan = (rKm: number, meanKm: number) => { const x = 2 * rKm / meanKm; return (1 + x) * Math.exp(-x); };
/** Erlang-2 deterrence (density shape) for a trip of d km with mean length L. */
const deterrence = (dKm: number, meanKm: number) => { const d = Math.max(0.1, dKm); return d * Math.exp(-2 * d / meanKm); };

/** Convex hull (lng/lat), for the area's outline. */
function hull(points: [number, number][]): [number, number][] {
  const p = [...points].sort((a, b) => a[0] - b[0] || a[1] - b[1]);
  if (p.length < 3) return p;
  const cross = (o: number[], a: number[], b: number[]) => (a[0] - o[0]) * (b[1] - o[1]) - (a[1] - o[1]) * (b[0] - o[0]);
  const lower: [number, number][] = [], upper: [number, number][] = [];
  for (const q of p) { while (lower.length >= 2 && cross(lower[lower.length - 2], lower[lower.length - 1], q) <= 0) lower.pop(); lower.push(q); }
  for (let i = p.length - 1; i >= 0; i--) { const q = p[i]; while (upper.length >= 2 && cross(upper[upper.length - 2], upper[upper.length - 1], q) <= 0) upper.pop(); upper.push(q); }
  return [...lower.slice(0, -1), ...upper.slice(0, -1)];
}

const RAYS = 16;
/** Distances (km) from a point to the area outline along RAYS directions. */
function rayDistancesKm(point: readonly number[], outline: [number, number][]): number[] {
  const kx = M_PER_DEG_LAT * Math.cos(point[1] * Math.PI / 180);
  const poly = outline.map(([x, y]) => [(x - point[0]) * kx, (y - point[1]) * M_PER_DEG_LAT]);
  const out: number[] = [];
  for (let k = 0; k < RAYS; k++) {
    const a = (2 * Math.PI * k) / RAYS, dx = Math.cos(a), dy = Math.sin(a);
    let best = Infinity;
    for (let i = 0; i < poly.length; i++) {
      const [x1, y1] = poly[i], [x2, y2] = poly[(i + 1) % poly.length];
      const ex = x2 - x1, ey = y2 - y1;
      const den = dx * ey - dy * ex;
      if (Math.abs(den) < 1e-9) continue;
      const t = (x1 * ey - y1 * ex) / den, u = (x1 * dy - y1 * dx) / den;
      if (t >= 0 && u >= 0 && u <= 1) best = Math.min(best, t);
    }
    out.push(Number.isFinite(best) ? best / 1000 : 0);
  }
  return out;
}

/** Share of an endpoint's trips (mean length L km) that cross the area's edge. */
export function externalShare(point: readonly number[], outline: [number, number][], meanKm: number): number {
  if (outline.length < 3) return 1;
  const rays = rayDistancesKm(point, outline);
  return rays.reduce((n, r) => n + longerThan(r, meanKm), 0) / rays.length;
}

export interface AreaDemandOptions {
  /** Leave out traffic crossing the area (land-use trips only), to see what the area's own buildings make. */
  through?: boolean;
  /** Snap distance from a trip end to the area's roads (m). */
  accessM?: number;
}

/**
 * Peak-hour OD demand for a study area: internal, land-use <-> edge and
 * through trips (see the module comment). Coordinates, not node ids, so the
 * same demand can be replayed after a road edit.
 */
export function compileAreaDemand(context: SimulationContext, area: StudyArea, roads: ReadonlyMap<string, DrivableObject>, options: AreaDemandOptions = {}): DemandPlan | null {
  const period = context.period ?? 'AM_Peak';
  const accessM = options.accessM ?? 250;
  const net: TrafficNetwork = area.network;
  const includedNodes = new Set<string>();
  const included = new Set(area.segments.map(s => s.key));
  for (const e of net.edges.values()) if (included.has(segmentKey(e.id))) { includedNodes.add(e.fromNodeId); includedNodes.add(e.toNodeId); }
  const nodes = [...includedNodes].map(id => net.nodes.get(id)!).filter(Boolean);

  // A trip end belongs to the area when one of its ground-level roads is within reach
  const grid = new Map<string, typeof nodes>();
  const cell = (lng: number, lat: number) => `${Math.floor(lng / 0.003)}:${Math.floor(lat / 0.003)}`;
  for (const n of nodes) { const k = cell(n.coordinates[0], n.coordinates[1]); (grid.get(k) ?? grid.set(k, []).get(k)!).push(n); }
  const snap = (p: readonly number[]) => {
    const cx = Math.floor(p[0] / 0.003), cy = Math.floor(p[1] / 0.003);
    let best: (typeof nodes)[number] | null = null, bd = accessM;
    for (let dx = -1; dx <= 1; dx++) for (let dy = -1; dy <= 1; dy++) for (const n of grid.get(`${cx + dx}:${cy + dy}`) ?? []) {
      if (Math.abs((n.coordinates[2] || 0) - (p[2] || 0)) > 3) continue;
      const d = distM(p, n.coordinates);
      if (d < bd) { bd = d; best = n; }
    }
    return best;
  };

  const b = area.bounds;
  const padLat = 250 / M_PER_DEG_LAT, padLng = padLat / Math.cos((b.minLat + b.maxLat) / 2 * Math.PI / 180);
  const { origins, destinations } = activityEndpoints(context, { minLng: b.minLng - padLng, maxLng: b.maxLng + padLng, minLat: b.minLat - padLat, maxLat: b.maxLat + padLat });
  const cordon = cordonOf(area, roads);
  if (!cordon.length && !origins.length && !destinations.length) return null;
  // Directed reachability on the area's roads: an edge trip is only sent where it can actually drive
  const fwd = new Map<string, string[]>(), bwd = new Map<string, string[]>();
  for (const e of net.edges.values()) {
    if (!included.has(segmentKey(e.id))) continue;
    (fwd.get(e.fromNodeId) ?? fwd.set(e.fromNodeId, []).get(e.fromNodeId)!).push(e.toNodeId);
    (bwd.get(e.toNodeId) ?? bwd.set(e.toNodeId, []).get(e.toNodeId)!).push(e.fromNodeId);
  }
  const reach = (start: string, adj: Map<string, string[]>) => {
    const seenN = new Set([start]), stack = [start];
    while (stack.length) for (const n of adj.get(stack.pop()!) ?? []) if (!seenN.has(n)) { seenN.add(n); stack.push(n); }
    return seenN;
  };
  const canReach = reachability(fwd);
  const fromEntry = new Map(cordon.filter(c => c.inLanes > 0).map(c => [c.nodeId, reach(c.nodeId, fwd)]));
  const toExit = new Map(cordon.filter(c => c.outLanes > 0).map(c => [c.nodeId, reach(c.nodeId, bwd)]));
  const outline = hull(cordon.length >= 3 ? cordon.map(c => [c.coordinates[0], c.coordinates[1]]) : nodes.map(n => [n.coordinates[0], n.coordinates[1]]));

  // Trip ends of the area's activity, merged per road node they reach
  type End = { nodeId: string; point: [number, number, number]; vehicles: Map<VehicleKind, number>; gateway: boolean };
  // Frontage per node: half the length of the local and collector stretches meeting there (where zone activity lives)
  const frontage = new Map<string, number>();
  for (const e of net.edges.values()) {
    if (!included.has(segmentKey(e.id)) || e.id.endsWith('_bwd')) continue;
    const cls = roads.get(e.roadId)?.roadClass ?? 'local';
    if (cls !== 'local' && cls !== 'collector') continue;
    for (const id of [e.fromNodeId, e.toNodeId]) frontage.set(id, (frontage.get(id) ?? 0) + e.length / 2);
  }
  const inPolygon = (p: readonly number[], poly: readonly (readonly number[])[]) => {
    let r = false;
    for (let i = 0, j = poly.length - 1; i < poly.length; j = i++) {
      const a = poly[i], c = poly[j];
      if ((a[1] > p[1]) !== (c[1] > p[1]) && p[0] < (c[0] - a[0]) * (p[1] - a[1]) / (c[1] - a[1]) + a[0]) r = !r;
    }
    return r;
  };
  const merge = (list: ActivityEndpoint[]) => {
    const byNode = new Map<string, End>();
    let dropped = 0;
    const addTo = (n: (typeof nodes)[number], e: ActivityEndpoint, share: number) => {
      const end = byNode.get(n.id) ?? byNode.set(n.id, { nodeId: n.id, point: [...n.coordinates] as [number, number, number], vehicles: new Map(), gateway: false }).get(n.id)!;
      for (const [k, v] of e.vehicles) end.vehicles.set(k, (end.vehicles.get(k) ?? 0) + v * share);
    };
    for (const e of list) {
      // A residual zone's activity is spread over the streets inside it, not put at its centroid
      if (e.spread && e.spread.length >= 3) {
        const inside = nodes.filter(n => (frontage.get(n.id) ?? 0) > 0 && inPolygon(n.coordinates, e.spread!));
        const total = inside.reduce((x, n) => x + frontage.get(n.id)!, 0);
        if (total > 0) { for (const n of inside) addTo(n, e, frontage.get(n.id)! / total); continue; }
      }
      const n = snap(e.point);
      if (!n) { dropped += e.flow; continue; }
      // Gateways stay separate: their flows already cross the edge
      const key = e.gateway ? `g:${e.id}` : n.id;
      const end = byNode.get(key) ?? byNode.set(key, { nodeId: n.id, point: [...n.coordinates] as [number, number, number], vehicles: new Map(), gateway: !!e.gateway }).get(key)!;
      for (const [k, v] of e.vehicles) end.vehicles.set(k, (end.vehicles.get(k) ?? 0) + v);
    }
    return { ends: [...byNode.values()], dropped };
  };
  const prod = merge(origins), attr = merge(destinations);

  const trips: DemandPlan['trips'] = [];
  const components: DemandComponents = { internal: 0, outbound: 0, inbound: 0, through: 0, outsideArea: prod.dropped + attr.dropped, noEdgeRoute: 0 };
  // A closed network (no road crosses the edge) is the whole modelled world: every trip stays inside it
  const share = (point: readonly number[], L: number) => cordon.length ? externalShare(point, outline, L) : 0;
  const usedIn = new Map<string, number>(), usedOut = new Map<string, number>();
  const push = (from: [number, number, number], to: [number, number, number], vph: number, kind: VehicleKind) => {
    if (vph > 1e-6 && distM(from, to) > 1) trips.push({ from: [...from], to: [...to], vehiclesPerHour: vph, kind });
  };
  const MAX_INTERNAL = 24, MAX_EDGE = 12;
  const attrTotal = (e: End) => [...e.vehicles.values()].reduce((n, v) => n + v, 0);
  const edgeWeights = (point: readonly number[], meanKm: number, side: 'in' | 'out', nodeId: string) => {
    const w = cordon.filter(c => side === 'out' ? toExit.get(c.nodeId)?.has(nodeId) : fromEntry.get(c.nodeId)?.has(nodeId)).map(c => ({ c, w: (side === 'out' ? c.outLanes : c.inLanes) * Math.max(60, side === 'out' ? c.outVph / Math.max(1, c.outLanes) : c.inVph / Math.max(1, c.inLanes)) * Math.exp(-distM(point, c.coordinates) / 1000 / meanKm) }))
      .filter(x => x.w > 0).sort((p, q) => q.w - p.w).slice(0, MAX_EDGE);
    const sum = w.reduce((n, x) => n + x.w, 0);
    return sum > 0 ? w.map(x => ({ c: x.c, share: x.w / sum })) : [];
  };

  // 1 + 2a: trips made by the area's productions (homes in the AM peak, jobs in the PM peak)
  for (const o of prod.ends) {
    for (const [kind, vph] of o.vehicles) {
      const L = MEAN_TRIP_KM[kind] ?? DEFAULT_TRIP_KM;
      // Only destinations the origin can drive to: a one-way street or a cut-off piece is not reached by drawing a line to it
      const options2 = attr.ends.filter(d => canReach(o.nodeId, d.nodeId)).map(d => ({ d, w: attrTotal(d) * deterrence(distM(o.point, d.point) / 1000, L) })).filter(x => x.w > 0 && distM(o.point, x.d.point) > 1)
        .sort((p, q) => q.w - p.w).slice(0, MAX_INTERNAL);
      const wSum = options2.reduce((n, x) => n + x.w, 0);
      const ext = wSum > 0 ? (o.gateway ? 0 : share(o.point, L)) : 1;
      for (const { d, w } of options2) { push(o.point, d.point, vph * (1 - ext) * w / wSum, kind); components.internal += vph * (1 - ext) * w / wSum; }
      const exits = edgeWeights(o.point, L, 'out', o.nodeId);
      if (!exits.length) components.noEdgeRoute! += vph * ext;
      for (const { c, share } of exits) {
        push(o.point, c.coordinates, vph * ext * share, kind);
        components.outbound += vph * ext * share;
        usedOut.set(c.nodeId, (usedOut.get(c.nodeId) ?? 0) + vph * ext * share);
      }
    }
  }
  // 2b: trips attracted by the area from beyond its edge
  for (const d of attr.ends) {
    for (const [kind, vph] of d.vehicles) {
      const L = MEAN_TRIP_KM[kind] ?? DEFAULT_TRIP_KM;
      if (d.gateway) continue; // reached from the area's own trips only
      const ext = share(d.point, L);
      const entries = edgeWeights(d.point, L, 'in', d.nodeId);
      if (!entries.length) components.noEdgeRoute! += vph * ext;
      for (const { c, share } of entries) {
        push(c.coordinates, d.point, vph * ext * share, kind);
        components.inbound += vph * ext * share;
        usedIn.set(c.nodeId, (usedIn.get(c.nodeId) ?? 0) + vph * ext * share);
      }
    }
  }
  // 3: through traffic on the main roads: the edge flow the area's own trips do not account for
  if (options.through !== false) {
    const rows = cordon.map(c => Math.max(0, c.inVph - (usedIn.get(c.nodeId) ?? 0)));
    const cols = cordon.map(c => Math.max(0, c.outVph - (usedOut.get(c.nodeId) ?? 0)));
    const n = cordon.length;
    // Seed: crossing the area is the point of a through trip, so farther pairs weigh more; never back out where it came in.
    // Through traffic mostly stays on its road: an exit on the same named road or route weighs SAME_ROAD_WEIGHT times more (assumption).
    const keysOf = cordon.map(c => roadKeys(roads.get(c.roadId)));
    const seed: number[][] = cordon.map((a, i) => cordon.map((c, j) => {
      if (i === j || rows[i] <= 0 || cols[j] <= 0 || !fromEntry.get(a.nodeId)?.has(c.nodeId)) return 0;
      const d = distM(a.coordinates, c.coordinates);
      if (d < 300 || a.roadId === c.roadId && d < 600) return 0;
      const same = [...keysOf[i]].some(k => keysOf[j].has(k));
      return (d / 1000) * (same ? SAME_ROAD_WEIGHT : 1);
    }));
    const m = seed.map(r => [...r]);
    for (let it = 0; it < 30; it++) {
      for (let i = 0; i < n; i++) { const s = m[i].reduce((x, y) => x + y, 0); if (s > 0) for (let j = 0; j < n; j++) m[i][j] *= rows[i] / s; }
      for (let j = 0; j < n; j++) { let s = 0; for (let i = 0; i < n; i++) s += m[i][j]; if (s > 0) for (let i = 0; i < n; i++) m[i][j] *= cols[j] / s; }
    }
    // Rows and columns cannot both be met when entry and exit flows differ: trim so that neither an entry nor an exit
    // carries more than its edge flow (scaling a column down never pushes a row back up)
    for (let i = 0; i < n; i++) { const s = m[i].reduce((x, y) => x + y, 0); if (s > rows[i]) for (let j = 0; j < n; j++) m[i][j] *= rows[i] / s; }
    for (let j = 0; j < n; j++) { let s = 0; for (let i = 0; i < n; i++) s += m[i][j]; if (s > cols[j]) for (let i = 0; i < n; i++) m[i][j] *= cols[j] / s; }
    const mix = VEHICLE_TYPES.filter(t => t.share > 0);
    for (let i = 0; i < n; i++) for (let j = 0; j < n; j++) {
      const v = m[i][j];
      if (v < 0.5) continue;
      components.through += v;
      for (const t of mix) push(cordon[i].coordinates, cordon[j].coordinates, v * t.share, t.kind);
    }
  }
  const total = trips.reduce((n, t) => n + t.vehiclesPerHour, 0);
  if (total <= 0) return null;
  const parts = [`${Math.round(components.internal)} internal`, `${Math.round(components.outbound + components.inbound)} to/from beyond the edge`, `${Math.round(components.through)} through`];
  if ((components.noEdgeRoute ?? 0) >= 1) parts.push(`${Math.round(components.noEdgeRoute!)} left out (no drivable way to the edge)`);
  return {
    trips,
    provenance: {
      source: 'project-estimate',
      label: `Estimated peak-hour demand: trips of the area's buildings (CMP 2018 Pune rates and trip lengths) plus traffic crossing the edge on main roads at counted Pune arterial flows. ${parts.join(', ')} veh/h. Not measured on these roads.`,
      period, vehiclesPerHour: total, pairCount: trips.length,
      components: { ...components, cordonPoints: cordon.length, throughIncluded: options.through !== false },
    },
  };
}

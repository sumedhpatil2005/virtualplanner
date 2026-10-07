import type { TrafficNetwork, TrafficEdge, TrafficNode } from '../objects/trafficTypes';
import type { RoadObject } from '../objects/types';
import { surfaceLiftM } from '../objects/roadSurface';
import type { StudyArea, DrivableObject } from './StudyAreaExplorer';
import { RouteTrees } from './routeTrees';

/**
 * Microscopic traffic simulation on a study area.
 *
 * Every vehicle follows the Intelligent Driver Model (IDM): it accelerates
 * towards its desired speed and brakes for whatever is ahead (another vehicle,
 * a red light, a junction it must give way at). Links keep their real lane
 * counts, so widening a road adds capacity. Traffic drives on the left.
 *
 * Deterministic for a given seed: all randomness comes from one seeded RNG.
 * No rendering here; see MicroTrafficVisualizer.
 */

export type VehicleKind = 'two_wheeler' | 'car' | 'bus_auto';

export interface VehicleTypeParams {
  kind: VehicleKind;
  /** Share of generated trips. */
  share: number;
  lengthM: number;
  maxAccel: number; // m/s²
  comfortDecel: number; // m/s²
  headwayS: number; // desired time gap
  minGapM: number; // standstill gap
  /** Desired speed as a multiple of the speed limit. */
  speedFactor: number;
  /** How long the vehicle occupies an unsignalised junction while crossing (s). */
  clearS: number;
}

/** Pune fleet mix from the execution plan: ~60% two-wheelers, ~30% cars, ~10% buses and autos. */
export const VEHICLE_TYPES: readonly VehicleTypeParams[] = [
  { kind: 'two_wheeler', share: 0.6, lengthM: 2.0, maxAccel: 2.0, comfortDecel: 2.5, headwayS: 0.9, minGapM: 1.2, speedFactor: 1.05, clearS: 1.5 },
  { kind: 'car', share: 0.3, lengthM: 4.5, maxAccel: 1.5, comfortDecel: 2.0, headwayS: 1.2, minGapM: 2.0, speedFactor: 1.0, clearS: 2.2 },
  { kind: 'bus_auto', share: 0.1, lengthM: 7.0, maxAccel: 1.0, comfortDecel: 1.8, headwayS: 1.5, minGapM: 2.5, speedFactor: 0.85, clearS: 3.0 },
];

/** Simulation time step (s). */
export const STEP_S = 0.25;
const DEFAULT_LANE_WIDTH_M = 3.5;
/** Vehicles fade in over this distance after entering the area and fade out before leaving it. */
export const EDGE_FADE_M = 60;
/** Turns sharper than this slow vehicles to TURN_SPEED_MPS at the junction. */
const TURN_ANGLE_DEG = 35;
const TURN_SPEED_MPS = 4.5;
/** Distance over which vehicles slow down for a turn. */
const TURN_SLOWDOWN_M = 40;
/** A vehicle stopped this long at the front of a queue is removed (gridlock), and counted. */
export const GRIDLOCK_S = 180;
/** A higher-priority vehicle this close in time to the junction makes lower-priority traffic wait. */
const CRITICAL_GAP_S = 3;
/** Traffic that must give way is cleared to cross only from this close to the line. */
const YIELD_LINE_M = 8;
/** Beyond this many vehicles, new arrivals wait at the area edge. */
const MAX_VEHICLES = 5000;
/**
 * OSM junctions are often clusters of nodes a few metres apart. Road stretches
 * shorter than this are folded into one junction (like SUMO's junction joining),
 * so vehicles never queue inside a junction on a link shorter than a car.
 */
export const JOIN_JUNCTION_M = 12;
/** A joined junction never spans more than this, so a dense street is not collapsed into one. */
const MAX_JUNCTION_SPAN_M = 30;

/** Fixed-time signal plan: each of two phase groups gets green, amber, then all-red. */
export const SIGNAL_GREEN_S = 25;
export const SIGNAL_AMBER_S = 3;
export const SIGNAL_ALL_RED_S = 2;
const SIGNAL_CYCLE_S = 2 * (SIGNAL_GREEN_S + SIGNAL_AMBER_S + SIGNAL_ALL_RED_S);
/** Signal heads stand this far beyond the edge of the kerb-side lane (m). */
const SIGNAL_KERB_M = 1.2;
/** A mapped signal this close to a junction controls it (m). */
const SIGNAL_MATCH_M = 35;

/** Assumed saturation flow per lane by road class (veh/h), used to estimate demand at the area edge. */
export const LANE_CAPACITY_VPH: Record<string, number> = { highway: 1800, arterial: 1400, collector: 1000, local: 600 };
const CLASS_RANK: Record<string, number> = { highway: 4, arterial: 3, collector: 2, local: 1 };
/**
 * Focus trips (entry -> selected road -> exit) are drawn mostly from entry and
 * exit pairs for which going via the selected road is about as quick as the
 * fastest route: a detour up to FOCUS_FREE_DETOUR is taken freely, longer ones
 * become rarer, and beyond FOCUS_MAX_DETOUR the pair is not used.
 */
const FOCUS_FREE_DETOUR = 1.15;
const FOCUS_DETOUR_DECAY = 0.2;
const FOCUS_MAX_DETOUR = 2.0;

/**
 * Route choice treats smaller roads as slower than their speed limit (narrow
 * lanes, parked vehicles, a give-way at every junction), so through traffic
 * keeps to main roads as drivers do. Affects routing only, not driving speed.
 */
export const ROUTE_SPEED_FACTOR: Record<string, number> = { highway: 1.0, arterial: 0.9, collector: 0.7, local: 0.45 };

export interface MicroSimOptions {
  /** Demand at the area edge as a share of the entering roads' capacity (0-1). */
  demandLevel: number;
  seed: number;
  /** Roads whose traffic is reported separately (the roads being studied). */
  watchRoadIds?: readonly string[];
  /**
   * Real traffic signal positions (OpenStreetMap). When given, a junction is
   * signalised exactly when a signal stands at it; otherwise signals are
   * estimated from the classes of the roads that meet.
   */
  signalPoints?: readonly (readonly [number, number])[];
  /**
   * Extra trips sent through the watched roads, as a share of their capacity
   * (0 = none). They enter and leave at the area edge like other traffic.
   */
  focusLoad?: number;
}

/** Traffic on the watched roads. */
export interface WatchedRoadMetrics {
  /** Vehicles on them now. */
  onRoad: number;
  /** Vehicles that have used them since the start. */
  passed: number;
  /** Mean speed of the vehicles on them (km/h), null when empty. */
  meanSpeedKmh: number | null;
}

export type SignalState = 'green' | 'amber' | 'red';

export interface MicroSimMetrics {
  timeS: number;
  onNetwork: number;
  waitingToEnter: number;
  completedTrips: number;
  /** Mean speed of vehicles on the network (km/h), null when empty. */
  meanSpeedKmh: number | null;
  /** Mean of (actual ÷ free-flow travel time) over completed trips, null before any. */
  delayIndex: number | null;
  stopsPerTrip: number | null;
  gridlockRemovals: number;
  /** Trips dropped because no route joins their entry and exit. */
  unroutable: number;
  entries: number;
  exits: number;
  signals: number;
  /** Vehicles per hour generated at the area edge at the current demand level. */
  inflowVph: number;
  /** Vehicles per hour sent through the watched roads by the focus load (included in inflowVph). */
  focusVph: number;
  watched: WatchedRoadMetrics;
}

/** Where a vehicle is drawn. One object is reused for every vehicle visited. */
export interface VehicleView {
  id: number;
  kind: VehicleKind;
  lng: number;
  lat: number;
  /** Height of the road surface under the vehicle (m). */
  z: number;
  /** Direction of travel, radians anticlockwise from east. */
  heading: number;
  /** Slope along the direction of travel, radians (positive uphill). */
  pitch: number;
  /** Speed as a share of the speed limit. */
  speedRatio: number;
  /** 0-1: fades in after entering the area and out before leaving it. */
  opacity: number;
  /** Uses a watched road on its route. */
  focus: boolean;
}

interface Link {
  index: number;
  id: string;
  segmentKey: string;
  roadId: string;
  from: string;
  to: string;
  length: number;
  speed: number; // m/s
  rank: number;
  twoWay: boolean;
  /** Vehicles per lane, front (furthest along) first. */
  lanes: Vehicle[][];
  pts: [number, number, number][];
  cum: number[];
  headingStart: number;
  headingEnd: number;
  laneWidth: number;
  /** Half the median width: two-way lanes start this far from the centre line. */
  medianHalf: number;
  /** The drawn road surface is this far above the link's points. */
  surfaceLift: number;
}

interface Vehicle {
  id: number;
  type: VehicleTypeParams;
  /** This driver's desired speed as a multiple of the speed limit. */
  speedFactor: number;
  link: number;
  lane: number;
  pos: number;
  v: number;
  acc: number;
  route: number[];
  routeIdx: number;
  /** Target lane on the next link once cleared to cross the junction. */
  grantLane: number | null;
  departT: number;
  freeFlowS: number;
  waitS: number;
  stops: number;
  wasMoving: boolean;
  /** Has used a watched road. */
  watched: boolean;
  /** Route includes a watched road. */
  focus: boolean;
  /** Distance driven inside the area (m). */
  odo: number;
}

interface Control {
  kind: 'signal' | 'priority';
  /** Signal phase group per incoming link. */
  groups: Map<number, 0 | 1>;
  /** Priority junctions: the main road's class rank, or null when every approach ranks the same. */
  majorRank: number | null;
  offset: number;
  busyUntil: number;
  busyFrom: number;
}

interface Source {
  nodeId: string;
  ratePerS: number;
  nextT: number;
  queue: Vehicle[];
  /** Exits a vehicle entering here can reach inside the area. */
  sinks: Sink[];
}

interface Sink {
  nodeId: string;
  weight: number;
}

/** An entry -> watched link -> exit combination that focus trips are drawn from. */
interface FocusPair {
  source: Source;
  link: number;
  sinkNodeId: string;
}

const segmentKey = (edgeId: string) => edgeId.replace(/_(fwd|bwd)$/, '');
const M_PER_DEG_LAT = 111320;
const mPerDegLng = (lat: number) => M_PER_DEG_LAT * Math.cos((lat * Math.PI) / 180);

/** mulberry32: small, fast, seedable. */
function makeRng(seed: number) {
  let a = seed >>> 0;
  return () => {
    a = (a + 0x6d2b79f5) >>> 0;
    let t = a;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

/** Lane width and half the median width, as the road's 3D mesh lays them out. */
function laneGeometry(road: DrivableObject | undefined): { laneWidth: number; medianHalf: number } {
  if (!road) return { laneWidth: DEFAULT_LANE_WIDTH_M, medianHalf: 0 };
  const section = road.type === 'road' ? (road as RoadObject).sections?.[0] : undefined;
  const laneWidth = section?.carriagewayA?.laneWidth || road.laneWidth || DEFAULT_LANE_WIDTH_M;
  const medianHalf = section ? (section.hasMedian ? (section.medianWidth || 0) / 2 : 0) : road.hasDivider ? (road.dividerWidth || 0) / 2 : 0;
  return { laneWidth, medianHalf };
}

function headingOf(a: readonly number[], b: readonly number[]): number {
  return Math.atan2((b[1] - a[1]) * M_PER_DEG_LAT, (b[0] - a[0]) * mPerDegLng(a[1]));
}

function angleBetweenDeg(a: number, b: number): number {
  let d = Math.abs(a - b) % (2 * Math.PI);
  if (d > Math.PI) d = 2 * Math.PI - d;
  return (d * 180) / Math.PI;
}

/** IDM acceleration towards desired speed v0 with a leader `gap` metres ahead moving at vLead. */
export function idmAcceleration(v: number, v0: number, gap: number, vLead: number, p: VehicleTypeParams): number {
  const sStar = p.minGapM + Math.max(0, v * p.headwayS + (v * (v - vLead)) / (2 * Math.sqrt(p.maxAccel * p.comfortDecel)));
  const acc = p.maxAccel * (1 - Math.pow(v / Math.max(v0, 0.1), 4) - Math.pow(sStar / Math.max(gap, 0.01), 2));
  return Math.max(-9, Math.min(p.maxAccel, acc));
}

export class TrafficMicroSim {
  private readonly links: Link[] = [];
  /** Original network node -> the joined junction it belongs to (absent: its own junction). */
  private readonly junctionOf = new Map<string, string>();
  private readonly junctionMembers = new Map<string, string[]>();
  private readonly linkById = new Map<string, number>();
  private readonly controls = new Map<string, Control>();
  private readonly sources: Source[] = [];
  private readonly sinks: Sink[] = [];
  private readonly subnet: TrafficNetwork;
  /** The study area's own network nodes, before junctions were joined. */
  private readonly areaNodes: ReadonlyMap<string, TrafficNode>;
  private readonly routeCache = new Map<string, { route: number[]; freeFlowS: number } | null>();
  /** Junction id -> number, for the route trees. */
  private readonly nodeIndex = new Map<string, number>();
  private readonly trees: RouteTrees;
  /** Vehicles on the network now (kept up to date rather than counted every step). */
  private onNetworkCount = 0;
  /** Links that have had a vehicle since the last step; only these are visited. */
  private readonly busy = new Set<number>();
  /** Links ending at a signal. */
  private signalLinks: number[] = [];
  private readonly rng: () => number;
  private demandLevel: number;
  private nextId = 1;
  private t = 0;

  private completed = 0;
  private delaySum = 0;
  private stopsSum = 0;
  private gridlockRemovals = 0;
  private unroutable = 0;
  private readonly watchedLinks = new Set<number>();
  private watchedPassed = 0;
  private readonly focusPairs: FocusPair[] = [];
  /** Cumulative pair weights, for drawing a pair in proportion to its weight. */
  private readonly focusCum: number[] = [];
  private focusCapacityVph = 0;
  private focusLoad: number;
  private focusNextT = Infinity;

  constructor(area: StudyArea, roads: ReadonlyMap<string, DrivableObject>, options: MicroSimOptions) {
    this.rng = makeRng(options.seed);
    this.demandLevel = Math.max(0, Math.min(1, options.demandLevel));
    this.focusLoad = Math.max(0, options.focusLoad ?? 0);
    const net = area.network;
    this.areaNodes = net.nodes;
    const included = new Set(area.segments.map(s => s.key));
    const classOf = (roadId: string) => roads.get(roadId)?.roadClass ?? 'local';
    const rankOf = (roadId: string) => CLASS_RANK[classOf(roadId)] ?? 1;

    const areaEdges = [...net.edges.values()].filter(e => included.has(segmentKey(e.id)));
    this.joinJunctions(net, areaEdges);

    // Links: both travel directions of every stretch in the area, except those inside a joined junction
    for (const e of areaEdges) {
      const from = this.junction(e.fromNodeId), to = this.junction(e.toNodeId);
      if (from === to) continue;
      this.linkById.set(e.id, this.links.length);
      this.links.push(this.makeLink(e, this.links.length, rankOf(e.roadId), from, to, roads.get(e.roadId)));
    }

    // The area's graph between junctions, for routing
    const nodes = new Map<string, TrafficNode>();
    const touch = (id: string) => {
      if (!nodes.has(id)) nodes.set(id, { ...net.nodes.get(id)!, id, incomingSegments: [], outgoingSegments: [] });
      return nodes.get(id)!;
    };
    const edges = new Map<string, TrafficEdge>();
    for (const l of this.links) {
      const e = net.edges.get(l.id)!;
      const routeSpeed = (e.speedLimit || 50) * (ROUTE_SPEED_FACTOR[classOf(e.roadId)] ?? 0.45);
      edges.set(l.id, { ...e, fromNodeId: l.from, toNodeId: l.to, speedLimit: routeSpeed });
      touch(l.from).outgoingSegments.push(l.id);
      touch(l.to).incomingSegments.push(l.id);
    }
    this.subnet = { nodes, edges };
    nodes.forEach((_, id) => this.nodeIndex.set(id, this.nodeIndex.size));
    const cost = new Float64Array(this.links.length);
    this.links.forEach((l, i) => {
      const e = edges.get(l.id)!;
      cost[i] = e.length / ((e.speedLimit || 50) / 3.6);
    });
    this.trees = new RouteTrees(
      this.nodeIndex.size,
      Int32Array.from(this.links, l => this.nodeIndex.get(l.from)!),
      Int32Array.from(this.links, l => this.nodeIndex.get(l.to)!),
      cost,
    );

    this.buildControls(options.signalPoints ?? null);
    this.signalLinks = this.links.filter(l => this.controls.get(l.to)?.kind === 'signal').map(l => l.index);
    this.buildSourcesAndSinks(net, included, roads);
    const watch = new Set(options.watchRoadIds ?? []);
    for (const l of this.links) if (watch.has(l.roadId)) this.watchedLinks.add(l.index);
    this.buildFocusDemand(roads);
  }

  /** Counts a vehicle the first time it drives onto a watched road. */
  private noteLink(veh: Vehicle, linkIndex: number) {
    if (!veh.watched && this.watchedLinks.has(linkIndex)) {
      veh.watched = true;
      this.watchedPassed++;
    }
  }

  private junction(nodeId: string): string {
    return this.junctionOf.get(nodeId) ?? nodeId;
  }

  /** Folds nodes joined by very short stretches into single junctions (shortest stretches first). */
  private joinJunctions(net: TrafficNetwork, areaEdges: TrafficEdge[]) {
    const spanM = (ids: string[]) => {
      const cs = ids.map(id => net.nodes.get(id)!.coordinates);
      const lats = cs.map(c => c[1]), lngs = cs.map(c => c[0]);
      const dy = (Math.max(...lats) - Math.min(...lats)) * M_PER_DEG_LAT;
      const dx = (Math.max(...lngs) - Math.min(...lngs)) * mPerDegLng(lats[0]);
      return Math.hypot(dx, dy);
    };
    const short = areaEdges.filter(e => e.length < JOIN_JUNCTION_M).sort((a, b) => a.length - b.length);
    for (const e of short) {
      const a = this.junction(e.fromNodeId), b = this.junction(e.toNodeId);
      if (a === b) continue;
      const merged = [...(this.junctionMembers.get(a) ?? [a]), ...(this.junctionMembers.get(b) ?? [b])];
      if (spanM(merged) > MAX_JUNCTION_SPAN_M) continue;
      this.junctionMembers.set(a, merged);
      this.junctionMembers.delete(b);
      for (const m of merged) this.junctionOf.set(m, a);
    }
  }

  private makeLink(e: TrafficEdge, index: number, rank: number, from: string, to: string, road: DrivableObject | undefined): Link {
    const pts = e.coordinates;
    const cum = [0];
    for (let i = 1; i < pts.length; i++) {
      const dx = (pts[i][0] - pts[i - 1][0]) * mPerDegLng(pts[i - 1][1]);
      const dy = (pts[i][1] - pts[i - 1][1]) * M_PER_DEG_LAT;
      cum.push(cum[i - 1] + Math.hypot(dx, dy));
    }
    return {
      index,
      id: e.id,
      segmentKey: segmentKey(e.id),
      roadId: e.roadId,
      from,
      to,
      length: cum[cum.length - 1],
      speed: Math.max(10, e.speedLimit || 50) / 3.6,
      rank,
      twoWay: e.direction !== 'forward',
      lanes: Array.from({ length: Math.max(1, Math.min(6, e.lanes || 1)) }, () => []),
      pts,
      cum,
      headingStart: headingOf(pts[0], pts[1]),
      headingEnd: headingOf(pts[pts.length - 2], pts[pts.length - 1]),
      ...laneGeometry(road),
      surfaceLift: surfaceLiftM(road),
    };
  }

  /**
   * Junctions with three or more arms get control. Crossroads between roads of
   * collector class or above get a two-phase fixed-time signal (approaches
   * grouped by direction); the rest give way by road class.
   */
  private buildControls(signalPoints: readonly (readonly [number, number])[] | null) {
    const incoming = new Map<string, number[]>();
    const arms = new Map<string, Set<string>>();
    const addArm = (node: string, key: string) => {
      if (!arms.has(node)) arms.set(node, new Set());
      arms.get(node)!.add(key);
    };
    for (const l of this.links) {
      if (!incoming.has(l.to)) incoming.set(l.to, []);
      incoming.get(l.to)!.push(l.index);
      addArm(l.from, l.segmentKey);
      addArm(l.to, l.segmentKey);
    }

    const signalled = signalPoints ? this.junctionsWithSignals(signalPoints, [...incoming.keys()].filter(n => (arms.get(n)?.size ?? 0) >= 3)) : null;

    incoming.forEach((inLinks, nodeId) => {
      const armCount = arms.get(nodeId)?.size ?? 0;
      if (armCount < 3) return;
      const groups = new Map<number, 0 | 1>();
      // Group approaches by axis: within 45° of the first approach's axis, or across it
      const ref = this.links[inLinks[0]].headingEnd;
      for (const i of inLinks) {
        const d = angleBetweenDeg(this.links[i].headingEnd, ref);
        groups.set(i, d < 45 || d > 135 ? 0 : 1);
      }
      if (signalled) {
        // Real signals: two phases, one per axis (both used whenever approaches lie on both)
        const twoPhases = new Set(groups.values()).size === 2;
        if (signalled.has(nodeId) && twoPhases) {
          this.controls.set(nodeId, { kind: 'signal', groups, majorRank: null, offset: this.rng() * SIGNAL_CYCLE_S, busyUntil: 0, busyFrom: -1 });
          return;
        }
      } else if (armCount >= 4) {
        // Signals only where a collector or bigger road runs on both axes; a main
        // road meeting a lane stays a priority junction
        const majorOn = (g: 0 | 1) => inLinks.some(i => groups.get(i) === g && this.links[i].rank >= 2);
        if (majorOn(0) && majorOn(1)) {
          this.controls.set(nodeId, { kind: 'signal', groups, majorRank: null, offset: this.rng() * SIGNAL_CYCLE_S, busyUntil: 0, busyFrom: -1 });
          return;
        }
      }
      const ranks = inLinks.map(i => this.links[i].rank);
      const top = Math.max(...ranks);
      const majorRank = ranks.some(r => r < top) ? top : null;
      this.controls.set(nodeId, { kind: 'priority', groups: new Map(), majorRank, offset: 0, busyUntil: 0, busyFrom: -1 });
    });
  }

  /**
   * Junctions that have a real signal: each signal belongs to the nearest
   * junction within SIGNAL_MATCH_M (OSM often marks signals on the approach,
   * a little before the junction itself).
   */
  private junctionsWithSignals(points: readonly (readonly [number, number])[], junctions: string[]): Set<string> {
    const centres = junctions.map(id => {
      const members = this.junctionMembers.get(id) ?? [id];
      const cs = members.map(m => this.areaNodes.get(m)!.coordinates);
      return { id, lng: cs.reduce((a, c) => a + c[0], 0) / cs.length, lat: cs.reduce((a, c) => a + c[1], 0) / cs.length };
    });
    const out = new Set<string>();
    for (const [lng, lat] of points) {
      const kx = mPerDegLng(lat);
      let best: string | null = null;
      let bestD = SIGNAL_MATCH_M;
      for (const c of centres) {
        const d = Math.hypot((c.lng - lng) * kx, (c.lat - lat) * M_PER_DEG_LAT);
        if (d < bestD) {
          bestD = d;
          best = c.id;
        }
      }
      if (best) out.add(best);
    }
    return out;
  }

  /**
   * Traffic enters where roads outside the area lead in, and leaves where the
   * area's roads lead out. Entry flow is the entering roads' lane capacity
   * times the demand level; exits are chosen in proportion to their capacity.
   */
  private buildSourcesAndSinks(net: TrafficNetwork, included: Set<string>, roads: ReadonlyMap<string, DrivableObject>) {
    const laneCapacity = (e: TrafficEdge) => LANE_CAPACITY_VPH[roads.get(e.roadId)?.roadClass ?? 'local'] ?? 600;
    // Outside roads at any node of a (joined) junction count; not those wholly inside it
    const outsideVph = (junctionId: string, dir: 'incomingSegments' | 'outgoingSegments') => {
      let vph = 0;
      for (const nodeId of this.junctionMembers.get(junctionId) ?? [junctionId]) {
        for (const id of net.nodes.get(nodeId)?.[dir] ?? []) {
          const e = net.edges.get(id);
          if (!e || included.has(segmentKey(id))) continue;
          if (this.junction(e.fromNodeId) === this.junction(e.toNodeId)) continue;
          vph += Math.max(1, e.lanes) * laneCapacity(e);
        }
      }
      return vph;
    };
    this.subnet.nodes.forEach((node, nodeId) => {
      const inVph = outsideVph(nodeId, 'incomingSegments');
      const outVph = outsideVph(nodeId, 'outgoingSegments');
      if (inVph > 0 && node.outgoingSegments.length > 0) {
        this.sources.push({ nodeId, ratePerS: inVph / 3600, nextT: 0, queue: [], sinks: [] });
      }
      if (outVph > 0 && node.incomingSegments.length > 0) this.sinks.push({ nodeId, weight: outVph });
    });
    // Near the area edge, a pocket of streets may join the rest only through
    // roads outside the range. Its traffic can use only the exits it reaches;
    // an entry that reaches none generates no traffic.
    for (const s of this.sources) {
      s.sinks = this.sinks.filter(k => k.nodeId !== s.nodeId && this.travelTime(s.nodeId, k.nodeId) < Infinity);
      if (s.sinks.length === 0) s.ratePerS = 0;
      s.nextT = this.nextArrival(s, 0);
    }
  }

  /** Fastest travel time between two junctions, as route choice sees it (Infinity when unconnected). */
  private travelTime(fromNode: string, toNode: string): number {
    return this.trees.timeBetween(this.nodeIndex.get(fromNode)!, this.nodeIndex.get(toNode)!);
  }

  /**
   * Focus trips: entry -> watched road -> exit. Their rate is the watched
   * roads' capacity times the focus load. Each trip draws an entry, a direction
   * on the watched road and an exit, favouring combinations for which the
   * watched road is on or near the fastest way through (select-link traffic).
   */
  private buildFocusDemand(roads: ReadonlyMap<string, DrivableObject>) {
    if (this.watchedLinks.size === 0) return;
    // Capacity: per watched road and travel direction, its widest stretch
    const lanesBy = new Map<string, { roadId: string; lanes: number }>();
    for (const i of this.watchedLinks) {
      const l = this.links[i];
      const key = `${l.roadId}|${l.id.endsWith('_bwd') ? 'bwd' : 'fwd'}`;
      lanesBy.set(key, { roadId: l.roadId, lanes: Math.max(lanesBy.get(key)?.lanes ?? 0, l.lanes.length) });
    }
    lanesBy.forEach(({ roadId, lanes }) => {
      this.focusCapacityVph += lanes * (LANE_CAPACITY_VPH[roads.get(roadId)?.roadClass ?? 'local'] ?? 600);
    });

    const linkTime = (i: number) => {
      const e = this.subnet.edges.get(this.links[i].id)!;
      return e.length / ((e.speedLimit || 50) / 3.6);
    };

    // Travel times come from the route trees: one per exit and per watched link start
    const pairs: FocusPair[] = [];
    const weights: number[] = [];
    const fallbackWeights: number[] = [];
    for (const source of this.sources) {
      if (source.sinks.length === 0) continue;
      for (const i of this.watchedLinks) {
        const toLink = this.travelTime(source.nodeId, this.links[i].from);
        if (toLink === Infinity) continue;
        for (const sink of source.sinks) {
          const onward = this.travelTime(this.links[i].to, sink.nodeId);
          const direct = this.travelTime(source.nodeId, sink.nodeId);
          if (onward === Infinity || direct === Infinity) continue;
          const detour = (toLink + linkTime(i) + onward) / Math.max(direct, 1);
          const w = source.ratePerS * sink.weight;
          pairs.push({ source, link: i, sinkNodeId: sink.nodeId });
          weights.push(detour > FOCUS_MAX_DETOUR ? 0 : w * Math.exp(-Math.max(0, detour - FOCUS_FREE_DETOUR) / FOCUS_DETOUR_DECAY));
          fallbackWeights.push(w / (detour * detour));
        }
      }
    }
    // Where no combination passes near the watched road, any that can reach it will do
    const use = weights.some(w => w > 0) ? weights : fallbackWeights;
    let total = 0;
    for (let k = 0; k < pairs.length; k++) {
      if (use[k] <= 0) continue;
      total += use[k];
      this.focusPairs.push(pairs[k]);
      this.focusCum.push(total);
    }
    this.focusNextT = this.nextFocusArrival(0);
  }

  private get focusRatePerS(): number {
    return this.focusPairs.length > 0 ? (this.focusCapacityVph * this.focusLoad) / 3600 : 0;
  }

  private nextFocusArrival(from: number): number {
    const rate = this.focusRatePerS;
    return rate > 0 ? from - Math.log(1 - this.rng()) / rate : Infinity;
  }

  /** Sets the focus load (share of the watched roads' capacity sent through them). */
  public setFocusLoad(load: number) {
    this.focusLoad = Math.max(0, load);
    this.focusNextT = this.nextFocusArrival(this.t);
  }

  private spawnFocusTrip() {
    const r = this.rng() * this.focusCum[this.focusCum.length - 1];
    let lo = 0, hi = this.focusCum.length - 1;
    while (lo < hi) {
      const mid = (lo + hi) >> 1;
      if (this.focusCum[mid] < r) lo = mid + 1;
      else hi = mid;
    }
    const { source, link, sinkNodeId } = this.focusPairs[lo];
    const l = this.links[link];
    const before = this.route(source.nodeId, l.from);
    const after = this.route(l.to, sinkNodeId);
    if (!before || !after) {
      this.unroutable++;
      return;
    }
    this.queueVehicle(source, [...before.route, link, ...after.route], before.freeFlowS + l.length / l.speed + after.freeFlowS, this.pickType());
  }

  private nextArrival(source: Source, from: number): number {
    const rate = source.ratePerS * this.demandLevel;
    if (rate <= 0) return Infinity;
    return from - Math.log(1 - this.rng()) / rate; // Poisson arrivals
  }

  public setDemandLevel(level: number) {
    this.demandLevel = Math.max(0, Math.min(1, level));
    for (const s of this.sources) s.nextT = this.nextArrival(s, this.t);
  }

  public get timeS(): number {
    return this.t;
  }

  private route(fromNode: string, toNode: string) {
    const key = `${fromNode}>${toNode}`;
    if (!this.routeCache.has(key)) {
      // A focus trip may enter right at the watched road, or leave right after it: an empty leg
      const from = this.nodeIndex.get(fromNode), to = this.nodeIndex.get(toNode);
      const route = from === undefined || to === undefined ? null : this.trees.path(from, to);
      if (!route) {
        this.routeCache.set(key, null);
      } else {
        const freeFlowS = route.reduce((s, i) => s + this.links[i].length / this.links[i].speed, 0);
        this.routeCache.set(key, { route, freeFlowS });
      }
    }
    return this.routeCache.get(key)!;
  }

  private pickType(): VehicleTypeParams {
    let r = this.rng();
    for (const t of VEHICLE_TYPES) {
      if ((r -= t.share) <= 0) return t;
    }
    return VEHICLE_TYPES[VEHICLE_TYPES.length - 1];
  }

  /** Creates a vehicle waiting to enter at `fromNode`, bound for `toNode`. Returns false if unroutable. */
  public spawnVehicle(fromNodeId: string, toNodeId: string, kind?: VehicleKind): boolean {
    const fromNode = this.junction(fromNodeId), toNode = this.junction(toNodeId);
    const source = this.sources.find(s => s.nodeId === fromNode) ?? this.addSource(fromNode);
    const r = this.route(fromNode, toNode);
    if (!r) {
      this.unroutable++;
      return false;
    }
    if (r.route.length === 0) {
      this.unroutable++;
      return false;
    }
    this.queueVehicle(source, r.route, r.freeFlowS, kind ? VEHICLE_TYPES.find(t => t.kind === kind)! : this.pickType());
    return true;
  }

  private queueVehicle(source: Source, route: number[], freeFlowS: number, type: VehicleTypeParams) {
    source.queue.push({
      id: this.nextId++,
      type,
      // Desired speeds vary a little between drivers
      speedFactor: type.speedFactor * (0.9 + 0.2 * this.rng()),
      link: route[0],
      lane: 0,
      pos: 0,
      v: 0,
      acc: 0,
      route,
      routeIdx: 0,
      grantLane: null,
      departT: this.t,
      freeFlowS,
      waitS: 0,
      stops: 0,
      wasMoving: false,
      watched: false,
      focus: route.some(i => this.watchedLinks.has(i)),
      odo: 0,
    });
  }

  private addSource(nodeId: string): Source {
    const s: Source = { nodeId, ratePerS: 0, nextT: Infinity, queue: [], sinks: [] };
    this.sources.push(s);
    return s;
  }

  private pickSink(source: Source): string | null {
    const options = source.sinks;
    const total = options.reduce((a, s) => a + s.weight, 0);
    if (total <= 0) return null;
    let r = this.rng() * total;
    for (const s of options) {
      if ((r -= s.weight) <= 0) return s.nodeId;
    }
    return options[options.length - 1].nodeId;
  }

  private spawnDue() {
    for (const s of this.sources) {
      while (s.nextT <= this.t) {
        s.nextT = this.nextArrival(s, s.nextT);
        const to = this.pickSink(s);
        if (to) this.spawnVehicle(s.nodeId, to);
      }
    }
    while (this.focusNextT <= this.t) {
      this.focusNextT = this.nextFocusArrival(this.focusNextT);
      this.spawnFocusTrip();
    }
  }

  /** Space from the start of a lane to the back of its last vehicle. */
  private backSpace(lane: Vehicle[]): number {
    const last = lane[lane.length - 1];
    return last ? last.pos - last.type.lengthM : Infinity;
  }

  private bestLane(link: Link): number {
    let best = 0;
    for (let i = 1; i < link.lanes.length; i++) {
      if (this.backSpace(link.lanes[i]) > this.backSpace(link.lanes[best])) best = i;
    }
    return best;
  }

  private insertQueued() {
    let onNetwork = this.onNetworkCount;
    for (const s of this.sources) {
      while (s.queue.length > 0 && onNetwork < MAX_VEHICLES) {
        const veh = s.queue[0];
        const link = this.links[veh.link];
        const lane = this.bestLane(link);
        const last = link.lanes[lane][link.lanes[lane].length - 1];
        const v0 = link.speed * veh.speedFactor;
        const entryV = Math.min(v0, last ? last.v : v0);
        const needed = veh.type.minGapM + entryV * veh.type.headwayS * 0.5;
        if (this.backSpace(link.lanes[lane]) < needed) break;
        s.queue.shift();
        veh.lane = lane;
        veh.v = entryV;
        veh.wasMoving = entryV > 2;
        link.lanes[lane].push(veh);
        this.busy.add(link.index);
        this.noteLink(veh, veh.link);
        onNetwork++;
        this.onNetworkCount++;
      }
    }
  }

  public signalState(linkIndex: number): SignalState | null {
    const link = this.links[linkIndex];
    const c = this.controls.get(link.to);
    if (!c || c.kind !== 'signal') return null;
    const group = c.groups.get(linkIndex) ?? 0;
    const half = SIGNAL_GREEN_S + SIGNAL_AMBER_S + SIGNAL_ALL_RED_S;
    const tc = (this.t + c.offset) % SIGNAL_CYCLE_S;
    const local = group === 0 ? tc : (tc - half + SIGNAL_CYCLE_S) % SIGNAL_CYCLE_S;
    if (local < SIGNAL_GREEN_S) return 'green';
    if (local < SIGNAL_GREEN_S + SIGNAL_AMBER_S) return 'amber';
    return 'red';
  }

  /** Whether the front vehicle of a lane may cross into its next link; reserves the junction if so. */
  private tryGrant(veh: Vehicle, link: Link, dist: number) {
    const next = this.links[veh.route[veh.routeIdx + 1]];
    const lane = this.bestLane(next);
    // Never enter a junction without room on the far side
    if (this.backSpace(next.lanes[lane]) < veh.type.lengthM + veh.type.minGapM) return;

    const c = this.controls.get(link.to);
    if (c?.kind === 'signal') {
      const state = this.signalState(link.index);
      const canStop = dist > (veh.v * veh.v) / (2 * veh.type.comfortDecel);
      if (state === 'red' || (state === 'amber' && canStop)) return;
    } else if (c?.kind === 'priority') {
      // Everyone waits for a vehicle from another approach that is crossing
      if (c.busyUntil > this.t && c.busyFrom !== link.index) return;
      // The main road keeps going; it only waited for a side-road vehicle already crossing
      if (c.majorRank !== null && link.rank === c.majorRank) {
        veh.grantLane = lane;
        return;
      }
      // Side roads, and junctions of equal roads, edge up to the line first
      if (dist > YIELD_LINE_M) return;
      // Give way to higher-class approaches with a vehicle about to arrive: one
      // cleared to cross, or moving and close. A queued, stopped vehicle there
      // does not hold up the side road (it claims the junction once it moves).
      for (const [otherIdx] of this.incomingOf(link.to)) {
        if (otherIdx === link.index) continue;
        const other = this.links[otherIdx];
        if (other.rank <= link.rank) continue;
        for (const l of other.lanes) {
          const front = l[0];
          if (!front) continue;
          if (front.grantLane !== null) return;
          if (front.v >= 0.5 && (other.length - front.pos) / front.v < CRITICAL_GAP_S) return;
        }
      }
      const timeToJunction = dist / Math.max(veh.v, 1);
      c.busyUntil = this.t + timeToJunction + veh.type.clearS;
      c.busyFrom = link.index;
    }
    veh.grantLane = lane;
  }

  private incomingCache = new Map<string, [number, Link][]>();
  private incomingOf(nodeId: string): [number, Link][] {
    let list = this.incomingCache.get(nodeId);
    if (!list) {
      list = this.links.filter(l => l.to === nodeId).map(l => [l.index, l] as [number, Link]);
      this.incomingCache.set(nodeId, list);
    }
    return list;
  }

  private desiredSpeed(veh: Vehicle, link: Link, dist: number): number {
    const v0 = link.speed * veh.speedFactor;
    if (veh.routeIdx >= veh.route.length - 1 || dist > TURN_SLOWDOWN_M) return v0;
    const next = this.links[veh.route[veh.routeIdx + 1]];
    if (angleBetweenDeg(link.headingEnd, next.headingStart) < TURN_ANGLE_DEG) return v0;
    return Math.min(v0, TURN_SPEED_MPS + (dist / TURN_SLOWDOWN_M) * (v0 - TURN_SPEED_MPS));
  }

  /** Advances the simulation by one step. */
  public step() {
    const dt = STEP_S;
    this.spawnDue();
    this.insertQueued();
    const active = this.activeLinks();

    // 1. Front vehicles near a junction ask to cross
    for (const link of active) {
      for (const lane of link.lanes) {
        const veh = lane[0];
        if (!veh || veh.grantLane !== null || veh.routeIdx >= veh.route.length - 1) continue;
        const dist = link.length - veh.pos;
        if (dist <= (veh.v * veh.v) / (2 * veh.type.comfortDecel) + 15) this.tryGrant(veh, link, dist);
      }
    }

    // 2. Accelerations from the current state
    for (const link of active) {
      for (const lane of link.lanes) {
        for (let i = 0; i < lane.length; i++) {
          const veh = lane[i];
          const dist = link.length - veh.pos;
          let gap: number;
          let vLead: number;
          if (i > 0) {
            const lead = lane[i - 1];
            gap = lead.pos - lead.type.lengthM - veh.pos;
            vLead = lead.v;
          } else if (veh.routeIdx >= veh.route.length - 1) {
            gap = 1e6; // leaves the area at the end of this link
            vLead = veh.v;
          } else if (veh.grantLane === null) {
            gap = dist - 0.3; // stop line
            vLead = 0;
          } else {
            const next = this.links[veh.route[veh.routeIdx + 1]];
            const last = next.lanes[veh.grantLane][next.lanes[veh.grantLane].length - 1];
            gap = last ? dist + last.pos - last.type.lengthM : dist + 200;
            vLead = last ? last.v : veh.v;
          }
          veh.acc = idmAcceleration(veh.v, this.desiredSpeed(veh, link, dist), gap, vLead, veh.type);
        }
      }
    }

    // 3. Move, front to back, never through the vehicle or stop line ahead
    for (const link of active) {
      for (const lane of link.lanes) {
        for (let i = 0; i < lane.length; i++) {
          const veh = lane[i];
          let v = Math.max(0, veh.v + veh.acc * dt);
          let pos = veh.pos + Math.max(0, ((veh.v + v) / 2) * dt);
          let limit = Infinity;
          if (i > 0) {
            const lead = lane[i - 1];
            limit = lead.pos - lead.type.lengthM - 0.2;
            if (pos > limit) v = Math.min(v, lead.v);
          } else if (veh.routeIdx < veh.route.length - 1 && veh.grantLane === null) {
            limit = link.length - 0.1;
            if (pos > limit) v = 0;
          }
          if (pos > limit) pos = Math.max(veh.pos, limit);
          veh.v = v;
          veh.odo += pos - veh.pos;
          veh.pos = pos;
          this.trackWaiting(veh, dt);
        }
      }
    }

    // 4. Cross junctions, leave the area, clear gridlock
    for (const link of active) {
      for (const lane of link.lanes) {
        const veh = lane[0];
        if (!veh) continue;
        if (veh.pos >= link.length) {
          if (veh.routeIdx >= veh.route.length - 1) {
            lane.shift();
            this.onNetworkCount--;
            this.finishTrip(veh);
          } else {
            this.crossJunction(veh, link, lane);
          }
        } else if (veh.waitS > GRIDLOCK_S) {
          lane.shift();
          this.onNetworkCount--;
          this.gridlockRemovals++;
        }
      }
    }

    this.t += dt;
  }

  /** Links with vehicles on them, in link order; links that have emptied are dropped. */
  private activeLinks(): Link[] {
    const out: Link[] = [];
    for (const i of this.busy) {
      const l = this.links[i];
      if (l.lanes.some(lane => lane.length > 0)) out.push(l);
      else this.busy.delete(i);
    }
    return out.sort((a, b) => a.index - b.index);
  }

  private trackWaiting(veh: Vehicle, dt: number) {
    if (veh.v < 0.3) {
      veh.waitS += dt;
      if (veh.wasMoving) {
        veh.stops++;
        veh.wasMoving = false;
      }
    } else {
      veh.waitS = 0;
      if (veh.v > 2) veh.wasMoving = true;
    }
  }

  private crossJunction(veh: Vehicle, link: Link, lane: Vehicle[]) {
    const nextIdx = veh.route[veh.routeIdx + 1];
    const next = this.links[nextIdx];
    const target = next.lanes[veh.grantLane ?? this.bestLane(next)];
    const overflow = veh.pos - link.length;
    const room = this.backSpace(target) - 0.2;
    if (room < 0) {
      // Another vehicle took the space this step: wait at the stop line
      veh.pos = link.length - 0.1;
      veh.v = 0;
      veh.grantLane = null;
      return;
    }
    lane.shift();
    veh.link = nextIdx;
    veh.lane = next.lanes.indexOf(target);
    veh.pos = Math.min(overflow, room);
    veh.routeIdx++;
    veh.grantLane = null;
    target.push(veh);
    this.busy.add(nextIdx);
    this.noteLink(veh, nextIdx);
  }

  private finishTrip(veh: Vehicle) {
    this.completed++;
    this.delaySum += (this.t - veh.departT) / Math.max(veh.freeFlowS, 1);
    this.stopsSum += veh.stops;
  }

  public getMetrics(): MicroSimMetrics {
    let n = 0;
    let speedSum = 0;
    let onWatched = 0;
    let watchedSpeedSum = 0;
    for (const i of this.busy) {
      const l = this.links[i];
      const watched = this.watchedLinks.has(l.index);
      for (const lane of l.lanes) {
        for (const v of lane) {
          n++;
          speedSum += v.v;
          if (watched) {
            onWatched++;
            watchedSpeedSum += v.v;
          }
        }
      }
    }
    return {
      timeS: this.t,
      onNetwork: n,
      waitingToEnter: this.sources.reduce((a, s) => a + s.queue.length, 0),
      completedTrips: this.completed,
      meanSpeedKmh: n > 0 ? (speedSum / n) * 3.6 : null,
      delayIndex: this.completed > 0 ? this.delaySum / this.completed : null,
      stopsPerTrip: this.completed > 0 ? this.stopsSum / this.completed : null,
      gridlockRemovals: this.gridlockRemovals,
      unroutable: this.unroutable,
      entries: this.sources.filter(s => s.ratePerS > 0).length,
      exits: this.sinks.length,
      signals: [...this.controls.values()].filter(c => c.kind === 'signal').length,
      inflowVph: Math.round((this.sources.reduce((a, s) => a + s.ratePerS, 0) * this.demandLevel + this.focusRatePerS) * 3600),
      focusVph: Math.round(this.focusRatePerS * 3600),
      watched: {
        onRoad: onWatched,
        passed: this.watchedPassed,
        meanSpeedKmh: onWatched > 0 ? (watchedSpeedSum / onWatched) * 3.6 : null,
      },
    };
  }

  /** Mean speed as a share of the speed limit per road stretch with vehicles on it. */
  public segmentSpeedRatios(): Map<string, number> {
    const sums = new Map<string, [number, number]>();
    for (const i of this.busy) {
      const l = this.links[i];
      for (const lane of l.lanes) {
        for (const v of lane) {
          const s = sums.get(l.segmentKey) ?? [0, 0];
          s[0] += Math.min(1, v.v / l.speed);
          s[1]++;
          sums.set(l.segmentKey, s);
        }
      }
    }
    const out = new Map<string, number>();
    sums.forEach(([sum, n], key) => out.set(key, sum / n));
    return out;
  }

  /**
   * Where a point `pos` metres along a link lies, in its lane, with the
   * direction and slope of the road there. Writes into `out`.
   */
  private place<T extends { lng: number; lat: number; z: number; heading: number; pitch: number }>(link: Link, lane: number, pos: number, out: T): T {
    const { pts, cum } = link;
    let i = 1;
    while (i < cum.length - 1 && cum[i] < pos) i++;
    const a = pts[i - 1], b = pts[i];
    const segLen = cum[i] - cum[i - 1];
    const t = segLen > 0 ? Math.max(0, Math.min(1, (pos - cum[i - 1]) / segLen)) : 0;
    const lat = a[1] + t * (b[1] - a[1]);
    const kx = mPerDegLng(lat);
    const dx = (b[0] - a[0]) * kx, dy = (b[1] - a[1]) * M_PER_DEG_LAT, dz = (b[2] || 0) - (a[2] || 0);
    const len = Math.hypot(dx, dy) || 1;
    // Left of the direction of travel (India drives on the left), lanes as the road mesh draws them
    const n = link.lanes.length;
    const offset = link.twoWay ? link.medianHalf + (lane + 0.5) * link.laneWidth : (lane - (n - 1) / 2) * link.laneWidth;
    out.lng = a[0] + t * (b[0] - a[0]) + ((-dy / len) * offset) / kx;
    out.lat = lat + ((dx / len) * offset) / M_PER_DEG_LAT;
    out.z = (a[2] || 0) + t * dz + link.surfaceLift;
    out.heading = Math.atan2(dy, dx);
    out.pitch = Math.atan2(dz, len);
    return out;
  }

  private readonly view: VehicleView = { id: 0, kind: 'car', lng: 0, lat: 0, z: 0, heading: 0, pitch: 0, speedRatio: 0, opacity: 1, focus: false };

  /**
   * Visits every vehicle on the network. `aheadS` (simulated seconds since the
   * last step) carries each vehicle on at its current speed so drawing between
   * steps is smooth, never past the vehicle or stop line ahead of it.
   */
  public forEachVehicle(visit: (vehicle: Readonly<VehicleView>) => void, aheadS = 0) {
    const view = this.view;
    for (const i of this.busy) {
      const l = this.links[i];
      for (let li = 0; li < l.lanes.length; li++) {
        const lane = l.lanes[li];
        for (let k = 0; k < lane.length; k++) {
          const v = lane[k];
          const exiting = v.routeIdx >= v.route.length - 1;
          const limit = k > 0
            ? lane[k - 1].pos - lane[k - 1].type.lengthM - 0.2
            : !exiting && v.grantLane === null ? l.length - 0.1 : l.length;
          const extra = Math.max(0, Math.min(v.v * aheadS, limit - v.pos));
          const pos = v.pos + extra;
          this.place(l, li, Math.max(0, pos - v.type.lengthM / 2), view);
          view.id = v.id;
          view.kind = v.type.kind;
          view.speedRatio = Math.min(1, v.v / l.speed);
          view.opacity = Math.max(0, Math.min(1, (v.odo + extra) / EDGE_FADE_M, exiting ? (l.length - pos) / EDGE_FADE_M : 1));
          view.focus = v.focus;
          visit(view);
        }
      }
    }
  }

  /** Where a signal head stands. */
  public static readonly SIGNAL_KERB_M = 1.2;

  /**
   * Signal heads: one per signalised approach, on the kerb beside its stop
   * line, with the approach's direction of travel.
   */
  public forEachSignal(visit: (linkId: string, at: { lng: number; lat: number; z: number; heading: number }, state: SignalState) => void) {
    const at = { lng: 0, lat: 0, z: 0, heading: 0, pitch: 0 };
    for (const i of this.signalLinks) {
      const l = this.links[i];
      const state = this.signalState(l.index);
      if (!state) continue;
      // Outermost lane (the kerb side), then on past its edge
      this.place(l, l.lanes.length - 1, Math.max(0, l.length - 2), at);
      const side = l.laneWidth / 2 + SIGNAL_KERB_M;
      const lat = at.lat;
      at.lng += (-Math.sin(at.heading) * side) / mPerDegLng(lat);
      at.lat += (Math.cos(at.heading) * side) / M_PER_DEG_LAT;
      visit(l.id, at, state);
    }
  }

  /** Test hook: vehicles per link id and lane, front first. */
  public debugLanes(): Map<string, { id: number; pos: number; v: number; length: number; kind: VehicleKind }[][]> {
    const out = new Map<string, { id: number; pos: number; v: number; length: number; kind: VehicleKind }[][]>();
    for (const l of this.links) {
      out.set(l.id, l.lanes.map(lane => lane.map(v => ({ id: v.id, pos: v.pos, v: v.v, length: v.type.lengthM, kind: v.type.kind }))));
    }
    return out;
  }

  /** Signal state for an approach, by link id (null when not signalised). */
  public signalStateOf(linkId: string): SignalState | null {
    const i = this.linkById.get(linkId);
    return i === undefined ? null : this.signalState(i);
  }

  public linkLength(linkId: string): number | undefined {
    const i = this.linkById.get(linkId);
    return i === undefined ? undefined : this.links[i].length;
  }

  public getSourceNodes(): string[] {
    return this.sources.map(s => s.nodeId);
  }

  public getSinkNodes(): string[] {
    return this.sinks.map(s => s.nodeId);
  }
}

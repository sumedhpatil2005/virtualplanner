import type { TrafficNetwork, TrafficEdge, TrafficNode } from '../objects/trafficTypes';
import type { RoadObject, JunctionObject } from '../objects/types';
import { websterTiming, indoHcmSaturationFlow, type WebsterResult } from './signalTiming';
import { surfaceLiftM } from '../objects/roadSurface';
import type { StudyArea, DrivableObject } from './StudyAreaExplorer';
import { RouteTrees } from './routeTrees';
import { isAccessRestricted, RESTRICTED_ENTRY_S } from './accessRestriction';
import { makeLaneConnector, sampleLaneConnector, connectorsConflict, type LaneConnector, type LanePose } from './LaneConnector';
import { layoutZone, turnBetween, movementKey, type CountZone, type LinkEnds, type ZoneLayout } from '../calibration/junctionMovements';
import type { Cardinal } from '../calibration/observedCounts';

/**
 * Microscopic traffic simulation on a study area.
 *
 * Every vehicle follows the Intelligent Driver Model (IDM): it accelerates
 * towards its desired speed and brakes for whatever is ahead (another vehicle,
 * a red light, a junction it must give way at). Links keep their real lane
 * counts, so widening a road adds capacity. Traffic drives on the left.
 *
 * Deterministic for a given seed: all randomness comes from seeded RNGs. Explicit OD
 * streams (arrivals and their drivers) and signal offsets each have their own
 * stream keyed by identity (streamRng), so a baseline and a proposal share them.
 * No rendering here; see MicroTrafficVisualizer.
 */

/** Vehicle classes. `bus_auto` is the legacy combined class kept so older saved plans still run. */
export type VehicleKind = 'two_wheeler' | 'car' | 'auto' | 'bus' | 'truck' | 'bus_auto';

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
  /** Passenger car units (IRC:106-1990, as tabulated in Pune CMP 2008 Table 4). */
  pcu: number;
}

/**
 * Vehicle classes for Indian mixed traffic.
 *
 * IDM parameters (length, time headway T, standstill gap s0, acceleration a,
 * comfortable deceleration b) for motorcycle, car, auto-rickshaw and bus are
 * the calibrated values for Chennai mixed traffic in Kanagaraj & Treiber (2018),
 * "Self-driven particle model for mixed traffic and other disordered flows",
 * Physica A 509:1-11, Table 1 (doi:10.1016/j.physa.2018.05.086). Trucks are not
 * in that table: they use the bus values with an 8 m length (assumption).
 *
 * Shares (for capacity-based synthetic traffic) are the Gunjan Chowk, Pune
 * classified counts, 08-20 h both directions (Thakur et al. 2017, IJETT 47(2)):
 * two-wheelers 52.0%, cars 31.2%, autos 11.2%, buses 3.5%, goods vehicles 2.1%.
 * Desired-speed factors and junction clearing times are model assumptions.
 */
export const VEHICLE_TYPES: readonly VehicleTypeParams[] = [
  { kind: 'two_wheeler', share: 0.520, lengthM: 1.8, maxAccel: 2.0, comfortDecel: 2.0, headwayS: 0.3, minGapM: 0.5, speedFactor: 1.05, clearS: 1.5, pcu: 0.75 },
  { kind: 'car', share: 0.312, lengthM: 4.2, maxAccel: 1.0, comfortDecel: 1.0, headwayS: 0.8, minGapM: 2.0, speedFactor: 1.0, clearS: 2.2, pcu: 1.0 },
  { kind: 'auto', share: 0.112, lengthM: 2.6, maxAccel: 1.0, comfortDecel: 1.0, headwayS: 1.0, minGapM: 2.0, speedFactor: 0.8, clearS: 2.0, pcu: 2.0 },
  { kind: 'bus', share: 0.035, lengthM: 10.3, maxAccel: 1.0, comfortDecel: 1.0, headwayS: 1.0, minGapM: 2.0, speedFactor: 0.85, clearS: 3.5, pcu: 2.2 },
  { kind: 'truck', share: 0.021, lengthM: 8.0, maxAccel: 1.0, comfortDecel: 1.0, headwayS: 1.0, minGapM: 2.0, speedFactor: 0.8, clearS: 3.5, pcu: 2.2 },
  { kind: 'bus_auto', share: 0, lengthM: 7.0, maxAccel: 1.0, comfortDecel: 1.0, headwayS: 1.0, minGapM: 2.0, speedFactor: 0.85, clearS: 3.0, pcu: 2.0 },
];

/**
 * Critical gaps for giving way (s): Indo-HCM 2017 (CSIR-CRRI) base critical gap
 * for the major-road right turn (movement 1) 2.70 s and the minor-road right turn
 * (movement 7) 3.80 s, as tabulated in "Traffic congestion analysis using
 * Indo-HCM, IRC method..." (IJRESM, journal.ijresm.com, Table 4). Minor-road
 * through and left movements use the minor right-turn value (assumption: the
 * manual's OTM values for them were not available).
 */
export const CRITICAL_GAP_MAJOR_RIGHT_S = 2.7;
export const CRITICAL_GAP_MINOR_S = 3.8;
/**
 * Impatience: drivers who have waited at the front of their queue accept
 * shorter gaps (Mahmassani & Sheffi 1981; Kittelson & Vandehey 1991, TRR 1320:
 * critical gap falling from about 6 s to 3-4 s over 0-40 s of front-of-queue
 * delay). Here the critical gap falls linearly over IMPATIENCE_RAMP_S of
 * standing at the line to a floor: 3.0 s from a minor road (Indian minor-road
 * right turns: 2.8-3.7 s, Kanagaraj-type limited-priority studies, e.g. IATSS
 * Research 2016, doi:10.1016/j.iatssr.2015.12.002) and 2.4 s for a right turn
 * across oncoming traffic (same study: 2.4-3.1 s). The ramp length and the
 * linear shape are estimates. A gap is still required: nobody enters in front
 * of a vehicle closer than the floor, and nobody enters while a conflicting
 * vehicle is in the junction.
 */
export const CRITICAL_GAP_MINOR_FLOOR_S = 3.0;
export const CRITICAL_GAP_MAJOR_RIGHT_FLOOR_S = 2.4;
export const IMPATIENCE_RAMP_S = 40;
/** Critical gap (s) for a driver who has stood `waitS` at the line. */
export function criticalGap(minor: boolean, waitS: number): number {
  const base = minor ? CRITICAL_GAP_MINOR_S : CRITICAL_GAP_MAJOR_RIGHT_S;
  const floor = minor ? CRITICAL_GAP_MINOR_FLOOR_S : CRITICAL_GAP_MAJOR_RIGHT_FLOOR_S;
  return base - (base - floor) * Math.min(1, Math.max(0, waitS) / IMPATIENCE_RAMP_S);
}
/** Vehicles stuck this long at a junction with nothing crossing it count as a deadlock. */
export const DEADLOCK_S = 60;

/** Simulation time step (s). */
export const STEP_S = 0.25;
/** Vehicles per lane that may hold a grant to cross at once (the front one and the platoon behind it). */
const PLATOON_GRANTS = 6;
/** A next lane whose last vehicle is slower than this (m/s) and not speeding up counts as blocked when choosing a lane. */
const BLOCKED_TAIL_MPS = 1;
/** Speeding up faster than this (m/s²), a slow tail is pulling away rather than blocked. */
const PULLING_AWAY_MPS2 = 0.2;
/**
 * Whether the rear of a lane is moving off: one of its last three vehicles is
 * above walking pace or speeding up. One rider braking hard behind the vehicle
 * it has just followed across (a pair entering side by side) does not make the
 * lane blocked while the vehicles ahead of it pull away.
 */
const rearMoving = (lane: readonly { v: number; acc: number }[]) => {
  for (let k = lane.length - 1; k >= Math.max(0, lane.length - 3); k--) if (lane[k].v > BLOCKED_TAIL_MPS || lane[k].acc > PULLING_AWAY_MPS2) return true;
  return false;
};
/**
 * Lateral offset from the lane centre of each rider of a two-wheeler pair riding
 * abreast: 0.55 m puts the two 1.1 m apart, so two riders about 0.75 m wide fit
 * in a 3.0-3.5 m lane with room to spare.
 */
export const ABREAST_OFFSET_M = 0.55;
const DEFAULT_LANE_WIDTH_M = 3.5;
/** Vehicles fade in over this distance after entering the area and fade out before leaving it. */
export const EDGE_FADE_M = 60;
/** Turns sharper than this slow vehicles to TURN_SPEED_MPS at the junction. */
const TURN_ANGLE_DEG = 35;
const TURN_SPEED_MPS = 4.5;
/** Distance over which vehicles slow down for a turn. */
const TURN_SLOWDOWN_M = 40;
/**
 * A vehicle standing this long at the front of a queue counts as gridlocked (a
 * gridlock event, reported with where it stands and what it waits on). Only
 * with `removeStuckVehicles` is it also removed from the network (a despawn,
 * counted as a stuck removal); off by default (docs/OVERHAUL.md §20).
 */
export const GRIDLOCK_S = 180;
/**
 * A vehicle held at its line this long (s), for room in a lane another approach
 * also feeds or by a movement crossing its path from an approach it does not
 * give way to, gets the next turn: the lane, or the junction, is left to it
 * (merging and crossing in turn). Shorter waits change nothing. Well under
 * GRIDLOCK_S, so a vehicle that only had to wait its turn is never removed.
 */
const MERGE_TURN_S = 60;
/** A vehicle held at a line stops this close to it (see lineGap); within this it is at the line. */
const AT_LINE_M = 0.5;
/** Turn-taking: a vehicle held for room in a lane is owed that lane; one held by crossing traffic is owed the junction. */
const ROOM_HOLDS = ['room', 'room-wait'] as const;
const CONFLICT_HOLDS = ['conflict'] as const;
/** Traffic that must give way is cleared to cross only from this close to the line. */
const YIELD_LINE_M = 8;
/**
 * A cleared vehicle claims its path through a junction only from this long
 * before its stop line (and while it drives the path). Claiming from the moment
 * of clearance, often 60 m out, starves crossing and merging approaches.
 */
const CLAIM_AHEAD_S = 2;
/**
 * Time (s) to cover `dist` metres from speed `v`, accelerating at `a` up to
 * `vMax` (uniform acceleration, then constant speed).
 */
export function timeToCover(dist: number, v: number, a: number, vMax: number): number {
  if (dist <= 0) return 0;
  const top = Math.max(vMax, v, 0.1);
  if (v >= top || a <= 0) return dist / Math.max(v, 0.1);
  const dAcc = (top * top - v * v) / (2 * a);
  if (dist <= dAcc) return (-v + Math.sqrt(v * v + 2 * a * dist)) / a;
  return (top - v) / a + (dist - dAcc) / top;
}
/** Distance (m) covered in `t` seconds from speed `v`, accelerating at `a` up to `vMax` (inverse of timeToCover). */
export function distanceIn(t: number, v: number, a: number, vMax: number): number {
  if (t <= 0) return 0;
  const top = Math.max(vMax, v);
  if (a <= 0 || v >= top) return v * t;
  const tAcc = (top - v) / a;
  if (t <= tAcc) return v * t + 0.5 * a * t * t;
  return (top * top - v * v) / (2 * a) + top * (t - tAcc);
}
/** Beyond this many vehicles, new arrivals wait at the area edge. */
/** Vehicles on the network at once; beyond it arrivals wait at their entry (reported by road analysis as a capacity limit). */
export const MAX_VEHICLES = 5000;
/**
 * OSM junctions are often clusters of nodes a few metres apart. Road stretches
 * shorter than this are folded into one junction (like SUMO's junction joining),
 * so vehicles never queue inside a junction on a link shorter than a car.
 * 16 m (was 12): where two divided roads cross, OSM draws four nodes joined by
 * 12-14 m carriageway stubs (Kasturi Chowk, Wakad). At 12 m they stayed four
 * junctions, each with its own give-way or partial signal, and vehicles stopped
 * on the stubs inside the crossing: the "waiting oddly at junctions" seen there.
 */
export const JOIN_JUNCTION_M = 16;
/** A joined junction never spans more than this, so a dense street is not collapsed into one. */
const MAX_JUNCTION_SPAN_M = 30;

/** Fixed-time signal plan: each of two phase groups gets green, amber, then all-red. */
export const SIGNAL_GREEN_S = 25;
export const SIGNAL_AMBER_S = 3;
export const SIGNAL_ALL_RED_S = 2;
const SIGNAL_CYCLE_S = 2 * (SIGNAL_GREEN_S + SIGNAL_AMBER_S + SIGNAL_ALL_RED_S);
/** Shortest cycle a placed junction may run (matches the junction editor), leaving each group 5 s of green. */
export const MIN_SIGNAL_CYCLE_S = 20;
/**
 * Demand level ("Normal" volume) at which an OD trip's vehiclesPerHour is
 * served as given; other levels scale it proportionally.
 */
export const OD_REFERENCE_LEVEL = 0.12;
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
  /** Study-area stretches (segment keys) watched as well: a road section rather than whole OSM ways (roadSection.ts). */
  watchSegmentKeys?: readonly string[];
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
  junctions?: readonly JunctionObject[];
  /** Explicit estimated OD arrivals replace the capacity-based synthetic fallback. */
  demandTrips?: readonly MicroDemandTrip[];
  /**
   * Fixed-time signal plans: 'webster' (default) times each signalised junction
   * from its critical flows (Webster's optimum cycle, Indo-HCM width-based
   * saturation flow, L = 2n + R lost times; signalTiming.ts); 'equal' gives every
   * phase SIGNAL_GREEN_S (the earlier plan, kept for comparison).
   */
  signalTiming?: 'webster' | 'equal';
  /** Two-wheelers ride two abreast in a lane (lateral filtering). Default true. */
  twoWheelersAbreast?: boolean;
  /**
   * Route cost multipliers per link id (congested / free-flow travel time from
   * an earlier run, assignment.ts). Route choice then weighs each link's usual
   * cost (length over class-weighted speed) by how congested it was.
   */
  linkCostFactors?: ReadonlyMap<string, number>;
  /**
   * Count movements at the junction's stop lines (default true): a movement is
   * the link a vehicle enters the junction core by and the link it leaves by,
   * as a manual count at the junction records it. false: the older zone-edge
   * counting, where any road crossing the count circle is an arm.
   */
  stopLineCounting?: boolean;
  /**
   * Remove a vehicle that has stood GRIDLOCK_S at the front of a queue (a
   * despawn: the vehicle is deleted, counted in `accounting.stuckRemovals` with
   * where it stood and what it waited on). Default false: gridlock is left in
   * place and reported (`accounting.gridlockedNow`, `gridlockSites()`). An
   * explicitly labelled fallback, kept for comparison with earlier results.
   */
  removeStuckVehicles?: boolean;
}

export interface MicroDemandTrip {
  fromNodeId: string; toNodeId: string; vehiclesPerHour: number; kind: VehicleKind; viaRoadId?: string;
  /**
   * Links the trip must take, in order (link ids). A count-seeded trip stands for
   * vehicles counted making one movement, so it is routed through that movement's
   * stop-line approach and exit whatever the link costs; only how it reaches the
   * approach and leaves after the exit is chosen by route cost. Ignored when a
   * listed link is not in the network (e.g. after a road edit).
   */
  viaLinkIds?: readonly string[];
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
export type HoldCause = 'signal' | 'blocked' | 'giveWay' | 'conflict';
export interface AnalysisLinkCounts {
  id: string; segmentKey: string; roadId: string; from: string; to: string; lengthM: number; lanes: number; freeFlowS: number; watched: boolean;
  entries: number; pcuEntries: number; selectEntries: number; meanTimeS: number | null; onLinkNow: number; queuedNow: number;
  /** Queued vehicle-seconds by why the front vehicle was held (see attributeHolds). */
  hold: Record<HoldCause, number>;
  /** Links whose lack of room held vehicles here (link id, vehicle-seconds). */
  blockedBy: [string, number][];
  /** Ends at a signalised junction; its effective green ratio (green / cycle) for this approach. */
  signal: boolean; gC: number | null;
}

/** Where a gridlocked front vehicle stands: inside a junction box (still driving the movement of the junction behind), at its stop line, or elsewhere on the link. */
export type StuckPlace = 'box' | 'approach' | 'link';
/**
 * What a gridlocked front vehicle waits on: a gap in the priority stream
 * (gap acceptance), a crossing movement holding the junction, a red signal, room
 * on its exit (the lane it leads to is full), or nothing it asked for
 * (`other`). `laneChange` and `noConnection` are listed for completeness: this
 * model has no lane changing (a blocked target lane falls back to another lane
 * of the next link at the grant), and every lane maps across every junction, so
 * neither can occur.
 */
export type StuckCause = 'priorityGap' | 'crossingTraffic' | 'redSignal' | 'blockedExit' | 'laneChange' | 'noConnection' | 'other';
const STUCK_CAUSES: readonly StuckCause[] = ['priorityGap', 'crossingTraffic', 'redSignal', 'blockedExit', 'laneChange', 'noConnection', 'other'];

/**
 * Every vehicle the simulation created, by what became of it. Conservation:
 * `spawned = completedAtDestination + exitedAtEdge + timeouts + stuckRemovals + inNetwork`
 * and `generated = spawned + waitingAtEdge`.
 */
export interface VehicleAccounting {
  /** Trips created (each waits at its entry until there is room to enter). Trips with no route are in `unroutable`, not here. */
  generated: number;
  /** Generated but never got onto the network: still waiting at their entry (spawn blocked by a full first lane, or the vehicle limit). */
  waitingAtEdge: number;
  /** Entered the network. */
  spawned: number;
  /** Trip ended at a destination inside the study area. */
  completedAtDestination: number;
  /** Trip ended by leaving the study area at its edge (its destination lies outside). */
  exitedAtEdge: number;
  /** Removed for exceeding a maximum trip time: always 0, the model has no such limit. */
  timeouts: number;
  /** Removed after standing GRIDLOCK_S at the front of a queue (only with `removeStuckVehicles`). */
  stuckRemovals: number;
  stuckRemovalsByPlace: Record<StuckPlace, number>;
  stuckRemovalsByCause: Record<StuckCause, number>;
  /** On the network now. */
  inNetwork: number;
  /** Whether stuck vehicles are removed in this run. */
  stuckRemovalEnabled: boolean;
  /** Front vehicles that reached GRIDLOCK_S standing (each counted once, removed or not). */
  gridlockEvents: number;
  gridlockEventsByPlace: Record<StuckPlace, number>;
  gridlockEventsByCause: Record<StuckCause, number>;
  /** Front vehicles standing GRIDLOCK_S or longer right now (genuine gridlock left in place). */
  gridlockedNow: number;
}

/** A junction where front vehicles stand gridlocked now (removal off), for reporting the location. */
export interface GridlockSite {
  node: string;
  lng: number;
  lat: number;
  /** Front vehicles standing GRIDLOCK_S or longer on its approaches (or inside its box). */
  vehicles: number;
  longestS: number;
  causes: Partial<Record<StuckCause, number>>;
  places: Partial<Record<StuckPlace, number>>;
}

export interface MicroSimMetrics {
  timeS: number;
  onNetwork: number;
  waitingToEnter: number;
  completedTrips: number;
  /** Mean speed of vehicles on the network (km/h), null when empty. */
  meanSpeedKmh: number | null;
  /** Mean of (actual ÷ free-flow travel time) over completed trips, null before any. */
  delayIndex: number | null;
  /** Completed trips, including waiting to enter. */
  meanTravelTimeS: number | null;
  meanDelayS: number | null;
  stopsPerTrip: number | null;
  /** Vehicles removed after standing GRIDLOCK_S (= accounting.stuckRemovals; 0 unless removal is enabled). */
  gridlockRemovals: number;
  /** What became of every vehicle created (conservation checked in tests). */
  accounting: VehicleAccounting;
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
  speedKmh: number;
  /** 0-1: fades in after entering the area and out before leaving it. */
  opacity: number;
  /** Uses a watched road on its route. */
  focus: boolean;
}

export interface DebugVehicle { id: number; pos: number; v: number; length: number; kind: VehicleKind; stopLine: number; crossing: boolean; abreast: boolean }

/** A movement through a controlled junction that conflicting movements must wait for. */
interface Reservation {
  veh: Vehicle;
  vehId: number;
  node: string;
  from: number;
  connector: LaneConnector;
  /** The link and lane the movement leads into (keep-clear accounting). */
  toLink: number;
  toLane: number;
  /** Crossing beside a partner: takes no room of its own in the next lane. */
  alongside?: boolean;
  /** Order in which grants were given (a vehicle's room counts only those cleared before it). */
  seq: number;
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
  /** Part of a roundabout's circulating carriageway (OSM junction=roundabout). */
  roundabout: boolean;
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
  /** The granted movement through the next junction, while still approaching it. */
  connector: LaneConnector | null;
  reservation: Reservation | null;
  /**
   * The movement this vehicle is still driving after crossing the stop line.
   * It is already on the next link (at a negative position until the turn is
   * done), so the vehicle behind it can follow it through; its claim on the
   * junction lasts until it reaches `connector.entry`.
   */
  arriving: { connector: LaneConnector; reservation: Reservation | null } | null;
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
  /** Per count zone, the approach this vehicle entered it by (see setCountZones). */
  zoneEntry?: (Cardinal | null)[];
  /** Time stopped (v < 0.3 m/s) on the current link, charged to the junction at its end. */
  linkStopS?: number;
  /** When and where (m along the link) the vehicle came onto its current link, for control delay. */
  linkEnterT?: number;
  linkEnterPos?: number;
  /**
   * Riding alongside the two-wheeler ahead (lateral filtering): Indian
   * two-wheelers queue and move two abreast in one lane. Such a vehicle follows
   * the vehicle ahead of its partner and never passes the partner.
   */
  abreast?: boolean;
  /** Cleared to cross beside its partner (into the same lane, alongside it). */
  pairCross?: boolean;
  /** Why its last request to cross was refused (signal, room, room-wait, conflict, give-way), for delay attribution. */
  hold?: string;
  /** The link it was waiting to enter. */
  holdNext?: number;
  /** Has stood GRIDLOCK_S at the front of a queue (counted once as a gridlock event). */
  gridlocked?: boolean;
}

interface Control {
  kind: 'signal' | 'priority';
  /** Signal phase group per incoming link. */
  groups: Map<number, number>;
  /** Number of signal phases the cycle is split into (2: by axis; one per approach for approach-wise plans). */
  phases?: number;
  /** Priority junctions: the main road's class rank, or null when every approach ranks the same. */
  majorRank: number | null;
  offset: number;
  busyUntil: number;
  busyFrom: number;
  cycleS?: number;
  /** Displayed green per phase (s), when phases differ (Webster split); else equal slots. */
  greens?: number[];
  /** Timing set by the project (a placed junction's own cycle): never retimed. */
  fixed?: boolean;
  /** Last Webster design for this junction, for reporting. */
  design?: WebsterResult;
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

/** FNV-1a hash of a string, for random streams keyed by what they belong to rather than by position. */
function hashKey(key: string): number {
  let h = 0x811c9dc5;
  for (let i = 0; i < key.length; i++) { h ^= key.charCodeAt(i); h = Math.imul(h, 0x01000193); }
  return h >>> 0;
}

/**
 * A random stream for one thing in one run (an OD stream, a junction's
 * signal offset), seeded from the run's seed and the thing's own identity.
 * Keyed by identity, not by its position in a list, so a network edit that
 * reorders or changes other entries leaves this one's draws as they were
 * (common random numbers between a baseline and a proposal).
 */
export function streamRng(seed: number, key: string) {
  return makeRng((seed ^ Math.imul(hashKey(key) | 1, 0x9e3779b1)) >>> 0);
}

/** The identity of a frozen OD stream: its ends, vehicle class and the links it is held to. */
export function odStreamKey(trip: Pick<MicroDemandTrip, 'fromNodeId' | 'toNodeId' | 'kind' | 'viaRoadId' | 'viaLinkIds'>) {
  return `${trip.fromNodeId}>${trip.toNodeId}|${trip.kind ?? ''}|${trip.viaRoadId ?? ''}|${trip.viaLinkIds?.join(',') ?? ''}`;
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

/** Level of service from mean control delay (HCM 2000 Exhibits 16-2 and 17-2). */
export function losFor(delayS: number, signalised: boolean): string {
  const t = signalised ? [10, 20, 35, 55, 80] : [10, 15, 25, 35, 50];
  const i = t.findIndex(x => delayS <= x);
  return 'ABCDEF'[i < 0 ? 5 : i];
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
  /** The run's seed, for the per-junction and per-OD streams (streamRng). */
  private readonly seed: number;
  private demandLevel: number;
  private readonly signalTimingMode: 'webster' | 'equal';
  /** Road-analysis counters since startAnalysis(): link entries, and those by vehicles routed over a watched link. */
  private analysis: { fromT: number; entries: Uint32Array; selectEntries: Uint32Array; selectOd: Map<string, number>; timeSum0: Float64Array; timeN0: Uint32Array; released: number; capSteps: number; steps0: number; gridlock0: number; unroutable0: number;
    /** Queued vehicle-seconds behind a stopped front vehicle, by why the front vehicle was held: signal, blocked (no room ahead), give-way, conflict. */
    hold: Record<HoldCause, Float64Array>; blockedBy: Map<number, Map<number, number>>; pcuEntries: Float64Array } | null = null;
  private linkTimeSum = new Float64Array(0);
  private linkTimeN = new Uint32Array(0);
  private readonly abreastEnabled: boolean;
  private readonly stopLineCounting: boolean;
  /** Design flows (PCU/h) per inbound link index set from observed counts; others come from assigned demand. */
  private designFlows = new Map<number, number>();
  /** Time-of-day multiplier on all arrivals: demand at the chosen hour / demand at the hour the plan represents. */
  private hourFactor = 1;
  private nextId = 1;
  private t = 0;

  private completed = 0;
  private delaySum = 0;
  private travelTimeSum = 0;
  private excessTimeSum = 0;
  private stopsSum = 0;
  private gridlockRemovals = 0;
  private readonly removeStuck: boolean;
  private generated = 0;
  private spawned = 0;
  private exitedAtEdge = 0;
  private readonly stuckByPlace: Record<StuckPlace, number> = { box: 0, approach: 0, link: 0 };
  private readonly stuckByCause = Object.fromEntries(STUCK_CAUSES.map(c => [c, 0])) as Record<StuckCause, number>;
  private gridlockEvents = 0;
  private readonly gridlockByPlace: Record<StuckPlace, number> = { box: 0, approach: 0, link: 0 };
  private readonly gridlockByCause = Object.fromEntries(STUCK_CAUSES.map(c => [c, 0])) as Record<StuckCause, number>;
  /** Junctions where a trip leaving the area ends (a road continues beyond the area there). */
  private readonly edgeExits = new Set<string>();
  private grantSeq = 0;
  private unroutable = 0;
  private readonly watchedLinks = new Set<number>();
  private watchedPassed = 0;
  private readonly focusPairs: FocusPair[] = [];
  /** Cumulative pair weights, for drawing a pair in proportion to its weight. */
  private readonly focusCum: number[] = [];
  private focusCapacityVph = 0;
  private focusLoad: number;
  private focusNextT = Infinity;
  private readonly movements = new Map<string, LaneConnector>();
  private readonly reservations = new Set<Reservation>();
  private readonly odArrivals: { index: number; key: string; trip: MicroDemandTrip; nextT: number; route: number[]; freeFlowS: number; rng: () => number }[] = [];
  private explicitDemand = false;
  /** Counted junctions (observed-count calibration): their layouts and the movements counted since countFromT. */
  private countLayouts: ZoneLayout[] = [];
  private countFromT = 0;
  private readonly movementCountMap = new Map<string, number>();
  /** Junction -> stopped time of vehicles that crossed it, and how many crossed. */
  private readonly junctionDelay = new Map<string, { stopS: number; vehicles: number }>();
  /** Junction -> control delay (s, actual minus free-flow time on the approach), PCU crossed, queue samples. */
  private readonly junctionPerf = new Map<string, { controlDelayS: number; vehicles: number; pcu: number; queueSumM: number; queueMaxM: number; samples: number; lastCrossT: number }>();
  private deadlockEvents = 0;
  private readonly deadlocked = new Set<string>();
  private maxStuckInBoxS = 0;
  private nextSampleT = 0;

  constructor(area: StudyArea, roads: ReadonlyMap<string, DrivableObject>, options: MicroSimOptions) {
    this.rng = makeRng(options.seed);
    this.seed = options.seed >>> 0;
    this.demandLevel = Math.max(0, Math.min(1, options.demandLevel));
    this.signalTimingMode = options.signalTiming ?? 'webster';
    this.abreastEnabled = options.twoWheelersAbreast ?? true;
    this.stopLineCounting = options.stopLineCounting ?? true;
    this.removeStuck = options.removeStuckVehicles ?? true;
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
      const f = options.linkCostFactors?.get(l.id);
      cost[i] = (e.length / ((e.speedLimit || 50) / 3.6)) * (f !== undefined && Number.isFinite(f) && f > 0 ? f : 1);
      // A private / destination-only road (campus, gated lane) is not a through route here either, as in the
      // area assignment (docs/OVERHAUL.md §19): prohibitive per stretch but finite, so trips that start or end
      // on one, or have no other way, are still routed. Route times are taken from the links, not from this cost.
      if (isAccessRestricted(roads.get(e.roadId))) cost[i] += RESTRICTED_ENTRY_S;
    });
    this.trees = new RouteTrees(
      this.nodeIndex.size,
      Int32Array.from(this.links, l => this.nodeIndex.get(l.from)!),
      Int32Array.from(this.links, l => this.nodeIndex.get(l.to)!),
      cost,
    );

    this.buildControls(options.signalPoints ?? null);
    this.applyPlacedControls(options.junctions ?? []);
    this.signalLinks = this.links.filter(l => this.controls.get(l.to)?.kind === 'signal').map(l => l.index);
    this.buildSourcesAndSinks(net, included, roads);
    const watch = new Set(options.watchRoadIds ?? []);
    const watchSegs = new Set(options.watchSegmentKeys ?? []);
    for (const l of this.links) if (watch.has(l.roadId) || watchSegs.has(l.segmentKey)) this.watchedLinks.add(l.index);
    this.buildFocusDemand(roads);
    if (options.demandTrips !== undefined) {
      this.explicitDemand = true;
      for (const s of this.sources) { s.ratePerS = 0; s.nextT = Infinity; }
      this.focusNextT = Infinity;
      const linkIndexById = new Map(this.links.map(l => [l.id, l.index]));
      const seen = new Map<string, number>();
      for (const [index, trip] of options.demandTrips.entries()) {
        if (trip.vehiclesPerHour <= 0) continue;
        // A stream per OD stream, seeded by what the stream is (its ends, class and links), not by
        // its index: an edit re-routes the area, which reorders and changes the neighbourhood's trip
        // list, and an index-keyed stream then gave every OD other arrivals and drivers, so any edit
        // re-drew the whole neighbourhood's traffic (docs/OVERHAUL.md §10.2). Identical streams are told apart by
        // their occurrence.
        const key = odStreamKey(trip);
        const occurrence = seen.get(key) ?? 0;
        seen.set(key, occurrence + 1);
        const rng = streamRng(options.seed, `${key}#${occurrence}`);
        const from = this.junction(trip.fromNodeId), to = this.junction(trip.toNodeId);
        // Intrazonal: both ends attach to the same junction, so the trip never
        // uses a modelled road. It is not a routing failure.
        if (from && from === to) continue;
        let path = this.nodeIndex.has(from) && this.nodeIndex.has(to) ? this.route(from, to) : null;
        if (trip.viaRoadId) {
          const paths = this.links.filter(l => l.roadId === trip.viaRoadId).flatMap(l => {
            const before = this.route(from, l.from), after = this.route(l.to, to);
            return before && after ? [{ route: [...before.route, l.index, ...after.route], freeFlowS: before.freeFlowS + l.length / l.speed + after.freeFlowS }] : [];
          });
          path = paths.sort((a, b) => a.freeFlowS - b.freeFlowS)[0] ?? null;
        }
        if (trip.viaLinkIds?.length) {
          const via = trip.viaLinkIds.map(id => linkIndexById.get(id));
          if (via.every((i): i is number => i !== undefined)) {
            // Through each listed link in turn; the legs between them by route cost
            const route: number[] = [];
            let at = from, ok = true;
            for (const i of via) {
              const leg = at === this.links[i].from ? { route: [] as number[] } : this.route(at, this.links[i].from);
              if (!leg) { ok = false; break; }
              route.push(...leg.route, i);
              at = this.links[i].to;
            }
            const last = ok ? (at === to ? { route: [] as number[] } : this.route(at, to)) : null;
            if (ok && last) {
              route.push(...last.route);
              path = { route, freeFlowS: route.reduce((n, i) => n + this.links[i].length / this.links[i].speed, 0) };
            } else path = null;
          }
        }
        this.odArrivals.push({ index, key: `${key}#${occurrence}`, trip: { ...trip, fromNodeId: from, toNodeId: to }, nextT: this.nextOdArrival(trip, 0, rng), route: path?.route ?? [], freeFlowS: path?.freeFlowS ?? 0, rng });
      }
    }
    this.linkTimeSum = new Float64Array(this.links.length);
    this.linkTimeN = new Uint32Array(this.links.length);
    this.retimeSignals();
  }

  /** Explicit project controls override mapped/estimated signals only at the same elevation. */
  private applyPlacedControls(junctions: readonly JunctionObject[]) {
    for (const junction of junctions) {
      let closest: string | null = null, distance = SIGNAL_MATCH_M;
      for (const [nodeId, node] of this.subnet.nodes) {
        const links = this.incomingOf(nodeId).map(([, l]) => l);
        if (!links.length || (junction.connectedRoads.length && !links.some(l => junction.connectedRoads.includes(l.roadId)))) continue;
        if (Math.abs((node.coordinates[2] || 0) - junction.coordinates[2]) > 3) continue;
        const d = Math.hypot((node.coordinates[0] - junction.coordinates[0]) * mPerDegLng(junction.coordinates[1]), (node.coordinates[1] - junction.coordinates[1]) * M_PER_DEG_LAT);
        if (d < distance) { closest = nodeId; distance = d; }
      }
      if (!closest) continue;
      const incoming = this.incomingOf(closest).map(([, l]) => l);
      const ref = incoming[0].headingEnd;
      const groups = new Map<number, number>(incoming.map(l => {
        const d = angleBetweenDeg(l.headingEnd, ref);
        return [l.index, d < 45 || d > 135 ? 0 : 1];
      }));
      this.controls.set(closest, { kind: junction.hasSignals ? 'signal' : 'priority', groups,
        majorRank: null, offset: 0, busyUntil: 0, busyFrom: -1,
        cycleS: Math.max(MIN_SIGNAL_CYCLE_S, Number.isFinite(junction.signalTiming) ? junction.signalTiming : SIGNAL_CYCLE_S),
        fixed: Number.isFinite(junction.signalTiming) });
    }
  }

  private nextOdArrival(trip: MicroDemandTrip, from: number, rng: () => number) {
    const rate = trip.vehiclesPerHour * this.demandLevel * this.hourFactor / OD_REFERENCE_LEVEL / 3600;
    return rate > 0 ? from - Math.log(1 - rng()) / rate : Infinity;
  }

  /** Counts a vehicle the first time it drives onto a watched road. */
  private noteLink(veh: Vehicle, linkIndex: number) {
    if (this.analysis) {
      const a = this.analysis;
      a.entries[linkIndex]++;
      a.pcuEntries[linkIndex] += veh.type.pcu;
      if (veh.focus) {
        a.selectEntries[linkIndex]++;
        // Select-link origin and destination: counted once per vehicle, when it enters the area
        if (linkIndex === veh.route[0]) {
          const key = `${this.links[veh.route[0]].from}>${this.links[veh.route[veh.route.length - 1]].to}`;
          a.selectOd.set(key, (a.selectOd.get(key) ?? 0) + 1);
        }
      }
    }
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
      roundabout: road?.type === 'road' && !!(road as RoadObject).osmProvenance?.roundabout,
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
      const groups = new Map<number, number>();
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
          this.controls.set(nodeId, this.approachWisePlan(nodeId, inLinks) ?? { kind: 'signal', groups, majorRank: null, offset: this.signalOffsetUnit(nodeId) * SIGNAL_CYCLE_S, busyUntil: 0, busyFrom: -1 });
          return;
        }
      } else if (armCount >= 4) {
        // Signals only where a collector or bigger road runs on both axes; a main
        // road meeting a lane stays a priority junction
        const majorOn = (g: number) => inLinks.some(i => groups.get(i) === g && this.links[i].rank >= 2);
        if (majorOn(0) && majorOn(1)) {
          this.controls.set(nodeId, this.approachWisePlan(nodeId, inLinks) ?? { kind: 'signal', groups, majorRank: null, offset: this.signalOffsetUnit(nodeId) * SIGNAL_CYCLE_S, busyUntil: 0, busyFrom: -1 });
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
   * Approach-wise ("split") phasing: each approach gets its own green in turn,
   * with all its movements, so nothing in a phase conflicts. This is the
   * textbook plan where turning flows are comparable with through flows and
   * through and turning traffic share lanes (IIT Bombay, Mathew, "Design
   * principles of traffic signal", NPTEL 571, four-phase option 1;
   * https://www.civil.iitb.ac.in/tvm/nptel/571_TrSignal.pdf). The model has no
   * turn bays, so every approach shares lanes; the Pune counts show turning
   * flows of the same order as through flows. Carriageways arriving from within
   * 35 degrees of each other are one approach. Each phase: SIGNAL_GREEN_S
   * green, SIGNAL_AMBER_S amber, SIGNAL_ALL_RED_S all-red (120 s for four arms).
   * Returns null for fewer than three approaches.
   */
  private approachWisePlan(nodeId: string, inLinks: number[]): Control | null {
    const reps: number[] = [];
    const groups = new Map<number, number>();
    // Collector-class and bigger approaches get phases; a lane or service road joining
    // the junction runs with the phase of the approach nearest its direction.
    const major = inLinks.filter(i => this.links[i].rank >= 2);
    // An approach's direction is where it comes from: the bearing from the junction
    // to a point 40 m back along the link. (The carriageways of one divided road
    // can end at different corners of a joined junction with quite different final headings.)
    const from = (i: number) => {
      const l = this.links[i];
      const end = l.pts[l.pts.length - 1];
      const back = this.place(l, 0, Math.max(0, l.length - 40), { lng: 0, lat: 0, z: 0, heading: 0, pitch: 0 });
      return headingOf(end, [back.lng, back.lat]);
    };
    for (const i of major.length >= 3 ? major : inLinks) {
      const h = from(i);
      let g = reps.findIndex(r => angleBetweenDeg(r, h) < 35);
      if (g < 0) { g = reps.length; reps.push(h); }
      groups.set(i, g);
    }
    if (reps.length < 3) return null;
    for (const i of inLinks) {
      if (groups.has(i)) continue;
      const h = from(i);
      let best = 0;
      reps.forEach((r, g) => { if (angleBetweenDeg(r, h) < angleBetweenDeg(reps[best], h)) best = g; });
      groups.set(i, best);
    }
    const cycleS = reps.length * (SIGNAL_GREEN_S + SIGNAL_AMBER_S + SIGNAL_ALL_RED_S);
    return { kind: 'signal', groups, phases: reps.length, cycleS, majorRank: null, offset: this.signalOffsetUnit(nodeId) * cycleS, busyUntil: 0, busyFrom: -1 };
  }

  /** A junction's signal offset (share of its cycle): drawn per junction, so an edit elsewhere does not shift it. */
  private signalOffsetUnit(nodeId: string) {
    return streamRng(this.seed, `signal:${nodeId}`)();
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
        const src: Source = { nodeId, ratePerS: inVph / 3600, nextT: 0, queue: [], sinks: [] };
        this.sources.push(src);
        this.sourceByNode.set(nodeId, src);
      }
      if (outVph > 0 && node.incomingSegments.length > 0) { this.sinks.push({ nodeId, weight: outVph }); this.edgeExits.add(nodeId); }
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
    if (this.explicitDemand) return 0;
    return this.focusPairs.length > 0 ? (this.focusCapacityVph * this.focusLoad * this.hourFactor) / 3600 : 0;
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
    const rate = source.ratePerS * this.demandLevel * this.hourFactor;
    if (rate <= 0) return Infinity;
    return from - Math.log(1 - this.rng()) / rate; // Poisson arrivals
  }

  public setDemandLevel(level: number) {
    this.demandLevel = Math.max(0, Math.min(1, level));
    for (const s of this.sources) s.nextT = this.nextArrival(s, this.t);
    for (const arrival of this.odArrivals) arrival.nextT = this.nextOdArrival(arrival.trip, this.t, arrival.rng);
    this.arrivalHeapDirty = true;
    this.retimeSignals();
  }

  /**
   * Scales every arrival stream by the time-of-day factor (hourly demand =
   * calibrated peak-hour demand x profile[hour] / profile[count hour]).
   */
  public setHourFactor(factor: number) {
    this.hourFactor = Math.max(0, Number.isFinite(factor) ? factor : 1);
    for (const s of this.sources) s.nextT = this.nextArrival(s, this.t);
    for (const arrival of this.odArrivals) arrival.nextT = this.nextOdArrival(arrival.trip, this.t, arrival.rng);
    this.arrivalHeapDirty = true;
    this.focusNextT = this.nextFocusArrival(this.t);
    this.retimeSignals();
  }

  public get currentHourFactor(): number {
    return this.hourFactor;
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

  private queueVehicle(source: Source, route: number[], freeFlowS: number, type: VehicleTypeParams, speedDraw: number = this.rng()) {
    this.generated++;
    source.queue.push({
      id: this.nextId++,
      type,
      // Desired speeds vary a little between drivers
      speedFactor: type.speedFactor * (0.9 + 0.2 * speedDraw),
      link: route[0],
      lane: 0,
      pos: 0,
      v: 0,
      acc: 0,
      route,
      routeIdx: 0,
      grantLane: null,
      connector: null,
      reservation: null,
      arriving: null,
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
    this.sourceByNode.set(nodeId, s);
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

  /**
   * OD arrivals by next arrival time (binary min-heap of indices into
   * odArrivals). Scanning every OD stream each step cost most of a step on
   * large areas (tens of thousands of streams); the heap visits only those due.
   * Rebuilt when arrival times are reset (demand level or hour changes).
   */
  private arrivalHeap: number[] = [];
  private arrivalHeapDirty = true;
  private heapLess(a: number, b: number) {
    const x = this.odArrivals[a].nextT, y = this.odArrivals[b].nextT;
    return x < y || (x === y && a < b);
  }
  private heapPush(i: number) {
    const h = this.arrivalHeap;
    h.push(i);
    let k = h.length - 1;
    while (k > 0) { const p = (k - 1) >> 1; if (!this.heapLess(h[k], h[p])) break; [h[k], h[p]] = [h[p], h[k]]; k = p; }
  }
  private heapPop(): number {
    const h = this.arrivalHeap, top = h[0], last = h.pop()!;
    if (h.length) {
      h[0] = last;
      let k = 0;
      for (;;) {
        const l = 2 * k + 1, r = l + 1;
        let m = k;
        if (l < h.length && this.heapLess(h[l], h[m])) m = l;
        if (r < h.length && this.heapLess(h[r], h[m])) m = r;
        if (m === k) break;
        [h[k], h[m]] = [h[m], h[k]]; k = m;
      }
    }
    return top;
  }
  private readonly sourceByNode = new Map<string, Source>();

  private spawnDue() {
    if (this.arrivalHeapDirty) {
      this.arrivalHeap = [];
      this.odArrivals.forEach((a, i) => { if (Number.isFinite(a.nextT)) this.heapPush(i); });
      this.arrivalHeapDirty = false;
    }
    // Due streams by arrival time, then by stream identity: not by their index in the trip list,
    // which an edit elsewhere can reorder
    const due: number[] = [];
    while (this.arrivalHeap.length && this.odArrivals[this.arrivalHeap[0]].nextT <= this.t) due.push(this.heapPop());
    const oa = this.odArrivals;
    due.sort((a, b) => oa[a].nextT - oa[b].nextT || (oa[a].key < oa[b].key ? -1 : oa[a].key > oa[b].key ? 1 : 0));
    for (const i of due) {
      const arrival = this.odArrivals[i];
      while (arrival.nextT <= this.t) {
        // The driver's speed comes from the OD's own stream (drawn whether or not it can be routed,
        // so the stream stays aligned): which vehicle gets which driver does not depend on the order
        // other streams fall due in
        const speedDraw = arrival.rng();
        if (arrival.route.length) {
          const source = this.sourceByNode.get(arrival.trip.fromNodeId) ?? this.addSource(arrival.trip.fromNodeId);
          this.queueVehicle(source, arrival.route, arrival.freeFlowS, VEHICLE_TYPES.find(t => t.kind === arrival.trip.kind)!, speedDraw);
        } else this.unroutable++;
        arrival.nextT = this.nextOdArrival(arrival.trip, arrival.nextT, arrival.rng);
      }
      if (Number.isFinite(arrival.nextT)) this.heapPush(i);
    }
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
    if (this.analysis && onNetwork >= MAX_VEHICLES) this.analysis.capSteps++;
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
        this.spawned++;
        if (this.analysis) this.analysis.released++;
        veh.lane = lane;
        veh.v = entryV;
        veh.wasMoving = entryV > 2;
        veh.linkEnterT = this.t;
        veh.linkEnterPos = 0;
        link.lanes[lane].push(veh);
        this.busy.add(link.index);
        this.noteLink(veh, veh.link);
        onNetwork++;
        this.onNetworkCount++;
      }
    }
  }

  /**
   * Design flows for Webster timing from observed counts: PCU/h arriving on each
   * inbound link (by link id). Links not given keep their assigned-demand flow.
   * Retimes the signals at once.
   */
  public setSignalDesignFlows(flows: ReadonlyMap<string, number> | null) {
    this.designFlows = new Map();
    if (flows) flows.forEach((q, id) => { const i = this.linkById.get(id); if (i !== undefined) this.designFlows.set(i, q); });
    this.retimeSignals();
  }

  /** PCU/h the assigned OD demand sends along each link at the current demand level and hour. */
  private assignedLinkPcu(): Float64Array {
    const q = new Float64Array(this.links.length);
    const meanPcu = VEHICLE_TYPES.reduce((n, t) => n + t.share * t.pcu, 0);
    const scale = this.demandLevel * this.hourFactor / OD_REFERENCE_LEVEL;
    for (const a of this.odArrivals) {
      if (!a.route.length) continue;
      const pcu = VEHICLE_TYPES.find(t => t.kind === a.trip.kind)?.pcu ?? meanPcu;
      const v = a.trip.vehiclesPerHour * scale * pcu;
      for (const i of a.route) q[i] += v;
    }
    return q;
  }

  /**
   * Webster timing for every signalised junction (signalTiming.ts): each phase's
   * critical flow ratio is the largest q/s among the approaches it serves, q the
   * design flow (observed counts where given, else assigned demand) and s the
   * Indo-HCM saturation flow of the approach width (lanes x lane width). With no
   * flow known, or signalTiming 'equal', phases keep equal greens.
   */
  private retimeSignals() {
    if (this.signalTimingMode !== 'webster' || !this.controls) return;
    const assigned = this.assignedLinkPcu();
    this.controls.forEach(c => {
      if (c.kind !== 'signal' || c.fixed) return;
      const phases = c.phases ?? 2;
      const flow = new Array(phases).fill(0);
      const ratio = new Array(phases).fill(0);
      // Approaches of a phase: inbound links grouped into it; carriageways of one approach add up
      const byPhase = new Map<number, number[]>();
      c.groups.forEach((g, i) => { if (!byPhase.has(g)) byPhase.set(g, []); byPhase.get(g)!.push(i); });
      byPhase.forEach((links, g) => {
        if (g >= phases) return;
        // Approaches within the phase: carriageways arriving from within 35 degrees of each other
        const reps: number[] = [], qa: number[] = [], wa: number[] = [];
        for (const i of links) {
          const l = this.links[i];
          let a = reps.findIndex(h => angleBetweenDeg(h, l.headingEnd) < 35);
          if (a < 0) { a = reps.length; reps.push(l.headingEnd); qa.push(0); wa.push(0); }
          qa[a] += this.designFlows.get(i) ?? assigned[i];
          wa[a] += l.lanes.length * l.laneWidth;
        }
        qa.forEach((q, a) => {
          flow[g] += q;
          if (wa[a] > 0) ratio[g] = Math.max(ratio[g], q / indoHcmSaturationFlow(wa[a]));
        });
      });
      if (!flow.some(q => q > 0)) { delete c.greens; delete c.design; return; }
      const design = websterTiming(ratio.map(y => ({ flow: y, saturationFlow: 1 })), { amberS: SIGNAL_AMBER_S, allRedS: SIGNAL_ALL_RED_S });
      c.cycleS = design.cycleS;
      c.greens = design.greensS;
      c.design = design;
      if (c.offset >= c.cycleS) c.offset %= c.cycleS;
    });
  }

  /**
   * Mean travel time (s) on each link that vehicles have used: the time from
   * entering to crossing at its far end, scaled to the full length, with
   * vehicles still on the link counted at their time so far when that is
   * already longer (a queue that has not cleared is not free-flowing). Links
   * nobody used are left out.
   */
  public linkTravelTimes(): Map<string, { meanS: number; samples: number; freeFlowS: number }> {
    const out = new Map<string, { meanS: number; samples: number; freeFlowS: number }>();
    const sum = Float64Array.from(this.linkTimeSum), n = Uint32Array.from(this.linkTimeN);
    for (const l of this.links) for (const lane of l.lanes) for (const v of lane) {
      const elapsed = this.t - (v.linkEnterT ?? this.t);
      if (elapsed > l.length / l.speed) { sum[l.index] += elapsed; n[l.index]++; }
    }
    for (const l of this.links) if (n[l.index]) out.set(l.id, { meanS: sum[l.index] / n[l.index], samples: n[l.index], freeFlowS: l.length / l.speed });
    return out;
  }

  /** Starts (or restarts) the road-analysis counters: link volumes, select-link volumes and origins/destinations. */
  public startAnalysis() {
    // Junction delay and queues over the same window
    this.junctionPerf.forEach(p => { p.controlDelayS = 0; p.vehicles = 0; p.pcu = 0; p.queueSumM = 0; p.queueMaxM = 0; p.samples = 0; });
    this.startCounting();
    this.analysis = { fromT: this.t, entries: new Uint32Array(this.links.length), selectEntries: new Uint32Array(this.links.length), selectOd: new Map(),
      timeSum0: Float64Array.from(this.linkTimeSum), timeN0: Uint32Array.from(this.linkTimeN), released: 0, capSteps: 0, steps0: Math.round(this.t / STEP_S), gridlock0: this.gridlockRemovals, unroutable0: this.unroutable,
      hold: { signal: new Float64Array(this.links.length), blocked: new Float64Array(this.links.length), giveWay: new Float64Array(this.links.length), conflict: new Float64Array(this.links.length) }, blockedBy: new Map(), pcuEntries: new Float64Array(this.links.length) };
  }

  /**
   * Road-analysis counts since startAnalysis(), per link: vehicles entering it,
   * those of them routed over a watched link (select-link), and the mean
   * traversal time of vehicles that left it in the window.
   */
  public analysisCounts(): { windowS: number; links: AnalysisLinkCounts[]; selectOd: Map<string, number>; load: { releasedVehicles: number; capShare: number; gridlockRemovals: number; unroutable: number } } | null {
    const a = this.analysis;
    if (!a) return null;
    const links = this.links.map(l => {
      const n = this.linkTimeN[l.index] - a.timeN0[l.index];
      const sum = this.linkTimeSum[l.index] - a.timeSum0[l.index];
      let onLinkNow = 0, queuedNow = 0;
      for (const lane of l.lanes) for (const v of lane) { onLinkNow++; if (v.v < 1) queuedNow++; }
      return { id: l.id, segmentKey: l.segmentKey, roadId: l.roadId, from: l.from, to: l.to, lengthM: l.length, lanes: l.lanes.length, freeFlowS: l.length / l.speed,
        watched: this.watchedLinks.has(l.index), entries: a.entries[l.index], pcuEntries: a.pcuEntries[l.index], selectEntries: a.selectEntries[l.index], meanTimeS: n > 0 ? sum / n : null, onLinkNow, queuedNow,
        hold: { signal: a.hold.signal[l.index], blocked: a.hold.blocked[l.index], giveWay: a.hold.giveWay[l.index], conflict: a.hold.conflict[l.index] },
        blockedBy: [...(a.blockedBy.get(l.index) ?? new Map<number, number>())].map(([k, sec]) => [this.links[k].id, sec] as [string, number]),
        signal: this.controls.get(l.to)?.kind === 'signal', gC: this.greenRatio(l.index) };
    });
    const steps = Math.max(1, Math.round(this.t / STEP_S) - a.steps0);
    return { windowS: this.t - a.fromT, links, selectOd: new Map(a.selectOd),
      load: { releasedVehicles: a.released, capShare: Math.min(1, a.capSteps / steps), gridlockRemovals: this.gridlockRemovals - a.gridlock0, unroutable: this.unroutable - a.unroutable0 } };
  }

  /** The simulated junction a network node belongs to (nodes a few metres apart are joined). */
  public junctionOfNode(nodeId: string): string {
    return this.junction(nodeId);
  }

  /** Coordinates of a junction of the simulated network (joined junctions: their first node). */
  public nodeCoordinates(nodeId: string): [number, number, number] | null {
    const n = this.subnet.nodes.get(nodeId) ?? this.areaNodes.get(nodeId);
    return n ? [...n.coordinates] as [number, number, number] : null;
  }

  /** Webster designs in force, per signalised junction (for reports and tests). */
  public signalPlans(): { nodeId: string; cycleS: number; greensS: number[]; flowRatioSum: number | null; oversaturated: boolean }[] {
    const out: { nodeId: string; cycleS: number; greensS: number[]; flowRatioSum: number | null; oversaturated: boolean }[] = [];
    this.controls.forEach((c, nodeId) => {
      if (c.kind !== 'signal') return;
      const phases = c.phases ?? 2, cycle = c.cycleS ?? SIGNAL_CYCLE_S;
      out.push({ nodeId, cycleS: cycle, greensS: c.greens ?? new Array(phases).fill(cycle / phases - SIGNAL_AMBER_S - SIGNAL_ALL_RED_S),
        flowRatioSum: c.design?.flowRatioSum ?? null, oversaturated: c.design?.oversaturated ?? false });
    });
    return out;
  }

  /** Green time over cycle time for the phase serving this approach link (null where unsignalised). */
  public greenRatio(linkIndex: number): number | null {
    const link = this.links[linkIndex];
    const c = this.controls.get(link.to);
    if (!c || c.kind !== 'signal') return null;
    const phases = c.phases ?? 2, cycle = c.cycleS ?? SIGNAL_CYCLE_S;
    const group = c.groups.get(linkIndex) ?? 0;
    const green = c.greens && c.greens.length === phases ? c.greens[group] : cycle / phases - SIGNAL_AMBER_S - SIGNAL_ALL_RED_S;
    return Math.max(0, Math.min(1, green / cycle));
  }

  public signalState(linkIndex: number): SignalState | null {
    const link = this.links[linkIndex];
    const c = this.controls.get(link.to);
    if (!c || c.kind !== 'signal') return null;
    const group = c.groups.get(linkIndex) ?? 0;
    const cycle = c.cycleS ?? SIGNAL_CYCLE_S;
    let start: number, green: number;
    if (c.greens && c.greens.length === (c.phases ?? 2)) {
      start = 0;
      for (let g = 0; g < group; g++) start += c.greens[g] + SIGNAL_AMBER_S + SIGNAL_ALL_RED_S;
      green = c.greens[group];
    } else {
      const slot = cycle / (c.phases ?? 2);
      start = group * slot;
      green = slot - SIGNAL_AMBER_S - SIGNAL_ALL_RED_S;
    }
    const tc = (this.t + c.offset) % cycle;
    const local = (tc - start + cycle) % cycle;
    if (local < green) return 'green';
    if (local < green + SIGNAL_AMBER_S) return 'amber';
    return 'red';
  }

  /** Whether the front vehicle of a lane may cross into its next link; reserves the junction if so. */
  /** Diagnostics: outcomes of grant requests per approach link (only when enabled). */
  private grantLog: Map<string, Map<string, number>> | null = null;
  /** Test hook: start counting the outcomes of grant requests per approach link id. */
  public traceGrants() { this.grantLog = new Map(); }
  public grantOutcomes(): Map<string, Map<string, number>> { return this.grantLog ?? new Map(); }
  private refuse(link: Link, reason: string, veh?: Vehicle, next?: number) {
    if (veh) { veh.hold = reason === 'granted' ? undefined : reason; veh.holdNext = next; }
    if (!this.grantLog) return;
    let m = this.grantLog.get(link.id);
    if (!m) { m = new Map(); this.grantLog.set(link.id, m); }
    m.set(reason, (m.get(reason) ?? 0) + 1);
  }

  private tryGrant(veh: Vehicle, link: Link, dist: number) {
    const next = this.links[veh.route[veh.routeIdx + 1]];
    // Lanes map across the junction in order (kerb lane to kerb lane), so vehicles
    // from parallel lanes discharge side by side; a blocked target lane falls back
    // to the emptiest one. (Sending every lane to the emptiest lane made parallel
    // movements converge and cross one at a time.)
    // A rider abreast of a partner cleared into the same next link goes with it, side by side
    const laneArr = link.lanes[veh.lane];
    const partner = veh.abreast ? laneArr[laneArr.indexOf(veh) - 1] : undefined;
    const withPartner = !!partner && partner.grantLane !== null && partner.route[partner.routeIdx + 1] === next.index;
    // Keep the junction box clear: enter only with room on the far side for this
    // vehicle, after every vehicle already cleared into the same lane. What is free
    // now counts, plus what a moving tail clears before this one reaches its line.
    // A rider beside its partner needs no room of its own.
    const need = (connector: LaneConnector) => this.exitNeed(veh, connector);
    // The room is needed where the movement ends, when this vehicle gets there: a
    // moving tail goes on at its speed for as long as this vehicle takes to reach
    // the line and drive the movement (kinematics from its speed and acceleration,
    // at turning speed through a turn). Projecting the tail only over the time to
    // the line (at the line: none) made every follower wait for the whole gap to
    // open before moving, so a turning queue could not discharge as a platoon
    // (one vehicle per lane every 4-5 s).
    const room = (k: number, d: number, connector: LaneConnector) => this.exitRoom(veh, next, k, d, connector);
    let lane = withPartner ? partner!.grantLane! : this.mappedLane(link, veh.lane, next);
    let connector = this.connectorFor(link, veh.lane, next, lane);
    dist = connector.start - veh.pos;
    if (!withPartner && room(lane, dist, connector) < need(connector)) {
      // The lane it leads to has no room yet. Between links with the same number of
      // lanes, if its tail is moving away the room comes in a moment: wait for it
      // (switching then sends parallel lanes across each other). If its tail is
      // standing (the lane is blocked), take another lane of the next link that has
      // room, if any.
      // Where the lane count changes (a merge or a widening) any lane with room will do.
      // A lane whose rear is pulling away is not blocked: at the start of green the
      // vehicles just across are still below walking pace (and a rider entering beside
      // its partner may brake hard behind the vehicle ahead), and treating the lane as
      // blocked sent the followers of one lane into the other lane of the next link,
      // across that lane's platoon, so both stalled at the line.
      if (link.lanes.length === next.lanes.length && rearMoving(next.lanes[lane])) return this.refuse(link, 'room-wait', veh, next.index);
      let best = -1, bestRoom = -Infinity;
      for (let k = 0; k < next.lanes.length; k++) {
        if (k === lane) continue;
        const c = this.connectorFor(link, veh.lane, next, k);
        const r = room(k, c.start - veh.pos, c) - need(c);
        if (r > bestRoom) { bestRoom = r; best = k; }
      }
      if (best < 0 || bestRoom < 0) return this.refuse(link, 'room', veh, next.index);
      lane = best;
      connector = this.connectorFor(link, veh.lane, next, lane);
      dist = connector.start - veh.pos;
    }

    const c = this.controls.get(link.to);
    if (c?.kind === 'signal') {
      const state = this.signalState(link.index);
      const canStop = dist > (veh.v * veh.v) / (2 * veh.type.comfortDecel);
      if (state === 'red' || (state === 'amber' && canStop)) return this.refuse(link, 'signal', veh, next.index);
    }

    if (this.conflictingClaim(veh, link, connector, false)) return this.refuse(link, 'conflict', veh, next.index);
    if (!withPartner && this.owesTurn(veh, link, connector)) return this.refuse(link, 'conflict', veh, next.index);

    if (c?.kind === 'signal') {
      // Permissive right turn: give way to opposing green traffic (gap acceptance)
      if (this.mustGiveWay(veh, link, next, connector, c, dist)) return this.refuse(link, 'give-way', veh, next.index);
    } else if (c?.kind === 'priority') {
      const yields = this.yieldsAt(link, next, c);
      // Traffic that gives way edges up to the line before judging the gap
      if (yields && dist > YIELD_LINE_M) return;
      if (this.mustGiveWay(veh, link, next, connector, c, dist)) return this.refuse(link, 'give-way', veh, next.index);
    }
    this.refuse(link, 'granted', veh);
    veh.pairCross = withPartner;
    this.reserve(veh, lane, connector);
  }

  /** Signed turn angle from `link` into `next` (degrees, anticlockwise positive: left turns positive, right turns negative). */
  private turnAngle(link: Link, next: Link): number {
    let d = next.headingStart - link.headingEnd;
    while (d > Math.PI) d -= 2 * Math.PI;
    while (d < -Math.PI) d += 2 * Math.PI;
    return (d * 180) / Math.PI;
  }

  /** India drives on the left: a right turn crosses the opposing stream. */
  private isRightTurn(link: Link, next: Link): boolean {
    return this.turnAngle(link, next) <= -TURN_ANGLE_DEG;
  }

  /** Whether `other`'s traffic has priority over `link`'s at a priority (unsignalised) junction or roundabout. */
  private hasPriorityOver(other: Link, link: Link, c: Control): boolean {
    // Roundabout: entering traffic gives way to traffic already circulating
    if (other.roundabout !== link.roundabout) return other.roundabout;
    if (c.majorRank !== null) return other.rank > link.rank;
    return false;
  }

  /** Whether movements from `link` give way at all (side road, roundabout entry, or a right turn across the main road). */
  private yieldsAt(link: Link, next: Link, c: Control): boolean {
    for (const [i, other] of this.incomingOf(link.to)) {
      if (i !== link.index && this.hasPriorityOver(other, link, c)) return true;
    }
    return this.isRightTurn(link, next);
  }

  /**
   * Whether the movement from `link` into `next` gives way to traffic from
   * `other` going into `otherNext` (the priority rules of mustGiveWay): at a
   * signal, a right turn to oncoming traffic that is not itself turning right;
   * at a priority junction, a lower-class road (or roundabout entry) to the
   * higher, and among equals a right turn to oncoming traffic.
   */
  private givesWayTo(link: Link, next: Link, other: Link, otherNext: Link, c: Control): boolean {
    const right = this.isRightTurn(link, next);
    const oncoming = angleBetweenDeg(other.headingEnd, link.headingEnd) > 135;
    if (c.kind === 'signal') return right && oncoming && !this.isRightTurn(other, otherNext);
    if (this.hasPriorityOver(other, link, c)) return true;
    return right && oncoming && !this.hasPriorityOver(link, other, c) && !this.isRightTurn(other, otherNext);
  }

  /**
   * Gap acceptance: true when a vehicle with priority over this movement will
   * reach a conflicting path sooner than the critical gap (Indo-HCM: 2.7 s for a
   * right turn from the main road or on green, 3.8 s from a minor road or
   * roundabout entry). Who has priority:
   *  - signal: oncoming green traffic that is not itself turning right, over a right turn;
   *  - priority junction: higher-class roads over lower; circulating roundabout
   *    traffic over entries; among equal roads, oncoming traffic over a right turn.
   */
  private mustGiveWay(veh: Vehicle, link: Link, next: Link, connector: LaneConnector, c: Control, dist: number): boolean {
    const myRight = this.isRightTurn(link, next);
    // Time to reach the line from where it is now, accelerating from its speed
    // (dist / max(v, 1 m/s) took a vehicle rolling up at walking pace 6 s for 6 m).
    // A driver waiting at the line (it stops 0.3 m short) is at it: the critical gap
    // is the gap such a driver accepts, its own start included.
    const timeToLine = timeToCover(Math.max(0, dist - AT_LINE_M), veh.v, veh.type.maxAccel, TURN_SPEED_MPS);
    for (const [otherIdx, other] of this.incomingOf(link.to)) {
      if (otherIdx === link.index) continue;
      let priority: boolean;
      let minor = false;
      if (c.kind === 'signal') {
        if (!myRight || this.signalState(otherIdx) !== 'green') continue;
        priority = angleBetweenDeg(other.headingEnd, link.headingEnd) > 135; // oncoming
      } else if (this.hasPriorityOver(other, link, c)) {
        priority = true;
        minor = true;
      } else {
        priority = myRight && !this.hasPriorityOver(link, other, c) && angleBetweenDeg(other.headingEnd, link.headingEnd) > 135;
      }
      if (!priority) continue;
      const tc = criticalGap(minor, veh.waitS) + timeToLine;
      for (let li = 0; li < other.lanes.length; li++) {
        for (const w of other.lanes[li]) {
          if (w.routeIdx >= w.route.length - 1) break; // leaves the area on this link
          const wNext = this.links[w.route[w.routeIdx + 1]];
          // Opposing right turns pass each other (left-hand traffic): an oncoming
          // right-turner does not hold up our right turn
          if (!minor && this.isRightTurn(other, wNext)) continue;
          const wConn = w.connector ?? this.connectorFor(other, li, wNext, Math.min(li, wNext.lanes.length - 1));
          const tArrive = (wConn.start - w.pos) / Math.max(w.v, 0.1);
          if (w.v < 0.5 && w.grantLane === null) {
            // Stopped on its approach: at a priority junction it waits for its own reasons;
            // on green it is about to move if it is at the front of the line.
            if (c.kind !== 'signal' || wConn.start - w.pos > 10) break;
          } else if (tArrive > tc) break; // vehicles behind arrive later still
          if (connectorsConflict(connector, wConn)) return true;
          break;
        }
      }
      // Vehicles from that approach already on their movement through the junction but
      // not yet at the crossing: the gap is measured to when they get there
      for (const r of this.reservations) {
        if (r.from !== otherIdx || r.node !== link.to || r.veh.reservation === r || r.veh.arriving?.connector !== r.connector) continue;
        if (!minor && this.isRightTurn(other, this.links[r.toLink])) continue;
        if (!connectorsConflict(connector, r.connector) || this.pastConflict(r.veh, r.connector, connector)) continue;
        if (this.timeToConflict(r.veh, r.connector, connector, 0.1) < tc) return true;
      }
    }
    return false;
  }

  /** Room a vehicle needs on the far side to be clear of the junction: past the end of its movement, its length and a standstill gap. */
  private exitNeed(veh: Vehicle, connector: LaneConnector): number {
    return connector.entry + veh.type.lengthM + veh.type.minGapM;
  }

  /**
   * Room in lane `k` of `next` that a vehicle `d` metres before its movement can
   * count on when it gets there: what is free now behind the lane's last vehicle,
   * plus how far a moving tail goes on meanwhile (the vehicle's own time to the
   * line and through the movement), less what vehicles already cleared into the
   * lane will take.
   *
   * Unless the lane's front vehicle is leaving it (cleared through the next
   * junction, or leaving the area), the tail can only go on as far as the lane
   * can close up: the vehicles in it packed nose to tail at their standstill gaps
   * against the lane's own stop line (`packedBack`). Before, a tail moving at
   * turning speed was projected 20-35 m on even when the lane ahead of it was a
   * 10 m link already full, so each follower saw the one before it still rolling,
   * entered, and stopped inside the junction holding its claim (docs/OVERHAUL.md
   * §18). A lane the next room owed to a longer-waiting vehicle on another
   * approach has no room for this one (`heldFor`).
   */
  private exitRoom(veh: Vehicle, next: Link, k: number, d: number, connector: LaneConnector): number {
    const target = next.lanes[k];
    const tail = target[target.length - 1];
    const free = this.backSpace(target);
    let ahead = 0;
    if (tail && rearMoving(target)) {
      const tArrive = timeToCover(Math.max(0, d) + connector.length, veh.v, veh.type.maxAccel, connector.turn ? TURN_SPEED_MPS : next.speed * veh.speedFactor);
      const front = target[0];
      // Leaving: it leaves the area at the end of this lane, or it is cleared through the
      // next junction and can no longer stop before its line. A cleared front that can
      // still stop may yet give its grant back (red, a crossing claim, its own exit
      // filling), and then everyone who entered on the room it was to leave stood in
      // the junction box behind it: on a 10 m link that blocked the box for good, the
      // crossing approaches waited on the claim and the two junctions locked each
      // other (docs/OVERHAUL.md §20)
      const leaving = front.routeIdx >= front.route.length - 1 || (front.grantLane !== null && this.committed(front));
      // Follow-up at an unsignalised junction: a tail still driving its own movement out
      // of this junction (the vehicle that went just before) pulls away, accelerating, not
      // at the crawl it has at this instant. Projecting it at its current speed held
      // each following side-road driver until the one ahead had all but finished its
      // turn: one vehicle per 5 s in a gap instead of a follow-up of about 3 s.
      const pulling = !!tail.arriving && this.controls.get(next.from)?.kind !== 'signal';
      const roll = pulling ? distanceIn(tArrive, tail.v, tail.type.maxAccel, (tail.arriving!.connector.turn ? TURN_SPEED_MPS : next.speed * tail.speedFactor)) : tail.v * tArrive;
      ahead = leaving ? roll : Math.min(roll, Math.max(0, this.packedBack(next, target) - free));
    }
    if (this.heldFor(next, k, veh)) return -Infinity;
    return free + ahead - this.pendingInto(next.index, k, veh);
  }

  /** A cleared vehicle that can no longer stop before its line (comfortable braking): it will cross. */
  private committed(veh: Vehicle): boolean {
    if (veh.grantLane === null || !veh.connector) return false;
    return veh.connector.start - veh.pos <= (veh.v * veh.v) / (2 * veh.type.comfortDecel);
  }

  /**
   * Front vehicles on other approaches to the junction at the start of `next`
   * that have waited longer than `veh`, and over MERGE_TURN_S, at their line for
   * room or for a gap: the ones whose turn it is (calls `each` with the vehicle,
   * its approach and the lane it would take; stops when `each` returns true).
   * Only a turn the other vehicle could take now counts: its signal is green,
   * and at a priority junction it does not give way to `veh`'s road. Waits are
   * strictly ordered, so two approaches can never each wait for the other.
   */
  private longerWaiting(node: string, mine: Link, veh: Vehicle, holds: readonly string[], each: (f: Vehicle, other: Link, lane: number) => boolean): boolean {
    const c = this.controls.get(node);
    if (!c) return false;
    const myNext = mine.to === node && veh.routeIdx < veh.route.length - 1 ? this.links[veh.route[veh.routeIdx + 1]] : null;
    for (const [idx, other] of this.incomingOf(node)) {
      if (idx === mine.index) continue;
      if (c.kind === 'signal' && this.signalState(idx) !== 'green') continue;
      if (c.kind === 'priority' && this.hasPriorityOver(mine, other, c)) continue;
      for (let li = 0; li < other.lanes.length; li++) {
        const f = other.lanes[li][0];
        if (!f || f.grantLane !== null || f.holdNext === undefined || f.waitS < MERGE_TURN_S || f.waitS <= veh.waitS) continue;
        if (!f.hold || !holds.includes(f.hold)) continue;
        // Never a turn against priority: a vehicle whose movement gives way to `veh`'s
        // (a right turn across oncoming traffic, at a signal or a priority junction) waits
        // for a gap however long it has waited
        if (myNext && this.givesWayTo(other, this.links[f.holdNext], mine, myNext, c)) continue;
        if (each(f, other, li)) return true;
      }
    }
    return false;
  }

  /**
   * Whether lane `k` of `next` is owed to a longer-waiting vehicle on another
   * approach (merging in turn). Without it, where two approaches feed one short
   * lane, whichever kept the lane's tail rolling took every gap: a turning
   * stream on a long movement always found room as its tail rolled on, and the
   * straight-on queue beside it was refused until its front vehicle was removed
   * as gridlock (docs/OVERHAUL.md §18).
   */
  private heldFor(next: Link, k: number, veh: Vehicle): boolean {
    return this.longerWaiting(next.from, this.links[veh.link], veh, ROOM_HOLDS, (f, other, li) => {
      if (f.holdNext !== next.index) return false;
      const [lo, hi] = this.mappedLanes(other, li, next);
      return k >= lo && k <= hi;
    });
  }

  /**
   * Whether `veh`'s movement would cross the path of a longer-waiting vehicle on
   * another approach (its turn to go). Among approaches that do not give way to
   * each other, a dense stream from one otherwise kept a claim on the junction
   * at every moment, and a vehicle on the other could wait until it was removed
   * as gridlock.
   */
  private owesTurn(veh: Vehicle, link: Link, connector: LaneConnector): boolean {
    // Only for a vehicle held by crossing traffic: one held because its own exit is full
    // gains nothing from the junction being left to it, and holding the crossing
    // movements for it spread its queue's standstill to every approach (§20)
    return this.longerWaiting(link.to, link, veh, CONFLICT_HOLDS, (f, other, li) => {
      const fNext = this.links[f.holdNext!];
      if (!fNext || f.route[f.routeIdx + 1] !== fNext.index) return false;
      return connectorsConflict(connector, this.connectorFor(other, li, fNext, this.mappedLanes(other, li, fNext)[0]));
    });
  }

  /**
   * Where the back of a lane's queue would be with every vehicle in it closed up
   * to its standstill gap behind the one ahead, the front one at its stop line
   * (or the end of the link, where it leaves the area). A rider abreast of its
   * partner takes no length of its own.
   */
  private packedBack(link: Link, lane: Vehicle[]): number {
    if (!lane.length) return Infinity;
    const front = lane[0];
    const reach = Math.max(front.pos, front.routeIdx >= front.route.length - 1 ? link.length : this.stopLine(front, link));
    let back = reach - front.type.lengthM;
    for (let i = 1; i < lane.length; i++) {
      const v = lane[i];
      if (v.abreast) continue;
      back -= v.type.minGapM + v.type.lengthM;
    }
    return Math.max(back, this.backSpace(lane));
  }

  /** Room in a lane already promised to vehicles cleared into it that have not reached it yet. */
  private pendingInto(linkIndex: number, lane: number, except: Vehicle): number {
    let m = 0;
    const before = except.reservation?.seq ?? Infinity;
    for (const r of this.reservations) {
      if (r.toLink !== linkIndex || r.toLane !== lane || r.veh === except || r.veh.reservation !== r || r.alongside || r.seq > before) continue;
      m += r.veh.type.lengthM + r.veh.type.minGapM;
    }
    return m;
  }

  private reserve(veh: Vehicle, lane: number, connector: LaneConnector) {
    veh.grantLane = lane;
    veh.connector = connector;
    const link = this.links[veh.link];
    if (this.controls.has(link.to)) {
      veh.reservation = { veh, vehId: veh.id, node: link.to, from: link.index, connector, toLink: veh.route[veh.routeIdx + 1], toLane: lane, alongside: !!veh.pairCross, seq: this.grantSeq++ };
      this.reservations.add(veh.reservation);
    }
  }

  /**
   * A live claim on `link.to` whose path crosses `connector`: a vehicle driving
   * its path, or (unless `drivingOnly`) one within CLAIM_AHEAD_S of its line.
   */
  private conflictingClaim(veh: Vehicle, link: Link, connector: LaneConnector, drivingOnly: boolean): boolean {
    for (const r of this.reservations) {
      if (r.vehId === veh.id || r.node !== link.to || r.from === link.index) continue;
      const approaching = r.veh.reservation === r;
      if (approaching && (drivingOnly || (r.connector.start - r.veh.pos) / Math.max(r.veh.v, 1) > CLAIM_AHEAD_S)) continue;
      if (connectorsConflict(connector, r.connector)) {
        // A vehicle on its movement whose rear is past the stretch where the two paths
        // meet no longer conflicts: the claim was on its whole path, so on a 50 m turn
        // through a large junction a stream of 2,000 veh/h kept a crossing side road out
        // for good although each vehicle was over the crossing point in about a second
        if (!approaching && this.pastConflict(r.veh, r.connector, connector)) continue;
        // ... nor, as on the approach, one more than CLAIM_AHEAD_S from that stretch
        if (!approaching && r.veh.arriving?.connector === r.connector && this.timeToConflict(r.veh, r.connector, connector) > CLAIM_AHEAD_S) continue;
        if (this.grantLog && !drivingOnly) this.refuse(link, `by ${this.links[r.from].id} ${approaching ? 'approaching' : 'in-box'} ${r.veh.v < 0.3 ? 'standing' : 'moving'} ${this.signalState(r.from) ?? 'nosig'}`);
        return true;
      }
    }
    return false;
  }

  private readonly spans = new WeakMap<LaneConnector, Map<LaneConnector, [number, number]>>();
  /**
   * How far along `c` (m) a vehicle driving it must get, rear first, to be clear
   * of `other`'s path (within the conflict distance connectorsConflict uses):
   * where the paths last meet when they cross; where they first meet when they
   * merge (both end in the same place: from there the one behind follows the one
   * ahead in its lane, and room in that lane is the room check's business).
   * -Infinity when they never meet. Also where they first meet (`conflictSpan`).
   */
  private conflictEnd(c: LaneConnector, other: LaneConnector): number {
    return this.conflictSpan(c, other)[1];
  }

  private conflictSpan(c: LaneConnector, other: LaneConnector): [number, number] {
    let m = this.spans.get(c);
    if (!m) { m = new Map(); this.spans.set(c, m); }
    let span = m.get(other);
    if (span === undefined) {
      let first = -Infinity, last = -Infinity;
      const kx = 111320 * Math.cos(c.points[0].lat * Math.PI / 180);
      const near = (p: LanePose, q: LanePose) => Math.abs(p.z - q.z) <= 3 && Math.hypot((p.lng - q.lng) * kx, (p.lat - q.lat) * 111320) < 2.3;
      for (let i = 0; i < c.points.length; i++) {
        if (other.points.some(q => near(c.points[i], q))) { if (first === -Infinity) first = c.distances[i]; last = c.distances[i]; }
      }
      const merging = near(c.points[c.points.length - 1], other.points[other.points.length - 1]);
      span = [first, merging ? first : last];
      m.set(other, span);
    }
    return span;
  }

  /**
   * Seconds until a vehicle driving movement `c` reaches, front first, where `c`
   * meets `other` (0 once there; at least 1 m/s assumed, as for claims on approach).
   */
  private timeToConflict(veh: Vehicle, c: LaneConnector, other: LaneConnector, minV = 1): number {
    const frontAlong = veh.pos - (c.entry - c.length);
    return Math.max(0, this.conflictSpan(c, other)[0] - frontAlong) / Math.max(veh.v, minV);
  }

  /** Whether a vehicle driving movement `c` has its rear past where `c` meets `other` (with a 1 m margin). */
  private pastConflict(veh: Vehicle, c: LaneConnector, other: LaneConnector): boolean {
    if (veh.arriving?.connector !== c) return false;
    // On the next link the movement starts at entry - length (see crossJunction)
    const rearAlong = veh.pos - (c.entry - c.length) - veh.type.lengthM;
    return rearAlong > this.conflictEnd(c, other) + 1;
  }

  /**
   * A cleared vehicle still able to stop before its line whose exit lane can no
   * longer take it even with every vehicle there closed up (the queue reached
   * back while it approached): it gives its grant back rather than enter and stop
   * inside the junction (keep the box clear). Only the lane's capacity counts
   * here, not the tail's motion: re-judging a moving tail over the shrinking time
   * to the line would hold back every follower of a discharging platoon.
   */
  private lostExitRoom(veh: Vehicle): boolean {
    const next = this.links[veh.route[veh.routeIdx + 1]];
    const lane = next.lanes[veh.grantLane!];
    return this.packedBack(next, lane) - this.pendingInto(next.index, veh.grantLane!, veh) < this.exitNeed(veh, veh.connector!);
  }

  /** Withdraws a grant not yet used (e.g. the signal turned red before the stop line). */
  private revokeGrant(veh: Vehicle) {
    if (veh.reservation) this.reservations.delete(veh.reservation);
    veh.reservation = null;
    veh.connector = null;
    veh.grantLane = null;
    veh.pairCross = false;
  }

  /** Frees every junction claimed by a vehicle leaving the network. */
  private releaseAll(veh: Vehicle) {
    if (veh.reservation) this.reservations.delete(veh.reservation);
    if (veh.arriving?.reservation) this.reservations.delete(veh.arriving.reservation);
    veh.reservation = null;
    veh.arriving = null;
  }

  private connectorFor(link: Link, lane: number, next: Link, nextLane: number): LaneConnector {
    const key = `${link.index}:${lane}>${next.index}:${nextLane}`;
    let c = this.movements.get(key);
    if (!c) {
      const turn = angleBetweenDeg(link.headingEnd, next.headingStart) >= TURN_ANGLE_DEG;
      const trim = turn ? Math.max(6, link.laneWidth * link.lanes.length + link.medianHalf) : 2;
      const start = link.length - Math.min(trim, link.length * 0.2);
      const entry = Math.min(turn ? Math.max(6, next.laneWidth * next.lanes.length + next.medianHalf) : 2, next.length * 0.2);
      const blank = () => ({ lng: 0, lat: 0, z: 0, heading: 0, pitch: 0 });
      c = { ...makeLaneConnector(this.place(link, lane, start, blank()), this.place(next, nextLane, entry, blank()), start, entry), turn };
      this.movements.set(key, c);
    }
    return c;
  }

  private stopLine(veh: Vehicle, link: Link): number {
    if (veh.routeIdx >= veh.route.length - 1) return link.length;
    const next = this.links[veh.route[veh.routeIdx + 1]];
    return this.connectorFor(link, veh.lane, next, this.mappedLanes(link, veh.lane, next)[0]).start;
  }

  /**
   * The lanes of `next` that lane `lane` of `link` leads to, keeping the order of
   * lanes (kerb lane to kerb lane): the lanes of `next` its share of the
   * carriageway spans. Where a road gains lanes one lane leads to several, where
   * it loses lanes several lead to one (the lane connections of a junction or
   * widening, as SUMO builds them).
   */
  private mappedLanes(link: Link, lane: number, next: Link): [number, number] {
    const m = link.lanes.length, n = next.lanes.length;
    if (m === n) return [lane, lane];
    const lo = Math.min(n - 1, Math.floor((lane * n) / m));
    const hi = Math.max(lo, Math.min(n - 1, Math.ceil(((lane + 1) * n) / m) - 1));
    return [lo, hi];
  }

  /** The emptiest of the lanes `lane` leads to (the lowest index on a tie, so it is repeatable). */
  private mappedLane(link: Link, lane: number, next: Link): number {
    const [lo, hi] = this.mappedLanes(link, lane, next);
    let best = lo;
    for (let k = lo + 1; k <= hi; k++) if (this.backSpace(next.lanes[k]) > this.backSpace(next.lanes[best])) best = k;
    return best;
  }

  /** How far along `link` a vehicle may be drawn: onto its granted movement, if it has one. */
  private movementEnd(veh: Vehicle, link: Link): number {
    return veh.connector ? veh.connector.start + veh.connector.length : link.length;
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
    if (veh.arriving?.connector.turn && veh.pos < veh.arriving.connector.entry) return Math.min(v0, TURN_SPEED_MPS);
    if (veh.routeIdx >= veh.route.length - 1 || dist > TURN_SLOWDOWN_M) return v0;
    const next = this.links[veh.route[veh.routeIdx + 1]];
    if (angleBetweenDeg(link.headingEnd, next.headingStart) < TURN_ANGLE_DEG) return v0;
    // Past the stop line (on the turn itself) `dist` is negative: hold turning
    // speed. Extrapolating the ramp would ask for a speed below zero and stall
    // the vehicle inside the junction, holding its reservation.
    return Math.min(v0, TURN_SPEED_MPS + (Math.max(0, dist) / TURN_SLOWDOWN_M) * (v0 - TURN_SPEED_MPS));
  }

  /** Advances the simulation by one step. */
  public step() {
    const dt = STEP_S;
    this.spawnDue();
    this.insertQueued();
    const active = this.activeLinks();

    // 1. Vehicles near a junction ask to cross: the front vehicle of each lane and,
    // behind a vehicle already cleared to cross, the next one too (a queue
    // discharges as a platoon on green, each driver following the one ahead over
    // the line rather than stopping at it until the one ahead has gone). Each
    // grant is checked on its own: signal, conflicts, room on the far side.
    for (const link of active) {
      for (const lane of link.lanes) {
        // Platoon grants at signals only: there the discharge rate of a standing queue
        // was measured against Indo-HCM; elsewhere only the front vehicle asks
        const platoon = this.controls.get(link.to)?.kind === 'signal' ? PLATOON_GRANTS : 1;
        // Every grant not yet used is checked, not only the front one's: a platoon
        // cleared on green that has not reached the line when the signal turns red
        // gives its grants back (otherwise those standing at a red line keep claims
        // that block the movements of the next phase).
        // A follower can be past the start of its own turn (a turn starts further
        // back than the straight-on line) while still queued behind a leader that
        // has no grant: it has not entered the junction, so it is treated as not
        // past its line.
        for (let i = 0; i < lane.length; i++) {
          const veh = lane[i];
          if (veh.grantLane === null) continue;
          const queuedBehind = i > 0 && lane[i - 1].grantLane === null && !lane[i - 1].arriving;
          if (veh.connector && (veh.pos < veh.connector.start || queuedBehind)) {
            const signal = this.signalState(link.index);
            const distance = queuedBehind ? Infinity : veh.connector.start - veh.pos;
            const canStop = distance > veh.v * veh.v / (2 * veh.type.comfortDecel);
            if (signal === 'red' || (signal === 'amber' && canStop) ||
              (canStop && veh.reservation && this.conflictingClaim(veh, link, veh.connector, true)) ||
              (canStop && !veh.pairCross && !queuedBehind && this.lostExitRoom(veh))) this.revokeGrant(veh);
          }
        }
        for (let i = 0; i < lane.length && i < platoon; i++) {
          const veh = lane[i];
          if (veh.routeIdx >= veh.route.length - 1) break;
          if (veh.grantLane !== null) continue;
          const dist = this.stopLine(veh, link) - veh.pos;
          // Followers ask only once near their line (the front one asks early where there is no control)
          const near = dist <= (veh.v * veh.v) / (2 * veh.type.comfortDecel) + 15;
          if (near || (i === 0 && !this.controls.has(link.to))) this.tryGrant(veh, link, dist);
          // Only a cleared vehicle lets the one behind it ask
          if (veh.grantLane === null) break;
        }
      }
    }

    // 2. Accelerations from the current state
    for (const link of active) {
      for (const lane of link.lanes) {
        for (let i = 0; i < lane.length; i++) {
          const veh = lane[i];
          // Lateral filtering: a two-wheeler close behind a lone two-wheeler rides beside
          // it, at most two abreast. Pairs are kept from step to step (not re-derived from
          // the order in the lane, which flips every pair behind when the front one
          // leaves and would put a rider that was alongside its partner on top of it).
          // A pair forms only behind a rider that has no partner and when no one rides
          // beside this vehicle, so a rider never leaves a pair while ahead of the
          // vehicle it must then follow.
          const ahead = i > 0 ? lane[i - 1] : null;
          if (!ahead) veh.abreast = false;
          else if (veh.abreast) { if (ahead.type.kind !== 'two_wheeler' || ahead.abreast) veh.abreast = false; }
          else if (this.abreastEnabled && veh.type.kind === 'two_wheeler' && ahead.type.kind === 'two_wheeler' && !ahead.abreast && !lane[i + 1]?.abreast) veh.abreast = true;
          const abreast = !!veh.abreast;
          const li = abreast ? i - 2 : i - 1;
          const dist = this.stopLine(veh, link) - veh.pos;
          // A stop line is not a vehicle: the standstill gap s0 is kept to the vehicle
          // ahead, not to a painted line, so a vehicle held at a line stops at it (0.3 m
          // short) rather than s0 back (2 m for a car, which cost a driver waiting for a
          // gap two seconds to reach the line once it accepted one)
          const lineGap = dist - 0.3 + veh.type.minGapM;
          let gap: number;
          let vLead: number;
          if (i > 0 && li < 0) {
            // Alongside the front vehicle: it stops at the line until cleared itself
            const exiting = veh.routeIdx >= veh.route.length - 1;
            gap = exiting || veh.grantLane !== null ? 1e6 : lineGap;
            vLead = exiting || veh.grantLane !== null ? veh.v : 0;
          } else if (i > 0) {
            const lead = lane[li];
            gap = lead.pos - lead.type.lengthM - veh.pos;
            vLead = lead.v;
            // The leader stays on this link until it finishes its turn, so it can be
            // past the stop line. Its clearance is its own: a follower not yet cleared
            // stops at the line.
            if (veh.routeIdx < veh.route.length - 1 && veh.grantLane === null && lineGap < gap) {
              gap = lineGap;
              vLead = 0;
            }
          } else if (veh.routeIdx >= veh.route.length - 1) {
            gap = 1e6; // leaves the area at the end of this link
            vLead = veh.v;
          } else if (veh.grantLane === null) {
            gap = lineGap; // stop line
            vLead = 0;
          } else {
            const next = this.links[veh.route[veh.routeIdx + 1]];
            const last = next.lanes[veh.grantLane][next.lanes[veh.grantLane].length - 1];
            // Past the stop line it continues `connector.length - entry` behind the next link's start
            const c = veh.connector!;
            gap = last ? last.pos - last.type.lengthM - (c.entry - c.length + veh.pos - c.start) : dist + 200;
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
            const li = veh.abreast ? i - 2 : i - 1;
            const lead = li >= 0 ? lane[li] : null;
            limit = lead ? lead.pos - lead.type.lengthM - 0.2 : Infinity;
            // Never pass the partner it rides beside
            if (veh.abreast) limit = Math.min(limit, lane[i - 1].pos - 0.05);
            if (pos > limit) v = Math.min(v, lead ? lead.v : lane[i - 1].v);
            if (veh.routeIdx < veh.route.length - 1 && veh.grantLane === null) {
              const line = this.stopLine(veh, link) - 0.1;
              if (line < limit) {
                limit = line;
                if (pos > limit) v = 0;
              }
            }
          } else if (veh.routeIdx < veh.route.length - 1 && veh.grantLane === null) {
            limit = this.stopLine(veh, link) - 0.1;
            if (pos > limit) v = 0;
          }
          if (pos > limit) pos = Math.max(veh.pos, limit);
          veh.v = v;
          veh.odo += pos - veh.pos;
          veh.pos = pos;
          if (veh.arriving && veh.pos >= veh.arriving.connector.entry) {
            if (veh.arriving.reservation) this.reservations.delete(veh.arriving.reservation);
            veh.arriving = null;
          }
          this.trackWaiting(veh, dt);
        }
      }
    }

    if (this.analysis) this.attributeHolds(active, dt);

    // 4. Cross junctions, leave the area, clear gridlock
    for (const link of active) {
      for (const lane of link.lanes) {
        const veh = lane[0];
        if (!veh) continue;
        const exiting = veh.routeIdx >= veh.route.length - 1;
        if (exiting && veh.pos >= link.length) {
          lane.shift();
          this.onNetworkCount--;
          this.releaseAll(veh);
          this.finishTrip(veh);
        } else if (!exiting && veh.connector && veh.pos >= veh.connector.start) {
          this.crossJunction(veh, lane);
        } else if (veh.waitS > GRIDLOCK_S) {
          const { place, cause } = this.stuckReason(veh, link);
          if (!veh.gridlocked) {
            veh.gridlocked = true;
            this.gridlockEvents++;
            this.gridlockByPlace[place]++;
            this.gridlockByCause[cause]++;
          }
          if (this.removeStuck) {
            lane.shift();
            this.onNetworkCount--;
            this.gridlockRemovals++;
            this.stuckByPlace[place]++;
            this.stuckByCause[cause]++;
            this.releaseAll(veh);
          }
        }
      }
    }

    this.t += dt;
    if (this.t >= this.nextSampleT) {
      this.nextSampleT = this.t + 5;
      this.sampleJunctions(active);
    }
  }

  /**
   * Delay attribution (analysis window): every vehicle queued (under 1 m/s, in
   * an unbroken line from the front) behind a front vehicle that is waiting to
   * cross is charged to why the front vehicle waits: a red signal, no room on
   * the link ahead (a queue reaching back from further on: blocked), giving
   * way, or a conflicting movement in the junction. Blocked time also records
   * the link that had no room, so a queue can be traced to where it starts.
   */
  private attributeHolds(active: Link[], dt: number) {
    const a = this.analysis!;
    for (const link of active) {
      for (const lane of link.lanes) {
        const front = lane[0];
        if (!front || front.v >= 0.5 || front.grantLane !== null || front.routeIdx >= front.route.length - 1 || !front.hold) continue;
        let n = 0;
        for (const v of lane) { if (v.v >= 1) break; n++; }
        const cause: HoldCause = front.hold === 'signal' ? 'signal' : front.hold === 'room' || front.hold === 'room-wait' ? 'blocked' : front.hold === 'give-way' ? 'giveWay' : 'conflict';
        a.hold[cause][link.index] += n * dt;
        if (cause === 'blocked' && front.holdNext !== undefined) {
          const m = a.blockedBy.get(link.index) ?? a.blockedBy.set(link.index, new Map()).get(link.index)!;
          m.set(front.holdNext, (m.get(front.holdNext) ?? 0) + n * dt);
        }
      }
    }
  }

  private perfOf(node: string) {
    let p = this.junctionPerf.get(node);
    if (!p) {
      p = { controlDelayS: 0, vehicles: 0, pcu: 0, queueSumM: 0, queueMaxM: 0, samples: 0, lastCrossT: 0 };
      this.junctionPerf.set(node, p);
    }
    return p;
  }

  /**
   * Every 5 simulated seconds: queue length per controlled junction (the longest
   * approach lane: from the stop line back to the last vehicle in an unbroken line
   * of vehicles under 5 km/h), and deadlock detection. A junction is deadlocked
   * when nothing has crossed it for DEADLOCK_S while vehicles have stood at two or
   * more of its approaches, or inside its box, for that long.
   */
  private sampleJunctions(active: Link[]) {
    const queue = new Map<string, number>();
    const stuckApproaches = new Map<string, number>();
    for (const link of active) {
      if (!this.controls.has(link.to)) continue;
      let worst = 0;
      let stuck = false;
      for (const lane of link.lanes) {
        let back = -1;
        for (const v of lane) {
          if (v.v > 1.4) break;
          back = v.pos - v.type.lengthM;
        }
        if (back >= 0 || lane.length && lane[0].v <= 1.4) worst = Math.max(worst, Math.max(0, link.length - Math.max(0, back)));
        if (lane[0] && lane[0].waitS >= DEADLOCK_S) stuck = true;
        // Inside the box: still driving the movement of the junction behind it
        for (const v of lane) {
          if (v.arriving && v.v < 0.1) this.maxStuckInBoxS = Math.max(this.maxStuckInBoxS, v.waitS);
        }
      }
      if (worst > 0) queue.set(link.to, Math.max(queue.get(link.to) ?? 0, worst));
      if (stuck) stuckApproaches.set(link.to, (stuckApproaches.get(link.to) ?? 0) + 1);
    }
    for (const [node] of this.controls) {
      const p = this.perfOf(node);
      const q = queue.get(node) ?? 0;
      p.queueSumM += q;
      p.queueMaxM = Math.max(p.queueMaxM, q);
      p.samples++;
      const dead = (stuckApproaches.get(node) ?? 0) >= 2 && this.t - p.lastCrossT >= DEADLOCK_S;
      if (dead && !this.deadlocked.has(node)) { this.deadlocked.add(node); this.deadlockEvents++; }
      else if (!dead) this.deadlocked.delete(node);
    }
  }

  /**
   * Per controlled junction: vehicles and PCU crossed, mean control delay
   * (s/veh), mean and max queue (m), and level of service from control delay.
   * LOS thresholds are HCM 2000 (Exhibit 16-2 signalised: A<=10, B<=20, C<=35,
   * D<=55, E<=80 s; Exhibit 17-2 two-way-stop: A<=10, B<=15, C<=25, D<=35,
   * E<=50 s). The Indo-HCM 2017 Table 6.7 thresholds could not be checked
   * against an accessible copy, so they are not used.
   */
  public junctionStats(): { id: string; lng: number; lat: number; signalised: boolean; vehicles: number; pcu: number; meanControlDelayS: number; meanQueueM: number; maxQueueM: number; los: string }[] {
    const out: ReturnType<TrafficMicroSim['junctionStats']> = [];
    this.junctionPerf.forEach((p, id) => {
      const c = this.controls.get(id);
      if (!c || p.vehicles === 0) return;
      const members = this.junctionMembers.get(id) ?? [id];
      const cs = members.map(m => this.areaNodes.get(m)?.coordinates).filter((x): x is [number, number, number] => !!x);
      if (!cs.length) return;
      const delay = p.controlDelayS / p.vehicles;
      out.push({ id, lng: cs.reduce((a, q) => a + q[0], 0) / cs.length, lat: cs.reduce((a, q) => a + q[1], 0) / cs.length,
        signalised: c.kind === 'signal', vehicles: p.vehicles, pcu: Math.round(p.pcu), meanControlDelayS: delay,
        meanQueueM: p.samples ? p.queueSumM / p.samples : 0, maxQueueM: p.queueMaxM, los: losFor(delay, c.kind === 'signal') });
    });
    return out.sort((a, b) => b.vehicles - a.vehicles);
  }

  /** Deadlock detector: events so far, junctions deadlocked now, longest wait inside a junction box (s). */
  public deadlockReport(): { events: number; current: string[]; maxStuckInBoxS: number; gridlockRemovals: number } {
    return { events: this.deadlockEvents, current: [...this.deadlocked], maxStuckInBoxS: this.maxStuckInBoxS, gridlockRemovals: this.gridlockRemovals };
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
      veh.linkStopS = (veh.linkStopS ?? 0) + dt;
      if (veh.wasMoving) {
        veh.stops++;
        veh.wasMoving = false;
      }
    } else {
      veh.waitS = 0;
      if (veh.v > 2) veh.wasMoving = true;
    }
  }

  /**
   * At the stop line a granted vehicle moves onto its next link, where it
   * drives the rest of its movement (the lane connector) before the link's
   * own lane begins at `connector.entry`.
   */
  /** Restores the order of a lane after its front vehicle was put back: nobody overlaps or passes the one ahead. */
  private keepBehind(lane: Vehicle[]) {
    for (let i = 1; i < lane.length; i++) {
      const v = lane[i];
      const lead = v.abreast ? lane[i - 2] : lane[i - 1];
      let limit = lead ? lead.pos - lead.type.lengthM - 0.2 : Infinity;
      if (v.abreast) limit = Math.min(limit, lane[i - 1].pos - 0.05);
      if (v.pos > limit) { v.pos = Math.max(0, limit); v.v = Math.min(v.v, (lead ?? lane[i - 1]).v); }
      else break;
    }
  }

  private crossJunction(veh: Vehicle, lane: Vehicle[]) {
    veh.hold = undefined; veh.holdNext = undefined;
    const c = veh.connector!;
    const nextIdx = veh.route[veh.routeIdx + 1];
    const next = this.links[nextIdx];
    const target = next.lanes[veh.grantLane!];
    // Measured along the next link, the movement starts at entry - length (negative
    // when the turn is longer than the stretch of the next link it covers)
    const moveStart = c.entry - c.length;
    let pos = moveStart + (veh.pos - c.start);
    // A rider crossing beside its partner enters the next lane alongside it (still
    // behind the vehicle ahead of the pair), so the pair stays side by side. Only
    // while the partner is still beside it: a partner that has already ridden on
    // (it crossed first and pulled away) leaves this rider to cross on its own,
    // subject to room like anyone else. (Before, a rider whose partner had gone was
    // refused every step until the signal turned red: placed "beside" a partner far
    // ahead it always landed behind the start of the movement, so the lane stalled.)
    const tailV = target[target.length - 1];
    const besideTail = !!veh.pairCross && !!tailV && tailV.type.kind === 'two_wheeler' && !tailV.abreast && veh.type.kind === 'two_wheeler'
      && tailV.pos - pos <= tailV.type.lengthM;
    if (besideTail) {
      const front = target[target.length - 2];
      pos = Math.min(pos, tailV.pos - 0.05, front ? front.pos - front.type.lengthM - 0.2 : Infinity);
    }
    if (besideTail ? pos < moveStart - 0.01 : pos > this.backSpace(target) - 0.2) {
      // Another vehicle took the space this step: wait at the stop line. It is put
      // back a little, so the vehicles behind it (who may already be cleared and
      // close behind) are kept behind it too.
      veh.pos = c.start - 0.01;
      veh.v = 0;
      this.keepBehind(lane);
      return;
    }
    lane.shift();
    if (this.countLayouts.length) this.countCrossing(veh, veh.link, nextIdx);
    const fromLink = this.links[veh.link];
    const crossed = fromLink.to;
    const d = this.junctionDelay.get(crossed) ?? { stopS: 0, vehicles: 0 };
    d.stopS += veh.linkStopS ?? 0;
    d.vehicles++;
    this.junctionDelay.set(crossed, d);
    const perf = this.perfOf(crossed);
    const driven = Math.max(0, veh.pos - (veh.linkEnterPos ?? 0));
    perf.controlDelayS += Math.max(0, this.t - (veh.linkEnterT ?? this.t) - driven / Math.max(1, fromLink.speed * veh.speedFactor));
    perf.vehicles++;
    perf.pcu += veh.type.pcu;
    perf.lastCrossT = this.t;
    // Link travel time for assignment feedback: time on the link scaled to its full length
    if (driven > 0.5 * fromLink.length) {
      this.linkTimeSum[veh.link] += (this.t - (veh.linkEnterT ?? this.t)) * fromLink.length / driven;
      this.linkTimeN[veh.link]++;
    }
    veh.linkStopS = 0;
    veh.link = nextIdx;
    veh.lane = next.lanes.indexOf(target);
    veh.pos = pos;
    veh.linkEnterT = this.t;
    veh.linkEnterPos = Math.max(0, pos);
    veh.routeIdx++;
    veh.arriving = { connector: c, reservation: veh.reservation };
    veh.abreast = besideTail;
    veh.pairCross = false;
    veh.grantLane = null;
    veh.connector = null;
    veh.reservation = null;
    target.push(veh);
    this.busy.add(nextIdx);
    this.noteLink(veh, nextIdx);
  }

  private finishTrip(veh: Vehicle) {
    this.completed++;
    if (this.edgeExits.has(this.links[veh.link].to)) this.exitedAtEdge++;
    const travelTime = this.t - veh.departT;
    this.delaySum += travelTime / Math.max(veh.freeFlowS, 1);
    this.travelTimeSum += travelTime;
    this.excessTimeSum += Math.max(0, travelTime - veh.freeFlowS);
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
      meanTravelTimeS: this.completed > 0 ? this.travelTimeSum / this.completed : null,
      meanDelayS: this.completed > 0 ? this.excessTimeSum / this.completed : null,
      stopsPerTrip: this.completed > 0 ? this.stopsSum / this.completed : null,
      gridlockRemovals: this.gridlockRemovals,
      accounting: this.accounting(n),
      unroutable: this.unroutable,
      entries: this.explicitDemand ? new Set(this.odArrivals.filter(a => a.route.length).map(a => a.trip.fromNodeId)).size : this.sources.filter(s => s.ratePerS > 0).length,
      exits: this.explicitDemand ? new Set(this.odArrivals.filter(a => a.route.length).map(a => a.trip.toNodeId)).size : this.sinks.length,
      signals: [...this.controls.values()].filter(c => c.kind === 'signal').length,
      inflowVph: this.explicitDemand ? Math.round(this.odArrivals.reduce((n, a) => n + a.trip.vehiclesPerHour, 0) * this.demandLevel * this.hourFactor / OD_REFERENCE_LEVEL) : Math.round((this.sources.reduce((a, s) => a + s.ratePerS, 0) * this.demandLevel * this.hourFactor + this.focusRatePerS) * 3600),
      focusVph: Math.round(this.focusRatePerS * 3600),
      watched: {
        onRoad: onWatched,
        passed: this.watchedPassed,
        meanSpeedKmh: onWatched > 0 ? (watchedSpeedSum / onWatched) * 3.6 : null,
      },
    };
  }

  /** What became of every vehicle created so far (see VehicleAccounting). */
  private accounting(inNetwork: number): VehicleAccounting {
    let gridlockedNow = 0;
    for (const i of this.busy) for (const lane of this.links[i].lanes) if (lane[0] && lane[0].waitS > GRIDLOCK_S) gridlockedNow++;
    return {
      generated: this.generated,
      waitingAtEdge: this.sources.reduce((a, s) => a + s.queue.length, 0),
      spawned: this.spawned,
      completedAtDestination: this.completed - this.exitedAtEdge,
      exitedAtEdge: this.exitedAtEdge,
      timeouts: 0,
      stuckRemovals: this.gridlockRemovals,
      stuckRemovalsByPlace: { ...this.stuckByPlace },
      stuckRemovalsByCause: { ...this.stuckByCause },
      inNetwork,
      stuckRemovalEnabled: this.removeStuck,
      gridlockEvents: this.gridlockEvents,
      gridlockEventsByPlace: { ...this.gridlockByPlace },
      gridlockEventsByCause: { ...this.gridlockByCause },
      gridlockedNow,
    };
  }

  /**
   * Where a front vehicle that has stood GRIDLOCK_S stands and what it waits on
   * (from its last refused request to cross; see `refuse`).
   */
  private stuckReason(veh: Vehicle, link: Link): { place: StuckPlace; cause: StuckCause } {
    const exiting = veh.routeIdx >= veh.route.length - 1;
    const place: StuckPlace = veh.arriving ? 'box' : !exiting && this.stopLine(veh, link) - veh.pos < 3 ? 'approach' : 'link';
    let cause: StuckCause;
    if (veh.grantLane !== null) cause = 'blockedExit'; // cleared, but its exit lane did not take it
    else switch (veh.hold) {
      case 'signal': cause = 'redSignal'; break;
      case 'give-way': cause = 'priorityGap'; break;
      case 'conflict': cause = 'crossingTraffic'; break;
      case 'room': case 'room-wait': cause = 'blockedExit'; break;
      default: cause = 'other';
    }
    return { place, cause };
  }

  /** Junctions with front vehicles standing GRIDLOCK_S or longer now, worst first (gridlock left in place is reported here). */
  public gridlockSites(): GridlockSite[] {
    const by = new Map<string, GridlockSite>();
    for (const i of this.busy) {
      const link = this.links[i];
      for (const lane of link.lanes) {
        const veh = lane[0];
        if (!veh || veh.waitS <= GRIDLOCK_S) continue;
        const { place, cause } = this.stuckReason(veh, link);
        // A vehicle inside a box stands at the junction behind it
        const node = place === 'box' ? link.from : link.to;
        let s = by.get(node);
        if (!s) {
          const c = this.nodeCoordinates(this.junctionMembers.get(node)?.[0] ?? node);
          s = { node, lng: c?.[0] ?? 0, lat: c?.[1] ?? 0, vehicles: 0, longestS: 0, causes: {}, places: {} };
          by.set(node, s);
        }
        s.vehicles++;
        s.longestS = Math.max(s.longestS, veh.waitS);
        s.causes[cause] = (s.causes[cause] ?? 0) + 1;
        s.places[place] = (s.places[place] ?? 0) + 1;
      }
    }
    return [...by.values()].sort((a, b) => b.vehicles - a.vehicles || b.longestS - a.longestS || (a.node < b.node ? -1 : 1));
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

  private readonly view: VehicleView = { id: 0, kind: 'car', lng: 0, lat: 0, z: 0, heading: 0, pitch: 0, speedRatio: 0, speedKmh: 0, opacity: 1, focus: false };

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
          const ahead = k > 0 ? (v.abreast ? lane[k - 2] : lane[k - 1]) : undefined;
          const limit = k > 0
            ? Math.min(ahead ? ahead.pos - ahead.type.lengthM - 0.2 : Infinity, v.abreast ? lane[k - 1].pos - 0.05 : Infinity, exiting || v.grantLane !== null ? Infinity : this.stopLine(v, l) - 0.1)
            : !exiting && v.grantLane === null ? this.stopLine(v, l) - 0.1 : this.movementEnd(v, l);
          const extra = Math.max(0, Math.min(v.v * aheadS, limit - v.pos));
          const pos = v.pos + extra;
          // `pos` is the front bumper; models are drawn about their centre, so a
          // queue stops behind its stop line rather than half a vehicle over it.
          const centre = pos - v.type.lengthM / 2;
          if (v.connector && centre >= v.connector.start) sampleLaneConnector(v.connector, centre - v.connector.start, view);
          else if (v.arriving && centre < v.arriving.connector.entry) {
            const c = v.arriving.connector;
            const along = centre - (c.entry - c.length);
            sampleLaneConnector(c, Math.max(0, along), view);
            if (along < 0) {
              // Its back half has not reached the movement yet: carry on back along its heading
              view.lng += (Math.cos(view.heading) * along) / mPerDegLng(view.lat);
              view.lat += (Math.sin(view.heading) * along) / M_PER_DEG_LAT;
            }
          } else this.place(l, li, Math.max(0, centre), view);
          // A pair riding abreast shares the lane: the rider alongside on the kerb side
          // (the driver's left), its partner on the median side, ABREAST_OFFSET_M either
          // side of the lane centre
          const side = v.abreast ? ABREAST_OFFSET_M : lane[k + 1]?.abreast ? -ABREAST_OFFSET_M : 0;
          if (side !== 0) {
            view.lng -= (Math.sin(view.heading) * side) / mPerDegLng(view.lat);
            view.lat += (Math.cos(view.heading) * side) / M_PER_DEG_LAT;
          }
          view.id = v.id;
          view.kind = v.type.kind;
          view.speedRatio = Math.min(1, v.v / l.speed);
          view.speedKmh = v.v * 3.6;
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
  public debugLanes(): Map<string, DebugVehicle[][]> {
    const out = new Map<string, DebugVehicle[][]>();
    for (const l of this.links) {
      out.set(l.id, l.lanes.map(lane => lane.map(v => ({ id: v.id, pos: v.pos, v: v.v, length: v.type.lengthM, kind: v.type.kind,
        stopLine: this.stopLine(v, l), crossing: v.arriving !== null, abreast: !!v.abreast }))));
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

  /** OD rates at Normal volume, frozen for repeatable comparisons independent of road capacity edits. */
  // ── Observed-count calibration ───────────────────────────────────────────

  /** Both ends of every link, for laying out count zones. */
  public linkEnds(): LinkEnds[] {
    return this.links.map(l => ({ index: l.index, id: l.id, from: l.pts[0], to: l.pts[l.pts.length - 1], pts: l.pts, fromNode: l.from, toNode: l.to, roadId: l.roadId, rank: l.rank, lanes: l.lanes.length }));
  }

  /**
   * The core of a counted junction, whose stop lines the survey counts at: the
   * ring of a roundabout inside the zone (every node of the roundabout links
   * connected to it), else the controlled junction (three or more arms; a
   * joined node cluster counts as one) nearest the zone centre. Empty when
   * neither lies in the zone.
   */
  private zoneCore(zone: CountZone): Set<string> {
    const pos = (id: string) => {
      const members = this.junctionMembers.get(id) ?? [id];
      const cs = members.map(m => this.areaNodes.get(m)?.coordinates).filter((x): x is [number, number, number] => !!x);
      return cs.length ? [cs.reduce((a, p) => a + p[0], 0) / cs.length, cs.reduce((a, p) => a + p[1], 0) / cs.length] : null;
    };
    const dist = (id: string) => {
      const p = pos(id);
      if (!p) return Infinity;
      return Math.hypot((p[0] - zone.lng) * mPerDegLng(zone.lat), (p[1] - zone.lat) * M_PER_DEG_LAT);
    };
    const ring = this.links.filter(l => l.roundabout);
    const core = new Set<string>();
    for (const l of ring) if (dist(l.from) <= zone.radiusM && dist(l.to) <= zone.radiusM) { core.add(l.from); core.add(l.to); }
    if (core.size) {
      // The whole ring, also where it bulges past the zone edge
      for (let grew = true; grew;) {
        grew = false;
        for (const l of ring) if (core.has(l.from) !== core.has(l.to)) { core.add(l.from); core.add(l.to); grew = true; }
      }
      return core;
    }
    // A junction of the counted roads: three or more arms of collector class or above
    // meet there (a side street joining one main road is not the counted junction)
    const majorArms = (id: string) => new Set(this.links.filter(l => (l.to === id || l.from === id) && l.rank >= 2)
      .map(l => { const far = l.to === id ? l.pts[0] : l.pts[l.pts.length - 1]; const p = pos(id)!; return Math.round(headingOf(p, far) / (Math.PI / 6)); })).size;
    let best: string | null = null, bestD = Infinity;
    this.controls.forEach((_c, id) => {
      const d = dist(id);
      if (d <= MAX_JUNCTION_SPAN_M) { if (majorArms(id) >= 3) core.add(id); }
      if (d <= zone.radiusM && d < bestD) { bestD = d; best = id; }
    });
    if (!core.size && best) core.add(best);
    return core;
  }

  /**
   * Mean stopped delay per controlled junction (three or more arms) since the
   * start, for vehicles that crossed it: the time they stood (below 0.3 m/s)
   * on the approach. Basis for an approximate level of service.
   */
  public junctionDelays(): { id: string; lng: number; lat: number; signalised: boolean; vehicles: number; meanStoppedDelayS: number }[] {
    const out: { id: string; lng: number; lat: number; signalised: boolean; vehicles: number; meanStoppedDelayS: number }[] = [];
    this.junctionDelay.forEach((d, id) => {
      const c = this.controls.get(id);
      if (!c || d.vehicles === 0) return;
      const members = this.junctionMembers.get(id) ?? [id];
      const cs = members.map(m => this.areaNodes.get(m)?.coordinates).filter((x): x is [number, number, number] => !!x);
      if (!cs.length) return;
      out.push({ id, lng: cs.reduce((a, p) => a + p[0], 0) / cs.length, lat: cs.reduce((a, p) => a + p[1], 0) / cs.length, signalised: c.kind === 'signal', vehicles: d.vehicles, meanStoppedDelayS: d.stopS / d.vehicles });
    });
    return out.sort((a, b) => b.vehicles - a.vehicles);
  }

  /** Starts counting turning movements at these junctions (replacing any earlier zones). */
  public setCountZones(zones: readonly CountZone[]): ZoneLayout[] {
    const ends = this.linkEnds();
    this.countLayouts = zones.map(z => layoutZone(z, ends, this.stopLineCounting ? this.zoneCore(z) : undefined));
    this.startCounting();
    return this.countLayouts;
  }

  /** Counts from now on (e.g. after a warm-up). */
  public startCounting() {
    this.countFromT = this.t;
    this.movementCountMap.clear();
  }

  /** Vehicles per movement since counting started, and how long that was (simulated s). */
  public movementCounts(): { counts: Map<string, number>; windowS: number } {
    return { counts: new Map(this.movementCountMap), windowS: this.t - this.countFromT };
  }

  private countCrossing(veh: Vehicle, fromLink: number, toLink: number) {
    for (let z = 0; z < this.countLayouts.length; z++) {
      const layout = this.countLayouts[z];
      if (layout.problem) continue;
      const approach = layout.approachOf.get(fromLink);
      if (approach) (veh.zoneEntry ??= [])[z] = approach;
      const exit = layout.exitOf.get(toLink);
      const entry = veh.zoneEntry?.[z];
      if (exit && entry) {
        const turn = turnBetween(entry, exit);
        if (turn !== 'u_turn') {
          const key = movementKey(layout.zone.id, entry, turn);
          this.movementCountMap.set(key, (this.movementCountMap.get(key) ?? 0) + 1);
        }
        veh.zoneEntry![z] = null;
      }
    }
  }

  /**
   * Each routed explicit OD stream: its position in the demand trips given
   * (`index`), its route (link indices) and its flow in veh/h at the current
   * demand level. Intrazonal and zero-flow trips are not streams.
   */
  public demandRouteFlows(): { index: number; route: number[]; vehiclesPerHour: number; trip: MicroDemandTrip }[] {
    return this.odArrivals.map(a => ({ index: a.index, route: [...a.route], vehiclesPerHour: a.trip.vehiclesPerHour * this.demandLevel * this.hourFactor / OD_REFERENCE_LEVEL, trip: { ...a.trip } }));
  }

  public getDemandTrips(): MicroDemandTrip[] {
    if (this.explicitDemand) return this.odArrivals.map(a => ({ ...a.trip }));
    const trips: MicroDemandTrip[] = [];
    const add = (fromNodeId: string, toNodeId: string, vehiclesPerHour: number, viaRoadId?: string) => {
      for (const type of VEHICLE_TYPES) trips.push({ fromNodeId, toNodeId, vehiclesPerHour: vehiclesPerHour * type.share, kind: type.kind, viaRoadId });
    };
    for (const source of this.sources) {
      const sum = source.sinks.reduce((n, s) => n + s.weight, 0);
      for (const sink of source.sinks) add(source.nodeId, sink.nodeId, source.ratePerS * 3600 * OD_REFERENCE_LEVEL * sink.weight / sum);
    }
    const sum = this.focusCum[this.focusCum.length - 1] ?? 0;
    if (this.demandLevel > 0 && sum > 0) this.focusPairs.forEach((p, i) => {
      const weight = this.focusCum[i] - (this.focusCum[i - 1] ?? 0);
      add(p.source.nodeId, p.sinkNodeId, this.focusRatePerS * 3600 * OD_REFERENCE_LEVEL / this.demandLevel * weight / sum, this.links[p.link].roadId);
    });
    return trips;
  }

  public getSinkNodes(): string[] {
    return this.sinks.map(s => s.nodeId);
  }
}

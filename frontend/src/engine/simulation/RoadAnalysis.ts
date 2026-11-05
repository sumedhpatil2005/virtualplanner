import type { StudyArea, DrivableObject } from './StudyAreaExplorer';
import { MAX_VEHICLES, STEP_S, type TrafficMicroSim, type MicroSimMetrics, type AnalysisLinkCounts, type HoldCause } from './TrafficMicroSim';
import { isGenericRoadName, type RoadSection } from './roadSection';
import { angleDiff, boundLabel, compassWord, displacementM, downstreamLandmark, labelBearings, nameKeys, type Landmark } from './directions';
import type { DemandProvenance } from './StudyDemand';
import { routeMovements, movementKey, type ZoneLayout } from '../calibration/junctionMovements';
import type { CountJunction } from '../calibration/observedCounts';
import { speedLos } from './roadParameters';
import { indoHcmSaturationFlow } from './signalTiming';
import { selectLink, type AssignmentResult } from './staticAssignment';

/**
 * What is happening on one road section, and why (docs/OVERHAUL.md §3-§5).
 *
 * Two models, each used for what it is good at:
 *  - the AREA assignment (staticAssignment.ts) gives the demand on the road,
 *    its capacity and volume/capacity ratio, where its traffic comes from and
 *    goes (select-link), and the bottlenecks of the wider area;
 *  - the CORRIDOR micro-simulation (the selected road and its neighbourhood,
 *    fed by the assignment's paths, several random seeds) gives what drivers
 *    experience: speed, travel time, queues, level of service, and - from
 *    delay attribution - why they are delayed: signals, a queue reaching
 *    back from a junction further on (traced to where it starts), giving way.
 *
 * The status is the Indo-HCM urban-street level of service (travel speed as
 * a share of free-flow speed), with free-flow speeds from roadParameters.ts,
 * not a fixed threshold on an assumed 100 km/h. An explanation is only given
 * when the run's own delay attribution supports it; otherwise the panel says
 * the evidence is insufficient.
 */

export type RoadStatus = 'flowing' | 'moderate' | 'slow' | 'congested' | 'severe' | 'no_traffic';

export interface DelayBreakdown {
  /** Seconds per vehicle on the section, by cause. */
  signal: number; blocked: number; giveWay: number; conflict: number; other: number; total: number;
}

export interface DirectionFlow {
  /** "northbound", "towards the south-west", ... */
  label: string;
  bearingDeg: number;
  /** Eight-point compass word of the label ("north-west"). */
  compass: string;
  /** Bearing the compass word is taken from (shared axis of an opposite pair); within 15 degrees of bearingDeg. */
  labelBearingDeg: number;
  /** Where it leads at its downstream end, when a reliable name exists; else null (compass only). */
  towards: Landmark | null;
  /** Its geometry in travel order, for the direction arrows on the map. */
  paths: [number, number, number][][];
  /** Vehicles per hour that drove it in the corridor simulation (mean over seeds). */
  vph: number;
  /** Range over seeds (min, max). */
  vphRange: [number, number];
  pcuph: number;
  /** Vehicles per hour the area assignment routes along it (the demand on it). */
  demandVph: number;
  demandPcu: number;
  lanes: number;
  /** Mid-block capacity (IRC:106-1990) and, at a signalised end, the stop-line capacity (PCU/h). */
  midblockPcu: number;
  stopLinePcu: number | null;
  capacityPcu: number;
  capacityBasis: 'midblock' | 'signal';
  /** Volume / capacity from the demand on it (assignment) and from what got through (simulation), PCU. */
  vc: number;
  servedVc: number;
  meanSpeedKmh: number | null;
  speedRange: [number, number] | null;
  freeSpeedKmh: number;
  /** Mean speed / free-flow speed (1 = free-flowing), null without a speed sample. */
  speedRatio: number | null;
  travelTimeS: number | null;
  freeTimeS: number;
  /** Indo-HCM level of service per seed, and overall (from the mean speed). */
  los: string | null;
  losBySeed: (string | null)[];
  /** Per seed: vehicles per hour through it and mean speed (km/h). */
  vphBySeed: number[];
  speedBySeed: (number | null)[];
  delay: DelayBreakdown | null;
  queuedNow: number;
}

export interface Place { label: string; coordinates: [number, number, number]; vph: number; share: number; edge: boolean }
export interface RoadUse { roadName: string; roadClass: string; vph: number; share?: number; vc?: number; speedRatio?: number | null; distanceM: number; segmentKeys: string[] }
export interface JunctionUse { id: string; label: string; coordinates: [number, number]; delayS: number; los: string; maxQueueM: number; vehicles: number; signalised: boolean; distanceM: number; atSection: boolean }

/** A queue traced from the selected road back to the junction where it starts. */
export interface QueueChain {
  direction: string;
  /** Share of the direction's delay that is time stopped because the road ahead was full. */
  blockedShare: number;
  /** Where the queue starts: the junction holding the first vehicle of the chain, and why it is held there. */
  root: { label: string; coordinates: [number, number]; cause: 'signal' | 'giveWay' | 'conflict' | 'gridlock' | 'unknown'; delayS: number | null } | null;
  /** Stretches the queue occupies, from the selected road to the root. */
  segmentKeys: string[];
  /** Seeds (of those run) in which the same root junction was found. */
  agreement: number;
  seeds: number;
}

export interface Bottleneck { label: string; roadName: string; coordinates: [number, number, number]; vc: number; delayVehH: number; segmentKeys: string[]; atJunction: boolean }

export interface RoadAnalysisResult {
  windowS: number;
  seeds: number[];
  section: { name: string; lengthM: number; carriageways: number; endsAt: string[]; segmentKeys: string[] };
  directions: DirectionFlow[];
  totalVph: number;
  status: RoadStatus;
  /** All seeds gave the same status. */
  statusConsistent: boolean;
  statusBySeed: RoadStatus[];
  /** One plain sentence on what is happening, then the evidence-backed reasons. */
  headline: string;
  reasons: string[];
  /** Evidence for the cause, or why there is not enough of it. */
  cause: { kind: 'none' | 'own-signal' | 'spillback' | 'give-way' | 'volume' | 'mixed' | 'insufficient'; text: string; chain: QueueChain | null };
  /** Section-end junction that limits the road, if any. */
  bottleneck: JunctionUse | null;
  origins: Place[];
  destinations: Place[];
  /** Of the road's traffic (assignment): share that starts and ends beyond the area (through) or has one end inside it. */
  composition: { throughShare: number; localShare: number };
  feeders: RoadUse[];
  nearby: RoadUse[];
  junctions: JunctionUse[];
  /** Select-link flow by study-area stretch (veh/h), for the map (assignment). */
  selectLinkVph: Map<string, number>;
  /** Volume / capacity by stretch over the whole area (assignment), for the map. */
  areaVc: Map<string, number>;
  /** Simulated volumes by corridor link (veh/h, mean over seeds), for comparisons. */
  linkVph: Map<string, number>;
  /** Assigned volumes by area link (veh/h), for comparisons. */
  areaLinkVph: Map<string, number>;
  /** Worst places in the wider area (assignment v/c), for "which parts suffer most". */
  areaBottlenecks: Bottleneck[];
  network: MicroSimMetrics;
  load: LoadCheck;
  assignment: { iterations: number; relativeGap: number; demandVph: number; unroutedVph: number; overCapacityLinks: number; totalVehHours: number; elapsedMs: number };
  corridor: { roads: number; demandVph: number; rangeM: number };
  /** Per seed: what a comparison checks for consistency. */
  perSeed: { seed: number; sectionVph: number; sectionTimeS: number | null; completedTrips: number; meanTravelTimeS: number | null; meanDelayS: number | null; servedShare: number; gridlockRemovals: number; endDelayS: number | null }[];
  evidence: { demand: DemandProvenance | null; notes: string[] };
}

/** Map colour for a volume/capacity ratio (shared with the panel legend). */
export const VC_BANDS = [{ max: 0.6, css: '#34d399', label: 'under 60%' }, { max: 0.85, css: '#facc15', label: '60–85%' }, { max: 1, css: '#fb923c', label: '85–100%' }, { max: Infinity, css: '#f43f5e', label: 'over capacity' }] as const;
export const vcColour = (vc: number) => VC_BANDS.find(b => vc <= b.max)!.css;

export interface LoadCheck {
  demandVph: number;
  enteredVph: number;
  servedShare: number;
  waitingToEnter: number;
  atVehicleLimit: number;
  gridlockRemovalsVph: number;
  overloaded: boolean;
  message: string | null;
}

/** Below this share of the demand getting onto the network, the run is reported as capacity-limited. */
export const SERVED_SHARE_OK = 0.85;

export function loadCheck(demandVph: number, load: { releasedVehicles: number; capShare: number; gridlockRemovals: number }, windowS: number, waitingToEnter: number): LoadCheck {
  const perH = 3600 / Math.max(STEP_S, windowS);
  const enteredVph = load.releasedVehicles * perH, gridlockRemovalsVph = load.gridlockRemovals * perH;
  const servedShare = demandVph > 0 ? Math.min(1, enteredVph / demandVph) : 1;
  const overloaded = demandVph > 0 && (servedShare < SERVED_SHARE_OK || load.capShare > 0.05 || gridlockRemovalsVph > 0.05 * demandVph);
  let message: string | null = null;
  if (overloaded) {
    const parts = [`${Math.round(enteredVph).toLocaleString()} of the ${Math.round(demandVph).toLocaleString()} veh/h routed into the simulated neighbourhood (${Math.round(100 * servedShare)}%) got onto its roads`];
    if (waitingToEnter > 0) parts.push(`${waitingToEnter.toLocaleString()} vehicles were still queued at its edge at the end`);
    if (load.capShare > 0.05) parts.push(`the run spent ${Math.round(100 * load.capShare)}% of the time at the simulator's ${MAX_VEHICLES.toLocaleString()}-vehicle limit`);
    if (gridlockRemovalsVph > 0.05 * demandVph) parts.push(`${Math.round(gridlockRemovalsVph).toLocaleString()} veh/h were removed after gridlock`);
    message = `More traffic is routed here than the simulated junctions can pass: ${parts.join('; ')}. Volumes shown are what got through. Simulated junctions pass fewer vehicles than the counted Pune junctions (docs/CALIBRATION.md), so part of this is a model limit.`;
  }
  return { demandVph, enteredVph, servedShare, waitingToEnter, atVehicleLimit: load.capShare, gridlockRemovalsVph, overloaded, message };
}

export const NEARBY_M = 700;
export const ANALYSIS_WARMUP_S = 300;
export const ANALYSIS_MEASURE_S = 900;

const M_PER_DEG_LAT = 111320;
const distM = (a: readonly number[], b: readonly number[]) =>
  Math.hypot((a[0] - b[0]) * M_PER_DEG_LAT * Math.cos(a[1] * Math.PI / 180), (a[1] - b[1]) * M_PER_DEG_LAT);
const bearing = (a: readonly number[], b: readonly number[]) => {
  const dx = (b[0] - a[0]) * Math.cos(a[1] * Math.PI / 180), dy = b[1] - a[1];
  return ((Math.atan2(dx, dy) * 180) / Math.PI + 360) % 360;
};
export const compass = compassWord;
const capital = (s: string) => s.charAt(0).toUpperCase() + s.slice(1);
const fmt = (n: number) => Math.round(n).toLocaleString();
const mean = (xs: number[]) => xs.length ? xs.reduce((a, b) => a + b, 0) / xs.length : 0;

function pointToLineM(p: readonly number[], line: readonly (readonly number[])[]): number {
  let best = Infinity;
  for (const q of line) best = Math.min(best, distM(p, q));
  return best;
}

const LOS_STATUS: Record<string, RoadStatus> = { A: 'flowing', B: 'flowing', C: 'moderate', D: 'slow', E: 'congested', F: 'severe' };
const STATUS_RANK: Record<RoadStatus, number> = { no_traffic: 0, flowing: 1, moderate: 2, slow: 3, congested: 4, severe: 5 };

/** One direction of travel on the section, with its geometry in travel order. */
export interface SectionDirection {
  /** Overall compass bearing of travel (degrees clockwise from north), from the pieces' start-to-end displacements. */
  bearing: number;
  label: string;
  /** Eight-point compass word of the label ("north-west"); opposite directions share an axis (labelBearings). */
  compass: string;
  /** Bearing the compass word is taken from: the shared axis of an opposite pair, else the bearing itself. */
  labelBearing: number;
  /** Where this direction leads at its downstream end, when a reliable name exists (directions.ts). */
  towards: Landmark | null;
  linkIds: string[];
  /** The direction's pieces as chains of points in travel order (lng, lat, z). */
  paths: [number, number, number][][];
}

/** Chains a direction's links end to start, so each chain is a run of road in travel order. */
function chainLinks(network: StudyArea['network'], linkIds: readonly string[]): string[][] {
  const edges = linkIds.map(id => network.edges.get(id)!).filter(Boolean);
  const byFrom = new Map(edges.map(e => [e.fromNodeId, e]));
  const toNodes = new Set(edges.map(e => e.toNodeId));
  const used = new Set<string>();
  const chains: string[][] = [];
  const starts = [...edges.filter(e => !toNodes.has(e.fromNodeId)), ...edges];
  for (const s of starts) {
    if (used.has(s.id)) continue;
    const chain: string[] = [];
    for (let e: typeof s | undefined = s; e && !used.has(e.id); e = byFrom.get(e.toNodeId)) { used.add(e.id); chain.push(e.id); }
    chains.push(chain);
  }
  return chains;
}

/**
 * Directions of travel on a section: its links grouped by bearing (two
 * carriageways of a divided road, or both directions of a two-way one).
 * Each link's points are taken in travel order (the network stores a
 * backward link's points already reversed), and each direction's bearing is
 * that of its whole length, not of whichever piece came first.
 */
export function sectionDirections(area: StudyArea, section: RoadSection, roads?: ReadonlyMap<string, DrivableObject>): SectionDirection[] {
  const keys = new Set(section.segmentKeys);
  const groups: { e: number; n: number; linkIds: string[] }[] = [];
  const groupBearing = (g: { e: number; n: number }) => ((Math.atan2(g.e, g.n) * 180) / Math.PI + 360) % 360;
  for (const e of area.network.edges.values()) {
    const key = e.id.replace(/_(fwd|bwd)$/, '');
    if (!keys.has(key)) continue;
    const pts = e.coordinates;
    if (pts.length < 2) continue;
    const [de, dn] = displacementM(pts[0], pts[pts.length - 1]);
    const b = bearing(pts[0], pts[pts.length - 1]);
    const g = groups.find(x => angleDiff(groupBearing(x), b) < 70);
    if (g) { g.e += de; g.n += dn; g.linkIds.push(e.id); } else groups.push({ e: de, n: dn, linkIds: [e.id] });
  }
  const sectionNames = new Set<string>();
  if (roads) for (const id of section.roadIds) for (const k of nameKeys(roads.get(id))) sectionNames.add(k);
  const labelled = labelBearings(groups.map(groupBearing));
  return groups.map((g, gi) => {
    const b = groupBearing(g);
    const chains = chainLinks(area.network, g.linkIds);
    const paths = chains.map(ch => ch.flatMap((id, i) => { const c = area.network.edges.get(id)!.coordinates; return (i === 0 ? c : c.slice(1)).map(p => [p[0], p[1], p[2] || 0] as [number, number, number]); }));
    // The landmark is read from the end of the longest run of the direction
    let towards: Landmark | null = null;
    if (roads && chains.length) {
      const lengthOf = (ch: string[]) => ch.reduce((m, id) => m + (area.network.edges.get(id)?.length ?? 0), 0);
      const main = chains.reduce((a, c) => (lengthOf(c) > lengthOf(a) ? c : a));
      towards = downstreamLandmark(area.network, roads, main[main.length - 1], keys, sectionNames);
    }
    return { bearing: b, label: boundLabel(labelled[gi]), compass: compassWord(labelled[gi]), labelBearing: labelled[gi], towards, linkIds: g.linkIds, paths };
  });
}

// ── One corridor simulation run ─────────────────────────────────────────────

export interface CorridorRun {
  seed: number;
  windowS: number;
  directions: { vph: number; pcuph: number; meanSpeedKmh: number | null; travelTimeS: number | null; freeTimeS: number; freeSpeedKmh: number; lengthM: number; lanes: number; delay: DelayBreakdown | null; queuedNow: number; stopLinePcu: number | null; endSignal: boolean }[];
  chains: (QueueChain | null)[];
  junctions: JunctionUse[];
  linkVph: Map<string, number>;
  network: MicroSimMetrics;
  load: LoadCheck;
}

/** Reads one corridor run (counters since sim.startAnalysis()). */
export function readCorridorRun(sim: TrafficMicroSim, seed: number, corridor: StudyArea, roads: ReadonlyMap<string, DrivableObject>, section: RoadSection,
  dirs: { bearing: number; label: string; linkIds: string[] }[], demandVph: number): CorridorRun {
  const counts = sim.analysisCounts();
  if (!counts) throw new Error('Start the analysis window first.');
  const perH = 3600 / Math.max(STEP_S, counts.windowS);
  const byId = new Map(counts.links.map(l => [l.id, l]));
  const segCoords = new Map(corridor.segments.map(s => [s.key, s.coordinates]));
  const sectionLines = section.segmentKeys.map(k => segCoords.get(k) ?? []).filter(c => c.length);
  const near = (p: readonly number[]) => sectionLines.length ? Math.min(...sectionLines.map(l => pointToLineM(p, l))) : Infinity;

  // Junction names from the roads that meet there
  const roadNamesAt = new Map<string, Set<string>>();
  for (const l of counts.links) for (const n of [l.from, l.to]) { const s = roadNamesAt.get(n) ?? roadNamesAt.set(n, new Set()).get(n)!; const nm = roads.get(l.roadId)?.name; if (nm && !isGenericRoadName(nm)) s.add(nm); }
  const junctionName = (nodeId: string) => {
    const names = [...(roadNamesAt.get(nodeId) ?? [])];
    const others = names.filter(n => n !== section.name);
    if (names.length >= 2) return names.slice(0, 3).join(' / ');
    return others.length ? `${section.name} / ${others[0]}` : names.length ? `${names[0]} (junction)` : 'an unnamed junction';
  };
  const sectionNodes = new Set(dirs.flatMap(d => d.linkIds).flatMap(id => { const l = byId.get(id); return l ? [l.from, l.to] : []; }));
  const stats = sim.junctionStats();
  const statByJunction = new Map(stats.map(j => [j.id, j]));
  const junctions: JunctionUse[] = stats.map(j => ({ id: j.id, label: junctionName(j.id), coordinates: [j.lng, j.lat] as [number, number], delayS: j.meanControlDelayS, los: j.los, maxQueueM: j.maxQueueM, vehicles: j.vehicles, signalised: j.signalised,
    distanceM: near([j.lng, j.lat]), atSection: sectionNodes.has(j.id) || [...sectionNodes].some(n => sim.junctionOfNode(n) === j.id) }))
    .filter(j => j.distanceM <= NEARBY_M).sort((a, b) => b.delayS * b.vehicles - a.delayS * a.vehicles).slice(0, 10);

  const chains: (QueueChain | null)[] = [];
  const directions = dirs.map(d => {
    const ls = d.linkIds.map(id => byId.get(id)).filter((l): l is AnalysisLinkCounts => !!l);
    const len = ls.reduce((n, l) => n + l.lengthM, 0) || 1;
    const vph = ls.reduce((n, l) => n + l.entries * perH * l.lengthM, 0) / len;
    const pcuph = ls.reduce((n, l) => n + l.pcuEntries * perH * l.lengthM, 0) / len;
    const lanes = Math.round(ls.reduce((n, l) => n + l.lanes * l.lengthM, 0) / len);
    const freeTimeS = ls.reduce((n, l) => n + l.freeFlowS, 0);
    const timed = ls.filter(l => l.meanTimeS !== null && l.meanTimeS > 0);
    const allTimed = timed.length === ls.length && ls.length > 0;
    const travelTimeS = allTimed ? timed.reduce((n, l) => n + l.meanTimeS!, 0) : timed.length ? timed.reduce((n, l) => n + l.meanTimeS!, 0) * len / Math.max(1, timed.reduce((n, l) => n + l.lengthM, 0)) : null;
    const meanSpeedKmh = travelTimeS ? (len / travelTimeS) * 3.6 : null;
    // Delay per vehicle, by cause: queued vehicle-seconds on each link over the vehicles that used it
    let delay: DelayBreakdown | null = null;
    if (travelTimeS !== null) {
      const per = (k: HoldCause) => ls.reduce((n, l) => n + (l.entries > 0 ? l.hold[k] / l.entries : 0), 0);
      const total = Math.max(0, travelTimeS - freeTimeS);
      const signal = per('signal'), blocked = per('blocked'), giveWay = per('giveWay'), conflict = per('conflict');
      const attributed = signal + blocked + giveWay + conflict;
      const scale = attributed > total && attributed > 0 ? total / attributed : 1;
      delay = { signal: signal * scale, blocked: blocked * scale, giveWay: giveWay * scale, conflict: conflict * scale, other: Math.max(0, total - attributed * scale), total };
    }
    // The queue chain: follow "no room ahead" from the section to where the queue starts
    chains.push(delay && delay.blocked > 0.25 * delay.total && delay.total > 5 ? traceChain(ls, byId, sim, junctionName, statByJunction, d.label, delay.blocked / Math.max(1e-9, delay.total)) : null);
    const last = ls.find(l => !ls.some(m => m.from === l.to)) ?? ls[ls.length - 1];
    // Stop-line capacity at a signalised end, from the run's own signal plan (Webster green ratio) and Indo-HCM saturation flow
    const stopLinePcu = last?.signal && last.gC !== null ? indoHcmSaturationFlow(last.lanes * 3.5) * last.gC : null;
    return { vph, pcuph, meanSpeedKmh, travelTimeS, freeTimeS, freeSpeedKmh: (len / Math.max(0.1, freeTimeS)) * 3.6, lengthM: len, lanes, delay, queuedNow: ls.reduce((n, l) => n + l.queuedNow, 0), stopLinePcu, endSignal: !!last?.signal };
  });
  const linkVph = new Map<string, number>();
  for (const l of counts.links) linkVph.set(l.id, l.entries * perH);
  const network = sim.getMetrics();
  const load = loadCheck(Math.max(0, demandVph - counts.load.unroutable * perH), counts.load, counts.windowS, network.waitingToEnter);
  return { seed, windowS: counts.windowS, directions, chains, junctions, linkVph, network, load };
}

/**
 * Follows the queue from the section's links: at each step to the link whose
 * lack of room held the most vehicle-seconds, until a link whose own front
 * vehicles are held by something other than a full road ahead (a signal,
 * giving way, a conflict). That junction is where the queue starts.
 */
function traceChain(start: AnalysisLinkCounts[], byId: ReadonlyMap<string, AnalysisLinkCounts>, sim: TrafficMicroSim, junctionName: (id: string) => string,
  _statByJunction: ReadonlyMap<string, { meanControlDelayS: number }>, direction: string, blockedShare: number): QueueChain {
  const seg = new Set<string>();
  // The section link with the most blocked time starts the trace
  let cur = [...start].sort((a, b) => b.hold.blocked - a.hold.blocked)[0];
  const seen = new Set<string>();
  for (let depth = 0; depth < 25 && cur; depth++) {
    seen.add(cur.id);
    seg.add(cur.segmentKey);
    const next = [...cur.blockedBy].sort((a, b) => b[1] - a[1])[0];
    if (!next) break;
    const nl = byId.get(next[0]);
    if (!nl) break;
    if (seen.has(nl.id)) {
      return { direction, blockedShare, root: { label: junctionName(cur.to), coordinates: nodeLngLat(sim, cur.to), cause: 'gridlock', delayS: null }, segmentKeys: [...seg], agreement: 1, seeds: 1 };
    }
    const own = nl.hold;
    const ownTotal = own.signal + own.blocked + own.giveWay + own.conflict;
    seg.add(nl.segmentKey);
    if (ownTotal <= 0 || own.blocked < 0.5 * ownTotal) {
      const cause = own.signal >= own.giveWay && own.signal >= own.conflict ? 'signal' : own.giveWay >= own.conflict ? 'giveWay' : 'conflict';
      // The hold on the approach that starts the queue, per vehicle that entered it: the junction's
      // mean over all its movements can be small while this one approach is badly held
      const approachS = nl.entries > 0 ? ownTotal / nl.entries : null;
      return { direction, blockedShare, root: { label: junctionName(nl.to), coordinates: nodeLngLat(sim, nl.to), cause: ownTotal > 0 ? cause : 'unknown', delayS: approachS }, segmentKeys: [...seg], agreement: 1, seeds: 1 };
    }
    cur = nl;
  }
  return { direction, blockedShare, root: null, segmentKeys: [...seg], agreement: 1, seeds: 1 };
}

const nodeLngLat = (sim: TrafficMicroSim, id: string): [number, number] => { const c = sim.nodeCoordinates(id) ?? [0, 0, 0]; return [c[0], c[1]]; };

// ── Area context from the assignment ────────────────────────────────────────

export interface AreaContext {
  directions: { demandVph: number; demandPcu: number; midblockPcu: number; stopLinePcu: number | null; lanes: number }[];
  origins: Place[]; destinations: Place[];
  composition: { throughShare: number; localShare: number };
  selectLinkVph: Map<string, number>;
  areaVc: Map<string, number>;
  areaLinkVph: Map<string, number>;
  feeders: RoadUse[];
  nearby: RoadUse[];
  bottlenecks: Bottleneck[];
  summary: RoadAnalysisResult['assignment'];
}

export function areaContext(res: AssignmentResult, area: StudyArea, roads: ReadonlyMap<string, DrivableObject>, section: RoadSection, dirs: { linkIds: string[] }[], demandVph: number): AreaContext {
  const linkByAid = new Map(res.links.map(l => [l.id, l]));
  const segCoords = new Map(area.segments.map(s => [s.key, s.coordinates]));
  const sectionKeys = new Set(section.segmentKeys);
  const sectionLines = section.segmentKeys.map(k => segCoords.get(k) ?? []).filter(c => c.length);
  const near = (p: readonly number[]) => sectionLines.length ? Math.min(...sectionLines.map(l => pointToLineM(p, l))) : Infinity;
  const directions = dirs.map(d => {
    const ls = d.linkIds.map(id => linkByAid.get(id)).filter((l): l is NonNullable<typeof l> => !!l);
    const len = ls.reduce((n, l) => n + l.lengthM, 0) || 1;
    const w = (f: (l: (typeof ls)[number]) => number) => ls.reduce((n, l) => n + f(l) * l.lengthM, 0) / len;
    // Capacity of the direction: its tightest stretch, and the stop line at its signalised end if any
    const stop = ls.filter(l => l.stopLinePcu !== null).map(l => l.stopLinePcu!);
    return { demandVph: w(l => res.volVeh[l.index]), demandPcu: w(l => res.volPcu[l.index]), midblockPcu: ls.length ? Math.min(...ls.map(l => l.midblockPcu)) : 0,
      stopLinePcu: stop.length ? Math.min(...stop) : null, lanes: Math.round(w(l => l.lanes)) };
  });
  // Select-link analysis on the section's links
  const secIdx = new Set(res.links.filter(l => sectionKeys.has(l.segmentKey)).map(l => l.index));
  const sl = selectLink(res, secIdx);
  const boundary = new Set(area.boundary.map(b => b.nodeId));
  const total = sl.byOd.reduce((n, x) => n + x.veh, 0);
  let through = 0;
  for (const { od, veh } of sl.byOd) { const o = res.ods[od]; if (boundary.has(res.nodes[o.from]) && boundary.has(res.nodes[o.to])) through += veh; }
  const centre = sectionLines.length ? sectionLines[Math.floor(sectionLines.length / 2)][0] : [area.bounds.minLng, area.bounds.minLat];
  const roadOf = (node: number, out: boolean) => {
    const ls = res.links.filter(l => (out ? l.from : l.to) === node).sort((a, b) => sl.linkVeh[b.index] - sl.linkVeh[a.index]);
    const nm = ls.length ? roads.get(ls[0].roadId)?.name : undefined;
    return nm && !isGenericRoadName(nm) ? nm : 'an unnamed road';
  };
  const places = (which: 'from' | 'to') => {
    const m = new Map<string, Place>();
    for (const { od, veh } of sl.byOd) {
      const node = which === 'from' ? res.ods[od].from : res.ods[od].to;
      const c = res.nodeCoords[node];
      const edge = boundary.has(res.nodes[node]);
      const dir = compass(bearing(centre, c));
      const label = edge ? `${which === 'from' ? 'From' : 'To'} beyond the area, ${dir}, via ${roadOf(node, which === 'from')}` : `${which === 'from' ? 'From' : 'To'} streets about ${Math.max(100, Math.round(distM(centre, c) / 100) * 100)} m ${dir}, near ${roadOf(node, which === 'from')}`;
      const p = m.get(label) ?? m.set(label, { label, coordinates: c, vph: 0, share: 0, edge }).get(label)!;
      p.vph += veh; p.share += total ? veh / total : 0;
    }
    return [...m.values()].sort((a, b) => b.vph - a.vph).slice(0, 6).map(p => ({ ...p, vph: Math.round(p.vph) }));
  };
  const selectLinkVph = new Map<string, number>(), areaVc = new Map<string, number>(), areaLinkVph = new Map<string, number>();
  let over = 0, vehH = 0;
  for (const l of res.links) {
    const v = res.volVeh[l.index], vc = res.volPcu[l.index] / Math.max(1, l.capacityPcu);
    areaLinkVph.set(l.id, v);
    if (sl.linkVeh[l.index] > 0.5) selectLinkVph.set(l.segmentKey, Math.max(selectLinkVph.get(l.segmentKey) ?? 0, sl.linkVeh[l.index]));
    areaVc.set(l.segmentKey, Math.max(areaVc.get(l.segmentKey) ?? 0, vc));
    if (vc > 1) over++;
    vehH += v * res.timeS[l.index] / 3600;
  }
  // Roads by name: select-link flow (feeders) and assigned traffic (nearby)
  const byRoad = (val: (i: number) => number, filter: (l: (typeof res.links)[number]) => boolean) => {
    const m = new Map<string, { roadName: string; roadClass: string; vph: number; vc: number; dist: number; keys: Set<string> }>();
    for (const l of res.links) {
      if (!filter(l)) continue;
      const v = val(l.index);
      if (v <= 0.5) continue;
      const r = roads.get(l.roadId);
      const name = r?.name && !isGenericRoadName(r.name) ? r.name : 'Unnamed road';
      const key = `${name}|${r?.roadClass}`;
      const e = m.get(key) ?? m.set(key, { roadName: name, roadClass: r?.roadClass ?? 'local', vph: 0, vc: 0, dist: Infinity, keys: new Set() }).get(key)!;
      if (v > e.vph) { e.vph = v; e.vc = res.volPcu[l.index] / Math.max(1, l.capacityPcu); }
      e.keys.add(l.segmentKey);
      const c = segCoords.get(l.segmentKey);
      if (c?.length) e.dist = Math.min(e.dist, near(c[Math.floor(c.length / 2)]));
    }
    return [...m.values()];
  };
  const sectionNames = new Set(res.links.filter(l => sectionKeys.has(l.segmentKey)).map(l => roads.get(l.roadId)?.name).filter(Boolean));
  const feeders = byRoad(i => sl.linkVeh[i], l => !sectionKeys.has(l.segmentKey) && !sectionNames.has(roads.get(l.roadId)?.name)).sort((a, b) => b.vph - a.vph).slice(0, 6)
    .map(r => ({ roadName: r.roadName, roadClass: r.roadClass, vph: Math.round(r.vph), share: total ? r.vph / total : 0, distanceM: Math.round(r.dist), segmentKeys: [...r.keys] }));
  const nearby = byRoad(i => res.volVeh[i], l => !sectionKeys.has(l.segmentKey)).filter(r => (r.dist <= NEARBY_M && r.roadClass !== 'local') || r.dist <= 250)
    .sort((a, b) => b.vph - a.vph).slice(0, 8).map(r => ({ roadName: r.roadName, roadClass: r.roadClass, vph: Math.round(r.vph), vc: r.vc, speedRatio: null, distanceM: Math.round(r.dist), segmentKeys: [...r.keys] }));
  // Area bottlenecks: over-capacity stretches ranked by the extra vehicle-hours they cause, one per road name and place
  const cand = res.links.map(l => ({ l, vc: res.volPcu[l.index] / Math.max(1, l.capacityPcu), extra: res.volVeh[l.index] * Math.max(0, res.timeS[l.index] - l.t0) / 3600 }))
    .filter(x => x.vc > 0.9 && x.extra > 0.5).sort((a, b) => b.extra - a.extra);
  const bottlenecks: Bottleneck[] = [];
  for (const x of cand) {
    if (bottlenecks.length >= 6) break;
    const r = roads.get(x.l.roadId);
    const name = r?.name && !isGenericRoadName(r.name) ? r.name : 'Unnamed road';
    const c = res.nodeCoords[x.l.to];
    if (bottlenecks.some(b => distM(b.coordinates, c) < 250)) continue;
    bottlenecks.push({ label: `${name}${x.l.stopLinePcu !== null ? ' at its signal' : ''}, ${compass(bearing(centre, c))} of the road, ${Math.round(distM(centre, c) / 100) * 100} m`, roadName: name, coordinates: c,
      vc: x.vc, delayVehH: x.extra, segmentKeys: [x.l.segmentKey], atJunction: x.l.stopLinePcu !== null });
  }
  return { directions, origins: places('from'), destinations: places('to'), composition: { throughShare: total ? through / total : 0, localShare: total ? 1 - through / total : 0 },
    selectLinkVph, areaVc, areaLinkVph, feeders, nearby, bottlenecks,
    summary: { iterations: res.iterations, relativeGap: res.relativeGap, demandVph, unroutedVph: res.unroutedVeh, overCapacityLinks: over, totalVehHours: vehH, elapsedMs: res.elapsedMs } };
}

// ── Combining the area and the corridor runs ────────────────────────────────

export function combineAnalysis(area: AreaContext, runs: CorridorRun[], dirs: { bearing: number; label: string; compass?: string; labelBearing?: number; towards?: Landmark | null; paths?: [number, number, number][][] }[], section: RoadSection, corridorInfo: RoadAnalysisResult['corridor'], demand: DemandProvenance | null): RoadAnalysisResult {
  const n = runs.length;
  const directions: DirectionFlow[] = dirs.map((d, i) => {
    const a = area.directions[i];
    const rs = runs.map(r => r.directions[i]);
    const vphs = rs.map(r => r.vph), speeds = rs.map(r => r.meanSpeedKmh).filter((s): s is number => s !== null);
    const times = rs.map(r => r.travelTimeS).filter((s): s is number => s !== null);
    const freeTimeS = rs[0]?.freeTimeS ?? 0, freeSpeedKmh = rs[0]?.freeSpeedKmh ?? 0;
    const travelTimeS = times.length ? mean(times) : null;
    const meanSpeedKmh = travelTimeS ? (rs[0].lengthM / travelTimeS) * 3.6 : null;
    const speedRatio = travelTimeS ? freeTimeS / travelTimeS : null;
    // The corridor run's own signal timing where it has one, else the assignment's assumed green ratio
    const simStop = rs.map(r => r.stopLinePcu).filter((x): x is number => x !== null);
    const stopLinePcu = simStop.length ? mean(simStop) : a.stopLinePcu;
    const capacityPcu = Math.min(a.midblockPcu || Infinity, stopLinePcu ?? Infinity);
    const vc = a.demandPcu / Math.max(1, capacityPcu);
    const pcuph = mean(rs.map(r => r.pcuph));
    const delays = rs.map(r => r.delay).filter((x): x is DelayBreakdown => !!x);
    const avgDelay = delays.length ? { signal: mean(delays.map(x => x.signal)), blocked: mean(delays.map(x => x.blocked)), giveWay: mean(delays.map(x => x.giveWay)), conflict: mean(delays.map(x => x.conflict)), other: mean(delays.map(x => x.other)), total: mean(delays.map(x => x.total)) } : null;
    return { label: d.label, bearingDeg: d.bearing, compass: d.compass ?? compassWord(d.labelBearing ?? d.bearing), labelBearingDeg: d.labelBearing ?? d.bearing, towards: d.towards ?? null, paths: d.paths ?? [], vph: Math.round(mean(vphs)), vphRange: [Math.round(Math.min(...vphs)), Math.round(Math.max(...vphs))] as [number, number], pcuph: Math.round(pcuph),
      demandVph: Math.round(a.demandVph), demandPcu: Math.round(a.demandPcu), lanes: a.lanes || rs[0]?.lanes || 1,
      midblockPcu: Math.round(a.midblockPcu), stopLinePcu: stopLinePcu !== null ? Math.round(stopLinePcu) : null, capacityPcu: Math.round(capacityPcu), capacityBasis: (stopLinePcu !== null && stopLinePcu < a.midblockPcu ? 'signal' : 'midblock') as 'signal' | 'midblock',
      vc, servedVc: pcuph / Math.max(1, capacityPcu),
      meanSpeedKmh, speedRange: speeds.length ? [Math.min(...speeds), Math.max(...speeds)] as [number, number] : null, freeSpeedKmh, speedRatio,
      travelTimeS, freeTimeS, los: speedLos(speedRatio, vc > 1 && pcuph < 0.9 * a.demandPcu ? vc : null),
      losBySeed: rs.map(r => speedLos(r.travelTimeS ? r.freeTimeS / r.travelTimeS : null, null)),
      vphBySeed: rs.map(r => Math.round(r.vph)), speedBySeed: rs.map(r => r.meanSpeedKmh === null ? null : Math.round(r.meanSpeedKmh * 10) / 10),
      delay: avgDelay, queuedNow: Math.round(mean(rs.map(r => r.queuedNow))) };
  }).sort((x, y) => y.vph - x.vph);
  const totalVph = directions.reduce((s, d) => s + d.vph, 0);

  // Status: the worse direction's level of service, per seed and overall
  const statusOf = (los: (string | null)[], vph: number) => vph < 10 ? 'no_traffic' as RoadStatus : los.filter((x): x is string => !!x).map(x => LOS_STATUS[x]).sort((a, b) => STATUS_RANK[b] - STATUS_RANK[a])[0] ?? 'no_traffic';
  const statusBySeed = runs.map((r, k) => statusOf(directions.map(d => d.losBySeed[k]), r.directions.reduce((s, x) => s + x.vph, 0)));
  const status = statusOf(directions.map(d => d.los), totalVph);
  const statusConsistent = statusBySeed.every(s => s === statusBySeed[0]);

  // Junctions: merge seeds by id (mean delay)
  const jm = new Map<string, JunctionUse & { k: number }>();
  for (const r of runs) for (const j of r.junctions) { const e = jm.get(j.id); if (e) { e.delayS += j.delayS; e.maxQueueM = Math.max(e.maxQueueM, j.maxQueueM); e.vehicles += j.vehicles; e.k++; } else jm.set(j.id, { ...j, k: 1 }); }
  const junctions = [...jm.values()].map(j => ({ ...j, delayS: j.delayS / j.k, vehicles: Math.round(j.vehicles / j.k) })).sort((a, b) => b.delayS * b.vehicles - a.delayS * a.vehicles).slice(0, 8)
    .map(j => ({ ...j, los: losLabel(j.delayS, j.signalised) }));
  const worstEnd = junctions.filter(j => j.atSection && j.vehicles >= 20).sort((a, b) => b.delayS - a.delayS)[0] ?? null;
  const bottleneck = worstEnd && (worstEnd.los === 'E' || worstEnd.los === 'F') ? worstEnd : null;

  // Queue chains: agreement on the root junction across seeds, per direction
  const chainFor = (label: string): QueueChain | null => {
    const idx = dirs.findIndex(d => d.label === label);
    const cs = runs.map(r => r.chains[idx]).filter((c): c is QueueChain => !!c && !!c.root);
    if (!cs.length) return null;
    const by = new Map<string, QueueChain[]>();
    for (const c of cs) (by.get(c.root!.label) ?? by.set(c.root!.label, []).get(c.root!.label)!).push(c);
    const [, best] = [...by].sort((a, b) => b[1].length - a[1].length)[0];
    const ds = best.map(c => c.root!.delayS).filter((x): x is number => x !== null);
    return { ...best[0], root: { ...best[0].root!, delayS: ds.length ? mean(ds) : null }, blockedShare: mean(best.map(c => c.blockedShare)), segmentKeys: [...new Set(best.flatMap(c => c.segmentKeys))], agreement: best.length, seeds: n };
  };

  // Headline, cause and reasons, all from the numbers above
  const reasons: string[] = [];
  // The direction to explain: the worse level of service, then the longer delay per vehicle
  const worst = [...directions].sort((a, b) => (STATUS_RANK[LOS_STATUS[b.los ?? 'A']] - STATUS_RANK[LOS_STATUS[a.los ?? 'A']]) || ((b.delay?.total ?? 0) - (a.delay?.total ?? 0)))[0];
  const loadMsg = runs.find(r => r.load.message)?.load.message ?? null;
  const overloadedRuns = runs.filter(r => r.load.overloaded).length;
  let headline: string;
  let cause: RoadAnalysisResult['cause'] = { kind: 'none', text: '', chain: null };
  const fmtS = (s: number) => `${Math.round(s)} s`;
  if (status === 'no_traffic' || !worst) {
    headline = 'Almost no simulated traffic uses this road.';
    cause = { kind: 'insufficient', text: 'Routes through the area avoid it, or it is poorly connected. Check its connections under Advanced.', chain: null };
  } else {
    const speedTxt = (d: DirectionFlow) => d.meanSpeedKmh === null ? 'no speed measured' : `${Math.round(d.meanSpeedKmh)} km/h against a free-flow ${Math.round(d.freeSpeedKmh)} km/h`;
    const word: Record<RoadStatus, string> = { flowing: 'moves freely', moderate: 'moves with some delay', slow: 'is slow', congested: 'is congested', severe: 'is severely congested', no_traffic: 'is almost empty' };
    headline = `${capital(worst.label)} traffic ${word[LOS_STATUS[worst.los ?? 'A']]}: ${speedTxt(worst)} (level of service ${worst.los ?? '?'}).`;
    const d = worst.delay;
    if (d && d.total > 5 && STATUS_RANK[status] >= 2) {
      const chain = chainFor(worst.label);
      const shares = { signal: d.signal / d.total, blocked: d.blocked / d.total, giveWay: (d.giveWay + d.conflict) / d.total, other: d.other / d.total };
      // A cause is named only when most runs trace the queue to the same junction (2 of 3, or the one run)
      const agreed = !!chain?.root && 2 * chain.agreement > n;
      if (shares.blocked >= 0.35 && chain?.root && agreed) {
        const agree = n === 1 ? 'in the one run analysed' : chain.agreement === n ? `in all ${n} runs` : `in ${chain.agreement} of ${n} runs`;
        const why = chain.root.cause === 'signal' ? 'its signal' : chain.root.cause === 'giveWay' ? 'traffic giving way there' : chain.root.cause === 'conflict' ? 'conflicting turns inside it' : chain.root.cause === 'gridlock' ? 'a circular jam (gridlock)' : 'a hold-up';
        cause = { kind: 'spillback', chain, text: `${Math.round(100 * shares.blocked)}% of the delay on it (${fmtS(d.blocked)} of ${fmtS(d.total)} per vehicle) is spent stopped because the road ahead is full. The queue was traced back to ${chain.root.label}, held by ${why}${chain.root.delayS !== null ? ` (vehicles on the approach that starts the queue wait ${fmtS(chain.root.delayS)} each there)` : ''}; found ${agree}. It is marked on the map.` };
      } else if (shares.blocked >= 0.35) {
        const minority = chain?.root ? ` (the most frequent trace, to ${chain.root.label}, was found in only ${chain.agreement} of ${n} runs)` : '';
        cause = { kind: 'insufficient', chain: null, text: `${Math.round(100 * shares.blocked)}% of the delay is spent stopped behind a full road ahead, but the queue could not be traced to one junction consistently${minority}. The evidence is not enough to name a cause.` };
      } else if (shares.signal >= 0.5) {
        const endJ = junctions.find(j => j.atSection && j.signalised);
        cause = { kind: 'own-signal', chain: null, text: `Most of the delay (${fmtS(d.signal)} of ${fmtS(d.total)} per vehicle) is waiting at the signal at its end${endJ ? `, ${endJ.label}` : ''}. That is ordinary signal delay, not a queue from elsewhere.` };
      } else if (shares.giveWay >= 0.5) {
        cause = { kind: 'give-way', chain: null, text: `Most of the delay (${fmtS(d.giveWay + d.conflict)} of ${fmtS(d.total)} per vehicle) is giving way or waiting for crossing traffic at an unsignalised junction.` };
      } else if (shares.other >= 0.5 && worst.servedVc > 0.85) {
        cause = { kind: 'volume', chain: null, text: `Traffic is close to the road's capacity (${Math.round(100 * worst.servedVc)}%): vehicles slow in dense traffic rather than at one junction.` };
      } else if (shares.other >= 0.5) {
        cause = { kind: 'insufficient', chain: null, text: `Most of the delay (${fmtS(d.other)} of ${fmtS(d.total)} per vehicle) is slow driving in moving traffic (turning, merging, following), not queuing at a junction. No single cause stands out.` };
      } else {
        cause = { kind: 'mixed', chain: null, text: `The delay (${fmtS(d.total)} per vehicle) is spread over causes: signal ${fmtS(d.signal)}, queue from further on ${fmtS(d.blocked)}, giving way ${fmtS(d.giveWay + d.conflict)}, slow moving traffic ${fmtS(d.other)}.` };
      }
    } else if (d) {
      cause = { kind: 'none', chain: null, text: `Delay is small: ${fmtS(d.total)} per vehicle over the ${Math.round(section.lengthM)} m section.` };
    }
    for (const x of directions) {
      const cap = `${fmt(x.capacityPcu)} PCU/h ${x.capacityBasis === 'signal' ? 'at the signal at its end' : 'mid-block (IRC:106)'}`;
      reasons.push(`${capital(x.label)}: ${fmt(x.demandVph)} veh/h routed along it (${Math.round(100 * x.vc)}% of capacity, ${cap}); ${fmt(x.vph)} veh/h got through in the simulation${n > 1 ? ` (${fmt(x.vphRange[0])}–${fmt(x.vphRange[1])} over ${n} runs)` : ''}.`);
    }
    if (overloadedRuns) reasons.push(loadMsg!);
  }
  if (!statusConsistent) reasons.push(`The runs disagree (${statusBySeed.map(s => STATUS_WORD[s]).join(', ')}): the road is near a boundary between levels of service, so read the status as uncertain.`);

  const net = runs[0].network;
  const notes: string[] = [];
  if (demand?.source !== 'calibrated') notes.push('No traffic count on this road was used: volumes are model estimates, not measurements.');
  if (demand?.components && !demand.components.throughIncluded) notes.push('Through traffic is switched off: only trips made by the area\'s own buildings are shown.');
  if (section.carriageways === 2) notes.push('Divided road: both carriageways are counted, each as its own direction.');
  const linkVph = new Map<string, number>();
  for (const r of runs) r.linkVph.forEach((v, k) => linkVph.set(k, (linkVph.get(k) ?? 0) + v / n));
  return {
    windowS: runs[0].windowS, seeds: runs.map(r => r.seed),
    section: { name: section.name, lengthM: section.lengthM, carriageways: section.carriageways, endsAt: section.endsAt, segmentKeys: section.segmentKeys },
    directions, totalVph, status, statusConsistent, statusBySeed, headline, reasons, cause, bottleneck,
    origins: area.origins, destinations: area.destinations, composition: area.composition, feeders: area.feeders, nearby: area.nearby, junctions,
    selectLinkVph: area.selectLinkVph, areaVc: area.areaVc, linkVph, areaLinkVph: area.areaLinkVph, areaBottlenecks: area.bottlenecks,
    network: { ...net, completedTrips: Math.round(mean(runs.map(r => r.network.completedTrips))), meanTravelTimeS: meanOrNull(runs.map(r => r.network.meanTravelTimeS)), meanDelayS: meanOrNull(runs.map(r => r.network.meanDelayS)),
      gridlockRemovals: Math.round(mean(runs.map(r => r.network.gridlockRemovals))), waitingToEnter: Math.round(mean(runs.map(r => r.network.waitingToEnter))), onNetwork: Math.round(mean(runs.map(r => r.network.onNetwork))) },
    load: { ...runs[0].load, servedShare: mean(runs.map(r => r.load.servedShare)), overloaded: overloadedRuns > n / 2, message: overloadedRuns > n / 2 ? loadMsg : null },
    assignment: area.summary, corridor: corridorInfo,
    perSeed: runs.map(r => {
      const tt = r.directions.map(d => d.travelTimeS).filter((x): x is number => x !== null);
      const ends = r.junctions.filter(j => j.atSection);
      return { seed: r.seed, sectionVph: Math.round(r.directions.reduce((a, d) => a + d.vph, 0)), sectionTimeS: tt.length ? mean(tt) : null, completedTrips: r.network.completedTrips,
        meanTravelTimeS: r.network.meanTravelTimeS, meanDelayS: r.network.meanDelayS, servedShare: r.load.servedShare, gridlockRemovals: r.network.gridlockRemovals, endDelayS: ends.length ? Math.max(...ends.map(j => j.delayS)) : null };
    }),
    evidence: { demand, notes },
  };
}

const meanOrNull = (xs: (number | null)[]) => { const v = xs.filter((x): x is number => x !== null); return v.length ? mean(v) : null; };
export const STATUS_WORD: Record<RoadStatus, string> = { flowing: 'flowing', moderate: 'moderate delay', slow: 'slow', congested: 'congested', severe: 'severely congested', no_traffic: 'almost no traffic' };
const losLabel = (delayS: number, signalised: boolean) => { const t = signalised ? [10, 20, 35, 55, 80] : [10, 15, 25, 35, 50]; const i = t.findIndex(x => delayS <= x); return 'ABCDEF'[i < 0 ? 5 : i]; };

/** Model against observed counts at a counted junction in the area: total entering veh/h. */
export interface CountCheck { id: string; name: string; observedVph: number; demandVph: number; servedVph: number; problem: string | null }

export function countChecks(sim: TrafficMicroSim, layouts: readonly ZoneLayout[], junctions: readonly CountJunction[]): CountCheck[] {
  const { counts, windowS } = sim.movementCounts();
  const perH = 3600 / Math.max(STEP_S, windowS);
  const demand = new Map<string, number>();
  for (const f of sim.demandRouteFlows()) for (const key of routeMovements(f.route, layouts)) demand.set(key, (demand.get(key) ?? 0) + f.vehiclesPerHour);
  return junctions.map(j => {
    const layout = layouts.find(l => l.zone.id === j.id);
    const keys = j.movements.map(m => movementKey(j.id, m.approach, m.turn));
    return { id: j.id, name: j.name, observedVph: Math.round(j.movements.reduce((n, m) => n + (m.LV ?? 0) + (m.HV ?? 0) + (m.TW ?? 0), 0)),
      demandVph: Math.round(keys.reduce((n, k) => n + (demand.get(k) ?? 0), 0)), servedVph: Math.round(keys.reduce((n, k) => n + (counts.get(k) ?? 0) * perH, 0)),
      problem: layout?.problem ?? null };
  });
}

import type { StudyArea, DrivableObject } from './StudyAreaExplorer';
import { LANE_CAPACITY_VPH, STEP_S, type TrafficMicroSim, type MicroSimMetrics } from './TrafficMicroSim';
import type { RoadSection } from './roadSection';
import type { DemandProvenance } from './StudyDemand';
import { routeMovements, movementKey, type ZoneLayout } from '../calibration/junctionMovements';
import type { CountJunction } from '../calibration/observedCounts';

/**
 * What the traffic on one road section looks like in a simulation run:
 * how much uses it (per direction), whether it is under-used, busy or
 * overloaded and why, where its traffic comes from and goes to (select-link),
 * which nearby roads and junctions shape it. Everything is computed from the
 * run's own counts over a window after warm-up.
 */

export type RoadStatus = 'underused' | 'normal' | 'busy' | 'congested' | 'no_traffic';

export interface DirectionFlow {
  /** "northbound", "towards the south-west", ... */
  label: string;
  bearingDeg: number;
  /** Vehicles per hour that drove it in the run (served). */
  vph: number;
  /** Vehicles per hour whose route uses it (demand assigned to it, before queues). */
  demandVph: number;
  lanes: number;
  /** Assumed lane capacity x lanes (veh/h), LANE_CAPACITY_VPH. */
  capacityVph: number;
  vc: number;
  meanSpeedKmh: number | null;
  freeSpeedKmh: number;
  /** Mean speed / free-flow speed (1 = free-flowing). */
  speedRatio: number | null;
  queuedNow: number;
}

export interface Place { label: string; coordinates: [number, number, number]; vph: number; share: number; edge: boolean }
export interface RoadUse { roadName: string; roadClass: string; vph: number; share?: number; vc?: number; speedRatio?: number | null; distanceM: number; segmentKeys: string[] }
export interface JunctionUse { id: string; label: string; coordinates: [number, number]; delayS: number; los: string; maxQueueM: number; vehicles: number; signalised: boolean; distanceM: number; atSection: boolean }

export interface RoadAnalysisResult {
  windowS: number;
  section: { name: string; lengthM: number; carriageways: number; endsAt: string[]; segmentKeys: string[] };
  directions: DirectionFlow[];
  totalVph: number;
  status: RoadStatus;
  /** Plain-language reasons for the status, most important first. */
  reasons: string[];
  /** Section-end junction that limits the road, if any. */
  bottleneck: JunctionUse | null;
  origins: Place[];
  destinations: Place[];
  /** Share of the section's traffic that starts and ends beyond the area (through), or has one end inside it. */
  composition: { throughShare: number; localShare: number };
  /** Roads carrying the section's traffic to and from it (select-link). */
  feeders: RoadUse[];
  /** Busiest roads within NEARBY_M of the section. */
  nearby: RoadUse[];
  junctions: JunctionUse[];
  /** Select-link flow by study-area stretch (veh/h), for the map. */
  selectLinkVph: Map<string, number>;
  /** All link volumes by stretch and direction (veh/h), for comparisons. */
  linkVph: Map<string, number>;
  network: MicroSimMetrics;
  evidence: { demand: DemandProvenance | null; notes: string[] };
}

export const NEARBY_M = 700;
/** Warm-up before counting and counting window of an analysis run (simulated seconds). */
export const ANALYSIS_WARMUP_S = 300;
export const ANALYSIS_MEASURE_S = 900;

const M_PER_DEG_LAT = 111320;
const distM = (a: readonly number[], b: readonly number[]) =>
  Math.hypot((a[0] - b[0]) * M_PER_DEG_LAT * Math.cos(a[1] * Math.PI / 180), (a[1] - b[1]) * M_PER_DEG_LAT);
const bearing = (a: readonly number[], b: readonly number[]) => {
  const dx = (b[0] - a[0]) * Math.cos(a[1] * Math.PI / 180), dy = b[1] - a[1];
  return ((Math.atan2(dx, dy) * 180) / Math.PI + 360) % 360;
};
const COMPASS = ['north', 'north-east', 'east', 'south-east', 'south', 'south-west', 'west', 'north-west'];
export const compass = (deg: number) => COMPASS[Math.round(deg / 45) % 8];
const BOUND = ['northbound', 'north-east', 'eastbound', 'south-east', 'southbound', 'south-west', 'westbound', 'north-west'];
const boundLabel = (deg: number) => { const b = BOUND[Math.round(deg / 45) % 8]; return b.endsWith('bound') ? b : `towards the ${b}`; };
const angleDiff = (a: number, b: number) => { const d = Math.abs(a - b) % 360; return d > 180 ? 360 - d : d; };

function pointToLineM(p: readonly number[], line: readonly (readonly number[])[]): number {
  let best = Infinity;
  for (const q of line) best = Math.min(best, distM(p, q));
  return best;
}

/** Runs an analysis window on a simulator (from an empty network) and analyses the section. */
export function runRoadAnalysis(sim: TrafficMicroSim, area: StudyArea, roads: ReadonlyMap<string, DrivableObject>, section: RoadSection,
  demand: DemandProvenance | null, o: { warmupS?: number; measureS?: number } = {}): RoadAnalysisResult {
  const warm = Math.round((o.warmupS ?? ANALYSIS_WARMUP_S) / STEP_S), meas = Math.round((o.measureS ?? ANALYSIS_MEASURE_S) / STEP_S);
  for (let i = 0; i < warm; i++) sim.step();
  sim.startAnalysis();
  for (let i = 0; i < meas; i++) sim.step();
  return analyseRoad(sim, area, roads, section, demand);
}

/** Analyses the section from the counters since sim.startAnalysis(). */
export function analyseRoad(sim: TrafficMicroSim, area: StudyArea, roads: ReadonlyMap<string, DrivableObject>, section: RoadSection, demand: DemandProvenance | null): RoadAnalysisResult {
  const maybe = sim.analysisCounts();
  if (!maybe) throw new Error('Start the analysis window first.');
  const counts = maybe;
  const perH = 3600 / Math.max(STEP_S, counts.windowS);
  // Demand assigned to each link by the OD routes (veh/h at the run's level and hour)
  const assigned = new Map<string, number>();
  {
    const ids = counts.links.map(l => l.id);
    const q = new Float64Array(ids.length);
    for (const f of sim.demandRouteFlows()) for (const i of f.route) q[i] += f.vehiclesPerHour;
    ids.forEach((id, i) => assigned.set(id, q[i]));
  }
  const segCoords = new Map(area.segments.map(s => [s.key, s.coordinates]));
  const sectionKeys = new Set(section.segmentKeys);
  const linkPts = (l: { segmentKey: string; id: string }) => {
    const c = segCoords.get(l.segmentKey) ?? [];
    return l.id.endsWith('_bwd') ? [...c].reverse() : c;
  };
  const watched = counts.links.filter(l => sectionKeys.has(l.segmentKey));

  // Directions of travel on the section: links grouped by bearing (two carriageways of a divided road, or both directions of a two-way one)
  const groups: { bearing: number; links: typeof watched }[] = [];
  for (const l of watched) {
    const pts = linkPts(l);
    if (pts.length < 2) continue;
    const b = bearing(pts[0], pts[pts.length - 1]);
    const g = groups.find(x => angleDiff(x.bearing, b) < 70);
    if (g) g.links.push(l); else groups.push({ bearing: b, links: [l] });
  }
  const directions: DirectionFlow[] = groups.map(g => {
    const len = g.links.reduce((n, l) => n + l.lengthM, 0) || 1;
    // A section's volume is the length-weighted mean of its stretches' volumes (vehicles join and leave along it)
    const vph = g.links.reduce((n, l) => n + l.entries * perH * l.lengthM, 0) / len;
    const demandVph = g.links.reduce((n, l) => n + (assigned.get(l.id) ?? 0) * l.lengthM, 0) / len;
    const lanes = Math.round(g.links.reduce((n, l) => n + l.lanes * l.lengthM, 0) / len);
    const cls = roads.get(g.links[0].roadId)?.roadClass ?? 'local';
    const capacityVph = Math.max(1, lanes) * (LANE_CAPACITY_VPH[cls] ?? 600);
    const timed = g.links.filter(l => l.meanTimeS !== null && l.meanTimeS > 0);
    const freeS = g.links.reduce((n, l) => n + l.freeFlowS, 0);
    const timedLen = timed.reduce((n, l) => n + l.lengthM, 0), timedS = timed.reduce((n, l) => n + l.meanTimeS!, 0), timedFree = timed.reduce((n, l) => n + l.freeFlowS, 0);
    const meanSpeedKmh = timedS > 0 ? (timedLen / timedS) * 3.6 : null;
    const freeSpeedKmh = (len / Math.max(0.1, freeS)) * 3.6;
    return { label: boundLabel(g.bearing), bearingDeg: g.bearing, vph: Math.round(vph), demandVph: Math.round(demandVph), lanes, capacityVph, vc: vph / capacityVph,
      meanSpeedKmh, freeSpeedKmh, speedRatio: timedS > 0 ? timedFree / timedS : null, queuedNow: g.links.reduce((n, l) => n + l.queuedNow, 0) };
  }).sort((a, b) => b.vph - a.vph);
  const totalVph = directions.reduce((n, d) => n + d.vph, 0);

  // Junctions near the section, and the ones it ends at
  const sectionLines = section.segmentKeys.map(k => segCoords.get(k) ?? []).filter(c => c.length);
  const near = (p: readonly number[]) => Math.min(...sectionLines.map(l => pointToLineM(p, l)));
  const roadNamesAt = new Map<string, Set<string>>();
  for (const l of counts.links) for (const n of [l.from, l.to]) { const s = roadNamesAt.get(n) ?? roadNamesAt.set(n, new Set()).get(n)!; const nm = roads.get(l.roadId)?.name; if (nm && !/^(unnamed|residential|service) road$/i.test(nm)) s.add(nm); }
  const junctionLabel = (id: string) => { const names = [...(roadNamesAt.get(id) ?? [])].filter(n => n !== section.name).slice(0, 2); return names.length ? `${section.name} / ${names.join(' / ')}`.replace(/^ \/ /, '') : 'Junction'; };
  const sectionNodes = new Set(watched.flatMap(l => [l.from, l.to]));
  const junctions: JunctionUse[] = sim.junctionStats().map(j => ({ id: j.id, label: junctionLabel(j.id), coordinates: [j.lng, j.lat] as [number, number], delayS: j.meanControlDelayS, los: j.los, maxQueueM: j.maxQueueM, vehicles: j.vehicles, signalised: j.signalised,
    distanceM: near([j.lng, j.lat]), atSection: sectionNodes.has(j.id) })).filter(j => j.distanceM <= NEARBY_M).sort((a, b) => b.delayS * b.vehicles - a.delayS * a.vehicles).slice(0, 8);
  const sectionJunctions = junctions.filter(j => j.atSection && j.vehicles >= 20);
  const worstEnd = sectionJunctions.sort((a, b) => b.delayS - a.delayS)[0] ?? null;

  // Status and why
  const reasons: string[] = [];
  let status: RoadStatus;
  const busiest = directions[0];
  const slowest = [...directions].filter(d => d.speedRatio !== null).sort((a, b) => a.speedRatio! - b.speedRatio!)[0];
  const bottleneck = worstEnd && (worstEnd.los === 'E' || worstEnd.los === 'F') ? worstEnd : null;
  if (!busiest || totalVph < 10) {
    status = 'no_traffic';
    reasons.push('Almost no simulated vehicles use this section. Check the routes through the area: traffic may have a faster way, or the road may be poorly connected.');
  } else if ((slowest && slowest.speedRatio! < 0.5) || busiest.vc > 0.9) {
    status = 'congested';
    if (slowest && slowest.speedRatio! < 0.5) reasons.push(`${capital(slowest.label)} traffic moves at ${Math.round(slowest.meanSpeedKmh ?? 0)} km/h, ${Math.round(100 * slowest.speedRatio!)}% of free-flow speed.`);
    if (bottleneck) reasons.push(`The junction at ${bottleneck.label} holds traffic back: ${Math.round(bottleneck.delayS)} s average delay (level of service ${bottleneck.los}), queues up to ${Math.round(bottleneck.maxQueueM)} m. The junction, not the road's width, limits the flow.`);
    if (busiest.vc > 0.9) reasons.push(`${capital(busiest.label)}, it carries ${busiest.vph.toLocaleString()} veh/h on ${busiest.lanes} lane${busiest.lanes === 1 ? '' : 's'}, ${Math.round(100 * busiest.vc)}% of the assumed capacity: more traffic than the lanes can take.`);
    else if (!bottleneck) reasons.push('Volume is below the lanes\' capacity, so the slowdown comes from queues reaching back from a junction further along.');
  } else if (busiest.vc > 0.6) {
    status = 'busy';
    reasons.push(`${capital(busiest.label)}, it carries ${busiest.vph.toLocaleString()} veh/h, ${Math.round(100 * busiest.vc)}% of the assumed capacity of its ${busiest.lanes} lane${busiest.lanes === 1 ? '' : 's'}, still moving.`);
    if (bottleneck) reasons.push(`Watch the junction at ${bottleneck.label}: ${Math.round(bottleneck.delayS)} s average delay (level of service ${bottleneck.los}).`);
  } else if (busiest.vc < 0.25) {
    status = 'underused';
    reasons.push(`${capital(busiest.label)}, it carries ${busiest.vph.toLocaleString()} veh/h, ${Math.round(100 * busiest.vc)}% of the assumed capacity: room to spare.`);
  } else {
    status = 'normal';
    reasons.push(`${capital(busiest.label)}, it carries ${busiest.vph.toLocaleString()} veh/h, ${Math.round(100 * busiest.vc)}% of the assumed capacity, near free-flow speed.`);
    if (bottleneck) reasons.push(`The junction at ${bottleneck.label} is the weak point: ${Math.round(bottleneck.delayS)} s average delay (level of service ${bottleneck.los}).`);
  }

  if (busiest && busiest.demandVph > 1.25 * busiest.vph && busiest.demandVph - busiest.vph > 100)
    reasons.push(`${busiest.demandVph.toLocaleString()} veh/h are routed ${busiest.label} along it but ${busiest.vph.toLocaleString()} got through in the run: queues on the way hold back the rest.`);

  // Select-link: where the section's vehicles come from and go to
  const boundaryJunctions = new Set(area.boundary.map(b => sim.junctionOfNode(b.nodeId)));
  const centre = sectionLines.length ? sectionLines[Math.floor(sectionLines.length / 2)][0] : [area.bounds.minLng, area.bounds.minLat];
  const roadAtNode = (id: string, which: 'from' | 'to') => {
    const ls = counts.links.filter(l => (which === 'from' ? l.from : l.to) === id).sort((a, b) => (b.selectEntries - a.selectEntries) || (b.entries - a.entries));
    return ls.length ? roads.get(ls[0].roadId)?.name || 'an unnamed road' : 'a road';
  };
  const placeLabel = (id: string, which: 'from' | 'to', edge: boolean) => {
    const c = sim.nodeCoordinates(id) ?? [0, 0, 0];
    const dir = compass(bearing(centre, c));
    const road = roadAtNode(id, which);
    return edge ? `${which === 'from' ? 'From' : 'To'} beyond the area, ${dir}, via ${road}` : `${which === 'from' ? 'From' : 'To'} streets ${Math.round(distM(centre, c) / 100) * 100} m ${dir}, near ${road}`;
  };
  const totalSelect = [...counts.selectOd.values()].reduce((n, v) => n + v, 0);
  const aggregate = (which: 'from' | 'to') => {
    const by = new Map<string, number>();
    for (const [key, n] of counts.selectOd) { const [f, t] = key.split('>'); const id = which === 'from' ? f : t; by.set(id, (by.get(id) ?? 0) + n); }
    const places = new Map<string, Place>();
    for (const [id, n] of by) {
      const edge = boundaryJunctions.has(id);
      const label = placeLabel(id, which, edge);
      const p = places.get(label);
      if (p) { p.vph += n * perH; p.share += n / Math.max(1, totalSelect); }
      else places.set(label, { label, coordinates: sim.nodeCoordinates(id) ?? [0, 0, 0], vph: n * perH, share: n / Math.max(1, totalSelect), edge });
    }
    return [...places.values()].sort((a, b) => b.vph - a.vph).slice(0, 6).map(p => ({ ...p, vph: Math.round(p.vph) }));
  };
  let through = 0;
  for (const [key, n] of counts.selectOd) { const [f, t] = key.split('>'); if (boundaryJunctions.has(f) && boundaryJunctions.has(t)) through += n; }

  // Roads by name: select-link flow (feeders) and all traffic (nearby)
  const byRoad = (pick: (l: (typeof counts.links)[number]) => number, filter: (l: (typeof counts.links)[number]) => boolean) => {
    const m = new Map<string, { roadName: string; roadClass: string; vph: number; len: number; cap: number; t: number; tf: number; dist: number; keys: Set<string> }>();
    for (const l of counts.links) {
      if (!filter(l)) continue;
      const v = pick(l) * perH;
      if (v <= 0) continue;
      const r = roads.get(l.roadId);
      const name = r?.name || 'Unnamed road';
      const key = `${name}|${r?.roadClass}`;
      const e = m.get(key) ?? m.set(key, { roadName: name, roadClass: r?.roadClass ?? 'local', vph: 0, len: 0, cap: 0, t: 0, tf: 0, dist: Infinity, keys: new Set() }).get(key)!;
      // Busiest stretch of the road (per direction)
      if (v > e.vph) { e.vph = v; e.cap = Math.max(1, l.lanes) * (LANE_CAPACITY_VPH[r?.roadClass ?? 'local'] ?? 600); }
      if (l.meanTimeS) { e.t += l.meanTimeS; e.tf += l.freeFlowS; }
      e.keys.add(l.segmentKey);
      const pts = linkPts(l);
      if (pts.length) e.dist = Math.min(e.dist, near(pts[Math.floor(pts.length / 2)]));
    }
    return [...m.values()];
  };
  const sectionNames = new Set(watched.map(l => roads.get(l.roadId)?.name).filter(Boolean));
  const feeders: RoadUse[] = byRoad(l => l.selectEntries, l => !sectionKeys.has(l.segmentKey) && !sectionNames.has(roads.get(l.roadId)?.name))
    .sort((a, b) => b.vph - a.vph).slice(0, 6)
    .map(r => ({ roadName: r.roadName, roadClass: r.roadClass, vph: Math.round(r.vph), share: totalVph ? r.vph / Math.max(1, busiest?.vph ?? 1) : 0, distanceM: Math.round(r.dist), segmentKeys: [...r.keys] }));
  const nearby: RoadUse[] = byRoad(l => l.entries, l => !sectionKeys.has(l.segmentKey))
    .filter(r => r.dist <= NEARBY_M && r.roadClass !== 'local' || r.dist <= 250)
    .sort((a, b) => b.vph - a.vph).slice(0, 8)
    .map(r => ({ roadName: r.roadName, roadClass: r.roadClass, vph: Math.round(r.vph), vc: r.vph / r.cap, speedRatio: r.t > 0 ? r.tf / r.t : null, distanceM: Math.round(r.dist), segmentKeys: [...r.keys] }));

  const selectLinkVph = new Map<string, number>(), linkVph = new Map<string, number>();
  for (const l of counts.links) {
    if (l.selectEntries) selectLinkVph.set(l.segmentKey, Math.max(selectLinkVph.get(l.segmentKey) ?? 0, l.selectEntries * perH));
    linkVph.set(l.id, l.entries * perH);
  }

  const notes: string[] = [];
  if (demand?.source !== 'calibrated') notes.push('No traffic count on this road: volumes are model estimates from land use and counted Pune arterial flows, not measurements.');
  if (demand?.components && !demand.components.throughIncluded) notes.push('Through traffic is switched off: only trips made by the area\'s own buildings are shown.');
  if (section.carriageways === 2) notes.push('Divided road: both carriageways are counted, each as its own direction.');

  return {
    windowS: counts.windowS,
    section: { name: section.name, lengthM: section.lengthM, carriageways: section.carriageways, endsAt: section.endsAt, segmentKeys: section.segmentKeys },
    directions, totalVph, status, reasons, bottleneck,
    origins: aggregate('from'), destinations: aggregate('to'),
    composition: { throughShare: totalSelect ? through / totalSelect : 0, localShare: totalSelect ? 1 - through / totalSelect : 0 },
    feeders, nearby, junctions, selectLinkVph, linkVph, network: sim.getMetrics(),
    evidence: { demand, notes },
  };
}

const capital = (s: string) => s.charAt(0).toUpperCase() + s.slice(1);

/** Model against observed counts at a counted junction in the area: total entering veh/h. */
export interface CountCheck { id: string; name: string; observedVph: number; demandVph: number; servedVph: number; problem: string | null }

/**
 * Compares the model with the counted junctions inside the area (whole-junction
 * entering volume, the counts' peak hour): the demand routed through each and
 * the vehicles that got through in the run. Call countZonesFor() before the run.
 */
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

/**
 * Calibrating a study area's demand against observed junction counts.
 *
 *  1. Counted junctions inside the study area become count zones in the
 *     simulator (junctionMovements.ts) with compass-labelled arms.
 *  2. "Simulated" flows are measured by running the micro-simulation from an
 *     empty network: a warm-up, then a counting window, scaled to veh/h.
 *  3. The calibration step scales each OD trip by a factor fitted with
 *     bounded iterative proportional fitting (ipf.ts) so that the flows the
 *     trips route through each counted movement match the counts. A counted
 *     movement's volume is driven by the counts: one "count-seeded" trip per
 *     vehicle class is added through every counted movement (upstream end of
 *     the approach to downstream end of the exit, starting at the observed
 *     class volume) and fitted together with the estimated trips, so the
 *     building heuristic only fills the rest of the network. (With
 *     countDriven: false, only movements no estimated trip reaches are seeded.)
 *     Seeded trips are listed so the demand they add is visible.
 *  4. The calibrated plan is measured again the same way, giving before/after
 *     GEH on simulated flows (not only on the fitted assignment).
 *
 * The after-GEH is measured on the same counts that were fitted, so it shows
 * goodness of fit, not independent validation; the panel says so.
 */
import type { DemandPlan } from '../simulation/StudyDemand';
import { snapDemandPlan } from '../simulation/StudyDemand';
import { TrafficMicroSim, STEP_S, OD_REFERENCE_LEVEL, type MicroSimOptions, type MicroSimMetrics, type VehicleKind } from '../simulation/TrafficMicroSim';
import type { StudyArea, DrivableObject, Bounds } from '../simulation/StudyAreaExplorer';
import { geh, summarizeGeh, type GehSummary } from './geh';
import { calibrateFlows, type IpfOptions, type IpfResult } from './ipf';
import { routeMovements, movementKey, distanceM, type CountZone, type ZoneLayout, type LinkEnds } from './junctionMovements';
import { CARDINALS, TURNS, movementVeh, movementPcu, type CountDataset, type CountJunction, type Cardinal, type Turn, type VehicleClass } from './observedCounts';

export const WARMUP_S = 300;
export const MEASURE_S = 900;

/** Count zone radius: wide enough to hold a divided-road crossing (its carriageways settle within ~60 m in Pune OSM data) or a roundabout ring. */
export const zoneRadiusM = (j: CountJunction) => (j.location.matched?.kind === 'roundabout' ? 70 : 60);

/** Counted junctions whose located point lies inside the bounds. */
export function junctionsIn(ds: CountDataset, bounds: Bounds): CountJunction[] {
  return ds.junctions.filter(j => j.location.lon >= bounds.minLng && j.location.lon <= bounds.maxLng && j.location.lat >= bounds.minLat && j.location.lat <= bounds.maxLat);
}

export const zoneFor = (j: CountJunction): CountZone => ({ id: j.id, lng: j.location.lon, lat: j.location.lat, radiusM: zoneRadiusM(j) });

/** Observed veh/h per movement key, for the junctions given. */
export function observedFlows(junctions: readonly CountJunction[]): Map<string, number> {
  const out = new Map<string, number>();
  for (const j of junctions) for (const m of j.movements) out.set(movementKey(j.id, m.approach, m.turn), movementVeh(m));
  return out;
}

export interface CalibrationRow {
  junctionId: string;
  junctionName: string;
  approach: Cardinal;
  turn: Turn;
  observed: number;
  before: number | null;
  after: number | null;
  gehBefore: number | null;
  gehAfter: number | null;
}

export interface JunctionCheck {
  id: string;
  name: string;
  /** Why this junction's movements are not compared, or null. */
  problem: string | null;
  arms: number;
  maxCardinalErrorDeg: number | null;
}

/** One table row per counted movement of the junctions that laid out cleanly. */
export function compareRows(junctions: readonly CountJunction[], layouts: readonly ZoneLayout[], before: ReadonlyMap<string, number> | null, after: ReadonlyMap<string, number> | null): CalibrationRow[] {
  const ok = new Set(layouts.filter(l => !l.problem).map(l => l.zone.id));
  const rows: CalibrationRow[] = [];
  for (const j of junctions) {
    if (!ok.has(j.id)) continue;
    for (const a of CARDINALS) for (const t of TURNS) {
      const m = j.movements.find(x => x.approach === a && x.turn === t);
      if (!m) continue;
      const key = movementKey(j.id, a, t), observed = movementVeh(m);
      const b = before ? before.get(key) ?? 0 : null, c = after ? after.get(key) ?? 0 : null;
      rows.push({ junctionId: j.id, junctionName: j.name, approach: a, turn: t, observed, before: b, after: c,
        gehBefore: b === null ? null : geh(b, observed), gehAfter: c === null ? null : geh(c, observed) });
    }
  }
  return rows;
}

export const summarize = (rows: readonly CalibrationRow[], which: 'gehBefore' | 'gehAfter'): GehSummary | null =>
  rows.some(r => r[which] !== null) ? summarizeGeh(rows.map(r => r[which]).filter((g): g is number => g !== null)) : null;

export interface SimSetup {
  area: StudyArea;
  roads: ReadonlyMap<string, DrivableObject>;
  options: Omit<MicroSimOptions, 'demandTrips'>;
  /**
   * Counted junctions whose signals are timed (Webster) from their observed
   * approach flows rather than from the assigned demand.
   */
  signalDesignCounts?: readonly CountJunction[];
}

/**
 * Observed design flow (PCU/h, IRC:106 factors of the count file) arriving on
 * each inbound link of the counted junctions that laid out cleanly. An
 * approach with several inbound carriageways splits its flow by their lanes.
 */
export function observedDesignFlows(junctions: readonly CountJunction[], layouts: readonly ZoneLayout[], linkIds: readonly string[], lanesOf: (id: string) => number,
  factors: Record<VehicleClass, number> = { LV: 1, HV: 2.2, TW: 0.75 }): Map<string, number> {
  const out = new Map<string, number>();
  for (const layout of layouts) {
    if (layout.problem) continue;
    const j = junctions.find(x => x.id === layout.zone.id);
    if (!j) continue;
    for (const arm of layout.arms) {
      if (!arm.cardinal || !arm.inbound.length) continue;
      const q = j.movements.filter(m => m.approach === arm.cardinal).reduce((n, m) => n + movementPcu(m, factors), 0);
      const lanes = arm.inbound.map(i => Math.max(1, lanesOf(linkIds[i])));
      const total = lanes.reduce((a, b) => a + b, 0);
      arm.inbound.forEach((i, k) => out.set(linkIds[i], q * lanes[k] / total));
    }
  }
  return out;
}

/** Applies observed design flows to a simulator whose count zones are set. */
export function timeSignalsFromCounts(sim: TrafficMicroSim, junctions: readonly CountJunction[], layouts: readonly ZoneLayout[], factors?: Record<VehicleClass, number>) {
  const lanes = sim.debugLanes();
  const ids = [...lanes.keys()];
  sim.setSignalDesignFlows(observedDesignFlows(junctions, layouts, ids, id => lanes.get(id)?.length ?? 1, factors));
}

export function buildSim(setup: SimSetup, plan: DemandPlan): TrafficMicroSim {
  const { area, roads, options } = setup;
  return new TrafficMicroSim(area, roads, { ...options, demandTrips: snapDemandPlan(plan, area.network, 250, new Set(area.segments.map(s => s.key))) });
}

/** Runs a plan from an empty network and returns veh/h per counted movement. */
export async function measureFlows(setup: SimSetup, plan: DemandPlan, zones: readonly CountZone[],
  opts: { warmupS?: number; measureS?: number; yieldEveryMs?: number; aborted?: () => boolean; onProgress?: (share: number) => void } = {}):
  Promise<{ flows: Map<string, number>; layouts: ZoneLayout[]; windowS: number; metrics: MicroSimMetrics }> {
  const { warmupS = WARMUP_S, measureS = MEASURE_S, yieldEveryMs = 20, aborted, onProgress } = opts;
  const sim = buildSim(setup, plan);
  const layouts = sim.setCountZones(zones);
  if (setup.signalDesignCounts?.length) timeSignalsFromCounts(sim, setup.signalDesignCounts, layouts);
  const total = Math.round((warmupS + measureS) / STEP_S), warm = Math.round(warmupS / STEP_S);
  let yieldedAt = performance.now();
  for (let i = 0; i < total; i++) {
    if (i === warm) sim.startCounting();
    sim.step();
    if (performance.now() - yieldedAt > yieldEveryMs) {
      await new Promise<void>(r => setTimeout(r, 0));
      if (aborted?.()) throw new Error('The run was cancelled because the project changed.');
      onProgress?.(i / total);
      yieldedAt = performance.now();
    }
  }
  const { counts, windowS } = sim.movementCounts();
  const flows = new Map([...counts].map(([k, n]) => [k, (n * 3600) / Math.max(windowS, STEP_S)]));
  return { flows, layouts, windowS, metrics: sim.getMetrics() };
}

/** Count classes to simulated classes: LV light vehicles as cars, HV heavy vehicles as buses, TW two-wheelers. */
const KIND_OF: Record<VehicleClass, VehicleKind> = { LV: 'car', HV: 'bus', TW: 'two_wheeler' };

export interface SeedTrip { junctionId: string; approach: Cardinal; turn: Turn; kind: VehicleKind; vehiclesPerHour: number }

/** Count-seeded trips for counted movements no existing trip passes through. */
export function seedTrips(junctions: readonly CountJunction[], layouts: readonly ZoneLayout[], links: readonly LinkEnds[], reachable: ReadonlySet<string>):
  { trips: DemandPlan['trips']; seeds: SeedTrip[] } {
  const byIndex = new Map(links.map(l => [l.index, l]));
  const trips: DemandPlan['trips'] = [], seeds: SeedTrip[] = [];
  for (const layout of layouts) {
    if (layout.problem) continue;
    const j = junctions.find(x => x.id === layout.zone.id);
    if (!j) continue;
    for (const m of j.movements) {
      if (reachable.has(movementKey(j.id, m.approach, m.turn))) continue;
      const exit = CARDINALS[(CARDINALS.indexOf(m.approach) + (m.turn === 'left' ? 1 : m.turn === 'straight' ? 2 : 3)) % 4];
      const inArm = layout.arms.find(a => a.cardinal === m.approach), outArm = layout.arms.find(a => a.cardinal === exit);
      const inLink = inArm?.inbound[0], outLink = outArm?.outbound[0];
      if (inLink === undefined || outLink === undefined) continue; // that arm has no road in that direction in the model
      const from = byIndex.get(inLink)!.from, to = byIndex.get(outLink)!.to;
      for (const c of ['LV', 'HV', 'TW'] as VehicleClass[]) {
        const v = m[c] ?? 0;
        if (v <= 0) continue;
        trips.push({ from: [from[0], from[1], from[2] ?? 0], to: [to[0], to[1], to[2] ?? 0], vehiclesPerHour: v, kind: KIND_OF[c] });
        seeds.push({ junctionId: j.id, approach: m.approach, turn: m.turn, kind: KIND_OF[c], vehiclesPerHour: v });
      }
    }
  }
  return { trips, seeds };
}

export interface CalibrationFit {
  plan: DemandPlan;
  ipf: IpfResult;
  seeds: SeedTrip[];
  /** Fitted movements that remain out of reach (no route passes them even with seeds). */
  unreachable: string[];
  layouts: ZoneLayout[];
  /** Plan flows are multiplied by this inside the simulator (demand level ÷ reference level). */
  levelFactor: number;
}

/**
 * Fits trip factors to the counts. `base` is the uncalibrated plan; the
 * result is a new plan with every trip's flow multiplied by its factor plus
 * any seeded trips. Plan flows are scaled so that, at the demand level in
 * `setup`, the routed flows equal the fitted ones.
 */
export function fitPlan(setup: SimSetup, base: DemandPlan, junctions: readonly CountJunction[], options: IpfOptions & { countDriven?: boolean } = {}): CalibrationFit {
  const zones = junctions.map(zoneFor);
  const observed = observedFlows(junctions);
  let sim = buildSim(setup, base);
  let layouts = sim.setCountZones(zones);
  const valid = new Set(layouts.filter(l => !l.problem).map(l => l.zone.id));
  for (const key of [...observed.keys()]) if (!valid.has(key.split('|')[0])) observed.delete(key);
  const reach = (s: TrafficMicroSim) => new Set(s.demandRouteFlows().filter(f => f.vehiclesPerHour > 0).flatMap(f => routeMovements(f.route, layouts)));
  const levelFactor = setup.options.demandLevel / OD_REFERENCE_LEVEL;
  // Count-driven OD: every counted movement gets trips at its observed class volume
  // (not only those no estimated trip reaches), so the counts, not the building
  // heuristic, set the volume through counted junctions; IPF then fits both together.
  const { trips: seedPlanTrips, seeds } = seedTrips(junctions, layouts, sim.linkEnds(), options.countDriven === false ? reach(sim) : new Set());
  // Seeds start at the observed volume as the simulator will run them (it multiplies plan flows by levelFactor)
  const plan: DemandPlan = { ...base, trips: [...base.trips, ...seedPlanTrips.map(t => ({ ...t, vehiclesPerHour: t.vehiclesPerHour / levelFactor }))] };
  if (seedPlanTrips.length) {
    sim = buildSim(setup, plan);
    layouts = sim.setCountZones(zones);
  }
  const flows = sim.demandRouteFlows();
  const incidence = flows.map(f => routeMovements(f.route, layouts));
  const ipf = calibrateFlows(flows.map(f => f.vehiclesPerHour), incidence, observed, options);
  const factorOf = new Map(flows.map((f, i) => [f.index, ipf.factors[i]]));
  const calibrated: DemandPlan = {
    trips: plan.trips.map((t, i) => ({ ...t, vehiclesPerHour: t.vehiclesPerHour * (factorOf.get(i) ?? 1) })),
    provenance: { ...plan.provenance, source: 'calibrated', vehiclesPerHour: 0, pairCount: plan.trips.length,
      label: `${plan.provenance.label} Scaled to observed turning counts by bounded IPF (${ipf.iterations} iterations${ipf.converged ? ', converged' : ', stopped before converging'})${seeds.length ? `; ${seeds.length} count-seeded trip(s) added` : ''}.` },
  };
  calibrated.provenance.vehiclesPerHour = calibrated.trips.reduce((n, t) => n + t.vehiclesPerHour, 0);
  return { plan: calibrated, ipf, seeds, unreachable: ipf.unreachable, layouts, levelFactor };
}

export function junctionChecks(junctions: readonly CountJunction[], layouts: readonly ZoneLayout[]): JunctionCheck[] {
  return junctions.map(j => {
    const l = layouts.find(x => x.zone.id === j.id);
    return { id: j.id, name: j.name, problem: l ? l.problem : 'Not in the simulated network.', arms: l?.arms.length ?? 0, maxCardinalErrorDeg: l?.maxCardinalErrorDeg ?? null };
  });
}

/** Distance from a point to the nearest counted junction (for "no counts here" hints). */
export function nearestCounted(ds: CountDataset, lng: number, lat: number): { junction: CountJunction; distanceM: number } | null {
  let best: { junction: CountJunction; distanceM: number } | null = null;
  for (const j of ds.junctions) {
    const d = distanceM(lng, lat, j.location.lon, j.location.lat);
    if (!best || d < best.distanceM) best = { junction: j, distanceM: d };
  }
  return best;
}

/** CSV of the calibration table (for the report and for reviewers). */
export function rowsToCsv(rows: readonly CalibrationRow[]): string {
  const f = (v: number | null) => (v === null ? '' : (Math.round(v * 10) / 10).toString());
  return ['junction_id,junction,approach,turn,observed_veh_h,simulated_before_veh_h,simulated_after_veh_h,geh_before,geh_after',
    ...rows.map(r => [r.junctionId, `"${r.junctionName}"`, r.approach, r.turn, r.observed, f(r.before), f(r.after), f(r.gehBefore), f(r.gehAfter)].join(','))].join('\n');
}

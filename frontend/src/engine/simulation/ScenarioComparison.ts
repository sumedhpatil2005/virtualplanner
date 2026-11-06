import type { RoadAnalysisResult, Bottleneck, BindingSegment, DirectionFlow } from './RoadAnalysis';
import type { AnalysisOutput } from './analysisJob';
import type { DrivableObject } from './StudyAreaExplorer';
import { isGenericRoadName } from './roadSection';

/**
 * Existing city against a proposal (docs/OVERHAUL.md §8). Both are analysed
 * on the same frozen OD demand, hour and seeds: the area assignment re-routes
 * the demand on the edited network (a new road or bridge changes where traffic
 * goes), and the corridor is simulated with every seed. Differences are then
 * the network's doing.
 *
 * A change is called better only when (a) the measures that improve do so in
 * every seed, beyond the noise threshold, and (b) nothing gets seriously worse
 * elsewhere: no new over-capacity bottleneck in the area and no rise in the
 * area's total travel time. Otherwise it is mixed or no clear change, and the
 * panel says which part held it back.
 */
export type Verdict = 'better' | 'worse' | 'mixed' | 'no_change';

export interface Delta { label: string; before: number | null; after: number | null; unit: string; lowerIsBetter: boolean; change: number | null; good: boolean | null;
  /** Seeds in which the change has the same sign as the mean (for simulated measures). */
  agreement?: { same: number; of: number };
  /** Why a value is missing, when one side has none. */
  note?: string }
export interface RoadChange { roadName: string; before: number; after: number; change: number; segmentKeys: string[]; vcBefore: number; vcAfter: number }

export interface ComparisonResult {
  kind: 'infrastructure' | 'development';
  demandBefore: number;
  demandAfter: number;
  section: Delta[];
  network: Delta[];
  /** Whole study area, from the deterministic assignment. */
  area: Delta[];
  /** Roads whose traffic changed most (assignment, veh/h on their busiest stretch). */
  rerouting: RoadChange[];
  /** Roads with clearly less load (v/c down) and clearly more (v/c up). */
  winners: RoadChange[];
  losers: RoadChange[];
  /** Over-capacity places in the proposal that were not in the existing city. */
  newBottlenecks: Bottleneck[];
  /** Per direction of the selected road whose lanes were edited: whether its capacity followed, and which stretch sets it (docs/OVERHAUL.md §16). */
  laneInsights: LaneInsight[];
  /** Change in volume/capacity by stretch (after - before), for the map. */
  segmentChange: Map<string, number>;
  verdict: { section: Verdict; network: Verdict; area: Verdict; overall: Verdict; summary: string };
  confidence: { level: 'low' | 'medium' | 'high'; text: string };
  caveats: string[];
  /** The two runs' demand, hour, seeds and duration, and whether they match (absent when the caller passed none). */
  inputs?: InputCheck;
}

/** What a run's figures depend on besides the network. A comparison holds these fixed, so a difference is the network's doing. */
export interface RunInputs {
  /** Content key of the OD demand plan, its trip count and planned veh/h (before the hour factor). */
  demandKey: string; trips: number; plannedVph: number;
  hour: number; hourFactor: number;
  /** Seeds the analysis actually ran, in order. */
  seeds: number[];
  measureS: number;
}
export interface InputCheck { before: RunInputs; after: RunInputs; matched: boolean; mismatches: ('demand' | 'hour' | 'seeds' | 'duration')[] }

/** Whether two runs used the same demand, hour, seeds and duration. `newDemand`: a development scenario, where the demand is meant to differ. */
export function checkRunInputs(before: RunInputs, after: RunInputs, newDemand = false): InputCheck {
  const mismatches: InputCheck['mismatches'] = [];
  if (!newDemand && (before.demandKey !== after.demandKey || before.trips !== after.trips || Math.abs(before.plannedVph - after.plannedVph) > 1e-6)) mismatches.push('demand');
  if (before.hour !== after.hour || Math.abs(before.hourFactor - after.hourFactor) > 1e-9) mismatches.push('hour');
  if (before.seeds.length !== after.seeds.length || before.seeds.some((x, i) => x !== after.seeds[i])) mismatches.push('seeds');
  if (before.measureS !== after.measureS) mismatches.push('duration');
  return { before, after, matched: mismatches.length === 0, mismatches };
}

/**
 * What a lane edit did to the capacity of one direction of the selected road
 * (model output: IRC:106 mid-block capacity of the direction's narrowest
 * stretch). `unchanged_elsewhere`: lanes were edited on part of the direction
 * but its capacity did not move, because a stretch that was not edited still
 * sets it (widening only a bridge deck leaves its 2-lane approaches as the
 * limit). `raised` / `lowered`: it moved; `binding` says which stretch sets it
 * now. `newBottlenecksNearby`: over-capacity places new in the proposal within
 * NEAR_EDIT_M of an edited way (the queue may have moved downstream).
 */
export interface LaneInsight {
  direction: string;
  editedRoadIds: string[];
  /** The edited ways in this direction, with their lanes after the edit. */
  edited: BindingSegment[];
  lanesBefore: [number, number];
  lanesAfter: [number, number];
  capacityBefore: number;
  capacityAfter: number;
  capacityChanged: boolean;
  /** The stretch that sets the capacity after the edit, and whether it is one of the edited ways. */
  binding: BindingSegment | null;
  bindingSegments: BindingSegment[];
  bindingEdited: boolean;
  /** The binding way differs from the existing city's. */
  bindingMoved: boolean;
  /** The stop line at a signalised end, not the mid-block, sets the capacity after the edit. */
  signalLimited: boolean;
  newBottlenecksNearby: Bottleneck[];
  kind: 'unchanged_elsewhere' | 'unchanged' | 'raised' | 'lowered';
  text: string;
}

const NEAR_EDIT_M = 800;
const laneSig = (r: DrivableObject | undefined) => {
  if (!r) return null;
  const sec = 'sections' in r ? r.sections?.[0] : undefined;
  return JSON.stringify([r.laneCount, sec?.carriagewayA?.lanes ?? null, sec?.carriagewayB?.lanes ?? null, r.isOneWay]);
};
const fmtN = (n: number) => Math.round(n).toLocaleString('en-US');
const ways = (bs: readonly BindingSegment[]) => bs.map(b => `${b.roadId}, ${fmtN(b.lengthM)} m`).join('; ');
const capital = (s: string) => s.charAt(0).toUpperCase() + s.slice(1);

/** Lane insights for the directions of the selected road whose ways had their lanes changed between the two networks. */
export function laneInsights(before: readonly DirectionFlow[], after: readonly DirectionFlow[], roads: { before: ReadonlyMap<string, DrivableObject>; after: ReadonlyMap<string, DrivableObject> }, newBottlenecks: readonly Bottleneck[]): LaneInsight[] {
  const changed = new Set<string>();
  for (const [id, r] of roads.after) if (laneSig(r) !== laneSig(roads.before.get(id))) changed.add(id);
  if (!changed.size) return [];
  const M = 111320;
  const dist = (p: readonly number[], q: readonly number[]) => Math.hypot((p[0] - q[0]) * M * Math.cos(p[1] * Math.PI / 180), (p[1] - q[1]) * M);
  const out: LaneInsight[] = [];
  for (const d of after) {
    const editedRoadIds = (d.roadIds ?? []).filter(id => changed.has(id));
    if (!editedRoadIds.length) continue;
    const b = before.find(x => x.label === d.label) ?? before.find(x => Math.abs((((x.bearingDeg - d.bearingDeg) % 360) + 540) % 360 - 180) < 30);
    if (!b) continue;
    const capacityBefore = b.midblockPcu, capacityAfter = d.midblockPcu;
    const capacityChanged = Math.abs(capacityAfter - capacityBefore) >= 1;
    const binding = d.binding ?? null;
    const bindingEdited = !!binding && editedRoadIds.includes(binding.roadId);
    const edited = (d.segments ?? []).filter(s => editedRoadIds.includes(s.roadId));
    const pts = editedRoadIds.flatMap(id => roads.after.get(id)?.coordinates ?? []);
    const newBottlenecksNearby = newBottlenecks.filter(x => pts.some(p => dist(p, x.coordinates) < NEAR_EDIT_M));
    const kind: LaneInsight['kind'] = capacityChanged ? (capacityAfter > capacityBefore ? 'raised' : 'lowered') : binding && !bindingEdited ? 'unchanged_elsewhere' : 'unchanged';
    const signalLimited = d.capacityBasis === 'signal';
    const lim = binding ? `a ${binding.lanes}-lane stretch of ${binding.name} (${binding.roadId}, ${fmtN(binding.lengthM)} m${(d.bindingSegments?.length ?? 1) > 1 ? `, and ${(d.bindingSegments!.length - 1)} more at the same capacity: ${ways(d.bindingSegments!.slice(1))}` : ''})` : 'another stretch';
    const editedPhrase = edited.length ? edited.map(e => `${e.lanes}-lane ${e.roadId} (${fmtN(e.lengthM)} m)`).join(', ') : editedRoadIds.join(', ');
    let text: string;
    if (kind === 'unchanged_elsewhere') text = `${capital(d.label)} capacity is still ${fmtN(capacityAfter)} PCU/h: it is set by ${lim}. The edited ${editedPhrase} ${edited.length === 1 ? "isn't" : "aren't"} the constraint.`;
    else if (kind === 'unchanged') text = `${capital(d.label)} mid-block capacity did not change (${fmtN(capacityAfter)} PCU/h).`;
    else text = `${capital(d.label)} mid-block capacity ${kind === 'raised' ? 'rises' : 'falls'} from ${fmtN(capacityBefore)} to ${fmtN(capacityAfter)} PCU/h${binding && !bindingEdited ? `, now set by ${lim}, which was not edited` : ''}.`;
    if (signalLimited) text += ` The signal at its end (${fmtN(d.stopLinePcu ?? 0)} PCU/h at the stop line) limits it more than the road does.`;
    if (newBottlenecksNearby.length) text += ` A new over-capacity stretch appears nearby: ${newBottlenecksNearby.map(x => `${x.roadName} (${Math.round(x.vc * 100)}%)`).join(', ')}; the queue may have moved there.`;
    text += ' Model output (IRC:106 capacity of the narrowest stretch, estimated demand).';
    out.push({ direction: d.label, editedRoadIds, edited, lanesBefore: b.lanesRange, lanesAfter: d.lanesRange, capacityBefore, capacityAfter, capacityChanged, binding, bindingSegments: d.bindingSegments ?? [],
      bindingEdited, bindingMoved: (b.binding?.roadId ?? null) !== (binding?.roadId ?? null), signalLimited, newBottlenecksNearby, kind, text });
  }
  return out;
}

const pct = (a: number | null, b: number | null) => (a === null || b === null || Math.abs(a) < 1e-9 ? null : (b - a) / Math.abs(a));
const delta = (label: string, before: number | null, after: number | null, unit: string, lowerIsBetter: boolean, threshold = 0.05, perSeed?: { before: (number | null)[]; after: (number | null)[] }): Delta => {
  const change = pct(before, after);
  let good = change === null || Math.abs(change) < threshold ? null : lowerIsBetter ? change < 0 : change > 0;
  let agreement: Delta['agreement'];
  if (perSeed && change !== null) {
    const signs = perSeed.before.map((b, i) => { const a = perSeed.after[i]; return b === null || a === null ? 0 : Math.sign(a - b); });
    const same = signs.filter(x => x === Math.sign(change)).length;
    agreement = { same, of: signs.length };
    // A change that not every seed shows is not reported as good or bad
    if (good !== null && same < signs.length) good = null;
  }
  return { label, before, after, unit, lowerIsBetter, change, good, agreement };
};
const verdictOf = (ds: Delta[]): Verdict => {
  const goods = ds.filter(d => d.good === true).length, bads = ds.filter(d => d.good === false).length;
  return goods && !bads ? 'better' : bads && !goods ? 'worse' : goods && bads ? 'mixed' : 'no_change';
};

const sectionSpeed = (r: RoadAnalysisResult) => {
  const ds = r.directions.filter(d => d.meanSpeedKmh !== null);
  const w = ds.reduce((n, d) => n + Math.max(1, d.vph), 0);
  return ds.length ? ds.reduce((n, d) => n + d.meanSpeedKmh! * Math.max(1, d.vph), 0) / w : null;
};
const mean = (xs: (number | null)[]) => { const v = xs.filter((x): x is number => x !== null); return v.length ? v.reduce((a, b) => a + b, 0) / v.length : null; };

export function compareAnalyses(before: AnalysisOutput, after: AnalysisOutput, roads: { before: ReadonlyMap<string, DrivableObject>; after: ReadonlyMap<string, DrivableObject> }, demand: { before: number; after: number }, inputs?: { before: RunInputs; after: RunInputs; newDemand?: boolean }): ComparisonResult {
  const a = before.result, b = after.result;
  const inputCheck = inputs ? checkRunInputs(inputs.before, inputs.after, inputs.newDemand) : undefined;
  const kind = Math.abs(demand.before - demand.after) > 0.5 ? 'development' : 'infrastructure';
  const sameSeeds = a.perSeed.length === b.perSeed.length && a.perSeed.every((s, i) => s.seed === b.perSeed[i].seed);
  const seeds = (pick: (s: RoadAnalysisResult['perSeed'][number]) => number | null) => sameSeeds ? { before: a.perSeed.map(pick), after: b.perSeed.map(pick) } : undefined;
  const section: Delta[] = [
    delta('Traffic through the road', a.totalVph, b.totalVph, 'veh/h', false, 0.05, seeds(s => s.sectionVph)),
    delta('Traffic routed along it', a.directions.reduce((n, d) => n + d.demandVph, 0), b.directions.reduce((n, d) => n + d.demandVph, 0), 'veh/h', false, 0.05),
    delta('Time to drive it', mean(a.perSeed.map(s => s.sectionTimeS)), mean(b.perSeed.map(s => s.sectionTimeS)), 's', true, 0.05, seeds(s => s.sectionTimeS)),
    // Per run, the inverse of the time to drive it: the same direction as the speed. Without it a speed gain
    // that only some runs showed was reported as good, and the verdict said "in every run"
    delta('Speed on it', sectionSpeed(a), sectionSpeed(b), 'km/h', false, 0.05, seeds(s => (s.sectionTimeS ? 1 / s.sectionTimeS : null))),
    delta('Worst junction delay at its ends', mean(a.perSeed.map(s => s.endDelayS)), mean(b.perSeed.map(s => s.endDelayS)), 's', true, 0.1, seeds(s => s.endDelayS)),
  ];
  const endDelay = section[4];
  if ((endDelay.before === null) !== (endDelay.after === null)) endDelay.note = `Not measured in the ${endDelay.before === null ? 'existing city' : 'proposal'}: the simulation recorded no junction at the road's ends in any run (an edit can change which junctions count as its ends).`;
  // Volume by itself is neither good nor bad: more vehicles can mean it now relieves a parallel road
  section[0].good = null; section[1].good = null;
  const network: Delta[] = [
    delta('Share of routed traffic that got through the neighbourhood', 100 * a.load.servedShare, 100 * b.load.servedShare, '%', false, 0.03, seeds(s => s.servedShare)),
    delta('Trips completed in the neighbourhood', a.network.completedTrips, b.network.completedTrips, 'trips', false, 0.03, seeds(s => s.completedTrips)),
    delta('Mean trip time in the neighbourhood', a.network.meanTravelTimeS, b.network.meanTravelTimeS, 's', true, 0.03, seeds(s => s.meanTravelTimeS)),
    delta('Mean delay per trip', a.network.meanDelayS, b.network.meanDelayS, 's', true, 0.05, seeds(s => s.meanDelayS)),
    delta('Vehicles removed after gridlock', a.network.gridlockRemovals, b.network.gridlockRemovals, 'veh', true, 0.2, seeds(s => s.gridlockRemovals)),
  ];
  const area: Delta[] = [
    delta('Total time spent driving in the area', a.assignment.totalVehHours, b.assignment.totalVehHours, 'veh·h', true, 0.01),
    delta('Road stretches over capacity', a.assignment.overCapacityLinks, b.assignment.overCapacityLinks, 'stretches', true, 0.05),
    delta('Trips that cannot reach their destination', a.assignment.unroutedVph, b.assignment.unroutedVph, 'veh/h', true, 0.05),
  ];

  // Per road (assignment): volume and load before and after
  const byRoad = (r: RoadAnalysisResult, rs: ReadonlyMap<string, DrivableObject>) => {
    const out = new Map<string, { vph: number; vc: number; keys: Set<string> }>();
    r.areaLinkVph.forEach((vph, linkId) => {
      const roadId = linkId.replace(/_seg_\d+_(fwd|bwd)$/, '');
      const name = rs.get(roadId)?.name;
      if (!name || isGenericRoadName(name)) return;
      const seg = linkId.replace(/_(fwd|bwd)$/, '');
      const e = out.get(name) ?? out.set(name, { vph: 0, vc: 0, keys: new Set() }).get(name)!;
      e.vph = Math.max(e.vph, vph);
      e.vc = Math.max(e.vc, r.areaVc.get(seg) ?? 0);
      e.keys.add(seg);
    });
    return out;
  };
  const ra = byRoad(a, roads.before), rb = byRoad(b, roads.after);
  const changes: RoadChange[] = [...new Set([...ra.keys(), ...rb.keys()])].map(roadName => {
    const x = ra.get(roadName), y = rb.get(roadName);
    return { roadName, before: Math.round(x?.vph ?? 0), after: Math.round(y?.vph ?? 0), change: Math.round((y?.vph ?? 0) - (x?.vph ?? 0)), segmentKeys: [...new Set([...(x?.keys ?? []), ...(y?.keys ?? [])])], vcBefore: x?.vc ?? 0, vcAfter: y?.vc ?? 0 };
  });
  const rerouting = changes.filter(r => Math.abs(r.change) >= 60 && Math.abs(r.change) >= 0.1 * Math.max(r.before, r.after)).sort((x, y) => Math.abs(y.change) - Math.abs(x.change)).slice(0, 8);
  const winners = changes.filter(r => r.vcBefore > 0.6 && r.vcAfter < r.vcBefore - 0.1).sort((x, y) => (x.vcAfter - x.vcBefore) - (y.vcAfter - y.vcBefore)).slice(0, 5);
  const losers = changes.filter(r => r.vcAfter > 0.6 && r.vcAfter > r.vcBefore + 0.1).sort((x, y) => (y.vcAfter - y.vcBefore) - (x.vcAfter - x.vcBefore)).slice(0, 5);
  const segmentChange = new Map<string, number>();
  new Set([...a.areaVc.keys(), ...b.areaVc.keys()]).forEach(k => segmentChange.set(k, (b.areaVc.get(k) ?? 0) - (a.areaVc.get(k) ?? 0)));
  const M = 111320;
  const near = (p: readonly number[], q: readonly number[]) => Math.hypot((p[0] - q[0]) * M * Math.cos(p[1] * Math.PI / 180), (p[1] - q[1]) * M) < 250;
  const newBottlenecks = b.areaBottlenecks.filter(x => x.vc > 1 && !a.areaBottlenecks.some(y => near(x.coordinates, y.coordinates)));

  const sv = verdictOf(section), nv = verdictOf(network), av = verdictOf(area);
  const harm = newBottlenecks.length > 0 || av === 'worse' || av === 'mixed';
  // Any measure that got worse in every run, at any level, rules out "better": a road that speeds up
  // while the neighbourhood's trips take 14% longer is a trade-off, not an improvement
  const worsened = [...section, ...network, ...area].filter(d => d.good === false);
  let overall: Verdict;
  if ((sv === 'better' || nv === 'better') && !worsened.length && !harm) overall = 'better';
  else if ((sv === 'worse' || nv === 'worse' || av === 'worse') && sv !== 'better' && nv !== 'better' && av !== 'better') overall = 'worse';
  else if (sv === 'no_change' && nv === 'no_change' && av === 'no_change' && !newBottlenecks.length) overall = 'no_change';
  else overall = 'mixed';
  const word: Record<Verdict, string> = { better: 'improves', worse: 'worsens', mixed: 'has mixed effects on', no_change: 'makes no clear difference to' };
  let summary = `The change ${word[sv]} the selected road, ${word[nv]} its neighbourhood and ${word[av]} the wider area.`;
  if ((sv === 'better' || nv === 'better') && harm) summary = `The selected road${nv === 'better' ? ' and its neighbourhood' : ''} improve, but ${newBottlenecks.length ? `${newBottlenecks.length} new bottleneck${newBottlenecks.length > 1 ? 's appear' : ' appears'} (${newBottlenecks.map(x => x.roadName).join(', ')})` : 'the wider area gets worse'}: traffic or queues move elsewhere. Not a clear improvement.`;
  else if (overall === 'mixed' && (sv === 'better' || nv === 'better' || av === 'better') && worsened.length) {
    const gained = [...section, ...network, ...area].filter(d => d.good === true).map(d => d.label.toLowerCase());
    const lost = worsened.map(d => `${d.label.toLowerCase()} ${d.change !== null ? `${d.change > 0 ? '+' : ''}${Math.round(d.change * 100)}%` : ''}`.trim());
    summary = `A trade-off, not a clear improvement: ${gained.join(', ')} improve${gained.length === 1 ? 's' : ''}, but ${lost.join(', ')} get${lost.length === 1 ? 's' : ''} worse in every run.`;
  }
  if (overall === 'better') summary = `The change improves ${sv === 'better' ? 'the selected road' : 'the neighbourhood'} in every run, without a new bottleneck or more total travel time in the area.`;

  const simDeltas = [...section, ...network].filter(d => d.agreement && d.change !== null && Math.abs(d.change) >= 0.05);
  const allAgree = simDeltas.every(d => d.agreement!.same === d.agreement!.of);
  const overloaded = a.load.overloaded || b.load.overloaded;
  const nSeeds = a.perSeed.length;
  const confidence: ComparisonResult['confidence'] = !sameSeeds ? { level: 'low', text: 'The two analyses used different seeds, so they are not directly comparable.' }
    : overloaded ? { level: 'low', text: `More traffic is routed through the neighbourhood than its simulated junctions pass in at least one case; part of any difference is how the queues happened to form. ${allAgree ? 'The direction of the main changes was the same in all runs.' : 'The runs did not all agree.'}` }
    : allAgree && nSeeds >= 3 ? { level: 'medium', text: `All ${nSeeds} runs agree on the direction of every change above the noise threshold. Demand is estimated, not counted, so treat the sizes of the changes as indicative; the comparison holds demand fixed, so their direction is more reliable than the absolute figures.` }
    : { level: 'low', text: `The ${nSeeds} runs do not all agree on the direction of the changes; run more seeds or treat the result as no clear change.` };
  const caveats: string[] = [];
  // Inputs that differ make the figures incomparable: say so first and never claim more than low confidence
  if (inputCheck && !inputCheck.matched) {
    confidence.level = 'low';
    confidence.text = `The two runs did not use the same ${inputCheck.mismatches.join(', ')}, so the differences are not the network's doing alone.`;
    caveats.push(`Not like with like: the existing city and the proposal differ in ${inputCheck.mismatches.join(', ')}.`);
  }
  if (kind === 'development') caveats.push(`Land use changed too: demand went from ${Math.round(demand.before).toLocaleString()} to ${Math.round(demand.after).toLocaleString()} veh/h, so differences mix the new demand with any road changes.`);
  if (!inputCheck || inputCheck.matched) caveats.push(`Both analyses use the same demand, hour and ${nSeeds} seed${nSeeds === 1 ? '' : 's'}; drivers are re-routed on the proposal by the area assignment. Differences under 5% (3% for neighbourhood trip time, trips completed and the share that got through; 10% for junction delay; 1% for area travel time) are shown as no change, and a simulated change counts only if every seed shows it.`);
  if (after.unroutedVph > before.unroutedVph + 1) caveats.push(`${Math.round(after.unroutedVph - before.unroutedVph).toLocaleString()} veh/h more can no longer reach their destination: the change cuts a route.`);
  return { kind, demandBefore: demand.before, demandAfter: demand.after, section, network, area, rerouting, winners, losers, newBottlenecks, segmentChange,
    laneInsights: laneInsights(a.directions, b.directions, roads, newBottlenecks),
    verdict: { section: sv, network: nv, area: av, overall, summary }, confidence, caveats, ...(inputCheck ? { inputs: inputCheck } : {}) };
}

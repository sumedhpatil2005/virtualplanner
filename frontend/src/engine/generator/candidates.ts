import type { RoadAnalysisResult, DirectionFlow } from '../simulation/RoadAnalysis';
import type { StudyArea, DrivableObject } from '../simulation/StudyAreaExplorer';
import type { RoadClassification, RoadObject } from '../objects/types';
import { groupJunctions, type LogicalJunction } from '../simulation/junctionGroups';
import { defaultEdit, type JunctionEditSpec, type SignalPlan, DEFAULT_AMBER_S, DEFAULT_ALL_RED_S, MIN_GREEN_EDIT_S } from '../simulation/junctionControl';
import { websterTiming, indoHcmSaturationFlow } from '../simulation/signalTiming';
import { lastRunControl } from '../editing/junctionDraft';
import type { ProposalType } from '../feasibility/types';
import { FLEET_MEAN_PCU, phaseSaturation, type BottleneckCause, type CauseFinding, type Diagnosis, type DiagnosedLocation } from './diagnosis';

/**
 * Candidate interventions from a diagnosis (mission §8 categories A-F, §11
 * steps 4-7; docs/SCENARIO_GENERATOR.md §3). Each candidate is a list of
 * EDITS that `apply.ts` writes into its own isolated proposal scenario through
 * the scenario copy-on-write system; nothing here touches any scenario.
 *
 * Order and restraint: traffic-management measures come first. Physical works
 * (widening, new connector, flyover) are proposed only for a cause that
 * capacity can address (excessive demand, merge, poor connectivity) found with
 * at least medium confidence, and each carries a feasibility screening.
 * Costs are never estimated: candidates carry an ORDINAL works class with its
 * basis, and land take is "none" only for measures without physical works.
 */

export type InterventionCategory = 'A' | 'B' | 'C' | 'D' | 'E' | 'F';
export const CATEGORY_LABEL: Record<InterventionCategory, string> = {
  A: 'Traffic management', B: 'Public transport', C: 'Road-space management', D: 'Grade-separated infrastructure', E: 'Underground infrastructure', F: 'New surface infrastructure',
};

export type CandidateKind = 'signal_retiming' | 'signal_coordination' | 'turn_ban' | 'one_way' | 'junction_control' | 'bus_priority_lane' | 'new_connector' | 'flyover' | 'widening';

export type CandidateEdit =
  | { op: 'junction_edit'; spec: JunctionEditSpec; centre: [number, number] }
  | { op: 'road_field'; roadId: string; field: 'isOneWay' | 'lanesForward' | 'lanesBackward'; value: number | boolean; scope: 'segment' | 'carriageway' }
  | { op: 'draw'; mode: 'draw_road' | 'draw_flyover'; points: [number, number, number][]; roadClass: RoadClassification; name: string; laneCount: number; isOneWay: boolean };

/** Ordinal classes (1 lowest … 5 highest). Not money and not a duration: the basis says what they rest on. */
export interface OrdinalClass { level: 1 | 2 | 3 | 4 | 5 | null; label: string; basis: string }

export interface Candidate {
  id: string;
  kind: CandidateKind;
  category: InterventionCategory;
  title: string;
  /** The diagnosed location and the causes it answers. */
  locationId: string;
  locationLabel: string;
  causes: BottleneckCause[];
  rationale: string;
  evidence: string[];
  assumptions: string[];
  limitations: string[];
  edits: CandidateEdit[];
  physical: boolean;
  /** Feasibility proposal type for physical candidates (screened by the feasibility engine after creation). */
  feasibilityType?: ProposalType;
  costClass: OrdinalClass;
  disruptionClass: OrdinalClass;
  landTake: { value: 'none' | 'unknown' | 'possible'; basis: string };
}

const COST_BASIS = 'Ordinal class from the type of works only (docs/SCENARIO_GENERATOR.md §3.3). Not a cost estimate: costing needs quantities, schedule-of-rates and land/utility information.';
const DISRUPTION_BASIS = 'Ordinal class from the type of works only (construction footprint and duration typical of the works type). Not a construction programme.';
export const COST_BY_KIND: Record<CandidateKind, OrdinalClass> = {
  signal_retiming: { level: 1, label: 'very low (timing change)', basis: COST_BASIS },
  signal_coordination: { level: 1, label: 'very low (timing change; communications not assessed)', basis: COST_BASIS },
  turn_ban: { level: 1, label: 'very low (signs, markings, enforcement)', basis: COST_BASIS },
  one_way: { level: 2, label: 'low (signs, markings, enforcement)', basis: COST_BASIS },
  junction_control: { level: 2, label: 'low (signal equipment)', basis: COST_BASIS },
  bus_priority_lane: { level: 2, label: 'low (markings, enforcement)', basis: COST_BASIS },
  widening: { level: 3, label: 'medium; higher if land is needed', basis: COST_BASIS },
  new_connector: { level: 4, label: 'high (new road)', basis: COST_BASIS },
  flyover: { level: 5, label: 'very high (structure)', basis: COST_BASIS },
};
export const DISRUPTION_BY_KIND: Record<CandidateKind, OrdinalClass> = {
  signal_retiming: { level: 1, label: 'very low', basis: DISRUPTION_BASIS },
  signal_coordination: { level: 1, label: 'very low', basis: DISRUPTION_BASIS },
  turn_ban: { level: 1, label: 'very low', basis: DISRUPTION_BASIS },
  one_way: { level: 2, label: 'low (re-routing during adjustment)', basis: DISRUPTION_BASIS },
  junction_control: { level: 2, label: 'low (installation works at the junction)', basis: DISRUPTION_BASIS },
  bus_priority_lane: { level: 2, label: 'low (markings)', basis: DISRUPTION_BASIS },
  widening: { level: 4, label: 'high (works along the carriageway)', basis: DISRUPTION_BASIS },
  new_connector: { level: 4, label: 'high (new construction)', basis: DISRUPTION_BASIS },
  flyover: { level: 5, label: 'very high (structure over a live junction)', basis: DISRUPTION_BASIS },
};
const NO_LAND = { value: 'none' as const, basis: 'No physical works: changes control, markings or use of existing road space only.' };
const LAND_UNKNOWN = { value: 'unknown' as const, basis: 'Physical works: land need follows from the feasibility screening (right-of-way data are not available; see its findings).' };

export interface GeneratorContext {
  result: RoadAnalysisResult;
  area: StudyArea;
  roads: ReadonlyMap<string, DrivableObject>;
  junctions?: LogicalJunction[];
}

const M = 111320;
const distM = (a: readonly number[], b: readonly number[]) => Math.hypot((a[0] - b[0]) * M * Math.cos(a[1] * Math.PI / 180), (a[1] - b[1]) * M);
const bearingOf = (a: readonly number[], b: readonly number[]) => (Math.atan2((b[0] - a[0]) * Math.cos(a[1] * Math.PI / 180), b[1] - a[1]) * 180 / Math.PI + 360) % 360;
const angleDiff = (a: number, b: number) => { const d = Math.abs(a - b) % 360; return d > 180 ? 360 - d : d; };

/** Webster timing of a plan's phases on given phase demands (PCU/h): the plan's phase structure kept, greens re-split. */
export function websterPlan(plan: SignalPlan, phases: { flowPcu: number; satFlowPcu: number }[], cycle?: number): { plan: SignalPlan; cycleS: number; Y: number; oversaturated: boolean } {
  const amberS = plan.amberS || DEFAULT_AMBER_S, allRedS = plan.allRedS ?? DEFAULT_ALL_RED_S;
  const w = websterTiming(phases.map(p => ({ flow: p.flowPcu, saturationFlow: p.satFlowPcu })), { amberS, allRedS, ...(cycle ? { minCycleS: cycle, maxCycleS: cycle } : {}) });
  const greens = w.greensS.map(g => Math.max(MIN_GREEN_EDIT_S, Math.round(g)));
  return { plan: { amberS, allRedS, phases: plan.phases.map((p, i) => ({ greenS: greens[i], arms: [...p.arms] })) }, cycleS: greens.reduce((n, g) => n + g + amberS + allRedS, 0), Y: w.flowRatioSum, oversaturated: w.oversaturated };
}

/** Assigned demand (PCU/h) and saturation flow of each approach of a junction. */
function armDemand(j: LogicalJunction, r: RoadAnalysisResult) {
  return new Map(j.approaches.map(a => [a.id, { flowPcu: a.edgeIds.reduce((n, id) => n + (r.areaLinkVph.get(id) ?? 0), 0) * FLEET_MEAN_PCU, satFlowPcu: indoHcmSaturationFlow(Math.max(1, a.lanes) * 3.5) }]));
}

/** The approach of a junction that a location's direction arrives on (its roads, else the nearest bearing). */
function approachFor(j: LogicalJunction, loc: DiagnosedLocation, dir: DirectionFlow | undefined) {
  const ids = new Set(loc.evidence.roadIds ?? []);
  const byRoad = j.approaches.find(a => a.roadIds.some(id => ids.has(id)));
  if (byRoad) return byRoad;
  if (!dir) return null;
  const from = (dir.bearingDeg + 180) % 360;
  return [...j.approaches].sort((a, b) => angleDiff(a.bearingDeg, from) - angleDiff(b.bearingDeg, from))[0] ?? null;
}

const strongest = (causes: CauseFinding[], c: BottleneckCause) => causes.find(f => f.cause === c);
const atLeastMedium = (f?: CauseFinding) => !!f && (f.confidence === 'high' || f.confidence === 'medium');
const metricText = (f: CauseFinding) => `${f.metric.name} = ${f.metric.value}${f.metric.unit ? ` ${f.metric.unit}` : ''} (threshold ${f.metric.threshold}; ${f.metric.thresholdBasis}); confidence ${f.confidence}.`;

/** Builds candidates for the diagnosis' locations (most severe first), at most `max`. */
export function generateCandidates(diag: Diagnosis, ctx: GeneratorContext, max = 6): Candidate[] {
  const r = ctx.result, net = ctx.area.network;
  const js = ctx.junctions ?? groupJunctions(net, ctx.roads);
  const out: Candidate[] = [];
  const seen = new Set<string>();
  const push = (c: Candidate) => { const k = `${c.kind}|${c.edits.map(e => e.op === 'junction_edit' ? e.spec.junctionId : e.op === 'road_field' ? e.roadId : e.points.map(p => p.map(v => v.toFixed(5)).join(',')).join(';')).join('|')}`; if (!seen.has(k)) { seen.add(k); out.push(c); } };
  const jById = new Map(js.map(j => [j.id, j]));

  for (const loc of diag.locations) {
    const ev = loc.evidence, causes = loc.causes;
    if (!causes.length) continue;
    const dir = ev.direction ? r.directions.find(d => d.label === ev.direction) : undefined;
    const j = ev.junctionId ? jById.get(ev.junctionId) ?? null : null;
    const evidence = causes.map(metricText);
    const base = { locationId: ev.id, locationLabel: ev.label, evidence };

    // A. Signal retiming (Webster on the run's assigned demand) where timing or demand at a signal is the cause
    const timing = strongest(causes, 'signal_timing'), demand = strongest(causes, 'excessive_demand'), coord = strongest(causes, 'uncoordinated_signals');
    if (j && ev.signal && (timing || demand || coord)) {
      const run = lastRunControl(j, r, net);
      if (run?.plan) {
        const sat = phaseSaturation(ev.signal);
        const w = websterPlan(run.plan, ev.signal.phases);
        const spec: JunctionEditSpec = { ...defaultEdit(j, { plan: w.plan }), asRun: undefined };
        delete spec.asRun;
        push({ ...base, id: `retime:${j.id}`, kind: 'signal_retiming', category: 'A', title: `Retime the signal at ${j.label} (Webster)`,
          causes: [timing, demand, coord].filter((f): f is CauseFinding => !!f).map(f => f.cause),
          rationale: `Re-split the green time in proportion to the critical flow ratios of the run's assigned demand (Webster 1958): cycle ${Math.round(ev.signal.cycleS)} s → ${w.cycleS} s, worst phase x = ${Math.max(...sat.x).toFixed(2)}.${w.oversaturated ? ' Y is above 0.9, so Webster caps the cycle: timing cannot serve this demand; this candidate is the management baseline for the physical options.' : ''}`,
          assumptions: ['Phase structure of the plan the run used is kept; only greens and cycle change.', `Demand per approach: assigned volumes of the run × mean fleet PCU ${FLEET_MEAN_PCU.toFixed(2)} (model output, not counts).`, 'Saturation flow: Indo-HCM width-based on 3.5 m lanes (assumed width).', 'Fixed time; no adaptive control or pedestrian phases modelled.'],
          limitations: ['Pedestrian minimum greens are not checked.', 'Demand is the model\'s estimate (the model does not meet TAG M3.1 validation criteria: docs/OVERHAUL.md §24).'],
          edits: [{ op: 'junction_edit', spec, centre: j.centre }], physical: false,
          costClass: COST_BY_KIND.signal_retiming, disruptionClass: DISRUPTION_BY_KIND.signal_retiming, landTake: NO_LAND });
        // Coordination: put this junction on the upstream signal's cycle so a fixed offset can exist
        if (coord?.cause && ev.coordination && Math.abs(ev.coordination.neighbourCycleS - ev.coordination.ownCycleS) > 5) {
          const wc = websterPlan(run.plan, ev.signal.phases, Math.round(ev.coordination.neighbourCycleS));
          const specC: JunctionEditSpec = { ...defaultEdit(j, { plan: wc.plan }) }; delete specC.asRun;
          push({ ...base, id: `coord:${j.id}`, kind: 'signal_coordination', category: 'A', title: `Common cycle with ${ev.coordination.neighbourLabel}`,
            causes: ['uncoordinated_signals'], rationale: `Run ${j.label} on the upstream signal's cycle (${Math.round(ev.coordination.neighbourCycleS)} s) with Webster splits, the precondition for a fixed offset between them.`,
            assumptions: ['The upstream signal keeps its plan.', 'Offsets are not optimised (the simulator has no offset control): only the common cycle is tested.'],
            limitations: ['Without an offset the benefit of a common cycle is partial; arrival on red is inferred from delay, not counted.'],
            edits: [{ op: 'junction_edit', spec: specC, centre: j.centre }], physical: false,
            costClass: COST_BY_KIND.signal_coordination, disruptionClass: DISRUPTION_BY_KIND.signal_coordination, landTake: NO_LAND });
        }
      }
    }

    // A. Spillback: act where the queue starts (signal there → retime; unsignalised → signal control)
    const spill = strongest(causes, 'downstream_spillback');
    if (spill && ev.spillback) {
      const root = js.slice().sort((a, b) => distM(a.centre, ev.spillback!.rootCoordinates) - distM(b.centre, ev.spillback!.rootCoordinates))[0];
      if (root && distM(root.centre, ev.spillback.rootCoordinates) < 60) {
        const run = lastRunControl(root, r, net);
        const dem = armDemand(root, r);
        if (run?.plan) {
          const phases = run.plan.phases.map(p => { let best = { flowPcu: 0, satFlowPcu: 1 }; for (const id of p.arms) { const f = dem.get(id); if (f && f.flowPcu / f.satFlowPcu > best.flowPcu / best.satFlowPcu) best = f; } return best; });
          const w = websterPlan(run.plan, phases);
          const spec = { ...defaultEdit(root, { plan: w.plan }) }; delete spec.asRun;
          push({ ...base, id: `retime:${root.id}`, kind: 'signal_retiming', category: 'A', title: `Retime the signal where the queue starts: ${root.label}`, causes: ['downstream_spillback'],
            rationale: `The queue on ${ev.label} was traced to ${root.label} (${ev.spillback.agreement} of ${ev.spillback.seeds} runs). Re-split its greens by Webster on the assigned demand (cycle ${w.cycleS} s, Y = ${w.Y.toFixed(2)}).`,
            assumptions: ['Phase structure kept; greens by Webster on assigned demand × mean fleet PCU.', 'Saturation flow Indo-HCM on 3.5 m lanes (assumed).'],
            limitations: ['Moving delay from one approach to another can move the queue; compare the whole neighbourhood.'],
            edits: [{ op: 'junction_edit', spec, centre: root.centre }], physical: false,
            costClass: COST_BY_KIND.signal_retiming, disruptionClass: DISRUPTION_BY_KIND.signal_retiming, landTake: NO_LAND });
        } else if (root.approaches.length >= 3) {
          push(signalisationCandidate(root, r, base, ['downstream_spillback'], `The queue on ${ev.label} was traced to the unsignalised ${root.label}: control it with a signal timed by Webster on its assigned demand.`));
        }
      }
    }

    // A. Turning conflicts: ban the opposed (right, in left-hand traffic) turn of the worst approach; or signalise an unsignalised junction
    const conflict = strongest(causes, 'turning_conflict');
    if (conflict && j) {
      const appr = approachFor(j, loc, dir);
      const right = appr ? j.movements.filter(m => m.approachId === appr.id && m.turn === 'right') : [];
      if (appr && right.length) {
        const run = lastRunControl(j, r, net);
        const spec = defaultEdit(j, run);
        spec.bannedMovements = right.map(m => `${m.approachId}>${m.exitId}`);
        push({ ...base, id: `ban:${j.id}:${appr.id}`, kind: 'turn_ban', category: 'A', title: `Ban the right turn from ${appr.label} at ${j.label}`, causes: ['turning_conflict'],
          rationale: `Opposed turns cause ${Math.round(100 * conflict.metric.value)}% of the delay on this approach. In left-hand traffic the right turn crosses the opposing flow; banning it removes that conflict, and the area assignment re-routes the banned traffic.`,
          assumptions: ['The control and timing the run used are kept (only the ban applies).', 'Banned traffic re-routes by user equilibrium on the frozen demand.'],
          limitations: ['The right-turning volume is not measured; the detour adds distance to those trips (shown in area travel time).', 'Access to properties beyond the banned turn is not assessed.'],
          edits: [{ op: 'junction_edit', spec, centre: j.centre }], physical: false,
          costClass: COST_BY_KIND.turn_ban, disruptionClass: DISRUPTION_BY_KIND.turn_ban, landTake: NO_LAND });
      }
      if (!j.signalised && !ev.signal && j.approaches.length >= 3) push(signalisationCandidate(j, r, base, ['turning_conflict'], `Most delay is giving way at the unsignalised ${j.label}: a signal separates the conflicting movements in time.`));
    }

    // A. One-way: a two-way road with conflicts or demand at capacity and a spare parallel main road nearby
    if ((conflict || demand) && dir && ev.scope === 'corridor') {
      const spare = r.nearby.filter(n => (n.vc ?? 1) < 0.6 && n.roadClass !== 'local' && n.vph > 0).sort((a, b) => (a.vc ?? 1) - (b.vc ?? 1))[0];
      const twoWay = (dir.roadIds ?? []).map(id => ctx.roads.get(id)).filter((o): o is RoadObject => !!o && o.type === 'road' && !o.isOneWay);
      if (spare && twoWay.length && r.directions.length >= 2) {
        const heavy = [...r.directions].sort((a, b) => b.demandVph - a.demandVph)[0];
        const edits: CandidateEdit[] = twoWay.map(o => ({ op: 'road_field' as const, roadId: o.id, field: 'isOneWay' as const, value: true, scope: 'segment' as const }));
        // A road drawn against the heavier direction must be reversed for one-way to keep the heavier flow: not attempted
        const along = twoWay.every(o => angleDiff(bearingOf(o.coordinates[0], o.coordinates.at(-1)!), heavy.bearingDeg) < 90);
        if (along) push({ ...base, id: `oneway:${dir.label}`, kind: 'one_way', category: 'A', title: `Make ${r.section.name} one-way ${heavy.label}`, causes: [conflict, demand].filter((f): f is CauseFinding => !!f).map(f => f.cause),
          rationale: `One-way operation in the heavier direction (${Math.round(heavy.demandVph)} veh/h assigned) gives it all lanes and removes opposed turns; ${spare.roadName} (${Math.round(100 * (spare.vc ?? 0))}% of capacity, ${spare.distanceM} m away) is the spare parallel road for the other direction.`,
          assumptions: [`Lanes of the opposite direction are given to ${heavy.label} (the editor's one-way rule).`, 'The other direction re-routes by user equilibrium on the frozen demand.'],
          limitations: [`${spare.roadName} is not made one-way the other way (a one-way pair would need it): only this road changes.`, 'Bus routes, access and pedestrian crossing needs are not assessed.'],
          edits, physical: false, costClass: COST_BY_KIND.one_way, disruptionClass: DISRUPTION_BY_KIND.one_way, landTake: NO_LAND });
      }
    }

    // B. Bus priority lane (lane reallocation) on a multi-lane direction with demand near capacity
    if (demand && dir && dir.lanes >= 2) {
      const b0 = dir.binding ?? dir.segments?.[0];
      const roadsAlong = (dir.segments ?? (b0 ? [b0] : [])).map(s => ctx.roads.get(s.roadId)).filter((o): o is RoadObject => !!o && o.type === 'road');
      const edits = roadsAlong.map(o => laneEdit(o, dir, -1)).filter((e): e is CandidateEdit => !!e);
      if (edits.length) push({ ...base, id: `bus:${dir.label}`, kind: 'bus_priority_lane', category: 'B', title: `Bus priority lane ${dir.label} on ${r.section.name}`, causes: ['excessive_demand'],
        rationale: 'Reallocate one general lane to buses. With demand above capacity, moving people rather than vehicles is the alternative to adding road space.',
        assumptions: ['Modelled as one fewer general-traffic lane on the direction\'s ways (the simulator has no bus-only lanes).'],
        limitations: ['Bus travel-time and passenger benefits are NOT modelled (no bus routes, frequencies or ridership in the model): the comparison shows only the effect on general traffic.', 'Mode shift is not modelled; demand is frozen.'],
        edits, physical: false, costClass: COST_BY_KIND.bus_priority_lane, disruptionClass: DISRUPTION_BY_KIND.bus_priority_lane, landTake: NO_LAND });
    }

    // F. Widening (+1 lane) only for demand above capacity (or a merge) found with at least medium confidence
    const merge = strongest(causes, 'merge');
    if ((atLeastMedium(demand) || atLeastMedium(merge)) && dir) {
      const segs = dir.bindingSegments?.length ? dir.bindingSegments : dir.binding ? [dir.binding] : [];
      const edits = segs.map(s => ctx.roads.get(s.roadId)).filter((o): o is RoadObject => !!o && o.type === 'road').map(o => laneEdit(o, dir, +1)).filter((e): e is CandidateEdit => !!e);
      if (edits.length) push({ ...base, id: `widen:${dir.label}`, kind: 'widening', category: 'F', title: `Add a lane ${dir.label} where ${r.section.name} is narrowest`, causes: [demand, merge].filter((f): f is CauseFinding => !!f).map(f => f.cause),
        rationale: `Demand exceeds capacity with ${atLeastMedium(demand) ? demand!.confidence : merge!.confidence} confidence and management cannot add capacity there. +1 lane on the stretch that sets the direction's capacity (${segs.map(s => s.name).join(', ')}).`,
        assumptions: ['Lane width 3.5 m (editor default).', 'Induced demand is not modelled (frozen demand).'],
        limitations: ['Land and right-of-way availability unknown: see the feasibility screening.', 'Extra capacity can move the queue to the end junctions.'],
        edits, physical: true, feasibilityType: 'additional_lane',
        costClass: COST_BY_KIND.widening, disruptionClass: DISRUPTION_BY_KIND.widening, landTake: LAND_UNKNOWN });
    }

    // D. Flyover: a signalised junction whose demand no timing can serve (Y >= 0.9, at least medium), carrying the selected road's through traffic
    if (j && ev.signal && atLeastMedium(demand) && dir && ev.scope === 'corridor') {
      const pts = flyoverAlignment(j, dir, net);
      if (pts) push({ ...base, id: `flyover:${j.id}:${dir.label}`, kind: 'flyover', category: 'D', title: `Conceptual flyover over ${j.label} for ${r.section.name} ${dir.label}`, causes: ['excessive_demand'],
        rationale: `${demand!.text} A grade-separated through movement removes it from the signal. Conceptual geometry only: ends on the approach and exit roads, ramps at the editor's grade.`,
        assumptions: ['Deck height 6 m, 2 lanes one-way, ramps on the existing carriageway (editor defaults).', 'Through-movement share is not counted: the assignment decides who uses it.'],
        limitations: ['Conceptual geometry, not a design: structure, ramp length, land, utilities and construction staging need professional assessment.', 'The surface capacity taken by ramps is the editor\'s estimate.'],
        edits: [{ op: 'draw', mode: 'draw_flyover', points: pts, roadClass: 'arterial', name: `Flyover over ${j.label} (generated)`, laneCount: 2, isOneWay: true }],
        physical: true, feasibilityType: 'flyover', costClass: COST_BY_KIND.flyover, disruptionClass: DISRUPTION_BY_KIND.flyover, landTake: LAND_UNKNOWN });
    }

    // F. New connector: poor connectivity at medium+ confidence and a main road ending without a connection nearby
    const conn = strongest(causes, 'poor_connectivity');
    if (conn) {
      const link = connectorAlignment(r, ctx, ev.coordinates);
      if (link && (atLeastMedium(conn) || link.lengthM < 300)) push({ ...base, id: `connector:${link.fromRoad}`, kind: 'new_connector', category: 'F', title: `New connector from ${link.fromName} to ${link.toName}`, causes: ['poor_connectivity'],
        rationale: `${conn.text} ${link.fromName} ends without a connection ${Math.round(distM(link.points[0], ev.coordinates))} m away; a ${Math.round(link.lengthM)} m link to ${link.toName} gives traffic another route.`,
        assumptions: ['Straight two-way local link, 2 lanes, at ground level.', 'Joins only at its two ends (other crossings are flagged for the user, never joined).'],
        limitations: ['Alignment is conceptual: land, buildings in the way and levels are unknown until the feasibility screening and a survey.', 'May draw through traffic into a local street.'],
        edits: [{ op: 'draw', mode: 'draw_road', points: link.points, roadClass: 'local', name: `Connector ${link.fromName} – ${link.toName} (generated)`, laneCount: 2, isOneWay: false }],
        physical: true, feasibilityType: 'new_road', costClass: COST_BY_KIND.new_connector, disruptionClass: DISRUPTION_BY_KIND.new_connector, landTake: LAND_UNKNOWN });
    }
  }
  // Management first, then physical; within each, the order of the locations
  const order = (c: Candidate) => (c.physical ? 1 : 0);
  return out.map((c, i) => ({ c, i })).sort((a, b) => order(a.c) - order(b.c) || a.i - b.i).map(x => x.c).slice(0, max);
}

function signalisationCandidate(j: LogicalJunction, r: RoadAnalysisResult, base: Pick<Candidate, 'locationId' | 'locationLabel' | 'evidence'>, causes: BottleneckCause[], rationale: string): Candidate {
  const dem = armDemand(j, r);
  const plan0: SignalPlan = { amberS: DEFAULT_AMBER_S, allRedS: DEFAULT_ALL_RED_S, phases: j.approaches.map(a => ({ greenS: 25, arms: [a.id] })) };
  const w = websterPlan(plan0, j.approaches.map(a => dem.get(a.id) ?? { flowPcu: 0, satFlowPcu: 1 }));
  const spec: JunctionEditSpec = { ...defaultEdit(j, { plan: w.plan }), control: 'signal' }; delete spec.asRun;
  return { ...base, id: `signal:${j.id}`, kind: 'junction_control', category: 'A', title: `Signal control at ${j.label}`, causes,
    rationale: `${rationale} One phase per approach, cycle ${w.cycleS} s (Webster, Y = ${w.Y.toFixed(2)}).`,
    assumptions: ['One phase per approach (conservative; no shared phases).', 'Greens by Webster on assigned demand × mean fleet PCU; Indo-HCM saturation flow on 3.5 m lanes.'],
    limitations: ['Signal warrant (e.g. IRC:93 criteria) not checked: needs counts.', 'Pedestrian phases not modelled.'],
    edits: [{ op: 'junction_edit', spec, centre: j.centre }], physical: false,
    costClass: COST_BY_KIND.junction_control, disruptionClass: DISRUPTION_BY_KIND.junction_control, landTake: NO_LAND };
}

/** A lane added to (+1) or taken from (-1) one direction of a road, as the Build properties edit does. */
function laneEdit(o: RoadObject, dir: DirectionFlow, delta: 1 | -1): CandidateEdit | null {
  const forward = o.isOneWay || angleDiff(bearingOf(o.coordinates[0], o.coordinates.at(-1)!), dir.bearingDeg) < 90;
  const field = forward ? 'lanesForward' : 'lanesBackward';
  const sec = o.sections?.[0];
  const now = forward ? sec?.carriagewayA?.lanes ?? Math.ceil((o.laneCount || 2) / (o.isOneWay ? 1 : 2)) : sec?.carriagewayB?.lanes ?? Math.floor((o.laneCount || 2) / 2);
  const next = now + delta;
  if (next < 1 || next > 6) return null;
  return { op: 'road_field', roadId: o.id, field, value: next, scope: 'segment' };
}

/** Flyover points: from ~150 m up the direction's approach, over the junction, to ~150 m down the exit straight ahead; ends on network nodes. */
export function flyoverAlignment(j: LogicalJunction, dir: DirectionFlow, net: StudyArea['network']): [number, number, number][] | null {
  const from = (dir.bearingDeg + 180) % 360;
  const appr = [...j.approaches].sort((a, b) => angleDiff(a.bearingDeg, from) - angleDiff(b.bearingDeg, from))[0];
  const exit = [...j.exits].sort((a, b) => angleDiff(a.bearingDeg, dir.bearingDeg) - angleDiff(b.bearingDeg, dir.bearingDeg))[0];
  if (!appr || !exit || angleDiff(appr.bearingDeg, from) > 30 || angleDiff(exit.bearingDeg, dir.bearingDeg) > 30) return null;
  const walk = (start: string, back: boolean): [number, number, number] | null => {
    let n = start, d = 0;
    for (let i = 0; i < 30 && d < 150; i++) {
      const ids = back ? net.nodes.get(n)?.incomingSegments ?? [] : net.nodes.get(n)?.outgoingSegments ?? [];
      const e = ids.map(id => net.edges.get(id)!).filter(Boolean).sort((a, b) => angleDiff(bearingOf(...(back ? [a.coordinates.at(-1)!, a.coordinates[0]] : [a.coordinates[0], a.coordinates.at(-1)!]) as [number[], number[]]), back ? from : dir.bearingDeg)
        - angleDiff(bearingOf(...(back ? [b.coordinates.at(-1)!, b.coordinates[0]] : [b.coordinates[0], b.coordinates.at(-1)!]) as [number[], number[]]), back ? from : dir.bearingDeg))[0];
      if (!e) break;
      d += e.length; n = back ? e.fromNodeId : e.toNodeId;
    }
    if (d < 80) return null;
    const c = net.nodes.get(n)!.coordinates;
    return [c[0], c[1], c[2] ?? 0];
  };
  const startEdge = net.edges.get(appr.edgeIds[0]), endEdge = net.edges.get(exit.edgeIds[0]);
  if (!startEdge || !endEdge) return null;
  const a = walk(startEdge.fromNodeId, true) ?? [startEdge.coordinates[0][0], startEdge.coordinates[0][1], 0] as [number, number, number];
  const b = walk(endEdge.toNodeId, false) ?? [endEdge.coordinates.at(-1)![0], endEdge.coordinates.at(-1)![1], 0] as [number, number, number];
  if (distM(a, b) < 150) return null;
  return [a, [j.centre[0], j.centre[1], 0], b];
}

/** A straight connector from the end of a main road that ends without a connection to the nearest node of another road (≤ 400 m). */
function connectorAlignment(r: RoadAnalysisResult, ctx: GeneratorContext, near: readonly number[]): { points: [number, number, number][]; fromRoad: string; fromName: string; toName: string; lengthM: number } | null {
  const net = ctx.area.network;
  const gap = (r.networkGaps ?? []).filter(g => distM(g.coordinates, near) < 800).sort((a, b) => distM(a.coordinates, near) - distM(b.coordinates, near))[0];
  if (!gap) return null;
  const start = gap.coordinates;
  let best: { c: [number, number, number]; road: string; d: number } | null = null;
  for (const n of net.nodes.values()) {
    const roadsHere = new Set([...n.incomingSegments, ...n.outgoingSegments].map(id => net.edges.get(id)?.roadId));
    if (roadsHere.has(gap.roadId)) continue;
    if (Math.abs((n.coordinates[2] ?? 0) - (start[2] ?? 0)) > 1) continue;
    const d = distM(n.coordinates, start);
    if (d >= 40 && d <= 400 && (!best || d < best.d)) best = { c: [n.coordinates[0], n.coordinates[1], n.coordinates[2] ?? 0], road: [...roadsHere][0] ?? '', d };
  }
  if (!best) return null;
  const toName = (ctx.roads.get(best.road) as RoadObject | undefined)?.name || 'the nearest road';
  return { points: [[start[0], start[1], start[2] ?? 0], best.c], fromRoad: gap.roadId, fromName: gap.roadName, toName, lengthM: best.d };
}


import type { RoadAnalysisResult } from './RoadAnalysis';
import type { AnalysisOutput } from './analysisJob';
import type { DrivableObject } from './StudyAreaExplorer';
import { isGenericRoadName } from './roadSection';

/**
 * Existing city against a proposal, both run on the same frozen OD demand,
 * seed, hour and settings (analysisJob.ts), each with the same route
 * adaptation. Differences are then the network's doing: rerouting, capacity,
 * junction control. When the land use changed too, the comparison is labelled
 * a development scenario and the demand change is reported next to it.
 */
export type Verdict = 'better' | 'worse' | 'mixed' | 'no_change';

export interface Delta { label: string; before: number | null; after: number | null; unit: string; /** Lower is better for this measure. */ lowerIsBetter: boolean; change: number | null; good: boolean | null }
export interface RoadChange { roadName: string; before: number; after: number; change: number }

export interface ComparisonResult {
  kind: 'infrastructure' | 'development';
  /** Planned demand before and after (veh/h); equal for an infrastructure comparison. */
  demandBefore: number;
  demandAfter: number;
  section: Delta[];
  network: Delta[];
  /** Roads whose traffic changed most (veh/h on their busiest stretch). */
  rerouting: RoadChange[];
  verdict: { section: Verdict; network: Verdict; summary: string };
  /** Share of OD flow on a different route in the proposal than in the existing city. */
  caveats: string[];
}

const pct = (a: number | null, b: number | null) => (a === null || b === null || Math.abs(a) < 1e-9 ? null : (b - a) / Math.abs(a));
const delta = (label: string, before: number | null, after: number | null, unit: string, lowerIsBetter: boolean, threshold = 0.05): Delta => {
  const change = pct(before, after);
  const good = change === null || Math.abs(change) < threshold ? null : lowerIsBetter ? change < 0 : change > 0;
  return { label, before, after, unit, lowerIsBetter, change, good };
};
const verdictOf = (ds: Delta[]): Verdict => {
  const goods = ds.filter(d => d.good === true).length, bads = ds.filter(d => d.good === false).length;
  return goods && !bads ? 'better' : bads && !goods ? 'worse' : goods && bads ? 'mixed' : 'no_change';
};

/** Mean section speed over its directions, weighted by volume. */
const sectionSpeed = (r: RoadAnalysisResult) => {
  const ds = r.directions.filter(d => d.meanSpeedKmh !== null);
  const w = ds.reduce((n, d) => n + Math.max(1, d.vph), 0);
  return ds.length ? ds.reduce((n, d) => n + d.meanSpeedKmh! * Math.max(1, d.vph), 0) / w : null;
};

export function compareAnalyses(before: AnalysisOutput, after: AnalysisOutput, roads: { before: ReadonlyMap<string, DrivableObject>; after: ReadonlyMap<string, DrivableObject> }, demand: { before: number; after: number }): ComparisonResult {
  const a = before.result, b = after.result;
  const kind = Math.abs(demand.before - demand.after) > 0.5 ? 'development' : 'infrastructure';
  const endDelay = (r: RoadAnalysisResult) => {
    const js = r.junctions.filter(j => j.atSection);
    return js.length ? Math.max(...js.map(j => j.delayS)) : null;
  };
  const section: Delta[] = [
    delta('Traffic on the road', a.totalVph, b.totalVph, 'veh/h', false, 0.05),
    delta('Speed on the road', sectionSpeed(a), sectionSpeed(b), 'km/h', false, 0.05),
    delta('Worst junction delay at its ends', endDelay(a), endDelay(b), 's', true, 0.1),
    delta('Vehicles queued on it', a.directions.reduce((n, d) => n + d.queuedNow, 0), b.directions.reduce((n, d) => n + d.queuedNow, 0), 'veh', true, 0.15),
  ];
  // "Traffic on the road" is neither good nor bad by itself: more vehicles can mean it now relieves a parallel road
  section[0].good = null;
  const m = (r: RoadAnalysisResult) => r.network;
  const network: Delta[] = [
    delta('Share of demand that got onto the roads', a.load ? 100 * a.load.servedShare : null, b.load ? 100 * b.load.servedShare : null, '%', false, 0.03),
    delta('Trips completed', m(a).completedTrips, m(b).completedTrips, 'trips', false, 0.03),
    delta('Mean trip time', m(a).meanTravelTimeS, m(b).meanTravelTimeS, 's', true, 0.03),
    delta('Mean delay per trip', m(a).meanDelayS, m(b).meanDelayS, 's', true, 0.05),
    delta('Vehicles still queued or waiting to enter', m(a).onNetwork + m(a).waitingToEnter, m(b).onNetwork + m(b).waitingToEnter, 'veh', true, 0.05),
    delta('Vehicles removed after gridlock', m(a).gridlockRemovals, m(b).gridlockRemovals, 'veh', true, 0.2),
  ];

  // Rerouting: traffic by road name, on its busiest stretch, before and after
  const byRoad = (r: RoadAnalysisResult, rs: ReadonlyMap<string, DrivableObject>) => {
    const out = new Map<string, number>();
    r.linkVph.forEach((vph, linkId) => {
      const roadId = linkId.replace(/_seg_\d+_(fwd|bwd)$/, '');
      const name = rs.get(roadId)?.name || 'Unnamed road';
      if (isGenericRoadName(name)) return;
      out.set(name, Math.max(out.get(name) ?? 0, vph));
    });
    return out;
  };
  const ra = byRoad(a, roads.before), rb = byRoad(b, roads.after);
  const rerouting = [...new Set([...ra.keys(), ...rb.keys()])].map(roadName => ({ roadName, before: Math.round(ra.get(roadName) ?? 0), after: Math.round(rb.get(roadName) ?? 0), change: Math.round((rb.get(roadName) ?? 0) - (ra.get(roadName) ?? 0)) }))
    .filter(r => Math.abs(r.change) >= 60 && Math.abs(r.change) >= 0.1 * Math.max(r.before, r.after)).sort((x, y) => Math.abs(y.change) - Math.abs(x.change)).slice(0, 8);

  const sv = verdictOf(section), nv = verdictOf(network);
  const word: Record<Verdict, string> = { better: 'improves', worse: 'worsens', mixed: 'has mixed effects on', no_change: 'makes no clear difference to' };
  let summary = `The change ${word[sv]} the selected road and ${word[nv]} the wider area.`;
  if (sv === 'better' && nv === 'worse') summary = 'The selected road gets better, but the wider area gets worse: traffic or queues move elsewhere.';
  if (sv === 'worse' && nv === 'better') summary = 'The wider area gets better at the expense of the selected road.';
  const caveats: string[] = [];
  if (kind === 'development') caveats.push(`Land use changed too: demand went from ${Math.round(demand.before).toLocaleString()} to ${Math.round(demand.after).toLocaleString()} veh/h, so differences mix the new demand with any road changes. Compare road changes on their own with the land use as in the baseline.`);
  if (a.load?.overloaded || b.load?.overloaded) caveats.push('Demand exceeds what the modelled network can carry in at least one run, so part of the demand never entered: compare the share of demand served and the waiting vehicles, not only speeds.');
  if (before.adaptation && after.adaptation && before.adaptation.applied !== after.adaptation.applied)
    caveats.push(`Routes were adapted to congestion in ${after.adaptation.applied ? 'the proposal' : 'the existing city'} only (the other run was past its modelled capacity), so part of the difference is drivers choosing routes differently.`);
  caveats.push('One seed and one simulated hour: differences under about 5% (10% for junction delay) are within run-to-run noise and are shown as no change.');
  if (after.unroutedVph > before.unroutedVph + 1) caveats.push(`${Math.round(after.unroutedVph - before.unroutedVph).toLocaleString()} veh/h more can no longer reach their destination: the change cuts a route.`);
  return { kind, demandBefore: demand.before, demandAfter: demand.after, section, network, rerouting, verdict: { section: sv, network: nv, summary }, caveats };
}

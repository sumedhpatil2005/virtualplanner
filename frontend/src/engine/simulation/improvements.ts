import type { RoadAnalysisResult } from './RoadAnalysis';

export interface Suggestion { title: string; why: string; action?: { label: string; roadIds: string[]; at: [number, number, number] | null } }

/** Improvements worth testing, from the diagnosis. Suggestions, not results: each is tested with "Test a change". */
export function improvementsFor(r: RoadAnalysisResult, sectionRoadIds: string[], at: [number, number, number] | null): Suggestion[] {
  const out: Suggestion[] = [];
  const busiest = r.directions[0];
  const quiet = r.nearby.filter(n => (n.vc ?? 1) < 0.4 && n.roadClass !== 'local').slice(0, 1)[0];
  if (r.bottleneck) out.push({ title: `Rework the junction at ${r.bottleneck.label}`, why: `It delays traffic ${Math.round(r.bottleneck.delayS)} s on average (LOS ${r.bottleneck.los}). Try signal timing, a separate turning phase, a free left turn, or a grade separation.`, action: { label: 'Open the junction in Build', roadIds: sectionRoadIds, at: [r.bottleneck.coordinates[0], r.bottleneck.coordinates[1], 0] } });
  if (busiest && busiest.vc > 0.85) out.push({ title: 'Add a lane', why: `${busiest.label} it runs at ${Math.round(busiest.vc * 100)}% of capacity on ${busiest.lanes} lane${busiest.lanes === 1 ? '' : 's'}. Widening helps only if the junctions at its ends can pass the extra traffic.`, action: { label: 'Select the road in Build', roadIds: sectionRoadIds, at } });
  if ((r.status === 'congested' || r.status === 'busy') && r.composition.throughShare > 0.6) out.push({ title: 'Give through traffic another way', why: `${Math.round(r.composition.throughShare * 100)}% of its vehicles only cross the area. A bypass, a link road or a flyover over the worst junction would take them off it.`, action: { label: 'Draw a road in Build', roadIds: [], at } });
  if ((r.status === 'congested' || r.status === 'busy') && quiet) out.push({ title: `Make better use of ${quiet.roadName}`, why: `It runs at ${Math.round((quiet.vc ?? 0) * 100)}% of capacity ${quiet.distanceM} m away. A better connection could move traffic there.` });
  if (r.status === 'underused') out.push({ title: 'Space to spare', why: 'Capacity is well above use at this hour. Check the peak hours before deciding; a road this quiet could give space to footpaths, a bus lane or a cycle track.' });
  if (r.status === 'no_traffic') out.push({ title: 'Check how it connects', why: 'Routes through the area avoid it. It may be cut off by one-way streets or turn bans, or a parallel road may be much faster. See Network checks under Advanced.' });
  if (r.status === 'normal' && !r.bottleneck) out.push({ title: 'No pressing problem at this hour', why: 'Try the morning (09:00) and evening (19:00) peaks before concluding.' });
  return out.slice(0, 3);
}


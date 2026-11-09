import type { RoadAnalysisResult } from './RoadAnalysis';

/**
 * Improvements worth testing, each traced to a finding of the analysis
 * (docs/OVERHAUL.md §7). Nothing is suggested without the number that
 * motivates it; where the analysis cannot point to a cause, the suggestion is
 * to investigate further (a count, a site visit), not to build something.
 * These are things to test with "Compare", not results.
 */
export interface Suggestion {
  title: string;
  /** The finding it rests on, with its numbers. */
  evidence: string;
  /** What to try, and what to check when comparing. */
  why: string;
  kind: 'junction' | 'signal' | 'widen' | 'divert' | 'investigate' | 'none' | 'times';
  /** The headline number of the evidence, for a compact card (the same figure the evidence text gives). */
  figure?: { value: string; label: string };
  action?: { label: string; roadIds: string[]; at: [number, number, number] | null; /** Opens the whole junction at `at` in Build's junction editor (docs/OVERHAUL.md §23). */ junction?: boolean };
}

export function improvementsFor(r: RoadAnalysisResult, sectionRoadIds: string[], at: [number, number, number] | null): Suggestion[] {
  const out: Suggestion[] = [];
  const worst = [...r.directions].sort((a, b) => (b.delay?.total ?? 0) - (a.delay?.total ?? 0))[0];
  const chain = r.cause.chain;
  const congested = r.status === 'slow' || r.status === 'congested' || r.status === 'severe';

  if (r.cause.kind === 'spillback' && chain?.root) {
    const root = chain.root;
    out.push({ kind: 'junction', title: `Fix the junction where the queue starts: ${root.label}`,
      // The same figures as the "Why" text: the direction's delay split, not the trace's own share
      evidence: (() => {
        const dd = r.directions.find(d => d.label === chain.direction)?.delay;
        return dd && dd.total > 0
          ? `${Math.round(100 * dd.blocked / dd.total)}% of the delay ${chain.direction} (${Math.round(dd.blocked)} s of ${Math.round(dd.total)} s per vehicle) is spent stopped behind a queue traced to it (${chain.agreement} of ${chain.seeds} runs).`
          : `${Math.round(100 * chain.blockedShare)}% of the delay ${chain.direction} is stopped time behind a queue traced to it (${chain.agreement} of ${chain.seeds} runs).`;
      })(),
      figure: (() => {
        const dd = r.directions.find(d => d.label === chain.direction)?.delay;
        return { value: `${Math.round(100 * (dd && dd.total > 0 ? dd.blocked / dd.total : chain.blockedShare))}%`, label: `of the delay ${chain.direction} is queueing behind it` };
      })(),
      why: root.cause === 'signal' ? 'Try retiming its signal or giving the queued approach a longer green; compare the delay on this road and at the junction\'s other approaches.' : 'Try signal control, a turn ban or a separate turning lane there; compare the whole neighbourhood, not only this road.',
      action: { label: 'Open the junction in Build', roadIds: sectionRoadIds, at: [root.coordinates[0], root.coordinates[1], 0], junction: true } });
  }
  if (r.cause.kind === 'own-signal' && worst?.delay) {
    const j = r.junctions.find(x => x.atSection && x.signalised);
    out.push({ kind: 'signal', title: `Retime the signal at ${j?.label ?? 'its end'}`,
      evidence: `${Math.round(worst.delay.signal)} s of the ${Math.round(worst.delay.total)} s delay per vehicle ${worst.label} is signal waiting; the stop line passes about ${worst.capacityPcu.toLocaleString()} PCU/h against ${worst.demandPcu.toLocaleString()} routed.`,
      figure: { value: `${Math.round(worst.delay.signal)} s`, label: `of ${Math.round(worst.delay.total)} s delay per vehicle is signal waiting` },
      why: 'A longer green for this approach shortens its wait but lengthens the others\': compare all approaches of the junction.',
      action: j ? { label: 'Open the junction in Build', roadIds: sectionRoadIds, at: [j.coordinates[0], j.coordinates[1], 0], junction: true } : undefined });
  }
  const overCap = r.directions.find(d => d.vc > 0.85 && d.capacityBasis === 'midblock');
  if (overCap) {
    out.push({ kind: 'widen', title: 'Add a lane',
      evidence: `${capital(overCap.label)} the traffic routed along it is ${Math.round(100 * overCap.vc)}% of its mid-block capacity (${overCap.capacityPcu.toLocaleString()} PCU/h on ${overCap.lanes} lane${overCap.lanes === 1 ? '' : 's'}, IRC:106).`,
      figure: { value: `${Math.round(100 * overCap.vc)}%`, label: `of mid-block capacity, ${overCap.label}` },
      why: 'Widening only helps if the junctions at its ends can pass the extra traffic, and more capacity can draw more traffic onto it: compare the end junctions and the neighbourhood.',
      action: { label: 'Select the road in Build', roadIds: sectionRoadIds, at } });
  }
  const signalCap = r.directions.find(d => d.vc > 0.85 && d.capacityBasis === 'signal');
  if (signalCap && r.cause.kind !== 'own-signal') {
    out.push({ kind: 'signal', title: 'Give its approach more green time',
      evidence: `${capital(signalCap.label)} the traffic routed along it is ${Math.round(100 * signalCap.vc)}% of what the signal at its end passes (${signalCap.capacityPcu.toLocaleString()} PCU/h).`,
      figure: { value: `${Math.round(100 * signalCap.vc)}%`, label: `of what the signal passes, ${signalCap.label}` },
      why: 'More green here means less for the crossing road: compare the junction as a whole.',
      // The signal at the direction's downstream end: its stop line is the last point of the direction's geometry
      action: (() => { const end = signalCap.paths.at(-1)?.at(-1); return end ? { label: 'Open the junction in Build', roadIds: sectionRoadIds, at: [end[0], end[1], 0] as [number, number, number], junction: true } : undefined; })() });
  }
  if (congested && r.composition.throughShare > 0.6) {
    const spare = r.nearby.filter(n => (n.vc ?? 1) < 0.6 && n.roadClass !== 'local' && n.vph > 0).sort((a, b) => (a.vc ?? 1) - (b.vc ?? 1))[0];
    if (spare) out.push({ kind: 'divert', title: `Make ${spare.roadName} the better route for through traffic`,
      evidence: `${Math.round(100 * r.composition.throughShare)}% of the road's traffic only crosses the area; ${spare.roadName}, ${spare.distanceM} m away, runs at ${Math.round(100 * (spare.vc ?? 0))}% of capacity.`,
      figure: { value: `${Math.round(100 * r.composition.throughShare)}%`, label: `through traffic; ${spare.roadName} at ${Math.round(100 * (spare.vc ?? 0))}% of capacity` },
      why: 'A better connection or signal priority there could move traffic off this road. Compare both roads: diverting can just move the queue.' });
    else out.push({ kind: 'investigate', title: 'Through traffic has no spare alternative nearby',
      evidence: `${Math.round(100 * r.composition.throughShare)}% of the road's traffic only crosses the area, and no nearby main road has spare capacity in the model.`,
      figure: { value: `${Math.round(100 * r.composition.throughShare)}%`, label: 'only crosses the area; no spare parallel road' },
      why: 'A new link or bypass would need a wider study (origins and destinations beyond this area) before it can be judged here.' });
  }
  if (r.cause.kind === 'insufficient' && congested) {
    out.push({ kind: 'investigate', title: 'Investigate before deciding',
      evidence: r.cause.text,
      why: 'Count the traffic and observe the queues on site at this hour. The model cannot point to one cause, so no intervention is suggested.' });
  }
  if (!r.statusConsistent) {
    out.push({ kind: 'investigate', title: 'The result is borderline',
      evidence: `The runs disagree on the status (${r.statusBySeed.join(', ')}).`,
      why: 'Treat the road as near the threshold; a count or travel-time survey would settle it.' });
  }
  if (r.status === 'flowing' || r.status === 'moderate') {
    if (!out.length) out.push({ kind: 'times', title: 'No pressing problem at this hour',
      evidence: r.headline,
      why: 'Compare the other times of day before concluding; spare capacity could also give space to footpaths, a bus lane or a cycle track.' });
  }
  if (r.status === 'no_traffic') out.push({ kind: 'investigate', title: 'Check how it connects',
    evidence: 'Almost no traffic is routed over it in the model.',
    why: 'It may be cut off by one-way streets or a mapping error, or a parallel road may be much faster. See the network checks under Details.' });
  return out.slice(0, 4);
}

const capital = (s: string) => s.charAt(0).toUpperCase() + s.slice(1);

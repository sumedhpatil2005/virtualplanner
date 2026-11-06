import type { TrafficNetwork } from '../objects/trafficTypes';
import type { RoadAnalysisResult } from './RoadAnalysis';
import { compileJunctionEdits, type JunctionEditSpec } from './junctionControl';

/**
 * Before and after at the approaches of an edited junction (docs/OVERHAUL.md
 * §23): delay per vehicle and traffic on each approach, from the per-link
 * figures of the two analyses (mean over their seeds). A longer green for one
 * approach costs the others; this is what shows it.
 */
export interface ApproachSide { delayS: number | null; vph: number; gC: number | null }
export interface ApproachDelta {
  armId: string;
  label: string;
  before: ApproachSide;
  after: ApproachSide;
  /** after - before delay (s), null where either side has none. */
  delayChangeS: number | null;
  /** Under 2 s or 10% either way is no clear change. */
  verdict: 'better' | 'worse' | 'same' | 'unknown';
}

const side = (links: string[], r: RoadAnalysisResult): ApproachSide => {
  let vph = 0, dw = 0, w = 0, gC: number | null = null;
  for (const id of links) {
    const l = r.linkDelay?.get(id);
    if (!l) continue;
    vph += l.vph;
    if (l.delayS !== null) { dw += l.delayS * Math.max(l.vph, 1e-6); w += Math.max(l.vph, 1e-6); }
    if (l.gC !== null) gC = Math.max(gC ?? 0, l.gC);
  }
  return { delayS: w > 0 ? dw / w : null, vph, gC };
};

export function junctionApproachDeltas(net: TrafficNetwork, spec: JunctionEditSpec, before: RoadAnalysisResult, after: RoadAnalysisResult): { approaches: ApproachDelta[]; total: ApproachDelta } | null {
  const c = compileJunctionEdits(net, [spec])[0];
  if (!c || !before.linkDelay || !after.linkDelay) return null;
  const linksOf = (armId: string) => {
    // The simulated link that reaches the junction: the stretch entering it, or the piece before it where the simulator folded a short one into the junction
    const direct = [...c.approachOfEdge].filter(([, a]) => a === armId).map(([id]) => id);
    const known = direct.filter(id => before.linkDelay!.has(id) || after.linkDelay!.has(id));
    if (known.length) return known;
    return [...c.chainOfEdge].filter(([id, a]) => a === armId && spec.arms.find(x => x.id === a)?.kind === 'in' && (before.linkDelay!.has(id) || after.linkDelay!.has(id))).map(([id]) => id);
  };
  const verdict = (b: number | null, a: number | null): ApproachDelta['verdict'] => {
    if (b === null || a === null) return 'unknown';
    const d = a - b;
    if (Math.abs(d) < 2 || Math.abs(d) < 0.1 * Math.max(b, 1)) return 'same';
    return d < 0 ? 'better' : 'worse';
  };
  const approaches = spec.arms.filter(a => a.kind === 'in').map(a => {
    const ids = linksOf(a.id);
    const b = side(ids, before), x = side(ids, after);
    return { armId: a.id, label: a.label, before: b, after: x, delayChangeS: b.delayS !== null && x.delayS !== null ? x.delayS - b.delayS : null, verdict: verdict(b.delayS, x.delayS) };
  });
  const agg = (k: 'before' | 'after'): ApproachSide => {
    let vph = 0, dw = 0, w = 0;
    for (const a of approaches) { vph += a[k].vph; if (a[k].delayS !== null) { dw += a[k].delayS! * Math.max(a[k].vph, 1e-6); w += Math.max(a[k].vph, 1e-6); } }
    return { delayS: w > 0 ? dw / w : null, vph, gC: null };
  };
  const tb = agg('before'), ta = agg('after');
  return { approaches, total: { armId: 'all', label: 'All approaches', before: tb, after: ta, delayChangeS: tb.delayS !== null && ta.delayS !== null ? ta.delayS - tb.delayS : null, verdict: verdict(tb.delayS, ta.delayS) } };
}

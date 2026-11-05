import type { RoadAnalysisResult, RoadStatus, DirectionFlow, LoadCheck } from '../engine/simulation/RoadAnalysis';
import type { Tone } from './ui/vizTones';

/**
 * What the road analysis pieces read from a result: the status words and
 * tones, the direction the analysis explains, the overloaded runs and the
 * one-line cause. Plain functions, no components (RoadAnalysisPieces.tsx).
 */

export const STATUS: Record<RoadStatus, { label: string; short: string; tone: Tone }> = {
  flowing: { label: 'Flowing', short: 'Flowing', tone: 'good' },
  moderate: { label: 'Some delay', short: 'Some delay', tone: 'ok' },
  slow: { label: 'Slow', short: 'Slow', tone: 'warn' },
  congested: { label: 'Congested', short: 'Congested', tone: 'alert' },
  severe: { label: 'Severely congested', short: 'Severe', tone: 'bad' },
  no_traffic: { label: 'Almost no traffic', short: 'Empty', tone: 'neutral' },
};
/** The direction the analysis explains (its own pick), falling back to the longest delay for older results. */
export function explainedDirection(r: RoadAnalysisResult): { d: DirectionFlow; index: number } | null {
  if (!r.directions.length) return null;
  let index = r.explainedDirection ? r.directions.findIndex(d => d.label === r.explainedDirection) : -1;
  if (index < 0) index = r.directions.reduce((best, d, i) => ((d.delay?.total ?? 0) > (r.directions[best].delay?.total ?? 0) ? i : best), 0);
  return { d: r.directions[index], index };
}

/** Load checks of the runs that reported the neighbourhood overloaded (all runs from older results: the combined one). */
export function overloadedRuns(r: RoadAnalysisResult): { runs: LoadCheck[]; of: number; message: string | null } {
  const all = r.loadBySeed ?? [r.load];
  const runs = all.filter(l => l.overloaded);
  const message = r.load.message ?? runs.find(l => l.message)?.message ?? null;
  return { runs, of: all.length, message };
}

export const DELAY_COLOURS = { signal: '#60a5fa', blocked: '#f43f5e', giveWay: '#facc15', other: '#94a3b8' } as const;

export const delayParts = (d: NonNullable<DirectionFlow['delay']>) => [
  { key: 'signal', label: 'Signal', value: d.signal, color: DELAY_COLOURS.signal },
  { key: 'blocked', label: 'Queue from ahead', value: d.blocked, color: DELAY_COLOURS.blocked },
  { key: 'giveWay', label: 'Giving way', value: d.giveWay + d.conflict, color: DELAY_COLOURS.giveWay },
  { key: 'other', label: 'Moving traffic', value: d.other, color: DELAY_COLOURS.other },
];

/** One line naming the cause, from the analysis' cause kind (a cause is named only when the runs support it). */
export function causeLine(r: RoadAnalysisResult): { text: string; tone: Tone; agreement?: string } {
  const c = r.cause;
  switch (c.kind) {
    case 'spillback': {
      const root = c.chain?.root;
      const why = root?.cause === 'signal' ? 'its signal' : root?.cause === 'giveWay' ? 'giving way' : root?.cause === 'conflict' ? 'conflicting turns' : root?.cause === 'gridlock' ? 'gridlock' : 'a hold-up';
      return { text: root ? `Queue backing up from ${root.label} (${why})` : 'Queue backing up from a junction further on', tone: 'bad', agreement: c.chain ? `${c.chain.agreement}/${c.chain.seeds} runs` : undefined };
    }
    case 'own-signal': return { text: 'Waiting at the signal at its end', tone: 'info' };
    case 'give-way': return { text: 'Giving way at an unsignalised junction', tone: 'warn' };
    case 'volume': return { text: 'Close to capacity: slow in dense traffic', tone: 'alert' };
    case 'mixed': return { text: 'Spread over several causes', tone: 'neutral' };
    case 'insufficient': {
      if (r.status === 'no_traffic') return { text: 'Routes avoid it, or it is poorly connected', tone: 'warn' };
      // Which kind of "not enough evidence": the same split the analysis used (RoadAnalysis.combineAnalysis)
      const d = explainedDirection(r)?.d.delay;
      if (d && d.total > 0 && d.blocked / d.total >= 0.35) return { text: 'Queue from further on, not traced to one junction consistently', tone: 'warn' };
      if (d && d.total > 0 && d.other / d.total >= 0.5) return { text: 'Slow in moving traffic: no single junction stands out', tone: 'warn' };
      return { text: 'Evidence not enough to name a cause', tone: 'warn' };
    }
    default: return { text: 'Delay is small', tone: 'good' };
  }
}


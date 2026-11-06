import React from 'react';
import type { ApproachDelta } from '../engine/simulation/junctionCompare';

/**
 * Improve & compare: before and after at the approaches of each edited
 * imported junction (docs/OVERHAUL.md §23). A longer green for one approach
 * is paid for by the others; this card shows both sides, from the same
 * demand, hour and seeds as the rest of the comparison.
 */
export interface JunctionComparison { junctionId: string; label: string; deltas: { approaches: ApproachDelta[]; total: ApproachDelta } }

const s = (x: number | null) => (x === null ? '—' : `${Math.round(x)} s`);
const v = (x: number) => Math.round(x).toLocaleString('en-US');
const TONE: Record<ApproachDelta['verdict'], string> = { better: 'text-emerald-300', worse: 'text-rose-300', same: 'text-slate-400', unknown: 'text-slate-500' };
const WORD: Record<ApproachDelta['verdict'], string> = { better: 'shorter', worse: 'longer', same: 'no clear change', unknown: 'no data' };

const Row: React.FC<{ a: ApproachDelta; strong?: boolean }> = ({ a, strong }) => (
  <li className={`grid grid-cols-[1fr_auto] gap-x-2 px-2.5 py-1.5 text-[11px] ${strong ? 'bg-white/[0.03]' : ''}`} data-arm-id={a.armId} data-verdict={a.verdict}>
    <span className={`leading-tight ${strong ? 'text-slate-100 font-semibold' : 'text-slate-300'}`}>{a.label}</span>
    <span className="tabular-nums text-right">
      <span className="text-slate-400">{s(a.before.delayS)} → </span>
      <span className={TONE[a.verdict]}>{s(a.after.delayS)}</span>
    </span>
    <span className="text-slate-500 tabular-nums">
      {v(a.before.vph)} → {v(a.after.vph)} veh/h{a.before.gC !== null || a.after.gC !== null ? ` · green ${a.before.gC !== null ? Math.round(a.before.gC * 100) : '—'}% → ${a.after.gC !== null ? Math.round(a.after.gC * 100) : '—'}% of cycle` : ''}
    </span>
    <span className={`text-right ${TONE[a.verdict]}`}>{a.delayChangeS !== null && a.verdict !== 'same' ? `${a.delayChangeS > 0 ? '+' : ''}${Math.round(a.delayChangeS)} s, ${WORD[a.verdict]}` : WORD[a.verdict]}</span>
  </li>
);

export const JunctionCompareCard: React.FC<{ items: readonly JunctionComparison[] }> = ({ items }) => {
  if (!items.length) return null;
  return (
    <div className="space-y-2" data-testid="junction-compare">
      {items.map(j => (
        <div key={j.junctionId} className="rounded-xl border border-white/10 bg-slate-950/40" data-junction-id={j.junctionId}>
          <div className="px-2.5 pt-2 pb-1">
            <div className="text-xs font-semibold text-slate-100">Edited junction: {j.label}</div>
            <div className="text-[10px] text-slate-500">Delay per vehicle on each approach, before → after (simulated, mean over the runs; same demand, hour and seeds)</div>
          </div>
          <ul className="divide-y divide-white/5">
            {j.deltas.approaches.map(a => <Row key={a.armId} a={a} />)}
            <Row a={j.deltas.total} strong />
          </ul>
        </div>
      ))}
    </div>
  );
};

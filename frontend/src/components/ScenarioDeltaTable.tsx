import React from 'react';
import { ArrowDown, ArrowUp, Minus } from 'lucide-react';
import type { Delta } from '../engine/simulation/ScenarioComparison';

/**
 * Pieces of the road analysis panel that show the existing city against a
 * proposal. Kept free of engine imports so they can be rendered in tests.
 * Every value is the comparison's own (Delta.before / after / change / good);
 * nothing here recomputes or rounds differently from the old table.
 */

const fmt = (n: number) => Math.round(n).toLocaleString();

const fmtDeltaValue = (d: Delta, v: number | null) =>
  v === null ? '—' : `${d.unit === 's' || d.unit === 'km/h' ? Math.round(v) : fmt(v)}${d.unit === 's' ? ' s' : d.unit === 'km/h' ? ' km/h' : d.unit === '%' ? '%' : d.unit === 'veh·h' ? ' veh·h' : ''}`;

/** Change as a percentage, or null when it is too small to show. */
const fmtChange = (d: Delta) =>
  d.change !== null && Math.abs(d.change) >= 0.005 ? `${d.change > 0 ? '+' : ''}${Math.round(d.change * 100)}%` : null;

const GOOD_TITLE = 'Better in every run, beyond the noise threshold';
const BAD_TITLE = 'Worse in every run, beyond the noise threshold';
const NONE_TITLE = 'Not counted as a change: under the noise threshold, not shown by every run, or (for volumes) neither good nor bad';

/** The % change with an arrow, coloured by whether it counts as better (green), worse (red) or no clear change (grey). */
export const ChangePill: React.FC<{ d: Delta }> = ({ d }) => {
  const change = fmtChange(d);
  const cls = d.good === true ? 'text-emerald-200 bg-emerald-500/15 border-emerald-400/30' : d.good === false ? 'text-rose-200 bg-rose-500/15 border-rose-400/30' : 'text-slate-300 bg-white/[0.04] border-white/10';
  const Icon = !change ? Minus : d.change! > 0 ? ArrowUp : ArrowDown;
  return (
    <span data-testid="change-pill" data-good={String(d.good)} title={d.good === true ? GOOD_TITLE : d.good === false ? BAD_TITLE : NONE_TITLE}
      className={`inline-flex items-center gap-0.5 rounded-full border px-1.5 py-px text-[11px] font-semibold tabular-nums whitespace-nowrap ${cls}`}>
      <Icon size={11} aria-hidden />{change ?? 'no change'}
    </span>
  );
};

/** "3/3 runs" when every run shows the change, amber "2/3 runs" when not; only for a visible change. */
export const AgreementChip: React.FC<{ d: Delta }> = ({ d }) => !(d.agreement && d.change !== null && Math.abs(d.change) >= 0.005) ? null : (
  <span data-testid="seed-agreement" title={d.agreement.same === d.agreement.of ? `Same direction of change in all ${d.agreement.of} runs` : `Only ${d.agreement.same} of ${d.agreement.of} runs show this direction of change`}
    className={`inline-flex rounded-full border px-1.5 py-px text-[10px] tabular-nums whitespace-nowrap ${d.agreement.same === d.agreement.of ? 'border-white/10 text-slate-400' : 'border-amber-400/40 text-amber-200'}`}>
    {d.agreement.same}/{d.agreement.of} runs
  </span>
);

const afterColour = (d: Delta) => (d.good === true ? '#34d399' : d.good === false ? '#f43f5e' : '#cbd5e1');

/** Before and after as two thin bars on the same scale. */
const PairBars: React.FC<{ d: Delta }> = ({ d }) => {
  const max = Math.max(Math.abs(d.before ?? 0), Math.abs(d.after ?? 0), 1e-9);
  const w = (v: number | null) => `${v === null ? 0 : Math.max(2, (100 * Math.abs(v)) / max)}%`;
  return (
    <div className="space-y-0.5" aria-hidden>
      <div className="h-1 rounded-full bg-white/5 overflow-hidden"><div className="h-full rounded-full bg-slate-500" style={{ width: w(d.before) }} /></div>
      <div className="h-1 rounded-full bg-white/5 overflow-hidden"><div className="h-full rounded-full" style={{ width: w(d.after), background: afterColour(d) }} /></div>
    </div>
  );
};

/** Existing against proposal, one measure per row: label, paired bars, existing → proposal and the change. */
export const DeltaRows: React.FC<{ rows: Delta[] }> = ({ rows }) => (
  <ul className="divide-y divide-white/5" data-testid="delta-table">
    {rows.map(d => (
      <li key={d.label} className="py-1.5 space-y-1" data-testid="delta-row">
        <div className="flex items-start justify-between gap-2">
          <span className="text-xs text-slate-300 leading-snug" data-testid="delta-label">{d.label}</span>
          <span className="flex items-center gap-1 shrink-0"><AgreementChip d={d} /><ChangePill d={d} /></span>
        </div>
        <div className="grid grid-cols-[1fr_auto] items-center gap-3">
          <PairBars d={d} />
          <span className="text-xs tabular-nums whitespace-nowrap">
            <span className="text-slate-400" data-testid="delta-before" title="Existing city">{fmtDeltaValue(d, d.before)}</span>
            <span className="text-slate-600 mx-1">→</span>
            <span className={d.good === true ? 'text-emerald-300' : d.good === false ? 'text-rose-300' : 'text-white'} data-testid="delta-after" title="Proposal">{fmtDeltaValue(d, d.after)}</span>
          </span>
        </div>
        {d.note && <p className="text-[10px] text-slate-500 leading-snug" data-testid="delta-note">{d.note}</p>}
      </li>
    ))}
  </ul>
);

/** One measure as a before → after card, for the selected road's headline figures. */
export const DeltaKpi: React.FC<{ d: Delta; label?: string }> = ({ d, label }) => (
  <div className="rounded-xl border border-white/5 bg-white/[0.04] px-2.5 py-2 min-w-0 space-y-1" data-testid="delta-kpi" title={d.label}>
    <div className="text-[10px] font-semibold uppercase tracking-wide text-slate-500 truncate">{label ?? d.label}</div>
    <div className="flex items-baseline gap-1.5 tabular-nums whitespace-nowrap">
      <span className="text-xs text-slate-400" title="Existing city">{fmtDeltaValue(d, d.before)}</span><span className="text-xs text-slate-600">→</span>
      <span className={`text-lg font-semibold leading-none ${d.good === true ? 'text-emerald-300' : d.good === false ? 'text-rose-300' : 'text-white'}`} title="Proposal">{fmtDeltaValue(d, d.after)}</span>
    </div>
    <div className="flex items-center gap-1 flex-wrap"><ChangePill d={d} /><AgreementChip d={d} /></div>
    {d.note && <p className="text-[10px] text-slate-500 leading-snug">{d.note}</p>}
  </div>
);

/** Marks figures that come from the network as edited in Build, not the existing city. */
export const ProposalBadge: React.FC = () => (
  <span data-testid="proposal-badge" title="These figures are for the network as edited in Build, not the existing city saved as the baseline."
    className="inline-flex items-center gap-1 rounded-full border border-indigo-400/40 bg-indigo-500/20 px-2 py-0.5 text-[11px] font-semibold uppercase tracking-wide text-indigo-200">
    Proposal
  </span>
);

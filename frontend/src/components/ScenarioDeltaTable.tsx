import React from 'react';
import type { Delta } from '../engine/simulation/ScenarioComparison';

/**
 * Pieces of the road analysis panel that show the existing city against a
 * proposal. Kept free of engine imports so they can be rendered in tests.
 */

const fmt = (n: number) => Math.round(n).toLocaleString();

const fmtDeltaValue = (d: Delta, v: number | null) =>
  v === null ? '—' : `${d.unit === 's' || d.unit === 'km/h' ? Math.round(v) : fmt(v)}${d.unit === 's' ? ' s' : d.unit === 'km/h' ? ' km/h' : ''}`;

/** Change as a percentage, or null when it is too small to show. */
const fmtChange = (d: Delta) =>
  d.change !== null && Math.abs(d.change) >= 0.005 ? `${d.change > 0 ? '+' : ''}${Math.round(d.change * 100)}%` : null;

/** Existing against proposal, one measure per row; the % change sits on its own line under the proposal value. */
export const DeltaRows: React.FC<{ rows: Delta[] }> = ({ rows }) => (
  <table className="w-full text-xs tabular-nums" data-testid="delta-table">
    <thead><tr className="text-slate-500"><th className="text-left font-medium pb-1 pr-3">Measure</th><th className="text-right font-medium pb-1 px-3">Existing</th><th className="text-right font-medium pb-1 pl-3">Proposal</th></tr></thead>
    <tbody>
      {rows.map(d => {
        const change = fmtChange(d);
        return (
          <tr key={d.label} className="border-t border-white/5 align-top">
            <th className="py-1.5 pr-3 text-left font-normal text-slate-400">{d.label}</th>
            <td className="py-1.5 px-3 text-right text-slate-300 whitespace-nowrap">{fmtDeltaValue(d, d.before)}</td>
            <td className={`py-1.5 pl-3 text-right whitespace-nowrap ${d.good === true ? 'text-emerald-300' : d.good === false ? 'text-rose-300' : 'text-white'}`}>
              <span className="block">{fmtDeltaValue(d, d.after)}</span>
              {change && <span className="block text-[11px] text-slate-500">{change}</span>}
            </td>
          </tr>
        );
      })}
    </tbody>
  </table>
);

/** Marks figures that come from the network as edited in Build, not the existing city. */
export const ProposalBadge: React.FC = () => (
  <span data-testid="proposal-badge" title="These figures are for the network as edited in Build, not the existing city saved as the baseline."
    className="inline-flex items-center gap-1 rounded-full border border-indigo-400/40 bg-indigo-500/20 px-2 py-0.5 text-[11px] font-semibold uppercase tracking-wide text-indigo-200">
    Proposal
  </span>
);

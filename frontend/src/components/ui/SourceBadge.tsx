import React from 'react';
import type { DataSource } from './dataSource';

/**
 * Where a number comes from, so a reviewer can tell measured data from
 * modelling assumptions at a glance:
 *  - observed:   counted in the field and published (with a citation)
 *  - survey:     the project's own survey or manual entry from one
 *  - estimated:  a heuristic (population, gravity model, defaults)
 *  - synthetic:  generated from road capacity only
 *  - calibrated: an estimate scaled to observed counts
 *  - simulated:  produced by the traffic model
 *  - hypothetical: a what-if value the user set, never observed or forecast
 */


const STYLE: Record<DataSource, { label: string; cls: string; title: string }> = {
  observed: { label: 'Observed', cls: 'bg-emerald-500/15 text-emerald-300 border-emerald-400/30', title: 'Counted in the field and published; see the citation.' },
  survey: { label: 'Survey', cls: 'bg-sky-500/15 text-sky-300 border-sky-400/30', title: 'From a survey entered for this project.' },
  estimated: { label: 'Estimated', cls: 'bg-amber-500/15 text-amber-300 border-amber-400/30', title: 'Heuristic estimate (population, gravity model or defaults), not a measurement.' },
  synthetic: { label: 'Synthetic', cls: 'bg-slate-500/20 text-slate-300 border-slate-400/30', title: 'Generated from road capacity only; no demand data.' },
  calibrated: { label: 'Calibrated', cls: 'bg-violet-500/15 text-violet-300 border-violet-400/30', title: 'An estimate scaled to match observed counts.' },
  hypothetical: { label: 'Hypothetical', cls: 'bg-fuchsia-500/15 text-fuchsia-300 border-fuchsia-400/40', title: 'A what-if value set by the user: neither observed nor forecast.' },
  simulated: { label: 'Simulated', cls: 'bg-indigo-500/15 text-indigo-300 border-indigo-400/30', title: 'Output of the traffic simulation.' },
};


export const SourceBadge: React.FC<{ source: DataSource; citation?: string; className?: string }> = ({ source, citation, className = '' }) => {
  const s = STYLE[source];
  return (
    <span data-source={source} title={citation ? `${s.title} ${citation}` : s.title}
      className={`inline-flex items-center gap-1 rounded-md border px-1.5 py-px text-[10px] font-semibold uppercase tracking-wide whitespace-nowrap ${s.cls} ${className}`}>
      {s.label}{citation && source === 'observed' ? <span className="normal-case font-normal opacity-80">· {citation}</span> : null}
    </span>
  );
};

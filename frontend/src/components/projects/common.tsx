import React from 'react';
import { CircleHelp, Clock, CircleCheck } from 'lucide-react';
import { STATUS_LABEL, type ProjectStatus } from '../../engine/planning/planningApi';
import type { StaleVerdict } from '../../lib/coordinationApi';
import { staleReasonText, staleState } from '../../lib/planningProjects';

const STATUS_STYLE: Record<ProjectStatus, string> = {
  draft: 'bg-slate-500/20 text-slate-200 border-slate-400/30',
  under_study: 'bg-sky-500/15 text-sky-300 border-sky-400/30',
  under_review: 'bg-amber-500/15 text-amber-300 border-amber-400/30',
  decision_recorded: 'bg-violet-500/15 text-violet-200 border-violet-400/30',
};
export const StatusBadge: React.FC<{ status: ProjectStatus }> = ({ status }) => (
  <span data-testid="project-status" title={status === 'decision_recorded' ? 'A decision was recorded in this tool. This is not a statutory approval.' : undefined}
    className={`inline-flex items-center rounded-md border px-1.5 py-px text-[10px] font-semibold uppercase tracking-wide whitespace-nowrap ${STATUS_STYLE[status]}`}>{STATUS_LABEL[status]}</span>
);

/** Stale indicator computed on read by the backend: Stale (reasons) · Current · Unknown (inputs not recorded). */
export const StaleBadge: React.FC<{ verdict: Pick<StaleVerdict, 'stale' | 'reasons' | 'not_checked'> | null | undefined }> = ({ verdict }) => {
  const s = staleState(verdict);
  const reasons = verdict?.reasons?.map(staleReasonText) ?? [];
  const notChecked = verdict?.not_checked?.length ? ` Not checked: ${verdict.not_checked.join(', ')}.` : '';
  const cfg = s === 'stale'
    ? { Icon: Clock, text: 'Stale', cls: 'text-amber-300 border-amber-400/50', title: `Inputs changed since this was computed: ${reasons.join('; ')}.${notChecked}` }
    : s === 'current'
      ? { Icon: CircleCheck, text: 'Current', cls: 'text-slate-300 border-slate-500/50', title: `No recorded input changed since this was computed.${notChecked}` }
      : { Icon: CircleHelp, text: 'Stale: unknown', cls: 'text-slate-400 border-slate-500/50 border-dashed', title: `Inputs were not fully recorded, so staleness cannot be checked.${notChecked}` };
  return (
    <span data-testid="stale-badge" data-stale={s} title={cfg.title}
      className={`inline-flex items-center gap-1 rounded border px-1.5 py-px text-[11px] font-semibold whitespace-nowrap ${cfg.cls}`}>
      <cfg.Icon size={11} aria-hidden />{cfg.text}{s === 'stale' && reasons.length ? <span className="font-normal">· {reasons[0]}{reasons.length > 1 ? ` +${reasons.length - 1}` : ''}</span> : null}
    </span>
  );
};


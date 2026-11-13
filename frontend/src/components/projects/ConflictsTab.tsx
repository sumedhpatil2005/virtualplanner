import React, { useState } from 'react';
import { Crosshair, FileDown, Loader2, Radar, Share2, ShieldCheck } from 'lucide-react';
import { Section, Button } from '../ui/kit';
import { Disclosure } from '../ui/Disclosure';
import { EmptyState } from '../ui/EmptyState';
import { CertaintyBadge } from '../ui/badges';
import { coordinationApi, type ConflictStatus, type ProjectIssue } from '../../lib/coordinationApi';
import { planningClient } from '../../lib/planningClient';
import { groupIssuesByClass, otherSideEvidence, otherSideLabel, sideBLabel, ACTIONABLE } from '../../lib/planningProjects';
import { StaleBadge } from './common';
import { inputCls, when, flyToGeometry, type Act, type ProjectBundle } from './projectData';

const CLASS_TONE: Record<string, string> = {
  conflict: 'text-rose-300', potential_conflict: 'text-amber-300', vertically_separated: 'text-sky-300',
  unknown_no_coverage: 'text-slate-400', no_conflict_within_available_data: 'text-slate-400',
};
const STATUS_TEXT: Record<ConflictStatus, string> = { open: 'Open', acknowledged: 'Acknowledged', resolved: 'Resolved' };
const m = (v: number | null) => (v == null ? 'UNKNOWN' : `${v.toFixed(1)} m`);

export const ConflictsTab: React.FC<{ b: ProjectBundle; who: string; act: Act }> = ({ b, who, act }) => {
  const [busy, setBusy] = useState(false);
  const lastRun = b.stale?.coordination_runs[0] ?? null;
  const groups = groupIssuesByClass(b.issues);
  const detect = async () => { setBusy(true); await act(() => coordinationApi.detect(b.project.id, who)); setBusy(false); };
  return (
    <>
      <Section title="Conflict detection">
        <div className="flex items-center gap-2 flex-wrap">
          <Button size="sm" variant="primary" icon={busy ? Loader2 : Radar} spin={busy} data-testid="run-detection" disabled={busy || !who || b.elements.length === 0} onClick={() => void detect()}>
            {lastRun ? 'Run again' : 'Run detection'}
          </Button>
          {lastRun && <span className="text-xs text-slate-400">Last run {when(lastRun.created_at)}</span>}
          {lastRun && <StaleBadge verdict={lastRun} />}
        </div>
        {b.elements.length === 0 && <p className="text-xs text-slate-400">Register proposal elements from an alternative first.</p>}
        <Disclosure>
          <p className="text-xs text-slate-400">Checks this project's elements against other projects, base-city roads, OpenStreetMap metro, building footprints (OSM observed; Microsoft / Google ML inferred) and utility records incl. PMC sewer / storm-drain records (ASCE 38 QL-D; sewer depths from DESIGN levels, unverified) (UTM 43N). Depth or width UNKNOWN gives “potential conflict”, never “clear”. “No conflict within available data” is not proof of no conflict. Permission distances (e.g. metro NOC 20 m) are triggers for a permission, not engineering clearances. Findings never edit either project.</p>
        </Disclosure>
      </Section>
      {lastRun && groups.length === 0 && <EmptyState icon={ShieldCheck} title="No findings to show">Nothing within the screening radius in the available data.</EmptyState>}
      {groups.map(g => (
        <Section key={g.cls} title={g.label} aside={`${g.items.length}`}>
          <ul className="space-y-1.5" data-testid={`conflicts-${g.cls}`}>
            {g.items.map(i => <IssueRow key={i.id} i={i} b={b} who={who} act={act} />)}
          </ul>
        </Section>
      ))}
      {b.issues.length > 0 && (
        <a className="inline-block" href={planningClient.conflictCsvUrl(b.project.id, who)} data-testid="export-conflicts-csv"><Button size="sm" icon={FileDown}>Conflict summary CSV</Button></a>
      )}
    </>
  );
};

const IssueRow: React.FC<{ i: ProjectIssue; b: ProjectBundle; who: string; act: Act }> = ({ i, b, who, act }) => {
  const [note, setNote] = useState('');
  const [open, setOpen] = useState(false);
  const pid = b.project.id;
  const ours = i.raised_by_project === pid ? i.element_a_id : i.b_type === 'project_element' ? i.b_ref : null;
  const ourEl = b.elements.find(e => e.id === ours);
  const shared = i.other_project ? (b.projectNames[i.other_project] ?? i.other_project) : null;
  const fly = async () => {
    if (ourEl && flyToGeometry(ourEl.geometry)) return;
    try { const e = await coordinationApi.getElement(i.element_a_id); flyToGeometry(e.geometry); } catch { /* geometry unavailable */ }
  };
  const setStatus = (s: ConflictStatus) => act(async () => { await coordinationApi.setConflictStatus(i.id, s, who, note.trim()); setNote(''); setOpen(false); });
  return (
    <li className="rounded-lg bg-white/[0.04] border border-white/5 px-2.5 py-2 text-sm space-y-1" data-testid="conflict-row" data-class={i.class} data-status={i.status}>
      <div className="flex items-start gap-2">
        <button type="button" onClick={() => void fly()} className="flex-1 min-w-0 text-left cursor-pointer" title="Fly to location">
          <div className="truncate text-slate-100">{ourEl?.name ?? ours ?? i.element_a_id} <span className="text-slate-500">↔</span> {otherSideLabel(i, b.projectNames, pid)}</div>
          <div className={`text-xs ${CLASS_TONE[i.class] ?? ''}`}>{i.class_label} · horizontal {m(i.horizontal_distance_m)} · vertical gap {m(i.vertical_gap_m)}</div>
        </button>
        <CertaintyBadge certainty={i.certainty} compact />
        <button aria-label="Fly to location" title="Fly to location" className="p-1 rounded text-slate-400 hover:text-white cursor-pointer" onClick={() => void fly()}><Crosshair size={14} /></button>
      </div>
      {otherSideEvidence(i) && <div className="text-xs text-slate-400" data-testid="conflict-evidence">{otherSideEvidence(i)}</div>}
      {shared && <div className="text-xs text-violet-200 flex items-start gap-1" data-testid="conflict-shared"><Share2 size={11} aria-hidden className="mt-0.5 shrink-0" />Shared with project “{shared}” — they see the same finding; nothing in their project is changed.</div>}
      {i.permission_triggers.length > 0 && <div className="text-xs text-amber-200">{i.permission_triggers.map(t => `${t.label}: ${t.distance_m.toFixed(1)} m ≤ ${t.threshold_m} m (permission trigger, not an engineering clearance)`).join(' · ')}</div>}
      <div className="flex items-center gap-2 text-xs">
        <span className={i.status === 'open' ? 'text-amber-200' : 'text-slate-300'} data-testid="conflict-status">{STATUS_TEXT[i.status]}</span>
        {i.status_by && <span className="text-slate-500 truncate">by {i.status_by}{i.status_note ? ` — “${i.status_note}”` : ''}</span>}
        {i.run_stale?.stale && <StaleBadge verdict={i.run_stale} />}
        {ACTIONABLE.has(i.class) && <button type="button" className="ml-auto uos-link" data-testid="conflict-respond" disabled={!who} onClick={() => setOpen(o => !o)}>{open ? 'Cancel' : 'Respond'}</button>}
      </div>
      {open && (
        <div className="space-y-1.5 pt-1">
          <input aria-label="Response note" data-testid="conflict-note" className={inputCls} value={note} onChange={e => setNote(e.target.value)} placeholder="Note (required), e.g. depth survey requested" />
          <div className="flex gap-1.5">
            {i.status !== 'acknowledged' && <Button size="sm" data-testid="conflict-ack" disabled={!note.trim()} onClick={() => void setStatus('acknowledged')}>Acknowledge</Button>}
            {i.status !== 'resolved' && <Button size="sm" data-testid="conflict-resolve" disabled={!note.trim()} onClick={() => void setStatus('resolved')}>Resolve</Button>}
            {i.status !== 'open' && <Button size="sm" variant="ghost" disabled={!note.trim()} onClick={() => void setStatus('open')}>Reopen</Button>}
          </div>
          <p className="text-xs text-slate-500">A response records a person's note; it does not change the finding, either project, or any approval.</p>
        </div>
      )}
      <Disclosure>
        <ul className="text-xs text-slate-400 space-y-0.5">
          {i.reasons.map((r, k) => <li key={k}>{r}</li>)}
          <li>Finding {i.id} · run {i.run_id} · side B: {sideBLabel(i)} (ref {i.b_ref})</li>
        </ul>
      </Disclosure>
    </li>
  );
};


import React, { useEffect, useMemo, useState } from 'react';
import { ClipboardCheck, Database, FileSearch, History, ShieldAlert } from 'lucide-react';
import { Section, Button, Notice } from '../ui/kit';
import { Disclosure } from '../ui/Disclosure';
import { EmptyState } from '../ui/EmptyState';
import { TrustBadge } from '../ui/badges';
import { planningApi, LINK_TYPE_LABEL, type AuditEvent, type Project, type Linkable } from '../../engine/planning/planningApi';
import { coordinationApi, type SubsurfaceDataset } from '../../lib/coordinationApi';
import { listDocuments, listReviews, documentUrl, REVIEW_STATUS_LABEL, type DocumentRecord, type ReviewRecord } from '../../engine/feasibility/feasibilityApi';
import { planningClient, type TrafficDatasetInfo } from '../../lib/planningClient';
import { StaleBadge } from './common';
import { inputCls, when, ACTION_LABEL, ENTITY_LABEL, type Act, type ProjectBundle } from './projectData';

const RUN_KIND: Record<string, string> = { simulation: 'Simulation run', odme: 'ODME run', emissions: 'Emissions run' };

// ── Assessments ─────────────────────────────────────────────────────────────────────────────────────────────────
export const AssessmentsTab: React.FC<{ b: ProjectBundle }> = ({ b }) => {
  const st = b.stale;
  const [docs, setDocs] = useState<Record<string, DocumentRecord[]>>({});
  const assessIds = useMemo(() => (st?.assessments ?? []).map(a => a.id), [st]);
  useEffect(() => {
    assessIds.forEach(id => listDocuments(id).then(d => setDocs(m => ({ ...m, [id]: d }))).catch(() => setDocs(m => ({ ...m, [id]: [] }))));
  }, [assessIds]);
  if (!st) return <Notice tone="warn">Stale indicators could not be loaded.</Notice>;
  const empty = !st.assessments.length && !st.runs.length && !st.coordination_runs.length;
  return (
    <>
      {empty && <EmptyState icon={FileSearch} title="No assessments linked">Attach feasibility screenings or simulation runs in Overview → Linked records, or run conflict detection.</EmptyState>}
      {st.assessments.length > 0 && (
        <Section title="Feasibility screenings" aside={`${st.assessments.length}`}>
          <ul className="space-y-1.5">
            {st.assessments.map(a => (
              <li key={a.id} className="rounded-lg bg-white/[0.04] border border-white/5 px-2.5 py-2 text-sm space-y-1" data-testid="assessment-row">
                <div className="flex items-center gap-2"><span className="flex-1 min-w-0 truncate text-slate-100">{a.name || a.id}</span><StaleBadge verdict={a} /></div>
                {(docs[a.id] ?? []).length > 0
                  ? <div className="text-xs">{docs[a.id].map(d => <a key={d.id} className="uos-link mr-2" href={documentUrl(d)}>{d.file_name}</a>)}</div>
                  : <div className="text-xs text-slate-500">No investigation document generated (Reports).</div>}
              </li>
            ))}
          </ul>
        </Section>
      )}
      {st.runs.length > 0 && (
        <Section title="Traffic model runs" aside={`${st.runs.length}`}>
          <ul className="space-y-1.5">
            {st.runs.map(r => (
              <li key={r.id} className="rounded-lg bg-white/[0.04] border border-white/5 px-2.5 py-2 text-sm space-y-1" data-testid="run-row">
                <div className="text-slate-100">{RUN_KIND[r.run_kind ?? ''] ?? (r.run_kind ? `${r.run_kind} run` : 'Run record')} · {r.scenario_id}</div>
                <div className="flex flex-wrap items-center gap-1.5 text-xs text-slate-400">
                  {when(r.created_at)} <TrustBadge trust="fails_validation" testId="run-trust" /> <StaleBadge verdict={r} />
                </div>
              </li>
            ))}
          </ul>
        </Section>
      )}
      {st.coordination_runs.length > 0 && (
        <Section title="Conflict detection runs" aside={`${st.coordination_runs.length}`}>
          <ul className="space-y-1">
            {st.coordination_runs.slice(0, 10).map((c, k) => (
              <li key={c.id} className="flex items-center gap-2 text-sm" data-testid="coord-run-row">
                <span className="flex-1 text-slate-200">{when(c.created_at)}{k === 0 ? ' (latest)' : ''}</span><StaleBadge verdict={c} />
              </li>
            ))}
          </ul>
        </Section>
      )}
      <Disclosure>
        <p className="text-xs text-slate-400">Staleness is computed on read from recorded inputs (alternative versions and edits, base city, other projects, rules, subsurface records, engine version). “Stale: unknown” means the inputs were not recorded, so it cannot be checked — not that it is current. Simulation, ODME and emissions outputs come from a traffic model that fails validation (TAG M3.1).</p>
      </Disclosure>
    </>
  );
};

// ── Datasets ───────────────────────────────────────────────────────────────────────────────────────────────────
export const DatasetsTab: React.FC<{ b: ProjectBundle }> = ({ b }) => {
  const traffic = (b.project.links ?? []).filter(l => l.entity_type === 'dataset');
  const [info, setInfo] = useState<Record<string, TrafficDatasetInfo | null>>({});
  const [sub, setSub] = useState<SubsurfaceDataset[] | null>(null);
  const ids = traffic.map(t => t.entity_id).join(',');
  useEffect(() => {
    ids.split(',').filter(Boolean).forEach(id => planningClient.trafficDataset(id).then(d => setInfo(m => ({ ...m, [id]: d }))).catch(() => setInfo(m => ({ ...m, [id]: null }))));
  }, [ids]);
  useEffect(() => { coordinationApi.listDatasets(b.project.id).then(setSub).catch(() => setSub([])); }, [b.project.id]);
  return (
    <>
      <Section title="Traffic datasets" aside={`${traffic.length}`}>
        {traffic.length === 0 ? <p className="text-sm text-slate-400">None attached (Overview → Linked records). Manage counts in Projects → Data.</p> : (
          <ul className="space-y-1.5">
            {traffic.map(l => {
              const d = info[l.entity_id];
              return (
                <li key={l.id} className="rounded-lg bg-white/[0.04] border border-white/5 px-2.5 py-2 text-sm" data-testid="traffic-dataset-row">
                  <div className="text-slate-100 truncate">{d?.name ?? l.label}</div>
                  {d && <div className="text-xs text-slate-400">{d.kind}{d.synthetic ? ' · SYNTHETIC (not an observation)' : ''} · {d.role} · {d.record_count ?? 'UNKNOWN'} records</div>}
                  {d && <Disclosure summary="Provenance"><div className="text-xs text-slate-400 space-y-0.5">
                    <div>Provider: {d.provider || 'UNKNOWN'} · Method: {d.method || 'UNKNOWN'}</div>
                    <div>Collected: {d.collected_from ?? 'UNKNOWN'} – {d.collected_to ?? 'UNKNOWN'} · {d.period_desc || ''}</div>
                    <div>Entered by {d.entered_by} · {when(d.created_at)}{d.imported_file_name ? ` · file ${d.imported_file_name}` : ''}</div>
                    {d.imported_file_sha256 && <div className="break-all">sha256 {d.imported_file_sha256}</div>}
                  </div></Disclosure>}
                </li>
              );
            })}
          </ul>
        )}
      </Section>
      <Section title="Subsurface datasets" aside={sub ? `${sub.length}` : ''}>
        {sub == null ? null : sub.length === 0 ? <EmptyState icon={Database} title="No subsurface records imported for this project">Utility and borehole coverage is UNKNOWN: absence of records proves nothing.</EmptyState> : (
          <ul className="space-y-1.5">
            {sub.map(d => (
              <li key={d.id} className="rounded-lg bg-white/[0.04] border border-white/5 px-2.5 py-2 text-sm" data-testid="subsurface-dataset-row">
                <div className="text-slate-100 truncate">{d.name}</div>
                <div className="text-xs text-slate-400">{d.record_type} · {d.format.toUpperCase()} · {d.record_count} records · coverage {d.coverage_label}</div>
                <Disclosure summary="Provenance"><div className="text-xs text-slate-400 space-y-0.5">
                  <div>Publisher: {d.publisher || 'UNKNOWN'} · Licence: {d.licence} · Data date: {d.data_date ?? 'UNKNOWN'}</div>
                  <div>Imported by {d.imported_by} · {when(d.imported_at)}</div>
                  {d.file_sha256 && <div className="break-all">sha256 {d.file_sha256}</div>}
                  {d.warnings.map((w, k) => <div key={k} className="text-amber-200">{w}</div>)}
                </div></Disclosure>
              </li>
            ))}
          </ul>
        )}
      </Section>
    </>
  );
};

// ── Reviews & decisions ─────────────────────────────────────────────────────────────────────────────────────────
export const DecisionsTab: React.FC<{ b: ProjectBundle; who: string; act: Act }> = ({ b, who, act }) => {
  const assess = (b.project.links ?? []).filter(l => l.entity_type === 'assessment');
  const [reviews, setReviews] = useState<(ReviewRecord & { assessment: string })[]>([]);
  const ids = assess.map(a => `${a.entity_id}|${a.label}`).join(',');
  useEffect(() => {
    Promise.all(ids.split(',').filter(Boolean).map(s => { const [id, label] = s.split('|'); return listReviews(id).then(r => r.map(x => ({ ...x, assessment: label }))).catch(() => []); }))
      .then(all => setReviews(all.flat()));
  }, [ids]);
  return (
    <>
      <DecisionForm p={b.project} linkable={b.linkable} who={who} act={act} />
      <Section title="Reviews" aside={`${reviews.length}`}>
        {reviews.length === 0 ? <p className="text-sm text-slate-400">No reviews on the attached feasibility screenings.</p> : (
          <ul className="space-y-1">
            {reviews.map(r => (
              <li key={r.id} className="text-sm rounded-lg bg-white/[0.04] border border-white/5 px-2.5 py-1.5" data-testid="review-row">
                <div className="text-slate-100">{r.status_label ?? REVIEW_STATUS_LABEL[r.status]} · {r.reviewer_name}{r.reviewer_role ? ` (${r.reviewer_role})` : ''}</div>
                <div className="text-xs text-slate-400">{r.assessment} · {when(r.created_at)} · Approval: <b>No</b></div>
              </li>
            ))}
          </ul>
        )}
      </Section>
    </>
  );
};

const DecisionForm: React.FC<{ p: Project; linkable: Linkable | null; who: string; act: Act }> = ({ p, linkable, who, act }) => {
  const [text, setText] = useState('');
  const [role, setRole] = useState('');
  const [org, setOrg] = useState('');
  const [vid, setVid] = useState('');
  const [refs, setRefs] = useState<Set<string>>(new Set());
  const scenIds = useMemo(() => new Set((p.links ?? []).filter(l => l.entity_type === 'scenario').map(l => l.entity_id)), [p.links]);
  const versions = (linkable?.scenario_version ?? []).filter(v => v.scenario_id && scenIds.has(v.scenario_id));
  const refOptions = (p.links ?? []).filter(l => l.entity_type === 'assessment' || l.entity_type === 'dataset' || l.entity_type === 'run');
  return (
    <Section title="Decision record">
      <Notice tone="warn" icon={ShieldAlert}>A <b>planning decision recorded in this tool</b> by the named person. Not an engineering assessment, statutory approval, sanction or permit.</Notice>
      {(p.decisions ?? []).map(d => (
        <div key={d.id} data-testid="decision" className="rounded-xl bg-violet-500/10 border border-violet-400/20 px-3 py-2 text-sm">
          <div className="text-xs text-violet-200">#{d.seq} · Planning decision recorded in tool — not a statutory approval</div>
          <div className="text-slate-100 mt-1 whitespace-pre-wrap">{d.decision_text}</div>
          <div className="text-xs text-slate-400 mt-1">{d.decided_by}{d.role ? ` (${d.role})` : ''}{d.organisation ? `, ${d.organisation}` : ''} · {when(d.created_at)}{d.scenario_version_id ? ` · version ${d.scenario_version_id}` : ''}{d.evidence_refs.length ? ` · ${d.evidence_refs.length} evidence ref(s)` : ''}</div>
          <div className="text-xs mt-1" data-testid="decision-statutory">Statutory approval: <b className="text-slate-100">{d.is_statutory_approval ? 'Yes' : 'No'}</b></div>
        </div>
      ))}
      <textarea aria-label="Decision" data-testid="decision-text" rows={2} className={inputCls} value={text} onChange={e => setText(e.target.value)} placeholder="e.g. Proceed to the investigations listed for Option A" />
      <div className="grid grid-cols-2 gap-2">
        <input aria-label="Role" className={inputCls} value={role} onChange={e => setRole(e.target.value)} placeholder="Role" />
        <input aria-label="Organisation" className={inputCls} value={org} onChange={e => setOrg(e.target.value)} placeholder="Organisation" />
      </div>
      <select aria-label="Scenario version" data-testid="decision-version" className={inputCls} value={vid} onChange={e => setVid(e.target.value)}>
        <option value="">Scenario version: none</option>
        {versions.map(v => <option key={v.id} value={v.id}>{v.label} ({v.scenario_id})</option>)}
      </select>
      {refOptions.length > 0 && (
        <div className="space-y-1">
          <div className="text-xs text-slate-400">Evidence relied on</div>
          {refOptions.map(l => (
            <label key={l.id} className="flex items-center gap-2 text-sm text-slate-200">
              <input type="checkbox" checked={refs.has(`${l.entity_type}:${l.entity_id}`)} onChange={e => {
                const n = new Set(refs); const k = `${l.entity_type}:${l.entity_id}`; if (e.target.checked) n.add(k); else n.delete(k); setRefs(n);
              }} />
              <span className="truncate">{LINK_TYPE_LABEL[l.entity_type]}: {l.label}</span>
            </label>
          ))}
        </div>
      )}
      <Button size="sm" icon={ClipboardCheck} data-testid="record-decision" disabled={!text.trim() || !who}
        onClick={() => act(async () => {
          await planningApi.decide(p.id, { decision_text: text, decided_by: who, role, organisation: org, scenario_version_id: vid || null,
            evidence_refs: [...refs].map(k => { const [type, ...rest] = k.split(':'); return { type, id: rest.join(':') }; }) });
          setText(''); setRefs(new Set());
        })}>Record decision</Button>
    </Section>
  );
};

// ── Activity ────────────────────────────────────────────────────────────────────────────────────────────────────
export const ActivityTab: React.FC<{ events: AuditEvent[] }> = ({ events }) => (
  <Section title="Audit timeline" aside={`${events.length} event${events.length === 1 ? '' : 's'}`}>
    <p className="text-xs text-slate-500">Append-only. Names are self-declared.</p>
    <ol className="space-y-1" data-testid="audit-timeline">
      {events.slice(0, 150).map(e => (
        <li key={e.id} data-entity={e.entity_type} data-action={e.action} className="flex gap-2 text-xs border-l-2 border-white/10 pl-2 py-0.5">
          <History size={12} className="mt-0.5 text-slate-500 shrink-0" />
          <div className="min-w-0">
            <div className="text-slate-200"><b>{ENTITY_LABEL[e.entity_type] ?? e.entity_type}</b> {ACTION_LABEL[e.action] ?? e.action}{e.label ? ` — ${e.label}` : ''}{e.changed_fields ? ` (${e.changed_fields.join(', ')})` : ''}</div>
            <div className="text-slate-500">{when(e.at)} · {e.actor}{e.actor_source === 'none' ? '' : ` [${e.actor_source.replace('_', ' ')}]`}</div>
          </div>
        </li>
      ))}
    </ol>
  </Section>
);

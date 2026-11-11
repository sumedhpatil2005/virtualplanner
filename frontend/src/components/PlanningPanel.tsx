import React, { useCallback, useEffect, useMemo, useState } from 'react';
import { ClipboardCheck, FileDown, FolderPlus, History, Link2, Loader2, Plus, ShieldAlert, Trash2 } from 'lucide-react';
import { SidePanel, PanelHeader, PanelBody, Section, Button, Notice, Facts, Segmented } from './ui/kit';
import { apiGet } from '../lib/api';
import {
  planningApi, LINK_TYPE_LABEL, STATUS_LABEL,
  type AuditEvent, type Linkable, type LinkType, type Project, type ProjectStatus,
} from '../engine/planning/planningApi';

/**
 * Planning & Approval Workspace (docs/PLANNING_WORKSPACE.md): planning projects that reference existing scenarios,
 * traffic datasets and feasibility assessments; the audit timeline; a decision record that is explicitly NOT an
 * approval; report export (PDF/DOCX).
 */

const inputCls = 'w-full rounded-lg bg-white/[0.05] border border-white/10 px-2 py-1.5 text-sm text-white placeholder:text-slate-500 focus:outline-none focus:border-cyan-400/60';
const labelCls = 'block text-xs text-slate-400 mb-1';
const when = (iso: string | null | undefined) => (iso ? new Date(iso).toLocaleString(undefined, { dateStyle: 'medium', timeStyle: 'short' }) : '–');
const STATUS_STYLE: Record<ProjectStatus, string> = {
  draft: 'bg-slate-500/20 text-slate-200 border-slate-400/30',
  under_study: 'bg-sky-500/15 text-sky-300 border-sky-400/30',
  under_review: 'bg-amber-500/15 text-amber-300 border-amber-400/30',
  decision_recorded: 'bg-violet-500/15 text-violet-200 border-violet-400/30',
};
const StatusBadge: React.FC<{ status: ProjectStatus }> = ({ status }) => (
  <span data-testid="project-status" title={status === 'decision_recorded' ? 'A decision was recorded in this tool. This is not a statutory approval.' : undefined}
    className={`inline-flex items-center rounded-md border px-1.5 py-px text-[10px] font-semibold uppercase tracking-wide ${STATUS_STYLE[status]}`}>{STATUS_LABEL[status]}</span>
);
const ACTION_LABEL: Record<string, string> = { create: 'created', update: 'changed', delete: 'deleted', export: 'exported' };
const ENTITY_LABEL: Record<string, string> = {
  project: 'Project', project_link: 'Attachment', decision: 'Decision', project_report: 'Report', scenario: 'Scenario', scenario_change: 'Scenario edit',
  scenario_version: 'Scenario version', run: 'Simulation run', dataset: 'Traffic dataset', count_record: 'Count record', assessment: 'Feasibility assessment',
  evidence: 'Evidence', review: 'Review', document: 'Investigation document', pcu_set: 'PCU set', vehicle_class: 'Vehicle class',
};

export const PlanningPanel: React.FC<{ onClose: () => void }> = ({ onClose }) => {
  const [projects, setProjects] = useState<Project[] | null>(null);
  const [openId, setOpenId] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [user, setUserState] = useState(() => localStorage.getItem('td-user') ?? '');
  const setUser = (v: string) => { setUserState(v); localStorage.setItem('td-user', v); };

  const reload = useCallback(async () => {
    try { setProjects(await planningApi.projects()); setError(null); } catch (e) { setError(String((e as Error).message ?? e)); }
  }, []);
  useEffect(() => { void reload(); }, [reload]);

  return (
    <SidePanel label="Planning projects" wide>
      {openId
        ? <ProjectView id={openId} user={user} onBack={() => { setOpenId(null); void reload(); }} onClose={onClose} />
        : (
          <>
            <PanelHeader title="Planning projects" subtitle="Scenarios, traffic data and feasibility screening for one planning question" onClose={onClose} />
            <PanelBody>
              {error && <Notice tone="bad">{error}</Notice>}
              <div>
                <label className={labelCls} htmlFor="pl-user">Your name (recorded in the audit log; not verified)</label>
                <input id="pl-user" data-testid="planning-user" className={inputCls} value={user} onChange={e => setUser(e.target.value)} placeholder="e.g. A. Planner" />
              </div>
              <NewProject user={user} onCreated={p => { void reload(); setOpenId(p.id); }} />
              <Section title="Projects" aside={projects ? `${projects.length}` : undefined}>
                {!projects ? <Notice icon={Loader2} spin>Loading…</Notice>
                  : projects.length === 0 ? <p className="text-sm text-slate-400">No planning project yet.</p>
                  : (
                    <ul className="space-y-1.5">
                      {projects.map(p => (
                        <li key={p.id}>
                          <button data-testid="open-project" onClick={() => setOpenId(p.id)} className="w-full text-left rounded-xl bg-white/[0.04] border border-white/5 hover:border-white/20 px-3 py-2 cursor-pointer transition">
                            <div className="flex items-center justify-between gap-2"><span className="text-sm font-semibold text-white truncate">{p.name}</span><StatusBadge status={p.status} /></div>
                            <div className="text-xs text-slate-400 mt-0.5">{p.link_count} attached · by {p.created_by} · {when(p.created_at)}</div>
                          </button>
                        </li>
                      ))}
                    </ul>
                  )}
              </Section>
            </PanelBody>
          </>
        )}
    </SidePanel>
  );
};

const NewProject: React.FC<{ user: string; onCreated: (p: Project) => void }> = ({ user, onCreated }) => {
  const [open, setOpen] = useState(false);
  const [name, setName] = useState('');
  const [desc, setDesc] = useState('');
  const [areaId, setAreaId] = useState('');
  const [areas, setAreas] = useState<{ id: string; name: string }[]>([]);
  const [busy, setBusy] = useState(false);
  const [err, setErr] = useState<string | null>(null);
  useEffect(() => {
    if (open && !areas.length) apiGet<{ id: string; name: string }[]>('/api/areas').then(a => setAreas(a.map(x => ({ id: x.id, name: x.name })))).catch(() => {});
  }, [open, areas.length]);
  if (!open) return <Button icon={FolderPlus} variant="primary" data-testid="new-project" onClick={() => setOpen(true)}>New planning project</Button>;
  const create = async () => {
    setBusy(true); setErr(null);
    try { onCreated(await planningApi.create({ name, description: desc, area_id: areaId || null, created_by: user.trim() })); setOpen(false); setName(''); setDesc(''); }
    catch (e) { setErr((e as Error).message); } finally { setBusy(false); }
  };
  return (
    <Section title="New planning project">
      <div><label className={labelCls} htmlFor="pl-name">Name</label><input id="pl-name" data-testid="project-name" className={inputCls} value={name} onChange={e => setName(e.target.value)} /></div>
      <div><label className={labelCls} htmlFor="pl-desc">Planning question / description</label><textarea id="pl-desc" data-testid="project-desc" rows={2} className={inputCls} value={desc} onChange={e => setDesc(e.target.value)} /></div>
      <div>
        <label className={labelCls} htmlFor="pl-area">Study area (optional)</label>
        <select id="pl-area" className={inputCls} value={areaId} onChange={e => setAreaId(e.target.value)}>
          <option value="">— none —</option>
          {areas.map(a => <option key={a.id} value={a.id}>{a.name}</option>)}
        </select>
      </div>
      <p className="text-xs text-slate-500">The project records the current baseline network's fingerprint, so a later baseline edit is flagged.</p>
      {err && <Notice tone="bad">{err}</Notice>}
      <div className="flex gap-2">
        <Button variant="primary" icon={busy ? Loader2 : Plus} spin={busy} disabled={busy || !name.trim() || !user.trim()} data-testid="create-project" onClick={create}>Create</Button>
        <Button variant="ghost" onClick={() => setOpen(false)}>Cancel</Button>
      </div>
      {!user.trim() && <p className="text-xs text-amber-300">Enter your name above first.</p>}
    </Section>
  );
};

const ProjectView: React.FC<{ id: string; user: string; onBack: () => void; onClose: () => void }> = ({ id, user, onBack, onClose }) => {
  const [p, setP] = useState<Project | null>(null);
  const [events, setEvents] = useState<AuditEvent[]>([]);
  const [linkable, setLinkable] = useState<Linkable | null>(null);
  const [err, setErr] = useState<string | null>(null);
  const reload = useCallback(async () => {
    try {
      const [pp, ev, lk] = await Promise.all([planningApi.project(id), planningApi.audit(id), planningApi.linkable()]);
      setP(pp); setEvents(ev); setLinkable(lk); setErr(null);
    } catch (e) { setErr((e as Error).message); }
  }, [id]);
  useEffect(() => { void reload(); }, [reload]);
  const act = async (f: () => Promise<unknown>) => { setErr(null); try { await f(); } catch (e) { setErr((e as Error).message); } await reload(); };

  if (!p) return (<><PanelHeader title="Planning project" onBack={onBack} onClose={onClose} /><PanelBody>{err ? <Notice tone="bad">{err}</Notice> : <Notice icon={Loader2} spin>Loading…</Notice>}</PanelBody></>);
  const who = user.trim();
  return (
    <>
      <PanelHeader title={p.name} subtitle={<StatusBadge status={p.status} />} onBack={onBack} backLabel="All projects" onClose={onClose} />
      <PanelBody>
        {err && <Notice tone="bad">{err}</Notice>}
        {!who && <Notice tone="warn">Enter your name on the project list; it is recorded with every change.</Notice>}
        {p.description && <p className="text-sm text-slate-300">{p.description}</p>}
        <Facts rows={[
          ['Created', `${p.created_by}, ${when(p.created_at)}`],
          ['Study area', p.area ? p.area.name : p.bbox ? 'bounding box' : 'not set'],
          ['Baseline', <span key="b" title={`${p.baseline_fingerprint}`}>{p.baseline_changed_since_created ? <span className="text-amber-300">changed since project created</span> : 'unchanged since project created'}</span>],
        ]} />
        <Section title="Status">
          {p.status === 'decision_recorded'
            ? <Notice tone="info">A decision is recorded (in this tool). Status can be moved back for further study.</Notice> : null}
          <Segmented label="Project status" value={p.status === 'decision_recorded' ? ('' as ProjectStatus) : p.status}
            options={(['draft', 'under_study', 'under_review'] as const).map(s => ({ value: s, label: STATUS_LABEL[s] }))}
            onChange={s => who && act(() => planningApi.setStatus(id, s as Exclude<ProjectStatus, 'decision_recorded'>, who))} />
        </Section>
        <Attachments p={p} linkable={linkable} who={who} act={act} />
        <DecisionForm p={p} linkable={linkable} who={who} act={act} />
        <Section title="Report">
          <p className="text-xs text-slate-400">Summary, baseline, datasets with provenance labels, scenarios, versions and run inputs, comparison from run records, feasibility findings with certainty labels, documents, reviews, decision, assumptions and unknowns, audit summary.</p>
          <div className="flex gap-2">
            <a data-testid="export-pdf" href={planningApi.reportUrl(id, 'pdf', who)} onClick={() => setTimeout(() => void reload(), 1500)}><Button icon={FileDown} size="sm">PDF</Button></a>
            <a data-testid="export-docx" href={planningApi.reportUrl(id, 'docx', who)} onClick={() => setTimeout(() => void reload(), 1500)}><Button icon={FileDown} size="sm">DOCX</Button></a>
          </div>
        </Section>
        <Timeline events={events} />
      </PanelBody>
    </>
  );
};

const Attachments: React.FC<{ p: Project; linkable: Linkable | null; who: string; act: (f: () => Promise<unknown>) => Promise<void> }> = ({ p, linkable, who, act }) => {
  const [type, setType] = useState<LinkType>('scenario');
  const [eid, setEid] = useState('');
  const linked = new Set((p.links ?? []).map(l => `${l.entity_type}:${l.entity_id}`));
  const options = (linkable?.[type] ?? []).filter(o => !linked.has(`${type}:${o.id}`));
  return (
    <Section title="Attached records" aside={`${p.links?.length ?? 0}`}>
      <p className="text-xs text-slate-500">Attaching references the existing record; nothing is copied.</p>
      <ul className="space-y-1" data-testid="project-links">
        {(p.links ?? []).map(l => (
          <li key={l.id} className="flex items-center gap-2 rounded-lg bg-white/[0.04] border border-white/5 px-2.5 py-1.5 text-sm">
            <span className="text-[10px] uppercase tracking-wide text-slate-400 w-24 shrink-0">{LINK_TYPE_LABEL[l.entity_type]}</span>
            <span className={`flex-1 min-w-0 truncate ${l.exists ? 'text-slate-100' : 'text-rose-300'}`} title={l.entity_id}>{l.label}</span>
            <button aria-label="Detach" title="Detach (the record itself is kept)" disabled={!who} onClick={() => act(() => planningApi.unlink(p.id, l.id, who))}
              className="p-1 rounded text-slate-400 hover:text-rose-300 cursor-pointer disabled:opacity-40"><Trash2 size={14} /></button>
          </li>
        ))}
      </ul>
      <div className="grid grid-cols-[8.5rem_1fr] gap-2">
        <select aria-label="Record type" data-testid="link-type" className={inputCls} value={type} onChange={e => { setType(e.target.value as LinkType); setEid(''); }}>
          {(Object.keys(LINK_TYPE_LABEL) as LinkType[]).map(t => <option key={t} value={t}>{LINK_TYPE_LABEL[t]}</option>)}
        </select>
        <select aria-label="Record" data-testid="link-record" className={inputCls} value={eid} onChange={e => setEid(e.target.value)}>
          <option value="">{options.length ? '— choose —' : '— none available —'}</option>
          {options.map(o => <option key={o.id} value={o.id}>{o.label}{o.kind && type === 'dataset' ? ` [${o.kind}${o.synthetic ? ', synthetic' : ''}]` : ''}</option>)}
        </select>
      </div>
      <Button size="sm" icon={Link2} data-testid="attach" disabled={!eid || !who} onClick={() => act(async () => { await planningApi.link(p.id, type, eid, who); setEid(''); })}>Attach</Button>
    </Section>
  );
};

const DecisionForm: React.FC<{ p: Project; linkable: Linkable | null; who: string; act: (f: () => Promise<unknown>) => Promise<void> }> = ({ p, linkable, who, act }) => {
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
      <Notice tone="warn" icon={ShieldAlert}>A decision recorded here is a <b>planning decision recorded in this tool</b> by the named person. It is not an engineering assessment and not a statutory approval, sanction or permit.</Notice>
      {(p.decisions ?? []).map(d => (
        <div key={d.id} data-testid="decision" className="rounded-xl bg-violet-500/10 border border-violet-400/20 px-3 py-2 text-sm">
          <div className="text-xs text-violet-200">#{d.seq} · Planning decision recorded in tool — not a statutory approval</div>
          <div className="text-slate-100 mt-1 whitespace-pre-wrap">{d.decision_text}</div>
          <div className="text-xs text-slate-400 mt-1">{d.decided_by}{d.role ? ` (${d.role})` : ''}{d.organisation ? `, ${d.organisation}` : ''} · {when(d.created_at)}{d.scenario_version_id ? ` · version ${d.scenario_version_id}` : ''}{d.evidence_refs.length ? ` · ${d.evidence_refs.length} evidence ref(s)` : ''}</div>
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

const Timeline: React.FC<{ events: AuditEvent[] }> = ({ events }) => (
  <Section title="Audit timeline" aside={`${events.length} event${events.length === 1 ? '' : 's'}`}>
    <p className="text-xs text-slate-500">Append-only log of changes to this project and the records attached to it. Names are self-declared.</p>
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

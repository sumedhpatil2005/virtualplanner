import React from 'react';
import { FileDown, Link2, Trash2 } from 'lucide-react';
import { useState } from 'react';
import { Section, Button, Notice, Facts, Segmented } from '../ui/kit';
import { MetricTile } from '../ui/MetricTile';
import { Disclosure } from '../ui/Disclosure';
import { CertaintyBadge, TrustBadge } from '../ui/badges';
import { planningApi, LINK_TYPE_LABEL, STATUS_LABEL, type Linkable, type LinkType, type Project, type ProjectStatus } from '../../engine/planning/planningApi';
import { cardSummary, openActionableCount } from '../../lib/planningProjects';
import { StaleBadge } from './common';
import { inputCls, when, type Act, type ProjectBundle } from './projectData';

export const OverviewTab: React.FC<{ b: ProjectBundle; who: string; act: Act; reload: () => void; goTab: (t: string) => void }> = ({ b, who, act, reload, goTab }) => {
  const p = b.project;
  const sum = cardSummary({ links: p.links, elements: b.elements.length, issues: b.issues, stale: b.stale });
  const unknownDepth = b.elements.filter(e => e.z_min_m == null || e.z_max_m == null).length;
  const lastCoord = b.stale?.coordination_runs[0] ?? null;
  const trafficRuns = b.stale?.runs.length ?? 0;
  const preferred = (p.links ?? []).find(l => l.entity_type === 'scenario' && l.entity_id === p.preferred_scenario_id);
  return (
    <>
      {p.description ? <p className="text-sm text-slate-200" data-testid="project-purpose">{p.description}</p>
        : <p className="text-sm text-slate-500">No purpose recorded.</p>}
      <div className="grid grid-cols-2 gap-2" data-testid="project-metrics">
        <button type="button" className="text-left" onClick={() => goTab('alternatives')} title="Open Alternatives">
          <MetricTile label="Alternatives" value={sum.alternatives} hint={preferred ? `★ ${preferred.label}` : 'None preferred'} />
        </button>
        <button type="button" className="text-left" onClick={() => goTab('alternatives')} title="Open Alternatives">
          <MetricTile label="Proposal elements" value={sum.elements}
            badge={unknownDepth ? <CertaintyBadge certainty="unknown" note={`${unknownDepth} element(s) with depth or height UNKNOWN`} /> : null}
            hint={unknownDepth ? `${unknownDepth} with depth unknown` : undefined} />
        </button>
        <button type="button" className="text-left" onClick={() => goTab('conflicts')} title="Open Conflicts">
          <MetricTile label="Open conflicts" value={lastCoord ? openActionableCount(b.issues) : null}
            badge={lastCoord ? <StaleBadge verdict={lastCoord} /> : null} hint={lastCoord ? `Detection ${when(lastCoord.created_at)}` : 'Detection not run'} data-testid="metric-open-conflicts" />
        </button>
        <button type="button" className="text-left" onClick={() => goTab('assessments')} title="Open Assessments">
          <MetricTile label="Stale assessments" value={b.stale ? sum.staleAssessments : null}
            hint={sum.unknownStale ? `${sum.unknownStale} cannot be checked` : undefined}
            badge={trafficRuns ? <TrustBadge trust="fails_validation" testId="overview-traffic-trust" /> : null} />
        </button>
      </div>
      <Facts rows={[
        ['Created', `${p.created_by}, ${when(p.created_at)}`],
        ['Study area', p.area ? p.area.name : p.bbox ? 'bounding box' : 'not set'],
        ['Baseline', <span key="b" title={p.baseline_fingerprint}>{p.baseline_changed_since_created ? <span className="text-amber-300">changed since project created</span> : 'unchanged since project created'}</span>],
      ]} />
      <Section title="Status">
        {p.status === 'decision_recorded' ? <Notice tone="info">A decision is recorded (in this tool). Status can be moved back for further study.</Notice> : null}
        <Segmented label="Project status" value={p.status === 'decision_recorded' ? ('' as ProjectStatus) : p.status}
          options={(['draft', 'under_study', 'under_review'] as const).map(s => ({ value: s, label: STATUS_LABEL[s] }))}
          onChange={s => who && act(() => planningApi.setStatus(p.id, s as Exclude<ProjectStatus, 'decision_recorded'>, who))} />
      </Section>
      <Section title="Report">
        <div className="flex gap-2">
          <a data-testid="export-pdf" href={planningApi.reportUrl(p.id, 'pdf', who)} onClick={() => setTimeout(reload, 1500)}><Button icon={FileDown} size="sm">PDF</Button></a>
          <a data-testid="export-docx" href={planningApi.reportUrl(p.id, 'docx', who)} onClick={() => setTimeout(reload, 1500)}><Button icon={FileDown} size="sm">DOCX</Button></a>
        </div>
        <Disclosure summary="What the report contains">
          <p className="text-xs text-slate-400">Summary, baseline, datasets with provenance labels, scenarios, versions and run inputs, comparison from run records, feasibility findings with certainty labels, documents, reviews, decision, assumptions and unknowns, audit summary. Every export is recorded in Activity.</p>
        </Disclosure>
      </Section>
      <Attachments p={p} linkable={b.linkable} who={who} act={act} />
    </>
  );
};

/** All linked records (any type) — the original attach control, kept so every link type stays reachable. */
const Attachments: React.FC<{ p: Project; linkable: Linkable | null; who: string; act: Act }> = ({ p, linkable, who, act }) => {
  const [type, setType] = useState<LinkType>('scenario');
  const [eid, setEid] = useState('');
  const linked = new Set((p.links ?? []).map(l => `${l.entity_type}:${l.entity_id}`));
  const options = (linkable?.[type] ?? []).filter(o => !linked.has(`${type}:${o.id}`));
  return (
    <Section title="Linked records" aside={`${p.links?.length ?? 0}`}>
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
      <p className="text-xs text-slate-500">Attaching references the existing record; nothing is copied.</p>
    </Section>
  );
};

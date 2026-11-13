import React, { useCallback, useEffect, useState } from 'react';
import { FileDown, FileText, Loader2, RefreshCw } from 'lucide-react';
import { API_BASE } from '../../lib/api';
import { planningApi, STATUS_LABEL, type Project } from '../../engine/planning/planningApi';
import { documentUrl, generateDocument, listDocuments, type DocumentRecord, type StoredAssessment } from '../../engine/feasibility/feasibilityApi';
import { coordinationApi, type StaleVerdict } from '../../lib/coordinationApi';
import { planningClient } from '../../lib/planningClient';
import { lastExport, type ReportScopeInfo } from '../../lib/planningReports';
import { PanelSection } from '../../components/ui/Panel';
import { Disclosure } from '../../components/ui/Disclosure';
import { EmptyState } from '../../components/ui/EmptyState';
import { TrustBadge } from '../../components/ui/badges';
import { StaleBadge } from '../../components/projects/common';
import { formatWhen } from '../../lib/formatWhen';
import { useShellStore } from '../useShellStore';
import { DataCatalogueSection } from '../../components/data/DataCatalogueSection';

const who = () => localStorage.getItem('td-user') ?? '';
const when = (iso: string | null | undefined) => formatWhen(iso, 'never');

/**
 * Reports: a catalogue of the report endpoints that exist, each with scope, inputs, validation status and last generated.
 *  - GET  /api/planning/projects/{id}/report?format=pdf|docx            planning project report (audited export)
 *  - GET  /api/coordination/projects/{id}/conflicts/export?format=csv   conflict summary (audited export)
 *  - POST /api/feasibility/assessments/{id}/documents {format}          Investigation Requirements Document
 *  - GET  /api/feasibility/documents/{id}/download                      a generated document
 * engine/report/scenarioReport.ts (scenario CSV/HTML) has no run wired to it, so it is listed without a button.
 */
export const ReportsContext: React.FC = () => {
  const [projects, setProjects] = useState<Project[] | null>(null);
  const [scope, setScope] = useState<Record<string, ReportScopeInfo>>({});
  const [assessments, setAssessments] = useState<StoredAssessment[] | null>(null);
  const [aStale, setAStale] = useState<Record<string, StaleVerdict | null>>({});
  const [error, setError] = useState<string | null>(null);
  const [docs, setDocs] = useState<Record<string, DocumentRecord[]>>({});
  const [busy, setBusy] = useState<string | null>(null);
  const setWorkspace = useShellStore(s => s.setWorkspace);
  const openProject = useShellStore(s => s.openProject);

  const loadScope = useCallback((ps: Project[]) => {
    ps.forEach(p => {
      Promise.all([
        planningApi.project(p.id),
        planningApi.audit(p.id).catch(() => []),
        coordinationApi.projectStale(p.id).catch(() => null),
        coordinationApi.projectIssues(p.id).then(r => r.issues.length).catch(() => null),
      ]).then(([full, events, stale, issues]) => {
        const links = full.links ?? [];
        setScope(m => ({ ...m, [p.id]: {
          alternatives: links.filter(l => l.entity_type === 'scenario').length,
          datasets: links.filter(l => l.entity_type === 'dataset').length,
          assessments: links.filter(l => l.entity_type === 'assessment').length,
          runs: stale?.runs.length ?? 0, decisions: full.decisions?.length ?? 0, issues,
          lastDetection: stale?.coordination_runs[0] ?? null,
          lastPdf: lastExport(events, 'PDF report'), lastDocx: lastExport(events, 'DOCX report'), lastCsv: lastExport(events, 'CSV conflict summary'),
        } }));
      }).catch(() => { /* card shows without scope */ });
    });
  }, []);

  const load = useCallback(() => {
    setError(null);
    planningApi.projects().then(ps => { setProjects(ps); loadScope(ps); }).catch((e: Error) => { setProjects([]); setError(e.message); });
    fetch(`${API_BASE}/api/feasibility/assessments`)
      .then(r => (r.ok ? r.json() : Promise.reject(new Error(`${r.status} ${r.statusText}`))))
      .then((a: StoredAssessment[]) => {
        setAssessments(a);
        a.forEach(x => {
          listDocuments(x.id).then(d => setDocs(m => ({ ...m, [x.id]: d }))).catch(() => setDocs(m => ({ ...m, [x.id]: [] })));
          coordinationApi.stale('assessment', x.id).then(v => setAStale(m => ({ ...m, [x.id]: v }))).catch(() => setAStale(m => ({ ...m, [x.id]: null })));
        });
      })
      .catch((e: Error) => { setAssessments([]); setError(e.message); });
  }, [loadScope]);
  useEffect(load, [load]);
  const refreshSoon = (ps: Project[] | null) => setTimeout(() => ps && loadScope(ps), 1500);

  const generate = async (id: string, format: 'pdf' | 'docx') => {
    setBusy(`${id}:${format}`);
    try {
      await generateDocument(id, format, { generated_by: who() || 'anonymous' });
      const d = await listDocuments(id);
      setDocs(m => ({ ...m, [id]: d }));
      (window as any).showToast?.(`${format.toUpperCase()} generated`, 'success');
    } catch (e) {
      (window as any).showToast?.(`Could not generate: ${(e as Error).message}`, 'error');
    } finally { setBusy(null); }
  };

  return (
    <div className="space-y-5" data-testid="reports-catalogue">
      {error && <p className="text-label text-warn" role="status">Some reports could not be listed ({error}).</p>}
      <DataCatalogueSection />
      <PanelSection title="Planning project reports" aside={<button type="button" onClick={load} className="uos-link inline-flex items-center gap-1" aria-label="Reload reports"><RefreshCw size={12} aria-hidden />Reload</button>}>
        {projects == null ? <p className="text-label text-text-2 flex items-center gap-2"><Loader2 size={14} className="animate-spin" aria-hidden />Loading…</p>
          : projects.length === 0 ? <EmptyState icon={FileText} title="No planning projects yet" action={{ label: 'Create one in Projects', onClick: () => setWorkspace('projects') }} />
          : (
            <ul className="space-y-2">
              {projects.map(p => {
                const s = scope[p.id];
                return (
                  <li key={p.id} className="uos-card space-y-1.5" data-testid={`report-card-${p.id}`}>
                    <button type="button" className="min-w-0 w-full text-left" onClick={() => { setWorkspace('projects'); openProject(p.id); }} title="Open the project">
                      <span className="block text-body text-text-1 break-words">{p.name}</span>
                      <span className="block text-meta text-text-2">{STATUS_LABEL[p.status] ?? p.status}</span>
                    </button>
                    {s && <div className="text-meta text-text-2 tabular-nums" data-testid="report-inputs">Inputs: {s.alternatives} alternatives · {s.datasets} datasets · {s.assessments} screenings · {s.runs} runs · {s.decisions} decisions</div>}
                    {s && s.runs > 0 && <div className="flex items-center gap-1.5 text-meta text-text-2">Traffic figures: <TrustBadge trust="fails_validation" testId="report-trust" /></div>}
                    <div className="flex flex-wrap items-center gap-1.5">
                      <a className="uos-btn uos-btn-sm" href={planningApi.reportUrl(p.id, 'pdf', who())} onClick={() => refreshSoon(projects)} data-testid={`report-project-pdf-${p.id}`}><FileDown size={14} aria-hidden />PDF</a>
                      <a className="uos-btn uos-btn-sm" href={planningApi.reportUrl(p.id, 'docx', who())} onClick={() => refreshSoon(projects)} data-testid={`report-project-docx-${p.id}`}><FileDown size={14} aria-hidden />DOCX</a>
                      {s && <span className="text-meta text-text-3" data-testid="report-last-generated">Last: PDF {when(s.lastPdf)} · DOCX {when(s.lastDocx)}</span>}
                    </div>
                    {s && (s.issues ?? 0) > 0 && (
                      <div className="flex flex-wrap items-center gap-1.5 border-t border-[var(--border)] pt-1.5">
                        <a className="uos-btn uos-btn-sm" href={planningClient.conflictCsvUrl(p.id, who())} onClick={() => refreshSoon(projects)} data-testid={`report-conflicts-csv-${p.id}`}><FileDown size={14} aria-hidden />Conflict summary CSV</a>
                        {s.lastDetection && <StaleBadge verdict={s.lastDetection} />}
                        <span className="text-meta text-text-3">Last: {when(s.lastCsv)}</span>
                      </div>
                    )}
                  </li>
                );
              })}
            </ul>
          )}
        <Disclosure summary="What these contain">
          <p className="text-label text-text-2">Project report: summary, baseline, datasets with provenance, alternatives and versions, run comparison, feasibility findings with certainty, reviews, decision (never a statutory approval), unknowns, audit. Conflict summary: every finding visible to the project with class, distances (empty = UNKNOWN), certainty, permission triggers, response status and stale verdict. Every export is recorded in the project's Activity.</p>
        </Disclosure>
      </PanelSection>

      <PanelSection title="Investigation Requirements Documents">
        {assessments == null ? <p className="text-label text-text-2 flex items-center gap-2"><Loader2 size={14} className="animate-spin" aria-hidden />Loading…</p>
          : assessments.length === 0 ? <p className="text-label text-text-2">No saved feasibility screenings. Screen a road or flyover in Design (select it → Feasibility) first.</p>
          : (
            <ul className="space-y-2">
              {assessments.map(a => {
                const d = docs[a.id];
                const last = d && d.length ? d.map(x => x.generated_at).sort().at(-1) : null;
                return (
                  <li key={a.id} className="uos-card space-y-1.5">
                    <div className="flex items-center gap-2"><span className="flex-1 min-w-0 truncate text-body text-text-1">{a.name || a.proposal_type}</span>{a.id in aStale && <StaleBadge verdict={aStale[a.id]} />}</div>
                    <div className="text-meta text-text-2">{a.proposal_type} · screened {a.created_at?.slice(0, 10)} · last generated {when(last)}</div>
                    <div className="flex flex-wrap gap-1.5">
                      {(['pdf', 'docx'] as const).map(f => (
                        <button key={f} type="button" className="uos-btn uos-btn-sm" disabled={!!busy} onClick={() => void generate(a.id, f)} data-testid={`report-ird-${f}-${a.id}`}>
                          {busy === `${a.id}:${f}` ? <Loader2 size={14} className="animate-spin" aria-hidden /> : <FileText size={14} aria-hidden />}Generate {f.toUpperCase()}
                        </button>
                      ))}
                    </div>
                    {d && d.length > 0 && <ul className="text-meta space-y-0.5">{d.map(x => <li key={x.id}><a className="uos-link" href={documentUrl(x)}>{x.file_name}</a> · {x.generated_at?.slice(0, 16).replace('T', ' ')}</li>)}</ul>}
                  </li>
                );
              })}
            </ul>
          )}
        <Disclosure summary="What these contain">
          <p className="text-label text-text-2">From a saved feasibility screening: required investigations, constraints, reviews and evidence. A screening, not an engineering assessment. Generated here, the narrative fields are left blank; fill them from the object's Feasibility panel.</p>
        </Disclosure>
      </PanelSection>

      <PanelSection title="Scenario traffic report">
        <p className="text-label text-text-2">Not available: the builder exists in code but no run is connected to it yet. <TrustBadge trust="fails_validation" testId="scenario-report-trust" /></p>
      </PanelSection>
    </div>
  );
};

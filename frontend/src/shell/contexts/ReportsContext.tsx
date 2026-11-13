import React, { useCallback, useEffect, useState } from 'react';
import { FileDown, FileText, Loader2, RefreshCw } from 'lucide-react';
import { API_BASE } from '../../lib/api';
import { planningApi, STATUS_LABEL, type Project } from '../../engine/planning/planningApi';
import { documentUrl, generateDocument, listDocuments, type DocumentRecord, type StoredAssessment } from '../../engine/feasibility/feasibilityApi';
import { PanelSection } from '../../components/ui/Panel';
import { Disclosure } from '../../components/ui/Disclosure';
import { EmptyState } from '../../components/ui/EmptyState';
import { useShellStore } from '../useShellStore';

const who = () => localStorage.getItem('td-user') ?? '';

/**
 * Reports: the report endpoints that exist in the backend, each with a working action.
 *  - GET  /api/planning/projects/{id}/report?format=pdf|docx           (planning project report; audited export)
 *  - POST /api/feasibility/assessments/{id}/documents {format}         (Investigation Requirements Document)
 *  - GET  /api/feasibility/documents/{id}/download                     (download a generated document)
 * engine/report/scenarioReport.ts (scenario CSV/HTML) has no UI entry point yet, so it is listed without a button.
 */
export const ReportsContext: React.FC = () => {
  const [projects, setProjects] = useState<Project[] | null>(null);
  const [assessments, setAssessments] = useState<StoredAssessment[] | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [docs, setDocs] = useState<Record<string, DocumentRecord[]>>({});
  const [busy, setBusy] = useState<string | null>(null);
  const setWorkspace = useShellStore(s => s.setWorkspace);
  const openProject = useShellStore(s => s.openProject);

  const load = useCallback(() => {
    setError(null);
    planningApi.projects().then(setProjects).catch((e: Error) => { setProjects([]); setError(e.message); });
    fetch(`${API_BASE}/api/feasibility/assessments`)
      .then(r => (r.ok ? r.json() : Promise.reject(new Error(`${r.status} ${r.statusText}`))))
      .then((a: StoredAssessment[]) => setAssessments(a))
      .catch((e: Error) => { setAssessments([]); setError(e.message); });
  }, []);
  useEffect(load, [load]);

  const loadDocs = (id: string) => listDocuments(id).then(d => setDocs(m => ({ ...m, [id]: d }))).catch(() => setDocs(m => ({ ...m, [id]: [] })));
  const generate = async (id: string, format: 'pdf' | 'docx') => {
    setBusy(`${id}:${format}`);
    try {
      await generateDocument(id, format, { generated_by: who() || 'anonymous' });
      await loadDocs(id);
      (window as any).showToast?.(`${format.toUpperCase()} generated`, 'success');
    } catch (e) {
      (window as any).showToast?.(`Could not generate: ${(e as Error).message}`, 'error');
    } finally { setBusy(null); }
  };

  return (
    <div className="space-y-5" data-testid="reports-catalogue">
      {error && <p className="text-label text-warn" role="status">Some reports could not be listed ({error}).</p>}
      <PanelSection title="Planning project report" aside={<button type="button" onClick={load} className="uos-link inline-flex items-center gap-1" aria-label="Reload reports"><RefreshCw size={12} aria-hidden />Reload</button>}>
        <p className="text-meta text-text-3">Summary, baseline, datasets with provenance, scenarios and versions, run comparison, feasibility findings with certainty, reviews, decision, unknowns, audit. Each export is recorded in the project’s audit log.</p>
        {projects == null ? <p className="text-label text-text-2 flex items-center gap-2"><Loader2 size={14} className="animate-spin" aria-hidden />Loading…</p>
          : projects.length === 0 ? <EmptyState icon={FileText} title="No planning projects yet" action={{ label: 'Create one in Projects', onClick: () => setWorkspace('projects') }} />
          : (
            <ul className="space-y-1">
              {projects.map(p => (
                <li key={p.id} className="uos-row">
                  <button type="button" className="min-w-0 flex-1 text-left" onClick={() => { setWorkspace('projects'); openProject(p.id); }} title="Open the project">
                    <span className="block text-body text-text-1 truncate">{p.name}</span>
                    <span className="block text-meta text-text-2">{STATUS_LABEL[p.status] ?? p.status}</span>
                  </button>
                  <a className="uos-btn uos-btn-sm" href={planningApi.reportUrl(p.id, 'pdf', who())} data-testid={`report-project-pdf-${p.id}`}><FileDown size={14} aria-hidden />PDF</a>
                  <a className="uos-btn uos-btn-sm" href={planningApi.reportUrl(p.id, 'docx', who())} data-testid={`report-project-docx-${p.id}`}><FileDown size={14} aria-hidden />DOCX</a>
                </li>
              ))}
            </ul>
          )}
      </PanelSection>

      <PanelSection title="Investigation Requirements Document">
        <p className="text-meta text-text-3">From a saved feasibility screening: required investigations, constraints, reviews and evidence. Generated here, the narrative fields (reason, traffic conditions, expected benefits) are left blank; fill them from the Feasibility panel of the object.</p>
        {assessments == null ? <p className="text-label text-text-2 flex items-center gap-2"><Loader2 size={14} className="animate-spin" aria-hidden />Loading…</p>
          : assessments.length === 0 ? <p className="text-label text-text-2">No saved feasibility screenings. Screen a road or flyover in Design (select it → Feasibility) first.</p>
          : (
            <ul className="space-y-2">
              {assessments.map(a => (
                <li key={a.id} className="uos-card space-y-1.5">
                  <div className="text-body text-text-1">{a.name || a.proposal_type}</div>
                  <div className="text-meta text-text-2">{a.proposal_type} · {a.created_at?.slice(0, 10)}</div>
                  <div className="flex flex-wrap gap-1.5">
                    {(['pdf', 'docx'] as const).map(f => (
                      <button key={f} type="button" className="uos-btn uos-btn-sm" disabled={!!busy} onClick={() => void generate(a.id, f)} data-testid={`report-ird-${f}-${a.id}`}>
                        {busy === `${a.id}:${f}` ? <Loader2 size={14} className="animate-spin" aria-hidden /> : <FileText size={14} aria-hidden />}Generate {f.toUpperCase()}
                      </button>
                    ))}
                    {!docs[a.id] && <button type="button" className="uos-btn uos-btn-sm" onClick={() => void loadDocs(a.id)}>Show generated</button>}
                  </div>
                  {docs[a.id] && (docs[a.id].length === 0
                    ? <p className="text-meta text-text-3">None generated yet.</p>
                    : <ul className="text-meta space-y-0.5">{docs[a.id].map(d => <li key={d.id}><a className="uos-link" href={documentUrl(d)}>{d.file_name}</a> · {d.generated_at?.slice(0, 16).replace('T', ' ')}</li>)}</ul>)}
                </li>
              ))}
            </ul>
          )}
      </PanelSection>

      <PanelSection title="Scenario traffic report">
        <p className="text-label text-text-2">The CSV/HTML builder exists in code (engine/report/scenarioReport.ts) but is not connected to a run yet, so there is no export button. Traffic figures in any report fail validation (TAG M3.1).</p>
      </PanelSection>
      <Disclosure>
        <p className="text-label text-text-2">Endpoints: GET /api/planning/projects/&#123;id&#125;/report?format=pdf|docx · POST /api/feasibility/assessments/&#123;id&#125;/documents · GET /api/feasibility/documents/&#123;id&#125;/download.</p>
      </Disclosure>
    </div>
  );
};

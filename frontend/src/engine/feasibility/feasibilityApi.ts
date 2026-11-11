/** Client for /api/feasibility (backend/api/feasibility_router.py). */
import { API_BASE } from '../../lib/api';
import type { FeasibilityAssessment, SiteData } from './types';

export type ReviewStatus = 'not_started' | 'in_review' | 'information_requested' | 'reviewed_not_approval' | 'external_approval_recorded_unverified';
export const REVIEW_STATUS_LABEL: Record<ReviewStatus, string> = {
  not_started: 'Not started',
  in_review: 'In review',
  information_requested: 'Information requested',
  reviewed_not_approval: 'Reviewed — not an approval',
  external_approval_recorded_unverified: 'External approval recorded (unverified)',
};

export interface StoredAssessment { id: string; scenario_id: string; scenario_version: string | null; proposal_object_ids: string[]; proposal_type: string; name: string; created_at: string; created_by: string; assessment?: FeasibilityAssessment }
export interface EvidenceRecord { id: string; investigation_id: string | null; file_name: string; file_sha256: string; size_bytes: number; description: string; provenance: string; uploaded_by: string; uploaded_at: string }
export interface ReviewRecord { id: string; seq: number; item_type: string; item_id: string | null; reviewer_name: string; reviewer_role: string; organisation: string; status: ReviewStatus; status_label: string; is_approval: false; notes: string; evidence_ids: string[]; external_reference: string | null; supersedes: string | null; created_at: string }
export interface DocumentRecord { id: string; format: 'pdf' | 'docx'; file_name: string; file_sha256: string; size_bytes: number; generated_at: string; download_url: string }
export interface DocumentInputs { project_name?: string; location_description?: string; reason?: string; traffic_conditions?: string; simulation_results?: string; expected_benefits?: string; responsible_team?: string; generated_by?: string }

async function call<T>(method: string, path: string, body?: unknown): Promise<T> {
  const res = await fetch(`${API_BASE}/api/feasibility${path}`, { method, headers: body ? { 'Content-Type': 'application/json' } : undefined, body: body ? JSON.stringify(body) : undefined });
  if (!res.ok) {
    let msg = res.statusText;
    try { const j = await res.json(); msg = typeof j.detail === 'string' ? j.detail : JSON.stringify(j.detail); } catch { /* keep statusText */ }
    throw new Error(`${res.status}: ${msg}`);
  }
  return res.json() as Promise<T>;
}

const box = (b: number[]) => b.map(v => v.toFixed(6)).join(',');
export const fetchSiteData = (wide: number[], near: number[]) => call<SiteData>('GET', `/site-data?bbox=${box(wide)}&near_bbox=${box(near)}`);
export const saveAssessment = (a: FeasibilityAssessment, createdBy = 'anonymous') =>
  call<StoredAssessment>('POST', '/assessments', { scenario_id: a.proposal.scenarioId, scenario_version: a.proposal.scenarioVersion ?? null, proposal_object_ids: a.proposal.objectIds, created_by: createdBy, assessment: a });
export const listAssessments = (objectId: string) => call<StoredAssessment[]>('GET', `/assessments?object_id=${encodeURIComponent(objectId)}`);
export const getAssessment = (id: string) => call<StoredAssessment>('GET', `/assessments/${id}`);
export const listReviews = (id: string) => call<{ reviews: ReviewRecord[] }>('GET', `/assessments/${id}/reviews`).then(r => r.reviews);
export const addReview = (id: string, r: { reviewer_name: string; reviewer_role: string; organisation?: string; status: ReviewStatus; notes?: string; evidence_ids?: string[]; external_reference?: string; item_type?: string; item_id?: string | null }) =>
  call<ReviewRecord>('POST', `/assessments/${id}/reviews`, r);
export const listEvidence = (id: string) => call<EvidenceRecord[]>('GET', `/assessments/${id}/evidence`);
export const listDocuments = (id: string) => call<DocumentRecord[]>('GET', `/assessments/${id}/documents`);
export const generateDocument = (id: string, format: 'pdf' | 'docx', inputs: DocumentInputs) => call<DocumentRecord>('POST', `/assessments/${id}/documents`, { format, ...inputs });
export const documentUrl = (d: DocumentRecord) => `${API_BASE}${d.download_url}`;

export async function uploadEvidence(id: string, file: File, meta: { description: string; uploaded_by: string; investigation_id?: string | null; provenance?: string }): Promise<EvidenceRecord> {
  const buf = new Uint8Array(await file.arrayBuffer());
  let bin = '';
  for (let i = 0; i < buf.length; i += 0x8000) bin += String.fromCharCode(...buf.subarray(i, i + 0x8000));
  return call<EvidenceRecord>('POST', `/assessments/${id}/evidence`, {
    file_name: file.name, content_type: file.type || 'application/octet-stream', content_base64: btoa(bin),
    description: meta.description, uploaded_by: meta.uploaded_by, investigation_id: meta.investigation_id || null, provenance: meta.provenance ?? 'unknown',
  });
}

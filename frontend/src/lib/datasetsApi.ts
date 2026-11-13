/**
 * Typed client for /api/datasets (backend/api/datasets_router.py, docs/urbanos/DATA_QUALITY_AND_PROVENANCE.md).
 * Honesty carried by the types: a missing value is null (= UNKNOWN), never 0 or ''. Licence 'UNKNOWN' is a value.
 */
import { API_BASE } from './api';

export type DataClass = 'observed' | 'inferred' | 'estimated' | 'derived' | 'synthetic';
export type Suitability = 'visualisation' | 'screening' | 'engineering';
export type CheckStatus = 'pass' | 'warn' | 'fail' | 'unknown' | 'not_applicable';
export type DatasetStatus = 'available' | 'synthetic' | 'pending_review' | 'not_acquired';
export type FeatureStatus = 'ready' | 'partial' | 'blocked';
export type DepState = 'satisfied' | 'insufficient_quality' | 'quality_fail' | 'unclassified' | 'synthetic_only' | 'pending_review' | 'missing';

export interface QualityCheck { check: string; status: CheckStatus; value: string | null; detail: string; run_at: string | null }
export interface DsSource {
  id: string; name: string; publisher: string; url: string; access_method: string; licence_text: string; licence_url: string;
  robots_notes: string; tos_notes: string; official: boolean; registration_required: boolean; notes: string; origin: string;
}
export interface ProcessingRun {
  id: string; version_id: string; pipeline: string; git_commit: string | null; params: Record<string, unknown>;
  inputs: { path?: string; sha256?: string; version_id?: string }[]; outputs: unknown[]; validation: unknown;
  started_at: string | null; finished_at: string | null; origin_path: string | null;
}
export interface DsFile { id: string; role: string; path: string; sha256: string | null; size_bytes: number | null; format: string | null; url: string | null }
export interface DsVersion {
  id: string; dataset_id: string; version_label: string; review_status: 'active' | 'pending_review' | 'superseded' | 'rejected';
  observation_start: string | null; observation_end: string | null; published_date: string | null; source_updated_date: string | null;
  retrieved_at: string | null; sha256: string | null; coverage_bbox: [number, number, number, number] | null; has_coverage_polygon: boolean;
  crs: string | null; resolution: string | null; format: string | null; size_bytes: number | null;
  data_class: DataClass | null; suitability: Suitability | null; accuracy_statement: string; licence_text: string; licence_url: string;
  http: Record<string, string>; stats: Record<string, unknown>; notes: string; origin: string; origin_path: string | null;
  supersedes_id: string | null; reviewed_by: string | null; reviewed_at: string | null; review_note: string | null; created_at: string | null;
  quality_checks: QualityCheck[]; files?: DsFile[]; processing_runs?: ProcessingRun[]; coverage_geojson?: unknown;
}
export type UpdateResult = 'update_available' | 'unchanged' | 'changed' | 'first_seen' | 'error' | 'not_checkable';
export interface UpdateStatus {
  result: UpdateResult; checked_at: string | null; detail: string; url: string | null; urls_checked: number; results: Partial<Record<UpdateResult, number>>;
}
export interface UpdateCheck {
  id: string; dataset_id: string; method: string; url: string | null; etag: string | null; last_modified: string | null;
  catalogue_modified: string | null; result: UpdateResult; detail: string;
  new_version_id: string | null; checked_by: string; checked_at: string | null;
}
export interface RecommendedSource { name: string; publisher: string; url: string; licence: string; notes?: string }
export interface DsDataset {
  id: string; title: string; description: string; theme: string; source_id: string | null; source: DsSource | null;
  catalogue_ref: string | null; backs_catalogue: string[]; recommended_sources: RecommendedSource[]; limitations: string;
  max_age_days: number | null; update_check: { method?: string; url?: string }; origin: string;
  /** Latest update-monitor verdict across the probed URLs; null/absent = never checked. Nothing is downloaded by a check. */
  update_status?: UpdateStatus | null;
  status: DatasetStatus; active_version_id: string | null; pending_version_ids: string[]; version_count: number;
  active_version: DsVersion | null; versions?: DsVersion[]; update_checks?: UpdateCheck[]; used_by_features?: string[];
}
export interface FeatureDependency {
  dependency_id: string; theme: string; preferred_dataset_id: string | null; required_quality: Suitability; required: boolean; note: string;
  state: DepState; reason: string; dataset_id: string | null; dataset_title: string | null; version_id: string | null;
  candidates: { dataset_id: string; state: DepState }[];
}
export interface FeatureReadiness {
  id: string; workspace: string; capability: string; name: string; description: string; status: FeatureStatus; capped: boolean;
  status_cap: FeatureStatus | null; status_cap_reason: string | null; reasons: string[]; dependencies: FeatureDependency[];
  /** Whether the feature's code reads registered data today; null = not recorded. */
  wired: boolean | null; wiring_note: string | null;
}
export interface Vocabulary { themes: Record<string, string>; pune_bbox: [number, number, number, number]; data_root: string; rules: string[] }

async function j<T>(path: string, init?: RequestInit): Promise<T> {
  const r = await fetch(`${API_BASE}${path}`, { headers: { 'Content-Type': 'application/json' }, ...init });
  if (!r.ok) {
    let msg = `${r.status} ${r.statusText}`;
    try { const b = await r.json(); if (b?.detail) msg = typeof b.detail === 'string' ? b.detail : JSON.stringify(b.detail); } catch { /* keep status */ }
    throw new Error(msg);
  }
  return r.json() as Promise<T>;
}

export const datasetsApi = {
  vocabulary: () => j<Vocabulary>('/api/datasets/vocabulary'),
  list: () => j<DsDataset[]>('/api/datasets'),
  get: (id: string) => j<DsDataset>(`/api/datasets/${encodeURIComponent(id)}`),
  features: () => j<{ features: FeatureReadiness[]; summary: Record<FeatureStatus, number> }>('/api/datasets/features'),
  review: (versionId: string, body: { decision: 'activate' | 'reject'; reviewer: string; note?: string }) =>
    j<DsVersion>(`/api/datasets/versions/${encodeURIComponent(versionId)}/review`, { method: 'POST', body: JSON.stringify(body) }),
  runQuality: (versionId: string) => j<{ checks: QualityCheck[] }>(`/api/datasets/versions/${encodeURIComponent(versionId)}/quality`, { method: 'POST', body: '{}' }),
  updateCheck: (id: string, checkedBy: string) => j<UpdateCheck>(`/api/datasets/${encodeURIComponent(id)}/update-check`, { method: 'POST', body: JSON.stringify({ checked_by: checkedBy }) }),
  importTree: (actor: string) => j<{ root: string; exists: boolean; summary: Record<string, number>; entries: { dir: string; result: string; reason?: string }[] }>(
    '/api/datasets/import', { method: 'POST', body: JSON.stringify({ actor }) }),
};

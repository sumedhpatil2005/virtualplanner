/**
 * Typed client for /api/coordination (backend/api/coordination_router.py, docs/urbanos/COORDINATION_AND_SUBSURFACE.md).
 * Shared city model: proposal elements with 3D extents, clearance rules, cross-project conflict detection, conflict status,
 * stale-assessment indicators, subsurface records (AGS4 subset / CSV / JSON) and the environment layer catalogue.
 *
 * Honesty rules carried by the types: depth `null` = UNKNOWN (never 0); `certainty` is measured | estimated | hypothetical |
 * unknown; `no_conflict_within_available_data` is not proof of no conflict; seeded clearance rules are cited PERMISSION
 * distances, not engineering clearances. No UI here.
 */
import { API_BASE } from './api';

export type Certainty = 'measured' | 'estimated' | 'hypothetical' | 'unknown';
export type ConflictClass = 'conflict' | 'potential_conflict' | 'vertically_separated' | 'no_conflict_within_available_data' | 'unknown_no_coverage';
export type ConflictStatus = 'open' | 'acknowledged' | 'resolved';
export type ElementKind =
  | 'road' | 'road_widening' | 'flyover' | 'bridge' | 'metro_tunnel' | 'metro_viaduct' | 'metro_station' | 'tunnel' | 'utility'
  | 'pipeline' | 'drainage' | 'building' | 'foundation' | 'pier' | 'excavation' | 'protected_monument' | 'other';
export type QualityLevel = 'QL-A' | 'QL-B' | 'QL-C' | 'QL-D';
export type GeoJsonGeometry =
  | { type: 'Point'; coordinates: [number, number] }
  | { type: 'LineString'; coordinates: [number, number][] }
  | { type: 'Polygon'; coordinates: [number, number][][] };

export interface ProfilePoint { chainage_m: number; z_min_m: number | null; z_max_m: number | null }

export interface ProposalElement {
  id: string; project_id: string; kind: ElementKind; name: string; scenario_id: string | null; scenario_version_id: string | null;
  element_ref: string | null; geometry: GeoJsonGeometry | null; own_geometry: boolean; width_m: number | null;
  z_min_m: number | null; z_max_m: number | null; z_ref: 'ground' | 'msl' | 'unknown'; z_known: { z_min: boolean; z_max: boolean };
  profile: ProfilePoint[] | null; clearance_m: number | null; construction_phase: 'permanent' | 'temporary_works';
  provenance: string; certainty: Certainty; notes: string[]; created_by: string; created_at: string; updated_at: string;
}
export interface ElementInput {
  kind: ElementKind; name?: string; scenario_id?: string | null; scenario_version_id?: string | null; element_ref?: string | null;
  geometry?: GeoJsonGeometry | null; width_m?: number | null; z_min_m?: number | null; z_max_m?: number | null;
  z_ref?: 'ground' | 'msl' | 'unknown'; profile?: ProfilePoint[] | null; clearance_m?: number | null;
  construction_phase?: 'permanent' | 'temporary_works'; provenance?: string; certainty?: Certainty; created_by: string;
}
export interface ElementPatch extends Partial<Omit<ElementInput, 'created_by' | 'element_ref' | 'scenario_id' | 'z_ref' | 'construction_phase'>> {
  edited_by: string; clear_fields?: ('width_m' | 'z_min_m' | 'z_max_m' | 'clearance_m' | 'scenario_version_id' | 'profile')[];
}

export interface ClearanceRule {
  id: string; label: string; rule_type: 'permission_distance' | 'engineering_clearance'; subject_kind: string; other_kind: string;
  horizontal_m: number | null; vertical_m: number | null; horizontal_label: string; vertical_label: string;
  basis: 'cited_permission_distance' | 'user_entered'; basis_label: string; is_permission_distance: boolean; is_engineering_clearance: boolean;
  citation: string | null; note: string; active: boolean; created_by: string; created_at: string; updated_at: string;
}
export interface RuleInput {
  label: string; rule_type: 'permission_distance' | 'engineering_clearance'; subject_kind?: string; other_kind?: string;
  horizontal_m?: number | null; vertical_m?: number | null; citation?: string | null; note?: string; created_by: string;
}
export interface RulePatch {
  edited_by: string; label?: string; horizontal_m?: number; vertical_m?: number; subject_kind?: string; other_kind?: string;
  active?: boolean; note?: string; citation?: string; clear_fields?: ('horizontal_m' | 'vertical_m' | 'citation')[];
}

export interface StaleVerdict {
  /** true = stale, false = current, null = UNKNOWN (inputs not fully recorded) */
  stale: boolean | null; reasons: string[]; not_checked: string[]; label: string; computed_at: string; run_kind?: string;
}
export interface PermissionTrigger { rule_id: string; label: string; distance_m: number; threshold_m: number; basis: string; citation: string | null; note: string }
export interface ConflictFinding {
  id: string; run_id: string; project_a_id: string; element_a_id: string; segment_a: number | null;
  b_type: 'project_element' | 'baseline_road' | 'osm_metro' | 'subsurface_utility' | 'layer' | 'project'; project_b_id: string | null;
  b_ref: string; segment_b: number | null; class: ConflictClass; class_label: string; horizontal_distance_m: number | null;
  vertical_gap_m: number | null; certainty: Certainty; reasons: string[]; permission_triggers: PermissionTrigger[];
  evidence: Record<string, unknown>; status: ConflictStatus; status_by: string | null; status_note: string | null;
  status_at: string | null; status_carried_from: string | null; created_at: string;
}
export interface ProjectIssue extends ConflictFinding { raised_by_project: string; other_project: string | null; run_stale: StaleVerdict | null }
export interface CoordinationRun {
  id: string; project_id: string; engine_version: string; created_by: string; created_at: string;
  summary: { counts: Partial<Record<ConflictClass, number>>; elements: number; skipped_elements: { element_id: string; reason: string }[];
    other_projects: string[]; layers: Record<string, number>; permission_triggers: number; [k: string]: unknown };
  inputs: Record<string, unknown>; stale: StaleVerdict; conflicts?: ConflictFinding[];
}
export interface ProjectStale {
  project_id: string;
  runs: ({ id: string; scenario_id: string; created_at: string } & StaleVerdict)[];
  assessments: ({ id: string; name: string } & StaleVerdict)[];
  coordination_runs: ({ id: string; created_at: string } & StaleVerdict)[];
}

export interface SubsurfaceDataset {
  id: string; project_id: string | null; record_type: 'borehole' | 'utility'; format: 'ags4' | 'csv' | 'json'; name: string;
  file_name: string | null; file_sha256: string | null; publisher: string; source_url: string; licence: string; data_date: string | null;
  coverage_bbox: number[] | null; coverage_label: string; provenance: string; record_count: number; warnings: string[];
  supersedes_id: string | null; imported_by: string; imported_at: string;
}
export interface SubsurfaceRecord {
  id: string; dataset_id: string; record_type: 'borehole' | 'utility'; external_id: string; geometry: GeoJsonGeometry | null;
  location_note: string; ground_level_m: number | null; final_depth_m: number | null;
  strata: { top_m: number | null; base_m: number | null; description: string; legend?: string | null; geology?: string | null }[];
  water_strikes: number[]; spt: { top_m: number | null; n: number | null }[]; utility_type: string | null; owner: string | null;
  depth_m: number | null; diameter_m: number | null; quality_level: QualityLevel | 'UNKNOWN' | null; survey_method: string | null;
  z_min_m: number | null; z_max_m: number | null; z_certainty: Certainty; properties: Record<string, unknown>;
}
export interface ImportInput {
  record_type: 'borehole' | 'utility'; format: 'ags4' | 'csv' | 'json'; content?: string; records?: Record<string, unknown>[];
  name: string; file_name?: string; publisher?: string; source_url?: string; licence?: string; data_date?: string;
  coverage_bbox?: [number, number, number, number]; provenance?: string; project_id?: string; grid_epsg?: number;
  supersedes_id?: string; imported_by: string;
}
export interface EnvironmentLayer {
  id: string; domain: string; name: string; status: 'available' | 'not_imported'; status_label: string; status_source: string;
  source: string; licence: string; data_date: string | null; limitations: string; feature_count?: number | null; coverage_bbox?: number[] | null;
  recommended_sources: { name: string; publisher: string; url: string; licence: string; notes: string; status: string }[];
}

async function call<T>(method: string, path: string, body?: unknown): Promise<T> {
  const res = await fetch(`${API_BASE}/api/coordination${path}`, {
    method, headers: body ? { 'Content-Type': 'application/json' } : undefined, body: body ? JSON.stringify(body) : undefined,
  });
  if (!res.ok) {
    let msg = res.statusText;
    try { const j = await res.json(); msg = typeof j.detail === 'string' ? j.detail : JSON.stringify(j.detail); } catch { /* keep statusText */ }
    throw new Error(`${res.status}: ${msg}`);
  }
  return res.json() as Promise<T>;
}
const q = (s: string) => encodeURIComponent(s);

export const coordinationApi = {
  vocabulary: () => call<Record<string, unknown>>('GET', '/vocabulary'),
  // proposal elements
  listElements: (projectId: string) => call<ProposalElement[]>('GET', `/projects/${q(projectId)}/elements`),
  createElement: (projectId: string, body: ElementInput) => call<ProposalElement>('POST', `/projects/${q(projectId)}/elements`, body),
  getElement: (id: string) => call<ProposalElement>('GET', `/elements/${q(id)}`),
  patchElement: (id: string, body: ElementPatch) => call<ProposalElement>('PATCH', `/elements/${q(id)}`, body),
  deleteElement: (id: string, removedBy: string) => call<{ deleted: string; note: string }>('DELETE', `/elements/${q(id)}?removed_by=${q(removedBy)}`),
  // clearance rules
  listRules: () => call<{ rules: ClearanceRule[]; rule_set_hash: string; engineering_clearances_note: string }>('GET', '/clearance-rules'),
  createRule: (body: RuleInput) => call<ClearanceRule>('POST', '/clearance-rules', body),
  patchRule: (id: string, body: RulePatch) => call<ClearanceRule>('PATCH', `/clearance-rules/${q(id)}`, body),
  // detection
  detect: (projectId: string, runBy: string, screeningRadiusM?: number) =>
    call<CoordinationRun>('POST', `/projects/${q(projectId)}/detect`, { run_by: runBy, ...(screeningRadiusM ? { screening_radius_m: screeningRadiusM } : {}) }),
  listRuns: (projectId: string) => call<CoordinationRun[]>('GET', `/projects/${q(projectId)}/runs`),
  getRun: (runId: string) => call<CoordinationRun>('GET', `/runs/${q(runId)}`),
  projectIssues: (projectId: string, includeClear = false) =>
    call<{ project_id: string; issues: ProjectIssue[]; note: string }>('GET', `/projects/${q(projectId)}/conflicts${includeClear ? '?include_clear=true' : ''}`),
  setConflictStatus: (id: string, status: ConflictStatus, actor: string, note: string) =>
    call<ConflictFinding & { note: string }>('PATCH', `/conflicts/${q(id)}/status`, { status, actor, note }),
  // staleness
  stale: (kind: 'run' | 'assessment' | 'coordination_run', id: string) => call<StaleVerdict & { kind: string; id: string }>('GET', `/stale/${kind}/${q(id)}`),
  projectStale: (projectId: string) => call<ProjectStale>('GET', `/projects/${q(projectId)}/stale`),
  // subsurface
  importSubsurface: (body: ImportInput) => call<SubsurfaceDataset & { meta: Record<string, unknown>; records: SubsurfaceRecord[] }>('POST', '/subsurface/import', body),
  listDatasets: (projectId?: string) => call<SubsurfaceDataset[]>('GET', `/subsurface/datasets${projectId ? `?project_id=${q(projectId)}` : ''}`),
  getDataset: (id: string) => call<SubsurfaceDataset & { records: SubsurfaceRecord[] }>('GET', `/subsurface/datasets/${q(id)}`),
  listRecords: (opts: { bbox?: [number, number, number, number]; recordType?: 'borehole' | 'utility' } = {}) => {
    const p = new URLSearchParams();
    if (opts.bbox) p.set('bbox', opts.bbox.join(','));
    if (opts.recordType) p.set('record_type', opts.recordType);
    const s = p.toString();
    return call<{ records: SubsurfaceRecord[]; note: string }>('GET', `/subsurface/records${s ? `?${s}` : ''}`);
  },
  // environment
  environmentLayers: () => call<{ layers: EnvironmentLayer[]; note: string }>('GET', '/environment-layers'),
};

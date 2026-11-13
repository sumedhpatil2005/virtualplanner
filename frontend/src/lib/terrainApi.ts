/**
 * Typed client for /api/terrain (backend/api/terrain_router.py, docs/urbanos/TERRAIN_AND_SUBSURFACE_DATA.md).
 * Copernicus DEM GLO-30 is a DSM (buildings and trees included): every value is screening-grade. `null` = UNKNOWN
 * (nodata / outside coverage / not published), never 0.
 */
import { API_BASE } from './api';

export type SampleStatus = 'ok' | 'nodata' | 'outside_coverage';

export interface DemDataset {
  dataset_id: string; version: string; dataset_version_id: string | null; registry_review_status: string | null;
  file: string; file_sha256: string | null; crs: string; resolution_m: number; coverage_bbox_wgs84: number[];
  product: string; surface: 'DSM'; warning: string; vertical_datum: string; vertical_accuracy: string;
  classification: string; suitability: string; interpolation: string; attribution: string;
}
export interface ProfileSample { chainage_m: number; segment: number; t: number; lon: number; lat: number; elevation_m: number | null; status: SampleStatus }
export interface TerrainProfile {
  samples: ProfileSample[]; step_m: number; length_m_utm: number; vertex_chainage_m_utm: number[];
  summary: { n: number; n_ok: number; n_nodata: number; n_outside: number; min_m: number | null; max_m: number | null; coverage_fraction: number };
  dataset: DemDataset;
}
export interface TerrainPoint { lon: number; lat: number; elevation_m: number | null; status: SampleStatus; dataset: DemDataset }

export interface OverlayMeta {
  bounds_wgs84: { west: number; south: number; east: number; north: number };
  overlays: Record<'hillshade' | 'slope', { file: string; url: string; legend: string | { label: string; rgba: number[] }[]; units?: string }>;
  source: string; attribution: string; data_date: string; processed_at: string; warning: string; version: string;
  dataset_version_id: string | null; suitability: string; classification: string;
}

export interface DatasetRef { dataset_id: string; version?: string; available: boolean; run_at?: string; notes?: string }
export interface WellObs { date: string; depth_m_bgl: number }
export interface Well {
  station_id: string; agency: string | null; village: string | null; lon: number; lat: number; distance_m: number;
  nearest_chainage_m_utm: number; latest: WellObs | null; first_date: string | null; n_obs: number; series: WellObs[];
  series_truncated: number; well_depth_m: number | null; aquifer: string | null; classification: string;
}
export interface SoilPoint { chainage_m_utm: number; lon: number; lat: number; values: Record<string, number | null>; status: string }
export interface SewerBase {
  pipeline_id: string; label: string | null; type: string | null; material: string | null; diameter_m: number | null;
  start_invert_m: number | null; end_invert_m: number | null; start_top_level_m: number | null; end_top_level_m: number | null;
  sewer_district: string | null; quality_level: 'QL-D'; certainty: string;
}
export interface SewerCrossing extends SewerBase {
  chainage_m_utm: number; lon: number; lat: number; invert_at_crossing_m: number | null; top_level_at_crossing_m: number | null;
  level_method: string; dsm_at_crossing_m: number | null; invert_below_dsm_m: number | null;
}
export interface SewerNear extends SewerBase { distance_m: number; nearest_chainage_m_utm: number }
export interface SubsurfaceEvidence {
  alignment_length_m_utm: number;
  groundwater: { dataset: DatasetRef; statement: string; wells: Well[]; radius_km: number; status: string };
  soil: { dataset: DatasetRef; statement: string; depth: string; properties: { key: string; label: string; unit: string }[]; points: SoilPoint[]; n_unknown?: number; status: string };
  sewers: {
    dataset: DatasetRef; publisher: string; statement: string; quality_level: string; crossings: SewerCrossing[]; near: SewerNear[];
    near_not_shown: number; near_m?: number; status: string;
    datum_check?: { n: number; median_dsm_minus_top_level_m: number; p10: number; p90: number; note: string };
  };
  boreholes: { records: { id: string; external_id: string; distance_m: number; final_depth_m: number | null }[]; status: string; message?: string; import_hint?: string; source: string; radius_km: number };
  dem: DemDataset | null;
  honesty: string;
}

async function call<T>(method: string, path: string, body?: unknown): Promise<T> {
  const res = await fetch(`${API_BASE}/api/terrain${path}`, {
    method, headers: body ? { 'Content-Type': 'application/json' } : undefined, body: body ? JSON.stringify(body) : undefined,
  });
  if (!res.ok) {
    let detail = `${res.status} ${res.statusText}`;
    try { const j = await res.json(); if (j?.detail) detail = typeof j.detail === 'string' ? j.detail : JSON.stringify(j.detail); } catch { /* not json */ }
    throw new Error(detail);
  }
  return res.json() as Promise<T>;
}

type LonLat = readonly (readonly number[])[];
const coords = (c: LonLat) => c.map(p => [p[0], p[1]]);

export const terrainApi = {
  profile: (c: LonLat, stepM = 30) => call<TerrainProfile>('POST', '/profile', { coordinates: coords(c), step_m: stepM }),
  point: (lon: number, lat: number) => call<TerrainPoint>('GET', `/point?lon=${lon}&lat=${lat}`),
  overlays: () => call<OverlayMeta>('GET', '/overlays'),
  overlayUrl: (path: string) => `${API_BASE}${path}`,
  evidence: (c: LonLat, radiusKm = 3, sewerNearM = 50) =>
    call<SubsurfaceEvidence>('POST', '/subsurface-evidence', { coordinates: coords(c), radius_km: radiusKm, sewer_near_m: sewerNearM }),
};

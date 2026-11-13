/**
 * Typed client for /api/infra (backend/api/infra_router.py, docs/urbanos/INFRASTRUCTURE_DATA.md): municipal layers
 * (PMC via OpenCity) and merged building footprints from the spatial index. A missing value is null (= UNKNOWN).
 */
import { API_BASE } from './api';
import type { DataClass, Suitability } from './datasetsApi';

export interface InfraLayer {
  id: string; title: string; group: string; subgroup: string; dataset_id: string; dataset_dir: string; input_sha256: string;
  publisher: string; via: string; source_url: string | null; licence: string; licence_url: string | null;
  source_updated: string | null; retrieved_at: string | null; data_class: DataClass; suitability: Suitability;
  active: boolean; notes: string; feature_count: number | null; bbox: [number, number, number, number] | null; available: boolean;
}
export interface CensusSummary {
  available: boolean; title?: string; vintage?: string; mappable: boolean; not_mappable_reasons?: string[]; wards?: number;
  total_population?: number; reason?: string; by_ward_office?: { ward_office: string; wards: number; population: number; households: number }[];
  source?: { url: string; sha256: string; retrieved_at: string; publisher: string; licence_as_stated?: string };
}
export interface TrafficCountsStatement {
  status: 'none_from_official_sources'; label: string; detail: string; collection_plan: string; collection_plan_url: string;
  restricted_sources: { id: string; name: string; access: string; url: string; note: string }[];
}
export interface InfraCatalogue {
  index: { available: boolean; reason?: string; built_at?: string; fingerprint?: string };
  groups: { label: string; layers: InfraLayer[] }[]; feature_cap: number; max_cap: number;
  population: CensusSummary; traffic_counts: TrafficCountsStatement; note: string;
}
export interface InfraFeature { type: 'Feature'; id: number; properties: Record<string, unknown> & { _fid: number; _ext_id: string }; geometry: { type: string; coordinates: unknown } }
export interface InfraFeatureCollection {
  type: 'FeatureCollection'; layer: string; bbox: number[]; total_in_bbox: number | null; returned: number; not_shown: number | null;
  truncated: boolean; cap: number; too_large?: boolean; message?: string; meta: InfraLayer; features: InfraFeature[];
}

async function get<T>(path: string): Promise<T> {
  const r = await fetch(`${API_BASE}/api/infra${path}`);
  if (!r.ok) {
    let msg = `${r.status} ${r.statusText}`;
    try { const j = await r.json(); if (j?.detail) msg = typeof j.detail === 'string' ? j.detail : JSON.stringify(j.detail); } catch { /* not json */ }
    throw new Error(msg);
  }
  return r.json() as Promise<T>;
}

export const infraApi = {
  catalogue: () => get<InfraCatalogue>('/layers'),
  features: (layer: string, bbox: readonly number[], limit?: number) =>
    get<InfraFeatureCollection>(`/layers/${encodeURIComponent(layer)}/features?bbox=${bbox.map(v => v.toFixed(6)).join(',')}${limit ? `&limit=${limit}` : ''}`),
  trafficCounts: () => get<TrafficCountsStatement>('/traffic-counts'),
  docUrl: (name: 'collection-plan' | 'infrastructure-data') => `${API_BASE}/api/infra/docs/${name}`,
};

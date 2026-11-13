/**
 * Typed client for /api/env-data (backend/api/envdata_router.py, docs/urbanos/ENVIRONMENT_DATA.md): real derived Pune
 * datasets, server-rendered raster views, capped bbox vector/point APIs, air-quality station series, rainfall summaries.
 * No UI here.
 */
import { API_BASE } from './api';

export type EnvDataStatus = 'available' | 'missing' | 'blocked' | 'rejected';
export type EnvDataKind = 'raster' | 'vector' | 'points' | 'stations' | 'series' | 'none';
export type DataClass = 'observed' | 'inferred' | 'estimated' | 'derived' | 'synthetic';
export type Suitability = 'visualisation' | 'screening' | 'engineering';

export interface LegendItem { value?: number; label: string; color: string }
export type EnvLegend =
  | { type: 'categorical'; items: LegendItem[] }
  | { type: 'line'; items: LegendItem[] }
  | { type: 'ramp'; unit: string; label: string; stops: { value: number; color: string }[] };

export interface EnvVariant { id: string; label: string; data_date?: string; legend?: EnvLegend; available: boolean }

export interface EnvDataLayer {
  id: string; group: string; name: string; kind: EnvDataKind; status: EnvDataStatus; status_reason: string;
  source: string; publisher: string; licence: string; licence_url: string | null; attribution: string;
  data_date: string | null; vintage_note: string; data_class: DataClass; suitability: Suitability; limitations: string;
  legend: EnvLegend | null; variants: EnvVariant[]; covers: string[]; bounds: number[] | null;
  processing: { pipeline: string | null; git_commit: string | null; run_at: string | null; file: string | null; sha256: string | null } | null;
}

export interface LandcoverAreas {
  scope: string; area_km2: number; pixels: number; nodata_pixels: number; method: string;
  classes: { value: number; label: string; color: string; km2: number; pct: number | null }[];
}

export interface TreePoint {
  id: number; lon: number; lat: number; girth_cm: number | null; height_m: number | null; canopy_dia_m: number | null;
  condition: string | null; ownership: string | null; ward: string | null; is_rare: number | null;
  botanical_name: string | null; common_name: string | null; local_name: string | null;
}
export type TreesResponse =
  | { mode: 'points'; total: number; returned: number; limit: number; points: TreePoint[] }
  | { mode: 'clusters'; total: number; total_exact: boolean; returned: 0; limit: number; cell_deg: number; clusters: { lon: number; lat: number; n: number }[]; message: string };

export interface AqParamInfo { label: string; unit: string; samples?: number; first?: string; last?: string }
export interface AqStation {
  station_id: string; name: string; agency: string | null; lon: number | null; lat: number | null; coordinates_status: string;
  data_first: string | null; data_last: string | null; rows: number; has_series: boolean; in_cpcb_list_pdf: boolean;
  parameters: Record<string, AqParamInfo>;
}
export interface AqSeries {
  station_id: string; parameter: string; label: string; unit: string; agg: string; first: string | null; last: string | null;
  samples_per_full_bucket: number | null; points: { t: string; v: number; max?: number; n: number }[]; note: string;
}

export interface RainCell {
  cell_lon: number; cell_lat: number; resolution_deg: number;
  annual: { year: number; mm: number; qa_flag: string | null }[];
  monthly_mean_mm: { month: number; mm: number }[];
  daily_max_by_year: { year: number; mm: number; date: string }[];
  daily_max: { mm: number; date: string };
  suspect_years: number[];
}
export interface RainfallSummary {
  imd_grid: { cells: RainCell[]; period: string; suspect_cell_years: string[]; suspect_rule: string };
  chirps_box: { annual_total_mm: Record<string, number>; monthly_climatology_mm: Record<string, number> | null; annual_max_1day_mm: Record<string, number> | null; days: number; first: string; last: string };
  nwdp_district: { rows: Record<string, string | number | null>[]; first: string; last: string };
  statement: string;
}

const BASE = `${API_BASE}/api/env-data`;

async function call<T>(method: 'GET' | 'POST', path: string, body?: unknown): Promise<T> {
  let r: Response;
  try {
    r = await fetch(`${BASE}${path}`, { method, headers: body ? { 'Content-Type': 'application/json' } : undefined, body: body ? JSON.stringify(body) : undefined, signal: AbortSignal.timeout(60000) });
  } catch (e) {
    throw new Error(e instanceof Error && e.name === 'TimeoutError' ? 'no answer from the server within 60 s' : 'backend unreachable');
  }
  if (!r.ok) {
    let msg = `${r.status}`;
    try { const j = await r.json(); msg = typeof j.detail === 'string' ? j.detail : JSON.stringify(j.detail ?? j); } catch { /* keep status */ }
    throw new Error(msg);
  }
  return r.json() as Promise<T>;
}

const bb = (b: number[]) => b.map(v => v.toFixed(6)).join(',');

export const envDataApi = {
  catalogue: () => call<{ layers: EnvDataLayer[]; note: string; data_dir: string }>('GET', '/catalogue'),
  renderUrl: (id: string, bbox: number[], width: number, variant?: string | null) =>
    `${BASE}/layers/${id}/render.png?bbox=${bb(bbox)}&width=${Math.round(width)}${variant ? `&variant=${encodeURIComponent(variant)}` : ''}`,
  landcoverAreasBbox: (bbox: number[]) => call<LandcoverAreas>('GET', `/layers/landcover_worldcover2021/areas?bbox=${bb(bbox)}`),
  landcoverAreasPolygon: (geometry: unknown, label: string) => call<LandcoverAreas>('POST', '/layers/landcover_worldcover2021/areas', { geometry, label }),
  features: (id: string, bbox: number[], limit = 2000) =>
    call<{ total: number; returned: number; not_shown: number; limit: number; geojson: { features: { id: number; properties: Record<string, unknown>; geometry: { type: string; coordinates: number[][] | number[][][] } }[] } }>('GET', `/layers/${id}/features?bbox=${bb(bbox)}&limit=${limit}`),
  trees: (bbox: number[], limit = 2000) => call<TreesResponse>('GET', `/trees?bbox=${bb(bbox)}&limit=${limit}`),
  treesInPolygon: (geometry: unknown) => call<{ count: number; rare: number; vintage: string; note: string }>('POST', '/trees/count', { geometry }),
  airStations: () => call<{ stations: AqStation[]; parameters: Record<string, AqParamInfo>; note: string }>('GET', '/air/stations'),
  airSeries: (station: string, param: string, agg: 'hour' | 'day' | 'month' = 'day') =>
    call<AqSeries>('GET', `/air/series?station=${encodeURIComponent(station)}&param=${encodeURIComponent(param)}&agg=${agg}`),
  rainfallSummary: () => call<RainfallSummary>('GET', '/rainfall/summary'),
};

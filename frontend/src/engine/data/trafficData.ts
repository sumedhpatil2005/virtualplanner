/**
 * Traffic Data Manager: types mirroring /api/traffic-data (backend/api/traffic_data_router.py)
 * and small pure helpers. See docs/TRAFFIC_DATA.md.
 *
 * A count is vehicles observed (or estimated) passing a place in a period. It is
 * not demand and not throughput: the engine only reads counts as calibration /
 * validation evidence (countValidation.ts) and as constraints for a future
 * matrix estimator (odmeConstraints.ts).
 */
import { apiGet, apiPost, apiDelete, API_BASE } from '../../lib/api';

export type DatasetKind = 'measured' | 'estimated' | 'manual';
export type DatasetRole = 'validation' | 'calibration' | 'unused';
export type RefKind = 'road_direction' | 'junction_approach' | 'turn';
export type Direction = 'fwd' | 'bwd' | 'both';
export type DayType = 'weekday' | 'saturday' | 'sunday' | 'holiday' | 'weekend' | 'all_days';

export const KIND_LABEL: Record<DatasetKind, string> = { measured: 'Measured', estimated: 'Estimated', manual: 'Manual' };
export const DAY_TYPES: DayType[] = ['weekday', 'saturday', 'sunday', 'holiday', 'weekend', 'all_days'];

export interface VehicleClass { code: string; label: string; description: string; builtin: boolean; sort_order: number }

export interface PcuFactorSet {
  id: number; set_key: string; version: number; name: string; context: string;
  source_citation: string; source_url: string; assumptions: string; factors: Record<string, number>;
  change_note: string; builtin: boolean; created_by: string; created_at: string | null; latest: boolean | null;
}

export interface DatasetMeta {
  name: string; provider: string; kind: DatasetKind; method?: string;
  collected_from?: string | null; collected_to?: string | null; location_desc: string; period_desc: string;
  classification: string; assumptions?: string; adjustments?: string; pcu_factor_set_id?: number | null;
  role?: DatasetRole; entered_by: string; synthetic?: boolean;
}

export interface Dataset extends Required<Omit<DatasetMeta, 'collected_from' | 'collected_to' | 'pcu_factor_set_id'>> {
  id: string; collected_from: string | null; collected_to: string | null; pcu_factor_set_id: number | null;
  imported_file_name: string | null; imported_file_sha256: string | null;
  import_report: ImportReport | null; created_at: string | null; updated_at: string | null; record_count: number | null;
}

export interface ImportReport { file_name: string; sha256: string; rows_in_file: number; imported: number; rejected: number; rejected_rows: { row: number; errors: FieldError[] }[] }

export interface CountRecordInput {
  ref_kind: RefKind; road_id?: string | null; direction?: Direction | null; direction_label?: string;
  junction_ref?: string | null; approach_road_id?: string | null; from_road_id?: string | null; to_road_id?: string | null;
  turn?: string | null; day_type: DayType; count_date?: string | null; period_start: string; period_end: string;
  class_counts: Record<string, number>; total_count?: number | null; notes?: string;
}

export interface CountRecord extends CountRecordInput {
  id: number; dataset_id: string; source_row: number | null;
  vehicles: number; period_minutes: number; veh_h: number; pcu_h: number | null; pcu_note: string | null;
}

export interface DatasetDetail extends Dataset { pcu_set: PcuFactorSet | null; records: CountRecord[] }

export interface FieldError { field: string; message: string; value?: string | null }

/** One clock-hour count row for the engine (GET /api/traffic-data/counts); never merged across datasets. */
export interface EngineCountRow {
  ref_kind: RefKind; road_id: string | null; direction: Direction | null; junction_ref: string | null;
  approach_road_id: string | null; from_road_id: string | null; to_road_id: string | null;
  dataset_id: string; dataset_name: string; kind: DatasetKind; role: DatasetRole; synthetic: boolean;
  day_type: DayType; count_date: string | null; hour: number; period: string; span: boolean; complete: boolean;
  minutes: number; veh_h: number | null; pcu_h: number | null; pcu_set_name: string | null; class_counts: Record<string, number>;
}

export interface HourRow {
  key: { ref_kind: RefKind; road_id: string | null; direction: Direction | null; junction_ref: string | null; approach_road_id: string | null; from_road_id: string | null; to_road_id: string | null };
  day_type: DayType; count_date: string | null; hour: number; period: string; span: boolean; complete: boolean; minutes: number;
  veh_h: number | null; pcu_h: number | null; pcu_note: string | null; class_counts: Record<string, number>;
}

export interface ImportPreview {
  file_name: string; sha256: string; sheets: string[]; columns: string[]; fields: string[]; class_codes: string[];
  mapping: Record<string, string>; suggested: boolean; sample: (string | null)[][];
  row_count: number; valid_count: number; error_count: number;
  rows: { row: number; record: CountRecordInput; errors: FieldError[] }[];
  invalid_rows: { row: number; record: CountRecordInput; errors: FieldError[] }[];
}

const B = '/api/traffic-data';
export const trafficApi = {
  classes: () => apiGet<VehicleClass[]>(`${B}/vehicle-classes`),
  pcuSets: () => apiGet<PcuFactorSet[]>(`${B}/pcu-sets`),
  datasets: () => apiGet<Dataset[]>(`${B}/datasets`),
  dataset: (id: string) => apiGet<DatasetDetail>(`${B}/datasets/${encodeURIComponent(id)}`),
  createDataset: (m: DatasetMeta) => apiPost<Dataset>(`${B}/datasets`, m),
  patchDataset: (id: string, patch: Partial<DatasetMeta> & { edited_by: string }) => apiSend<Dataset>('PATCH', `${B}/datasets/${encodeURIComponent(id)}`, patch),
  deleteDataset: (id: string, by: string) => apiDelete(`${B}/datasets/${encodeURIComponent(id)}?deleted_by=${encodeURIComponent(by)}`),
  addRecords: (id: string, enteredBy: string, records: CountRecordInput[]) => apiSend<CountRecord[]>('POST', `${B}/datasets/${encodeURIComponent(id)}/records`, { entered_by: enteredBy, records }),
  deleteRecord: (id: number, by: string) => apiDelete(`${B}/records/${id}?deleted_by=${encodeURIComponent(by)}`),
  hourly: (id: string, roadId?: string) => apiGet<{ dataset: Dataset; pcu_set_name: string | null; hours: HourRow[] }>(`${B}/datasets/${encodeURIComponent(id)}/hourly${roadId ? `?road_id=${encodeURIComponent(roadId)}` : ''}`),
  counts: (o: { role?: DatasetRole; kinds: DatasetKind[]; dayType?: DayType }) =>
    apiGet<EngineCountRow[]>(`${B}/counts?kinds=${o.kinds.join(',')}${o.role ? `&role=${o.role}` : ''}${o.dayType ? `&day_type=${o.dayType}` : ''}`),
  preview: (body: { file_name: string; content_base64: string; sheet?: string | null; mapping?: Record<string, string> | null; defaults?: Record<string, string> }) => apiSend<ImportPreview>('POST', `${B}/import/preview`, body),
  commit: (body: { file_name: string; content_base64: string; sheet?: string | null; mapping: Record<string, string>; defaults?: Record<string, string>; dataset: DatasetMeta; skip_invalid: boolean }) => apiSend<Dataset>('POST', `${B}/import/commit`, body),
};

/** Error raised with the server's validation detail kept (row/field problems), unlike the generic ApiError text. */
export class TrafficApiError extends Error {
  constructor(public status: number, public detail: unknown) { super(typeof detail === 'string' ? detail : (detail as { message?: string })?.message ?? `HTTP ${status}`); }
}

async function apiSend<T>(method: string, path: string, body: unknown): Promise<T> {
  const res = await fetch(`${API_BASE}${path}`, { method, headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body) });
  const json = await res.json().catch(() => null);
  if (!res.ok) throw new TrafficApiError(res.status, json?.detail ?? json);
  return json as T;
}

// ── pure helpers (mirrors of backend/traffic_data/core.py) ───────────────────

export class MissingPcuFactorError extends Error {
  constructor(public classes: string[], setName: string) { super(`PCU factor set '${setName}' has no factor for: ${classes.join(', ')}`); }
}

export const minutesOf = (t: string): number | null => {
  const m = /^(\d{1,2}):(\d{2})$/.exec(t.trim());
  if (!m) return null;
  const h = Number(m[1]), mi = Number(m[2]);
  if (mi > 59 || h > 24 || (h === 24 && mi !== 0)) return null;
  return h * 60 + mi;
};

/** Vehicles in a period → veh/h. Null when the period is not valid. */
export function vehPerHour(vehicles: number, start: string, end: string): number | null {
  const s = minutesOf(start), e = minutesOf(end);
  if (s === null || e === null || e <= s) return null;
  return vehicles * 60 / (e - s);
}

/** Σ vehicles × factor; refuses when a counted class has no factor (never guesses one). */
export function toPcu(classCounts: Record<string, number>, set: Pick<PcuFactorSet, 'factors' | 'name' | 'version'>): number {
  const missing = Object.entries(classCounts).filter(([c, v]) => v > 0 && !(c in set.factors)).map(([c]) => c).sort();
  if (missing.length) throw new MissingPcuFactorError(missing, `${set.name} (v${set.version})`);
  return Object.entries(classCounts).reduce((a, [c, v]) => a + (v > 0 ? v * set.factors[c] : 0), 0);
}

/** Compass label of a polyline's drawn direction ('fwd'), e.g. "towards NE". */
export function forwardBearingLabel(coords: readonly (readonly number[])[]): { fwd: string; bwd: string } | null {
  if (coords.length < 2) return null;
  const [a, b] = [coords[0], coords[coords.length - 1]];
  const dx = (b[0] - a[0]) * Math.cos(((a[1] + b[1]) / 2) * Math.PI / 180), dy = b[1] - a[1];
  if (dx === 0 && dy === 0) return null;
  const deg = (Math.atan2(dx, dy) * 180 / Math.PI + 360) % 360;
  const names = ['N', 'NE', 'E', 'SE', 'S', 'SW', 'W', 'NW'];
  const at = (d: number) => names[Math.round(d / 45) % 8];
  return { fwd: `towards ${at(deg)}`, bwd: `towards ${at((deg + 180) % 360)}` };
}

export async function fileToBase64(file: Blob): Promise<string> {
  const buf = new Uint8Array(await file.arrayBuffer());
  let s = '';
  for (let i = 0; i < buf.length; i += 0x8000) s += String.fromCharCode(...buf.subarray(i, i + 0x8000));
  return btoa(s);
}

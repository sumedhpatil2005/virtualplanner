/**
 * Observed junction counts, as served by the backend from
 * backend/data/observed_counts/*.json (schema twincity.observed_counts/v1).
 *
 * The file is the only place real counts live: nothing in the frontend holds
 * or invents a count. A file is checked again here before use, so a bad file
 * is reported rather than half-used.
 */
import { apiGet } from '../../lib/api';

export type Cardinal = 'N' | 'E' | 'S' | 'W';
export type Turn = 'left' | 'straight' | 'right';
export type VehicleClass = 'LV' | 'HV' | 'TW';
export const CARDINALS: readonly Cardinal[] = ['N', 'E', 'S', 'W'];
export const TURNS: readonly Turn[] = ['left', 'straight', 'right'];
export const VEHICLE_CLASSES: readonly VehicleClass[] = ['LV', 'HV', 'TW'];

export interface CountSource { id: string; role: string; citation: string; doi?: string; url?: string; sha256?: string }
export interface ObservedMovement { approach: Cardinal; turn: Turn; LV?: number; HV?: number; TW?: number; veh?: number; pcu?: number }
export interface CountJunction {
  id: string;
  name: string;
  area?: string;
  control?: string;
  lanes?: number;
  source_table?: string;
  published_total_veh?: number;
  movements: ObservedMovement[];
  notes?: string[];
  location: {
    lon: number; lat: number; method: string; confidence?: string;
    anchor?: { lon: number; lat: number; source: string; url?: string };
    matched?: { kind: 'roundabout' | 'intersection'; arms: number; road_names?: string[]; way_ids?: number[] };
  };
  totals?: { veh: number; pcu: number; matches_published_total: boolean };
}
export interface CountDataset {
  schema: string;
  dataset_id: string;
  version: string;
  title: string;
  data_source_type: 'observed' | 'survey';
  sources: CountSource[];
  survey: { method: string; date: string | null; date_note?: string; period: string; peak_hour_clock: string | null; peak_hour_note?: string; phf_range?: [number, number] };
  units: { count: 'veh/h'; classes: Record<VehicleClass, string> };
  pcu: { standard: string; factors: Record<VehicleClass, number>; rationale?: string; url?: string };
  junctions: CountJunction[];
  missing?: { field: string; reason: string }[];
}
export interface CountDatasetSummary { file: string; valid: boolean; dataset_id?: string; title?: string; junctions?: number; bbox?: [number, number, number, number]; error?: string }

export const COUNT_SCHEMA = 'twincity.observed_counts/v1';
const isCount = (v: unknown) => typeof v === 'number' && Number.isInteger(v) && v >= 0;

/** Problems with a count file; empty when it is usable. Mirrors backend/observed/counts.py. */
export function validateCountDataset(doc: any): string[] {
  const p: string[] = [];
  if (!doc || typeof doc !== 'object') return ['not an object'];
  if (doc.schema !== COUNT_SCHEMA) p.push(`schema must be ${COUNT_SCHEMA}`);
  for (const key of ['dataset_id', 'version', 'title', 'sources', 'survey', 'units', 'pcu', 'junctions']) if (!(key in doc)) p.push(`missing ${key}`);
  if (p.length) return p;
  if (doc.data_source_type !== 'observed' && doc.data_source_type !== 'survey') p.push("data_source_type must be 'observed' or 'survey'");
  if (!Array.isArray(doc.sources) || !doc.sources.length) p.push('at least one source is required');
  else doc.sources.forEach((s: any, i: number) => { if (!s?.citation || !(s.doi || s.url)) p.push(`sources[${i}] needs a citation and a DOI or URL`); });
  if (doc.units?.count !== 'veh/h') p.push("units.count must be 'veh/h'");
  for (const c of VEHICLE_CLASSES) if (!(typeof doc.pcu?.factors?.[c] === 'number' && doc.pcu.factors[c] > 0)) p.push(`pcu.factors.${c} must be a positive number`);
  const ids = new Set<string>();
  for (const j of doc.junctions ?? []) {
    const id = j?.id ?? '?';
    if (ids.has(id)) p.push(`duplicate junction id ${id}`);
    ids.add(id);
    const loc = j?.location;
    if (!(typeof loc?.lon === 'number' && typeof loc?.lat === 'number' && Math.abs(loc.lon) <= 180 && Math.abs(loc.lat) <= 90)) p.push(`${id}: location needs lon/lat`);
    const keys = new Set<string>();
    for (const m of j?.movements ?? []) {
      if (!CARDINALS.includes(m?.approach) || !TURNS.includes(m?.turn)) { p.push(`${id}: bad movement key ${m?.approach}/${m?.turn}`); continue; }
      const key = `${m.approach}:${m.turn}`;
      if (keys.has(key)) p.push(`${id}: duplicate movement ${key}`);
      keys.add(key);
      for (const c of VEHICLE_CLASSES) if (c in m && !isCount(m[c])) p.push(`${id} ${key}: ${c} must be a non-negative integer`);
      if (!VEHICLE_CLASSES.some(c => c in m)) p.push(`${id} ${key}: no class counts`);
    }
    if (!keys.size) p.push(`${id}: no movements`);
  }
  return p;
}

/** Vehicles per hour of a movement: the sum of the classes present (an absent class is not zero-filled). */
export const movementVeh = (m: ObservedMovement) => VEHICLE_CLASSES.reduce((n, c) => n + (m[c] ?? 0), 0);
export const movementPcu = (m: ObservedMovement, factors: Record<VehicleClass, number>) => VEHICLE_CLASSES.reduce((n, c) => n + (m[c] ?? 0) * factors[c], 0);

/** Short citation for labels: "Khandekar et al. 2025; Kureshi et al. 2026". */
export function shortCitation(ds: CountDataset): string {
  return ds.sources.map(s => {
    const author = s.citation.split(',')[0].trim();
    const year = /\((\d{4})\)/.exec(s.citation)?.[1] ?? '';
    return `${author} et al. ${year}`.trim();
  }).join('; ');
}

export const DEFAULT_COUNT_DATASET = 'pune_west_2026';

export async function listCountDatasets(): Promise<CountDatasetSummary[]> {
  return (await apiGet<{ datasets: CountDatasetSummary[] }>('/api/observed-counts')).datasets;
}

export async function fetchCountDataset(id: string): Promise<CountDataset> {
  const doc = await apiGet<CountDataset>(`/api/observed-counts/${encodeURIComponent(id)}`);
  const problems = validateCountDataset(doc);
  if (problems.length) throw new Error(`Count file ${id} is invalid: ${problems.join('; ')}`);
  return doc;
}

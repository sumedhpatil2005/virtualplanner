/**
 * Pure model for the Environment data catalogue (GET /api/env-data/catalogue) merged with the coordination catalogue
 * (GET /api/coordination/environment-layers). Unit-tested in src/engine/testing/EnvDataModel.test.ts; no Cesium, no DOM.
 */
import type { EnvironmentLayer } from '../../lib/coordinationApi';
import type { EnvDataLayer, EnvLegend } from '../../lib/envDataApi';
import { ENV_GROUPS, type EnvGroupId, shortDate } from './envCatalogue';

export type CatalogueRow = { kind: 'coord'; layer: EnvironmentLayer } | { kind: 'env'; layer: EnvDataLayer };
export interface MergedGroup { id: EnvGroupId; label: string; rows: CatalogueRow[]; available: number; superseded: string[] }

const ENV_GROUP_OF: Record<string, EnvGroupId> = { vegetation: 'vegetation', water: 'water', ground: 'ground', air: 'air', heat: 'heat', noise: 'noise' };

const rowAvailable = (r: CatalogueRow) => r.layer.status === 'available';
const rowName = (r: CatalogueRow) => r.layer.name;

/**
 * Every row lands in one group. A coordination row that is NOT available and is covered by an env-data row
 * (e.g. "Land cover — Not imported") is replaced by the real dataset row and listed in `superseded`; an available
 * coordination row (OSM-derived) is kept next to it. Blocked/rejected env rows stay visible, after available ones.
 */
export function mergeCatalogue(coord: EnvironmentLayer[], env: EnvDataLayer[]): MergedGroup[] {
  const covered = new Set(env.flatMap(l => l.covers));
  const groups: MergedGroup[] = ENV_GROUPS.map(g => ({ id: g.id, label: g.label, rows: [], available: 0, superseded: [] }));
  const other: MergedGroup = { id: 'other', label: 'Other', rows: [], available: 0, superseded: [] };
  const byId = (id: EnvGroupId) => groups.find(g => g.id === id) ?? other;
  for (const l of coord) {
    const gi = ENV_GROUPS.findIndex(g => g.domains.includes(l.domain));
    const g = gi >= 0 ? groups[gi] : other;
    if (l.status !== 'available' && covered.has(l.id)) { g.superseded.push(l.id); continue; }
    g.rows.push({ kind: 'coord', layer: l });
  }
  for (const l of env) byId(ENV_GROUP_OF[l.group] ?? 'other').rows.push({ kind: 'env', layer: l });
  const rank = (r: CatalogueRow) => rowAvailable(r) ? 0 : r.kind === 'env' && (r.layer.status === 'blocked' || r.layer.status === 'rejected') ? 2 : 1;
  for (const g of [...groups, other]) {
    g.rows.sort((a, b) => rank(a) - rank(b) || rowName(a).localeCompare(rowName(b)));
    g.available = g.rows.filter(rowAvailable).length;
  }
  return [...groups, ...(other.rows.length ? [other] : [])];
}

export const STATUS_LABEL: Record<EnvDataLayer['status'], string> = {
  available: 'Available', missing: 'Not on disk — UNKNOWN', blocked: 'Blocked', rejected: 'Rejected',
};

/** A map toggle exists only for available rows with a renderer. */
export function hasMapToggle(l: EnvDataLayer): boolean {
  return l.status === 'available' && (l.kind === 'raster' || l.kind === 'vector' || l.kind === 'points' || l.kind === 'stations');
}

/** DataStatus value for an env-data row (available only; date shown in its stated zone). */
export function envDataStatus(l: EnvDataLayer, variantId?: string | null):
  | { status: 'available'; source: string; date: string; licence: string; url?: string }
  | { status: 'not_imported' } {
  if (l.status !== 'available') return { status: 'not_imported' };
  const v = variantId ? l.variants.find(x => x.id === variantId) : undefined;
  const date = v?.data_date ?? l.data_date ?? '';
  return { status: 'available', source: l.publisher || l.source, date: /^\d{4}-\d{2}-\d{2}T/.test(date) ? shortDate(date) ?? date : date, licence: l.licence, url: l.licence_url ?? undefined };
}

const CLASS_LABEL: Record<string, string> = { observed: 'Observed', inferred: 'Inferred', estimated: 'Estimated', derived: 'Derived', synthetic: 'Synthetic' };
export function classLine(l: Pick<EnvDataLayer, 'data_class' | 'suitability'>): string {
  const s = l.suitability === 'engineering' ? 'engineering' : `${l.suitability} only`;
  return `${CLASS_LABEL[l.data_class] ?? 'UNKNOWN'} · ${s}`;
}

/** Legend of the active variant (soil properties carry their own), else the layer legend. */
export function legendOf(l: EnvDataLayer, variantId?: string | null): EnvLegend | null {
  const v = variantId ? l.variants.find(x => x.id === variantId) : undefined;
  return v?.legend ?? l.legend;
}

export function rampCss(stops: { value: number; color: string }[]): string {
  if (stops.length === 0) return 'transparent';
  const lo = stops[0].value, hi = stops[stops.length - 1].value;
  const span = hi - lo || 1;
  return `linear-gradient(90deg, ${stops.map(s => `${s.color} ${(((s.value - lo) / span) * 100).toFixed(1)}%`).join(', ')})`;
}

/** Intersection of two [w,s,e,n] boxes; null when they do not overlap. */
export function clipBbox(a: number[], b: number[] | null): number[] | null {
  if (!b) return a;
  const w = Math.max(a[0], b[0]), s = Math.max(a[1], b[1]), e = Math.min(a[2], b[2]), n = Math.min(a[3], b[3]);
  return w < e && s < n ? [w, s, e, n] : null;
}

/** Output width in px for a view box: proportional to the share of the screen it covers, capped. */
export function renderWidth(view: number[], clipped: number[], screenPx: number): number {
  const share = (clipped[2] - clipped[0]) / (view[2] - view[0] || 1);
  return Math.max(64, Math.min(1600, Math.round(screenPx * share)));
}

/**
 * Approximate footprint polygon of a drawn line (centreline ± width/2), WGS84, for land-cover class areas of a
 * selected proposal. Offsets use a local metres-per-degree scale (adequate at city scale; stated in the UI).
 */
export function lineFootprint(coords: [number, number][], widthM: number): { type: 'Polygon'; coordinates: [number, number][][] } | null {
  const pts = coords.filter((c, i) => i === 0 || c[0] !== coords[i - 1][0] || c[1] !== coords[i - 1][1]);
  if (pts.length < 2 || !(widthM > 0)) return null;
  const lat0 = pts[0][1] * Math.PI / 180;
  const mx = 111320 * Math.cos(lat0), my = 110540;
  const half = widthM / 2;
  const left: [number, number][] = [], right: [number, number][] = [];
  for (let i = 0; i < pts.length; i++) {
    const a = pts[Math.max(0, i - 1)], b = pts[Math.min(pts.length - 1, i + 1)];
    const dx = (b[0] - a[0]) * mx, dy = (b[1] - a[1]) * my;
    const len = Math.hypot(dx, dy) || 1;
    const nx = -dy / len, ny = dx / len;
    left.push([pts[i][0] + (nx * half) / mx, pts[i][1] + (ny * half) / my]);
    right.push([pts[i][0] - (nx * half) / mx, pts[i][1] - (ny * half) / my]);
  }
  const ring = [...left, ...right.reverse()];
  ring.push(ring[0]);
  return { type: 'Polygon', coordinates: [ring] };
}

/** SVG polyline path for a time series (x by index), with the value range. Gaps (n=0 buckets) are absent upstream. */
export function seriesPath(values: number[], w: number, h: number, pad = 2): { d: string; min: number; max: number } {
  if (values.length === 0) return { d: '', min: 0, max: 0 };
  const min = Math.min(0, ...values), max = Math.max(...values);
  const span = max - min || 1;
  const step = values.length > 1 ? (w - 2 * pad) / (values.length - 1) : 0;
  const d = values.map((v, i) => `${i ? 'L' : 'M'}${(pad + i * step).toFixed(1)},${(h - pad - ((v - min) / span) * (h - 2 * pad)).toFixed(1)}`).join('');
  return { d, min, max };
}

export const MONTHS = ['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec'];

/** "2024-01-01T05:30:00+05:30" → "2024-01-01 IST"; other strings unchanged. */
export function istDate(s: string | null | undefined): string {
  if (!s) return 'unknown';
  const m = /^(\d{4}-\d{2}-\d{2})T[\d:]+\+05:30$/.exec(s);
  return m ? `${m[1]} IST` : s;
}

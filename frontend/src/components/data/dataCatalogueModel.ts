/**
 * Pure view-model of the Data catalogue (Reports → Data). No React, no fetch: tested in
 * src/engine/testing/DataCatalogueModel.test.ts. Missing values render as "UNKNOWN", never blank or 0.
 */
import type { DataStatusValue } from '../ui/badges';
import type { CheckStatus, DataClass, DatasetStatus, DepState, DsDataset, DsVersion, FeatureReadiness, FeatureStatus, QualityCheck } from '../../lib/datasetsApi';

export const UNKNOWN = 'UNKNOWN';
export const PUNE_BBOX: [number, number, number, number] = [73.70, 18.40, 74.05, 18.70];

export const STATUS_ORDER: DatasetStatus[] = ['available', 'pending_review', 'synthetic', 'not_acquired'];
export const STATUS_LABEL: Record<DatasetStatus, string> = {
  available: 'Available', pending_review: 'Pending review', synthetic: 'Synthetic only', not_acquired: 'Not acquired · UNKNOWN',
};
export const DATA_CLASS_LABEL: Record<DataClass, string> = {
  observed: 'Observed', inferred: 'Inferred', estimated: 'Estimated', derived: 'Derived', synthetic: 'SYNTHETIC',
};
export const DATA_CLASS_HELP: Record<DataClass, string> = {
  observed: 'Recorded by a survey, sensor or mapper; still check its accuracy and date.',
  inferred: 'Deduced from other evidence (e.g. a rule applied to observations).',
  estimated: 'Produced by a model, default or heuristic; not measured.',
  derived: 'Computed from other datasets by a recorded pipeline (clip, reprojection, aggregation).',
  synthetic: 'Made up (demo or test). Never counts as data for any feature.',
};
/** Data class → the colour token of the honesty vocabulary (measured / estimated / hypothetical). */
export const DATA_CLASS_TONE: Record<DataClass, 'measured' | 'estimated' | 'hypothetical'> = {
  observed: 'measured', inferred: 'estimated', estimated: 'estimated', derived: 'estimated', synthetic: 'hypothetical',
};
export const CHECK_TONE: Record<CheckStatus, 'good' | 'warn' | 'bad' | 'unknown'> = {
  pass: 'good', warn: 'warn', fail: 'bad', unknown: 'unknown', not_applicable: 'unknown',
};
export const CHECK_LABEL: Record<string, string> = {
  classification: 'Class & suitability', licence: 'Licence', crs: 'CRS', pune_coverage: 'Pune coverage', staleness: 'Date / staleness',
  checksum: 'Files & sha256', geometry_validity: 'Geometry validity', duplicates: 'Duplicates',
};
export const FEATURE_STATUS_LABEL: Record<FeatureStatus, string> = { ready: 'Ready', partial: 'Partial', blocked: 'Blocked' };
export const DEP_STATE_LABEL: Record<DepState, string> = {
  satisfied: 'Met', insufficient_quality: 'Lower quality than needed', quality_fail: 'Quality check failed', unclassified: 'Not classified',
  synthetic_only: 'Synthetic only', pending_review: 'Pending review', missing: 'Not acquired',
};
export const CAPABILITY_ORDER = ['Explore', 'Design', 'Underground', 'Environment', 'Flood/drainage', 'Traffic', 'Emissions', 'Population', 'Coordination'];

export const orUnknown = (v: string | number | null | undefined): string =>
  v === null || v === undefined || (typeof v === 'string' && !v.trim()) || (typeof v === 'number' && !Number.isFinite(v)) ? UNKNOWN : String(v);

/** The date that best says how current the data is, with which kind of date it is. */
export function bestDate(v: DsVersion | null | undefined): { kind: string; value: string } | null {
  if (!v) return null;
  if (v.observation_end) return { kind: 'data up to', value: v.observation_end };
  if (v.source_updated_date) return { kind: 'source updated', value: v.source_updated_date };
  if (v.published_date) return { kind: 'published', value: v.published_date };
  if (v.observation_start) return { kind: 'data from', value: v.observation_start };
  return null;
}

/** Maps a registry dataset onto the shared DataStatus badge (available needs source, date and licence; missing → "unknown"). */
export function dataStatusValue(d: DsDataset): DataStatusValue {
  const v = d.active_version;
  if (!v || d.status === 'not_acquired' || d.status === 'pending_review') return { status: 'not_imported' };
  const date = bestDate(v);
  return {
    status: 'available',
    source: d.source?.publisher && d.source.publisher !== 'UNKNOWN' ? d.source.publisher : '',
    date: date ? `${date.kind} ${date.value}` : '',
    licence: v.licence_text && !v.licence_text.toUpperCase().startsWith('UNKNOWN') ? shorten(v.licence_text, 48) : '',
    url: d.source?.url || undefined,
  };
}

export const shorten = (s: string, n: number) => (s.length > n ? `${s.slice(0, n - 1)}…` : s);

export function formatBytes(n: number | null | undefined): string {
  if (n === null || n === undefined || !Number.isFinite(n)) return UNKNOWN;
  if (n < 1024) return `${n} B`;
  const u = ['KB', 'MB', 'GB', 'TB'];
  let x = n / 1024, i = 0;
  while (x >= 1024 && i < u.length - 1) { x /= 1024; i += 1; }
  return `${x.toFixed(x >= 100 ? 0 : 1)} ${u[i]}`;
}

/** Provenance card rows: every row present; a missing value says UNKNOWN. */
export function provenanceRows(d: DsDataset): [string, string][] {
  const v = d.active_version;
  const s = d.source;
  return [
    ['Publisher', orUnknown(s?.publisher)],
    ['Source URL', orUnknown(s?.url || v?.http?.url)],
    ['Access', orUnknown(s?.access_method)],
    ['Licence', orUnknown(v?.licence_text ?? s?.licence_text)],
    ['Licence URL', orUnknown(v?.licence_url || s?.licence_url)],
    ['Observed', v ? `${orUnknown(v.observation_start)} → ${orUnknown(v.observation_end)}` : UNKNOWN],
    ['Published', orUnknown(v?.published_date)],
    ['Source updated', orUnknown(v?.source_updated_date)],
    ['Retrieved', v ? (v.retrieved_at ?? 'never stored (streamed / catalogue only)') : UNKNOWN],
    ['CRS', orUnknown(v?.crs)],
    ['Resolution / scale', orUnknown(v?.resolution)],
    ['Format · size', v ? `${orUnknown(v.format)} · ${formatBytes(v.size_bytes)}` : UNKNOWN],
    ['sha256', orUnknown(v?.sha256)],
    ['Class', v?.data_class ? DATA_CLASS_LABEL[v.data_class] : 'not classified'],
    ['Suitable for', orUnknown(v?.suitability)],
    ['Accuracy', orUnknown(v?.accuracy_statement)],
  ];
}

export interface DatasetGroup { status: DatasetStatus; label: string; items: DsDataset[] }

export function filterDatasets(list: DsDataset[], query: string, theme: string | null): DsDataset[] {
  const q = query.trim().toLowerCase();
  return list.filter(d => (!theme || d.theme === theme)
    && (!q || `${d.id} ${d.title} ${d.theme} ${d.source?.publisher ?? ''}`.toLowerCase().includes(q)));
}

export function groupDatasets(list: DsDataset[]): DatasetGroup[] {
  return STATUS_ORDER.map(status => ({ status, label: STATUS_LABEL[status], items: list.filter(d => d.status === status).sort((a, b) => a.title.localeCompare(b.title)) }))
    .filter(g => g.items.length > 0);
}

export function qualitySummary(checks: QualityCheck[]): { pass: number; warn: number; fail: number; unknown: number; worst: CheckStatus | null } {
  const c = { pass: 0, warn: 0, fail: 0, unknown: 0 };
  for (const q of checks) {
    if (q.status === 'pass') c.pass += 1;
    else if (q.status === 'warn') c.warn += 1;
    else if (q.status === 'fail') c.fail += 1;
    else if (q.status === 'unknown') c.unknown += 1;
  }
  const worst: CheckStatus | null = c.fail ? 'fail' : c.warn ? 'warn' : c.unknown ? 'unknown' : c.pass ? 'pass' : null;
  return { ...c, worst };
}

export interface Footprint {
  /** 'none' = coverage UNKNOWN; 'covers' = stated coverage contains the whole frame; 'outside' = no overlap. */
  kind: 'none' | 'covers' | 'partial' | 'outside';
  rect: { x: number; y: number; w: number; h: number } | null;
  frame: [number, number, number, number];
  percentOfPune: number | null;
}

/**
 * Coverage footprint drawn against a frame around the Pune study box (SVG units, y down). The rectangle is clipped to the
 * frame; a coverage larger than the frame is reported as 'covers'.
 */
export function footprint(bbox: [number, number, number, number] | null | undefined, width = 200, height = 160, pad = 0.15): Footprint {
  const [a0, b0, a1, b1] = PUNE_BBOX;
  const dx = (a1 - a0) * pad, dy = (b1 - b0) * pad;
  const frame: [number, number, number, number] = [a0 - dx, b0 - dy, a1 + dx, b1 + dy];
  if (!bbox || bbox.length !== 4 || bbox.some(v => !Number.isFinite(v))) return { kind: 'none', rect: null, frame, percentOfPune: null };
  const [x0, y0, x1, y1] = bbox;
  const ix = Math.max(0, Math.min(a1, x1) - Math.max(a0, x0));
  const iy = Math.max(0, Math.min(b1, y1) - Math.max(b0, y0));
  const percentOfPune = Math.round(((ix * iy) / ((a1 - a0) * (b1 - b0))) * 1000) / 10;
  const cx0 = Math.max(frame[0], x0), cy0 = Math.max(frame[1], y0), cx1 = Math.min(frame[2], x1), cy1 = Math.min(frame[3], y1);
  if (cx0 >= cx1 || cy0 >= cy1) return { kind: 'outside', rect: null, frame, percentOfPune };
  const sx = width / (frame[2] - frame[0]), sy = height / (frame[3] - frame[1]);
  const rect = { x: (cx0 - frame[0]) * sx, y: (frame[3] - cy1) * sy, w: (cx1 - cx0) * sx, h: (cy1 - cy0) * sy };
  const covers = x0 <= frame[0] && y0 <= frame[1] && x1 >= frame[2] && y1 >= frame[3];
  return { kind: covers ? 'covers' : 'partial', rect, frame, percentOfPune };
}

/** Pune study box in the same SVG frame. */
export function puneRect(width = 200, height = 160, pad = 0.15) {
  const f = footprint(PUNE_BBOX, width, height, pad);
  return f.rect!;
}

export interface CapabilityGroup { capability: string; features: FeatureReadiness[]; counts: Record<FeatureStatus, number> }

export function groupFeatures(features: FeatureReadiness[]): CapabilityGroup[] {
  const caps = [...CAPABILITY_ORDER, ...[...new Set(features.map(f => f.capability))].filter(c => !CAPABILITY_ORDER.includes(c))];
  return caps.map(capability => {
    const fs = features.filter(f => f.capability === capability);
    const counts = { ready: 0, partial: 0, blocked: 0 } as Record<FeatureStatus, number>;
    fs.forEach(f => { counts[f.status] += 1; });
    return { capability, features: fs, counts };
  }).filter(g => g.features.length > 0);
}

/** Model-trust badge for a feature whose cap comes from the traffic validation failure. */
export function featureFailsValidation(f: FeatureReadiness): boolean {
  return /TAG M3\.1|fails validation|validation failure/i.test(f.status_cap_reason ?? '');
}

/** One-line catalogue summary for the Reports panel. */
export function catalogueSummary(list: DsDataset[]): Record<DatasetStatus, number> & { total: number } {
  const s = { available: 0, synthetic: 0, pending_review: 0, not_acquired: 0, total: list.length };
  list.forEach(d => { s[d.status] += 1; });
  return s;
}

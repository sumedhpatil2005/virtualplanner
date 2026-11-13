/**
 * Grouping of the environment catalogue (GET /api/coordination/environment-layers) into the Environment workspace's
 * domain groups (docs/urbanos/UX_ARCHITECTURE.md §8). Pure, so it is unit-testable without a backend.
 */
import type { EnvironmentLayer } from '../../lib/coordinationApi';

export type EnvGroupId = 'water' | 'ground' | 'air' | 'noise' | 'heat' | 'vegetation' | 'heritage' | 'infrastructure' | 'other';

export const ENV_GROUPS: { id: EnvGroupId; label: string; domains: string[] }[] = [
  { id: 'water', label: 'Water & flooding', domains: ['water', 'flood', 'drainage', 'groundwater'] },
  { id: 'ground', label: 'Ground & geology', domains: ['geology', 'soil', 'seismic', 'terrain'] },
  { id: 'air', label: 'Air', domains: ['air'] },
  { id: 'noise', label: 'Noise', domains: ['noise'] },
  { id: 'heat', label: 'Heat', domains: ['heat'] },
  { id: 'vegetation', label: 'Vegetation', domains: ['vegetation'] },
  { id: 'heritage', label: 'Heritage & protected', domains: ['heritage', 'protected'] },
  // Not environmental domains, but constraint layers the catalogue carries and feasibility screening reads
  { id: 'infrastructure', label: 'Infrastructure constraints', domains: ['metro', 'railway'] },
];

export interface EnvGroup { id: EnvGroupId; label: string; layers: EnvironmentLayer[]; available: number }

/** Every catalogue row lands in exactly one group; an unmapped domain goes to "Other" rather than disappearing. */
export function groupCatalogue(layers: EnvironmentLayer[]): EnvGroup[] {
  const out: EnvGroup[] = ENV_GROUPS.map(g => ({ id: g.id, label: g.label, layers: [], available: 0 }));
  const other: EnvGroup = { id: 'other', label: 'Other', layers: [], available: 0 };
  for (const l of layers) {
    const gi = ENV_GROUPS.findIndex(g => g.domains.includes(l.domain));
    const g = gi >= 0 ? out[gi] : other;
    g.layers.push(l);
    if (l.status === 'available') g.available++;
  }
  // Available rows first inside a group, then by name
  for (const g of [...out, other]) g.layers.sort((a, b) => Number(b.status === 'available') - Number(a.status === 'available') || a.name.localeCompare(b.name));
  return [...out, ...(other.layers.length ? [other] : [])];
}

/**
 * Catalogue id → what toggling it shows on the map. 'overlay' = drawn from GET /api/feasibility/site-data (the same
 * OSM-derived features feasibility screening reads); 'engine' = an existing engine layer (LayerManager registry id).
 * A layer not listed here has no map rendering, so it gets no toggle.
 */
export const MAP_TOGGLES: Record<string, { kind: 'overlay'; key: OverlayKey } | { kind: 'engine'; layerId: string }> = {
  osm_water: { kind: 'overlay', key: 'water' },
  osm_heritage: { kind: 'overlay', key: 'heritage' },
  osm_railway: { kind: 'overlay', key: 'railway' },
  osm_metro: { kind: 'engine', layerId: 'metro' },
};

export type OverlayKey = 'water' | 'heritage' | 'railway';

/** "Mon 2026-11-02 2:51 AM IST (UTC+05:30)" → "2026-11-02"; ISO → date part; null → null. */
export function shortDate(s: string | null | undefined): string | null {
  if (!s) return null;
  const m = /(\d{4}-\d{2}-\d{2})/.exec(s);
  return m ? m[1] : s;
}

/** DataStatus value for a catalogue row: available rows carry the row's own source/date/licence (missing → shown as unknown). */
export function dataStatusOf(l: EnvironmentLayer):
  | { status: 'available'; source: string; date: string; licence: string }
  | { status: 'not_imported' } {
  if (l.status !== 'available') return { status: 'not_imported' };
  return { status: 'available', source: l.source ?? '', date: shortDate(l.data_date) ?? '', licence: l.licence ?? '' };
}

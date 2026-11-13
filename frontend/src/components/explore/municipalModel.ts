/**
 * Pure helpers for Explore → Municipal infrastructure (docs/urbanos/INFRASTRUCTURE_DATA.md): layer styling, the
 * attribute-inspector rows (source / date / licence / class first, then the feature's own attributes), and the status
 * line of a loaded layer. No Cesium or engine import, so it is unit-testable.
 */
import type { InfraFeatureCollection, InfraLayer } from '../../lib/infraApi';

export const LAYER_COLOR: Record<string, string> = {
  sewer: '#B07A3B', storm_drains: '#2FB3C8', swd_chambers: '#5FD3E0', swd_utility_chambers: '#8FE3EA', nallas: '#3E8EDE',
  rivers: '#2F6FD0', water_bodies: '#62A8FF', road_centreline: '#E0E0E0', bus_stops: '#F2C14E', bus_depots: '#E89B2E',
  wards_2025: '#C77DFF', wards_2022: '#9D7BD8', wards_2017: '#8A79B8', wards_2012: '#776F96', admin_wards_2017: '#E06FA8',
  prabhag: '#B88AE0', zones: '#FF8FB1', revenue_parcels: '#A3B18A', fire_stations: '#FF5A4E', public_toilets: '#9CC5A1',
  parks: '#4CAF50', libraries: '#D4A5FF', crematoriums: '#9E9E9E', stps: '#8D6E63', buildings: '#FFB347',
};
export const BUILDING_SOURCE_COLOR: Record<string, string> = { osm: '#FFB347', google_open_buildings_v3: '#4FC3F7', ms_global_ml_buildings: '#BA68C8' };

export const colorOf = (layerId: string, props?: Record<string, unknown>): string =>
  layerId === 'buildings' && typeof props?.source === 'string' ? (BUILDING_SOURCE_COLOR[props.source] ?? LAYER_COLOR.buildings) : (LAYER_COLOR[layerId] ?? '#CCCCCC');

/** Subgroups in display order; anything else after them. */
export const SUBGROUP_ORDER = ['Drainage & sewer', 'Water', 'Roads & transport', 'Boundaries', 'Facilities', 'Buildings'];

export function orderLayers(layers: readonly InfraLayer[]): { subgroup: string; layers: InfraLayer[] }[] {
  const subs = [...new Set(layers.map(l => l.subgroup))].sort((a, b) => {
    const ia = SUBGROUP_ORDER.indexOf(a), ib = SUBGROUP_ORDER.indexOf(b);
    return (ia < 0 ? 99 : ia) - (ib < 0 ? 99 : ib) || a.localeCompare(b);
  });
  return subs.map(s => ({ subgroup: s, layers: layers.filter(l => l.subgroup === s).sort((a, b) => Number(b.active) - Number(a.active)) }));
}

export interface InspectorRow { label: string; value: string; tone?: 'unknown' | 'warn' }

const CLASS_TEXT: Record<string, string> = {
  observed: 'Observed (as published by the agency)', inferred: 'Inferred (machine-learning detection)', estimated: 'Estimated',
  derived: 'Derived', synthetic: 'SYNTHETIC',
};

/** Rows shown for one clicked feature: provenance first (never empty — UNKNOWN when missing), then attributes. */
export function inspectorRows(layer: InfraLayer, props: Record<string, unknown>): { provenance: InspectorRow[]; attributes: InspectorRow[] } {
  const u = (v: unknown) => (v === null || v === undefined || v === '' ? 'UNKNOWN' : String(v));
  const featureClass = typeof props.data_class === 'string' ? props.data_class : layer.data_class;
  const provenance: InspectorRow[] = [
    { label: 'Layer', value: layer.title },
    { label: 'Source', value: layer.id === 'buildings' && typeof props.source === 'string' ? `${sourceLabel(props.source)} (${u(props.source_id)})` : `${u(layer.publisher)} · via ${u(layer.via)}` },
    { label: 'Source date', value: u(layer.source_updated), tone: layer.source_updated ? undefined : 'unknown' },
    { label: 'Retrieved', value: u(layer.retrieved_at) },
    { label: 'Licence', value: layer.licence || 'UNKNOWN', tone: /NON-COMMERCIAL|UNKNOWN/i.test(layer.licence) ? 'warn' : undefined },
    { label: 'Class', value: CLASS_TEXT[featureClass] ?? u(featureClass) },
    { label: 'Suitable for', value: layer.suitability === 'engineering' ? 'engineering' : `${layer.suitability} only` },
  ];
  const attributes: InspectorRow[] = [];
  if (layer.id === 'buildings') {
    attributes.push({ label: 'Confidence', value: props.confidence == null ? 'UNKNOWN (not published by this source)' : `${String(props.confidence)} (model score 0–1)`, tone: props.confidence == null ? 'unknown' : undefined });
    attributes.push({ label: 'OSM agreement', value: statusLabel(String(props.status ?? '')) });
    attributes.push({ label: 'Height', value: props.height_m == null ? 'UNKNOWN (not tagged)' : `${props.height_m} m — ${u(props.height_basis)}`, tone: props.height_m == null ? 'unknown' : undefined });
    if (props.levels_tag) attributes.push({ label: 'Levels (OSM tag)', value: String(props.levels_tag) });
    if (props.area_m2 != null) attributes.push({ label: 'Footprint area', value: `${props.area_m2} m²` });
    return { provenance, attributes };
  }
  if (layer.id === 'sewer') {
    attributes.push({ label: 'Depth to invert', value: props.invert_depth_max_m == null ? 'UNKNOWN' : `${props.invert_depth_min_m}–${props.invert_depth_max_m} m (DESIGN levels, unverified)`, tone: props.invert_depth_max_m == null ? 'unknown' : 'warn' });
    attributes.push({ label: 'Diameter', value: props.diameter_m == null ? 'UNKNOWN' : `${Math.round(Number(props.diameter_m) * 1000)} mm` });
    attributes.push({ label: 'Quality level', value: 'ASCE 38 QL-D (records)' });
  }
  const skip = new Set(['_fid', '_ext_id', 'data_class', 'depth_basis', 'levels_status', 'invert_depth_max_m', 'invert_depth_min_m', 'top_depth_m', 'diameter_m']);
  for (const [k, v] of Object.entries(props)) {
    if (skip.has(k) || v === null || v === undefined || v === '') continue;
    attributes.push({ label: k, value: (typeof v === 'object' ? JSON.stringify(v) : String(v)) + (ATTR_UNIT[k] ?? '') });
    if (attributes.length >= 18) break;
  }
  return { provenance, attributes };
}

export function sourceLabel(s: string): string {
  return ({ osm: 'OpenStreetMap (volunteer-mapped)', google_open_buildings_v3: 'Google Open Buildings v3 (ML)', ms_global_ml_buildings: 'Microsoft ML footprints' } as Record<string, string>)[s] ?? s;
}
export function statusLabel(s: string): string {
  return ({ osm: 'OSM footprint', agrees_with_osm: 'ML footprint agreeing with OSM (≥30% overlap)', ml_only_candidate: 'ML only — not in OSM (candidate)' } as Record<string, string>)[s] ?? (s || 'UNKNOWN');
}

/** One-line status of a loaded layer: counts, the cap, or why nothing was loaded. */
export function loadedLine(fc: Pick<InfraFeatureCollection, 'returned' | 'total_in_bbox' | 'not_shown' | 'truncated' | 'too_large' | 'message' | 'cap'>): string {
  if (fc.too_large) return fc.message ?? 'Zoom in to load this layer.';
  if (fc.truncated) return `${fc.returned.toLocaleString()} shown · ${(fc.not_shown ?? 0).toLocaleString()} more in view not shown (cap ${fc.cap.toLocaleString()}) — zoom in`;
  if (fc.returned === 0) return 'No features in view (absence of a record is not evidence)';
  return `${fc.returned.toLocaleString()} feature${fc.returned === 1 ? '' : 's'} in view`;
}

/** Boxes [minLon, minLat, maxLon, maxLat] overlap; an unknown layer extent never blocks a request. */
export function intersects(a: readonly number[], b: readonly number[] | null | undefined): boolean {
  if (!b || b.length !== 4) return true;
  return a[0] <= b[2] && b[0] <= a[2] && a[1] <= b[3] && b[1] <= a[3];
}
export const outsideLine = () => 'View is outside this layer\'s coverage (Pune study area): nothing to load here.';

/** A feature count with its unit. */
export const featuresText = (n: number | null | undefined) => (n == null ? 'count UNKNOWN' : `${n.toLocaleString()} feature${n === 1 ? '' : 's'}`);

/** Units of publisher attributes where the meaning is clear from the PMC sewer schema; others are shown as published. */
const ATTR_UNIT: Record<string, string> = { pipeline_d: ' mm (internal diameter)', tl_start_m: ' m (cover level, RL)', tl_end_man: ' m (cover level, RL)', start_inve: ' m (invert level, RL)', end_invert: ' m (invert level, RL)', area_m2: ' m²', i_length: ' m', st_length_: ' m', Shape_Length: ' (as published, unit not stated)' };

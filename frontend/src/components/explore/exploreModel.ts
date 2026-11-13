/**
 * Pure helpers for the Explore workspace (docs/urbanos/ENVIRONMENT_EXPLORE_SIMULATE.md): layer-tree grouping of the
 * engine's layer registry, object search by name / OSM id, the selected-object summary and city stats. No engine
 * import, so it is unit-testable.
 */
import type { CityObject } from '../../engine/objects/types';
import type { Certainty } from '../../engine/objects/certainty';

export type TreeGroupId = 'base' | 'buildings' | 'transport' | 'utilities' | 'landuse' | 'debug';
export const TREE_GROUPS: { id: TreeGroupId; label: string; layers: string[] }[] = [
  { id: 'base', label: 'Base map', layers: ['satellite', 'terrain'] },
  { id: 'buildings', label: 'Buildings', layers: ['buildings'] },
  { id: 'transport', label: 'Transport', layers: ['roads', 'junctions', 'metro', 'gateways'] },
  { id: 'utilities', label: 'Utilities', layers: ['water_util', 'electric_util', 'sewage_util', 'gas_util', 'fiber_util'] },
  { id: 'landuse', label: 'Land use / demand zones', layers: ['demand_zones'] },
  { id: 'debug', label: 'Simulation', layers: ['traffic_network_debug'] },
];

export interface LayerLike { id: string; name: string; category: string; visible: boolean }

/** Every registry layer lands in one group; one not listed above goes to the group of its registry category. */
export function groupLayers<L extends LayerLike>(layers: L[]): { id: TreeGroupId; label: string; layers: L[] }[] {
  const byCat: Record<string, TreeGroupId> = { base: 'base', infrastructure: 'transport', utilities: 'utilities', simulations: 'debug' };
  const out = TREE_GROUPS.map(g => ({ id: g.id, label: g.label, layers: [] as L[] }));
  for (const l of layers) {
    const gi = TREE_GROUPS.findIndex(g => g.layers.includes(l.id));
    const id = gi >= 0 ? TREE_GROUPS[gi].id : (byCat[l.category] ?? 'transport');
    out.find(g => g.id === id)!.layers.push(l);
  }
  return out.filter(g => g.layers.length > 0);
}

export function osmIdOf(o: CityObject): number | null {
  const r = o as { osmProvenance?: { osmId?: number }; osmId?: number };
  return r.osmProvenance?.osmId ?? r.osmId ?? null;
}

const TYPE_LABEL: Record<string, string> = {
  road: 'Road', building: 'Building', junction: 'Junction', flyover: 'Flyover', utility: 'Utility line', metro_line: 'Metro line',
  metro_station: 'Metro station', zone: 'Demand zone', gateway: 'Gateway', metro_flyover: 'Double-deck',
};
export const typeLabel = (t: string) => TYPE_LABEL[t] ?? t;

/** Name substring (case-insensitive) or OSM id (digits, optional "way/"/"node/" prefix). Exact OSM id first, then by name. */
export function searchObjects(objects: readonly CityObject[], query: string, limit = 12): CityObject[] {
  const q = query.trim().toLowerCase();
  if (q.length < 2) return [];
  const idQ = /^(?:way\/|node\/|relation\/|osm:?\s*)?(\d{3,})$/.exec(q)?.[1];
  const hits: { o: CityObject; rank: number }[] = [];
  for (const o of objects) {
    if (idQ) {
      const id = osmIdOf(o);
      if (id !== null && String(id) === idQ) hits.push({ o, rank: 0 });
      continue;
    }
    const n = (o.name ?? '').toLowerCase();
    if (!n) continue;
    const i = n.indexOf(q);
    if (i >= 0) hits.push({ o, rank: i === 0 ? 1 : 2 });
  }
  hits.sort((a, b) => a.rank - b.rank || (a.o.name ?? '').localeCompare(b.o.name ?? ''));
  // Roads are split into many pieces with the same name: keep one hit per (type, name) for name searches
  const seen = new Set<string>();
  const out: CityObject[] = [];
  for (const h of hits) {
    const key = idQ ? h.o.id : `${h.o.type}|${h.o.name}`;
    if (seen.has(key)) continue;
    seen.add(key);
    out.push(h.o);
    if (out.length >= limit) break;
  }
  return out;
}

export interface SummaryRow { label: string; value: string; certainty?: Certainty }

/** Key attributes per type. A certainty is attached only where the object records one (valueCertainty / depthCertainty). */
export function summarise(o: CityObject): { type: string; rows: SummaryRow[]; source: string } {
  const vc = o.valueCertainty ?? {};
  const rows: SummaryRow[] = [];
  const add = (label: string, value: unknown, field?: string, unit = '') => {
    if (value === undefined || value === null || value === '') return;
    rows.push({ label, value: `${typeof value === 'number' ? Math.round(value * 10) / 10 : String(value)}${unit}`, certainty: field ? vc[field] : undefined });
  };
  const r = o as unknown as Record<string, unknown>;
  switch (o.type) {
    case 'road': case 'flyover': case 'metro_flyover':
      add('Lanes', r.laneCount, 'laneCount'); add('Width', r.width, 'width', ' m'); add('Speed limit', r.speedLimit, 'speedLimit', ' km/h');
      if (typeof r.isOneWay === 'boolean') add('One way', r.isOneWay ? 'yes' : 'no');
      add('Deck height', r.elevation, 'elevation', ' m');
      if (Array.isArray(o.coordinates)) add('Length', lineLengthKm(o.coordinates as number[][]) * 1000, undefined, ' m');
      break;
    case 'building':
      add('Height', r.height, 'height', ' m'); add('Floors', r.floors, 'floors'); add('Use', r.category ?? r.usageType, 'category'); add('Built', r.constructionYear, 'constructionYear'); break;
    case 'junction':
      if (typeof r.hasSignals === 'boolean') add('Signals', r.hasSignals ? 'yes' : 'no', 'hasSignals');
      if (r.hasSignals) add('Signal cycle', r.signalTiming, 'signalTiming', ' s');
      if (Array.isArray(r.connectedRoads)) add('Roads meeting', (r.connectedRoads as unknown[]).length); break;
    case 'utility':
      add('Utility', r.utilityType); add('Depth', r.depth, 'depth', ' m');
      { const d = rows.find(x => x.label === 'Depth'); if (d) d.certainty = (r.depthCertainty as Certainty | undefined) ?? d.certainty ?? 'unknown'; }
      add('Diameter', r.diameterMm, 'diameterMm', ' mm'); break;
    default: break;
  }
  const osm = osmIdOf(o);
  const src = (r.source as string | undefined) ?? (r.provenance as { source?: string } | undefined)?.source;
  const source = osm !== null ? `OpenStreetMap id ${osm}` : src ? String(src) : 'Not recorded';
  return { type: typeLabel(o.type), rows, source };
}

const R = 6371.0088;
export function lineLengthKm(coords: number[][]): number {
  let km = 0;
  for (let i = 1; i < coords.length; i++) {
    const [lo1, la1] = coords[i - 1], [lo2, la2] = coords[i];
    const p1 = la1 * Math.PI / 180, p2 = la2 * Math.PI / 180, dp = p2 - p1, dl = (lo2 - lo1) * Math.PI / 180;
    const a = Math.sin(dp / 2) ** 2 + Math.cos(p1) * Math.cos(p2) * Math.sin(dl / 2) ** 2;
    km += 2 * R * Math.asin(Math.min(1, Math.sqrt(a)));
  }
  return km;
}

/**
 * Stats of the loaded objects: road km (centrelines, each carriageway counted as drawn), buildings, junctions.
 * Junctions = placed junction objects + road-network nodes (estimated from geometry): a vertex shared by at least two
 * road pieces where at least three arms meet (an end counts one arm, a pass-through vertex two). Vertices are matched
 * at ~0.1 m (1e-6°). Grade-separated crossings that share no vertex are not counted.
 */
export function cityStats(objects: readonly CityObject[]): { roadKm: number; roads: number; buildings: number; junctions: number; placedJunctions: number; networkNodes: number; proposals: number } {
  let roadKm = 0, roads = 0, buildings = 0, placedJunctions = 0, proposals = 0;
  const nodes = new Map<string, { arms: number; roads: number; last: string }>();
  for (const o of objects) {
    if (o.scenarioId !== 'base') proposals++;
    if (o.type === 'road') {
      roads++;
      const cs = o.coordinates as number[][];
      roadKm += lineLengthKm(cs);
      cs.forEach((c, i) => {
        const k = `${Math.round(c[0] * 1e6)},${Math.round(c[1] * 1e6)}`;
        const n = nodes.get(k) ?? { arms: 0, roads: 0, last: '' };
        n.arms += i === 0 || i === cs.length - 1 ? 1 : 2;
        if (n.last !== o.id) { n.roads++; n.last = o.id; }
        nodes.set(k, n);
      });
    }
    else if (o.type === 'building') buildings++;
    else if (o.type === 'junction') placedJunctions++;
  }
  let networkNodes = 0;
  for (const n of nodes.values()) if (n.roads >= 2 && n.arms >= 3) networkNodes++;
  return { roadKm, roads, buildings, junctions: placedJunctions + networkNodes, placedJunctions, networkNodes, proposals };
}

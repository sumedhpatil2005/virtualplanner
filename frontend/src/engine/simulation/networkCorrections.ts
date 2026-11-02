/**
 * Local network-correction layer: documented, versioned fixes to the imported
 * OpenStreetMap roads (backend/data/network_corrections/*.json), applied when
 * the simulation network is built. OpenStreetMap and the stored project roads
 * are never changed, so every correction can be switched off again.
 *
 * Also applies OSM tag implications the importer used to miss on roads
 * imported before it was fixed: junction=roundabout (or circular) implies
 * oneway=yes unless the way says oneway=no (OSM wiki, Tag:junction=roundabout).
 */
import type { DrivableObject } from './StudyAreaExplorer';
import type { RoadObject } from '../objects/types';

export type CorrectionAction = 'reverse' | 'set_two_way' | 'set_oneway' | 'set_lanes' | 'set_roundabout';

export interface NetworkCorrection {
  id: string;
  junction_id: string;
  osm_way_id: number;
  action: CorrectionAction;
  params: { lanes?: number; lanes_forward?: number; lanes_backward?: number; reverse?: boolean };
  evidence: string[];
  confidence: 'high' | 'medium' | 'low';
  proposed_osm_edit: string;
  enabled: boolean;
}

export interface NetworkCorrectionLayer {
  schema: 'twincity.network_corrections/v1';
  id: string;
  version: string;
  title: string;
  osm_snapshot: string;
  corrections: NetworkCorrection[];
}

export interface CorrectionReport {
  /** Corrections applied, with the project roads (ids) they changed. */
  applied: { id: string; roadIds: string[] }[];
  /** Enabled corrections whose way is not among the roads given (outside the project). */
  notFound: string[];
  /** Roads made one-way because junction=roundabout implies it. */
  impliedOneWay: string[];
}

const ACTIONS: readonly CorrectionAction[] = ['reverse', 'set_two_way', 'set_oneway', 'set_lanes', 'set_roundabout'];

/** Checks a layer read from the backend; throws with the first problem found. */
export function validateCorrectionLayer(layer: unknown): NetworkCorrectionLayer {
  const l = layer as NetworkCorrectionLayer;
  if (!l || l.schema !== 'twincity.network_corrections/v1') throw new Error('Not a twincity.network_corrections/v1 layer.');
  const seen = new Set<string>();
  for (const c of l.corrections ?? []) {
    if (!c.id || seen.has(c.id)) throw new Error(`Correction id missing or repeated: ${c.id}`);
    seen.add(c.id);
    if (!Number.isInteger(c.osm_way_id)) throw new Error(`${c.id}: osm_way_id must be an OSM way id`);
    if (!ACTIONS.includes(c.action)) throw new Error(`${c.id}: unknown action ${c.action}`);
    if (!Array.isArray(c.evidence) || !c.evidence.length) throw new Error(`${c.id}: a correction needs evidence`);
    if (c.action === 'set_lanes' && !(Number(c.params?.lanes) >= 1)) throw new Error(`${c.id}: set_lanes needs params.lanes`);
    if (c.action === 'set_two_way' && !(Number(c.params?.lanes_forward) >= 1 && Number(c.params?.lanes_backward) >= 1)) throw new Error(`${c.id}: set_two_way needs lanes_forward and lanes_backward`);
  }
  return l;
}

const osmWayOf = (r: DrivableObject): number | undefined => (r.type === 'road' ? (r as RoadObject).osmProvenance?.osmId : undefined) as number | undefined;

function reverseRoad(r: RoadObject): RoadObject {
  const n = r.coordinates.length;
  const out: RoadObject = { ...r, coordinates: [...r.coordinates].reverse() };
  if (r.sourceCoordinates) out.sourceCoordinates = [...r.sourceCoordinates].reverse();
  if (r.sections) {
    out.sections = [...r.sections].reverse().map(s => ({ ...s, startNodeIndex: n - 1 - s.endNodeIndex, endNodeIndex: n - 1 - s.startNodeIndex }));
  }
  return out;
}

function setOneWay(r: RoadObject, lanes: number): RoadObject {
  return {
    ...r, isOneWay: true, laneCount: lanes, trafficCapacity: lanes * 1000,
    sections: r.sections?.map(s => ({ ...s, carriagewayA: s.carriagewayA ? { ...s.carriagewayA, direction: 'forward' as const, lanes } : s.carriagewayA, carriagewayB: undefined })),
  };
}

function setTwoWay(r: RoadObject, fwd: number, bwd: number): RoadObject {
  return {
    ...r, isOneWay: false, laneCount: fwd + bwd, trafficCapacity: (fwd + bwd) * 1000,
    sections: r.sections?.map(s => ({
      ...s,
      carriagewayA: s.carriagewayA ? { ...s.carriagewayA, direction: 'forward' as const, lanes: fwd } : s.carriagewayA,
      carriagewayB: { ...(s.carriagewayB ?? s.carriagewayA!), direction: 'backward' as const, lanes: bwd },
    })),
  };
}

/** One-way roundabout pieces imported as two-way before the importer honoured junction=roundabout. */
export function impliesOneWay(tags: Record<string, string> | undefined): boolean {
  if (!tags) return false;
  return (tags.junction === 'roundabout' || tags.junction === 'circular') && tags.oneway !== 'no' && tags.oneway !== '-1';
}

/**
 * Returns the roads with the layer's enabled corrections applied (corrected
 * copies; untouched roads are passed through as they are). `layer` null or
 * `enabled` false applies only the OSM tag implications.
 */
export function applyNetworkCorrections(roads: readonly DrivableObject[], layer: NetworkCorrectionLayer | null, enabled = true):
  { roads: DrivableObject[]; report: CorrectionReport } {
  const report: CorrectionReport = { applied: [], notFound: [], impliedOneWay: [] };
  const byWay = new Map<number, NetworkCorrection[]>();
  if (layer && enabled) for (const c of layer.corrections) if (c.enabled !== false) {
    if (!byWay.has(c.osm_way_id)) byWay.set(c.osm_way_id, []);
    byWay.get(c.osm_way_id)!.push(c);
  }
  const touched = new Map<string, string[]>();
  const out = roads.map(r0 => {
    if (r0.type !== 'road') return r0;
    let r = r0 as RoadObject;
    if (!r.isOneWay && impliesOneWay(r.osmProvenance?.originalTags as Record<string, string> | undefined)) {
      r = setOneWay(r, Math.max(1, r.sections?.[0]?.carriagewayA?.lanes ?? r.laneCount ?? 1));
      report.impliedOneWay.push(r.id);
    }
    const way = osmWayOf(r);
    const fixes = way === undefined ? undefined : byWay.get(way);
    if (fixes) for (const c of fixes) {
      switch (c.action) {
        case 'reverse': r = reverseRoad(r); break;
        case 'set_oneway': r = setOneWay(c.params.reverse ? reverseRoad(r) : r, Math.max(1, r.sections?.[0]?.carriagewayA?.lanes ?? 1)); break;
        case 'set_two_way': r = setTwoWay(r, c.params.lanes_forward!, c.params.lanes_backward!); break;
        case 'set_lanes': r = r.isOneWay ? setOneWay(r, c.params.lanes!) : { ...r, laneCount: c.params.lanes! }; break;
        case 'set_roundabout': r = { ...r, osmProvenance: { ...r.osmProvenance!, roundabout: true } }; break;
      }
      if (!touched.has(c.id)) touched.set(c.id, []);
      touched.get(c.id)!.push(r.id);
    }
    return r;
  });
  if (layer && enabled) for (const c of layer.corrections) {
    if (c.enabled === false) continue;
    if (touched.has(c.id)) report.applied.push({ id: c.id, roadIds: touched.get(c.id)! });
    else report.notFound.push(c.id);
  }
  return { roads: out, report };
}

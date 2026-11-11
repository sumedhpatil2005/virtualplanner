/**
 * Turns a drawn city object into a ProposalInput, and the rest of the scenario
 * into the city context the engine screens against. The proposal type is a
 * user choice; the defaults below are only a starting point shown in the UI.
 */
import type { CityObject } from '../objects/types';
import type { CityContextObject, ProposalInput, ProposalLevel, ProposalType } from './types';

export const PROPOSAL_TYPES_FOR: Record<'road' | 'flyover' | 'metro_flyover', ProposalType[]> = {
  road: ['new_road', 'road_widening', 'additional_lane', 'tunnel', 'underground_road', 'underpass', 'bridge', 'ramp_link', 'junction_redesign'],
  flyover: ['flyover', 'elevated_corridor', 'interchange', 'ramp_link', 'bridge'],
  metro_flyover: ['elevated_corridor', 'flyover'],
};

export function isProposalObject(o: CityObject | null | undefined): o is Extract<CityObject, { type: 'road' | 'flyover' | 'metro_flyover' }> {
  return !!o && (o.type === 'road' || o.type === 'flyover' || o.type === 'metro_flyover') && (o as { coordinates: unknown[] }).coordinates.length >= 2;
}

export function defaultLevel(t: ProposalType): ProposalLevel {
  if (t === 'tunnel' || t === 'underground_road' || t === 'underpass') return 'underground';
  if (t === 'flyover' || t === 'elevated_corridor' || t === 'interchange' || t === 'bridge') return 'elevated';
  return 'surface';
}

export function defaultProposalType(o: CityObject): ProposalType {
  if (o.type === 'flyover') return 'flyover';
  if (o.type === 'metro_flyover') return 'elevated_corridor';
  if (o.type === 'road') {
    if (o.osmProvenance?.tunnel || (o.osmProvenance?.layer ?? 0) < 0) return 'tunnel';
    if (o.osmProvenance) return 'road_widening'; // an imported road being changed
    return 'new_road';
  }
  return 'new_road';
}

export function proposalFromObject(o: CityObject, type: ProposalType, opts: { level?: ProposalLevel; widthM?: number; excavationDepthM?: number | null; scenarioVersion?: string | null } = {}): ProposalInput {
  const coords = (o as { coordinates: [number, number, number][] }).coordinates;
  const width = opts.widthM ?? (o as { width?: number }).width ?? 7;
  return {
    name: o.name || `${type} ${o.id.slice(0, 8)}`,
    scenarioId: o.scenarioId,
    scenarioVersion: opts.scenarioVersion ?? null,
    objectIds: [o.id],
    proposalType: type,
    level: opts.level ?? defaultLevel(type),
    line: coords.map(c => [c[0], c[1]] as [number, number]),
    widthM: width,
    excavationDepthM: opts.excavationDepthM ?? null,
  };
}

export function cityContext(objects: CityObject[]): CityContextObject[] {
  const out: CityContextObject[] = [];
  for (const o of objects) {
    if (o.type === 'building' && o.coordinates.length >= 3) out.push({ id: o.id, type: 'building', name: o.name, coordinates: o.coordinates, osmId: o.osmId });
    else if (o.type === 'road' && o.coordinates.length >= 2) {
      const s = o.sections?.[0];
      out.push({ id: o.id, type: 'road', name: o.name, coordinates: o.coordinates, widthM: o.width, rowWidthM: s?.totalRowWidth,
        rowConfidence: s?.provenance?.originalConfidence, tunnel: !!o.osmProvenance?.tunnel, bridge: !!o.osmProvenance?.bridge, osmId: o.osmProvenance?.osmId });
    } else if ((o.type === 'flyover' || o.type === 'metro_flyover' || o.type === 'metro_line') && o.coordinates.length >= 2) {
      out.push({ id: o.id, type: o.type, name: o.name, coordinates: o.coordinates });
    } else if (o.type === 'utility' && o.coordinates.length >= 2) {
      out.push({ id: o.id, type: 'utility', name: o.name, coordinates: o.coordinates, utilityType: o.utilityType });
    }
  }
  return out;
}

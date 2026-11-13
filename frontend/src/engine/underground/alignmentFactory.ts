/**
 * Creating and editing underground alignments (docs/urbanos/UNDERGROUND_WORKSPACE.md). Pure functions: the
 * EditingEngine builds a new object with `buildAlignment`; inspector edits produce a new object with the `with*`
 * helpers, which the UI records for Undo (history.recordUpdate) and applies through ObjectManager.update, so scenario
 * copy-on-write applies exactly as for other objects.
 */
import type { Certainty } from '../objects/certainty';
import type { UndergroundAlignmentKind, UndergroundAlignmentObject, UndergroundSection, UndergroundVertexDepth } from '../objects/types';
import { ALIGNMENT_KIND_LABEL } from './alignmentGeometry';

/**
 * Drawing defaults per kind. These are NOT standards or typical values from a source: they are placeholders so a
 * new alignment has a visible size, stored as HYPOTHETICAL until the user edits them.
 */
export const DRAWING_DEFAULTS: Record<UndergroundAlignmentKind, { crownDepthM: number; section: UndergroundSection }> = {
  bored_tunnel: { crownDepthM: 15, section: { shape: 'circular', diameterM: 6 } },
  underground_metro: { crownDepthM: 15, section: { shape: 'circular', diameterM: 6 } },
  cut_and_cover: { crownDepthM: 3, section: { shape: 'box', widthM: 10, heightM: 7 } },
  utility_trunk: { crownDepthM: 4, section: { shape: 'circular', diameterM: 2 } },
  storm_drain: { crownDepthM: 2, section: { shape: 'box', widthM: 2, heightM: 1.5 } },
};

export const ALIGNMENT_KINDS = Object.keys(ALIGNMENT_KIND_LABEL) as UndergroundAlignmentKind[];

const pos = (v: number | null | undefined): number | null => (typeof v === 'number' && Number.isFinite(v) && v > 0 ? v : null);

/** A section with every non-positive / non-finite dimension turned into UNKNOWN (null), never 0. */
export function cleanSection(s: UndergroundSection): UndergroundSection {
  return s.shape === 'circular' ? { shape: 'circular', diameterM: pos(s.diameterM) } : { shape: 'box', widthM: pos(s.widthM), heightM: pos(s.heightM) };
}

/** Depth input: finite and ≥ 0 is kept (0 = crown at ground level), anything else is UNKNOWN. */
export const cleanDepth = (v: number | null | undefined): number | null => (typeof v === 'number' && Number.isFinite(v) && v >= 0 ? v : null);

export interface AlignmentDraft {
  id: string;
  scenarioId: string;
  points: [number, number, number][];
  kind: UndergroundAlignmentKind;
  crownDepthM: number | null;
  depthCertainty: Certainty;
  section: UndergroundSection;
  sectionCertainty: Certainty;
  createdAt: string;
  name?: string;
}

export function buildAlignment(d: AlignmentDraft): UndergroundAlignmentObject {
  if (d.points.length < 2) throw new Error('An underground alignment needs at least 2 points — keep clicking on the map, then double-click to finish.');
  const depth = cleanDepth(d.crownDepthM);
  return {
    id: d.id,
    type: 'underground_alignment',
    name: d.name ?? `${ALIGNMENT_KIND_LABEL[d.kind]} #${d.id.slice(0, 4)}`,
    layerId: 'underground',
    scenarioId: d.scenarioId,
    // plan vertices on the ground (z = 0: the depth lives in `depths`)
    coordinates: d.points.map(p => [p[0], p[1], 0] as [number, number, number]),
    alignmentKind: d.kind,
    section: cleanSection(d.section),
    sectionCertainty: d.sectionCertainty,
    depths: d.points.map(() => ({ crownDepthM: depth, certainty: depth === null ? 'unknown' : d.depthCertainty })),
    createdAt: d.createdAt,
    updatedAt: d.createdAt,
  };
}

/** New object with vertex `i`'s depth / certainty changed. A blank depth makes that vertex UNKNOWN. */
export function withVertexDepth(a: UndergroundAlignmentObject, i: number, patch: Partial<UndergroundVertexDepth>): UndergroundAlignmentObject {
  const depths = a.coordinates.map((_, k) => a.depths?.[k] ?? { crownDepthM: null, certainty: 'unknown' as Certainty });
  if (i < 0 || i >= depths.length) return a;
  const cur = depths[i];
  const crownDepthM = 'crownDepthM' in patch ? cleanDepth(patch.crownDepthM) : cur.crownDepthM;
  const certainty: Certainty = crownDepthM === null ? 'unknown' : (patch.certainty ?? (cur.certainty === 'unknown' ? 'hypothetical' : cur.certainty));
  depths[i] = { crownDepthM, certainty };
  return { ...a, depths, updatedAt: new Date().toISOString() };
}

/** New object with every vertex set to the same depth / certainty. */
export function withAllDepths(a: UndergroundAlignmentObject, crown: number | null, certainty: Certainty): UndergroundAlignmentObject {
  const d = cleanDepth(crown);
  return { ...a, depths: a.coordinates.map(() => ({ crownDepthM: d, certainty: d === null ? 'unknown' : certainty })), updatedAt: new Date().toISOString() };
}

export function withSection(a: UndergroundAlignmentObject, section: UndergroundSection, certainty?: Certainty): UndergroundAlignmentObject {
  return { ...a, section: cleanSection(section), sectionCertainty: certainty ?? a.sectionCertainty, updatedAt: new Date().toISOString() };
}

export function withKind(a: UndergroundAlignmentObject, kind: UndergroundAlignmentKind): UndergroundAlignmentObject {
  return { ...a, alignmentKind: kind, updatedAt: new Date().toISOString() };
}

export const isAlignment = (o: { type: string } | null | undefined): o is UndergroundAlignmentObject => !!o && o.type === 'underground_alignment';

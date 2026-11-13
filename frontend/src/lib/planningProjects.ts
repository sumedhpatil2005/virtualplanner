/**
 * View-model logic for the Projects & Coordination workspace (docs/urbanos/PROJECTS_AND_COORDINATION_UI.md).
 * Pure functions only (no fetch, no React) so they are unit-tested in isolation.
 *
 * Honesty rules: a depth / height we do not have is `null` (= UNKNOWN), never 0; a proposal's design values are
 * `hypothetical` (design inputs), never `measured`; "no conflict within available data" is not proof of no conflict.
 */
import type { Certainty, ConflictClass, ConflictFinding, ElementInput, ElementKind, ProjectIssue, StaleVerdict } from './coordinationApi';

// ── Proposal elements from an alternative's change set ───────────────────────────────────────────────────────────

/** One entry of GET /api/scenarios/{sid}/change-set. */
export interface ChangeSetEntry {
  objectId: string;
  op: 'add' | 'modify' | 'delete';
  object?: { id: string; type: string; name: string; coordinates: unknown; properties: Record<string, unknown> };
}

export interface ElementDraft {
  objectId: string;
  op: 'add' | 'modify';
  name: string;
  objectType: string;
  input: Omit<ElementInput, 'created_by'>;
  /** Why z / width are what they are (shown under "Technical details"). */
  basis: string[];
}
export interface SkippedObject { objectId: string; name: string; objectType: string; reason: string }

const num = (v: unknown): number | null => (typeof v === 'number' && Number.isFinite(v) ? v : null);
const pos = (v: unknown): number | null => { const n = num(v); return n != null && n > 0 ? n : null; };

/** Object types that are not physical works (demand/control objects) are not registered. */
const NOT_WORKS: Record<string, string> = {
  zone: 'demand zone (not a physical work)',
  gateway: 'traffic gateway (not a physical work)',
  junction: 'junction control edit (no own geometry to coordinate)',
};

/**
 * Maps one proposed object to a proposal element (kind, width, z range relative to ground, up positive).
 * Only values the object actually carries are used; everything else stays null = UNKNOWN.
 */
export function draftFromObject(
  entry: ChangeSetEntry, scenarioId: string, versionId: string | null,
): ElementDraft | SkippedObject {
  const o = entry.object;
  const name = o?.name || entry.objectId;
  const objectType = o?.type ?? 'unknown';
  if (entry.op === 'delete' || !o) {
    return { objectId: entry.objectId, name, objectType, reason: 'removal of an existing object (nothing new is built)' };
  }
  if (NOT_WORKS[objectType]) return { objectId: entry.objectId, name, objectType, reason: NOT_WORKS[objectType] };
  const p = o.properties ?? {};
  const basis: string[] = [];
  let kind: ElementKind = 'other';
  let width: number | null = null;
  let zMin: number | null = null;
  let zMax: number | null = null;
  let certainty: Certainty = 'hypothetical';

  switch (objectType) {
    case 'road': {
      kind = 'road';
      width = pos(p.width);
      zMax = 0;
      basis.push('At grade: top 0 m. Pavement / structure depth UNKNOWN.');
      break;
    }
    case 'flyover':
    case 'metro_flyover': {
      kind = 'flyover';
      width = pos(p.width);
      zMin = num(p.elevation);
      basis.push(zMin != null ? `Deck underside ${zMin} m (design elevation). Deck thickness, piers and foundations UNKNOWN.` : 'Deck elevation not recorded: UNKNOWN.');
      if (objectType === 'metro_flyover') basis.push('Double-deck: metro deck above the road deck; the element covers the road deck upward.');
      break;
    }
    case 'metro_line': {
      kind = 'metro_viaduct';
      width = pos(p.deckWidth) ?? pos(p.width);
      zMin = num(p.elevation);
      basis.push(zMin != null ? `Track deck at ${zMin} m (design elevation). Deck depth, piers and foundations UNKNOWN.` : 'Deck elevation not recorded: UNKNOWN.');
      break;
    }
    case 'metro_station': {
      kind = 'metro_station';
      width = pos(p.width);
      const el = num(p.elevation), h = pos(p.height);
      zMin = el;
      zMax = el != null && h != null ? el + h : null;
      basis.push(el != null ? `Platform level ${el} m${h != null ? `, height ${h} m` : ', height UNKNOWN'} (design values).` : 'Platform level not recorded: UNKNOWN.');
      break;
    }
    case 'utility': {
      kind = 'utility';
      const depth = num(p.depth);
      const dc = typeof p.depthCertainty === 'string' ? (p.depthCertainty as Certainty) : null;
      const diaM = pos(p.diameterMm) != null ? (pos(p.diameterMm) as number) / 1000 : null;
      width = diaM;
      if (depth == null || dc === 'unknown') {
        basis.push(depth == null ? 'Depth not recorded: UNKNOWN.' : `Stored depth ${depth} m is only a drawing placeholder: UNKNOWN.`);
        certainty = 'unknown';
      } else {
        zMax = -depth;
        zMin = diaM != null ? -(depth + diaM) : null;
        basis.push(`Cover to crown ${depth} m → top ${zMax} m.` + (diaM != null ? ` Diameter ${diaM} m → bottom ${zMin} m.` : ' Diameter UNKNOWN → bottom UNKNOWN.'));
        certainty = dc ?? 'hypothetical';
      }
      break;
    }
    case 'building': {
      kind = 'building';
      zMax = pos(p.height);
      basis.push(zMax != null ? `Height ${zMax} m (design value). Basement / foundation depth UNKNOWN.` : 'Height not recorded: UNKNOWN. Foundation depth UNKNOWN.');
      break;
    }
    default:
      basis.push(`Object type "${objectType}" has no element mapping; registered as "other" with depth UNKNOWN.`);
  }
  if (width == null) basis.push('Width UNKNOWN: detection uses the centreline and cannot rule out contact.');
  if (entry.op === 'modify') basis.push('Changes an existing object in this alternative; geometry is read from the alternative.');

  const input: Omit<ElementInput, 'created_by'> = {
    kind, name, scenario_id: scenarioId, scenario_version_id: versionId, element_ref: entry.objectId,
    width_m: width, z_min_m: zMin, z_max_m: zMax, z_ref: 'ground',
    provenance: `Registered from alternative ${scenarioId}${versionId ? ` version ${versionId}` : ' (current head)'}; design values from the proposal object`,
    certainty: zMin == null && zMax == null ? 'unknown' : certainty,
  };
  return { objectId: entry.objectId, op: entry.op, name, objectType, input, basis };
}

export function isDraft(x: ElementDraft | SkippedObject): x is ElementDraft { return 'input' in x; }

/** Splits a change set into registrable drafts and skipped objects; objects already registered are skipped. */
export function draftsFromChangeSet(
  changes: readonly ChangeSetEntry[], scenarioId: string, versionId: string | null,
  alreadyRegistered: ReadonlySet<string> = new Set(),
): { drafts: ElementDraft[]; skipped: SkippedObject[] } {
  const drafts: ElementDraft[] = [];
  const skipped: SkippedObject[] = [];
  for (const c of changes) {
    const d = draftFromObject(c, scenarioId, versionId);
    if (isDraft(d) && alreadyRegistered.has(`${scenarioId}:${c.objectId}`)) {
      skipped.push({ objectId: c.objectId, name: d.name, objectType: d.objectType, reason: 'already registered in this project' });
    } else if (isDraft(d)) drafts.push(d);
    else skipped.push(d);
  }
  return { drafts, skipped };
}

// ── Conflicts ─────────────────────────────────────────────────────────────────────────────────────────────────────

export const CLASS_ORDER: ConflictClass[] = ['conflict', 'potential_conflict', 'vertically_separated', 'unknown_no_coverage', 'no_conflict_within_available_data'];
export const CLASS_SHORT: Record<ConflictClass, string> = {
  conflict: 'Conflict',
  potential_conflict: 'Potential conflict',
  vertically_separated: 'Vertically separated',
  unknown_no_coverage: 'Unknown – no data coverage',
  no_conflict_within_available_data: 'No conflict within available data',
};
/** Classes that need a person's response. */
export const ACTIONABLE: ReadonlySet<ConflictClass> = new Set(['conflict', 'potential_conflict']);

export function groupIssuesByClass(issues: readonly ProjectIssue[]): { cls: ConflictClass; label: string; items: ProjectIssue[] }[] {
  return CLASS_ORDER
    .map(cls => ({ cls, label: CLASS_SHORT[cls], items: issues.filter(i => i.class === cls) }))
    .filter(g => g.items.length > 0);
}

export function openActionableCount(issues: readonly ProjectIssue[]): number {
  return issues.filter(i => ACTIONABLE.has(i.class) && i.status === 'open').length;
}

/** Layer names for layer-level findings (b_type "layer": b_ref is the layer id the backend checked). */
export const LAYER_NAME: Readonly<Record<string, string>> = {
  baseline_road: 'Existing roads (base city)', osm_metro: 'Existing metro (OpenStreetMap)', subsurface_utility: 'Utility records',
  building: 'Building footprints', project_element: 'Other projects\u2019 elements', geometry: 'Element geometry',
};

/**
 * Side B of a finding in words, without project names (both Underground's conflict check and Projects → Conflicts use it).
 * 'building' is returned by the backend since engine 1.1; kept out of the shared b_type union.
 */
export function sideBLabel(i: Pick<ConflictFinding, 'b_type' | 'b_ref' | 'evidence'>): string {
  switch (i.b_type as string) {
    case 'project_element': return 'Other project element';
    case 'project': return 'Other project';
    case 'baseline_road': return 'Existing road (base city)';
    case 'osm_metro': return 'Existing metro (OpenStreetMap)';
    case 'subsurface_utility': {
      const b = (i.evidence?.b ?? {}) as Record<string, unknown>;
      const t = b.utility_type === 'sewer' ? 'Sewer' : b.utility_type === 'storm_drain' ? 'Storm drain' : 'Utility';
      return b.external_id ? `${t} record ${String(b.external_id)}` : `${t} record`;
    }
    case 'building': {
      const b = (i.evidence?.b ?? {}) as Record<string, unknown>;
      return b.source === 'osm' ? 'Existing building (OSM footprint)' : 'Possible building (ML footprint)';
    }
    case 'layer': return `Layer: ${LAYER_NAME[i.b_ref] ?? i.b_ref.replace(/_/g, ' ')}`;
    default: return i.b_ref;
  }
}

/** Whether b_ref adds anything after sideBLabel (a record / footprint / road id), or only repeats the layer. */
export function sideBRefShown(i: Pick<ConflictFinding, 'b_type'>): boolean {
  return i.b_type !== 'layer' && i.b_type !== 'project';
}

/** What the other side of a finding is, in words. */
export function otherSideLabel(i: ProjectIssue, projectNames: Readonly<Record<string, string>>, thisProject: string): string {
  if (i.other_project) {
    const nm = projectNames[i.other_project] ?? i.other_project;
    return i.raised_by_project === thisProject ? `Project “${nm}”` : `Project “${nm}” (raised by them)`;
  }
  return sideBLabel(i);
}

const BLD_SOURCE: Record<string, string> = { osm: 'OpenStreetMap (volunteer-mapped)', google_open_buildings_v3: 'Google Open Buildings v3 (ML)', ms_global_ml_buildings: 'Microsoft ML footprints' };

/** Source and confidence of side B for building / utility-record findings (null for other kinds): never blank, UNKNOWN when missing. */
export function otherSideEvidence(i: Pick<ProjectIssue, 'b_type' | 'evidence'>): string | null {
  const b = (i.evidence?.b ?? {}) as Record<string, unknown>;
  if ((i.b_type as string) === 'building') {
    const src = BLD_SOURCE[String(b.source)] ?? String(b.source ?? 'UNKNOWN');
    const cls = b.data_class === 'observed' ? 'observed' : b.data_class === 'inferred' ? 'inferred' : 'class UNKNOWN';
    const conf = b.confidence == null ? 'confidence UNKNOWN' : `confidence ${String(b.confidence)} (model score 0–1)`;
    const agree = b.osm_agreement === 'ml_only_candidate' ? 'not in OSM' : b.osm_agreement === 'osm' ? 'OSM' : String(b.osm_agreement ?? '');
    const h = b.height_m == null ? 'height UNKNOWN' : `height ${String(b.height_m)} m (OSM tag)`;
    return `Source: ${src} ${String(b.source_id ?? '')} · ${cls} · ${conf} · ${agree} · ${h} · foundation depth UNKNOWN`;
  }
  if (i.b_type === 'subsurface_utility' && (b.quality_level || b.source)) {
    const depth = b.z_max_m == null && b.z_min_m == null ? 'depth UNKNOWN'
      : `z ${b.z_max_m == null ? 'UNKNOWN' : Number(b.z_max_m).toFixed(2)} to ${b.z_min_m == null ? 'UNKNOWN' : Number(b.z_min_m).toFixed(2)} m${b.levels_status ? ` (${String(b.levels_status)})` : ''}`;
    return `Source: ${String(b.source ?? b.owner ?? 'imported record')} · ASCE 38 ${String(b.quality_level ?? 'QL UNKNOWN')} · ${depth}`;
  }
  return null;
}

// ── Staleness ────────────────────────────────────────────────────────────────────────────────────────────────────

export type StaleState = 'stale' | 'current' | 'unknown';
export function staleState(v: Pick<StaleVerdict, 'stale'> | null | undefined): StaleState {
  if (!v || v.stale === null || v.stale === undefined) return 'unknown';
  return v.stale ? 'stale' : 'current';
}

const REASON_TEXT: [RegExp, string][] = [
  [/^project_elements_changed/, 'project elements changed'],
  [/^scenario_version_superseded/, 'a newer alternative version exists'],
  [/^scenario_head_changed/, 'the alternative was edited'],
  [/^other_project_(added|changed)/, 'another project changed'],
  [/^baseline_changed/, 'the base city changed'],
  [/^clearance_rules_changed/, 'clearance rules changed'],
  [/^subsurface_data_changed/, 'subsurface records changed'],
  [/^osm_index_changed/, 'the OSM index changed'],
  [/^engine_version_changed/, 'the detection engine changed'],
  [/^newer_scenario_version/, 'a newer alternative version exists'],
  [/^scenario_changed_since/, 'the alternative was edited'],
];
export function staleReasonText(reason: string): string {
  for (const [re, t] of REASON_TEXT) if (re.test(reason)) return t;
  return reason.replace(/_/g, ' ');
}

// ── Project cards ────────────────────────────────────────────────────────────────────────────────────────────────

export interface CardSummary { alternatives: number; elements: number; openConflicts: number; staleAssessments: number; unknownStale: number }

export function cardSummary(args: {
  links: readonly { entity_type: string }[] | undefined;
  elements: number;
  issues: readonly ProjectIssue[];
  stale: { runs: { stale: boolean | null }[]; assessments: { stale: boolean | null }[]; coordination_runs: { stale: boolean | null }[] } | null;
}): CardSummary {
  const all = args.stale ? [...args.stale.runs, ...args.stale.assessments, ...args.stale.coordination_runs.slice(0, 1)] : [];
  return {
    alternatives: (args.links ?? []).filter(l => l.entity_type === 'scenario').length,
    elements: args.elements,
    openConflicts: openActionableCount(args.issues),
    staleAssessments: all.filter(v => v.stale === true).length,
    unknownStale: all.filter(v => v.stale === null).length,
  };
}

// ── Geometry helpers ─────────────────────────────────────────────────────────────────────────────────────────────

/** Bounds of a GeoJSON geometry (lng/lat), or null. */
export function geometryBounds(g: { type: string; coordinates: unknown } | null | undefined): { minLng: number; minLat: number; maxLng: number; maxLat: number } | null {
  if (!g) return null;
  const pts: number[][] = [];
  const walk = (c: unknown) => {
    if (Array.isArray(c) && typeof c[0] === 'number' && typeof c[1] === 'number') pts.push(c as number[]);
    else if (Array.isArray(c)) c.forEach(walk);
  };
  walk(g.coordinates);
  if (!pts.length) return null;
  return {
    minLng: Math.min(...pts.map(p => p[0])), minLat: Math.min(...pts.map(p => p[1])),
    maxLng: Math.max(...pts.map(p => p[0])), maxLat: Math.max(...pts.map(p => p[1])),
  };
}

/** "−6.0 to −5.4 m", "top 0 m · bottom UNKNOWN", "UNKNOWN". */
export function zRangeText(zMin: number | null, zMax: number | null): string {
  const f = (v: number) => `${v > 0 ? '+' : ''}${v.toFixed(1)}`;
  if (zMin == null && zMax == null) return 'Depth UNKNOWN';
  if (zMin != null && zMax != null) return `${f(zMin)} to ${f(zMax)} m`;
  return zMin != null ? `bottom ${f(zMin)} m · top UNKNOWN` : `top ${f(zMax as number)} m · bottom UNKNOWN`;
}

/**
 * Underground alignment geometry (docs/urbanos/UNDERGROUND_WORKSPACE.md). Pure functions, no Cesium:
 * chainage, long-section (profile), crossings with other objects in plan, cross-section at a chainage, and the
 * coordination-element payload (docs/urbanos/COORDINATION_AND_SUBSURFACE.md §2).
 *
 * Conventions
 * - Depth is metres below the ground datum, positive down. Ground is a FLAT DATUM: the repo has no DEM
 *   (ENGINEERING_GIS_RESEARCH §E7), so "ground" = 0 everywhere and is UNKNOWN as a real level.
 * - null = UNKNOWN. A missing depth is never 0 and is never interpolated across.
 * - Plan distances use a local equirectangular projection around the alignment (good to well under 0.1 % over a few km).
 */
import type { Certainty } from '../objects/certainty';
import type {
  CityObject, UndergroundAlignmentKind, UndergroundAlignmentObject, UndergroundSection, UndergroundVertexDepth,
} from '../objects/types';

export const ALIGNMENT_KIND_LABEL: Record<UndergroundAlignmentKind, string> = {
  bored_tunnel: 'Bored tunnel',
  underground_metro: 'Underground metro',
  cut_and_cover: 'Cut-and-cover',
  utility_trunk: 'Utility trunk',
  storm_drain: 'Storm drain',
};

/** Coordination element kind for each alignment kind (backend ELEMENT_KINDS). */
export const ALIGNMENT_ELEMENT_KIND: Record<UndergroundAlignmentKind, 'tunnel' | 'metro_tunnel' | 'utility' | 'drainage'> = {
  bored_tunnel: 'tunnel',
  underground_metro: 'metro_tunnel',
  cut_and_cover: 'tunnel',
  utility_trunk: 'utility',
  storm_drain: 'drainage',
};

const CERTAINTY_RANK: Record<Certainty, number> = { measured: 0, estimated: 1, hypothetical: 2, unknown: 3 };
/** The least certain of the given levels (empty list = unknown). */
export function worstCertainty(levels: readonly Certainty[]): Certainty {
  if (levels.length === 0) return 'unknown';
  return levels.reduce((w, c) => (CERTAINTY_RANK[c] > CERTAINTY_RANK[w] ? c : w), 'measured' as Certainty);
}

const ok = (v: number | null | undefined): v is number => typeof v === 'number' && Number.isFinite(v);

/** Vertical size of the section (diameter or box height); null = UNKNOWN. */
export function sectionHeightM(s: UndergroundSection): number | null {
  const v = s.shape === 'circular' ? s.diameterM : s.heightM;
  return ok(v) && v > 0 ? v : null;
}
/** Plan width of the section (diameter or box width); null = UNKNOWN. */
export function sectionWidthM(s: UndergroundSection): number | null {
  const v = s.shape === 'circular' ? s.diameterM : s.widthM;
  return ok(v) && v > 0 ? v : null;
}

// ---- local plan projection -------------------------------------------------------------------------------------
export interface Projector { lat0: number; lon0: number; kx: number; ky: number }
export function projectorFor(coords: readonly (readonly number[])[]): Projector {
  const lat0 = coords.length ? coords.reduce((s, c) => s + c[1], 0) / coords.length : 0;
  const lon0 = coords.length ? coords[0][0] : 0;
  return { lat0, lon0, kx: 111320 * Math.cos((lat0 * Math.PI) / 180), ky: 110574 };
}
export const toXY = (p: Projector, c: readonly number[]): [number, number] => [(c[0] - p.lon0) * p.kx, (c[1] - p.lat0) * p.ky];
export const toLonLat = (p: Projector, x: number, y: number): [number, number] => [p.lon0 + x / p.kx, p.lat0 + y / p.ky];

/** Cumulative chainage (m) at each vertex, starting at 0. */
export function chainages(coords: readonly (readonly number[])[], proj = projectorFor(coords)): number[] {
  const out: number[] = [];
  let acc = 0;
  for (let i = 0; i < coords.length; i++) {
    if (i > 0) {
      const [x0, y0] = toXY(proj, coords[i - 1]);
      const [x1, y1] = toXY(proj, coords[i]);
      acc += Math.hypot(x1 - x0, y1 - y0);
    }
    out.push(acc);
  }
  return out;
}

/** Depth entries aligned to the coordinates (missing entries are UNKNOWN). */
export function depthsOf(a: Pick<UndergroundAlignmentObject, 'coordinates' | 'depths'>): UndergroundVertexDepth[] {
  return a.coordinates.map((_, i) => {
    const d = a.depths?.[i];
    return { crownDepthM: d && ok(d.crownDepthM) ? d.crownDepthM : null, certainty: d?.certainty ?? 'unknown' };
  });
}

// ---- long-section ---------------------------------------------------------------------------------------------------
export interface ProfileVertex {
  index: number;
  chainageM: number;
  crownDepthM: number | null;
  invertDepthM: number | null;
  certainty: Certainty;
}
export interface AlignmentProfile {
  lengthM: number;
  vertices: ProfileVertex[];
  /** Gradient of each segment in % (Δcrown / Δchainage, + = falling with chainage, i.e. getting deeper); null if a depth is unknown. */
  gradientsPct: (number | null)[];
  sectionHeightM: number | null;
  maxKnownDepthM: number | null;
  unknownDepthCount: number;
}

export function alignmentProfile(a: UndergroundAlignmentObject): AlignmentProfile {
  const ch = chainages(a.coordinates);
  const h = sectionHeightM(a.section);
  const ds = depthsOf(a);
  const vertices = ds.map((d, i) => ({
    index: i,
    chainageM: ch[i],
    crownDepthM: d.crownDepthM,
    invertDepthM: d.crownDepthM !== null && h !== null ? d.crownDepthM + h : null,
    certainty: d.crownDepthM === null ? 'unknown' as Certainty : d.certainty,
  }));
  const gradientsPct = vertices.slice(1).map((v, i) => {
    const u = vertices[i];
    const run = v.chainageM - u.chainageM;
    return u.crownDepthM !== null && v.crownDepthM !== null && run > 0 ? ((v.crownDepthM - u.crownDepthM) / run) * 100 : null;
  });
  const known = vertices.flatMap(v => (v.invertDepthM ?? v.crownDepthM) ?? []);
  return {
    lengthM: ch[ch.length - 1] ?? 0,
    vertices,
    gradientsPct,
    sectionHeightM: h,
    maxKnownDepthM: known.length ? Math.max(...known) : null,
    unknownDepthCount: vertices.filter(v => v.crownDepthM === null).length,
  };
}

/** Crown depth at a chainage: linear between the two neighbouring vertices only when both are known; else null. */
export function crownDepthAt(a: UndergroundAlignmentObject, chainageM: number): { depthM: number | null; certainty: Certainty } {
  const p = alignmentProfile(a);
  const v = p.vertices;
  if (v.length === 0) return { depthM: null, certainty: 'unknown' };
  const c = Math.min(Math.max(chainageM, 0), p.lengthM);
  for (let i = 1; i < v.length; i++) {
    if (c <= v[i].chainageM || i === v.length - 1) {
      const u = v[i - 1], w = v[i];
      if (u.crownDepthM === null || w.crownDepthM === null) return { depthM: null, certainty: 'unknown' };
      const span = w.chainageM - u.chainageM;
      const t = span > 0 ? (c - u.chainageM) / span : 0;
      return { depthM: u.crownDepthM + t * (w.crownDepthM - u.crownDepthM), certainty: worstCertainty([u.certainty, w.certainty]) };
    }
  }
  return { depthM: v[0].crownDepthM, certainty: v[0].certainty };
}

/** Plan position and unit direction at a chainage. */
export function pointAtChainage(a: UndergroundAlignmentObject, chainageM: number): { lonLat: [number, number]; xy: [number, number]; dir: [number, number]; proj: Projector } {
  const proj = projectorFor(a.coordinates);
  const ch = chainages(a.coordinates, proj);
  const c = Math.min(Math.max(chainageM, 0), ch[ch.length - 1] ?? 0);
  let i = 1;
  while (i < ch.length - 1 && ch[i] < c) i++;
  const p0 = toXY(proj, a.coordinates[i - 1] ?? a.coordinates[0]);
  const p1 = toXY(proj, a.coordinates[i] ?? a.coordinates[0]);
  const seg = Math.hypot(p1[0] - p0[0], p1[1] - p0[1]);
  const t = seg > 0 ? (c - ch[i - 1]) / seg : 0;
  const xy: [number, number] = [p0[0] + t * (p1[0] - p0[0]), p0[1] + t * (p1[1] - p0[1])];
  const dir: [number, number] = seg > 0 ? [(p1[0] - p0[0]) / seg, (p1[1] - p0[1]) / seg] : [1, 0];
  return { lonLat: toLonLat(proj, xy[0], xy[1]), xy, dir, proj };
}

// ---- what other objects occupy vertically ---------------------------------------------------------------------------
export interface VerticalExtent {
  /** Depth of the object's top below ground (m, + down; negative = above ground). null = UNKNOWN. */
  topDepthM: number | null;
  /** Depth of the object's lowest part (incl. foundations) below ground. null = UNKNOWN. */
  bottomDepthM: number | null;
  certainty: Certainty;
  note: string;
}

const UTILITY_LABEL: Record<string, string> = { water: 'Water', electricity: 'Electrical', sewage: 'Sewage', gas: 'Gas', fiber: 'Fibre' };

/** What the model knows about another object's vertical extent at a point along it (chainage along that object). */
export function verticalExtentOf(o: CityObject, otherChainageM = 0): VerticalExtent | null {
  switch (o.type) {
    case 'road':
      return { topDepthM: 0, bottomDepthM: null, certainty: 'unknown', note: 'At-grade road: pavement / structure depth UNKNOWN' };
    case 'flyover':
    case 'metro_flyover':
    case 'metro_line': {
      const elev = o.type === 'metro_flyover' ? o.metroElevation : o.elevation;
      return { topDepthM: ok(elev) ? -elev : null, bottomDepthM: null, certainty: 'unknown', note: 'Elevated structure: pier foundation depth UNKNOWN (not in the model)' };
    }
    case 'building':
      return { topDepthM: ok(o.height) ? -o.height : null, bottomDepthM: null, certainty: 'unknown', note: 'Building: foundation / basement depth UNKNOWN' };
    case 'utility': {
      const d = ok(o.depth) ? o.depth : null;
      const dia = ok(o.diameterMm) && (o.diameterMm as number) > 0 ? (o.diameterMm as number) / 1000 : null;
      return {
        topDepthM: d, bottomDepthM: d !== null && dia !== null ? d + dia : null,
        certainty: d === null ? 'unknown' : (o.depthCertainty ?? 'unknown'),
        note: `${UTILITY_LABEL[o.utilityType] ?? o.utilityType} utility (drawn object)${dia === null ? '; diameter UNKNOWN' : ''}`,
      };
    }
    case 'underground_alignment': {
      const c = crownDepthAt(o, otherChainageM);
      const h = sectionHeightM(o.section);
      return {
        topDepthM: c.depthM, bottomDepthM: c.depthM !== null && h !== null ? c.depthM + h : null,
        certainty: c.depthM === null ? 'unknown' : c.certainty,
        note: `${ALIGNMENT_KIND_LABEL[o.alignmentKind]} (drawn object)`,
      };
    }
    default:
      return null;
  }
}

/** Plan line(s) of another object that can be crossed: polylines, and building outlines. */
function linesOf(o: CityObject): (readonly (readonly number[])[])[] {
  switch (o.type) {
    case 'road': case 'flyover': case 'metro_flyover': case 'metro_line': case 'utility': case 'underground_alignment':
      return o.coordinates.length >= 2 ? [o.coordinates] : [];
    case 'building':
      return o.coordinates.length >= 3 ? [o.coordinates] : [];
    default:
      return [];
  }
}

function segIntersect(a: [number, number], b: [number, number], c: [number, number], d: [number, number]): { t: number; u: number } | null {
  const r = [b[0] - a[0], b[1] - a[1]], s = [d[0] - c[0], d[1] - c[1]];
  const den = r[0] * s[1] - r[1] * s[0];
  if (Math.abs(den) < 1e-12) return null;
  const qp = [c[0] - a[0], c[1] - a[1]];
  const t = (qp[0] * s[1] - qp[1] * s[0]) / den;
  const u = (qp[0] * r[1] - qp[1] * r[0]) / den;
  return t >= 0 && t <= 1 && u >= 0 && u <= 1 ? { t, u } : null;
}

export interface Crossing {
  chainageM: number;
  objectId: string;
  objectType: CityObject['type'];
  name: string;
  extent: VerticalExtent;
  lonLat: [number, number];
}

const bboxOf = (pts: [number, number][]) => pts.reduce((b, p) => [Math.min(b[0], p[0]), Math.min(b[1], p[1]), Math.max(b[2], p[0]), Math.max(b[3], p[1])], [Infinity, Infinity, -Infinity, -Infinity]);

/**
 * Where the alignment's centreline crosses other objects' centrelines / building outlines in plan (centreline
 * intersections only; widths are not buffered here: the coordination check does that server-side).
 */
export function findCrossings(a: UndergroundAlignmentObject, others: readonly CityObject[]): Crossing[] {
  if (a.coordinates.length < 2) return [];
  const proj = projectorFor(a.coordinates);
  const A = a.coordinates.map(c => toXY(proj, c));
  const chA = chainages(a.coordinates, proj);
  const bb = bboxOf(A);
  const out: Crossing[] = [];
  for (const o of others) {
    if (o.id === a.id) continue;
    for (const line of linesOf(o)) {
      const B = line.map(c => toXY(proj, c));
      const ob = bboxOf(B);
      if (ob[0] > bb[2] || ob[2] < bb[0] || ob[1] > bb[3] || ob[3] < bb[1]) continue;
      let chB = 0;
      for (let j = 1; j < B.length; j++) {
        const segB = Math.hypot(B[j][0] - B[j - 1][0], B[j][1] - B[j - 1][1]);
        for (let i = 1; i < A.length; i++) {
          const hit = segIntersect(A[i - 1], A[i], B[j - 1], B[j]);
          if (!hit) continue;
          const extent = verticalExtentOf(o, chB + hit.u * segB);
          if (!extent) continue;
          const x = A[i - 1][0] + hit.t * (A[i][0] - A[i - 1][0]);
          const y = A[i - 1][1] + hit.t * (A[i][1] - A[i - 1][1]);
          out.push({ chainageM: chA[i - 1] + hit.t * (chA[i] - chA[i - 1]), objectId: o.id, objectType: o.type, name: o.name || o.id, extent, lonLat: toLonLat(proj, x, y) });
        }
        chB += segB;
      }
    }
  }
  return out.sort((p, q) => p.chainageM - q.chainageM);
}

// ---- cross-section --------------------------------------------------------------------------------------------------
export interface SectionItem {
  /** Signed offset (m) along the section line from the alignment axis; + = right of the direction of chainage. */
  offsetM: number;
  objectId: string;
  objectType: CityObject['type'];
  name: string;
  extent: VerticalExtent;
  /** Plan width of the object where known (m). */
  widthM: number | null;
}
export interface CrossSection {
  chainageM: number;
  lonLat: [number, number];
  halfWidthM: number;
  own: { crownDepthM: number | null; certainty: Certainty; section: UndergroundSection; widthM: number | null; heightM: number | null };
  items: SectionItem[];
}

function planWidthOf(o: CityObject): number | null {
  switch (o.type) {
    case 'road': case 'flyover': case 'metro_flyover': return ok(o.width) ? o.width : null;
    case 'metro_line': return ok(o.deckWidth) ? o.deckWidth : null;
    case 'utility': return ok(o.diameterMm) && (o.diameterMm as number) > 0 ? (o.diameterMm as number) / 1000 : null;
    case 'underground_alignment': return sectionWidthM(o.section);
    default: return null;
  }
}

/** A vertical section perpendicular to the alignment at `chainageM`, `halfWidthM` either side. */
export function crossSectionAt(a: UndergroundAlignmentObject, chainageM: number, halfWidthM: number, others: readonly CityObject[]): CrossSection {
  const at = pointAtChainage(a, chainageM);
  const crown = crownDepthAt(a, chainageM);
  const n: [number, number] = [at.dir[1], -at.dir[0]]; // right-hand normal
  const L: [number, number] = [at.xy[0] - n[0] * halfWidthM, at.xy[1] - n[1] * halfWidthM];
  const R: [number, number] = [at.xy[0] + n[0] * halfWidthM, at.xy[1] + n[1] * halfWidthM];
  const items: SectionItem[] = [];
  for (const o of others) {
    if (o.id === a.id) continue;
    for (const line of linesOf(o)) {
      const B = line.map(c => toXY(at.proj, c));
      let chB = 0;
      for (let j = 1; j < B.length; j++) {
        const segB = Math.hypot(B[j][0] - B[j - 1][0], B[j][1] - B[j - 1][1]);
        const hit = segIntersect(L, R, B[j - 1], B[j]);
        if (hit) {
          const extent = verticalExtentOf(o, chB + hit.u * segB);
          if (extent) items.push({ offsetM: -halfWidthM + hit.t * 2 * halfWidthM, objectId: o.id, objectType: o.type, name: o.name || o.id, extent, widthM: planWidthOf(o) });
        }
        chB += segB;
      }
    }
  }
  items.sort((p, q) => p.offsetM - q.offsetM);
  return {
    chainageM: Math.min(Math.max(chainageM, 0), alignmentProfile(a).lengthM),
    lonLat: at.lonLat,
    halfWidthM,
    own: { crownDepthM: crown.depthM, certainty: crown.certainty, section: a.section, widthM: sectionWidthM(a.section), heightM: sectionHeightM(a.section) },
    items,
  };
}

// ---- coordination element -------------------------------------------------------------------------------------------
export interface AlignmentElementPayload {
  kind: 'tunnel' | 'metro_tunnel' | 'utility' | 'drainage';
  name: string;
  geometry: { type: 'LineString'; coordinates: [number, number][] };
  width_m: number | null;
  z_min_m: number | null;
  z_max_m: number | null;
  z_ref: 'ground';
  profile: { chainage_m: number; z_min_m: number | null; z_max_m: number | null }[];
  certainty: Certainty;
  provenance: string;
}

/**
 * The alignment as a coordination proposal element: z is metres relative to ground, up positive (so a crown 10 m
 * down is z_max −10). Any unknown depth or section height keeps that value null (UNKNOWN); the element envelope is
 * only given when every vertex is known.
 */
export function alignmentElementPayload(a: UndergroundAlignmentObject): AlignmentElementPayload {
  const p = alignmentProfile(a);
  const prof = p.vertices.map(v => ({
    chainage_m: Math.round(v.chainageM * 100) / 100,
    z_max_m: v.crownDepthM === null ? null : -v.crownDepthM,
    z_min_m: v.invertDepthM === null ? null : -v.invertDepthM,
  }));
  const allMax = prof.every(q => q.z_max_m !== null), allMin = prof.every(q => q.z_min_m !== null);
  return {
    kind: ALIGNMENT_ELEMENT_KIND[a.alignmentKind],
    name: a.name,
    geometry: { type: 'LineString', coordinates: a.coordinates.map(c => [c[0], c[1]]) },
    width_m: sectionWidthM(a.section),
    z_max_m: allMax && prof.length ? Math.max(...prof.map(q => q.z_max_m as number)) : null,
    z_min_m: allMin && prof.length ? Math.min(...prof.map(q => q.z_min_m as number)) : null,
    z_ref: 'ground',
    profile: prof,
    certainty: worstCertainty([...p.vertices.map(v => v.certainty), a.sectionCertainty]),
    provenance: `UrbanOS underground alignment ${a.id} (scenario ${a.scenarioId}); depths user-entered relative to a flat ground datum (no DEM)`,
  };
}

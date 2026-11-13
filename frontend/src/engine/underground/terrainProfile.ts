/**
 * Ground line from the DEM for the Underground long-section (docs/urbanos/TERRAIN_AND_SUBSURFACE_DATA.md §4). Pure.
 *
 * - Ground = Copernicus GLO-30 DSM sampled by /api/terrain/profile (bilinear, EGM2008 geoid heights). Samples the server
 *   reports as nodata / outside coverage stay UNKNOWN: the ground is never interpolated across them.
 * - Depths in the model stay RELATIVE TO GROUND (crownDepthM per vertex). Where the DSM is known at a vertex, the crown
 *   elevation there is ground − depth (m above the EGM2008 geoid, as the product states). Between two such vertices the
 *   crown is drawn as a straight grade in elevation; its depth below the DSM along the run is ground(ch) − crown(ch).
 * - Server chainages (UTM 43N) are mapped onto the editor's chainage per segment (segment index + fraction), so both
 *   use the same vertices.
 */
import type { CityObject, UndergroundAlignmentObject } from '../objects/types';
import type { Certainty } from '../objects/certainty';
import type { SewerCrossing, TerrainProfile } from '../../lib/terrainApi';
import { alignmentProfile, chainages, findCrossings, type Crossing } from './alignmentGeometry';
import { scale, ticks, type Box, type Scale } from './sectionLayout';

export interface GroundSample { chainageM: number; elevM: number | null; status: string }

export function groundSamples(a: Pick<UndergroundAlignmentObject, 'coordinates'>, prof: Pick<TerrainProfile, 'samples'>): GroundSample[] {
  const ch = chainages(a.coordinates);
  return prof.samples.map(s => {
    const i = Math.min(Math.max(s.segment, 0), Math.max(ch.length - 2, 0));
    const c = ch.length >= 2 ? ch[i] + s.t * (ch[i + 1] - ch[i]) : 0;
    return { chainageM: c, elevM: s.status === 'ok' ? s.elevation_m : null, status: s.status };
  }).sort((p, q) => p.chainageM - q.chainageM);
}

/** Ground at a chainage: linear between the two neighbouring samples only when both are known; else null. */
export function groundAt(samples: readonly GroundSample[], chainageM: number): number | null {
  if (!samples.length) return null;
  if (chainageM <= samples[0].chainageM) return Math.abs(chainageM - samples[0].chainageM) < 1e-6 ? samples[0].elevM : null;
  for (let i = 1; i < samples.length; i++) {
    const u = samples[i - 1], v = samples[i];
    if (chainageM <= v.chainageM + 1e-9) {
      if (u.elevM === null || v.elevM === null) {
        if (Math.abs(chainageM - v.chainageM) < 1e-6) return v.elevM;
        if (Math.abs(chainageM - u.chainageM) < 1e-6) return u.elevM;
        return null;
      }
      const span = v.chainageM - u.chainageM;
      const t = span > 0 ? (chainageM - u.chainageM) / span : 0;
      return u.elevM + t * (v.elevM - u.elevM);
    }
  }
  return null;
}

/** Piecewise-linear map of a server (UTM) chainage onto the editor chainage using the vertex chainages of both. */
export function mapUtmChainage(chUtm: number, vertexUtm: readonly number[], vertexFe: readonly number[]): number {
  const n = Math.min(vertexUtm.length, vertexFe.length);
  if (n < 2) return chUtm;
  for (let i = 1; i < n; i++) {
    if (chUtm <= vertexUtm[i] || i === n - 1) {
      const span = vertexUtm[i] - vertexUtm[i - 1];
      const t = span > 0 ? (chUtm - vertexUtm[i - 1]) / span : 0;
      return vertexFe[i - 1] + Math.min(Math.max(t, 0), 1) * (vertexFe[i] - vertexFe[i - 1]);
    }
  }
  return chUtm;
}

export interface ElevVertex {
  chainageM: number; crownDepthM: number | null; groundM: number | null;
  /** m above the EGM2008 geoid; null when depth or ground is UNKNOWN. */
  crownElevM: number | null; invertElevM: number | null; certainty: Certainty;
}
export interface ElevRun { vertices: ElevVertex[]; minCoverM: number | null; minCoverChainageM: number | null }
export interface ElevationProfile {
  lengthM: number; vertices: ElevVertex[]; samples: GroundSample[];
  /** Polylines of consecutive known ground samples (chainage, elevation). */
  groundRuns: [number, number][][];
  /** Chainage spans where the ground is UNKNOWN (nodata / outside DEM coverage). */
  unknownGround: [number, number][];
  runs: ElevRun[];
  coverageFraction: number;
  sectionHeightM: number | null;
}

export function elevationProfile(a: UndergroundAlignmentObject, prof: Pick<TerrainProfile, 'samples'>): ElevationProfile {
  const p = alignmentProfile(a);
  const samples = groundSamples(a, prof);
  const vertices: ElevVertex[] = p.vertices.map(v => {
    const g = groundAt(samples, v.chainageM);
    const crown = g !== null && v.crownDepthM !== null ? g - v.crownDepthM : null;
    return { chainageM: v.chainageM, crownDepthM: v.crownDepthM, groundM: g, crownElevM: crown,
      invertElevM: crown !== null && p.sectionHeightM !== null ? crown - p.sectionHeightM : null, certainty: v.certainty };
  });
  const groundRuns: [number, number][][] = [];
  const unknownGround: [number, number][] = [];
  let cur: [number, number][] = [];
  let gapStart: number | null = null;
  for (const s of samples) {
    if (s.elevM !== null) {
      if (gapStart !== null) { unknownGround.push([gapStart, s.chainageM]); gapStart = null; }
      cur.push([s.chainageM, s.elevM]);
    } else {
      if (cur.length) { groundRuns.push(cur); cur = []; }
      if (gapStart === null) gapStart = s.chainageM;
    }
  }
  if (cur.length) groundRuns.push(cur);
  if (gapStart !== null) unknownGround.push([gapStart, samples.length ? samples[samples.length - 1].chainageM : gapStart]);
  // runs of consecutive vertices with a known crown elevation
  const runs: ElevRun[] = [];
  let run: ElevVertex[] = [];
  const flush = () => {
    if (run.length >= 2) {
      let minCover: number | null = null, at: number | null = null;
      for (const s of samples) {
        if (s.elevM === null || s.chainageM < run[0].chainageM || s.chainageM > run[run.length - 1].chainageM) continue;
        const c = crownElevAt(run, s.chainageM);
        if (c === null) continue;
        const cover = s.elevM - c;
        if (minCover === null || cover < minCover) { minCover = cover; at = s.chainageM; }
      }
      runs.push({ vertices: run, minCoverM: minCover, minCoverChainageM: at });
    }
    run = [];
  };
  for (const v of vertices) { if (v.crownElevM === null) flush(); else run.push(v); }
  flush();
  const known = samples.filter(s => s.elevM !== null).length;
  return { lengthM: p.lengthM, vertices, samples, groundRuns, unknownGround, runs,
    coverageFraction: samples.length ? known / samples.length : 0, sectionHeightM: p.sectionHeightM };
}

/** Crown elevation inside a run (straight grade between its vertices). */
export function crownElevAt(run: readonly ElevVertex[], chainageM: number): number | null {
  for (let i = 1; i < run.length; i++) {
    const u = run[i - 1], v = run[i];
    if (chainageM >= u.chainageM - 1e-9 && chainageM <= v.chainageM + 1e-9 && u.crownElevM !== null && v.crownElevM !== null) {
      const span = v.chainageM - u.chainageM;
      const t = span > 0 ? (chainageM - u.chainageM) / span : 0;
      return u.crownElevM + t * (v.crownElevM - u.crownElevM);
    }
  }
  return null;
}

// ---- SVG layout (elevation axis, up = higher) -----------------------------------------------------------------------
export interface SewerMark { chainageM: number; invertM: number | null; diameterM: number | null; label: string; x: number; y: number | null; c: SewerCrossing }
export interface ElevationLayout {
  box: Box; x: Scale; y: Scale; ep: ElevationProfile; crossings: (Crossing & { groundM: number | null })[];
  xTicks: number[]; yTicks: number[];
  groundPaths: [number, number][][]; unknownSpans: [number, number][];
  crownRuns: [number, number][][]; bands: [number, number][][]; unknownVertices: { chainageM: number; x: number; reason: string }[];
  sewers: SewerMark[];
}

export function layoutElevationProfile(a: UndergroundAlignmentObject, others: readonly CityObject[], prof: Pick<TerrainProfile, 'samples'>,
  sewers: readonly (SewerCrossing & { chainageM: number })[], size: { width: number; height: number }): ElevationLayout {
  const ep = elevationProfile(a, prof);
  const crossings = findCrossings(a, others).map(c => ({ ...c, groundM: groundAt(ep.samples, c.chainageM) }));
  const box: Box = { width: size.width, height: size.height, left: 52, right: 12, top: 18, bottom: 26 };
  const elevs: number[] = [
    ...ep.groundRuns.flat().map(p => p[1]),
    ...ep.vertices.flatMap(v => [v.crownElevM, v.invertElevM]).filter((v): v is number => v !== null),
    ...sewers.map(s => s.invert_at_crossing_m).filter((v): v is number => v !== null && Number.isFinite(v)),
    ...crossings.flatMap(c => [c.groundM !== null && c.extent.bottomDepthM !== null ? c.groundM - c.extent.bottomDepthM : null]).filter((v): v is number => v !== null),
  ];
  const hi = elevs.length ? Math.max(...elevs) : 10, lo = elevs.length ? Math.min(...elevs) : 0;
  const pad = Math.max(2, (hi - lo) * 0.08);
  const x: Scale = { d0: 0, d1: Math.max(ep.lengthM, 1), r0: box.left, r1: size.width - box.right };
  const y: Scale = { d0: hi + pad, d1: lo - pad, r0: box.top, r1: size.height - box.bottom };
  const P = (ch: number, e: number): [number, number] => [scale(x, ch), scale(y, e)];
  const crownRuns = ep.runs.map(r => r.vertices.map(v => P(v.chainageM, v.crownElevM as number)));
  const bands = ep.sectionHeightM === null ? [] : ep.runs.map(r => [
    ...r.vertices.map(v => P(v.chainageM, v.crownElevM as number)),
    ...[...r.vertices].reverse().map(v => P(v.chainageM, v.invertElevM as number)),
  ]);
  return {
    box, x, y, ep, crossings, xTicks: ticks(0, x.d1, 6), yTicks: ticks(lo - pad, hi + pad, 4),
    groundPaths: ep.groundRuns.map(r => r.map(([c, e]) => P(c, e))),
    unknownSpans: ep.unknownGround.map(([c0, c1]) => [scale(x, c0), scale(x, c1)]),
    crownRuns, bands,
    unknownVertices: ep.vertices.filter(v => v.crownElevM === null).map(v => ({ chainageM: v.chainageM, x: scale(x, v.chainageM),
      reason: v.crownDepthM === null ? 'depth UNKNOWN' : 'ground UNKNOWN (outside DEM coverage)' })),
    sewers: sewers.map(s => ({ chainageM: s.chainageM, invertM: s.invert_at_crossing_m, diameterM: s.diameter_m, label: s.label ?? s.pipeline_id,
      x: scale(x, s.chainageM), y: s.invert_at_crossing_m === null ? null : scale(y, s.invert_at_crossing_m), c: s })),
  };
}

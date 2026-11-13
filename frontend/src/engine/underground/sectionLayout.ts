/**
 * Pure layout for the Profile (long-section) and Cross-section SVGs (docs/urbanos/UNDERGROUND_WORKSPACE.md §4).
 * Depth axis: metres below the flat ground datum, + down. Nothing here invents a value: UNKNOWN stays null and is
 * drawn as an explicit "UNKNOWN" marker by the components.
 */
import type { CityObject, UndergroundAlignmentObject } from '../objects/types';
import { alignmentProfile, crossSectionAt, findCrossings, type AlignmentProfile, type Crossing, type CrossSection } from './alignmentGeometry';

export interface Box { width: number; height: number; left: number; right: number; top: number; bottom: number }
export interface Scale { d0: number; d1: number; r0: number; r1: number }
export const scale = (s: Scale, v: number) => s.r0 + ((v - s.d0) / (s.d1 - s.d0 || 1)) * (s.r1 - s.r0);

/** "Nice" tick values covering [a, b] (≈ n ticks). */
export function ticks(a: number, b: number, n = 5): number[] {
  const span = Math.abs(b - a);
  if (!(span > 0) || !Number.isFinite(span)) return [a];
  const raw = span / n, mag = 10 ** Math.floor(Math.log10(raw));
  const step = [1, 2, 5, 10].map(m => m * mag).find(s => s >= raw) ?? 10 * mag;
  const out: number[] = [];
  for (let v = Math.ceil(Math.min(a, b) / step) * step; v <= Math.max(a, b) + 1e-9; v += step) out.push(Math.round(v * 1e6) / 1e6);
  return out;
}

export interface ProfileLayout {
  box: Box;
  x: Scale;
  y: Scale;
  profile: AlignmentProfile;
  crossings: Crossing[];
  /** Depth range shown: [minDepth (≤0, above ground), maxDepth]. */
  depthRange: [number, number];
  xTicks: number[];
  yTicks: number[];
  /** Crown polyline (screen coords) per run of consecutive known vertices. */
  crownRuns: [number, number][][];
  /** Closed band crown→invert per run, when the section height is known. */
  bands: [number, number][][];
  unknownVertices: { chainageM: number; x: number }[];
}

const MIN_DEPTH_RANGE = 5;

export function layoutProfile(a: UndergroundAlignmentObject, others: readonly CityObject[], size: { width: number; height: number }): ProfileLayout {
  const profile = alignmentProfile(a);
  const crossings = findCrossings(a, others);
  const box: Box = { width: size.width, height: size.height, left: 48, right: 12, top: 18, bottom: 26 };
  const depths = [
    ...profile.vertices.flatMap(v => [v.crownDepthM, v.invertDepthM]),
    ...crossings.flatMap(c => [c.extent.topDepthM, c.extent.bottomDepthM]),
  ].filter((d): d is number => d !== null && Number.isFinite(d));
  const maxD = Math.max(MIN_DEPTH_RANGE, ...depths.filter(d => d > 0)) * 1.15;
  // Above ground only a little headroom (elevated structures are clipped and labelled)
  const minD = -Math.max(2, maxD * 0.12);
  const x: Scale = { d0: 0, d1: Math.max(profile.lengthM, 1), r0: box.left, r1: size.width - box.right };
  const y: Scale = { d0: minD, d1: maxD, r0: box.top, r1: size.height - box.bottom };
  const crownRuns: [number, number][][] = [], bands: [number, number][][] = [];
  let run: typeof profile.vertices = [];
  const flush = () => {
    if (run.length >= 2) {
      crownRuns.push(run.map(v => [scale(x, v.chainageM), scale(y, v.crownDepthM as number)]));
      if (profile.sectionHeightM !== null) {
        bands.push([
          ...run.map(v => [scale(x, v.chainageM), scale(y, v.crownDepthM as number)] as [number, number]),
          ...[...run].reverse().map(v => [scale(x, v.chainageM), scale(y, v.invertDepthM as number)] as [number, number]),
        ]);
      }
    }
    run = [];
  };
  for (const v of profile.vertices) { if (v.crownDepthM === null) flush(); else run.push(v); }
  flush();
  return {
    box, x, y, profile, crossings, depthRange: [minD, maxD],
    xTicks: ticks(0, x.d1, 6), yTicks: ticks(0, maxD, 4),
    crownRuns, bands,
    unknownVertices: profile.vertices.filter(v => v.crownDepthM === null).map(v => ({ chainageM: v.chainageM, x: scale(x, v.chainageM) })),
  };
}

export interface SectionLayout {
  box: Box;
  x: Scale;
  y: Scale;
  section: CrossSection;
  depthRange: [number, number];
  xTicks: number[];
  yTicks: number[];
  /** Own structure outline in screen coords (circle: cx, cy, rx, ry; box: x, y, w, h); null when depth or size UNKNOWN. */
  own: { shape: 'circular'; cx: number; cy: number; rx: number; ry: number } | { shape: 'box'; x: number; y: number; w: number; h: number } | null;
}

export function layoutSection(a: UndergroundAlignmentObject, chainageM: number, halfWidthM: number, others: readonly CityObject[], size: { width: number; height: number }): SectionLayout {
  const section = crossSectionAt(a, chainageM, halfWidthM, others);
  const box: Box = { width: size.width, height: size.height, left: 48, right: 12, top: 18, bottom: 26 };
  const o = section.own;
  const depths = [o.crownDepthM, o.crownDepthM !== null && o.heightM !== null ? o.crownDepthM + o.heightM : null,
    ...section.items.flatMap(i => [i.extent.topDepthM, i.extent.bottomDepthM])].filter((d): d is number => d !== null && Number.isFinite(d));
  const maxD = Math.max(MIN_DEPTH_RANGE, ...depths.filter(d => d > 0)) * 1.2;
  const minD = -Math.max(2, maxD * 0.12);
  const x: Scale = { d0: -halfWidthM, d1: halfWidthM, r0: box.left, r1: size.width - box.right };
  const y: Scale = { d0: minD, d1: maxD, r0: box.top, r1: size.height - box.bottom };
  let own: SectionLayout['own'] = null;
  if (o.crownDepthM !== null && o.widthM !== null && o.heightM !== null) {
    if (o.section.shape === 'circular') {
      const cx = scale(x, 0), cy = scale(y, o.crownDepthM + o.heightM / 2);
      own = { shape: 'circular', cx, cy, rx: Math.abs(scale(x, o.widthM / 2) - scale(x, 0)), ry: Math.abs(scale(y, o.heightM / 2) - scale(y, 0)) };
    } else {
      const x0 = scale(x, -o.widthM / 2), y0 = scale(y, o.crownDepthM);
      own = { shape: 'box', x: x0, y: y0, w: scale(x, o.widthM / 2) - x0, h: scale(y, o.crownDepthM + o.heightM) - y0 };
    }
  }
  return { box, x, y, section, depthRange: [minD, maxD], xTicks: ticks(-halfWidthM, halfWidthM, 6), yTicks: ticks(0, maxD, 4), own };
}

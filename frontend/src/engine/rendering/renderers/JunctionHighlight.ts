import { Viewer, Primitive, GeometryInstance, PolylineGeometry, PolylineMaterialAppearance, Material, Color } from 'cesium';
import { scenePoint } from '../../terrain/groundHeight';

/**
 * Preview of a whole imported junction in Build (docs/OVERHAUL.md §23):
 * every approach as an arrow pointing in (green), every exit as an arrow
 * pointing out (orange), and the pieces inside the junction (cyan). Drawn
 * lifted and without a depth test, not pickable, so clicks reach the roads.
 */
export const JUNCTION_HIGHLIGHT_STYLE = {
  approach: { css: '#4ade80', width: 16 },
  exit: { css: '#fb923c', width: 16 },
  internal: { css: '#22d3ee', width: 10 },
  /** An arm the editor points at (hover or the movement being edited). */
  focus: { css: '#fde047', width: 24 },
} as const;
const LIFT_M = 3;
/** Length of an arm drawn from the junction (m). */
export const ARM_DRAW_M = 45;

export interface JunctionHighlightInput {
  junctionId: string;
  approaches: { id: string; path: readonly (readonly number[])[] }[];
  exits: { id: string; path: readonly (readonly number[])[] }[];
  internal: { id: string; path: readonly (readonly number[])[] }[];
  focusArmIds?: readonly string[];
}

export class JunctionHighlight {
  private viewer: Viewer | null = null;
  private primitives: Primitive[] = [];
  private current: { junctionId: string; approachIds: string[]; exitIds: string[]; internalIds: string[]; focusArmIds: string[] } | null = null;

  public setViewer(viewer: Viewer) {
    this.clear();
    this.viewer = viewer;
  }

  /** What is on show (ids), for tests and the browser check; null when nothing. */
  public shown() {
    return this.current ? structuredClone(this.current) : null;
  }

  public show(input: JunctionHighlightInput) {
    this.clear();
    const focus = new Set(input.focusArmIds ?? []);
    this.current = { junctionId: input.junctionId, approachIds: input.approaches.map(a => a.id), exitIds: input.exits.map(a => a.id), internalIds: input.internal.map(a => a.id), focusArmIds: [...focus] };
    const viewer = this.viewer;
    if (!viewer || viewer.isDestroyed()) return;
    const renderState = { depthTest: { enabled: false }, depthMask: false };
    const add = (lines: { id: string; path: readonly (readonly number[])[] }[], style: { css: string; width: number }, arrow: boolean) => {
      const ok = lines.filter(l => l.path.length >= 2);
      if (!ok.length) return;
      this.primitives.push(viewer.scene.primitives.add(new Primitive({
        geometryInstances: ok.map(l => new GeometryInstance({
          id: `junction-highlight:${l.id}`,
          geometry: new PolylineGeometry({ positions: l.path.map(p => scenePoint(p[0], p[1], (p[2] || 0) + LIFT_M)), width: style.width, vertexFormat: PolylineMaterialAppearance.VERTEX_FORMAT }),
        })),
        appearance: new PolylineMaterialAppearance({ translucent: true, renderState,
          material: arrow ? Material.fromType('PolylineArrow', { color: Color.fromCssColorString(style.css).withAlpha(0.95) })
            : Material.fromType('Color', { color: Color.fromCssColorString(style.css).withAlpha(0.85) }) }),
        asynchronous: false,
        allowPicking: false,
      })));
    };
    add(input.internal, JUNCTION_HIGHLIGHT_STYLE.internal, false);
    add(input.approaches.filter(a => !focus.has(a.id)), JUNCTION_HIGHLIGHT_STYLE.approach, true);
    add(input.exits.filter(a => !focus.has(a.id)), JUNCTION_HIGHLIGHT_STYLE.exit, true);
    add([...input.approaches, ...input.exits].filter(a => focus.has(a.id)), JUNCTION_HIGHLIGHT_STYLE.focus, true);
    viewer.scene.requestRender();
  }

  public clear() {
    this.current = null;
    if (this.viewer && !this.viewer.isDestroyed()) {
      for (const p of this.primitives) this.viewer.scene.primitives.remove(p);
      this.viewer.scene.requestRender();
    }
    this.primitives = [];
  }

  public dispose() {
    this.clear();
    this.viewer = null;
  }
}

const M_PER_DEG_LAT = 111320;
/** The part of a polyline within `lengthM` of its end (fromEnd) or start, in travel order. */
export function cutPath(path: readonly (readonly number[])[], lengthM: number, fromEnd: boolean): number[][] {
  const pts = fromEnd ? [...path].reverse() : [...path];
  const out: number[][] = [[...pts[0]]];
  let left = lengthM;
  for (let i = 1; i < pts.length && left > 0; i++) {
    const a = pts[i - 1], b = pts[i];
    const d = Math.hypot((b[0] - a[0]) * M_PER_DEG_LAT * Math.cos(a[1] * Math.PI / 180), (b[1] - a[1]) * M_PER_DEG_LAT);
    if (d >= left) {
      const t = left / Math.max(d, 1e-9);
      out.push([a[0] + t * (b[0] - a[0]), a[1] + t * (b[1] - a[1]), (a[2] || 0) + t * ((b[2] || 0) - (a[2] || 0))]);
      left = 0;
    } else { out.push([...b]); left -= d; }
  }
  return fromEnd ? out.reverse() : out;
}

import {
  Viewer,
  Primitive,
  GeometryInstance,
  PolylineGeometry,
  PolylineColorAppearance,
  PolylineMaterialAppearance,
  Material,
  ColorGeometryInstanceAttribute,
  Color,
} from 'cesium';
import { scenePoint } from '../../terrain/groundHeight';

/**
 * A highlight drawn over whole roads (OpenStreetMap ways), for previews
 * before an edit and for pointing at a road from a panel:
 * - 'lane-scope': the ways a Build lane edit will change (docs/OVERHAUL.md §16)
 * - 'binding': the stretch that sets a direction's capacity in the analysis
 *
 * One primitive of plain polylines lifted above the road and drawn without a
 * depth test, so the road mesh or buildings never hide it. It is not
 * pickable: a click on it still selects the road underneath.
 */
export type RoadHighlightKind = 'lane-scope' | 'binding';

/**
 * `binding` sits on the selected road in Simulate, under its 16 px seed glow, among
 * study-area lines whose upstream colour is the same amber (StudyAreaVisualizer):
 * drawn 9 px wide and plain, it was hidden (merged-build browser check, 2026-11-06).
 * It is now wider than the glow, with a dark outline that sets it apart.
 */
export const ROAD_HIGHLIGHT_STYLE: Record<RoadHighlightKind, { css: string; width: number; outline?: { css: string; widthPx: number } }> = {
  'lane-scope': { css: '#e879f9', width: 9 },
  binding: { css: '#fbbf24', width: 22, outline: { css: '#0f172a', widthPx: 5 } },
};
const STYLE = ROAD_HIGHLIGHT_STYLE;
const LIFT_M = 2.5;

export class RoadHighlight {
  private viewer: Viewer | null = null;
  private primitive: Primitive | null = null;
  private current: { kind: RoadHighlightKind; roadIds: string[] } | null = null;

  public setViewer(viewer: Viewer) {
    this.clear();
    this.viewer = viewer;
  }

  /** The highlight on show (its road ids), for tests and the browser check; null when none. */
  public shown(): { kind: RoadHighlightKind; roadIds: string[]; css: string } | null {
    return this.current ? { ...this.current, roadIds: [...this.current.roadIds], css: STYLE[this.current.kind].css } : null;
  }

  /** Draws these roads highlighted (replacing any highlight), or with an empty list clears it. */
  public show(kind: RoadHighlightKind, roads: readonly { id: string; coordinates: readonly (readonly number[])[] }[]) {
    this.clear();
    const lines = roads.filter(r => r.coordinates.length >= 2);
    if (!lines.length) return;
    this.current = { kind, roadIds: lines.map(r => r.id) };
    const viewer = this.viewer;
    if (!viewer || viewer.isDestroyed()) return;
    const style = STYLE[kind];
    const color = ColorGeometryInstanceAttribute.fromColor(Color.fromCssColorString(style.css).withAlpha(0.95));
    const renderState = { depthTest: { enabled: false }, depthMask: false };
    const outline = style.outline;
    const vertexFormat = outline ? PolylineMaterialAppearance.VERTEX_FORMAT : PolylineColorAppearance.VERTEX_FORMAT;
    const instances = lines.map(r => new GeometryInstance({
      id: `road-highlight:${kind}:${r.id}`,
      geometry: new PolylineGeometry({ positions: r.coordinates.map(p => scenePoint(p[0], p[1], (p[2] || 0) + LIFT_M)), width: style.width, vertexFormat }),
      ...(outline ? {} : { attributes: { color } }),
    }));
    const appearance = outline
      ? new PolylineMaterialAppearance({ translucent: true, renderState,
        material: Material.fromType('PolylineOutline', { color: Color.fromCssColorString(style.css), outlineColor: Color.fromCssColorString(outline.css), outlineWidth: outline.widthPx }) })
      : new PolylineColorAppearance({ translucent: true, renderState });
    this.primitive = viewer.scene.primitives.add(new Primitive({
      geometryInstances: instances,
      appearance,
      asynchronous: false,
      allowPicking: false,
    }));
    viewer.scene.requestRender();
  }

  public clear() {
    this.current = null;
    if (this.primitive && this.viewer && !this.viewer.isDestroyed()) {
      this.viewer.scene.primitives.remove(this.primitive);
      this.viewer.scene.requestRender();
    }
    this.primitive = null;
  }

  public dispose() {
    this.clear();
    this.viewer = null;
  }
}

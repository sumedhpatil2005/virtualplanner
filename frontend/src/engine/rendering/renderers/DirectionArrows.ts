import {
  Viewer,
  Entity,
  CustomDataSource,
  Color,
  ConstantProperty,
  PolylineArrowMaterialProperty,
  BoundingSphere,
  HeadingPitchRange,
  Math as CesiumMath,
} from 'cesium';
import { scenePoint } from '../../terrain/groundHeight';
import { directionColor } from '../../simulation/directions';

/**
 * Arrows along the selected road, one set per direction of travel, pointing
 * the way that direction drives and coloured like its row in the analysis
 * panel (DIRECTION_COLORS).
 *
 * A few short arrow polylines per direction (entities: tens at most), offset
 * to the left of travel (traffic keeps left in India) so the two directions
 * of a two-way road sit side by side. Highlighting changes the shared
 * colour and width properties in place; nothing is rebuilt.
 */

/** Offset (m) to the left of travel, so opposite directions on one centre line do not overlap. */
export const ARROW_OFFSET_M = 4;
/** Height (m) above the road the arrows float, so the road mesh does not hide them. */
const ARROW_LIFT_M = 1.5;
const MAX_ARROWS_PER_PATH = 8;
const ARROW_EVERY_M = 90;
const WIDTH = { normal: 24, focused: 34, dimmed: 14 } as const;
const ALPHA = { normal: 0.95, focused: 1, dimmed: 0.28 } as const;

const ARROW_ID = /^dir-arrow:(\d+):\d+$/;
export const arrowId = (direction: number, k: number) => `dir-arrow:${direction}:${k}`;
/** The direction an arrow entity id belongs to, or null for anything else. */
export function directionOfArrowId(id: unknown): number | null {
  const m = typeof id === 'string' ? ARROW_ID.exec(id) : null;
  return m ? Number(m[1]) : null;
}

type Pt = readonly number[];

/**
 * Arrow pieces along a path in travel order: up to MAX_ARROWS_PER_PATH evenly
 * spaced pieces, each a short run of points following the road, shifted
 * `offsetM` to the left of travel. Pure, for tests.
 */
export function arrowPieces(path: readonly Pt[], offsetM = ARROW_OFFSET_M): [number, number, number][][] {
  if (path.length < 2) return [];
  const lat0 = path[0][1];
  const kx = 111320 * Math.cos((lat0 * Math.PI) / 180), ky = 111320;
  const xy = path.map(p => [(p[0] - path[0][0]) * kx, (p[1] - path[0][1]) * ky, p[2] || 0]);
  const cum = [0];
  for (let i = 1; i < xy.length; i++) cum.push(cum[i - 1] + Math.hypot(xy[i][0] - xy[i - 1][0], xy[i][1] - xy[i - 1][1]));
  const total = cum[cum.length - 1];
  if (total < 5) return [];
  const n = Math.max(1, Math.min(MAX_ARROWS_PER_PATH, Math.round(total / ARROW_EVERY_M)));
  const spacing = total / n;
  const len = Math.min(45, spacing * 0.6);
  const at = (s: number) => {
    let i = 1;
    while (i < cum.length - 1 && cum[i] < s) i++;
    const seg = Math.max(1e-9, cum[i] - cum[i - 1]);
    const t = Math.min(1, Math.max(0, (s - cum[i - 1]) / seg));
    const a = xy[i - 1], b = xy[i];
    const dx = (b[0] - a[0]) / seg, dy = (b[1] - a[1]) / seg;
    // Left of travel: the direction rotated 90 degrees anticlockwise
    const x = a[0] + (b[0] - a[0]) * t - dy * offsetM, y = a[1] + (b[1] - a[1]) * t + dx * offsetM;
    return [path[0][0] + x / kx, path[0][1] + y / ky, a[2] + (b[2] - a[2]) * t] as [number, number, number];
  };
  const pieces: [number, number, number][][] = [];
  for (let k = 0; k < n; k++) {
    const mid = (k + 0.5) * spacing, s0 = Math.max(0, mid - len / 2), s1 = Math.min(total, mid + len / 2);
    const pts = [at(s0)];
    for (let i = 1; i < cum.length - 1; i++) if (cum[i] > s0 && cum[i] < s1) pts.push(at(cum[i]));
    pts.push(at(s1));
    pieces.push(pts);
  }
  return pieces;
}

interface DirectionDrawing {
  color: Color;
  colorProp: ConstantProperty;
  widthProp: ConstantProperty;
  entities: Entity[];
  points: [number, number, number][];
}

export class DirectionArrows {
  private viewer: Viewer | null = null;
  private dataSource: CustomDataSource | null = null;
  private drawn: readonly { paths: readonly (readonly Pt[])[] }[] | null = null;
  private dirs: DirectionDrawing[] = [];
  private focus: number | null = null;

  public setViewer(viewer: Viewer) {
    this.dispose();
    this.viewer = viewer;
    this.dataSource = new CustomDataSource('direction-arrows');
    viewer.dataSources.add(this.dataSource);
  }

  public dispose() {
    this.clear();
    if (this.viewer && !this.viewer.isDestroyed() && this.dataSource) this.viewer.dataSources.remove(this.dataSource, true);
    this.dataSource = null;
    this.viewer = null;
  }

  public clear() {
    this.dataSource?.entities.removeAll();
    this.dirs = [];
    this.drawn = null;
  }

  /** Draws arrows for these directions (null: none). The same list again is a no-op. */
  public show(directions: readonly { paths: readonly (readonly Pt[])[] }[] | null) {
    if (directions === this.drawn) return;
    this.clear();
    const ds = this.dataSource;
    if (!directions || !ds) return;
    this.drawn = directions;
    ds.entities.suspendEvents();
    directions.forEach((d, i) => {
      const color = Color.fromCssColorString(directionColor(i));
      const colorProp = new ConstantProperty(color.withAlpha(ALPHA.normal));
      const widthProp = new ConstantProperty(WIDTH.normal);
      const material = new PolylineArrowMaterialProperty(colorProp);
      const entities: Entity[] = [];
      let k = 0;
      for (const path of d.paths ?? []) {
        for (const piece of arrowPieces(path)) {
          entities.push(ds.entities.add({
            id: arrowId(i, k++),
            polyline: {
              positions: piece.map(p => scenePoint(p[0], p[1], p[2] + ARROW_LIFT_M)),
              width: widthProp,
              material,
              // Still visible where buildings or the road mesh cover it
              depthFailMaterial: material,
            },
          }));
        }
      }
      this.dirs.push({ color, colorProp, widthProp, entities, points: (d.paths ?? []).flat().map(p => [p[0], p[1], p[2] || 0] as [number, number, number]) });
    });
    ds.entities.resumeEvents();
    this.apply();
  }

  /** Brightens and thickens one direction's arrows and dims the others; null shows all alike. */
  public setFocus(direction: number | null) {
    this.focus = direction;
    this.apply();
  }

  private apply() {
    this.dirs.forEach((d, i) => {
      const state = this.focus === null ? 'normal' : this.focus === i ? 'focused' : 'dimmed';
      d.colorProp.setValue(state === 'focused' ? Color.lerp(d.color, Color.WHITE, 0.25, new Color()).withAlpha(ALPHA.focused) : d.color.withAlpha(ALPHA[state]));
      d.widthProp.setValue(WIDTH[state]);
    });
  }

  /** Frames one direction's stretch, keeping the camera's heading (and its tilt, within limits). */
  public frame(direction: number) {
    const d = this.dirs[direction];
    const viewer = this.viewer;
    if (!d || !viewer || d.points.length === 0) return;
    const sphere = BoundingSphere.fromPoints(d.points.map(p => scenePoint(p[0], p[1], p[2])));
    const pitch = Math.min(CesiumMath.toRadians(-30), Math.max(CesiumMath.toRadians(-85), viewer.camera.pitch));
    viewer.camera.flyToBoundingSphere(sphere, {
      offset: new HeadingPitchRange(viewer.camera.heading, pitch, Math.min(1800, Math.max(220, sphere.radius * 3))),
      duration: 1.0,
    });
  }
}

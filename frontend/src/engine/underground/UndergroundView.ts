/**
 * Underground view state on the Cesium globe (UX_ARCHITECTURE §7, PRODUCT_UX_RESEARCH §3.2/§3.3):
 * ground opacity (globe.translucency.frontFaceAlpha / backFaceAlpha, optionally limited to a rectangle), X-ray
 * (translucent ground + no terrain depth test so buried objects show through), undergroundColor, and camera collision
 * detection off so the camera may go below ground. `leave()` restores exactly what `enter()` found.
 *
 * Cesium API used (CesiumJS ref-doc, GlobeTranslucency / Globe / ScreenSpaceCameraController):
 *   globe.translucency.{enabled, frontFaceAlpha, backFaceAlpha, rectangle}, globe.undergroundColor,
 *   globe.undergroundColorAlphaByDistance, globe.depthTestAgainstTerrain, screenSpaceCameraController.enableCollisionDetection.
 * The viewer is passed in (structurally typed) so this is testable without WebGL.
 */
import { Color, Rectangle } from 'cesium';

export interface GlobeLike {
  translucency: { enabled: boolean; frontFaceAlpha: number; backFaceAlpha: number; rectangle: unknown };
  undergroundColor: unknown;
  depthTestAgainstTerrain: boolean;
}
export interface ViewerLike {
  scene: { globe: GlobeLike; screenSpaceCameraController: { enableCollisionDetection: boolean }; requestRender?: () => void };
}

export interface UndergroundViewSettings {
  /** Ground opacity 0..1 (1 = opaque ground). */
  groundOpacity: number;
  /** X-ray: buried objects drawn through the ground (no terrain depth test). */
  xray: boolean;
  /** Limit translucency to this lon/lat box [west, south, east, north] in degrees; null = whole globe. */
  rectangleDeg: [number, number, number, number] | null;
}

export const DEFAULT_UNDERGROUND_SETTINGS: UndergroundViewSettings = { groundOpacity: 0.35, xray: false, rectangleDeg: null };

interface Saved {
  enabled: boolean; front: number; back: number; rectangle: unknown; undergroundColor: unknown; depthTest: boolean; collision: boolean;
}

/** Cesium value factories (injectable so the state logic is testable without the real Cesium module). */
export interface UndergroundViewDeps {
  rectangle: (deg: [number, number, number, number] | null) => unknown;
  tint: () => unknown;
}
const cesiumDeps: UndergroundViewDeps = {
  rectangle: deg => (deg ? Rectangle.fromDegrees(...deg) : Rectangle.MAX_VALUE),
  tint: () => Color.fromCssColorString('#1e293b').withAlpha(0.6), // dark slate, PRODUCT_UX_RESEARCH §3.3
};

export class UndergroundView {
  private deps: UndergroundViewDeps;
  constructor(deps: UndergroundViewDeps = cesiumDeps) { this.deps = deps; }

  private saved: Saved | null = null;
  private viewer: ViewerLike | null = null;
  private settings: UndergroundViewSettings = { ...DEFAULT_UNDERGROUND_SETTINGS };
  private listeners = new Set<() => void>();

  isActive() { return this.saved !== null; }
  getSettings(): UndergroundViewSettings { return { ...this.settings }; }
  onChange(cb: () => void) { this.listeners.add(cb); return () => { this.listeners.delete(cb); }; }
  private emit() { this.listeners.forEach(cb => cb()); }

  /** Saves the globe state and applies the underground settings. Idempotent. */
  enter(viewer: ViewerLike | null) {
    if (!viewer) return;
    if (this.saved && this.viewer === viewer) { this.apply(); return; }
    const g = viewer.scene.globe;
    this.viewer = viewer;
    this.saved = {
      enabled: g.translucency.enabled, front: g.translucency.frontFaceAlpha, back: g.translucency.backFaceAlpha,
      rectangle: g.translucency.rectangle, undergroundColor: g.undergroundColor, depthTest: g.depthTestAgainstTerrain,
      collision: viewer.scene.screenSpaceCameraController.enableCollisionDetection,
    };
    this.apply();
    this.emit();
  }

  /** Restores the state saved by enter(). */
  leave() {
    const v = this.viewer, s = this.saved;
    if (!v || !s) return;
    const g = v.scene.globe;
    g.translucency.enabled = s.enabled;
    g.translucency.frontFaceAlpha = s.front;
    g.translucency.backFaceAlpha = s.back;
    g.translucency.rectangle = s.rectangle;
    g.undergroundColor = s.undergroundColor;
    g.depthTestAgainstTerrain = s.depthTest;
    v.scene.screenSpaceCameraController.enableCollisionDetection = s.collision;
    v.scene.requestRender?.();
    this.saved = null;
    this.emit();
  }

  update(patch: Partial<UndergroundViewSettings>) {
    const op = patch.groundOpacity;
    this.settings = {
      ...this.settings, ...patch,
      ...(op !== undefined ? { groundOpacity: Math.min(1, Math.max(0, Number.isFinite(op) ? op : 1)) } : {}),
    };
    this.apply();
    this.emit();
  }

  private apply() {
    const v = this.viewer;
    if (!v || !this.saved) return;
    const g = v.scene.globe;
    const { groundOpacity, xray, rectangleDeg } = this.settings;
    const translucent = groundOpacity < 1 || xray;
    g.translucency.enabled = translucent;
    // X-ray forces see-through even at opacity 1 (cap at 0.5 so buried objects are visible)
    const alpha = xray ? Math.min(groundOpacity, 0.5) : groundOpacity;
    g.translucency.frontFaceAlpha = alpha;
    g.translucency.backFaceAlpha = alpha;
    g.translucency.rectangle = this.deps.rectangle(rectangleDeg);
    g.undergroundColor = this.deps.tint();
    // Opaque ground hides buried geometry correctly; X-ray turns the terrain depth test off
    g.depthTestAgainstTerrain = !xray && !translucent;
    v.scene.screenSpaceCameraController.enableCollisionDetection = false;
    v.scene.requestRender?.();
  }
}

export const undergroundView = new UndergroundView();

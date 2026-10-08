import {
  Viewer,
  Entity,
  CustomDataSource,
  Color,
  Cartesian2,
  Cartesian3,
  BoundingSphere,
  HeadingPitchRange,
  PolylineGlowMaterialProperty,
  PolylineDashMaterialProperty,
  LabelStyle,
  DistanceDisplayCondition,
  CallbackProperty,
  Primitive,
  GeometryInstance,
  PolylineGeometry,
  PolylineColorAppearance,
  ColorGeometryInstanceAttribute,
  ShowGeometryInstanceAttribute,
  DistanceDisplayConditionGeometryInstanceAttribute,
  PointPrimitiveCollection,
  LabelCollection,
  Math as CesiumMath,
} from 'cesium';
import { boundsOf, type StudyArea, type SegmentRole, type JunctionKind, type BoundaryKind, type Bounds } from '../../simulation/StudyAreaExplorer';
import { speedColor } from './MicroTrafficVisualizer';

/** Colours shared by the map overlay and the panel legend. */
export const STUDY_ROLE_COLORS: Record<SegmentRole, string> = {
  seed: '#67e8f9',
  both: '#a78bfa',
  downstream: '#34d399',
  upstream: '#fbbf24',
};

export const STUDY_BOUNDARY_COLORS: Record<BoundaryKind, string> = {
  entry: '#fbbf24',
  exit: '#34d399',
  entry_exit: '#f472b6',
};

export const STUDY_GRADE_SEPARATION_COLOR = '#38bdf8';

const JUNCTION_SIZE: Record<JunctionKind, number> = {
  dead_end: 6,
  t_junction: 7,
  crossroads: 9,
  complex: 11,
  roundabout: 9,
};

const BOUNDARY_LABEL: Record<BoundaryKind, string> = { entry: 'IN', exit: 'OUT', entry_exit: 'IN/OUT' };

/** Height above the road surface markers are drawn at, so they are not hidden inside the road mesh. */
const LIFT_M = 1.2;
/** Road-stretch lines lie just above the asphalt, so vehicles drive over them rather than through them. */
const LINE_LIFT_M = 0.2;
const LINE_WIDTH_PX = 5;
/**
 * While traffic runs, the speed-coloured stretches show only from at least
 * this far away: up close the vehicles themselves show the traffic, and
 * lines drawn over them only clutter the road.
 */
const SPEED_LINES_FROM_M = 900;
/** One pulse of the selected road's glow (ms). */
const PULSE_MS = 1600;
/** How long the area takes to spread out from the seed road when first shown. */
const REVEAL_MS = 700;
const ALWAYS_ON_TOP = Number.POSITIVE_INFINITY;
const EMPTY_STRETCH = '#64748b';

/**
 * Draws a study area on the map: road stretches coloured by their relation to
 * the seed road, junctions, cordon crossings, flyover crossings and problems.
 *
 * A 5 km area has tens of thousands of stretches and junctions, so they are
 * drawn as batched primitives (one for all stretches, one point and one label
 * collection for the markers) and recoloured in place while traffic runs.
 * Only the selected road, with its pulsing glow, is drawn as entities.
 */
export class StudyAreaVisualizer {
  private viewer: Viewer | null = null;
  private dataSource: CustomDataSource | null = null;
  private revealHandle: number | null = null;
  private focused = false;
  /** All stretches but the selected road's, one geometry instance each (id = stretch key). */
  private lines: Primitive | null = null;
  private lineKeys: string[] = [];
  private lineAttributes = new Map<string, any>();
  /** Show/colour changes asked for before the lines finished building. */
  private pendingSpeeds: ReadonlyMap<string, number> | null = null;
  private points: PointPrimitiveCollection | null = null;
  private labels: LabelCollection | null = null;
  /** The selected road's stretches, by key. */
  private seedEntities = new Map<string, Entity>();
  /** Colour each selected stretch currently glows in. */
  private seedColors = new Map<string, string>();
  /** Drop lines of flyover crossings (few, so entities). */
  private markerEntities: Entity[] = [];
  private markersVisible = true;

  public setViewer(viewer: Viewer) {
    this.dispose();
    this.viewer = viewer;
    this.dataSource = new CustomDataSource('study-area');
    viewer.dataSources.add(this.dataSource);
    if (this.focused) this.applyFocus();
  }

  public dispose() {
    this.clear();
    if (this.viewer && !this.viewer.isDestroyed() && this.dataSource) {
      this.viewer.dataSources.remove(this.dataSource, true);
    }
    this.dataSource = null;
    this.viewer = null;
  }

  public clear() {
    this.cancelReveal();
    this.dataSource?.entities.removeAll();
    if (this.viewer && !this.viewer.isDestroyed()) {
      const primitives = this.viewer.scene.primitives;
      if (this.lines) primitives.remove(this.lines);
      if (this.points) primitives.remove(this.points);
      if (this.labels) primitives.remove(this.labels);
    }
    this.lines = this.points = this.labels = null;
    this.lineKeys = [];
    this.lineAttributes.clear();
    this.pendingSpeeds = null;
    this.seedEntities.clear();
    this.seedColors.clear();
    this.markerEntities = [];
  }

  /** The selected road's glow breathes, so it reads as the subject of the study. */
  private pulsingGlow(color: Color) {
    return new PolylineGlowMaterialProperty({
      color,
      glowPower: new CallbackProperty(() => 0.16 + 0.14 * (0.5 + 0.5 * Math.sin((performance.now() / PULSE_MS) * Math.PI * 2)), false),
    });
  }

  public setMarkersVisible(visible: boolean) {
    this.markersVisible = visible;
    if (this.points) this.points.show = visible;
    if (this.labels) this.labels.show = visible;
    for (const e of this.markerEntities) e.show = visible;
  }

  /** A stretch's per-instance attributes, once the lines have been built. */
  private attributes(key: string) {
    let a = this.lineAttributes.get(key);
    if (!a && this.lines?.ready) {
      a = this.lines.getGeometryInstanceAttributes(key);
      if (a) this.lineAttributes.set(key, a);
    }
    return a;
  }

  /**
   * Colours road stretches by traffic speed (share of the speed limit); stretches
   * without vehicles fade to grey. The selected road keeps its pulsing glow, in
   * the colour of its traffic. Re-render the area to restore role colours.
   */
  public setSegmentSpeeds(ratios: ReadonlyMap<string, number>) {
    this.seedEntities.forEach((entity, key) => {
      const ratio = ratios.get(key);
      const css = ratio === undefined ? STUDY_ROLE_COLORS.seed : speedColor(ratio);
      if (this.seedColors.get(key) !== css) {
        this.seedColors.set(key, css);
        entity.polyline!.material = this.pulsingGlow(Color.fromCssColorString(css));
      }
    });
    if (!this.lines?.ready) {
      this.pendingSpeeds = ratios;
      return;
    }
    const scratch = new Color();
    const fromFar = new DistanceDisplayCondition(SPEED_LINES_FROM_M, Number.MAX_VALUE);
    for (const key of this.lineKeys) {
      const a = this.attributes(key);
      if (!a) continue;
      const ratio = ratios.get(key);
      Color.fromCssColorString(ratio === undefined ? EMPTY_STRETCH : speedColor(ratio), scratch);
      scratch.alpha = ratio === undefined ? 0.35 : 0.8;
      a.color = ColorGeometryInstanceAttribute.toValue(scratch, a.color);
      a.distanceDisplayCondition = DistanceDisplayConditionGeometryInstanceAttribute.toValue(fromFar, a.distanceDisplayCondition);
    }
  }

  /** Dims the base map while Simulation mode is on, so the highlighted network stands out. */
  public setFocus(on: boolean) {
    this.focused = on;
    this.applyFocus();
  }

  private applyFocus() {
    if (!this.viewer) return;
    const layers = this.viewer.imageryLayers;
    for (let i = 0; i < layers.length; i++) layers.get(i).brightness = this.focused ? 0.72 : 1.0;
  }

  /** Draws the area. With `reveal`, stretches appear outward from the seed like a ripple. */
  public render(area: StudyArea, reveal: boolean) {
    this.clear();
    const ds = this.dataSource;
    const viewer = this.viewer;
    if (!ds || !viewer) return;

    // The selected road: a pulsing glow, as entities
    ds.entities.suspendEvents();
    const seedColor = Color.fromCssColorString(STUDY_ROLE_COLORS.seed);
    for (const s of area.segments) {
      if (s.role !== 'seed') continue;
      this.seedEntities.set(s.key, ds.entities.add({
        polyline: {
          positions: s.coordinates.map(c => Cartesian3.fromDegrees(c[0], c[1], (c[2] || 0) + LINE_LIFT_M)),
          width: 16,
          material: this.pulsingGlow(seedColor),
        },
      }));
    }
    ds.entities.resumeEvents();

    // Every other stretch: one batched primitive, built off the main thread
    const others = area.segments.filter(s => s.role !== 'seed' && s.coordinates.length >= 2);
    this.lineKeys = others.map(s => s.key);
    if (others.length > 0) {
      this.lines = viewer.scene.primitives.add(new Primitive({
        geometryInstances: others.map(s => {
          const fade = 1 - 0.5 * Math.min(1, s.distanceM / area.rangeMeters);
          return new GeometryInstance({
            id: s.key,
            geometry: new PolylineGeometry({
              positions: s.coordinates.map(c => Cartesian3.fromDegrees(c[0], c[1], (c[2] || 0) + LINE_LIFT_M)),
              width: LINE_WIDTH_PX,
              vertexFormat: PolylineColorAppearance.VERTEX_FORMAT,
            }),
            attributes: {
              color: ColorGeometryInstanceAttribute.fromColor(Color.fromCssColorString(STUDY_ROLE_COLORS[s.role]).withAlpha(0.95 * fade)),
              show: new ShowGeometryInstanceAttribute(!reveal),
              distanceDisplayCondition: new DistanceDisplayConditionGeometryInstanceAttribute(0, Number.MAX_VALUE),
            },
          });
        }),
        appearance: new PolylineColorAppearance({ translucent: true }),
        allowPicking: false,
        asynchronous: true,
      }));
    }

    const showMarkers = () => {
      this.addMarkers(area, viewer);
      this.setMarkersVisible(this.markersVisible);
    };

    if (!reveal || !this.lines) {
      showMarkers();
      this.whenLinesReady(() => this.applyPendingSpeeds());
      return;
    }

    // Reveal: switch stretches on outward from the seed (they arrive sorted by distance)
    let shown = 0;
    let start = 0;
    const step = () => {
      const lines = this.lines;
      if (!lines) return;
      if (!lines.ready) {
        this.revealHandle = requestAnimationFrame(step);
        return;
      }
      start ||= performance.now();
      const t = Math.min(1, (performance.now() - start) / REVEAL_MS);
      const cutoff = area.rangeMeters * t;
      while (shown < others.length && (t === 1 || others[shown].distanceM <= cutoff)) {
        const a = this.attributes(others[shown].key);
        if (a) a.show = ShowGeometryInstanceAttribute.toValue(true, a.show);
        shown++;
      }
      if (t < 1) {
        this.revealHandle = requestAnimationFrame(step);
      } else {
        this.revealHandle = null;
        showMarkers();
        this.applyPendingSpeeds();
      }
    };
    step();
  }

  private whenLinesReady(then: () => void) {
    const check = () => {
      if (!this.lines) return;
      if (this.lines.ready) then();
      else this.revealHandle = requestAnimationFrame(check);
    };
    check();
  }

  private applyPendingSpeeds() {
    const pending = this.pendingSpeeds;
    this.pendingSpeeds = null;
    if (pending) this.setSegmentSpeeds(pending);
  }

  /** Junctions, cordon crossings, flyover crossings and problems, in one point and one label collection. */
  private addMarkers(area: StudyArea, viewer: Viewer) {
    const points = (this.points = viewer.scene.primitives.add(new PointPrimitiveCollection()));
    const labels = (this.labels = viewer.scene.primitives.add(new LabelCollection()));
    const at = (c: readonly number[], z = c[2] || 0) => Cartesian3.fromDegrees(c[0], c[1], z + LIFT_M);
    const ink = Color.fromCssColorString('#0f172a');

    for (const j of area.junctions) {
      points.add({
        position: at(j.coordinates),
        pixelSize: JUNCTION_SIZE[j.kind],
        color: j.kind === 'dead_end' ? Color.fromCssColorString('#94a3b8') : j.kind === 'roundabout' ? Color.fromCssColorString('#22d3ee') : Color.WHITE,
        outlineColor: ink,
        outlineWidth: 2,
        disableDepthTestDistance: ALWAYS_ON_TOP,
      });
    }

    // Roads passing over each other without connecting: a hollow marker and a dashed drop line
    const gradeColor = Color.fromCssColorString(STUDY_GRADE_SEPARATION_COLOR);
    for (const g of area.gradeSeparations) {
      const [lng, lat] = g.coordinates;
      points.add({ position: at([lng, lat], g.upperZ), pixelSize: 11, color: ink, outlineColor: gradeColor, outlineWidth: 3, disableDepthTestDistance: ALWAYS_ON_TOP });
      if (g.upperZ - g.lowerZ > 0.5) {
        this.markerEntities.push(this.dataSource!.entities.add({
          polyline: {
            positions: [at([lng, lat], g.lowerZ), at([lng, lat], g.upperZ)],
            width: 2,
            material: new PolylineDashMaterialProperty({ color: gradeColor, dashLength: 8 }),
            depthFailMaterial: new PolylineDashMaterialProperty({ color: gradeColor.withAlpha(0.5), dashLength: 8 }),
          },
        }));
      }
    }

    for (const b of area.boundary) {
      const color = Color.fromCssColorString(STUDY_BOUNDARY_COLORS[b.kind]);
      points.add({ position: at(b.coordinates), pixelSize: 12, color, outlineColor: ink, outlineWidth: 2, disableDepthTestDistance: ALWAYS_ON_TOP });
      labels.add({
        position: at(b.coordinates),
        text: BOUNDARY_LABEL[b.kind],
        font: '600 11px sans-serif',
        fillColor: color,
        outlineColor: ink,
        outlineWidth: 3,
        style: LabelStyle.FILL_AND_OUTLINE,
        pixelOffset: new Cartesian2(0, -16),
        // Labels only when zoomed in enough to read them without clutter
        distanceDisplayCondition: new DistanceDisplayCondition(0, 3000),
        disableDepthTestDistance: ALWAYS_ON_TOP,
      });
    }

    for (const p of area.problems) {
      if (p.severity === 'info') continue; // dead ends already show as grey junction dots
      points.add({
        position: at(p.location),
        pixelSize: 15,
        color: Color.fromCssColorString(p.severity === 'error' ? '#ef4444' : '#f59e0b'),
        outlineColor: Color.WHITE,
        outlineWidth: 2,
        disableDepthTestDistance: ALWAYS_ON_TOP,
      });
    }
  }

  /** Frames the whole area from a steep, slightly tilted overhead view. */
  public flyToBounds(bounds: Bounds) {
    if (!this.viewer) return;
    const corners = [
      Cartesian3.fromDegrees(bounds.minLng, bounds.minLat),
      Cartesian3.fromDegrees(bounds.maxLng, bounds.minLat),
      Cartesian3.fromDegrees(bounds.minLng, bounds.maxLat),
      Cartesian3.fromDegrees(bounds.maxLng, bounds.maxLat),
    ];
    const sphere = BoundingSphere.fromPoints(corners);
    this.viewer.camera.flyToBoundingSphere(sphere, {
      offset: new HeadingPitchRange(0, CesiumMath.toRadians(-75), Math.max(400, sphere.radius * 2.6)),
      duration: 1.2,
    });
  }

  /**
   * Frames the selected roads up close from a low, tilted angle, looking
   * across them so they run along the screen and the traffic on them reads
   * like a game camera's view.
   */
  public flyToRoad(coords: readonly (readonly number[])[]) {
    if (!this.viewer || coords.length === 0) return;
    const b = boundsOf(coords);
    const lat0 = (b.minLat + b.maxLat) / 2;
    const kx = 111320 * Math.cos(CesiumMath.toRadians(lat0));
    const extentM = Math.hypot((b.maxLng - b.minLng) * kx, (b.maxLat - b.minLat) * 111320);
    // Overall direction of the road, as a compass bearing
    const first = coords[0], last = coords[coords.length - 1];
    const bearing = Math.atan2((last[0] - first[0]) * kx, (last[1] - first[1]) * 111320);
    const z = coords.reduce((s, c) => s + (c[2] || 0), 0) / coords.length;
    const sphere = new BoundingSphere(Cartesian3.fromDegrees((b.minLng + b.maxLng) / 2, lat0, z), Math.max(30, extentM / 2));
    this.viewer.camera.flyToBoundingSphere(sphere, {
      offset: new HeadingPitchRange(bearing - Math.PI / 2, CesiumMath.toRadians(-32), Math.min(1800, Math.max(260, extentM * 1.1))),
      duration: 1.4,
    });
  }

  public flyToPoint(coords: [number, number, number]) {
    if (!this.viewer) return;
    const sphere = new BoundingSphere(Cartesian3.fromDegrees(coords[0], coords[1], coords[2] || 0), 30);
    this.viewer.camera.flyToBoundingSphere(sphere, {
      offset: new HeadingPitchRange(0, CesiumMath.toRadians(-60), 350),
      duration: 1.0,
    });
  }

  private cancelReveal() {
    if (this.revealHandle !== null) {
      cancelAnimationFrame(this.revealHandle);
      this.revealHandle = null;
    }
  }
}

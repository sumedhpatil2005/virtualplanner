import { Viewer, Cartesian3, Color, Model, Matrix4, ColorBlendMode, ShadowMode } from 'cesium';
import type { TrafficMicroSim, SignalState, VehicleView } from '../../simulation/TrafficMicroSim';
import { variantFor, vehicleModelUrl, trafficLightUrl, type VehicleVariant } from '../vehicles/vehicleModels';

/** Road colour by traffic speed as a share of the speed limit (shared with the panel legend). */
export const SPEED_COLORS = { free: '#22c55e', slow: '#f59e0b', stopped: '#ef4444' } as const;
export const speedColor = (ratio: number) => (ratio >= 0.6 ? SPEED_COLORS.free : ratio >= 0.25 ? SPEED_COLORS.slow : SPEED_COLORS.stopped);

const SIGNAL_STATES: readonly SignalState[] = ['red', 'amber', 'green'];
/** Signals stay readable from further out than vehicles. */
const SIGNAL_MIN_PIXEL_SIZE = 22;
/** Signal heads are drawn within this distance of the camera; a large area has hundreds. */
const SIGNAL_RANGE_M = 1500;

/** At most this many vehicles are drawn as 3D models: the ones nearest the camera. */
const MAX_MODELS = 600;
const MODEL_RANGE_M = 6000;
/** Tyres sit this far above the road surface, clear of the lane markings. */
const ROAD_CLEARANCE_M = 0.04;
/** Small on screen when zoomed out, but never so small it disappears. */
const MIN_PIXEL_SIZE = 14;
const MAX_ZOOM_OUT_SCALE = 5;

const DEG = Math.PI / 180;

/** A drawn vehicle: where it is shown, which may lag the simulation slightly. */
interface Track {
  variant: VehicleVariant;
  lng: number;
  lat: number;
  z: number;
  heading: number;
  pitch: number;
  opacity: number;
  seenFrame: number;
  position: Cartesian3;
  cameraDist2: number;
  slot: Slot | null;
}

/** A pooled 3D model, reused by the next vehicle of the same look. */
interface Slot {
  variant: VehicleVariant;
  model: Model | null;
  /** Pose, column-major, applied to the model when it has loaded. */
  matrix: number[];
  opacity: number;
  shown: boolean;
}

/** A signal head: one model per lamp state, the current one shown. */
interface SignalHead {
  models: Partial<Record<SignalState, Model>>;
  state: SignalState;
  matrix: number[];
  position: Cartesian3;
  /** Within range of the camera, so drawn. */
  near: boolean;
}


/**
 * Model matrix (column-major, into `m`) placing a model at `position` (above
 * lng/lat), its +X along `heading` (radians anticlockwise from east) tilted
 * up by `pitch`, +Z up.
 */
function writePose(m: number[], lng: number, lat: number, position: Cartesian3, heading: number, pitch: number) {
  const lam = lng * DEG, phi = lat * DEG;
  const sl = Math.sin(lam), cl = Math.cos(lam), sp = Math.sin(phi), cp = Math.cos(phi);
  // East, north, up here
  const ex = -sl, ey = cl;
  const nx = -sp * cl, ny = -sp * sl, nz = cp;
  const ux = cp * cl, uy = cp * sl, uz = sp;
  // Forward, left and up of the model in east-north-up terms
  const ch = Math.cos(heading), sh = Math.sin(heading), cpi = Math.cos(pitch), spi = Math.sin(pitch);
  const axis = (col: number, a0: number, a1: number, a2: number) => {
    m[col] = a0 * ex + a1 * nx + a2 * ux;
    m[col + 1] = a0 * ey + a1 * ny + a2 * uy;
    m[col + 2] = a1 * nz + a2 * uz;
    m[col + 3] = 0;
  };
  axis(0, ch * cpi, sh * cpi, spi);
  axis(4, -sh, ch, 0);
  axis(8, -spi * ch, -spi * sh, cpi);
  m[12] = position.x;
  m[13] = position.y;
  m[14] = position.z;
  m[15] = 1;
}

/**
 * Draws a running TrafficMicroSim: vehicles as low-poly 3D models driving in
 * their lanes, facing along the road and tilting on ramps, fading in where
 * they enter the area and out where they leave; and one light per signal head.
 */
export class MicroTrafficVisualizer {
  private viewer: Viewer | null = null;
  private signals = new Map<string, SignalHead>();
  private tracks = new Map<number, Track>();
  private freeSlots = new Map<string, Slot[]>();
  private slots: Slot[] = [];
  private live: Track[] = [];
  private frame = 0;
  /** Bumped when the models are removed, so ones still loading are dropped when they arrive. */
  private generation = 0;
  private modelError = false;

  public setViewer(viewer: Viewer) {
    this.dispose();
    this.viewer = viewer;
  }

  private ready() {
    return !!this.viewer && !this.viewer.isDestroyed();
  }

  /**
   * Brings the drawing in line with the simulation. `aheadS` is simulated
   * time since the last step (vehicles are carried on by it); `dtS` is
   * simulated time since the previous draw (retained for API compatibility).
   */
  public draw(sim: TrafficMicroSim, aheadS = 0, _dtS = 0) {
    if (!this.ready()) return;
    const frame = ++this.frame;
    const camera = this.viewer!.camera.positionWC;
    const live = this.live;
    live.length = 0;

    sim.forEachVehicle((v: Readonly<VehicleView>) => {
      let t = this.tracks.get(v.id);
      if (!t) {
        t = {
          variant: variantFor(v.kind, v.id),
          lng: v.lng, lat: v.lat, z: v.z, heading: v.heading, pitch: v.pitch,
          opacity: v.opacity, seenFrame: frame, position: new Cartesian3(), cameraDist2: 0, slot: null,
        };
        this.tracks.set(v.id, t);
      } else {
        // The simulation samples travelled distance on real lane connectors.
        // Spatial easing would cut their corners and separate heading from motion.
        t.lng = v.lng; t.lat = v.lat; t.z = v.z; t.heading = v.heading; t.pitch = v.pitch;
      }
      t.opacity = v.opacity;
      t.seenFrame = frame;
      Cartesian3.fromDegrees(t.lng, t.lat, t.z + ROAD_CLEARANCE_M, undefined, t.position);
      t.cameraDist2 = Cartesian3.distanceSquared(t.position, camera);
      live.push(t);
    }, aheadS);

    // Vehicles that left the area
    this.tracks.forEach((t, id) => {
      if (t.seenFrame === frame) return;
      this.release(t);
      this.tracks.delete(id);
    });

    // Models for the vehicles nearest the camera
    if (live.length > MAX_MODELS) live.sort((a, b) => a.cameraDist2 - b.cameraDist2);
    const range2 = MODEL_RANGE_M * MODEL_RANGE_M;
    for (let i = 0; i < live.length; i++) {
      const t = live[i];
      if (i >= MAX_MODELS || t.cameraDist2 > range2 || t.opacity <= 0.01) {
        this.release(t);
        continue;
      }
      if (!t.slot) t.slot = this.acquire(t.variant);
      if (t.slot) this.pose(t.slot, t);
    }

    this.drawSignals(sim);
  }

  /** Points the slot's model along the vehicle's heading and slope, at its position. */
  private pose(slot: Slot, t: Track) {
    writePose(slot.matrix, t.lng, t.lat, t.position, t.heading, t.pitch);
    slot.opacity = Math.round(t.opacity * 20) / 20;
    slot.shown = true;
    this.apply(slot);
  }

  private apply(slot: Slot) {
    const model = slot.model;
    if (!model) return;
    Matrix4.unpack(slot.matrix, 0, model.modelMatrix);
    model.show = slot.shown;
    if (model.color?.alpha !== slot.opacity) model.color = Color.WHITE.withAlpha(slot.opacity);
  }

  private acquire(variant: VehicleVariant): Slot | null {
    const free = this.freeSlots.get(variant.id);
    if (free && free.length > 0) return free.pop()!;
    if (this.modelError) return null;
    const slot: Slot = { variant, model: null, matrix: new Array<number>(16).fill(0), opacity: 1, shown: false };
    this.slots.push(slot);
    this.loadModel(vehicleModelUrl(variant), MIN_PIXEL_SIZE, model => {
      slot.model = model;
      this.apply(slot);
    });
    return slot;
  }

  /** Adds a model to the scene once loaded, unless the drawing was cleared meanwhile. */
  private loadModel(url: string, minimumPixelSize: number, onReady: (model: Model) => void) {
    const generation = this.generation;
    Model.fromGltfAsync({
      url,
      minimumPixelSize,
      maximumScale: MAX_ZOOM_OUT_SCALE,
      colorBlendMode: ColorBlendMode.HIGHLIGHT,
      shadows: ShadowMode.DISABLED,
      allowPicking: false,
      enablePick: false,
      // A live reflection map per model would cost far more than the model itself
      environmentMapOptions: { enabled: false },
      show: false,
    })
      .then(model => {
        if (generation !== this.generation || !this.viewer || this.viewer.isDestroyed()) {
          model.destroy();
          return;
        }
        onReady(this.viewer.scene.primitives.add(model));
      })
      .catch(err => {
        if (!this.modelError) console.warn('[MicroTrafficVisualizer] A 3D model failed to load:', err);
        this.modelError = true;
      });
  }

  private release(t: Track) {
    const slot = t.slot;
    if (!slot) return;
    t.slot = null;
    slot.shown = false;
    if (slot.model) slot.model.show = false;
    const free = this.freeSlots.get(slot.variant.id);
    if (free) free.push(slot);
    else this.freeSlots.set(slot.variant.id, [slot]);
  }

  /**
   * Signal heads stand still; only the lit lamp changes. Models are made for
   * heads near the camera only (when they first come near), and hidden again
   * when the camera moves away.
   */
  private drawSignals(sim: TrafficMicroSim) {
    const camera = this.viewer!.camera.positionWC;
    const range2 = SIGNAL_RANGE_M * SIGNAL_RANGE_M;
    sim.forEachSignal((linkId, at, state) => {
      let head = this.signals.get(linkId);
      if (!head) {
        const position = Cartesian3.fromDegrees(at.lng, at.lat, at.z + ROAD_CLEARANCE_M);
        const matrix = new Array<number>(16).fill(0);
        writePose(matrix, at.lng, at.lat, position, at.heading, 0);
        head = { models: {}, state, matrix, position, near: false };
        this.signals.set(linkId, head);
      }
      const near = Cartesian3.distanceSquared(head.position, camera) < range2;
      if (near && !head.near && !this.modelError && Object.keys(head.models).length === 0) {
        const created = head;
        for (const lamp of SIGNAL_STATES) {
          this.loadModel(trafficLightUrl(lamp), SIGNAL_MIN_PIXEL_SIZE, model => {
            created.models[lamp] = model;
            Matrix4.unpack(created.matrix, 0, model.modelMatrix);
            model.show = created.near && created.state === lamp;
          });
        }
      }
      if (head.state === state && head.near === near) return;
      head.state = state;
      head.near = near;
      for (const lamp of SIGNAL_STATES) {
        const model = head.models[lamp];
        if (model) model.show = near && lamp === state;
      }
    });
  }

  public clear() {
    this.generation++;
    if (this.viewer && !this.viewer.isDestroyed()) {
      const primitives = this.viewer.scene.primitives;
      for (const s of this.slots) if (s.model) primitives.remove(s.model);
      this.signals.forEach(head => {
        for (const m of Object.values(head.models)) if (m) primitives.remove(m);
      });
    }
    this.signals.clear();
    this.tracks.clear();
    this.freeSlots.clear();
    this.slots = [];
    this.live.length = 0;
  }

  public dispose() {
    this.clear();
    this.viewer = null;
  }
}

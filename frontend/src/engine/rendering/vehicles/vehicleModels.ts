import type { VehicleKind } from '../../simulation/TrafficMicroSim';

/**
 * Low-poly vehicle models for the traffic simulation, built in code as binary
 * glTF (GLB): no asset files to download or license. Flat-shaded parts with
 * per-vertex colours in a single material, so each vehicle is one draw call.
 *
 * Model space is glTF's: +Y up, +Z forward (the front of the vehicle), +X to
 * the vehicle's left. The origin is the centre of the footprint, on the road.
 * Sizes are metres, close to the real vehicles and to the lengths the
 * simulation gives each kind.
 */

type Vec3 = [number, number, number];

/** sRGB hex to linear RGB, as glTF vertex colours are linear. */
function linear(hex: string): Vec3 {
  const n = parseInt(hex.slice(1), 16);
  const ch = (v: number) => {
    const c = v / 255;
    return c <= 0.04045 ? c / 12.92 : Math.pow((c + 0.055) / 1.055, 2.4);
  };
  return [ch((n >> 16) & 255), ch((n >> 8) & 255), ch(n & 255)];
}

const sub = (a: Vec3, b: Vec3): Vec3 => [a[0] - b[0], a[1] - b[1], a[2] - b[2]];
const cross = (a: Vec3, b: Vec3): Vec3 => [a[1] * b[2] - a[2] * b[1], a[2] * b[0] - a[0] * b[2], a[0] * b[1] - a[1] * b[0]];
const dot = (a: Vec3, b: Vec3) => a[0] * b[0] + a[1] * b[1] + a[2] * b[2];
const norm = (a: Vec3): Vec3 => {
  const l = Math.hypot(a[0], a[1], a[2]) || 1;
  return [a[0] / l, a[1] / l, a[2] / l];
};
const centroid = (pts: Vec3[]): Vec3 => {
  const c: Vec3 = [0, 0, 0];
  for (const p of pts) for (let i = 0; i < 3; i++) c[i] += p[i] / pts.length;
  return c;
};

/** Collects flat-shaded faces. Each face faces away from the centre of the solid it belongs to. */
export class MeshBuilder {
  readonly positions: number[] = [];
  readonly normals: number[] = [];
  readonly colors: number[] = [];
  readonly indices: number[] = [];

  /** A planar polygon (3+ points, in order around it), turned to face away from `inside`. */
  face(pts: Vec3[], color: string, inside: Vec3) {
    let n = norm(cross(sub(pts[1], pts[0]), sub(pts[2], pts[0])));
    if (dot(n, sub(centroid(pts), inside)) < 0) {
      pts = [...pts].reverse();
      n = [-n[0], -n[1], -n[2]];
    }
    const rgb = linear(color);
    const base = this.positions.length / 3;
    for (const p of pts) {
      this.positions.push(...p);
      this.normals.push(...n);
      this.colors.push(...rgb);
    }
    for (let i = 1; i < pts.length - 1; i++) this.indices.push(base, base + i, base + i + 1);
  }

  /**
   * A six-sided solid from its bottom and top quads, each given as
   * rear-left, rear-right, front-right, front-left. `colors` overrides
   * individual faces (top, bottom, front, rear, left, right).
   */
  hexa(bottom: Vec3[], top: Vec3[], color: string, colors: Partial<Record<'top' | 'bottom' | 'front' | 'rear' | 'left' | 'right', string>> = {}) {
    const inside = centroid([...bottom, ...top]);
    const [b0, b1, b2, b3] = bottom;
    const [t0, t1, t2, t3] = top;
    this.face([t0, t1, t2, t3], colors.top ?? color, inside);
    this.face([b0, b1, b2, b3], colors.bottom ?? color, inside);
    this.face([b3, b2, t2, t3], colors.front ?? color, inside);
    this.face([b0, b1, t1, t0], colors.rear ?? color, inside);
    this.face([b0, b3, t3, t0], colors.left ?? color, inside);
    this.face([b1, b2, t2, t1], colors.right ?? color, inside);
  }

  /** Axis-aligned box from its centre and full size (x across, y up, z along). */
  box(c: Vec3, size: Vec3, color: string, colors?: Parameters<MeshBuilder['hexa']>[3]) {
    const [hx, hy, hz] = [size[0] / 2, size[1] / 2, size[2] / 2];
    const quad = (y: number): Vec3[] => [
      [c[0] + hx, y, c[2] - hz],
      [c[0] - hx, y, c[2] - hz],
      [c[0] - hx, y, c[2] + hz],
      [c[0] + hx, y, c[2] + hz],
    ];
    this.hexa(quad(c[1] - hy), quad(c[1] + hy), color, colors);
  }

  /**
   * A tapered block: a footprint at `y0` and a smaller or shifted one at `y1`,
   * each given as half-width and rear/front z.
   */
  taper(y0: number, bottom: { hw: number; z0: number; z1: number }, y1: number, top: { hw: number; z0: number; z1: number }, color: string, colors?: Parameters<MeshBuilder['hexa']>[3]) {
    const quad = (y: number, q: { hw: number; z0: number; z1: number }): Vec3[] => [
      [q.hw, y, q.z0],
      [-q.hw, y, q.z0],
      [-q.hw, y, q.z1],
      [q.hw, y, q.z1],
    ];
    this.hexa(quad(y0, bottom), quad(y1, top), color, colors);
  }

  /** A wheel: a short cylinder across the vehicle (axis along x), with a hub. */
  wheel(x: number, z: number, r: number, w: number, tire = '#1c1f24', hub = '#9ca3af', segments = 12) {
    this.cylinder([x, r, z], r, w, tire, segments);
    this.cylinder([x, r, z], r * 0.55, w + 0.02, hub, segments);
  }

  cylinder(c: Vec3, r: number, w: number, color: string, segments: number) {
    const ring = (dx: number): Vec3[] =>
      Array.from({ length: segments }, (_, i) => {
        const a = (i / segments) * Math.PI * 2;
        return [c[0] + dx, c[1] + r * Math.sin(a), c[2] + r * Math.cos(a)] as Vec3;
      });
    const a = ring(-w / 2), b = ring(w / 2);
    this.face(a, color, c);
    this.face(b, color, c);
    for (let i = 0; i < segments; i++) {
      const j = (i + 1) % segments;
      this.face([a[i], a[j], b[j], b[i]], color, c);
    }
  }
}

/** Packs a mesh into a GLB file. */
export function toGlb(mesh: MeshBuilder): Uint8Array {
  const pos = new Float32Array(mesh.positions);
  const nrm = new Float32Array(mesh.normals);
  const col = new Float32Array(mesh.colors);
  const idx = new Uint16Array(mesh.indices);
  const pad4 = (n: number) => (n + 3) & ~3;

  const views = [pos, nrm, col, idx];
  const offsets: number[] = [];
  let binLength = 0;
  for (const v of views) {
    offsets.push(binLength);
    binLength = pad4(binLength + v.byteLength);
  }
  const bin = new Uint8Array(binLength);
  views.forEach((v, i) => bin.set(new Uint8Array(v.buffer, v.byteOffset, v.byteLength), offsets[i]));

  const min: Vec3 = [Infinity, Infinity, Infinity];
  const max: Vec3 = [-Infinity, -Infinity, -Infinity];
  for (let i = 0; i < pos.length; i += 3) {
    for (let k = 0; k < 3; k++) {
      min[k] = Math.min(min[k], pos[i + k]);
      max[k] = Math.max(max[k], pos[i + k]);
    }
  }
  const vertexCount = pos.length / 3;
  const json = {
    asset: { version: '2.0', generator: 'virtualplanner vehicle builder' },
    scene: 0,
    scenes: [{ nodes: [0] }],
    nodes: [{ mesh: 0 }],
    meshes: [{ primitives: [{ attributes: { POSITION: 0, NORMAL: 1, COLOR_0: 2 }, indices: 3, material: 0 }] }],
    materials: [{ pbrMetallicRoughness: { baseColorFactor: [1, 1, 1, 1], metallicFactor: 0.15, roughnessFactor: 0.55 } }],
    buffers: [{ byteLength: binLength }],
    bufferViews: [
      { buffer: 0, byteOffset: offsets[0], byteLength: pos.byteLength, target: 34962 },
      { buffer: 0, byteOffset: offsets[1], byteLength: nrm.byteLength, target: 34962 },
      { buffer: 0, byteOffset: offsets[2], byteLength: col.byteLength, target: 34962 },
      { buffer: 0, byteOffset: offsets[3], byteLength: idx.byteLength, target: 34963 },
    ],
    accessors: [
      { bufferView: 0, componentType: 5126, count: vertexCount, type: 'VEC3', min, max },
      { bufferView: 1, componentType: 5126, count: vertexCount, type: 'VEC3' },
      { bufferView: 2, componentType: 5126, count: vertexCount, type: 'VEC3' },
      { bufferView: 3, componentType: 5123, count: idx.length, type: 'SCALAR' },
    ],
  };

  let jsonBytes = new TextEncoder().encode(JSON.stringify(json));
  const jsonLength = pad4(jsonBytes.length);
  if (jsonLength !== jsonBytes.length) {
    const padded = new Uint8Array(jsonLength).fill(0x20);
    padded.set(jsonBytes);
    jsonBytes = padded;
  }
  const total = 12 + 8 + jsonLength + 8 + binLength;
  const out = new Uint8Array(total);
  const dv = new DataView(out.buffer);
  dv.setUint32(0, 0x46546c67, true); // 'glTF'
  dv.setUint32(4, 2, true);
  dv.setUint32(8, total, true);
  dv.setUint32(12, jsonLength, true);
  dv.setUint32(16, 0x4e4f534a, true); // 'JSON'
  out.set(jsonBytes, 20);
  dv.setUint32(20 + jsonLength, binLength, true);
  dv.setUint32(24 + jsonLength, 0x004e4942, true); // 'BIN\0'
  out.set(bin, 28 + jsonLength);
  return out;
}

// ─── Vehicles ────────────────────────────────────────────────────────────────

const GLASS = '#1e293b';
const TRIM = '#272a30';
const HEADLIGHT = '#fef9c3';
const TAILLIGHT = '#dc2626';
const INDICATOR = '#f59e0b';

function lights(m: MeshBuilder, frontZ: number, rearZ: number, y: number, hw: number) {
  m.box([hw, y, frontZ], [0.32, 0.12, 0.05], HEADLIGHT);
  m.box([-hw, y, frontZ], [0.32, 0.12, 0.05], HEADLIGHT);
  m.box([hw, y, rearZ], [0.3, 0.12, 0.05], TAILLIGHT);
  m.box([-hw, y, rearZ], [0.3, 0.12, 0.05], TAILLIGHT);
}

/** Hatchback, sedan or SUV. */
function car(paint: string, shape: 'hatch' | 'sedan' | 'suv'): MeshBuilder {
  const m = new MeshBuilder();
  const L = shape === 'hatch' ? 3.8 : shape === 'sedan' ? 4.4 : 4.5;
  const hw = shape === 'suv' ? 0.92 : 0.84;
  const half = L / 2;
  const sill = shape === 'suv' ? 0.36 : 0.28;
  const belt = shape === 'suv' ? 1.05 : 0.82;
  const roof = shape === 'suv' ? 1.78 : shape === 'hatch' ? 1.5 : 1.44;
  const r = shape === 'suv' ? 0.36 : 0.31;

  // Lower body, hood a little lower than the boot line
  m.taper(sill, { hw, z0: -half, z1: half }, belt, { hw: hw - 0.03, z0: -half + 0.08, z1: half - 0.12 }, paint);
  // Cabin: glass sides with a painted roof
  const cab = shape === 'hatch'
    ? { b: { z0: -half + 0.2, z1: 0.55 }, t: { z0: -half + 0.35, z1: -0.25 } }
    : shape === 'sedan'
      ? { b: { z0: -1.15, z1: 0.75 }, t: { z0: -0.85, z1: 0.2 } }
      : { b: { z0: -half + 0.15, z1: 0.75 }, t: { z0: -half + 0.2, z1: 0.05 } };
  const roofBase = roof - 0.07;
  m.taper(belt, { hw: hw - 0.04, ...cab.b }, roofBase, { hw: hw - 0.16, ...cab.t }, GLASS);
  m.taper(roofBase, { hw: hw - 0.15, z0: cab.t.z0 - 0.02, z1: cab.t.z1 + 0.02 }, roof, { hw: hw - 0.2, z0: cab.t.z0 + 0.05, z1: cab.t.z1 - 0.05 }, paint);
  // Pillars between the windows
  const pillarZ = (cab.b.z0 + cab.b.z1) / 2 - 0.1;
  for (const s of [1, -1]) m.box([s * (hw - 0.09), (belt + roofBase) / 2, pillarZ], [0.06, roofBase - belt, 0.12], paint);
  // Bumpers, grille, lights
  m.box([0, sill + 0.12, half + 0.02], [hw * 2 - 0.1, 0.22, 0.12], TRIM);
  m.box([0, sill + 0.12, -half - 0.02], [hw * 2 - 0.1, 0.22, 0.12], TRIM);
  m.box([0, belt - 0.2, half + 0.01], [0.7, 0.14, 0.04], TRIM);
  lights(m, half + 0.01, -half - 0.01, belt - 0.16, hw - 0.22);
  if (shape === 'suv') {
    for (const s of [1, -1]) m.box([s * (hw - 0.25), roof + 0.04, cab.t.z0 + 0.6], [0.05, 0.06, 1.4], TRIM);
  }
  // Wheels, set slightly into the body
  const wz = half - (shape === 'hatch' ? 0.65 : 0.8);
  for (const x of [hw - 0.1, -(hw - 0.1)]) for (const z of [wz, -wz]) m.wheel(x, z, r, 0.22);
  return m;
}

/** Three-wheeled auto-rickshaw: narrow nose, open sides, canvas canopy. */
function autoRickshaw(lower: string, canopy: string): MeshBuilder {
  const m = new MeshBuilder();
  // Tub: narrow at the nose, full width at the back
  m.taper(0.3, { hw: 0.66, z0: -1.25, z1: 0.9 }, 0.85, { hw: 0.66, z0: -1.25, z1: 0.75 }, lower);
  m.taper(0.3, { hw: 0.32, z0: 0.9, z1: 1.4 }, 0.95, { hw: 0.3, z0: 0.75, z1: 1.25 }, lower);
  // Windscreen and dash
  m.taper(0.95, { hw: 0.38, z0: 0.9, z1: 1.2 }, 1.58, { hw: 0.42, z0: 0.62, z1: 0.75 }, GLASS);
  // Canopy roof and back
  m.box([0, 1.66, -0.3], [1.38, 0.14, 2.0], canopy);
  m.box([0, 1.22, -1.24], [1.34, 0.76, 0.08], canopy);
  // Corner posts
  for (const x of [0.62, -0.62]) {
    m.box([x, 1.22, 0.55], [0.06, 0.76, 0.06], canopy);
    m.box([x, 1.22, -0.6], [0.06, 0.76, 0.06], canopy);
  }
  // Seat back inside, and driver
  m.box([0, 1.05, -0.95], [1.1, 0.45, 0.2], '#3f3f46');
  m.box([0, 1.12, 0.25], [0.36, 0.48, 0.26], '#e2e8f0');
  m.box([0, 1.46, 0.25], [0.22, 0.22, 0.22], '#8d5524');
  m.box([0, 0.55, 1.42], [0.26, 0.12, 0.05], HEADLIGHT);
  for (const x of [0.5, -0.5]) m.box([x, 0.55, -1.27], [0.22, 0.1, 0.05], TAILLIGHT);
  m.wheel(0, 1.05, 0.24, 0.14);
  for (const x of [0.6, -0.6]) m.wheel(x, -0.8, 0.24, 0.16);
  return m;
}

/** City bus: tall box with a window band all round. */
function bus(body: string, stripe: string): MeshBuilder {
  const m = new MeshBuilder();
  const half = 4.25, hw = 1.25;
  m.box([0, 1.0, 0], [hw * 2, 1.1, half * 2], body);
  m.box([0, 0.62, 0], [hw * 2 + 0.02, 0.22, half * 2 + 0.02], stripe);
  // Window band, slightly proud of the body
  m.box([0, 2.0, -0.1], [hw * 2 + 0.03, 0.9, half * 2 - 0.4], GLASS);
  m.box([0, 2.0, half - 0.01], [hw * 2 - 0.15, 1.0, 0.06], GLASS);
  // Pillars between windows
  for (let z = -3.4; z <= 3.4; z += 1.35) m.box([0, 2.0, z], [hw * 2 + 0.05, 0.9, 0.12], body);
  m.box([0, 2.72, 0], [hw * 2, 0.55, half * 2], body);
  m.box([0, 3.02, 0], [hw * 2 - 0.3, 0.06, half * 2 - 0.6], '#cbd5e1');
  // Destination board, bumpers, lights
  m.box([0, 2.7, half + 0.01], [1.6, 0.26, 0.04], INDICATOR);
  m.box([0, 0.5, half + 0.05], [hw * 2, 0.25, 0.12], TRIM);
  m.box([0, 0.5, -half - 0.05], [hw * 2, 0.25, 0.12], TRIM);
  lights(m, half + 0.04, -half - 0.04, 0.8, hw - 0.3);
  for (const x of [hw - 0.15, -(hw - 0.15)]) {
    m.wheel(x, half - 1.6, 0.5, 0.32);
    m.wheel(x, -half + 1.9, 0.5, 0.32);
  }
  return m;
}

/** Scooter or motorcycle with its rider. */
function twoWheeler(paint: string, shirt: string, helmet: string, style: 'scooter' | 'bike'): MeshBuilder {
  const m = new MeshBuilder();
  const r = style === 'scooter' ? 0.24 : 0.3;
  m.wheel(0, 0.68, r, 0.1, '#1c1f24', '#6b7280', 10);
  m.wheel(0, -0.66, r, 0.12, '#1c1f24', '#6b7280', 10);
  if (style === 'scooter') {
    m.box([0, 0.36, -0.05], [0.34, 0.1, 0.8], TRIM); // floorboard
    m.taper(0.32, { hw: 0.2, z0: -0.85, z1: -0.15 }, 0.78, { hw: 0.17, z0: -0.75, z1: -0.3 }, paint); // rear body
    m.taper(0.3, { hw: 0.17, z0: 0.35, z1: 0.6 }, 1.0, { hw: 0.15, z0: 0.42, z1: 0.55 }, paint); // apron
  } else {
    m.box([0, 0.55, 0], [0.22, 0.3, 1.0], '#3f3f46'); // engine and frame
    m.taper(0.7, { hw: 0.17, z0: 0.0, z1: 0.5 }, 0.92, { hw: 0.13, z0: 0.05, z1: 0.42 }, paint); // tank
    m.box([0, 0.82, -0.45], [0.26, 0.1, 0.6], '#18181b'); // seat
    m.box([0, 0.75, 0.68], [0.08, 0.6, 0.08], '#71717a'); // forks
  }
  m.box([0, 1.03, 0.5], [0.66, 0.05, 0.05], TRIM); // handlebar
  m.box([0, 0.92, 0.62], [0.16, 0.12, 0.05], HEADLIGHT);
  m.box([0, 0.7, -0.88], [0.14, 0.08, 0.04], TAILLIGHT);
  // Rider: legs forward to the footrest, torso leaning slightly in, arms to the bar
  const seat = style === 'scooter' ? 0.8 : 0.88;
  for (const x of [0.12, -0.12]) {
    m.box([x, seat + 0.06, -0.25], [0.13, 0.13, 0.42], '#1e3a5f');
    m.box([x, (seat + 0.4) / 2, 0.02], [0.12, seat - 0.38, 0.13], '#1e3a5f');
  }
  m.taper(seat + 0.08, { hw: 0.2, z0: -0.5, z1: -0.25 }, seat + 0.62, { hw: 0.19, z0: -0.4, z1: -0.15 }, shirt);
  for (const x of [0.24, -0.24]) m.box([x, seat + 0.38, 0.12], [0.08, 0.08, 0.6], shirt);
  m.box([0, seat + 0.78, -0.28], [0.28, 0.3, 0.3], helmet);
  m.box([0, seat + 0.76, -0.12], [0.22, 0.1, 0.04], GLASS);
  return m;
}

/**
 * A traffic signal on its pole. Model +Z is the approach's direction of
 * travel, so the lamps face -Z, towards the oncoming vehicles. The lamp for
 * `lit` is bright, the others dark.
 */
export function trafficLight(lit: 'red' | 'amber' | 'green'): MeshBuilder {
  const m = new MeshBuilder();
  m.box([0, 0.05, 0], [0.4, 0.1, 0.4], '#52525b');
  m.box([0, 2.3, 0], [0.14, 4.6, 0.14], '#71717a');
  m.box([0, 4.15, -0.05], [0.42, 1.25, 0.32], '#18181b');
  m.box([0, 4.15, 0.13], [0.5, 1.35, 0.04], '#27272a'); // back plate
  const lamps = { red: [4.55, '#ff2d2d', '#4a1515'], amber: [4.15, '#ffb020', '#4a3510'], green: [3.75, '#2dff6a', '#123d20'] } as const;
  for (const [state, [y, on, off]] of Object.entries(lamps)) {
    m.box([0, y, -0.22], [0.26, 0.26, 0.04], state === lit ? on : off);
    m.box([0, y + 0.17, -0.27], [0.32, 0.04, 0.12], '#18181b'); // visor
  }
  return m;
}

const signalUrls = new Map<string, string>();

/** A URL for the signal model with one lamp lit (built once per page). */
export function trafficLightUrl(lit: 'red' | 'amber' | 'green'): string {
  let url = signalUrls.get(lit);
  if (!url) {
    url = URL.createObjectURL(new Blob([toGlb(trafficLight(lit)) as BlobPart], { type: 'model/gltf-binary' }));
    signalUrls.set(lit, url);
  }
  return url;
}

export interface VehicleVariant {
  id: string;
  kind: VehicleKind;
  /** Relative frequency within its kind. */
  weight: number;
  build: () => MeshBuilder;
}

/** Colours seen on Pune streets: mostly white and silver cars, black-and-yellow autos, red PMPML buses. */
export const VEHICLE_VARIANTS: readonly VehicleVariant[] = [
  { id: 'hatch-white', kind: 'car', weight: 5, build: () => car('#f1f5f9', 'hatch') },
  { id: 'hatch-silver', kind: 'car', weight: 4, build: () => car('#a8b0ba', 'hatch') },
  { id: 'hatch-red', kind: 'car', weight: 2, build: () => car('#b91c1c', 'hatch') },
  { id: 'hatch-blue', kind: 'car', weight: 1.5, build: () => car('#1d4ed8', 'hatch') },
  { id: 'sedan-white', kind: 'car', weight: 3, build: () => car('#e5e7eb', 'sedan') },
  { id: 'sedan-grey', kind: 'car', weight: 2, build: () => car('#4b5563', 'sedan') },
  { id: 'sedan-maroon', kind: 'car', weight: 1, build: () => car('#7f1d1d', 'sedan') },
  { id: 'suv-white', kind: 'car', weight: 2.5, build: () => car('#f8fafc', 'suv') },
  { id: 'suv-black', kind: 'car', weight: 1.5, build: () => car('#111827', 'suv') },
  { id: 'suv-brown', kind: 'car', weight: 1, build: () => car('#78350f', 'suv') },
  { id: 'auto-black', kind: 'bus_auto', weight: 4, build: () => autoRickshaw('#18181b', '#facc15') },
  { id: 'auto-green', kind: 'bus_auto', weight: 2, build: () => autoRickshaw('#15803d', '#facc15') },
  { id: 'bus-red', kind: 'bus_auto', weight: 2, build: () => bus('#b91c1c', '#fbbf24') },
  { id: 'bus-blue', kind: 'bus_auto', weight: 1, build: () => bus('#1e40af', '#e2e8f0') },
  { id: 'scooter-white', kind: 'two_wheeler', weight: 3, build: () => twoWheeler('#f1f5f9', '#0ea5e9', '#f8fafc', 'scooter') },
  { id: 'scooter-red', kind: 'two_wheeler', weight: 2, build: () => twoWheeler('#dc2626', '#f8fafc', '#18181b', 'scooter') },
  { id: 'scooter-grey', kind: 'two_wheeler', weight: 2, build: () => twoWheeler('#6b7280', '#a21caf', '#dc2626', 'scooter') },
  { id: 'bike-black', kind: 'two_wheeler', weight: 3, build: () => twoWheeler('#18181b', '#15803d', '#1d4ed8', 'bike') },
  { id: 'bike-red', kind: 'two_wheeler', weight: 2, build: () => twoWheeler('#b91c1c', '#334155', '#18181b', 'bike') },
  { id: 'bike-blue', kind: 'two_wheeler', weight: 1.5, build: () => twoWheeler('#1d4ed8', '#f59e0b', '#f8fafc', 'bike') },
];

const byKind = new Map<VehicleKind, { variants: VehicleVariant[]; total: number }>();
for (const v of VEHICLE_VARIANTS) {
  const entry = byKind.get(v.kind) ?? { variants: [], total: 0 };
  entry.variants.push(v);
  entry.total += v.weight;
  byKind.set(v.kind, entry);
}

/** The look of a vehicle: the same vehicle always gets the same one. */
export function variantFor(kind: VehicleKind, vehicleId: number): VehicleVariant {
  const { variants, total } = byKind.get(kind)!;
  // Integer hash so neighbouring ids look unrelated
  let h = Math.imul(vehicleId ^ 0x9e3779b9, 0x85ebca6b);
  h = Math.imul(h ^ (h >>> 13), 0xc2b2ae35);
  let r = (((h ^ (h >>> 16)) >>> 0) / 4294967296) * total;
  for (const v of variants) {
    if ((r -= v.weight) <= 0) return v;
  }
  return variants[variants.length - 1];
}

const urls = new Map<string, string>();

/** A URL for the variant's GLB (built once per page); every model of a variant shares it, and Cesium's cache with it. */
export function vehicleModelUrl(variant: VehicleVariant): string {
  let url = urls.get(variant.id);
  if (!url) {
    url = URL.createObjectURL(new Blob([toGlb(variant.build()) as BlobPart], { type: 'model/gltf-binary' }));
    urls.set(variant.id, url);
  }
  return url;
}

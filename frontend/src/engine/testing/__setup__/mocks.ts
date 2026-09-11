/**
 * src/engine/testing/__setup__/mocks.ts
 * ══════════════════════════════════════
 * Global mocks applied before every test.
 *
 * Cesium is a native-browser 3D engine; it cannot run inside jsdom.
 * Rather than trying to polyfill WebGL, we replace the entire 'cesium'
 * module with a lightweight stub so any engine code that imports from it
 * gets something that doesn't crash.
 *
 * Keep this minimal — only stub what's needed to prevent import errors.
 * Individual tests can override specific stubs using vi.mock() locally.
 */

import { vi } from 'vitest';

// ──────────────────────────────────────────────────────────────────────────────
// Cesium module stub
// All named exports needed by the engine are mocked as vi.fn() or
// sensible no-op implementations.
// ──────────────────────────────────────────────────────────────────────────────

vi.mock('cesium', () => ({
  Viewer: vi.fn().mockImplementation(() => ({
    scene: { globe: {}, primitives: { add: vi.fn(), remove: vi.fn() } },
    camera: { positionCartographic: {}, flyTo: vi.fn() },
    entities: { add: vi.fn(), remove: vi.fn(), removeById: vi.fn() },
    imageryLayers: { addImageryProvider: vi.fn(), remove: vi.fn() },
    destroy: vi.fn(),
  })),
  Entity: vi.fn(),
  Cartesian3: {
    fromDegrees: vi.fn((lng: number, lat: number, alt = 0) => ({ x: lng, y: lat, z: alt })),
    fromDegreesArray: vi.fn(() => []),
    fromDegreesArrayHeights: vi.fn(() => []),
    ZERO: { x: 0, y: 0, z: 0 },
    dot: vi.fn(() => 0),
    cross: vi.fn(() => ({ x: 0, y: 0, z: 0 })),
    distance: vi.fn(() => 0),
    magnitude: vi.fn(() => 0),
    normalize: vi.fn(() => ({ x: 0, y: 0, z: 1 })),
    add: vi.fn(() => ({ x: 0, y: 0, z: 0 })),
    subtract: vi.fn(() => ({ x: 0, y: 0, z: 0 })),
    multiplyByScalar: vi.fn(() => ({ x: 0, y: 0, z: 0 })),
    clone: vi.fn(() => ({ x: 0, y: 0, z: 0 })),
    pack: vi.fn(),
  },
  Cartesian2: vi.fn(),
  Cartographic: {
    fromDegrees: vi.fn((lng: number, lat: number) => ({ longitude: lng, latitude: lat, height: 0 })),
    fromCartesian: vi.fn(() => ({ longitude: 0, latitude: 0, height: 0 })),
    toDegrees: vi.fn((c: any) => c),
  },
  Color: {
    fromCssColorString: vi.fn(() => ({})),
    fromBytes: vi.fn(() => ({})),
    WHITE: {},
    RED: {},
    BLUE: {},
    GREEN: {},
    YELLOW: {},
    ORANGE: {},
    TRANSPARENT: {},
    fromAlpha: vi.fn(() => ({})),
    clone: vi.fn(),
  },
  Math: {
    toRadians: (deg: number) => (deg * Math.PI) / 180,
    toDegrees: (rad: number) => (rad * 180) / Math.PI,
    PI_OVER_TWO: Math.PI / 2,
    TWO_PI: Math.PI * 2,
    EPSILON6: 1e-6,
    EPSILON7: 1e-7,
  },
  ScreenSpaceEventHandler: vi.fn().mockImplementation(() => ({
    setInputAction: vi.fn(),
    removeInputAction: vi.fn(),
    destroy: vi.fn(),
  })),
  ScreenSpaceEventType: {
    LEFT_CLICK: 'LEFT_CLICK',
    LEFT_DOUBLE_CLICK: 'LEFT_DOUBLE_CLICK',
    MOUSE_MOVE: 'MOUSE_MOVE',
    RIGHT_CLICK: 'RIGHT_CLICK',
  },
  PolygonHierarchy: vi.fn(),
  GeometryInstance: vi.fn(),
  PolygonGeometry: { createGeometry: vi.fn() },
  PolylineGeometry: { createGeometry: vi.fn() },
  GroundPrimitive: vi.fn(),
  Primitive: vi.fn(),
  PerInstanceColorAppearance: vi.fn(),
  PolylineMaterialAppearance: vi.fn(),
  ColorGeometryInstanceAttribute: { fromColor: vi.fn() },
  GeometryAttribute: vi.fn(),
  ComponentDatatype: { FLOAT: 5126, DOUBLE: 5130 },
  PrimitiveType: { TRIANGLES: 4, LINES: 1 },
  BoundingSphere: { fromVertices: vi.fn(() => ({ center: {}, radius: 0 })) },
  ClassificationType: { BOTH: 2, CESIUM_3D_TILE: 0, TERRAIN: 1 },
  LabelStyle: { FILL: 0, OUTLINE: 1, FILL_AND_OUTLINE: 2 },
  HorizontalOrigin: { LEFT: -1, CENTER: 0, RIGHT: 1 },
  VerticalOrigin: { TOP: -1, CENTER: 0, BOTTOM: 1 },
  HeightReference: { NONE: 0, CLAMP_TO_GROUND: 1, RELATIVE_TO_GROUND: 2 },
  PolylineDashMaterialProperty: vi.fn(),
  Billboard: vi.fn(),
  BillboardCollection: vi.fn().mockImplementation(() => ({
    add: vi.fn(),
    remove: vi.fn(),
    destroy: vi.fn(),
    length: 0,
  })),
  PointPrimitive: vi.fn(),
  PointPrimitiveCollection: vi.fn().mockImplementation(() => ({
    add: vi.fn(),
    remove: vi.fn(),
    destroy: vi.fn(),
    length: 0,
  })),
  defined: (val: unknown) => val !== undefined && val !== null,
  destroyObject: vi.fn(),
}));

// ──────────────────────────────────────────────────────────────────────────────
// fetch mock (tests must either stub it via vi.stubGlobal or use MSW)
// Default: always resolves to 404 so tests that forget to mock don't hit network
// ──────────────────────────────────────────────────────────────────────────────

globalThis.fetch = vi.fn().mockResolvedValue({
  ok: false,
  status: 404,
  statusText: 'Not Found',
  json: () => Promise.resolve({}),
  text: () => Promise.resolve(''),
  headers: { get: () => null },
}) as unknown as typeof fetch;

// ──────────────────────────────────────────────────────────────────────────────
// import.meta.env stub
// Vitest provides this automatically, but we add our app-specific keys.
// ──────────────────────────────────────────────────────────────────────────────

Object.assign(import.meta.env, {
  VITE_API_BASE: 'http://localhost:8000',
  MODE: 'test',
  DEV: false,
  PROD: false,
  SSR: false,
});

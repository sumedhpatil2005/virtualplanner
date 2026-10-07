/**
 * Cesium stub rich enough to drive RenderManager and its tile renderers in
 * jsdom. Use with: vi.mock('cesium', async () => (await import('./__setup__/cesiumRenderMock')).cesiumRenderMock())
 */
export function cesiumRenderMock() {
  const listeners = () => ({ addEventListener: () => {}, removeEventListener: () => {} });
  const color = (alpha = 1): any => ({ alpha, withAlpha: (a: number) => color(a) });

  class Primitive {
    show = true;
    appearance: any;
    geometryInstances: any[];
    constructor(opts: any = {}) {
      this.appearance = opts.appearance;
      this.geometryInstances = opts.geometryInstances ?? [];
    }
    getGeometryInstanceAttributes(id: string) {
      return this.geometryInstances.some(g => g.id === id) ? { color: undefined } : undefined;
    }
    destroy() {}
  }

  return {
    Viewer: class {
      scene = {
        primitives: { add: (p: any) => p, remove: () => true, length: 0 },
        postRender: listeners(),
      };
      camera = { changed: listeners(), positionCartographic: { height: 800 } };
      entities = { add: (e: any) => e, remove: () => true };
    },
    Primitive,
    GroundPrimitive: Primitive,
    Geometry: class { constructor(opts: any) { Object.assign(this, opts); } },
    GeometryAttribute: class { constructor(opts: any) { Object.assign(this, opts); } },
    GeometryAttributes: class { constructor(opts: any) { Object.assign(this, opts); } },
    GeometryPipeline: { computeNormal: (g: any) => g },
    ComponentDatatype: { DOUBLE: 'DOUBLE', FLOAT: 'FLOAT' },
    PrimitiveType: { TRIANGLES: 'TRIANGLES' },
    BoundingSphere: class { static fromVertices() { return {}; } },
    Cartesian3: class { x: number; y: number; z: number; constructor(x = 0, y = 0, z = 0) { this.x = x; this.y = y; this.z = z; } },
    GeometryInstance: class { constructor(opts: any) { Object.assign(this, opts); } },
    ColorGeometryInstanceAttribute: { fromColor: () => ({}), toValue: () => new Uint8Array(4) },
    Color: { fromCssColorString: () => color(1), WHITE: color(1), CYAN: color(1) },
    PerInstanceColorAppearance: class { constructor(opts: any = {}) { Object.assign(this, opts); } },
    Math: { toDegrees: (v: number) => v * (180 / Math.PI), toRadians: (v: number) => v * (Math.PI / 180) },
  };
}

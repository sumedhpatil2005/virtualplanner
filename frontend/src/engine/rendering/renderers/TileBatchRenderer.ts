import {
  Viewer,
  Primitive,
  GeometryInstance,
  ColorGeometryInstanceAttribute,
  PerInstanceColorAppearance
} from 'cesium';
import { CesiumAdapter } from '../adapters/CesiumAdapter';
import type { MeshData } from '../types';
import type { SubRenderer } from './SubRenderer';
import { MeshCache } from '../cache/MeshCache';
import { SpatialHashGrid } from '../spatial/SpatialHashGrid';
import { withOpacity } from './opacity';

const SELECTION_COLOR = '#00ffff';

/**
 * Shared spatial batching for road, building and transit geometry.
 *
 * Objects are grouped into one Cesium Primitive per (tile, render layer). Each
 * subclass maps meshes to render layers and says at which camera heights a
 * layer is visible.
 *
 * Only layers visible at the current height are built (item 32). Zooming across
 * a threshold builds the missing layers for loaded tiles once; layers already
 * built stay on the GPU and are just shown/hidden, so hovering around a
 * threshold does not rebuild repeatedly.
 */
export abstract class TileBatchRenderer implements SubRenderer {
  protected viewer: Viewer;
  protected meshCache: MeshCache;
  protected spatialGrid: SpatialHashGrid;
  private getOpacity: (objId: string) => number;

  private objectTiles = new Map<string, string[]>();
  /** tileKey -> render layer -> primitive. */
  protected tilePrimitives = new Map<string, Map<string, Primitive>>();
  /** Layers that exist in a tile's meshes but were not built (hidden at the height they were built for). */
  private tileSkippedLayers = new Map<string, Set<string>>();
  private dirtyTiles = new Set<string>();
  /** Tiles whose rebuild must keep already-built layers (LOD expansion rather than content change). */
  private keepBuiltLayers = new Set<string>();
  private selections = new Set<string>();

  private rebuildTimeout: ReturnType<typeof setTimeout> | null = null;
  protected currentHeight = 800;

  constructor(viewer: Viewer, meshCache: MeshCache, spatialGrid: SpatialHashGrid, getOpacity: (objId: string) => number = () => 1) {
    this.viewer = viewer;
    this.meshCache = meshCache;
    this.spatialGrid = spatialGrid;
    this.getOpacity = getOpacity;
    if (viewer?.camera?.positionCartographic) {
      this.currentHeight = viewer.camera.positionCartographic.height;
    }
  }

  /** Render layer for a mesh (e.g. 'asphalt', 'close'). Return null to skip the mesh. */
  protected abstract layerOf(mesh: MeshData, index: number, meshes: MeshData[]): string | null;
  /** Whether a render layer should be visible at a camera height. */
  protected abstract isLayerVisible(layer: string, height: number): boolean;
  /** Layer whose instance colour is changed by setColor (traffic tinting). */
  protected colorLayer(): string | null {
    return null;
  }
  protected isAlwaysTranslucent(_layer: string): boolean {
    return false;
  }
  protected onRebuilt(_ms: number): void {}

  // ── SubRenderer ────────────────────────────────────────────────────────────

  public render(objId: string): void {
    const tileKeys = this.spatialGrid.getTileKeysForObject(objId);
    this.objectTiles.get(objId)?.forEach(key => {
      if (!tileKeys.includes(key)) this.dirtyTiles.add(key);
    });
    tileKeys.forEach(key => this.dirtyTiles.add(key));
    this.objectTiles.set(objId, tileKeys);
    this.scheduleRebuild();
  }

  public remove(objId: string): void {
    const tileKeys = this.objectTiles.get(objId);
    this.objectTiles.delete(objId);
    this.selections.delete(objId);
    if (tileKeys) {
      tileKeys.forEach(key => this.dirtyTiles.add(key));
      this.scheduleRebuild();
    }
  }

  public setSelection(objId: string, isSelected: boolean): void {
    if (isSelected) this.selections.add(objId);
    else this.selections.delete(objId);
    const tileKeys = this.objectTiles.get(objId);
    if (tileKeys) {
      tileKeys.forEach(key => this.dirtyTiles.add(key));
      this.scheduleRebuild();
    }
  }

  public clear(): void {
    if (this.rebuildTimeout) {
      clearTimeout(this.rebuildTimeout);
      this.rebuildTimeout = null;
    }
    this.tilePrimitives.forEach(layers => layers.forEach(prim => this.viewer.scene.primitives.remove(prim)));
    this.tilePrimitives.clear();
    this.tileSkippedLayers.clear();
    this.objectTiles.clear();
    this.dirtyTiles.clear();
    this.keepBuiltLayers.clear();
    this.selections.clear();
  }

  public unloadTile(tileKey: string): void {
    this.tilePrimitives.get(tileKey)?.forEach(prim => this.viewer.scene.primitives.remove(prim));
    this.tilePrimitives.delete(tileKey);
    this.tileSkippedLayers.delete(tileKey);
  }

  // ── Extras used by RenderManager / LODController ───────────────────────────

  public hasObject(objId: string): boolean {
    return this.objectTiles.has(objId);
  }

  /** Rebuilds every loaded tile, e.g. after a layer opacity change. */
  public refreshAll(): void {
    this.tilePrimitives.forEach((_, tileKey) => this.dirtyTiles.add(tileKey));
    this.scheduleRebuild();
  }

  public updateLOD(height: number): void {
    this.currentHeight = height;
    let needsBuild = false;
    this.tilePrimitives.forEach((layers, tileKey) => {
      layers.forEach((prim, layer) => {
        prim.show = this.isLayerVisible(layer, height);
      });
      const skipped = this.tileSkippedLayers.get(tileKey);
      if (skipped && [...skipped].some(layer => this.isLayerVisible(layer, height))) {
        this.dirtyTiles.add(tileKey);
        this.keepBuiltLayers.add(tileKey);
        needsBuild = true;
      }
    });
    if (needsBuild) this.scheduleRebuild();
  }

  /**
   * Tints one object's instances on the GPU without a rebuild. Looks only at the
   * tiles that object occupies (item 29) instead of every tile in the city.
   */
  public setColor(objId: string, colorHex: string): void {
    const layer = this.colorLayer();
    const tileKeys = this.objectTiles.get(objId);
    if (!layer || !tileKeys) return;
    const value = ColorGeometryInstanceAttribute.toValue(withOpacity(colorHex, this.getOpacity(objId)));
    for (const tileKey of tileKeys) {
      const prim = this.tilePrimitives.get(tileKey)?.get(layer);
      if (!prim) continue;
      try {
        const attributes = prim.getGeometryInstanceAttributes(objId);
        if (attributes) attributes.color = value;
      } catch {
        // Primitive not ready yet (first frame after a rebuild); the next tick retries
      }
    }
  }

  // ── Batching ───────────────────────────────────────────────────────────────

  private scheduleRebuild() {
    if (this.rebuildTimeout) return;
    this.rebuildTimeout = setTimeout(() => {
      this.rebuildTimeout = null;
      const start = performance.now();
      this.rebuildDirtyTiles();
      this.onRebuilt(performance.now() - start);
    }, 16);
  }

  private rebuildDirtyTiles() {
    const height = this.currentHeight;

    this.dirtyTiles.forEach(tileKey => {
      const keep = this.keepBuiltLayers.has(tileKey) ? new Set(this.tilePrimitives.get(tileKey)?.keys() ?? []) : null;
      this.unloadTile(tileKey);

      const objIds = this.spatialGrid.getObjectsInTiles([tileKey]).filter(id => this.objectTiles.has(id));
      if (objIds.length === 0) return;

      const instancesByLayer = new Map<string, GeometryInstance[]>();
      const translucentLayers = new Set<string>();
      const skipped = new Set<string>();

      for (const id of objIds) {
        const meshes = this.meshCache.get(id);
        if (!meshes || meshes.length === 0) continue;
        const isSelected = this.selections.has(id);
        const opacity = this.getOpacity(id);

        meshes.forEach((mesh, index) => {
          const layer = this.layerOf(mesh, index, meshes);
          if (!layer) return;
          if (!this.isLayerVisible(layer, height) && !keep?.has(layer)) {
            skipped.add(layer);
            return;
          }
          if (opacity < 1) translucentLayers.add(layer);
          let list = instancesByLayer.get(layer);
          if (!list) instancesByLayer.set(layer, (list = []));
          list.push(new GeometryInstance({
            geometry: CesiumAdapter.buildGeometry(mesh),
            attributes: {
              color: ColorGeometryInstanceAttribute.fromColor(withOpacity(isSelected ? SELECTION_COLOR : mesh.material.color, opacity))
            },
            id
          }));
        });
      }

      const layers = new Map<string, Primitive>();
      instancesByLayer.forEach((instances, layer) => {
        const prim = new Primitive({
          geometryInstances: instances,
          appearance: new PerInstanceColorAppearance({
            flat: true,
            translucent: translucentLayers.has(layer) || this.isAlwaysTranslucent(layer)
          }),
          asynchronous: false
        });
        prim.show = this.isLayerVisible(layer, height);
        this.viewer.scene.primitives.add(prim);
        layers.set(layer, prim);
      });

      this.tilePrimitives.set(tileKey, layers);
      if (skipped.size > 0) this.tileSkippedLayers.set(tileKey, skipped);
    });

    this.dirtyTiles.clear();
    this.keepBuiltLayers.clear();
  }
}

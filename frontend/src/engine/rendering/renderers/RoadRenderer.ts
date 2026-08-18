import { 
  Viewer, 
  Primitive, 
  GeometryInstance, 
  ColorGeometryInstanceAttribute, 
  Color, 
  PerInstanceColorAppearance 
} from 'cesium';
import { CesiumAdapter } from '../adapters/CesiumAdapter';
import type { MeshData } from '../types';
import type { SubRenderer } from './SubRenderer';
import { MeshCache } from '../cache/MeshCache';
import { SpatialHashGrid } from '../spatial/SpatialHashGrid';

export class RoadRenderer implements SubRenderer {
  private viewer: Viewer;
  private meshCache: MeshCache;
  private spatialGrid: SpatialHashGrid;

  // Tracking maps for spatial batching
  private roadToTileMap = new Map<string, string[]>();
  private tilePrimitives = new Map<string, Map<string, Primitive>>(); // tileKey -> Map<layerId, Primitive>
  private dirtyTiles = new Set<string>();
  private roadSelections = new Set<string>();

  private rebuildTimeout: any = null;
  private currentHeight: number = 800; // Camera height tracker

  constructor(viewer: Viewer, meshCache: MeshCache, spatialGrid: SpatialHashGrid) {
    this.viewer = viewer;
    this.meshCache = meshCache;
    this.spatialGrid = spatialGrid;

    if (viewer && viewer.camera && viewer.camera.positionCartographic) {
      this.currentHeight = viewer.camera.positionCartographic.height;
    }
  }

  /**
   * Called by RenderManager when a road object is registered or updated
   */
  public render(objId: string, _meshes: MeshData[]): void {
    const tileKeys = this.spatialGrid.getTileKeysForObject(objId);
    const oldTileKeys = this.roadToTileMap.get(objId);

    if (oldTileKeys) {
      oldTileKeys.forEach(key => {
        if (!tileKeys.includes(key)) {
          this.dirtyTiles.add(key);
        }
      });
    }

    tileKeys.forEach(key => {
      this.dirtyTiles.add(key);
    });

    this.roadToTileMap.set(objId, tileKeys);
    this.scheduleRebuild();
  }

  /**
   * Called by RenderManager when a road object is removed
   */
  public remove(objId: string): void {
    const tileKeys = this.roadToTileMap.get(objId);
    this.roadToTileMap.delete(objId);
    this.roadSelections.delete(objId);

    if (tileKeys) {
      tileKeys.forEach(key => {
        this.dirtyTiles.add(key);
      });
      this.scheduleRebuild();
    }
  }

  /**
   * Highlight selection state on road geometries
   */
  public setSelection(objId: string, isSelected: boolean): void {
    if (isSelected) {
      this.roadSelections.add(objId);
    } else {
      this.roadSelections.delete(objId);
    }
    const tileKeys = this.roadToTileMap.get(objId);
    if (tileKeys) {
      tileKeys.forEach(key => {
        this.dirtyTiles.add(key);
      });
      this.scheduleRebuild();
    }
  }

  /**
   * Clears all road primitives from the Cesium viewport
   */
  public clear(): void {
    if (this.rebuildTimeout) {
      clearTimeout(this.rebuildTimeout);
      this.rebuildTimeout = null;
    }
    this.tilePrimitives.forEach((layerMap) => {
      layerMap.forEach((prim) => {
        this.viewer.scene.primitives.remove(prim);
      });
    });
    this.tilePrimitives.clear();
    this.roadToTileMap.clear();
    this.dirtyTiles.clear();
    this.roadSelections.clear();
  }

  /**
   * Toggle visibility of tiles dynamically based on viewport frustum
   */
  public setVisibilityForObjects(objIds: string[], visible: boolean): void {
    const tilesToToggle = new Set<string>();
    for (const id of objIds) {
      const tileKeys = this.roadToTileMap.get(id);
      if (tileKeys) {
        tileKeys.forEach(key => tilesToToggle.add(key));
      }
    }

    tilesToToggle.forEach((tileKey) => {
      const layerMap = this.tilePrimitives.get(tileKey);
      if (layerMap) {
        layerMap.forEach((prim, layerId) => {
          this.applyLODToPrimitive(layerId, prim, visible);
        });
      }
    });
  }

  /**
   * Trigger LOD swaps at spatial batch level
   */
  public updateLOD(height: number): void {
    this.currentHeight = height;

    this.tilePrimitives.forEach((layerMap) => {
      layerMap.forEach((prim, layerId) => {
        this.applyLODToPrimitive(layerId, prim, true);
      });
    });
  }

  /**
   * Explicitly unloads primitives for a single tile key
   */
  public unloadTile(tileKey: string): void {
    const oldLayerMap = this.tilePrimitives.get(tileKey);
    if (oldLayerMap) {
      oldLayerMap.forEach((prim) => {
        this.viewer.scene.primitives.remove(prim);
      });
      this.tilePrimitives.delete(tileKey);
    }
  }

  /**
   * Dynamically updates the color of a specific road geometry instance on the GPU.
   * This allows overlaying traffic states without rebuilding the entire city geometry.
   */
  public setRoadColor(roadId: string, colorHex: string): void {
    this.tilePrimitives.forEach((layerMap) => {
      const asphaltPrim = layerMap.get('asphalt');
      if (asphaltPrim) {
        try {
          const attributes = asphaltPrim.getGeometryInstanceAttributes(roadId);
          if (attributes) {
            attributes.color = ColorGeometryInstanceAttribute.toValue(Color.fromCssColorString(colorHex));
          }
        } catch (e) {
          // Instance might not be present in this primitive
        }
      }
    });
  }

  private scheduleRebuild() {
    if (this.rebuildTimeout) return;
    this.rebuildTimeout = setTimeout(() => {
      const start = performance.now();
      this.rebuildDirtyTiles();
      const end = performance.now();
      (window as any).last_road_rebuild_time = end - start;
      this.rebuildTimeout = null;
    }, 16);
  }

  private rebuildDirtyTiles() {
    this.dirtyTiles.forEach((tileKey) => {
      // 1. Remove old tile primitives from the scene
      const oldLayerMap = this.tilePrimitives.get(tileKey);
      if (oldLayerMap) {
        oldLayerMap.forEach((prim) => {
          this.viewer.scene.primitives.remove(prim);
        });
        this.tilePrimitives.delete(tileKey);
      }

      // 2. Fetch all road IDs currently registered in this tile key
      const objIds = this.spatialGrid.getObjectsInTiles([tileKey]);
      const roadIds = objIds.filter(id => this.roadToTileMap.has(id));

      if (roadIds.length === 0) return;

      const instancesByLayer = new Map<string, GeometryInstance[]>();

      for (const id of roadIds) {
        const meshes = this.meshCache.get(id);
        if (!meshes) continue;

        const isSelected = this.roadSelections.has(id);

        for (const mesh of meshes) {
          const layerId = mesh.layerId || 'asphalt';
          
          if (!instancesByLayer.has(layerId)) {
            instancesByLayer.set(layerId, []);
          }

          const geom = CesiumAdapter.buildGeometry(mesh);
          // Highlight selected road instance as Cyan
          const colorStr = isSelected ? '#00ffff' : mesh.material.color;

          instancesByLayer.get(layerId)!.push(new GeometryInstance({
            geometry: geom,
            attributes: {
              color: ColorGeometryInstanceAttribute.fromColor(Color.fromCssColorString(colorStr))
            },
            id: id
          }));
        }
      }

      // 3. Compile primitives per active material layer
      const layerMap = new Map<string, Primitive>();

      instancesByLayer.forEach((instances, layerId) => {
        if (instances.length === 0) return;

        const prim = new Primitive({
          geometryInstances: instances,
          appearance: new PerInstanceColorAppearance({ flat: true, translucent: false }),
          asynchronous: false
        });
        
        this.viewer.scene.primitives.add(prim);
        layerMap.set(layerId, prim);
      });

      // Apply initial LOD visibility to the primitives
      layerMap.forEach((prim, layerId) => {
        this.applyLODToPrimitive(layerId, prim, true);
      });

      this.tilePrimitives.set(tileKey, layerMap);
    });

    this.dirtyTiles.clear();
  }

  private applyLODToPrimitive(layerId: string, prim: Primitive, visible: boolean) {
    if (!visible) {
      prim.show = false;
      return;
    }

    const height = this.currentHeight;
    const showSidewalks = height < 1500;
    const showCurbs = height < 400;
    const showMarkings = height < 1200;

    if (layerId === 'asphalt') {
      prim.show = true;
    } else if (layerId === 'marking') {
      prim.show = showMarkings;
    } else if (layerId === 'divider' || layerId === 'sidewalk') {
      prim.show = showSidewalks;
    } else if (layerId === 'curb') {
      prim.show = showCurbs;
    } else {
      prim.show = true;
    }
  }
}

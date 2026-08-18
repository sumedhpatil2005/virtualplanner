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

export class TransitRenderer implements SubRenderer {
  private viewer: Viewer;
  private meshCache: MeshCache;
  private spatialGrid: SpatialHashGrid;

  // Tracking maps for spatial batching
  private transitToTileMap = new Map<string, string[]>();
  private tilePrimitives = new Map<string, Map<string, Primitive>>(); // tileKey -> Map<layerId, Primitive>
  private dirtyTiles = new Set<string>();
  private transitSelections = new Set<string>();

  private rebuildTimeout: any = null;
  private currentHeight: number = 800; // Camera altitude tracker

  constructor(viewer: Viewer, meshCache: MeshCache, spatialGrid: SpatialHashGrid) {
    this.viewer = viewer;
    this.meshCache = meshCache;
    this.spatialGrid = spatialGrid;

    if (viewer && viewer.camera && viewer.camera.positionCartographic) {
      this.currentHeight = viewer.camera.positionCartographic.height;
    }
  }

  /**
   * Called by RenderManager when a transit object is registered or updated
   */
  public render(objId: string, _meshes: MeshData[]): void {
    const tileKeys = this.spatialGrid.getTileKeysForObject(objId);
    const oldTileKeys = this.transitToTileMap.get(objId);

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

    this.transitToTileMap.set(objId, tileKeys);
    this.scheduleRebuild();
  }

  /**
   * Called by RenderManager when a transit object is removed
   */
  public remove(objId: string): void {
    const tileKeys = this.transitToTileMap.get(objId);
    this.transitToTileMap.delete(objId);
    this.transitSelections.delete(objId);

    if (tileKeys) {
      tileKeys.forEach(key => {
        this.dirtyTiles.add(key);
      });
      this.scheduleRebuild();
    }
  }

  /**
   * Highlight selection state on transit geometries (Cyan)
   */
  public setSelection(objId: string, isSelected: boolean): void {
    if (isSelected) {
      this.transitSelections.add(objId);
    } else {
      this.transitSelections.delete(objId);
    }
    const tileKeys = this.transitToTileMap.get(objId);
    if (tileKeys) {
      tileKeys.forEach(key => {
        this.dirtyTiles.add(key);
      });
      this.scheduleRebuild();
    }
  }

  /**
   * Clears all transit primitives from the Cesium scene
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
    this.transitToTileMap.clear();
    this.dirtyTiles.clear();
    this.transitSelections.clear();
  }

  /**
   * Toggle visibility of tiles dynamically based on viewport frustum
   */
  public setVisibilityForObjects(objIds: string[], visible: boolean): void {
    const tilesToToggle = new Set<string>();
    for (const id of objIds) {
      const tileKeys = this.transitToTileMap.get(id);
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
   * Trigger LOD updates based on camera height
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
   * Dynamically updates the color of a specific transit deck geometry instance on the GPU.
   */
  public setTransitColor(transitId: string, colorHex: string): void {
    this.tilePrimitives.forEach((layerMap) => {
      const deckPrim = layerMap.get('transit_deck');
      if (deckPrim) {
        try {
          const attributes = deckPrim.getGeometryInstanceAttributes(transitId);
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
      this.rebuildDirtyTiles();
      this.rebuildTimeout = null;
    }, 16);
  }

  private rebuildDirtyTiles() {
    this.dirtyTiles.forEach((tileKey) => {
      // 1. Remove old tile primitives
      const oldLayerMap = this.tilePrimitives.get(tileKey);
      if (oldLayerMap) {
        oldLayerMap.forEach((prim) => {
          this.viewer.scene.primitives.remove(prim);
        });
        this.tilePrimitives.delete(tileKey);
      }

      // 2. Fetch all transit IDs currently registered in this tile key
      const objIds = this.spatialGrid.getObjectsInTiles([tileKey]);
      const transitIds = objIds.filter(id => this.transitToTileMap.has(id));

      if (transitIds.length === 0) return;

      const instancesByLayer = new Map<string, GeometryInstance[]>();

      for (const id of transitIds) {
        const meshes = this.meshCache.get(id);
        if (!meshes) continue;

        const isSelected = this.transitSelections.has(id);

        for (const mesh of meshes) {
          const layerId = mesh.layerId || 'transit_deck';
          
          if (!instancesByLayer.has(layerId)) {
            instancesByLayer.set(layerId, []);
          }

          const geom = CesiumAdapter.buildGeometry(mesh);
          // Highlight selected transit components as Cyan
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

      // 3. Compile primitives per active transit layer
      const layerMap = new Map<string, Primitive>();

      instancesByLayer.forEach((instances, layerId) => {
        if (instances.length === 0) return;

        const prim = new Primitive({
          geometryInstances: instances,
          appearance: new PerInstanceColorAppearance({ flat: true, translucent: layerId === 'transit_station' }),
          asynchronous: false
        });
        
        this.viewer.scene.primitives.add(prim);
        layerMap.set(layerId, prim);
      });

      // Apply initial visibility
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
    const showDetail = height < 1500;
    const showUtility = height < 800;

    if (layerId === 'transit_deck' || layerId === 'transit_station' || layerId === 'transit_pillars') {
      prim.show = true;
    } else if (
      layerId === 'transit_rails' || 
      layerId === 'transit_junction' || 
      layerId === 'transit_deck_details' || 
      layerId === 'transit_pillars_details'
    ) {
      prim.show = showDetail;
    } else if (layerId === 'transit_utility') {
      prim.show = showUtility;
    } else {
      prim.show = true;
    }
  }
}

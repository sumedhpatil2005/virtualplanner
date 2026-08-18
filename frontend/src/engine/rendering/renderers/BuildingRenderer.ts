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

export class BuildingRenderer implements SubRenderer {
  private viewer: Viewer;
  private meshCache: MeshCache;
  private spatialGrid: SpatialHashGrid;
  
  // Tracking maps for spatial batching
  private buildingToTileMap = new Map<string, string[]>();
  private tilePrimitives = new Map<string, Primitive[]>(); // tileKey -> [farPrim, medPrim, closePrim]
  private dirtyTiles = new Set<string>();
  private buildingSelections = new Set<string>();
  
  private rebuildTimeout: any = null;
  private currentHeight: number = 800; // Camera height tracker

  constructor(viewer: Viewer, meshCache: MeshCache, spatialGrid: SpatialHashGrid) {
    this.viewer = viewer;
    this.meshCache = meshCache;
    this.spatialGrid = spatialGrid;
  }

  /**
   * Called by RenderManager when a building object changes or is added
   */
  public render(objId: string, _meshes: MeshData[]): void {
    const tileKeys = this.spatialGrid.getTileKeysForObject(objId);
    const oldTileKeys = this.buildingToTileMap.get(objId);

    if (oldTileKeys) {
      oldTileKeys.forEach(key => {
        if (!tileKeys.includes(key)) {
          this.dirtyTiles.add(key);
        }
      });
    }
    
    this.buildingToTileMap.set(objId, tileKeys);
    tileKeys.forEach(key => {
      this.dirtyTiles.add(key);
    });
    
    this.scheduleRebuild();
  }

  /**
   * Called by RenderManager when a building object is removed
   */
  public remove(objId: string): void {
    const tileKeys = this.buildingToTileMap.get(objId);
    this.buildingToTileMap.delete(objId);
    this.buildingSelections.delete(objId);

    if (tileKeys) {
      tileKeys.forEach(key => {
        this.dirtyTiles.add(key);
      });
      this.scheduleRebuild();
    }
  }

  /**
   * Selection highlight trigger
   */
  public setSelection(objId: string, isSelected: boolean): void {
    if (isSelected) {
      this.buildingSelections.add(objId);
    } else {
      this.buildingSelections.delete(objId);
    }
    const tileKeys = this.buildingToTileMap.get(objId);
    if (tileKeys) {
      tileKeys.forEach(key => {
        this.dirtyTiles.add(key);
      });
      this.scheduleRebuild();
    }
  }

  /**
   * Clears all primitives from the Cesium viewport
   */
  public clear(): void {
    if (this.rebuildTimeout) {
      clearTimeout(this.rebuildTimeout);
      this.rebuildTimeout = null;
    }
    this.tilePrimitives.forEach((prims) => {
      for (const prim of prims) {
        this.viewer.scene.primitives.remove(prim);
      }
    });
    this.tilePrimitives.clear();
    this.buildingToTileMap.clear();
    this.dirtyTiles.clear();
    this.buildingSelections.clear();
  }

  /**
   * Dynamic loading/unloading of tiles on viewport camera moves
   */
  public setVisibilityForObjects(objIds: string[], visible: boolean): void {
    const tilesToToggle = new Set<string>();
    for (const id of objIds) {
      const tileKeys = this.buildingToTileMap.get(id);
      if (tileKeys) {
        tileKeys.forEach(key => tilesToToggle.add(key));
      }
    }

    tilesToToggle.forEach((tileKey) => {
      const prims = this.tilePrimitives.get(tileKey);
      if (prims) {
        this.applyLODToTilePrimitives(prims, visible);
      }
    });
  }

  /**
   * Updates tile primitives visibility depending on camera altitude
   */
  public updateLOD(height: number): void {
    this.currentHeight = height;

    this.tilePrimitives.forEach((prims) => {
      this.applyLODToTilePrimitives(prims, true);
    });
  }

  /**
   * Explicitly unloads primitives for a single tile key
   */
  public unloadTile(tileKey: string): void {
    const oldPrims = this.tilePrimitives.get(tileKey);
    if (oldPrims) {
      for (const prim of oldPrims) {
        this.viewer.scene.primitives.remove(prim);
      }
      this.tilePrimitives.delete(tileKey);
    }
  }

  private scheduleRebuild() {
    if (this.rebuildTimeout) return;
    this.rebuildTimeout = setTimeout(() => {
      this.rebuildDirtyTiles();
      this.rebuildTimeout = null;
    }, 16);
  }

  private rebuildDirtyTiles() {
    const cache = this.meshCache;
    const grid = this.spatialGrid;

    this.dirtyTiles.forEach((tileKey) => {
      // 1. Remove old tile primitives from the scene
      const oldPrims = this.tilePrimitives.get(tileKey);
      if (oldPrims) {
        for (const prim of oldPrims) {
          this.viewer.scene.primitives.remove(prim);
        }
        this.tilePrimitives.delete(tileKey);
      }

      // 2. Fetch building IDs currently active in this tile
      const objIds = grid.getObjectsInTiles([tileKey]);
      const buildingIds = objIds.filter(id => this.buildingToTileMap.has(id));

      if (buildingIds.length === 0) return;

      const farInstances: GeometryInstance[] = [];
      const medInstances: GeometryInstance[] = [];
      const closeInstances: GeometryInstance[] = [];

      for (const id of buildingIds) {
        const meshes = cache.get(id);
        if (!meshes || meshes.length < 3) continue;

        const isSelected = this.buildingSelections.has(id);

        // Far LOD Footprint
        const farGeom = CesiumAdapter.buildGeometry(meshes[0]);
        const farColorStr = isSelected ? '#00ffff' : meshes[0].material.color;
        farInstances.push(new GeometryInstance({
          geometry: farGeom,
          attributes: {
            color: ColorGeometryInstanceAttribute.fromColor(Color.fromCssColorString(farColorStr))
          },
          id: id
        }));

        // Medium LOD Extrusion
        const medGeom = CesiumAdapter.buildGeometry(meshes[1]);
        const medColorStr = isSelected ? '#00ffff' : meshes[1].material.color;
        medInstances.push(new GeometryInstance({
          geometry: medGeom,
          attributes: {
            color: ColorGeometryInstanceAttribute.fromColor(Color.fromCssColorString(medColorStr))
          },
          id: id
        }));

        // Close LOD High-Quality Extrusion
        const closeGeom = CesiumAdapter.buildGeometry(meshes[2]);
        const closeColorStr = isSelected ? '#00ffff' : meshes[2].material.color;
        closeInstances.push(new GeometryInstance({
          geometry: closeGeom,
          attributes: {
            color: ColorGeometryInstanceAttribute.fromColor(Color.fromCssColorString(closeColorStr))
          },
          id: id
        }));
      }

      // 3. Batch instances into tile primitives
      const prims: Primitive[] = [];

      if (farInstances.length > 0) {
        const farPrim = new Primitive({
          geometryInstances: farInstances,
          appearance: new PerInstanceColorAppearance({ flat: true, translucent: false }),
          asynchronous: false
        });
        this.viewer.scene.primitives.add(farPrim);
        prims.push(farPrim);
      }

      if (medInstances.length > 0) {
        const medPrim = new Primitive({
          geometryInstances: medInstances,
          appearance: new PerInstanceColorAppearance({ flat: true, translucent: false }),
          asynchronous: false
        });
        this.viewer.scene.primitives.add(medPrim);
        prims.push(medPrim);
      }

      if (closeInstances.length > 0) {
        const closePrim = new Primitive({
          geometryInstances: closeInstances,
          appearance: new PerInstanceColorAppearance({ flat: true, translucent: false }),
          asynchronous: false
        });
        this.viewer.scene.primitives.add(closePrim);
        prims.push(closePrim);
      }

      this.applyLODToTilePrimitives(prims, true);
      this.tilePrimitives.set(tileKey, prims);
    });

    this.dirtyTiles.clear();
  }

  private applyLODToTilePrimitives(prims: Primitive[], visible: boolean) {
    if (!visible) {
      for (const prim of prims) {
        prim.show = false;
      }
      return;
    }

    const height = this.currentHeight;
    const showFar = height >= 2000;
    const showMedium = height >= 500 && height < 2000;
    const showClose = height < 500;

    if (prims.length === 3) {
      prims[0].show = showFar;
      prims[1].show = showMedium;
      prims[2].show = showClose;
    } else if (prims.length === 2) {
      prims[0].show = showFar;
      prims[1].show = !showFar;
    } else if (prims.length === 1) {
      prims[0].show = true;
    }
  }
}

import { Viewer } from 'cesium';
import type { CityObject } from '../objects/types';
import { ProceduralGeometryGenerator } from './geometry/ProceduralGeometryGenerator';
import { MeshCache } from './cache/MeshCache';
import { SpatialHashGrid } from './spatial/SpatialHashGrid';
import { RoadRenderer } from './renderers/RoadRenderer';
import { BuildingRenderer } from './renderers/BuildingRenderer';
import { TransitRenderer } from './renderers/TransitRenderer';

export class RenderManager {
  private generator = new ProceduralGeometryGenerator();
  private meshCache = new MeshCache();
  private spatialGrid = new SpatialHashGrid(300); // 300m uniform metric cells
  
  private roadRenderer!: RoadRenderer;
  private buildingRenderer!: BuildingRenderer;
  private transitRenderer!: TransitRenderer;

  private allObjects = new Map<string, CityObject>();
  private loadedTiles = new Set<string>();
  private activeSelectedId: string | null = null;

  public initialize(viewer: Viewer): void {
    this.roadRenderer = new RoadRenderer(viewer, this.meshCache, this.spatialGrid);
    this.buildingRenderer = new BuildingRenderer(viewer, this.meshCache, this.spatialGrid);
    this.transitRenderer = new TransitRenderer(viewer, this.meshCache, this.spatialGrid);
  }

  /**
   * Reconciles the RenderManager's scene state against the ObjectManager's state
   */
  public reconcile(currentObjects: CityObject[]): void {
    console.log('[STARTUP] Rendering START');
    const currentMap = new Map(currentObjects.map(o => [o.id, o]));

    // 1. Identify deleted objects
    this.allObjects.forEach((_, id) => {
      if (!currentMap.has(id)) {
        this.deregisterObject(id);
      }
    });

    // Keep track of which objects are new or updated before pre-populating
    const toRegister: CityObject[] = [];
    const toUpdate: CityObject[] = [];

    currentObjects.forEach(obj => {
      const existing = this.allObjects.get(obj.id);
      if (!existing) {
        toRegister.push(obj);
      } else if (existing.updatedAt !== obj.updatedAt || JSON.stringify(existing) !== JSON.stringify(obj)) {
        toUpdate.push(obj);
      }
    });

    // 2. Pre-populate allObjects map with all current objects so that nearest-track lookups succeed
    currentObjects.forEach(obj => {
      this.allObjects.set(obj.id, obj);
    });

    // 3. Register and update the new or changed objects
    toRegister.forEach(obj => {
      this.registerObject(obj);
    });
    toUpdate.forEach(obj => {
      this.updateObject(obj);
    });
  }

  /**
   * Registers an object into the spatial grid, generates its mesh, and caches it
   */
  public registerObject(obj: CityObject): void {
    this.allObjects.set(obj.id, obj);

    // 1. Get location coordinates for spatial grid
    const coords: [number, number, number] | [number, number, number][] | undefined = obj.coordinates;
    if (coords && coords.length > 0) {
      this.spatialGrid.insertObject(obj.id, coords);
    }

    // 2. Pre-generate MeshData and store in cache ahead of rendering
    const meshes = this.generator.generateMeshData(obj, this.allObjects);
    this.meshCache.set(obj.id, meshes);

    // 3. If the object resides in any already loaded tile, render it immediately
    if (coords && coords.length > 0) {
      const objectTiles = this.spatialGrid.getTileKeysForObject(obj.id);
      const isAnyTileLoaded = objectTiles.some(tile => this.loadedTiles.has(tile));
      if (isAnyTileLoaded) {
        this.renderObject(obj.id);
      }
    }
  }

  /**
   * Updates an object's geometry cache, spatial cell position, and active primitives
   */
  public updateObject(obj: CityObject): void {
    this.deregisterObject(obj.id);
    this.registerObject(obj);
    if (this.activeSelectedId === obj.id) {
      this.setSelection(obj.id, true);
    }
  }

  public setRoadColor(roadId: string, colorHex: string): void {
    if (this.roadRenderer) {
      this.roadRenderer.setRoadColor(roadId, colorHex);
    }
    if (this.transitRenderer) {
      this.transitRenderer.setTransitColor(roadId, colorHex);
    }
  }

  /**
   * Deregisters and unmounts an object from memory and active viewports
   */
  public deregisterObject(objId: string): void {
    this.allObjects.delete(objId);
    this.spatialGrid.remove(objId);
    this.meshCache.invalidate(objId);

    this.roadRenderer.remove(objId);
    this.buildingRenderer.remove(objId);
    this.transitRenderer.remove(objId);
  }

  /**
   * Toggles the visibility of tiles dynamically based on camera visibility
   */
  public updateVisibleTiles(visibleTileKeys: string[]): void {
    const nextLoadedTiles = new Set(visibleTileKeys);

    // 1. Unload primitives for any tiles that are no longer visible,
    // and identify objects that should be fully unrendered.
    const objectsInUnloadedTiles = new Set<string>();

    for (const tile of this.loadedTiles) {
      if (!nextLoadedTiles.has(tile)) {
        // Unload tile primitives from Cesium scene
        this.roadRenderer.unloadTile(tile);
        this.buildingRenderer.unloadTile(tile);
        this.transitRenderer.unloadTile(tile);

        // Track objects that were in this tile
        const objIds = this.spatialGrid.getObjectsInTiles([tile]);
        for (const id of objIds) {
          objectsInUnloadedTiles.add(id);
        }
      }
    }

    // Fully unrender an object only if NONE of the tiles it intersects are currently visible
    for (const id of objectsInUnloadedTiles) {
      const objectTiles = this.spatialGrid.getTileKeysForObject(id);
      const isStillVisible = objectTiles.some(tile => nextLoadedTiles.has(tile));
      if (!isStillVisible) {
        this.unrenderObject(id);
      }
    }

    // 2. Identify tiles that should be loaded
    for (const tile of nextLoadedTiles) {
      if (!this.loadedTiles.has(tile)) {
        const objIds = this.spatialGrid.getObjectsInTiles([tile]);
        for (const id of objIds) {
          this.renderObject(id);
        }
      }
    }

    this.loadedTiles = nextLoadedTiles;
  }

  /**
   * Selection highlight toggle
   */
  public setSelection(objId: string | null, isSelected: boolean): void {
    if (isSelected && objId) {
      if (this.activeSelectedId && this.activeSelectedId !== objId) {
        this.setSelection(this.activeSelectedId, false);
      }
      this.activeSelectedId = objId;
      this.roadRenderer.setSelection(objId, true);
      this.buildingRenderer.setSelection(objId, true);
      this.transitRenderer.setSelection(objId, true);
    } else if (objId) {
      if (this.activeSelectedId === objId) {
        this.activeSelectedId = null;
      }
      this.roadRenderer.setSelection(objId, false);
      this.buildingRenderer.setSelection(objId, false);
      this.transitRenderer.setSelection(objId, false);
    }
  }

  /**
   * Clears everything
   */
  public clear(): void {
    this.roadRenderer.clear();
    this.buildingRenderer.clear();
    this.transitRenderer.clear();
    this.meshCache.clear();
    this.allObjects.clear();
    this.loadedTiles.clear();
    this.activeSelectedId = null;
  }

  /**
   * Renders an individual object on the viewport retrieving from cache
   */
  private renderObject(objId: string): void {
    const obj = this.allObjects.get(objId);
    if (!obj) return;

    const meshes = this.meshCache.get(objId);
    if (!meshes || meshes.length === 0) return;

    if (obj.type === 'road') {
      this.roadRenderer.render(objId, meshes);
    } else if (obj.type === 'building') {
      this.buildingRenderer.render(objId, meshes);
    } else if (
      obj.type === 'flyover' ||
      obj.type === 'metro_flyover' ||
      obj.type === 'metro_line' ||
      obj.type === 'metro_station' ||
      obj.type === 'utility' ||
      obj.type === 'junction'
    ) {
      this.transitRenderer.render(objId, meshes);
    }
  }

  /**
   * Removes primitives of an individual object from active viewport
   */
  private unrenderObject(objId: string): void {
    this.roadRenderer.remove(objId);
    this.buildingRenderer.remove(objId);
    this.transitRenderer.remove(objId);
  }

  // Getters for LOD checking
  public getRoadRenderer(): RoadRenderer { return this.roadRenderer; }
  public getBuildingRenderer(): BuildingRenderer { return this.buildingRenderer; }
  public getTransitRenderer(): TransitRenderer { return this.transitRenderer; }
  public getSpatialGrid(): SpatialHashGrid { return this.spatialGrid; }
  public getMeshCache() { return this.meshCache; }
}

export const renderManagerInstance = new RenderManager();

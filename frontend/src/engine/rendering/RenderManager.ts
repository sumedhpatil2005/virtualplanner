import { Viewer } from 'cesium';
import type { CityObject } from '../objects/types';
import { ProceduralGeometryGenerator } from './geometry/ProceduralGeometryGenerator';
import { MeshCache } from './cache/MeshCache';
import { SpatialHashGrid } from './spatial/SpatialHashGrid';
import { RoadRenderer } from './renderers/RoadRenderer';
import { BuildingRenderer } from './renderers/BuildingRenderer';
import { TransitRenderer } from './renderers/TransitRenderer';
import { GeometryContext } from './geometry/GeometryContext';

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

  // Opacity per registry layer id, plus a resolver from object layer id to registry id
  private layerOpacity = new Map<string, number>();
  private resolveLayer: (rawLayerId: string) => string = id => id;
  private opacityRefreshTimeout: ReturnType<typeof setTimeout> | null = null;

  /** Lookup index over allObjects; dropped whenever the object set changes and rebuilt on demand. */
  private sceneContext: GeometryContext | null = null;

  constructor() {
    // Meshes are generated lazily when a tile first needs them (and regenerated
    // after LRU eviction), so objects in tiles never viewed cost nothing.
    this.meshCache.setLoader(objId => {
      const obj = this.allObjects.get(objId);
      if (!obj) return undefined;
      this.sceneContext ??= new GeometryContext(this.allObjects);
      return this.generator.generateMeshData(obj, this.sceneContext);
    });
  }

  public initialize(viewer: Viewer): void {
    const getOpacity = (objId: string) => this.getObjectOpacity(objId);
    this.roadRenderer = new RoadRenderer(viewer, this.meshCache, this.spatialGrid, getOpacity);
    this.buildingRenderer = new BuildingRenderer(viewer, this.meshCache, this.spatialGrid, getOpacity);
    this.transitRenderer = new TransitRenderer(viewer, this.meshCache, this.spatialGrid, getOpacity);
  }

  public getObjectOpacity(objId: string): number {
    const obj = this.allObjects.get(objId);
    if (!obj) return 1;
    return this.layerOpacity.get(this.resolveLayer(obj.layerId)) ?? 1;
  }

  /**
   * Applies layer opacities. Changed values rebuild the loaded tiles, debounced
   * so dragging a slider does not rebuild on every intermediate value.
   */
  public setLayerOpacities(opacities: Map<string, number>, resolveLayer?: (rawLayerId: string) => string): void {
    if (resolveLayer) this.resolveLayer = resolveLayer;
    let changed = opacities.size !== this.layerOpacity.size;
    opacities.forEach((v, k) => {
      if (this.layerOpacity.get(k) !== v) changed = true;
    });
    if (!changed) return;
    this.layerOpacity = new Map(opacities);
    if (!this.roadRenderer) return;

    if (this.opacityRefreshTimeout) clearTimeout(this.opacityRefreshTimeout);
    this.opacityRefreshTimeout = setTimeout(() => {
      this.opacityRefreshTimeout = null;
      this.roadRenderer.refreshAll();
      this.buildingRenderer.refreshAll();
      this.transitRenderer.refreshAll();
    }, 120);
  }

  /**
   * Reconciles the RenderManager's scene state against the ObjectManager's state
   */
  public reconcile(currentObjects: CityObject[]): void {
    const currentMap = new Map(currentObjects.map(o => [o.id, o]));

    // 1. Identify deleted objects
    const removedTypes = new Set<string>();
    this.allObjects.forEach((obj, id) => {
      if (!currentMap.has(id)) {
        removedTypes.add(obj.type);
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
      } else if (existing !== obj) {
        // ObjectManager never mutates a stored object: every add/update stores a
        // new object, so identity is the change version. This replaces two
        // JSON.stringify calls per object on every change (~15k for one layer toggle).
        toUpdate.push(obj);
      }
    });

    if (toRegister.length === 0 && toUpdate.length === 0 && removedTypes.size === 0) return;

    // 2. Pre-populate allObjects map with all current objects so that nearest-track lookups succeed
    currentObjects.forEach(obj => {
      this.allObjects.set(obj.id, obj);
    });
    this.sceneContext = null;

    // Track-aligned stations orient themselves from nearby tracks, so when a
    // track appears, moves or disappears those stations must be rebuilt too.
    const trackChanged =
      removedTypes.has('metro_line') || removedTypes.has('metro_flyover') ||
      [...toRegister, ...toUpdate].some(o => o.type === 'metro_line' || o.type === 'metro_flyover');
    if (trackChanged) {
      const pending = new Set([...toRegister, ...toUpdate].map(o => o.id));
      currentObjects.forEach(o => {
        if (o.type === 'metro_station' && o.alignToTrack !== false && !pending.has(o.id)) {
          toUpdate.push(o);
        }
      });
    }

    // Roads leave footpaths and markings out where other roads meet them, so the
    // roads around a new or changed road are rebuilt to fit their junctions
    const isRoadLike = (o: CityObject) => o.type === 'road' || o.type === 'flyover' || o.type === 'metro_flyover';
    const changedRoads = [...toRegister, ...toUpdate].filter(isRoadLike);
    if (changedRoads.length > 0 && changedRoads.length < currentObjects.length / 2) {
      const pad = 0.0003; // about 30 m
      const box = (o: CityObject) => {
        const c = o.coordinates as number[][];
        let x0 = Infinity, y0 = Infinity, x1 = -Infinity, y1 = -Infinity;
        for (const p of c) {
          if (p[0] < x0) x0 = p[0];
          if (p[0] > x1) x1 = p[0];
          if (p[1] < y0) y0 = p[1];
          if (p[1] > y1) y1 = p[1];
        }
        return [x0 - pad, y0 - pad, x1 + pad, y1 + pad];
      };
      // Changed roads' boxes in a coarse grid, so each road checks only the few nearby
      const cell = (v: number) => Math.floor(v / 0.002);
      const grid = new Map<string, number[][]>();
      for (const b of changedRoads.map(box)) {
        for (let x = cell(b[0]); x <= cell(b[2]); x++) {
          for (let y = cell(b[1]); y <= cell(b[3]); y++) {
            const key = x + ':' + y;
            const list = grid.get(key);
            if (list) list.push(b);
            else grid.set(key, [b]);
          }
        }
      }
      const pending = new Set([...toRegister, ...toUpdate].map(o => o.id));
      currentObjects.forEach(o => {
        if (!isRoadLike(o) || pending.has(o.id) || !o.coordinates?.length) return;
        const [x0, y0, x1, y1] = box(o);
        for (let x = cell(x0); x <= cell(x1); x++) {
          for (let y = cell(y0); y <= cell(y1); y++) {
            if (grid.get(x + ':' + y)?.some(b => b[0] <= x1 && b[2] >= x0 && b[1] <= y1 && b[3] >= y0)) {
              toUpdate.push(o);
              return;
            }
          }
        }
      });
    }

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
    this.sceneContext = null;

    // 1. Get location coordinates for spatial grid
    const coords: [number, number, number] | [number, number, number][] | undefined = obj.coordinates;
    if (coords && coords.length > 0) {
      this.spatialGrid.insertObject(obj.id, coords);
    }

    // 2. Meshes are generated on demand by the cache loader when a tile builds

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
    this.sceneContext = null;
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
    // Nothing selected any more: take the highlight off whatever had it
    if (!objId) {
      if (this.activeSelectedId) this.setSelection(this.activeSelectedId, false);
      return;
    }
    if (isSelected) {
      if (this.activeSelectedId && this.activeSelectedId !== objId) {
        this.setSelection(this.activeSelectedId, false);
      }
      this.activeSelectedId = objId;
      this.roadRenderer.setSelection(objId, true);
      this.buildingRenderer.setSelection(objId, true);
      this.transitRenderer.setSelection(objId, true);
    } else {
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
    if (this.opacityRefreshTimeout) {
      clearTimeout(this.opacityRefreshTimeout);
      this.opacityRefreshTimeout = null;
    }
    this.roadRenderer?.clear();
    this.buildingRenderer?.clear();
    this.transitRenderer?.clear();
    this.allObjects.forEach((_, id) => this.spatialGrid.remove(id));
    this.sceneContext = null;
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

    // Meshes are fetched (and generated if needed) when the tile batch is built
    if (obj.type === 'road') {
      this.roadRenderer.render(objId);
    } else if (obj.type === 'building') {
      this.buildingRenderer.render(objId);
    } else if (
      obj.type === 'flyover' ||
      obj.type === 'metro_flyover' ||
      obj.type === 'metro_line' ||
      obj.type === 'metro_station' ||
      obj.type === 'utility' ||
      obj.type === 'junction'
    ) {
      this.transitRenderer.render(objId);
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

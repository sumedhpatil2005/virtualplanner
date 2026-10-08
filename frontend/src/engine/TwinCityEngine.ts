import {
  Viewer,
  Entity,
  Cartesian3,
  Cartesian2,
  Color,
  ScreenSpaceEventHandler,
  ScreenSpaceEventType,
  KeyboardEventModifier,
  Cartographic,
  Math as CesiumMath,
  defined,
  ClassificationType,
  LabelStyle,
  HorizontalOrigin,
  VerticalOrigin,
  HeightReference,
  PolylineDashMaterialProperty,
  EllipsoidTerrainProvider,
  createWorldTerrainAsync
} from 'cesium';
import { ObjectManager } from './objects/ObjectManager';
import type { CityObject, RoadObject, ZoneObject, GatewayObject, BuildingObject } from './objects/types';
import { renderManagerInstance } from './rendering/RenderManager';
import { TrafficNetworkVisualizer } from './rendering/renderers/TrafficNetworkVisualizer';
import { JunctionEditorOverlay } from './rendering/renderers/JunctionEditorOverlay';
import { LODController } from './rendering/lod/LODController';
import { SelectionEngine } from './selection/SelectionEngine';
import { LayerManager, resolveLayerId } from './layers/LayerManager';
import { filterObjectsForScenario } from './scenarios/scenarioFilter';
import { ScenarioManager, BASE_SCENARIO_ID, type Scenario } from './scenarios/ScenarioManager';
import { SimulationManager } from './simulation/SimulationManager';
import { SimulationMode, type SimulationContext } from './simulation/SimulationMode';
import type { TimePeriod } from './objects/demandTypes';
import { TrafficSignalSource } from './simulation/trafficSignals';
import { LocalOsmIndex } from './editing/LocalOsmIndex';
import { isDrivable, boundsOf, type StudyProblem } from './simulation/StudyAreaExplorer';
import { roadConnections, type RoadConnections } from './simulation/roadConnections';
import { isUserBuilt } from './objects/builtBy';

/** What the app is doing: looking at the city, changing it, or simulating traffic. */
export type AppMode = 'view' | 'build' | 'simulate';
import { findRoadEndGaps, type RoadEndGap } from './editing/roadGaps';
import type { NonDrivableRoad } from './editing/osmDrivability';
import { HistoryManager } from './history/HistoryManager';
import { EditingEngine } from './editing/EditingEngine';
import { runProgressivePerformanceTest, runRoadPerformanceTest } from './testing/PerformanceTester';
import { apiGet } from '../lib/api';
import { normalizeHeading, resolveStationHeading } from './objects/stationAlignment';

export class TwinCityEngine {
  public objects: ObjectManager;
  public selection: SelectionEngine;
  public layers: LayerManager;
  public scenarios: ScenarioManager;
  public simulations: SimulationManager;
  /** Simulation mode: study-area selection on a read-only road network. */
  public simMode: SimulationMode;
  public history: HistoryManager;
  public editing: EditingEngine;
  public trafficNetwork: any = null;
  public trafficDemandMatrix: any = null;
  private trafficVisualizer = new TrafficNetworkVisualizer();
  private junctionOverlay = new JunctionEditorOverlay();

  private viewer: Viewer | null = null;
  private drawPreviewEntity: Entity | null = null;
  private drawMarkers: Entity[] = [];
  private snapReticleEntity: Entity | null = null;
  private gapPreviewEntity: Entity | null = null;
  private rubberbandEntity: Entity | null = null;
  private snapFrameHandle: number | null = null;
  private pendingSnapPoint: [number, number, number] | null = null;
  private areaEntities: Entity[] = [];
  private draggingPointIdx: number | null = null;
  private zoneEntities: Entity[] = [];
  private gatewayEntities: Entity[] = [];
  private editZoneMarkers: Entity[] = [];
  private draggingZonePointIdx: number | null = null;
  private isPlanningMode = false;
  private modeListeners = new Set<() => void>();
  /**
   * The city-wide traffic graph is built only once something needs it (the
   * network debug layer, the gateway tool, a few Build-mode details), not on
   * every start-up and edit. Simulate builds its own graph for the study area.
   */
  private cityNetworkWanted = false;
  private viewModeHintShown = false;

  private rebuildTimeout: any = null;
  private demandRebuildTimeout: any = null;
  private trafficWorker: Worker | null = null;
  private activeRequestId = 0;

  // Viewer-bound resources released by dispose()
  private interactionHandler: ScreenSpaceEventHandler | null = null;
  private lodController: LODController | null = null;
  private removeImageryListener: (() => void) | null = null;
  private fpsFrameHandle: number | null = null;
  private hasLoadedData = false;

  // Zone vertex drag: preview locally per frame, save once on release (item 31)
  private zoneDragBefore: CityObject | null = null;
  private zoneDragCoords: [number, number, number][] | null = null;
  private zoneDragFrameHandle: number | null = null;

  constructor() {
    console.log('[STARTUP] BEGIN');
    this.objects = new ObjectManager();
    this.selection = new SelectionEngine();
    this.layers = new LayerManager();
    this.scenarios = new ScenarioManager();
    this.simulations = new SimulationManager();
    // Roads and signals from the backend's OpenStreetMap extract, shared by editing and simulation
    const localOsm = new LocalOsmIndex();
    this.simMode = new SimulationMode(
      () => filterObjectsForScenario(this.objects.getAll(), this.scenarios.getActiveScenarioId()).filter(isDrivable),
      // Study areas reaching past the imported map load the OSM roads there through the importer
      {
        load: (boxes, signal) => this.editing.loadOsmRoadsForStudyArea(boxes, signal),
      },
      // Real traffic signals from OpenStreetMap, kept on this device
      new TrafficSignalSource(localOsm),
      () => this.getSimulationContext()
    );
    this.history = new HistoryManager(this.objects);
    this.editing = new EditingEngine(this.objects, this.history, () => this.getTrafficNetwork(), localOsm);
    // Placing a gateway snaps it to the city-wide graph
    this.editing.onChange(() => {
      if (this.editing.getMode() === 'draw_gateway') this.requestTrafficNetwork();
    });

    (window as any).engineInstance = this;
    this.scenarios.load();

    this.startTrafficWorker();

    this.objects.onChange((changedTypes: Set<string>) => {
      if (changedTypes.has('road') || changedTypes.has('junction') || changedTypes.has('flyover') || changedTypes.has('metro_flyover') || changedTypes.size === 0) {
        this.queueTrafficRebuild();
        this.simMode.networkChanged();
      } else {
        this.queueTrafficDemandRebuildOnly();
        if (['building', 'zone', 'gateway'].some(type => changedTypes.has(type))) this.simMode.networkChanged();
      }
      renderManagerInstance.reconcile(this.getFilteredObjects());
      this.syncZonesAndGatewaysWithCesium();
    });
    this.layers.onChange(() => {
      if (this.layers.isVisible('traffic_network_debug')) this.requestTrafficNetwork();
      this.applyLayerOpacities();
      this.applyBaseLayers();
      this.syncTrafficNetworkVisualization();
      renderManagerInstance.reconcile(this.getFilteredObjects());
      this.syncZonesAndGatewaysWithCesium();
    });
    this.scenarios.onChange(() => {
      this.selection.clearSelection();
      this.simMode.networkChanged();
      renderManagerInstance.reconcile(this.getFilteredObjects());
      this.syncZonesAndGatewaysWithCesium();
    });
    this.simulations.onChange(() => {
      renderManagerInstance.reconcile(this.getFilteredObjects());
      this.syncZonesAndGatewaysWithCesium();
    });
    this.selection.onChange(() => {
      const activeSel = this.selection.getSelection();
      renderManagerInstance.setSelection(activeSel[0] || null, true);
      this.syncSavedAreasWithCesium();
      this.syncZonesAndGatewaysWithCesium();
    });
    this.editing.onChange(() => {
      this.updateDrawPreview();
      this.syncSavedAreasWithCesium();
      this.syncZonesAndGatewaysWithCesium();
      if (this.editing.getMode() === 'select') {
        this.clearSnapPreview();
      }
    });


    // Bind global tester
    (window as any).runProgressivePerformanceTest = () => {
      runProgressivePerformanceTest(this);
    };
    (window as any).runRoadPerformanceTest = () => {
      runRoadPerformanceTest(this);
    };
  }

  private getFilteredObjects(): CityObject[] {
    const all = this.objects.getAll();
    const activeScenarioId = this.scenarios.getActiveScenarioId();

    // 1. Filter by scenario (Base + Active Scenario, handling overrides)
    const scenarioFiltered = filterObjectsForScenario(all, activeScenarioId);

    // 2. Filter by layer visibility (legacy ids resolve to their registry layer)
    const visibility = new Map(this.layers.getAll().map(l => [l.id, l.visible]));
    return scenarioFiltered.filter(obj => visibility.get(resolveLayerId(obj.layerId)) ?? true);
  }

  private getSimulationContext(): SimulationContext {
    const scenarioId = this.scenarios.getActiveScenarioId();
    const objects = filterObjectsForScenario(this.objects.getAll(), scenarioId);
    const flows = (values: Record<string, number>) => Object.fromEntries(
      (['AM_Peak', 'PM_Peak', 'Midday', 'Night'] as TimePeriod[]).map(p => [p, Math.max(0, values?.[p] || 0)])
    ) as Record<TimePeriod, number>;
    return {
      scenarioId,
      junctions: objects.filter(o => o.type === 'junction'),
      buildings: objects.filter(o => o.type === 'building'),
      zones: objects.filter(o => o.type === 'zone').map(z => ({
        id: z.id, name: z.name, boundaryPolygon: z.coordinates,
        totalPopulation: z.totalPopulation || 0, totalEmployment: z.totalEmployment || 0,
        landUseMix: z.landUseMix, gateways: z.gateways || [],
        provenance: z.provenance || { source: 'estimated', confidence: 0, updatedAt: z.updatedAt },
      })),
      gateways: objects.filter(o => o.type === 'gateway').map(g => ({
        id: g.id, name: g.name, coordinates: g.coordinates[0], connectedNodeId: g.connectedNodeId,
        inboundFlows: flows(g.inboundFlows), outboundFlows: flows(g.outboundFlows), modeSplit: g.modeSplit,
        provenance: g.provenance || { source: 'estimated', confidence: 0, updatedAt: g.updatedAt },
      })),
    };
  }

  private startTrafficWorker() {
    if (this.trafficWorker) return;
    try {
      this.trafficWorker = new Worker(new URL('./simulation/traffic.worker.ts', import.meta.url), { type: 'module' });
      this.setupWorkerListener();
    } catch (err) {
      console.error('Failed to initialize traffic Web Worker:', err);
    }
  }

  /** Real-time FPS monitor exposed as window.twincity_fps. */
  private startFpsMonitor() {
    if (this.fpsFrameHandle !== null) return;
    let lastTime = performance.now();
    let frameCount = 0;
    const tick = () => {
      const now = performance.now();
      frameCount++;
      if (now - lastTime >= 1000) {
        (window as any).twincity_fps = Math.round((frameCount * 1000) / (now - lastTime));
        frameCount = 0;
        lastTime = now;
      }
      this.fpsFrameHandle = requestAnimationFrame(tick);
    };
    this.fpsFrameHandle = requestAnimationFrame(tick);
  }

  /**
   * Releases everything bound to the current Cesium viewer (item 30). Call it
   * before destroying the viewer. The engine's data stays in memory, so a later
   * setViewer() (e.g. React StrictMode's second mount) re-renders without
   * refetching or leaking a second set of primitives and camera listeners.
   */
  public dispose() {
    this.junctionOverlay.dispose();
    if (this.simulations.isRunning('traffic')) this.simulations.stopSimulation('traffic');
    this.interactionHandler?.destroy();
    this.interactionHandler = null;
    this.lodController?.dispose();
    this.lodController = null;
    this.removeImageryListener?.();
    this.removeImageryListener = null;

    for (const handle of [this.fpsFrameHandle, this.snapFrameHandle, this.zoneDragFrameHandle]) {
      if (handle !== null) cancelAnimationFrame(handle);
    }
    this.fpsFrameHandle = this.snapFrameHandle = this.zoneDragFrameHandle = null;
    if (this.rebuildTimeout) clearTimeout(this.rebuildTimeout);
    if (this.demandRebuildTimeout) clearTimeout(this.demandRebuildTimeout);
    this.rebuildTimeout = this.demandRebuildTimeout = null;

    this.trafficWorker?.terminate();
    this.trafficWorker = null;

    this.trafficVisualizer.clear();
    this.simMode.dispose();
    renderManagerInstance.clear();

    if (this.viewer && !this.viewer.isDestroyed()) {
      [...this.drawMarkers, ...this.areaEntities, ...this.zoneEntities, ...this.gatewayEntities, ...this.editZoneMarkers]
        .forEach(e => this.viewer!.entities.remove(e));
      [this.drawPreviewEntity, this.snapReticleEntity, this.rubberbandEntity, this.gapPreviewEntity].forEach(e => e && this.viewer!.entities.remove(e));
    }
    this.gapPreviewEntity = null;
    this.drawMarkers = [];
    this.areaEntities = [];
    this.zoneEntities = [];
    this.gatewayEntities = [];
    this.editZoneMarkers = [];
    this.drawPreviewEntity = this.snapReticleEntity = this.rubberbandEntity = null;
    this.draggingPointIdx = this.draggingZonePointIdx = null;
    this.zoneDragBefore = this.zoneDragCoords = null;
    this.viewer = null;
  }

  public setViewer(viewer: Viewer) {
    if (this.viewer && this.viewer !== viewer) this.dispose();
    this.viewer = viewer;
    this.startTrafficWorker();
    this.startFpsMonitor();
    this.trafficVisualizer.setViewer(viewer);
    this.junctionOverlay.setViewer(viewer);
    renderManagerInstance.initialize(viewer);
    this.simMode.setViewer(viewer);

    // Listen for the first frame render
    viewer.scene.postRender.addEventListener(function onPostRender() {
      console.log('[STARTUP] First Cesium render');
      viewer.scene.postRender.removeEventListener(onPostRender);
    });

    this.lodController = new LODController(viewer);
    this.lodController.initCameraListeners();

    this.applyLayerOpacities();
    this.applyBaseLayers();
    // The base-layer picker swaps imagery layers; keep them in sync with the Satellite layer
    this.removeImageryListener = viewer.imageryLayers.layerAdded.addEventListener(() => this.applyBaseLayers());

    this.setupInteraction();
    if (!this.hasLoadedData) {
      this.hasLoadedData = true;
      this.loadSampleData();
    } else {
      this.queueTrafficRebuild();
    }

    // Initial sync
    renderManagerInstance.reconcile(this.getFilteredObjects());
    this.syncSavedAreasWithCesium();
    this.syncZonesAndGatewaysWithCesium();
  }

  private applyLayerOpacities() {
    const opacities = new Map(this.layers.getAll().map(l => [l.id, l.opacity]));
    renderManagerInstance.setLayerOpacities(opacities, resolveLayerId);
  }

  private terrainEnabled = false;

  /** Wires the Satellite and Terrain base layers to the Cesium viewer. */
  private applyBaseLayers() {
    if (!this.viewer) return;
    const viewer = this.viewer;

    const satellite = this.layers.get('satellite');
    if (satellite) {
      for (let i = 0; i < viewer.imageryLayers.length; i++) {
        const layer = viewer.imageryLayers.get(i);
        layer.show = satellite.visible;
        layer.alpha = satellite.opacity;
      }
    }

    const wantTerrain = this.layers.isVisible('terrain');
    if (wantTerrain === this.terrainEnabled) return;

    if (!wantTerrain) {
      this.terrainEnabled = false;
      viewer.terrainProvider = new EllipsoidTerrainProvider();
      return;
    }

    if (!import.meta.env.VITE_CESIUM_ION_TOKEN) {
      this.layers.setVisibility('terrain', false);
      (window as any).showToast?.('Terrain needs a Cesium ion token: set VITE_CESIUM_ION_TOKEN in frontend/.env and restart.', 'error');
      return;
    }

    this.terrainEnabled = true;
    createWorldTerrainAsync()
      .then(provider => {
        if (this.terrainEnabled && this.viewer) {
          this.viewer.terrainProvider = provider;
          (window as any).showToast?.('Terrain on. City models are placed at sea-level height, so some may appear below the terrain surface.', 'info');
        }
      })
      .catch(err => {
        console.warn('[TwinCityEngine] Terrain load failed:', err);
        this.terrainEnabled = false;
        this.layers.setVisibility('terrain', false);
        (window as any).showToast?.('Could not load terrain from Cesium ion. Check the token and your connection.', 'error');
      });
  }

  public getPrimitivesCount(): number {
    return this.viewer ? this.viewer.scene.primitives.length : 0;
  }

  private setupInteraction() {
    if (!this.viewer) return;

    const handler = new ScreenSpaceEventHandler(this.viewer.scene.canvas);
    this.interactionHandler = handler;

    // 1. LEFT_DOWN: Click vertex marker to start drag shift
    handler.setInputAction((click: { position: Cartesian2 }) => {
      if (!this.viewer) return;
      const pickedObject = this.viewer.scene.pick(click.position);
      if (defined(pickedObject) && pickedObject.id && typeof pickedObject.id.id === 'string') {
        const idStr = pickedObject.id.id;
        if (idStr.startsWith('draw_point_')) {
          this.draggingPointIdx = parseInt(idStr.split('_')[2]);
          this.viewer.scene.screenSpaceCameraController.enableRotate = false;
          return;
        }
        if (idStr.startsWith('edit_zone_point_')) {
          const parts = idStr.split('_');
          this.draggingZonePointIdx = parseInt(parts[parts.length - 1]);
          this.viewer.scene.screenSpaceCameraController.enableRotate = false;
          return;
        }
      }
    }, ScreenSpaceEventType.LEFT_DOWN);

    // 2. MOUSE_MOVE: Shifting the coordinates of the dragged marker OR updating magnetic snap & rubberband
    handler.setInputAction((movement: { endPosition: Cartesian2 }) => {
      if (!this.viewer) return;

      const ray = this.viewer.camera.getPickRay(movement.endPosition);
      if (!ray) return;
      const position = this.viewer.scene.globe.pick(ray, this.viewer.scene);
      if (!position) return;

      const cartographic = Cartographic.fromCartesian(position);
      const lng = CesiumMath.toDegrees(cartographic.longitude);
      const lat = CesiumMath.toDegrees(cartographic.latitude);
      const alt = cartographic.height;

      if (this.draggingPointIdx !== null || this.draggingZonePointIdx !== null) {
        if (this.draggingPointIdx !== null) {
          const drawingPts = this.editing.getDrawingPoints();
          if (drawingPts[this.draggingPointIdx]) {
            drawingPts[this.draggingPointIdx] = [lng, lat, alt];
            this.editing.notify();
          }
        } else if (this.draggingZonePointIdx !== null) {
          const selectedId = this.selection.getSelection()[0];
          const selectedObj = selectedId ? this.objects.getById(selectedId) : null;
          if (selectedObj && selectedObj.type === 'zone') {
            this.zoneDragBefore ??= selectedObj;
            const newCoords = [...(this.zoneDragCoords ?? selectedObj.coordinates)] as [number, number, number][];
            newCoords[this.draggingZonePointIdx] = [lng, lat, alt];

            // If it's the start point, also update the end point to close the ring
            if (this.draggingZonePointIdx === 0) {
              newCoords[newCoords.length - 1] = [lng, lat, alt];
            } else if (this.draggingZonePointIdx === newCoords.length - 1) {
              newCoords[0] = [lng, lat, alt];
            }

            // Preview at most once per frame, without a backend write
            this.zoneDragCoords = newCoords;
            if (this.zoneDragFrameHandle === null) {
              this.zoneDragFrameHandle = requestAnimationFrame(() => {
                this.zoneDragFrameHandle = null;
                if (this.zoneDragCoords && this.zoneDragBefore) {
                  this.objects.update(this.zoneDragBefore.id, { coordinates: this.zoneDragCoords }, true);
                }
              });
            }
          }
        }
        return;
      }

      // Drawing mode: Magnetic Snapping & Rubberband Preview (at most once per frame)
      const editMode = this.editing.getMode();
      if (editMode !== 'select') {
        this.pendingSnapPoint = [lng, lat, alt];
        if (this.snapFrameHandle === null) {
          this.snapFrameHandle = requestAnimationFrame(() => {
            this.snapFrameHandle = null;
            const pt = this.pendingSnapPoint;
            if (pt && this.editing.getMode() !== 'select') this.updateSnapPreview(pt[0], pt[1], pt[2]);
          });
        }
      } else {
        this.clearSnapPreview();
      }
    }, ScreenSpaceEventType.MOUSE_MOVE);

    // 3. LEFT_UP: Release drag action
    handler.setInputAction(() => {
      if (this.draggingPointIdx !== null || this.draggingZonePointIdx !== null) {
        this.draggingPointIdx = null;
        this.draggingZonePointIdx = null;
        this.commitZoneDrag();
        if (this.viewer) {
          this.viewer.scene.screenSpaceCameraController.enableRotate = true;
        }
      }
    }, ScreenSpaceEventType.LEFT_UP);

    // 4. LEFT_CLICK: Place point, select area/object, click vertex to delete
    handler.setInputAction((click: { position: Cartesian2 }) => {
      if (!this.viewer) return;

      if (this.simMode.isActive()) {
        this.handleSimulationClick(click.position, false);
        return;
      }

      const pickedObject = this.viewer.scene.pick(click.position);

      // Draw mode path
      const ray = this.viewer.camera.getPickRay(click.position);
      if (!ray) return;
      const position = this.viewer.scene.globe.pick(ray, this.viewer.scene);

      if (position) {
        const cartographic = Cartographic.fromCartesian(position);
        const lng = CesiumMath.toDegrees(cartographic.longitude);
        const lat = CesiumMath.toDegrees(cartographic.latitude);
        const alt = cartographic.height;

        const editMode = this.editing.getMode();
        if (editMode !== 'select') {
          this.editing.addDrawingPoint([lng, lat, alt]);
          if (this.editing.isSingleClickMode(editMode)) {
            try {
              this.editing.finalizeDrawing(this.scenarios.getActiveScenarioId());
            } catch (err: any) {
              // Single-click tools have nothing to continue — reset for the next attempt
              this.editing.clearDrawing();
              (window as any).showToast?.(err.message || "Failed to place object.", "error");
            }
          }
          this.clearSnapPreview();
          return;
        }
      }

      // Selection mode path
      if (defined(pickedObject) && pickedObject.id) {
        const rawId = pickedObject.id.id || pickedObject.id;
        const entityId = typeof rawId === 'string' && rawId.startsWith('junction_edit_') ? rawId.slice('junction_edit_'.length) : rawId;

        if (typeof entityId === 'string' && (entityId.startsWith('debug_node_') || entityId.startsWith('debug_edge_'))) {
          this.selection.selectSingle(entityId);
          return;
        }

        const obj = this.objects.getById(entityId);
        if (obj) {
          // View mode is about what the user built; the imported map is background
          if (!this.isPlanningMode && !isUserBuilt(obj)) {
            this.selection.selectSingle(null);
            if (!this.viewModeHintShown) {
              this.viewModeHintShown = true;
              (window as any).showToast?.('That is part of the imported map. View shows details of what you built; use Simulate to study traffic on any road.', 'info');
            }
            return;
          }
          this.selection.selectSingle(entityId);
          return;
        }
        const savedArea = this.isPlanningMode && this.editing.getSavedAreas().find(a => a.id === entityId);
        if (savedArea) {
          this.selection.selectSingle(entityId);
          return;
        }
      }

      // Clicked void - clear selection
      this.selection.selectSingle(null);
    }, ScreenSpaceEventType.LEFT_CLICK);

    // Shift+click: add or remove a road from the study area in Simulation mode
    handler.setInputAction((click: { position: Cartesian2 }) => {
      if (this.simMode.isActive()) this.handleSimulationClick(click.position, true);
    }, ScreenSpaceEventType.LEFT_CLICK, KeyboardEventModifier.SHIFT);

    // Double click to finalize drawing
    handler.setInputAction(() => {
      const editMode = this.editing.getMode();
      if (editMode !== 'select' && editMode !== 'import_osm' && !this.editing.isSingleClickMode(editMode)) {
        try {
          this.editing.finalizeDrawing(this.scenarios.getActiveScenarioId());
          this.clearSnapPreview();
        } catch (err: any) {
          (window as any).showToast?.(err.message || "Failed to finalize drawing.", "error");
        }
      }
    }, ScreenSpaceEventType.LEFT_DOUBLE_CLICK);

    // Right-click a placed vertex marker to remove it
    handler.setInputAction((click: { position: Cartesian2 }) => {
      if (!this.viewer) return;
      const pickedObject = this.viewer.scene.pick(click.position);
      if (defined(pickedObject) && pickedObject.id && typeof pickedObject.id.id === 'string') {
        const idStr: string = pickedObject.id.id;
        if (idStr.startsWith('draw_point_')) {
          this.editing.removeDrawingPoint(parseInt(idStr.split('_')[2]));
        }
      }
    }, ScreenSpaceEventType.RIGHT_CLICK);
  }

  /**
   * Simulation-mode click: pick the road under the cursor, or the nearest one
   * around the clicked point (roads are thin when seen from high up).
   */
  private handleSimulationClick(position: Cartesian2, additive: boolean) {
    if (!this.viewer) return;
    if (!additive && this.simMode.getState().traffic.status !== 'idle') {
      const ray = this.viewer.camera.getPickRay(position);
      const at = this.viewer.scene.pickPositionSupported ? this.viewer.scene.pickPosition(position) : undefined;
      const ground = at ?? (ray ? this.viewer.scene.globe.pick(ray, this.viewer.scene) : undefined);
      if (ground) {
        const c = Cartographic.fromCartesian(ground);
        const tolerance = Math.min(10, Math.max(2, this.viewer.camera.positionCartographic.height * 0.004));
        const vehicle = this.simMode.pickVehicleAt(CesiumMath.toDegrees(c.longitude), CesiumMath.toDegrees(c.latitude), tolerance);
        if (vehicle) { this.simMode.selectVehicle(vehicle.id); return; }
      }
    }
    const picked = this.viewer.scene.pick(position);
    const pickedId = defined(picked) && picked.id ? (picked.id.id || picked.id) : null;
    const pickedObj = typeof pickedId === 'string' ? this.objects.getById(pickedId) : undefined;
    let roadId = pickedObj && isDrivable(pickedObj) ? pickedObj.id : null;

    if (!roadId) {
      const ray = this.viewer.camera.getPickRay(position);
      const ground = ray ? this.viewer.scene.globe.pick(ray, this.viewer.scene) : undefined;
      if (ground) {
        const c = Cartographic.fromCartesian(ground);
        const height = this.viewer.camera.positionCartographic.height;
        // A clicked building or gateway snaps to the road serving it, further away than a near-miss click
        const tolerance = pickedObj ? 250 : Math.min(150, Math.max(15, height * 0.03));
        roadId = this.simMode.pickRoadAt(CesiumMath.toDegrees(c.longitude), CesiumMath.toDegrees(c.latitude), tolerance);
      }
    }

    if (roadId) {
      this.simMode.selectRoad(roadId, additive);
    } else if (!additive) {
      (window as any).showToast?.('No road there. Click a road, flyover or bridge to start a study area.', 'info');
    }
  }

  public isSimulationModeActive(): boolean {
    return this.simMode.isActive();
  }

  /** Enters Simulation mode. The road network is read-only until it is left. */
  public enterSimulationMode(): void {
    if (this.simMode.isActive()) return;
    this.clearSnapPreview();
    this.isPlanningMode = false;
    this.selection.clearSelection();
    this.editing.setLocked(true);
    this.history.setLocked(true);
    this.simMode.enter();
    this.syncZonesAndGatewaysWithCesium();
    this.emitMode();
  }

  public exitSimulationMode(): void {
    if (!this.simMode.isActive()) return;
    this.editing.setLocked(false);
    this.history.setLocked(false);
    this.simMode.exit();
    this.emitMode();
  }

  public getAppMode(): AppMode {
    return this.simMode.isActive() ? 'simulate' : this.isPlanningMode ? 'build' : 'view';
  }

  public setAppMode(mode: AppMode): void {
    if (mode === this.getAppMode()) return;
    if (mode === 'simulate') {
      this.enterSimulationMode();
      return;
    }
    this.exitSimulationMode();
    this.setPlanningModeActive(mode === 'build');
  }

  /** For React's useSyncExternalStore. */
  public subscribeAppMode = (callback: () => void) => {
    this.modeListeners.add(callback);
    return () => {
      this.modeListeners.delete(callback);
    };
  };

  private emitMode() {
    this.modeListeners.forEach(cb => cb());
  }

  /** Switches to Simulate and studies this road. */
  public simulateRoad(roadId: string): void {
    this.enterSimulationMode();
    this.simMode.selectRoad(roadId, false);
  }

  /** What a road or flyover joins at its ends and along it, and what it passes over. */
  public getRoadConnections(roadId: string): RoadConnections | null {
    const road = this.objects.getById(roadId);
    if (!road || !isDrivable(road)) return null;
    return roadConnections(road, this.getScenarioObjects().filter(isDrivable));
  }

  /** Moves the camera to show an object. */
  public flyToObject(id: string): void {
    const obj = this.objects.getById(id);
    if (!obj || !this.viewer) return;
    const coords = (Array.isArray(obj.coordinates[0]) ? obj.coordinates : [obj.coordinates]) as number[][];
    this.simMode.flyToBounds(boundsOf(coords));
  }

  /** Objects in the active scenario, whatever their layer visibility. */
  private getScenarioObjects(): CityObject[] {
    return filterObjectsForScenario(this.objects.getAll(), this.scenarios.getActiveScenarioId());
  }

  /** Ends of this road that stop just short of another road in the active scenario. */
  public findRoadGaps(roadId: string): RoadEndGap[] {
    const road = this.objects.getById(roadId);
    return road ? findRoadEndGaps(road, this.getScenarioObjects()) : [];
  }

  /** Joins a road end across its gap (Build mode only; one undo step). */
  public connectRoadGap(gap: RoadEndGap): void {
    if (!this.isPlanningMode) throw new Error('Switch to Build mode to edit roads.');
    this.editing.connectRoadEnd(gap, this.getScenarioObjects());
    this.previewRoadGap(null);
  }

  /**
   * Removes imported OSM roads vehicles cannot use, matching the importer's
   * rules (Build mode only; one undo step).
   */
  public removeNonDrivableOsmRoads(): NonDrivableRoad[] {
    if (!this.isPlanningMode) throw new Error('Switch to Build mode to edit roads.');
    return this.editing.removeNonDrivableOsmRoads();
  }

  /** Shows, or with null hides, the link a Connect would add. */
  public previewRoadGap(gap: RoadEndGap | null): void {
    if (!this.viewer) return;
    if (this.gapPreviewEntity) {
      this.viewer.entities.remove(this.gapPreviewEntity);
      this.gapPreviewEntity = null;
    }
    if (!gap) return;
    const lift = (p: [number, number, number]) => Cartesian3.fromDegrees(p[0], p[1], (p[2] || 0) + 1.5);
    this.gapPreviewEntity = this.viewer.entities.add({
      position: lift(gap.joinPoint),
      point: { pixelSize: 10, color: Color.fromCssColorString('#34d399'), outlineColor: Color.WHITE, outlineWidth: 2, disableDepthTestDistance: Number.POSITIVE_INFINITY },
      polyline: {
        positions: [lift(gap.endPoint), lift(gap.joinPoint)],
        width: 4,
        material: new PolylineDashMaterialProperty({ color: Color.fromCssColorString('#34d399'), dashLength: 10 }),
        depthFailMaterial: new PolylineDashMaterialProperty({ color: Color.fromCssColorString('#34d399').withAlpha(0.6), dashLength: 10 }),
      },
    });
  }

  /** Leaves Simulate for Build with the problem's road selected and in view. */
  public editProblemInPlanMode(problem: StudyProblem): void {
    this.exitSimulationMode();
    this.setPlanningModeActive(true);
    const roadId = problem.roadIds.find(id => this.objects.getById(id));
    if (roadId) this.selection.selectSingle(roadId);
    this.simMode.flyTo(problem.location);
  }

  /** Saves a finished zone-vertex drag: one backend write and one Undo step. */
  private commitZoneDrag() {
    if (this.zoneDragFrameHandle !== null) {
      cancelAnimationFrame(this.zoneDragFrameHandle);
      this.zoneDragFrameHandle = null;
    }
    const before = this.zoneDragBefore;
    const coords = this.zoneDragCoords;
    this.zoneDragBefore = this.zoneDragCoords = null;
    if (!before || !coords || !this.objects.getById(before.id)) return;

    this.objects.update(before.id, { coordinates: coords });
    const after = this.objects.getById(before.id);
    if (after) this.history.recordUpdate(before, after, `Reshape ${before.name}`);
  }

  /** Finishes the in-progress multi-point drawing (used by the Enter shortcut). */
  public finishDrawing() {
    const mode = this.editing.getMode();
    if (mode === 'select' || mode === 'import_osm' || this.editing.isSingleClickMode(mode)) return;
    try {
      this.editing.finalizeDrawing(this.scenarios.getActiveScenarioId());
      this.clearSnapPreview();
    } catch (err: any) {
      (window as any).showToast?.(err.message || "Failed to finalize drawing.", "error");
    }
  }

  /**
   * Creates a new proposal scenario. When `sourceId` is a proposal, its objects
   * are copied into the new scenario (base objects are shared by every scenario
   * already). The new scenario becomes active.
   */
  public async createScenarioFrom(sourceId: string | null, input: { name: string; description?: string; year: number }): Promise<Scenario> {
    const scenario = await this.scenarios.createScenario(input);
    if (sourceId && sourceId !== BASE_SCENARIO_ID) {
      const copies = this.objects.getAll()
        .filter(o => o.scenarioId === sourceId)
        .map(o => ({
          ...(JSON.parse(JSON.stringify(o)) as CityObject),
          // Keep the original id stem (some ids carry a type prefix) and make it unique
          id: `${o.id.split('__')[0]}__${scenario.id}`,
          scenarioId: scenario.id,
        }));
      if (copies.length > 0) this.objects.addMultiple(copies);
    }
    this.scenarios.setActiveScenario(scenario.id);
    return scenario;
  }

  /** Deletes a proposal and its objects. Undo history is cleared since it may reference them. */
  public async deleteScenario(id: string): Promise<number> {
    await this.scenarios.deleteScenario(id);
    const own = this.objects.getAll().filter(o => o.scenarioId === id);
    // The backend already removed these rows, so don't sync the deletion again
    if (own.length > 0) this.objects.deleteMultiple(own, true);
    this.history.clear();
    return own.length;
  }

  /** Rotates a metro station by `deltaDeg` (switching it to manual heading), recorded for Undo. */
  public rotateStation(id: string, deltaDeg: number): boolean {
    const obj = this.objects.getById(id);
    if (!obj || obj.type !== 'metro_station') return false;
    const current = resolveStationHeading(obj, this.objects.getAll()).heading;
    const updates = { heading: normalizeHeading(current + deltaDeg), alignToTrack: false };
    this.history.recordUpdate(obj, { ...obj, ...updates }, `Rotate ${obj.name}`, `${id}:heading`);
    this.objects.update(id, updates);
    return true;
  }

  /** Deletes an object and records it for Undo. Shared by the panel button and the Delete key. */
  public deleteObjectWithHistory(id: string): boolean {
    const obj = this.objects.getById(id);
    if (!obj) return false;
    this.history.recordDelete(obj, `Delete ${obj.name || obj.type}`);
    this.objects.delete(id);
    this.selection.clearSelection();
    return true;
  }

  public clearSnapPreview() {
    if (!this.viewer) return;
    this.junctionOverlay.clearPreview();
    if (this.snapReticleEntity) {
      this.viewer.entities.remove(this.snapReticleEntity);
      this.snapReticleEntity = null;
    }
    if (this.rubberbandEntity) {
      this.viewer.entities.remove(this.rubberbandEntity);
      this.rubberbandEntity = null;
    }
  }

  private updateSnapPreview(mouseLng: number, mouseLat: number, mouseAlt: number) {
    if (!this.viewer) return;
    const mode = this.editing.getMode();
    if (mode === 'select') {
      this.clearSnapPreview();
      return;
    }

    const snap = this.editing.getSnapManager().findSnap([mouseLng, mouseLat, mouseAlt]);
    this.editing.setActiveSnap(snap.type !== 'none' ? snap : null);

    const activePoint: [number, number, number] = snap.type !== 'none' ? snap.point : [mouseLng, mouseLat, mouseAlt];

    if (mode === 'draw_junction') {
      this.junctionOverlay.preview(activePoint);
      return;
    }
    this.junctionOverlay.clearPreview();

    // 1. Update Snap Reticle Entity
    if (snap.type !== 'none') {
      const reticleColor = snap.type === 'endpoint'
        ? Color.LIME
        : snap.type === 'edge'
          ? Color.GOLD
          : Color.CYAN;

      const position = Cartesian3.fromDegrees(activePoint[0], activePoint[1], (activePoint[2] || 0) + 1.5);

      if (!this.snapReticleEntity) {
        this.snapReticleEntity = this.viewer.entities.add({
          position,
          point: {
            pixelSize: 14,
            color: reticleColor,
            outlineColor: Color.WHITE,
            outlineWidth: 2,
            disableDepthTestDistance: Number.POSITIVE_INFINITY
          },
          label: {
            text: snap.description || 'Snap',
            font: '12px Inter, system-ui, sans-serif',
            style: LabelStyle.FILL_AND_OUTLINE,
            fillColor: Color.WHITE,
            outlineColor: Color.BLACK,
            outlineWidth: 2,
            verticalOrigin: VerticalOrigin.BOTTOM,
            pixelOffset: new Cartesian2(0, -16),
            disableDepthTestDistance: Number.POSITIVE_INFINITY
          }
        });
      } else {
        this.snapReticleEntity.position = position as any;
        if (this.snapReticleEntity.point) {
          this.snapReticleEntity.point.color = reticleColor as any;
        }
        if (this.snapReticleEntity.label) {
          this.snapReticleEntity.label.text = (snap.description || 'Snap') as any;
        }
      }
    } else {
      if (this.snapReticleEntity) {
        this.viewer.entities.remove(this.snapReticleEntity);
        this.snapReticleEntity = null;
      }
    }

    // 2. Update Rubberband Entity if drawing points exist
    const drawingPts = this.editing.getDrawingPoints();
    if (drawingPts.length > 0 && (mode.startsWith('draw_') || mode === 'import_osm')) {
      const lastPt = drawingPts[drawingPts.length - 1];
      const p1 = Cartesian3.fromDegrees(lastPt[0], lastPt[1], lastPt[2] || 0);
      const p2 = Cartesian3.fromDegrees(activePoint[0], activePoint[1], activePoint[2] || 0);

      if (!this.rubberbandEntity) {
        this.rubberbandEntity = this.viewer.entities.add({
          polyline: {
            positions: [p1, p2],
            width: 3,
            material: new PolylineDashMaterialProperty({
              color: Color.YELLOW.withAlpha(0.9),
              dashLength: 12
            }),
            clampToGround: mode === 'draw_road' || mode === 'draw_utility'
          }
        });
      } else {
        if (this.rubberbandEntity.polyline) {
          this.rubberbandEntity.polyline.positions = [p1, p2] as any;
        }
      }
    } else {
      if (this.rubberbandEntity) {
        this.viewer.entities.remove(this.rubberbandEntity);
        this.rubberbandEntity = null;
      }
    }
  }

  private updateDrawPreview() {
    if (!this.viewer) return;

    // Clear previous preview
    if (this.drawPreviewEntity) {
      this.viewer.entities.remove(this.drawPreviewEntity);
      this.drawPreviewEntity = null;
    }

    // Clear previous drawing vertex markers
    this.drawMarkers.forEach(m => this.viewer?.entities.remove(m));
    this.drawMarkers = [];

    const points = this.editing.getDrawingPoints();
    const mode = this.editing.getMode();
    if (points.length === 0 || mode === 'select') return;

    const cartesians = points.map(p => Cartesian3.fromDegrees(p[0], p[1], p[2]));

    // Render temporary markers for each drawing point to make editing clear
    if (mode === 'import_osm') {
      points.forEach((pt, idx) => {
        const marker = this.viewer!.entities.add({
          id: `draw_point_${idx}`,
          position: Cartesian3.fromDegrees(pt[0], pt[1], pt[2]),
          point: {
            pixelSize: 10,
            color: Color.RED,
            outlineWidth: 2,
            outlineColor: Color.WHITE,
            disableDepthTestDistance: Number.POSITIVE_INFINITY
          }
        });
        this.drawMarkers.push(marker);
      });
    }

    if (mode === 'draw_road' || mode === 'draw_utility') {
      this.drawPreviewEntity = this.viewer.entities.add({
        polyline: {
          positions: cartesians,
          width: 5,
          material: Color.YELLOW.withAlpha(0.7),
          clampToGround: true
        }
      });
    } else if (mode === 'draw_building') {
      if (points.length < 3) {
        this.drawPreviewEntity = this.viewer.entities.add({
          polyline: {
            positions: cartesians,
            width: 3,
            material: Color.YELLOW.withAlpha(0.6),
            clampToGround: true
          }
        });
      } else {
        this.drawPreviewEntity = this.viewer.entities.add({
          polygon: {
            hierarchy: cartesians,
            material: Color.YELLOW.withAlpha(0.3),
            outline: true,
            outlineColor: Color.YELLOW,
            height: 0,
            extrudedHeight: 15
          }
        });
      }
    } else if (mode === 'import_osm') {
      if (points.length < 3) {
        this.drawPreviewEntity = this.viewer.entities.add({
          polyline: {
            positions: cartesians,
            width: 3,
            material: Color.YELLOW.withAlpha(0.6),
            clampToGround: true
          }
        });
      } else {
        this.drawPreviewEntity = this.viewer.entities.add({
          polygon: {
            hierarchy: cartesians,
            material: Color.YELLOW.withAlpha(0.3),
            outline: true,
            outlineColor: Color.YELLOW,
            height: 0
          }
        });
      }
    } else if (mode === 'draw_junction') {
      this.drawPreviewEntity = this.viewer.entities.add({
        position: cartesians[0],
        point: {
          pixelSize: 15,
          color: Color.YELLOW,
          outlineWidth: 2,
          outlineColor: Color.BLACK
        }
      });
    } else if (mode === 'draw_zone') {
      if (points.length < 3) {
        this.drawPreviewEntity = this.viewer.entities.add({
          polyline: {
            positions: cartesians,
            width: 3,
            material: Color.fromCssColorString('#f43f5e').withAlpha(0.6),
            clampToGround: true
          }
        });
      } else {
        this.drawPreviewEntity = this.viewer.entities.add({
          polygon: {
            hierarchy: cartesians,
            material: Color.fromCssColorString('#f43f5e').withAlpha(0.2),
            outline: true,
            outlineColor: Color.fromCssColorString('#f43f5e'),
            height: 0
          }
        });
      }
    } else if (mode === 'draw_gateway') {
      this.drawPreviewEntity = this.viewer.entities.add({
        position: cartesians[0],
        point: {
          pixelSize: 15,
          color: Color.fromCssColorString('#eab308'),
          outlineWidth: 2,
          outlineColor: Color.BLACK
        }
      });
    }
  }

  private syncSavedAreasWithCesium() {
    if (!this.viewer) return;

    this.areaEntities.forEach(ent => this.viewer?.entities.remove(ent));
    this.areaEntities = [];

    const areas = this.editing.getSavedAreas();
    const selections = this.selection.getSelection();

    areas.forEach(area => {
      const isSelected = selections.includes(area.id);
      const pts = area.polygonCoordinates.map(c => Cartesian3.fromDegrees(c[0], c[1], c[2]));

      const entity = this.viewer!.entities.add({
        id: area.id,
        name: area.name,
        polygon: {
          hierarchy: pts,
          material: isSelected
            ? Color.fromCssColorString('#0284c7').withAlpha(0.3)
            : Color.fromCssColorString('#0284c7').withAlpha(0.12),
          outline: true,
          outlineColor: isSelected ? Color.CYAN : Color.fromCssColorString('#0284c7'),
          outlineWidth: isSelected ? 4.0 : 2.0
        }
      });
      this.areaEntities.push(entity);
    });
  }

  public isPlanningModeActive(): boolean {
    return this.isPlanningMode;
  }

  public setPlanningModeActive(val: boolean): void {
    this.isPlanningMode = val;
    this.editing.setMode('select');
    this.selection.clearSelection();
    this.syncZonesAndGatewaysWithCesium();
    this.objects.notify();
    this.emitMode();
  }

  private syncZonesAndGatewaysWithCesium() {
    if (!this.viewer) return;

    // 1. Clear previous zone/gateway entities
    this.zoneEntities.forEach(ent => this.viewer?.entities.remove(ent));
    this.zoneEntities = [];

    this.gatewayEntities.forEach(ent => this.viewer?.entities.remove(ent));
    this.gatewayEntities = [];

    this.editZoneMarkers.forEach(m => this.viewer?.entities.remove(m));
    this.editZoneMarkers = [];

    const filtered = this.getFilteredObjects();
    const selections = this.selection.getSelection();
    const selectedId = selections[0];
    const selectedObj = selectedId ? this.objects.getById(selectedId) : null;
    this.junctionOverlay.sync(filtered, this.isPlanningMode && this.layers.isVisible('junctions'), selectedId);

    // 2. Render Zones if layer is visible
    if (this.layers.isVisible('demand_zones')) {
      const zoneOpacity = this.layers.getOpacity('demand_zones');
      const zones = filtered.filter(o => o.type === 'zone') as ZoneObject[];
      zones.forEach(zone => {
        const isSelected = selections.includes(zone.id);
        const pts = zone.coordinates.map(c => Cartesian3.fromDegrees(c[0], c[1], c[2] || 0.5));

        const entity = this.viewer!.entities.add({
          id: zone.id,
          name: zone.name,
          polygon: {
            hierarchy: pts,
            material: Color.fromCssColorString('#f43f5e').withAlpha((isSelected ? 0.25 : 0.08) * zoneOpacity),
            outline: true,
            outlineColor: (isSelected ? Color.CYAN : Color.fromCssColorString('#f43f5e')).withAlpha(zoneOpacity),
            outlineWidth: isSelected ? 4.0 : 2.0,
            classificationType: ClassificationType.BOTH
          },
          label: {
            text: zone.name,
            font: '14px Outfit, Inter, sans-serif',
            fillColor: Color.WHITE,
            outlineColor: Color.BLACK,
            outlineWidth: 3,
            style: LabelStyle.FILL_AND_OUTLINE,
            heightReference: HeightReference.CLAMP_TO_GROUND,
            horizontalOrigin: HorizontalOrigin.CENTER,
            verticalOrigin: VerticalOrigin.BOTTOM,
            disableDepthTestDistance: Number.POSITIVE_INFINITY
          },
          position: Cartesian3.fromDegrees(
            zone.coordinates.reduce((sum, c) => sum + c[0], 0) / zone.coordinates.length,
            zone.coordinates.reduce((sum, c) => sum + c[1], 0) / zone.coordinates.length,
            2.0
          )
        });
        this.zoneEntities.push(entity);
      });
    }

    // 3. Render Gateways if layer is visible
    if (this.layers.isVisible('gateways')) {
      const gatewayOpacity = this.layers.getOpacity('gateways');
      const gateways = filtered.filter(o => o.type === 'gateway') as GatewayObject[];
      gateways.forEach(gw => {
        const isSelected = selections.includes(gw.id);
        const coord = (gw.coordinates && gw.coordinates[0]) || [0, 0, 0];
        const pos = Cartesian3.fromDegrees(coord[0], coord[1], coord[2] || 1.0);

        const entity = this.viewer!.entities.add({
          id: gw.id,
          name: gw.name,
          position: pos,
          point: {
            pixelSize: isSelected ? 18 : 12,
            color: (isSelected ? Color.CYAN : Color.fromCssColorString('#eab308')).withAlpha(gatewayOpacity),
            outlineWidth: 3,
            outlineColor: Color.BLACK,
            disableDepthTestDistance: Number.POSITIVE_INFINITY
          },
          label: {
            text: `◆ ${gw.name}\n(Access Node: ${gw.connectedNodeId ? 'Connected' : 'Disconnected'})`,
            font: '12px Outfit, Inter, sans-serif',
            fillColor: Color.WHITE,
            outlineColor: Color.BLACK,
            outlineWidth: 3,
            style: LabelStyle.FILL_AND_OUTLINE,
            pixelOffset: new Cartesian2(0, -25),
            horizontalOrigin: HorizontalOrigin.CENTER,
            verticalOrigin: VerticalOrigin.BOTTOM,
            disableDepthTestDistance: Number.POSITIVE_INFINITY
          }
        });

        // Visual polyline connecting gateway to its connectedNodeId
        if (gw.connectedNodeId && this.trafficNetwork) {
          const node = this.trafficNetwork.nodes.get(gw.connectedNodeId);
          if (node) {
            const nodePos = Cartesian3.fromDegrees(node.coordinates[0], node.coordinates[1], node.coordinates[2] || 1.0);
            const lineEntity = this.viewer!.entities.add({
              polyline: {
                positions: [pos, nodePos],
                width: 3,
                material: new PolylineDashMaterialProperty({
                  color: Color.CYAN,
                  dashLength: 16
                }),
                clampToGround: true
              }
            });
            this.gatewayEntities.push(lineEntity);
          }
        }

        this.gatewayEntities.push(entity);
      });
    }

    // 4. In Planning Mode, draw cyan vertex point markers if a zone is selected
    if (selectedObj && selectedObj.type === 'zone' && this.isPlanningMode) {
      selectedObj.coordinates.forEach((pt, idx) => {
        // Skip duplicate last point in closed loop to avoid double markers
        if (idx === selectedObj.coordinates.length - 1 && idx > 0) return;

        const marker = this.viewer!.entities.add({
          id: `edit_zone_point_${selectedObj.id}_${idx}`,
          position: Cartesian3.fromDegrees(pt[0], pt[1], pt[2] || 0.5),
          point: {
            pixelSize: 10,
            color: Color.CYAN,
            outlineWidth: 2,
            outlineColor: Color.BLACK,
            disableDepthTestDistance: Number.POSITIVE_INFINITY
          }
        });
        this.editZoneMarkers.push(marker);
      });
    }
  }

  private async loadSampleData() {
    try {
      console.log('[STARTUP] Object fetch START');
      const data = await apiGet<any[]>('/api/objects');
      console.log('[STARTUP] Object fetch END');

      if (data && data.length > 0) {
        console.log(`Loaded ${data.length} objects from FastAPI database.`);
        console.log('[STARTUP] ObjectManager load START');
        this.objects.clear();
        let hasBuildings = false;
        let hasZones = false;

        data.forEach((obj: any) => {
          if (obj.type === 'building') hasBuildings = true;
          if (obj.type === 'zone') hasZones = true;
          const unpacked = {
            id: obj.id,
            type: obj.type as any,
            name: obj.name,
            layerId: obj.layerId,
            scenarioId: obj.scenarioId,
            coordinates: obj.coordinates,
            createdAt: new Date().toISOString(),
            updatedAt: new Date().toISOString(),
            ...obj.properties
          };
          if (unpacked.type === 'road') {
            this.objects.syncRoadProperties(unpacked as any);
          }
          (this.objects as any).objects.set(unpacked.id, unpacked);
        });

        this.objects.liftBridges();
        console.log('[STARTUP] ObjectManager load END');

        if (!hasBuildings || !hasZones) {
          console.log('Database missing buildings or zones. Seeding realistic Pune/Hinjewadi demand...');
          this.seedPuneHinjewadiDemand();
        }

        this.objects.notify();
        return;
      } else {
        console.log('FastAPI database is connected but empty. Seeding defaults...');
      }
    } catch (e) {
      console.warn('Backend database offline or unreachable. Running in local memory-only mode:', e);
    }


    const baseLng = 73.8567;
    const baseLat = 18.5204;

    this.objects.add({
      id: 'b1',
      type: 'building',
      name: 'TwinTowers Block A',
      layerId: 'buildings',
      scenarioId: 'base',
      coordinates: [
        [baseLng - 0.002, baseLat - 0.002, 0],
        [baseLng - 0.001, baseLat - 0.002, 0],
        [baseLng - 0.001, baseLat - 0.001, 0],
        [baseLng - 0.002, baseLat - 0.001, 0],
        [baseLng - 0.002, baseLat - 0.002, 0]
      ],
      usageType: 'residential',
      height: 45,
      floors: 15,
      population: 240,
      parkingSpaces: 80,
      waterDemand: 36000,
      electricityDemand: 1440,
      constructionYear: 2018,
      createdAt: new Date().toISOString(),
      updatedAt: new Date().toISOString()
    });

    this.objects.add({
      id: 'b2',
      type: 'building',
      name: 'Cyber IT Park',
      layerId: 'buildings',
      scenarioId: 'base',
      coordinates: [
        [baseLng + 0.001, baseLat - 0.002, 0],
        [baseLng + 0.003, baseLat - 0.002, 0],
        [baseLng + 0.003, baseLat - 0.0005, 0],
        [baseLng + 0.001, baseLat - 0.0005, 0],
        [baseLng + 0.001, baseLat - 0.002, 0]
      ],
      usageType: 'commercial',
      height: 30,
      floors: 8,
      population: 800,
      parkingSpaces: 300,
      waterDemand: 48000,
      electricityDemand: 4800,
      constructionYear: 2021,
      createdAt: new Date().toISOString(),
      updatedAt: new Date().toISOString()
    });

    this.objects.add({
      id: 'r1',
      type: 'road',
      name: 'Pune Central Boulevard',
      layerId: 'roads',
      scenarioId: 'base',
      coordinates: [
        [baseLng - 0.005, baseLat, 0],
        [baseLng + 0.005, baseLat, 0]
      ],
      roadClass: 'arterial',
      width: 19,
      laneCount: 4,
      laneWidth: 3.5,
      hasDivider: true,
      dividerWidth: 2.0,
      hasFootpath: true,
      footpathWidth: 1.5,
      speedLimit: 60,
      isOneWay: false,
      trafficCapacity: 2400,
      connectedJunctions: ['j1'],
      createdAt: new Date().toISOString(),
      updatedAt: new Date().toISOString()
    });

    this.objects.add({
      id: 'r2',
      type: 'road',
      name: 'Tech Corridor Lane',
      layerId: 'roads',
      scenarioId: 'base',
      coordinates: [
        [baseLng, baseLat, 0],
        [baseLng, baseLat - 0.003, 0]
      ],
      roadClass: 'local',
      width: 10,
      laneCount: 2,
      laneWidth: 3.5,
      hasDivider: false,
      dividerWidth: 0.0,
      hasFootpath: true,
      footpathWidth: 1.5,
      speedLimit: 40,
      isOneWay: false,
      trafficCapacity: 1000,
      connectedJunctions: ['j1'],
      createdAt: new Date().toISOString(),
      updatedAt: new Date().toISOString()
    });

    this.objects.add({
      id: 'j1',
      type: 'junction',
      name: 'Boulevard Intersection',
      layerId: 'junctions',
      scenarioId: 'base',
      coordinates: [baseLng, baseLat, 0],
      connectedRoads: ['r1', 'r2'],
      hasSignals: true,
      signalTiming: 120,
      hasPedestrianCrossing: true,
      createdAt: new Date().toISOString(),
      updatedAt: new Date().toISOString()
    });

    this.seedPuneHinjewadiDemand();
  }

  public getTrafficNetwork() {
    return this.trafficNetwork;
  }

  /** Asks for the city-wide traffic graph; it is built in the background and kept up to date from then on. */
  public requestTrafficNetwork() {
    if (this.cityNetworkWanted) return;
    this.cityNetworkWanted = true;
    this.queueTrafficRebuild();
  }

  public getViewer(): any {
    return this.viewer;
  }

  private setupWorkerListener() {
    if (!this.trafficWorker) return;
    this.trafficWorker.onmessage = (e: MessageEvent) => {
      const { requestId, status, result, error } = e.data;
      if (requestId !== this.activeRequestId) {
        // Discard stale results from previous requests
        return;
      }

      if (status === 'success') {
        if (result.network) {
          // Rehydrate network Maps
          this.trafficNetwork = {
            nodes: new Map(result.network.nodes),
            edges: new Map(result.network.edges)
          };
          this.syncTrafficNetworkVisualization();
        }

        if (result.matrix) {
          this.trafficDemandMatrix = result.matrix;
        }

        // Apply snaps quietly in memory to avoid onChange loops
        if (result.gatewaySnaps) {
          result.gatewaySnaps.forEach((snap: any) => {
            const gwObj = this.objects.getById(snap.id) as any;
            if (gwObj) {
              gwObj.connectedNodeId = snap.connectedNodeId;
            }
          });
          this.syncZonesAndGatewaysWithCesium();
        }

        if (result.buildingSnaps) {
          result.buildingSnaps.forEach((snap: any) => {
            const bObj = this.objects.getById(snap.id) as any;
            if (bObj) {
              bObj.nearestEdgeId = snap.nearestEdgeId;
              bObj.accessNodeId = snap.accessNodeId;
            }
          });
        }

        console.log('[TRAFFIC WORKER] Rebuild completed successfully.');
        if (result.diagnostics) {
          console.log(result.diagnostics);
        }
      } else {
        console.error('[TRAFFIC WORKER] Error in background calculation:', error);
      }
    };
  }

  private triggerWorkerRebuild(rebuildNetwork: boolean) {
    if (!this.trafficWorker) {
      console.warn('Traffic Web Worker not available.');
      return;
    }

    this.activeRequestId++;
    const requestId = this.activeRequestId;

    const roads = this.objects.getAll().filter(o => o.type === 'road' || o.type === 'flyover' || o.type === 'metro_flyover') as RoadObject[];
    const buildings = this.objects.getAll().filter(o => o.type === 'building') as BuildingObject[];
    const zones = this.objects.getAll().filter(o => o.type === 'zone') as ZoneObject[];
    const gateways = this.objects.getAll().filter(o => o.type === 'gateway') as GatewayObject[];

    const demandZones = zones.map(z => ({
      id: z.id,
      name: z.name,
      boundaryPolygon: z.coordinates,
      totalPopulation: z.totalPopulation || 0,
      totalEmployment: z.totalEmployment || 0,
      landUseMix: z.landUseMix || { residential: 50, commercial: 30, industrial: 10, educational: 10 },
      gateways: z.gateways || [],
      provenance: z.provenance || {
        source: 'estimated' as const,
        confidence: 0.7,
        updatedAt: new Date().toISOString()
      }
    }));

    const externalGateways = gateways.map(g => ({
      id: g.id,
      name: g.name,
      coordinates: (g.coordinates && g.coordinates[0]) || [0, 0, 0],
      connectedNodeId: g.connectedNodeId || '',
      inboundFlows: (g.inboundFlows as any) || { AM_Peak: 0, PM_Peak: 0, Midday: 0, Night: 0 },
      outboundFlows: (g.outboundFlows as any) || { AM_Peak: 0, PM_Peak: 0, Midday: 0, Night: 0 },
      modeSplit: g.modeSplit || { car: 0.25, twoWheeler: 0.35, bus: 0.2, metro: 0.1, walking: 0.08, other: 0.02 },
      provenance: g.provenance || {
        source: 'estimated' as const,
        confidence: 0.7,
        updatedAt: new Date().toISOString()
      }
    }));

    const scenarioId = this.scenarios.getActiveScenarioId();

    if (rebuildNetwork || !this.trafficNetwork) {
      console.log('[TRAFFIC WORKER] Posting full rebuild request', requestId);
      this.trafficWorker.postMessage({
        requestId,
        action: 'rebuild_network_and_demand',
        data: { roads, buildings, zones: demandZones, gateways: externalGateways, scenarioId }
      });
    } else {
      console.log('[TRAFFIC WORKER] Posting demand-only rebuild request', requestId);
      const serializedNetwork = {
        nodes: Array.from(this.trafficNetwork.nodes.entries()),
        edges: Array.from(this.trafficNetwork.edges.entries())
      };
      this.trafficWorker.postMessage({
        requestId,
        action: 'rebuild_demand_only',
        data: { network: serializedNetwork, roads, buildings, zones: demandZones, gateways: externalGateways, scenarioId }
      });
    }
  }

  private syncTrafficNetworkVisualization() {
    const isVisible = this.layers.isVisible('traffic_network_debug');
    if (isVisible && this.trafficNetwork) {
      this.trafficVisualizer.render(this.trafficNetwork);
    } else {
      this.trafficVisualizer.clear();
    }
  }

  private queueTrafficRebuild() {
    if (!this.cityNetworkWanted) return;
    if (this.demandRebuildTimeout) {
      clearTimeout(this.demandRebuildTimeout);
      this.demandRebuildTimeout = null;
    }
    if (this.rebuildTimeout) {
      clearTimeout(this.rebuildTimeout);
    }
    this.rebuildTimeout = setTimeout(() => {
      this.triggerWorkerRebuild(true);
      this.rebuildTimeout = null;
    }, 300);
  }

  private queueTrafficDemandRebuildOnly() {
    if (!this.cityNetworkWanted || this.rebuildTimeout) return;
    if (this.demandRebuildTimeout) {
      clearTimeout(this.demandRebuildTimeout);
    }
    this.demandRebuildTimeout = setTimeout(() => {
      this.triggerWorkerRebuild(false);
      this.demandRebuildTimeout = null;
    }, 300);
  }

  private seedPuneHinjewadiDemand() {
    // 1. Seed Zones
    const zonesData = [
      { id: 'zone_wakad', name: 'Wakad', pop: 85000, emp: 15000, mix: { residential: 65, commercial: 25, industrial: 5, educational: 5 }, poly: [[73.745, 18.590, 0], [73.765, 18.590, 0], [73.765, 18.608, 0], [73.745, 18.608, 0], [73.745, 18.590, 0]], gateways: ['g_wakad'] },
      { id: 'zone_hinjewadi_p1', name: 'Hinjewadi Phase 1', pop: 30000, emp: 120000, mix: { residential: 20, commercial: 75, industrial: 0, educational: 5 }, poly: [[73.725, 18.580, 0], [73.745, 18.580, 0], [73.745, 18.595, 0], [73.725, 18.595, 0], [73.725, 18.580, 0]], gateways: [] },
      { id: 'zone_hinjewadi_p2', name: 'Hinjewadi Phase 2', pop: 15000, emp: 90000, mix: { residential: 10, commercial: 85, industrial: 5, educational: 0 }, poly: [[73.700, 18.572, 0], [73.720, 18.572, 0], [73.720, 18.590, 0], [73.700, 18.590, 0], [73.700, 18.572, 0]], gateways: [] },
      { id: 'zone_hinjewadi_p3', name: 'Hinjewadi Phase 3', pop: 8000, emp: 50000, mix: { residential: 5, commercial: 90, industrial: 5, educational: 0 }, poly: [[73.670, 18.563, 0], [73.695, 18.563, 0], [73.695, 18.582, 0], [73.670, 18.582, 0], [73.670, 18.563, 0]], gateways: [] },
      { id: 'zone_baner', name: 'Baner', pop: 60000, emp: 25000, mix: { residential: 60, commercial: 30, industrial: 0, educational: 10 }, poly: [[73.768, 18.542, 0], [73.792, 18.542, 0], [73.792, 18.562, 0], [73.768, 18.562, 0], [73.768, 18.542, 0]], gateways: ['g_nh48_south', 'g_baner_east'] },
      { id: 'zone_balewadi', name: 'Balewadi', pop: 45000, emp: 18000, mix: { residential: 65, commercial: 25, industrial: 0, educational: 10 }, poly: [[73.758, 18.562, 0], [73.785, 18.562, 0], [73.785, 18.582, 0], [73.758, 18.582, 0], [73.758, 18.562, 0]], gateways: ['g_balewadi_stadium'] },
      { id: 'zone_aundh', name: 'Aundh', pop: 70000, emp: 30000, mix: { residential: 55, commercial: 35, industrial: 0, educational: 10 }, poly: [[73.790, 18.562, 0], [73.815, 18.562, 0], [73.815, 18.582, 0], [73.790, 18.582, 0], [73.790, 18.562, 0]], gateways: [] },
      { id: 'zone_pcmc', name: 'PCMC External', pop: 110000, emp: 80000, mix: { residential: 45, commercial: 30, industrial: 20, educational: 5 }, poly: [[73.742, 18.608, 0], [73.778, 18.608, 0], [73.778, 18.630, 0], [73.742, 18.630, 0], [73.742, 18.608, 0]], gateways: ['g_pcmc_north'] }
    ];

    zonesData.forEach(z => {
      this.objects.add({
        id: z.id,
        type: 'zone',
        name: z.name,
        layerId: 'demand_zones',
        scenarioId: 'base',
        coordinates: z.poly as [number, number, number][],
        totalPopulation: z.pop,
        totalEmployment: z.emp,
        landUseMix: z.mix,
        gateways: z.gateways,
        provenance: {
          source: 'estimated',
          confidence: 0.75,
          updatedAt: new Date().toISOString()
        },
        createdAt: new Date().toISOString(),
        updatedAt: new Date().toISOString()
      });
    });

    // 2. Seed Gateways
    const gatewaysData = [
      { id: 'g_wakad', name: 'Wakad NH48 Gateway', coords: [73.765, 18.605, 0] },
      { id: 'g_nh48_south', name: 'NH48 Highway Gateway (South)', coords: [73.766, 18.548, 0] },
      { id: 'g_baner_east', name: 'Baner Road East Gateway', coords: [73.785, 18.552, 0] },
      { id: 'g_balewadi_stadium', name: 'Balewadi Stadium Road Gateway', coords: [73.775, 18.568, 0] },
      { id: 'g_pcmc_north', name: 'PCMC Road Gateway (North)', coords: [73.755, 18.618, 0] }
    ];

    gatewaysData.forEach(g => {
      this.objects.add({
        id: g.id,
        type: 'gateway',
        name: g.name,
        layerId: 'gateways',
        scenarioId: 'base',
        coordinates: [g.coords as [number, number, number]],
        connectedNodeId: '',
        inboundFlows: { AM_Peak: 600, PM_Peak: 300, Midday: 250, Night: 80 },
        outboundFlows: { AM_Peak: 300, PM_Peak: 600, Midday: 250, Night: 80 },
        modeSplit: { car: 0.35, twoWheeler: 0.45, bus: 0.15, metro: 0.0, walking: 0.0, other: 0.05 },
        provenance: {
          source: 'estimated',
          confidence: 0.8,
          updatedAt: new Date().toISOString()
        },
        createdAt: new Date().toISOString(),
        updatedAt: new Date().toISOString()
      });
    });

    // 3. Seed Buildings inside Hinjewadi
    const buildingsData = [
      { id: 'b_it_infosys', name: 'Infosys Hinjawadi Campus', cat: 'office', usage: 'commercial', pop: 0, emp: 2500, ht: 40, fl: 10, center: [73.735, 18.587] },
      { id: 'b_it_wipro', name: 'Wipro Phase 1 Tech Center', cat: 'office', usage: 'commercial', pop: 0, emp: 1800, ht: 35, fl: 8, center: [73.732, 18.588] },
      { id: 'b_it_tcs', name: 'TCS Sahyadri Park', cat: 'office', usage: 'commercial', pop: 0, emp: 4000, ht: 50, fl: 12, center: [73.682, 18.573] },
      { id: 'b_it_cognizant', name: 'Cognizant Phase 2 Campus', cat: 'office', usage: 'commercial', pop: 0, emp: 2000, ht: 30, fl: 7, center: [73.715, 18.578] },
      { id: 'b_res_blueridge', name: 'Blue Ridge Apartments Block A', cat: 'residential', usage: 'residential', pop: 1200, emp: 50, ht: 60, fl: 18, center: [73.739, 18.590] },
      { id: 'b_res_megapolis', name: 'Megapolis Splendour Complex', cat: 'residential', usage: 'residential', pop: 1500, emp: 40, ht: 55, fl: 16, center: [73.673, 18.575] },
      { id: 'b_res_liferepublic', name: 'Life Republic Residential Tower', cat: 'residential', usage: 'residential', pop: 900, emp: 30, ht: 55, fl: 16, center: [73.718, 18.604] },
      { id: 'b_ret_grandmall', name: 'Grand High Street Mall', cat: 'retail', usage: 'commercial', pop: 0, emp: 300, ht: 15, fl: 3, center: [73.738, 18.592] },
      { id: 'b_ret_dmart', name: 'Hinjawadi D-Mart', cat: 'retail', usage: 'commercial', pop: 0, emp: 150, ht: 10, fl: 2, center: [73.745, 18.593] },
      { id: 'b_it_techm', name: 'Tech Mahindra Phase 3 Office', cat: 'office', usage: 'commercial', pop: 0, emp: 1800, ht: 40, fl: 10, center: [73.686, 18.571] },
      { id: 'b_ret_xion', name: 'Xion Mall Hinjawadi', cat: 'retail', usage: 'commercial', pop: 0, emp: 250, ht: 15, fl: 3, center: [73.751, 18.592] },
      { id: 'b_it_quadron', name: 'Quadron Business Park', cat: 'office', usage: 'commercial', pop: 0, emp: 3000, ht: 45, fl: 11, center: [73.703, 18.578] },
      { id: 'b_edu_school', name: 'Blue Ridge Public School', cat: 'school', usage: 'commercial', pop: 0, emp: 80, ht: 15, fl: 3, center: [73.742, 18.589] },
      { id: 'b_hosp_hinj', name: 'Hinjawadi Lifecare Hospital', cat: 'hospital', usage: 'commercial', pop: 0, emp: 120, ht: 25, fl: 5, center: [73.741, 18.591] }
    ];

    buildingsData.forEach(b => {
      const c = b.center;
      const footprint = [
        [c[0] - 0.0003, c[1] - 0.0003, 0],
        [c[0] + 0.0003, c[1] - 0.0003, 0],
        [c[0] + 0.0003, c[1] + 0.0003, 0],
        [c[0] - 0.0003, c[1] + 0.0003, 0],
        [c[0] - 0.0003, c[1] - 0.0003, 0]
      ] as [number, number, number][];

      this.objects.add({
        id: b.id,
        type: 'building',
        name: b.name,
        layerId: 'buildings',
        scenarioId: 'base',
        coordinates: footprint,
        usageType: b.usage as any,
        height: b.ht,
        floors: b.fl,
        population: b.pop || 0,
        parkingSpaces: Math.round(b.emp * 0.15 + b.pop * 0.2),
        waterDemand: (b.pop * 150) || (b.emp * 45),
        electricityDemand: (b.pop * 6) || (b.emp * 12),
        constructionYear: 2019,
        category: b.cat as any,
        state: 'existing',
        residents: b.pop || undefined,
        employees: b.emp || undefined,
        visitorsPerDay: b.cat === 'retail' ? 1000 : 50,
        source: 'surveyed',
        isManuallyEdited: false,
        activityProfile: {
          peakArrivalStart: b.cat === 'office' ? '08:30' : b.cat === 'retail' ? '12:00' : '17:30',
          peakArrivalEnd: b.cat === 'office' ? '10:00' : b.cat === 'retail' ? '14:00' : '19:30',
          peakDepartureStart: b.cat === 'office' ? '17:30' : b.cat === 'retail' ? '20:00' : '08:30',
          peakDepartureEnd: b.cat === 'office' ? '19:30' : b.cat === 'retail' ? '21:30' : '10:00',
          modeSplit: {
            car: 30,
            twoWheeler: 40,
            bus: 15,
            metro: 0,
            walk: 10,
            other: 5
          }
        },
        accessPoints: {
          vehicleEntrance: c as [number, number, number]
        },
        createdAt: new Date().toISOString(),
        updatedAt: new Date().toISOString()
      });
    });
  }
}

export const engineInstance = new TwinCityEngine();
export default engineInstance;

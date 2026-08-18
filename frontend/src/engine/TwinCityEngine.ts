import { 
  Viewer, 
  Entity, 
  Cartesian3, 
  Cartesian2,
  Color, 
  ScreenSpaceEventHandler, 
  ScreenSpaceEventType, 
  Cartographic, 
  Math as CesiumMath,
  defined,
  ClassificationType,
  LabelStyle,
  HorizontalOrigin,
  VerticalOrigin,
  HeightReference,
  PolylineDashMaterialProperty
} from 'cesium';
import { ObjectManager } from './objects/ObjectManager';
import type { CityObject, RoadObject, ZoneObject, GatewayObject, BuildingObject } from './objects/types';
import { renderManagerInstance } from './rendering/RenderManager';
import { TrafficNetworkVisualizer } from './rendering/renderers/TrafficNetworkVisualizer';
import { LODController } from './rendering/lod/LODController';
import { SelectionEngine } from './selection/SelectionEngine';
import { LayerManager } from './layers/LayerManager';
import { ScenarioManager } from './scenarios/ScenarioManager';
import { SimulationManager } from './simulation/SimulationManager';
import { HistoryManager } from './history/HistoryManager';
import { EditingEngine } from './editing/EditingEngine';
import { runProgressivePerformanceTest, runRoadPerformanceTest } from './testing/PerformanceTester';

export class TwinCityEngine {
  public objects: ObjectManager;
  public selection: SelectionEngine;
  public layers: LayerManager;
  public scenarios: ScenarioManager;
  public simulations: SimulationManager;
  public history: HistoryManager;
  public editing: EditingEngine;
  public trafficNetwork: any = null;
  public trafficDemandMatrix: any = null;
  private trafficVisualizer = new TrafficNetworkVisualizer();

  private viewer: Viewer | null = null;
  private drawPreviewEntity: Entity | null = null;
  private drawMarkers: Entity[] = [];
  private areaEntities: Entity[] = [];
  private draggingPointIdx: number | null = null;
  private zoneEntities: Entity[] = [];
  private gatewayEntities: Entity[] = [];
  private editZoneMarkers: Entity[] = [];
  private draggingZonePointIdx: number | null = null;
  private isPlanningMode = false;

  private rebuildTimeout: any = null;
  private demandRebuildTimeout: any = null;
  private trafficWorker: Worker | null = null;
  private activeRequestId = 0;

  constructor() {
    console.log('[STARTUP] BEGIN');
    this.objects = new ObjectManager();
    this.selection = new SelectionEngine();
    this.layers = new LayerManager();
    this.scenarios = new ScenarioManager();
    this.simulations = new SimulationManager();
    this.history = new HistoryManager();
    this.editing = new EditingEngine(this.objects, this.history, () => this.getTrafficNetwork());

    (window as any).engineInstance = this;

    // Initialize Web Worker for traffic calculations
    try {
      this.trafficWorker = new Worker(new URL('./simulation/traffic.worker.ts', import.meta.url), { type: 'module' });
      this.setupWorkerListener();
    } catch (err) {
      console.error('Failed to initialize traffic Web Worker:', err);
    }

    this.objects.onChange((changedTypes: Set<string>) => {
      if (changedTypes.has('road') || changedTypes.has('junction') || changedTypes.has('flyover') || changedTypes.has('metro_flyover') || changedTypes.size === 0) {
        this.queueTrafficRebuild();
      } else {
        this.queueTrafficDemandRebuildOnly();
      }
      renderManagerInstance.reconcile(this.getFilteredObjects());
      this.syncZonesAndGatewaysWithCesium();
    });
    this.layers.onChange(() => {
      this.syncTrafficNetworkVisualization();
      renderManagerInstance.reconcile(this.getFilteredObjects());
      this.syncZonesAndGatewaysWithCesium();
    });
    this.scenarios.onChange(() => {
      this.selection.clearSelection();
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
    });

    // Real-time FPS Monitor Loop
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
      requestAnimationFrame(tick);
    };
    requestAnimationFrame(tick);

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
    const scenarioFiltered = all.filter(obj => {
      const isBaseObj = obj.scenarioId === 'base';
      const isScenarioObj = obj.scenarioId === activeScenarioId;
      if (!isBaseObj && !isScenarioObj) return false;
      
      if (isBaseObj && activeScenarioId !== 'base') {
        const overrideExists = all.some(o => o.id === obj.id && o.scenarioId === activeScenarioId);
        if (overrideExists) return false;
      }
      return true;
    });

    // 2. Filter by layer visibility
    return scenarioFiltered.filter(obj => {
      let mappedLayerId = obj.layerId;
      if (mappedLayerId === 'transit') {
        mappedLayerId = 'metro';
      } else if (mappedLayerId === 'fiber_util') {
        mappedLayerId = 'electric_util';
      }
      
      const layer = this.layers.getAll().find(l => l.id === mappedLayerId);
      if (layer) {
        return layer.visible;
      }
      return true;
    });
  }

  public setViewer(viewer: Viewer) {
    this.viewer = viewer;
    this.trafficVisualizer.setViewer(viewer);
    renderManagerInstance.initialize(viewer);

    // Listen for the first frame render
    viewer.scene.postRender.addEventListener(function onPostRender() {
      console.log('[STARTUP] First Cesium render');
      viewer.scene.postRender.removeEventListener(onPostRender);
    });
    
    const lod = new LODController(viewer);
    lod.initCameraListeners();

    this.setupInteraction();
    this.loadSampleData();
    
    // Initial sync
    renderManagerInstance.reconcile(this.getFilteredObjects());
    this.syncSavedAreasWithCesium();
    this.syncZonesAndGatewaysWithCesium();
  }

  public getPrimitivesCount(): number {
    return this.viewer ? this.viewer.scene.primitives.length : 0;
  }

  private setupInteraction() {
    if (!this.viewer) return;

    const handler = new ScreenSpaceEventHandler(this.viewer.scene.canvas);

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

    // 2. MOUSE_MOVE: Shifting the coordinates of the dragged marker
    handler.setInputAction((movement: { endPosition: Cartesian2 }) => {
      if (!this.viewer) return;
      if (this.draggingPointIdx === null && this.draggingZonePointIdx === null) return;

      const ray = this.viewer.camera.getPickRay(movement.endPosition);
      if (!ray) return;
      const position = this.viewer.scene.globe.pick(ray, this.viewer.scene);

      if (position) {
        const cartographic = Cartographic.fromCartesian(position);
        const lng = CesiumMath.toDegrees(cartographic.longitude);
        const lat = CesiumMath.toDegrees(cartographic.latitude);
        const alt = cartographic.height;

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
            const newCoords = [...selectedObj.coordinates];
            newCoords[this.draggingZonePointIdx] = [lng, lat, alt];
            
            // If it's the start point, also update the end point to close the ring
            if (this.draggingZonePointIdx === 0) {
              newCoords[newCoords.length - 1] = [lng, lat, alt];
            } else if (this.draggingZonePointIdx === newCoords.length - 1) {
              newCoords[0] = [lng, lat, alt];
            }

            this.objects.update(selectedObj.id, { coordinates: newCoords });
          }
        }
      }
    }, ScreenSpaceEventType.MOUSE_MOVE);

    // 3. LEFT_UP: Release drag action
    handler.setInputAction(() => {
      if (this.draggingPointIdx !== null || this.draggingZonePointIdx !== null) {
        this.draggingPointIdx = null;
        this.draggingZonePointIdx = null;
        if (this.viewer) {
          this.viewer.scene.screenSpaceCameraController.enableRotate = true;
        }
      }
    }, ScreenSpaceEventType.LEFT_UP);

    // 4. LEFT_CLICK: Place point, select area/object, click vertex to delete
    handler.setInputAction((click: { position: Cartesian2 }) => {
      if (!this.viewer) return;

      const pickedObject = this.viewer.scene.pick(click.position);

      // Vertex delete path
      if (defined(pickedObject) && pickedObject.id && typeof pickedObject.id.id === 'string') {
        const idStr = pickedObject.id.id;
        if (idStr.startsWith('draw_point_')) {
          const idx = parseInt(idStr.split('_')[2]);
          const drawingPts = this.editing.getDrawingPoints();
          drawingPts.splice(idx, 1);
          this.editing.notify();
          return;
        }
      }

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
          if (editMode === 'import_osm') {
            this.editing.addDrawingPoint([lng, lat, alt]);
          } else if (editMode === 'draw_junction') {
            this.editing.addDrawingPoint([lng, lat, alt]);
            this.editing.finalizeDrawing(this.scenarios.getActiveScenarioId());
          } else {
            this.editing.addDrawingPoint([lng, lat, alt]);
          }
          return;
        }
      }

      // Selection mode path
      if (defined(pickedObject) && pickedObject.id) {
        const entityId = pickedObject.id.id || pickedObject.id;
        
        if (typeof entityId === 'string' && (entityId.startsWith('debug_node_') || entityId.startsWith('debug_edge_'))) {
          this.selection.selectSingle(entityId);
          return;
        }

        if (this.objects.getById(entityId)) {
          this.selection.selectSingle(entityId);
          return;
        }
        const savedArea = this.editing.getSavedAreas().find(a => a.id === entityId);
        if (savedArea) {
          this.selection.selectSingle(entityId);
          return;
        }
      }

      // Clicked void - clear selection
      this.selection.selectSingle(null);
    }, ScreenSpaceEventType.LEFT_CLICK);

    // Double click to finalize drawing
    handler.setInputAction(() => {
      const editMode = this.editing.getMode();
      if (editMode !== 'select' && editMode !== 'draw_junction' && editMode !== 'import_osm') {
        try {
          this.editing.finalizeDrawing(this.scenarios.getActiveScenarioId());
        } catch (err: any) {
          (window as any).showToast?.(err.message || "Failed to finalize drawing.", "error");
        }
      }
    }, ScreenSpaceEventType.LEFT_DOUBLE_CLICK);
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

    // 2. Render Zones if layer is visible
    if (this.layers.isVisible('demand_zones')) {
      const zones = filtered.filter(o => o.type === 'zone') as ZoneObject[];
      zones.forEach(zone => {
        const isSelected = selections.includes(zone.id);
        const pts = zone.coordinates.map(c => Cartesian3.fromDegrees(c[0], c[1], c[2] || 0.5));

        const entity = this.viewer!.entities.add({
          id: zone.id,
          name: zone.name,
          polygon: {
            hierarchy: pts,
            material: isSelected 
              ? Color.fromCssColorString('#f43f5e').withAlpha(0.25) 
              : Color.fromCssColorString('#f43f5e').withAlpha(0.08), 
            outline: true,
            outlineColor: isSelected ? Color.CYAN : Color.fromCssColorString('#f43f5e'),
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
            color: isSelected ? Color.CYAN : Color.fromCssColorString('#eab308'), 
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
      const res = await fetch('http://localhost:8000/api/objects');
      if (res.ok) {
        const data = await res.json();
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

    this.objects.add({
      id: 'b1',
      type: 'building',
      name: 'TwinTowers Block A (Vertical Extension)',
      layerId: 'buildings',
      scenarioId: 'proposal_2028',
      coordinates: [
        [baseLng - 0.002, baseLat - 0.002, 0],
        [baseLng - 0.001, baseLat - 0.002, 0],
        [baseLng - 0.001, baseLat - 0.001, 0],
        [baseLng - 0.002, baseLat - 0.001, 0],
        [baseLng - 0.002, baseLat - 0.002, 0]
      ],
      usageType: 'residential',
      height: 75,
      floors: 25,
      population: 400,
      parkingSpaces: 120,
      waterDemand: 60000,
      electricityDemand: 2400,
      constructionYear: 2028,
      createdAt: new Date().toISOString(),
      updatedAt: new Date().toISOString()
    });

    this.objects.add({
      id: 'f1',
      type: 'flyover' as any,
      name: 'Phase 1 Metro Bypass Flyover',
      layerId: 'roads',
      scenarioId: 'proposal_2028',
      coordinates: [
        [baseLng - 0.004, baseLat + 0.001, 5],
        [baseLng + 0.004, baseLat + 0.001, 5]
      ],
      roadClass: 'highway',
      width: 15.5,
      laneCount: 4,
      laneWidth: 3.5,
      hasDivider: true,
      dividerWidth: 1.5,
      hasFootpath: false,
      footpathWidth: 0.0,
      speedLimit: 80,
      isOneWay: false,
      trafficCapacity: 3200,
      connectedJunctions: [],
      createdAt: new Date().toISOString(),
      updatedAt: new Date().toISOString()
    } as any);

    this.objects.add({
      id: 'u1',
      type: 'utility',
      name: 'Sector 4 Water Trunk Feed',
      layerId: 'water_util',
      scenarioId: 'proposal_2030',
      coordinates: [
        [baseLng - 0.004, baseLat - 0.001, 0],
        [baseLng + 0.004, baseLat - 0.001, 0]
      ],
      utilityType: 'water',
      depth: 2.0,
      capacity: 350,
      createdAt: new Date().toISOString(),
      updatedAt: new Date().toISOString()
    });

    this.objects.add({
      id: 'u2',
      type: 'utility',
      name: 'High-Speed Telecom Ring',
      layerId: 'fiber_util',
      scenarioId: 'proposal_2030',
      coordinates: [
        [baseLng - 0.002, baseLat + 0.002, 0],
        [baseLng + 0.002, baseLat + 0.002, 0]
      ],
      utilityType: 'fiber',
      depth: 1.2,
      capacity: 1000,
      createdAt: new Date().toISOString(),
      updatedAt: new Date().toISOString()
    });

    this.seedPuneHinjewadiDemand();
  }

  public getTrafficNetwork() {
    return this.trafficNetwork;
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
    if (this.rebuildTimeout) return;
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

import type { CityObject, RoadClassification, BuildingUsage, UtilityType, Area, BuildingCategory, RoadObject } from '../objects/types';
import { ObjectManager } from '../objects/ObjectManager';
import { HistoryManager, type HistoryDiff } from '../history/HistoryManager';
import { apiGet, apiPost, apiDelete } from '../../lib/api';
import { SnapManager, type SnapResult } from './SnapManager';
import { OverpassClient } from './OverpassClient';
import { LocalOsmIndex } from './LocalOsmIndex';
import { findNearestTrack } from '../objects/stationAlignment';
import { utilityLayerId } from '../layers/LayerManager';
import { findRoadEndGaps, insertRoadVertex, markGeometryEdited, type RoadEndGap } from './roadGaps';
import { classifyOsmWay, findNonDrivableOsmRoads, type NonDrivableRoad } from './osmDrivability';
import { STUDY_AREA_ROADS_PREFIX } from '../simulation/osmCoverage';
import { BASE_SCENARIO_ID } from '../scenarios/ScenarioManager';
import { filterObjectsForScenario } from '../scenarios/scenarioFilter';
import { connectEnds, AUTO_CONNECT_M } from './autoConnect';

/** highway=* values fetched for study areas; the importer's allowlist, plus tracks it may keep. */
const STUDY_AREA_HIGHWAYS = 'motorway|motorway_link|trunk|trunk_link|primary|primary_link|secondary|secondary_link|tertiary|tertiary_link|unclassified|residential|living_street|service|road|track';

/** Roads fetched from OpenStreetMap per request when filling in missing ones. */
const OSM_FETCH_BATCH = 400;

export type EditingMode = 'select' | 'draw_road' | 'draw_building' | 'draw_junction' | 'draw_utility' | 'draw_flyover' | 'draw_metro' | 'place_station' | 'import_osm' | 'draw_zone' | 'draw_gateway' | 'draw_metro_flyover';

export class EditingEngine {
  private activeMode: EditingMode = 'select';
  private drawingPoints: [number, number, number][] = [];
  private isImporting: boolean = false;
  private savedAreas: Area[] = [];
  private savedAreasFetched = false;
  private snapManager: SnapManager;
  private activeSnap: SnapResult | null = null;

  // Selected creation types
  public roadClass: RoadClassification = 'local';
  public buildingUsage: BuildingUsage = 'residential';
  public utilityType: UtilityType = 'water';

  public getIsImporting(): boolean {
    return this.isImporting;
  }

  public setIsImporting(val: boolean) {
    // Each import gets a fresh cancellation token
    this.importAbort = val ? new AbortController() : null;
    if (this.isImporting !== val) {
      this.isImporting = val;
      this.notify();
    }
  }

  private overpass = new OverpassClient();
  /** Roads and signals from the backend's OSM extract; Overpass is used only where it has none. */
  public readonly localOsm: LocalOsmIndex;
  private importAbort: AbortController | null = null;

  private onChangeListeners: (() => void)[] = [];
  private objectManager: ObjectManager;
  private historyManager: HistoryManager;
  private getNetwork?: () => any;

  constructor(
    objectManager: ObjectManager,
    historyManager: HistoryManager,
    getNetwork?: () => any,
    localOsm: LocalOsmIndex = new LocalOsmIndex()
  ) {
    this.localOsm = localOsm;
    this.objectManager = objectManager;
    this.historyManager = historyManager;
    this.getNetwork = getNetwork;
    this.snapManager = new SnapManager(objectManager);
    this.fetchSavedAreas();
  }

  public getSnapManager(): SnapManager {
    return this.snapManager;
  }

  public getActiveSnap(): SnapResult | null {
    return this.activeSnap;
  }

  public setActiveSnap(snap: SnapResult | null) {
    this.activeSnap = snap;
  }

  public onChange(callback: () => void) {
    this.onChangeListeners.push(callback);
    return () => {
      this.onChangeListeners = this.onChangeListeners.filter(cb => cb !== callback);
    };
  }

  public notify() {
    this.onChangeListeners.forEach(cb => cb());
  }

  public getMode(): EditingMode {
    return this.activeMode;
  }

  private locked = false;

  /** While locked (Simulation mode) only the select tool is available, so nothing can be drawn. */
  public setLocked(locked: boolean) {
    this.locked = locked;
    if (locked) this.cancelDrawing();
  }

  public isLocked(): boolean {
    return this.locked;
  }

  public setMode(mode: EditingMode) {
    if (this.locked && mode !== 'select') return;
    if (this.activeMode !== mode) {
      this.activeMode = mode;
      this.clearDrawing();
      this.notify();
    }
  }

  public getDrawingPoints(): [number, number, number][] {
    return this.drawingPoints;
  }

  public addDrawingPoint(point: [number, number, number]) {
    const snap = this.activeSnap || this.snapManager.findSnap(point);
    const resolvedPoint = (snap && snap.type !== 'none') ? snap.point : point;

    // A double-click also fires two single clicks at the same spot; ignore
    // repeats so finishing a line doesn't create zero-length segments.
    const last = this.drawingPoints[this.drawingPoints.length - 1];
    if (last && Math.abs(last[0] - resolvedPoint[0]) < 1e-7 && Math.abs(last[1] - resolvedPoint[1]) < 1e-7) {
      return;
    }

    this.drawingPoints.push(resolvedPoint);
    this.notify();
  }

  public removeDrawingPoint(index: number) {
    if (index < 0 || index >= this.drawingPoints.length) return;
    this.drawingPoints.splice(index, 1);
    this.notify();
  }

  /** Tools that complete on a single click rather than a double-click. */
  public isSingleClickMode(mode: EditingMode = this.activeMode): boolean {
    return mode === 'draw_junction' || mode === 'place_station' || mode === 'draw_gateway';
  }

  public clearDrawing() {
    this.drawingPoints = [];
    this.activeSnap = null;
    this.notify();
  }

  public cancelDrawing() {
    this.clearDrawing();
    this.setMode('select');
  }

  private pointToSegmentDist(
    px: number, py: number,
    x1: number, y1: number,
    x2: number, y2: number
  ): { distance: number; t: number } {
    const dx = x2 - x1;
    const dy = y2 - y1;
    const len2 = dx * dx + dy * dy;
    if (len2 === 0) {
      const dist = Math.sqrt((px - x1) ** 2 + (py - y1) ** 2);
      return { distance: dist, t: 0 };
    }
    let t = ((px - x1) * dx + (py - y1) * dy) / len2;
    t = Math.max(0, Math.min(1, t));
    const cx = x1 + t * dx;
    const cy = y1 + t * dy;
    const dist = Math.sqrt((px - cx) ** 2 + (py - cy) ** 2);
    return { distance: dist, t };
  }

  /**
   * Splits existing roads where the new line's endpoints land mid-segment, so
   * the traffic network sees a real T-junction. Returns history diffs for the
   * modified roads so the caller can record them with the new object.
   */
  public insertJunctionIntoIntersectedRoads(newCoords: [number, number, number][]): HistoryDiff[] {
    const diffs: HistoryDiff[] = [];
    if (newCoords.length < 2) return diffs;
    const checkPoints = [newCoords[0], newCoords[newCoords.length - 1]];
    const roadIds = this.objectManager.getAll()
      .filter(o => o.type === 'road' || o.type === 'flyover' || o.type === 'metro_flyover')
      .map(o => o.id);

    for (const pt of checkPoints) {
      for (const roadId of roadIds) {
        // Re-read every time: an earlier split may already have replaced this road
        const road = this.objectManager.getById(roadId) as RoadObject | undefined;
        if (!road) continue;
        // If already a vertex of this road, skip
        const isVertex = road.coordinates.some(c =>
          Math.abs(c[0] - pt[0]) < 0.00001 && Math.abs(c[1] - pt[1]) < 0.00001
        );
        if (isVertex) continue;

        // Check each segment
        for (let s = 0; s < road.coordinates.length - 1; s++) {
          const p1 = road.coordinates[s];
          const p2 = road.coordinates[s + 1];
          const { distance, t } = this.pointToSegmentDist(pt[0], pt[1], p1[0], p1[1], p2[0], p2[1]);
          if (distance < 0.00012 && t > 0.02 && t < 0.98) {
            // Keeps section vertex ranges in step, or the road's last stretch stops rendering
            const { coordinates, sections } = insertRoadVertex(road, s + 1, [pt[0], pt[1], pt[2] || p1[2] || 0]);
            this.objectManager.update(road.id, sections ? { coordinates, sections } : { coordinates });
            const after = this.objectManager.getById(road.id);
            if (after) {
              diffs.push({ type: 'update', id: road.id, before: road, after, description: `Split ${road.name || road.id}` });
            }
            break;
          }
        }
      }
    }
    return diffs;
  }

  /**
   * Joins a road end to the road it stops just short of (see findRoadEndGaps).
   * The other road gets a vertex at the join point unless one is already there,
   * so both share an exact point and the traffic network links them. `visible`
   * is the active scenario's objects; the gap is re-checked against them first.
   * One undo step.
   */
  public connectRoadEnd(gap: RoadEndGap, visible: readonly CityObject[]): void {
    if (this.locked) throw new Error('The road network is read-only in Simulation mode.');
    const road = this.objectManager.getById(gap.roadId);
    const target = this.objectManager.getById(gap.targetRoadId);
    if (road?.type !== 'road' || target?.type !== 'road') {
      throw new Error('One of these roads no longer exists.');
    }
    const fresh = findRoadEndGaps(road, visible).find(g => g.end === gap.end && g.targetRoadId === gap.targetRoadId);
    if (!fresh) {
      throw new Error(`"${road.name}" no longer stops short of "${target.name}". It may already be connected.`);
    }

    const diffs: HistoryDiff[] = [];
    if (fresh.targetVertex === null) {
      const { coordinates, sections } = insertRoadVertex(target, fresh.targetSegment + 1, fresh.joinPoint);
      this.objectManager.update(target.id, { coordinates, sections: markGeometryEdited(sections) });
      diffs.push({ type: 'update', id: target.id, before: target, after: this.objectManager.getById(target.id)!, description: `Add junction point to ${target.name}` });
    }
    const index = fresh.end === 'start' ? 0 : road.coordinates.length;
    const { coordinates, sections } = insertRoadVertex(road, index, fresh.joinPoint);
    this.objectManager.update(road.id, { coordinates, sections: markGeometryEdited(sections) });
    diffs.push({ type: 'update', id: road.id, before: road, after: this.objectManager.getById(road.id)!, description: `Extend ${road.name}` });

    this.historyManager.pushDiff({ type: 'batch', description: `Connect ${road.name} to ${target.name}`, diffs });
  }

  /**
   * Removes imported OSM roads that vehicles cannot use (footways, paths,
   * closed roads, ...), matching what the importer now skips. One undo step;
   * returns what was removed and why.
   */
  public removeNonDrivableOsmRoads(): NonDrivableRoad[] {
    if (this.locked) throw new Error('The road network is read-only in Simulation mode.');
    const found = findNonDrivableOsmRoads(this.objectManager.getAll());
    if (found.length === 0) return found;
    const roads = found.map(f => f.road);
    this.historyManager.recordDelete(roads, `Remove ${roads.length} OSM ways vehicles cannot use`);
    this.objectManager.deleteMultiple(roads);
    return found;
  }

  /**
   * The drawn path with each end carried onto the road it stops just short of
   * (within AUTO_CONNECT_M, at the same level), so a new road or flyover is
   * part of the network as soon as it is built.
   */
  private joinedToNetwork(points: readonly [number, number, number][], scenarioId: string): [number, number, number][] {
    const pad = (AUTO_CONNECT_M + 5) / 111320;
    const ends = [points[0], points[points.length - 1]];
    // Road boxes, padded, that hold either end
    const nearEnd = (c: readonly (readonly number[])[]) => {
      let minX = Infinity, minY = Infinity, maxX = -Infinity, maxY = -Infinity;
      for (const p of c) {
        if (p[0] < minX) minX = p[0];
        if (p[0] > maxX) maxX = p[0];
        if (p[1] < minY) minY = p[1];
        if (p[1] > maxY) maxY = p[1];
      }
      const padLng = pad / Math.cos((ends[0][1] * Math.PI) / 180);
      return ends.some(e => e[0] >= minX - padLng && e[0] <= maxX + padLng && e[1] >= minY - pad && e[1] <= maxY + pad);
    };
    const roads = filterObjectsForScenario(this.objectManager.getAll(), scenarioId).filter(
      o => (o.type === 'road' || o.type === 'flyover' || o.type === 'metro_flyover') && nearEnd(o.coordinates)
    ) as { id: string; coordinates: [number, number, number][] }[];
    return connectEnds(points, roads) ?? [...points];
  }

  public finalizeDrawing(scenarioId: string) {
    if (this.drawingPoints.length === 0) return;

    const id = Math.random().toString(36).substr(2, 9);
    const createdAt = new Date().toISOString();
    const name = `${this.activeMode.split('_')[1].toUpperCase()} #${id.slice(0, 4)}`;

    let newObj: CityObject | null = null;
    let splitDiffs: HistoryDiff[] = [];
    const minPoints = (n: number, what: string) => {
      if (this.drawingPoints.length < n) {
        throw new Error(`${what} needs at least ${n} points — keep clicking on the map, then double-click to finish.`);
      }
    };

    if (this.activeMode === 'draw_road') {
      minPoints(2, 'A road');
      const coords = this.joinedToNetwork(this.drawingPoints, scenarioId);
      newObj = {
        id,
        type: 'road',
        name,
        layerId: 'roads',
        scenarioId,
        coordinates: coords,
        roadClass: this.roadClass,
        width: this.roadClass === 'highway' ? 24 : this.roadClass === 'arterial' ? 19 : 10,
        laneCount: this.roadClass === 'highway' ? 6 : this.roadClass === 'arterial' ? 4 : 2,
        laneWidth: 3.5,
        hasDivider: this.roadClass === 'highway' || this.roadClass === 'arterial',
        dividerWidth: this.roadClass === 'highway' ? 3.0 : this.roadClass === 'arterial' ? 2.0 : 0.0,
        hasFootpath: this.roadClass !== 'highway',
        footpathWidth: this.roadClass !== 'highway' ? 1.5 : 0.0,
        speedLimit: this.roadClass === 'highway' ? 100 : this.roadClass === 'arterial' ? 70 : 40,
        isOneWay: false,
        trafficCapacity: this.roadClass === 'highway' ? 4000 : this.roadClass === 'arterial' ? 2000 : 1000,
        connectedJunctions: [],
        createdAt,
        updatedAt: createdAt
      };
      splitDiffs = this.insertJunctionIntoIntersectedRoads(coords);
    } else if (this.activeMode === 'draw_building') {
      minPoints(3, 'A building footprint');
      // Close the polygon ring if not closed
      const coords = [...this.drawingPoints];
      if (coords[0][0] !== coords[coords.length - 1][0] || coords[0][1] !== coords[coords.length - 1][1]) {
        coords.push([coords[0][0], coords[0][1], coords[0][2]]);
      }

      const floors = Math.round(Math.random() * 15 + 2);
      const population = floors * 15;

      newObj = {
        id,
        type: 'building',
        name,
        layerId: 'buildings',
        scenarioId,
        coordinates: coords,
        usageType: this.buildingUsage,
        height: floors * 3, // 3m per floor
        floors,
        population,
        parkingSpaces: Math.round(floors * 2.5),
        waterDemand: population * 150, // 150L/person/day
        electricityDemand: population * 6, // 6kWh/person/day
        constructionYear: 2026,
        createdAt,
        updatedAt: createdAt
      };
    } else if (this.activeMode === 'draw_junction') {
      newObj = {
        id,
        type: 'junction',
        name,
        layerId: 'junctions',
        scenarioId,
        coordinates: this.drawingPoints[0],
        connectedRoads: [],
        hasSignals: true,
        signalTiming: 90,
        hasPedestrianCrossing: true,
        createdAt,
        updatedAt: createdAt
      };
    } else if (this.activeMode === 'draw_utility') {
      minPoints(2, 'A utility conduit');
      newObj = {
        id,
        type: 'utility',
        name,
        layerId: utilityLayerId(this.utilityType),
        scenarioId,
        coordinates: [...this.drawingPoints],
        utilityType: this.utilityType,
        depth: 1.5,
        capacity: 100,
        createdAt,
        updatedAt: createdAt
      };
    } else if (this.activeMode === 'draw_flyover') {
      minPoints(2, 'A flyover');
      // Ground-level points only: ObjectManager.add → applyFlyoverElevationProfile
      // resamples the path and builds the ramp/deck profile from these.
      const groundCoordinates = this.joinedToNetwork(this.drawingPoints.map(pt => [pt[0], pt[1], pt[2] || 0] as [number, number, number]), scenarioId);
      newObj = {
        id,
        type: 'flyover',
        name: `Flyover #${id.slice(0, 4)}`,
        layerId: 'roads',
        scenarioId,
        coordinates: groundCoordinates,
        roadClass: 'arterial',
        width: 19,
        laneCount: 4,
        laneWidth: 3.5,
        hasDivider: true,
        dividerWidth: 2.0,
        hasFootpath: true,
        footpathWidth: 1.5,
        speedLimit: 80,
        isOneWay: false,
        elevation: 6.0,
        pierSpacing: 30.0,
        createdAt,
        updatedAt: createdAt
      };
      splitDiffs = this.insertJunctionIntoIntersectedRoads(groundCoordinates);
    } else if (this.activeMode === 'draw_metro_flyover') {
      minPoints(2, 'A metro + flyover');
      // Ground-level points only: ObjectManager.add → applyFlyoverElevationProfile
      // resamples the path and builds the ramp/deck profile from these.
      const groundCoordinates = this.joinedToNetwork(this.drawingPoints.map(pt => [pt[0], pt[1], pt[2] || 0] as [number, number, number]), scenarioId);
      newObj = {
        id,
        type: 'metro_flyover',
        name: `Metro-Flyover #${id.slice(0, 4)}`,
        layerId: 'roads',
        scenarioId,
        coordinates: groundCoordinates,
        roadClass: 'arterial',
        width: 19,
        laneCount: 4,
        laneWidth: 3.5,
        hasDivider: true,
        dividerWidth: 2.0,
        hasFootpath: true,
        footpathWidth: 1.5,
        speedLimit: 80,
        isOneWay: false,
        elevation: 6.0,
        metroElevation: 12.0,
        pierSpacing: 30.0,
        createdAt,
        updatedAt: createdAt
      };
      splitDiffs = this.insertJunctionIntoIntersectedRoads(groundCoordinates);
    } else if (this.activeMode === 'draw_metro') {
      minPoints(2, 'A metro line');
      newObj = {
        id,
        type: 'metro_line',
        name: `Metro Track #${id.slice(0, 4)}`,
        layerId: 'metro',
        scenarioId,
        coordinates: [...this.drawingPoints],
        trackCount: 2,
        trackGauge: 1.435,
        deckWidth: 8.0,
        elevation: 12.0,
        pierSpacing: 30.0,
        createdAt,
        updatedAt: createdAt
      };
    } else if (this.activeMode === 'place_station') {
      if (this.drawingPoints.length === 0) return;
      newObj = {
        id,
        type: 'metro_station',
        name: `Elevated Metro Station #${id.slice(0, 4)}`,
        layerId: 'metro',
        scenarioId,
        coordinates: this.drawingPoints[0],
        stationName: `Station ${id.slice(0, 4)}`,
        length: 140,
        width: 20,
        height: 8,
        elevation: 12.0,
        capacity: 5000,
        // Face along the nearest track when there is one; otherwise north
        heading: findNearestTrack(this.drawingPoints[0], this.objectManager.getAll())?.bearing ?? 0,
        alignToTrack: true,
        createdAt,
        updatedAt: createdAt
      };
    } else if (this.activeMode === 'draw_zone') {
      if (this.drawingPoints.length < 3) {
        throw new Error("A zone must have at least 3 vertices.");
      }
      if (this.hasSelfIntersection(this.drawingPoints)) {
        throw new Error("Invalid polygon: The zone boundary cannot self-intersect.");
      }
      const coords = [...this.drawingPoints];
      if (coords[0][0] !== coords[coords.length - 1][0] || coords[0][1] !== coords[coords.length - 1][1]) {
        coords.push([coords[0][0], coords[0][1], coords[0][2]]);
      }
      newObj = {
        id: `zone_${id}`,
        type: 'zone',
        name: `Zone #${id.slice(0, 4)}`,
        layerId: 'demand_zones',
        scenarioId,
        coordinates: coords,
        totalPopulation: 10000,
        totalEmployment: 5000,
        landUseMix: { residential: 50, commercial: 30, industrial: 10, educational: 10 },
        gateways: [],
        provenance: {
          source: 'estimated',
          confidence: 0.8,
          updatedAt: createdAt
        },
        createdAt,
        updatedAt: createdAt
      } as any;
    } else if (this.activeMode === 'draw_gateway') {
      if (this.drawingPoints.length === 0) return;

      let nearestNodeId = '';
      let nearestCoords: [number, number, number] = this.drawingPoints[0];
      let minDistance = Infinity;

      const network = this.getNetwork ? this.getNetwork() : null;
      if (network && network.nodes) {
        network.nodes.forEach((node: any) => {
          const dx = node.coordinates[0] - this.drawingPoints[0][0];
          const dy = node.coordinates[1] - this.drawingPoints[0][1];
          const dist = Math.sqrt(dx * dx + dy * dy);
          if (dist < minDistance) {
            minDistance = dist;
            nearestNodeId = node.id;
            nearestCoords = [node.coordinates[0], node.coordinates[1], node.coordinates[2] || 0];
          }
        });
      }

      // 0.004 degrees is roughly 440 meters, snap threshold
      if (minDistance > 0.004) {
        throw new Error("Gateway is too far from the road network. Please place it within 300m of a road.");
      }

      newObj = {
        id: `gateway_${id}`,
        type: 'gateway',
        name: `Gateway #${id.slice(0, 4)}`,
        layerId: 'gateways',
        scenarioId,
        coordinates: [nearestCoords],
        connectedNodeId: nearestNodeId,
        inboundFlows: { AM_Peak: 500, PM_Peak: 300, Midday: 200, Night: 50 },
        outboundFlows: { AM_Peak: 300, PM_Peak: 500, Midday: 200, Night: 50 },
        modeSplit: {
          car: 0.35,
          twoWheeler: 0.40,
          bus: 0.15,
          metro: 0.05,
          walking: 0.03,
          other: 0.02
        },
        createdAt,
        updatedAt: createdAt
      } as any;
    }

    if (newObj) {
      const description = `Add ${newObj.type} ${newObj.name || newObj.id}`;
      if (splitDiffs.length > 0) {
        this.historyManager?.pushDiff({
          type: 'batch',
          description,
          diffs: [...splitDiffs, { type: 'add', objects: [newObj] }]
        });
      } else {
        this.historyManager?.recordAdd?.(newObj, description);
      }
      this.objectManager.add(newObj);
    }

    // Tools stay active after finishing so several objects can be drawn in a
    // row; Esc or the Select tool exits.
    this.clearDrawing();
  }

  public getSavedAreas(): Area[] {
    return this.savedAreas;
  }

  /** Whether the saved Areas have been asked for (loaded, or the backend could not be reached). */
  public hasFetchedSavedAreas(): boolean {
    return this.savedAreasFetched;
  }

  public async fetchSavedAreas(): Promise<void> {
    try {
      this.savedAreas = await apiGet<Area[]>('/api/areas');
      this.notify();
    } catch (e) {
      console.warn('[EditingEngine] fetchSavedAreas failed:', e);
      (window as any).showToast?.('Failed to load saved areas: Backend server may be offline.', 'error');
    } finally {
      this.savedAreasFetched = true;
    }
  }

  public async saveArea(name: string): Promise<Area> {
    if (this.drawingPoints.length < 3) {
      throw new Error("Boundary must have at least 3 points.");
    }
    if (this.hasSelfIntersection(this.drawingPoints)) {
      throw new Error("Self-intersecting polygon boundaries are invalid.");
    }

    const coords = [...this.drawingPoints];
    if (coords[0][0] !== coords[coords.length - 1][0] || coords[0][1] !== coords[coords.length - 1][1]) {
      coords.push([coords[0][0], coords[0][1], coords[0][2]]);
    }

    let minLat = Infinity, maxLat = -Infinity;
    let minLon = Infinity, maxLon = -Infinity;
    for (const pt of coords) {
      const lon = pt[0];
      const lat = pt[1];
      if (lat < minLat) minLat = lat;
      if (lat > maxLat) maxLat = lat;
      if (lon < minLon) minLon = lon;
      if (lon > maxLon) maxLon = lon;
    }

    const id = 'area_' + Math.random().toString(36).substr(2, 9);
    const areaObj: Area = {
      id,
      name,
      polygonCoordinates: coords,
      minLat,
      maxLat,
      minLon,
      maxLon,
      createdAt: new Date().toISOString()
    };

    await apiPost('/api/areas', areaObj);

    this.savedAreas.push(areaObj);
    this.clearDrawing();
    this.notify();
    return areaObj;
  }

  private isObjectInArea(obj: CityObject, area: Area): boolean {
    const coords = obj.coordinates;
    if (!coords || !Array.isArray(coords)) return false;

    const isPointInBBox = (pt: any) => {
      if (!Array.isArray(pt) || pt.length < 2) return false;
      const [lng, lat] = pt;
      return lng >= area.minLon && lng <= area.maxLon &&
             lat >= area.minLat && lat <= area.maxLat;
    };

    if (typeof coords[0] === 'number') {
      return isPointInBBox(coords);
    }

    if (Array.isArray(coords[0])) {
      return (coords as [number, number, number][]).some(pt => isPointInBBox(pt));
    }

    return false;
  }

  public async deleteArea(id: string, deleteAssociatedData = false): Promise<void> {
    try {
      const area = this.savedAreas.find(a => a.id === id);
      if (!area) return;

      await apiDelete(`/api/areas/${id}`);
      this.savedAreas = this.savedAreas.filter(a => a.id !== id);

      if (deleteAssociatedData) {
        const allObjects = this.objectManager.getAll();
        const objsToDelete = allObjects.filter(obj => this.isObjectInArea(obj, area));
        if (objsToDelete.length > 0) {
          this.historyManager?.recordDelete?.(objsToDelete, `Delete infrastructure in "${area.name}"`);
          this.objectManager.deleteMultiple(objsToDelete);
        }
      }

      this.notify();
    } catch (e) {
      console.warn('[EditingEngine] deleteArea failed:', e);
      throw new Error('Could not delete the area: the backend server did not accept the request.');
    }
  }

  private hasSelfIntersection(pts: [number, number, number][]): boolean {
    const n = pts.length;
    if (n < 4) return false;

    const intersects = (p1: [number, number, number], p2: [number, number, number], p3: [number, number, number], p4: [number, number, number]) => {
      const ccw = (A: [number, number, number], B: [number, number, number], C: [number, number, number]) =>
        (C[1] - A[1]) * (B[0] - A[0]) > (B[1] - A[1]) * (C[0] - A[0]);
      return ccw(p1, p3, p4) !== ccw(p2, p3, p4) && ccw(p1, p2, p3) !== ccw(p1, p2, p4);
    };

    const isClosed = pts[0][0] === pts[n-1][0] && pts[0][1] === pts[n-1][1];

    for (let i = 0; i < n - 1; i++) {
      for (let j = i + 2; j < n - 1; j++) {
        if (isClosed && i === 0 && j === n - 2) continue;
        if (intersects(pts[i], pts[i + 1], pts[j], pts[j + 1])) {
          return true;
        }
      }
    }
    return false;
  }

  /** Ways the last road import left out because vehicles cannot use them, by reason. */
  public lastRoadImportSkipped: Record<string, number> = {};

  /**
   * Turns Overpass ways into road objects: vehicle roads only, with one-way
   * directions, lanes and speed limits from their OSM tags. Ways left out are
   * counted by reason in `lastRoadImportSkipped`.
   */
  private osmWaysToRoads(elements: any[], scenarioId: string): RoadObject[] {
    this.lastRoadImportSkipped = {};
    const roadObjs: RoadObject[] = [];
    for (const el of elements) {
      if (el.type !== 'way' || !el.geometry || el.geometry.length < 2) continue;

      const id = `osm_${el.id}`;
      const tags = el.tags || {};
      // Footways, paths, cycleways etc. are not roads for the traffic network
      const decision = classifyOsmWay(tags);
      if (!decision.include) {
        this.lastRoadImportSkipped[decision.reason] = (this.lastRoadImportSkipped[decision.reason] || 0) + 1;
        continue;
      }
      const highwayType = tags.highway || 'local';

      let roadClass: 'highway' | 'arterial' | 'collector' | 'local' = 'local';
      if (highwayType === 'motorway' || highwayType === 'trunk' || highwayType === 'motorway_link') {
        roadClass = 'highway';
      } else if (highwayType === 'primary' || highwayType === 'secondary' || highwayType === 'primary_link') {
        roadClass = 'arterial';
      } else if (highwayType === 'tertiary' || highwayType === 'tertiary_link') {
        roadClass = 'collector';
      }

      const isOneWay = tags.oneway === 'yes' || tags.oneway === '1' || tags.oneway === '-1' || highwayType === 'motorway' || highwayType === 'motorway_link';

      let lanesA = 1;
      let lanesB = 0;

      const tagLanes = tags.lanes ? parseInt(tags.lanes) : NaN;
      const tagLanesFwd = tags["lanes:forward"] ? parseInt(tags["lanes:forward"]) : NaN;
      const tagLanesBwd = tags["lanes:backward"] ? parseInt(tags["lanes:backward"]) : NaN;

      if (isOneWay) {
        if (!isNaN(tagLanesFwd)) {
          lanesA = tagLanesFwd;
        } else if (!isNaN(tagLanes)) {
          lanesA = tagLanes;
        } else {
          if (highwayType === 'motorway' || highwayType === 'trunk') {
            lanesA = 3;
          } else if (highwayType.endsWith('_link')) {
            lanesA = 1;
          } else if (highwayType === 'service') {
            lanesA = 1;
          } else {
            lanesA = 2;
          }
        }
        lanesB = 0;
      } else {
        if (!isNaN(tagLanesFwd) && !isNaN(tagLanesBwd)) {
          lanesA = tagLanesFwd;
          lanesB = tagLanesBwd;
        } else if (!isNaN(tagLanesFwd)) {
          lanesA = tagLanesFwd;
          if (!isNaN(tagLanes)) {
            lanesB = Math.max(1, tagLanes - tagLanesFwd);
          } else {
            lanesB = tagLanesFwd;
          }
        } else if (!isNaN(tagLanesBwd)) {
          lanesB = tagLanesBwd;
          if (!isNaN(tagLanes)) {
            lanesA = Math.max(1, tagLanes - tagLanesBwd);
          } else {
            lanesA = tagLanesBwd;
          }
        } else if (!isNaN(tagLanes)) {
          if (tagLanes === 1) {
            lanesA = 1;
            lanesB = 1;
          } else {
            lanesA = Math.ceil(tagLanes / 2);
            lanesB = Math.floor(tagLanes / 2);
          }
        } else {
          if (highwayType === 'motorway' || highwayType === 'trunk') {
            lanesA = 2;
            lanesB = 2;
          } else if (highwayType.endsWith('_link')) {
            lanesA = 1;
            lanesB = 1;
          } else if (highwayType === 'service') {
            lanesA = 1;
            lanesB = 1;
          } else {
            if (roadClass === 'highway') {
              lanesA = 2;
              lanesB = 2;
            } else {
              lanesA = 1;
              lanesB = 1;
            }
          }
        }
      }

      const laneCount = lanesA + lanesB;
      const hasDivider = (roadClass === 'highway' && !isOneWay) || tags.divider === 'yes';
      const dividerWidth = hasDivider ? 2.0 : 0.0;
      const hasFootpath = highwayType !== 'motorway' && highwayType !== 'trunk';
      const footpathWidth = hasFootpath ? 1.5 : 0.0;
      const speedLimit = parseInt(tags.maxspeed) || (roadClass === 'highway' ? 100 : roadClass === 'arterial' ? 60 : 50);

      const coordinates = el.geometry.map((pt: any) => [pt.lon, pt.lat, 0]);
      const sourceCoordinates = el.geometry.map((pt: any) => [pt.lon, pt.lat, 0]);

      const leftRoadside = {
        footpathWidth: hasFootpath ? footpathWidth : 0,
        cycleTrackWidth: 0,
        vergeWidth: 0,
        parkingWidth: 0,
        drainageWidth: 0
      };

      const rightRoadside = {
        footpathWidth: (hasFootpath && !hasDivider && lanesB > 0) || (hasFootpath && hasDivider) ? footpathWidth : 0,
        cycleTrackWidth: 0,
        vergeWidth: 0,
        parkingWidth: 0,
        drainageWidth: 0
      };

      const carriagewayA = {
        direction: isOneWay ? 'forward' as const : 'both' as const,
        lanes: lanesA,
        laneWidth: 3.5,
        leftRoadside: leftRoadside,
        rightRoadside: { footpathWidth: 0, cycleTrackWidth: 0, vergeWidth: 0, parkingWidth: 0, drainageWidth: 0 }
      };

      let carriagewayB = undefined;
      if (lanesB > 0) {
        carriagewayB = {
          direction: 'backward' as const,
          lanes: lanesB,
          laneWidth: 3.5,
          leftRoadside: { footpathWidth: 0, cycleTrackWidth: 0, vergeWidth: 0, parkingWidth: 0, drainageWidth: 0 },
          rightRoadside: rightRoadside
        };
      } else if (!hasDivider && !isOneWay) {
        carriagewayA.rightRoadside = rightRoadside;
      } else if (isOneWay) {
        carriagewayA.rightRoadside = rightRoadside;
      }

      const sections = [{
        startNodeIndex: 0,
        endNodeIndex: coordinates.length - 1,
        totalRowWidth: (laneCount * 3.5) + dividerWidth + (hasFootpath ? footpathWidth * 2 : 0),
        wideningPossible: true,
        hasMedian: hasDivider,
        medianWidth: dividerWidth,
        carriagewayA,
        carriagewayB,
        reservedSpaces: [],
        provenance: {
          originalSource: 'OSM' as const,
          originalConfidence: 'estimated' as const,
          geometryModified: false,
          profileModified: false,
          lastModifiedBy: 'importer' as const,
          verificationStatus: 'unverified' as const
        }
      }];

      const roadObj = {
        id,
        type: 'road' as const,
        name: tags.name || `${highwayType.charAt(0).toUpperCase() + highwayType.slice(1)} Road`,
        layerId: 'roads',
        scenarioId,
        coordinates,
        sourceCoordinates,
        sections,
        roadClass,
        width: (laneCount * 3.5) + dividerWidth + (hasFootpath ? footpathWidth * 2 : 0),
        laneCount,
        laneWidth: 3.5,
        hasDivider,
        dividerWidth,
        hasFootpath,
        footpathWidth,
        speedLimit,
        isOneWay,
        trafficCapacity: laneCount * 1000,
        connectedJunctions: [],
        createdAt: new Date().toISOString(),
        updatedAt: new Date().toISOString(),

        osmProvenance: {
          osmId: el.id,
          originalTags: tags,
          layer: parseInt(tags.layer) || 0,
          bridge: tags.bridge === 'yes',
          tunnel: tags.tunnel === 'yes',
          roundabout: tags.junction === 'roundabout'
        }
      };

      roadObjs.push(roadObj);
    }

    return roadObjs;
  }

  public async importOSMRoadsInsideArea(area: Area, activeScenarioId: string): Promise<number> {
    this.setIsImporting(true);
    try {
      const polyCoords = area.polygonCoordinates.map(pt => `${pt[1]} ${pt[0]}`).join(' ');
      const query = `[out:json][timeout:50];way["highway"](poly:"${polyCoords}");out geom;`;
      const data = await this.fetchFromOverpass(query);
      if (!data || !data.elements) return 0;

      const roadObjs = this.osmWaysToRoads(data.elements, activeScenarioId);
      if (roadObjs.length > 0) {
        this.historyManager?.recordAdd?.(roadObjs, `Import ${roadObjs.length} OSM Roads`);
        this.objectManager.addMultiple(roadObjs);
      }
      if (Object.keys(this.lastRoadImportSkipped).length > 0) {
        console.info('[OSM import] Ways skipped as not vehicle roads:', this.lastRoadImportSkipped);
      }
      return roadObjs.length;
    } catch (err) {
      console.error("OSM Import failed:", err);
      throw err;
    } finally {
      this.setIsImporting(false);
      this.notify();
    }
  }

  /**
   * Makes the project hold every OpenStreetMap road inside `boxes`.
   *
   * Reads the roads from the backend's local OSM extract when it covers the
   * boxes (complete, and quick). Elsewhere asks Overpass which vehicle roads
   * OSM has there (ids only, a small answer), then fetches just the ones the
   * project is missing. An earlier load that came back incomplete, or roads
   * added to OSM since, are filled in this way.
   * Roads already present (possibly edited) are kept as they are, and roads
   * the user deleted are not brought back. Resolves only once the new roads
   * are saved, so a box is never recorded as checked when it is not.
   *
   * Not an edit: it is not recorded for undo, and works while Simulation mode
   * locks editing. Returns the number of roads added.
   */
  public async loadOsmRoadsForStudyArea(boxes: { minLng: number; minLat: number; maxLng: number; maxLat: number }[], signal?: AbortSignal): Promise<number> {
    const added = (await this.localOsm.covers(boxes))
      ? await this.fillFromLocalOsm(boxes)
      : await this.fillFromOverpass(boxes, signal);
    this.recordStudyAreaBoxes(boxes);
    return added;
  }

  /** Adds the local extract's roads in `boxes` that the project is missing; resolves once saved. */
  private async fillFromLocalOsm(boxes: { minLng: number; minLat: number; maxLng: number; maxLat: number }[]): Promise<number> {
    const elements = await this.localOsm.ways(boxes);
    const deleted = await this.objectManager.deletedOsmIds();
    const roads = this.osmWaysToRoads(elements, BASE_SCENARIO_ID).filter(r => !this.objectManager.getById(r.id) && !deleted.has(r.id));
    await this.objectManager.addMultipleAndSave(roads);
    return roads.length;
  }

  /** As fillFromLocalOsm, from the public Overpass servers: ids first, then only the missing roads. */
  private async fillFromOverpass(boxes: { minLng: number; minLat: number; maxLng: number; maxLat: number }[], signal?: AbortSignal): Promise<number> {
    // Vehicle highway types only: footways and paths make up much of the data and are dropped anyway
    const parts = boxes.map(b => `way["highway"~"^(${STUDY_AREA_HIGHWAYS})$"](${b.minLat},${b.minLng},${b.maxLat},${b.maxLng});`).join('');
    const listing = await this.overpass.query(`[out:json][timeout:60];(${parts});out ids;`, signal);
    // A remark means the server stopped early, so the answer may be partial
    if (typeof listing?.remark === 'string') throw new Error(`OpenStreetMap did not finish the query: ${listing.remark}`);
    const ids: number[] = (listing?.elements ?? []).filter((e: any) => e.type === 'way').map((e: any) => e.id);
    // Busy mirrors sometimes answer with nothing: an empty answer proves nothing
    if (ids.length === 0) throw new Error('OpenStreetMap returned no roads for this area. Try again in a moment.');

    const deleted = await this.objectManager.deletedOsmIds();
    const missing = ids.filter(id => !this.objectManager.getById(`osm_${id}`) && !deleted.has(`osm_${id}`));
    // Fetched in batches, then added together: one update for the map and the network
    const roads: RoadObject[] = [];
    for (let i = 0; i < missing.length; i += OSM_FETCH_BATCH) {
      const batch = missing.slice(i, i + OSM_FETCH_BATCH);
      const data = await this.overpass.query(`[out:json][timeout:60];way(id:${batch.join(',')});out geom;`, signal);
      if (typeof data?.remark === 'string') throw new Error(`OpenStreetMap did not finish the query: ${data.remark}`);
      roads.push(...this.osmWaysToRoads(data?.elements ?? [], BASE_SCENARIO_ID).filter(r => !this.objectManager.getById(r.id)));
    }
    await this.objectManager.addMultipleAndSave(roads);
    return roads.length;
  }

  /** Saves the boxes as Areas, recording that the project holds their roads. */
  private recordStudyAreaBoxes(boxes: { minLng: number; minLat: number; maxLng: number; maxLat: number }[]) {
    for (const { minLng, minLat, maxLng, maxLat } of boxes) {
      const area: Area = {
        id: STUDY_AREA_ROADS_PREFIX + Math.random().toString(36).slice(2, 11),
        name: 'Roads loaded for a study area',
        polygonCoordinates: [[minLng, minLat, 0], [maxLng, minLat, 0], [maxLng, maxLat, 0], [minLng, maxLat, 0], [minLng, minLat, 0]],
        minLat,
        maxLat,
        minLon: minLng,
        maxLon: maxLng,
        createdAt: new Date().toISOString(),
      };
      this.savedAreas.push(area);
      apiPost('/api/areas', area).catch(e => console.warn('[EditingEngine] Saving the loaded road area failed:', e));
    }
    this.notify();
  }

  public async importOSMBuildingsInsideArea(area: Area, activeScenarioId: string): Promise<number> {
    this.setIsImporting(true);
    try {
      const polyCoords = area.polygonCoordinates.map(pt => `${pt[1]} ${pt[0]}`).join(' ');
      const query = `[out:json][timeout:90];(way["building"](poly:"${polyCoords}");relation["building"](poly:"${polyCoords}"););out geom;`;
      const data = await this.fetchFromOverpass(query);
      if (!data || !data.elements) return 0;

      let count = 0;
      const buildingObjs: any[] = [];
      for (const el of data.elements) {
        let coordinates: [number, number, number][] = [];

        if (el.type === 'way' && el.geometry && el.geometry.length >= 3) {
          coordinates = el.geometry.map((pt: any) => [pt.lon, pt.lat, 0]);
        } else if (el.type === 'relation' && el.members) {
          const outerMember = el.members.find((m: any) => m.role === 'outer' && m.geometry && m.geometry.length >= 3);
          if (outerMember) {
            coordinates = outerMember.geometry.map((pt: any) => [pt.lon, pt.lat, 0]);
          }
        }

        if (coordinates.length < 3) continue;

        if (coordinates[0][0] !== coordinates[coordinates.length - 1][0] || coordinates[0][1] !== coordinates[coordinates.length - 1][1]) {
          coordinates.push([coordinates[0][0], coordinates[0][1], coordinates[0][2]]);
        }

        const id = `osm_b_${el.id}`;
        const tags = el.tags || {};

        const usageType: BuildingUsage = tags.amenity === 'school' || tags.building === 'school' ? 'educational' :
                          tags.building === 'commercial' || tags.building === 'office' ? 'commercial' :
                          tags.building === 'industrial' || tags.building === 'manufactory' ? 'industrial' :
                          'residential';

        let floors = 3;
        if (tags["building:levels"]) {
          const parsed = parseInt(tags["building:levels"]);
          if (!isNaN(parsed) && parsed > 0) floors = parsed;
        }

        let height = floors * 3;
        if (tags.height) {
          const parsed = parseFloat(tags.height);
          if (!isNaN(parsed) && parsed > 0) height = parsed;
        }

        const population = floors * 12;

        // Map category from tags
        let category: BuildingCategory = 'other';
        if (tags.office === 'it' || tags.building === 'it' || tags.amenity === 'it') {
          category = 'IT';
        } else if (tags.building === 'school' || tags.amenity === 'school') {
          category = 'school';
        } else if (tags.building === 'college' || tags.building === 'university' || tags.amenity === 'college' || tags.amenity === 'university') {
          category = 'college';
        } else if (tags.building === 'hospital' || tags.amenity === 'hospital') {
          category = 'hospital';
        } else if (tags.building === 'hotel' || tags.tourism === 'hotel') {
          category = 'hotel';
        } else if (tags.building === 'office' || tags.office) {
          category = 'office';
        } else if (tags.building === 'retail' || tags.shop) {
          category = 'retail';
        } else if (tags.building === 'commercial' || tags.amenity === 'bank') {
          category = 'commercial';
        } else if (tags.building === 'residential' || tags.building === 'apartments' || tags.building === 'house') {
          category = 'residential';
        } else if (tags.building === 'mixed_use') {
          category = 'mixed_use';
        } else if (tags.building === 'industrial' || tags.building === 'manufactory') {
          category = 'industrial';
        } else if (tags.building === 'government' || tags.amenity === 'townhall') {
          category = 'government';
        } else {
          // Fallback based on usageType
          if (usageType === 'residential') category = 'residential';
          else if (usageType === 'commercial') category = 'commercial';
          else if (usageType === 'industrial') category = 'industrial';
          else if (usageType === 'educational') category = 'school';
        }

        // Initialize specific capacity fields depending on category
        let residents = 0;
        let employees = 0;
        let students = 0;
        let patients = 0;
        let visitorsPerDay = 10;

        if (category === 'residential') {
          residents = population;
          visitorsPerDay = Math.round(population * 0.1);
        } else if (category === 'office' || category === 'IT') {
          employees = Math.round(population * 0.9);
          visitorsPerDay = Math.round(population * 0.15);
        } else if (category === 'commercial' || category === 'retail') {
          employees = Math.round(population * 0.5);
          visitorsPerDay = Math.round(population * 2.0);
        } else if (category === 'school' || category === 'college') {
          students = Math.round(population * 0.85);
          employees = Math.round(population * 0.15);
          visitorsPerDay = Math.round(population * 0.05);
        } else if (category === 'hospital') {
          employees = Math.round(population * 0.4);
          patients = Math.round(population * 0.6);
          visitorsPerDay = Math.round(population * 1.2);
        }

        const buildingObj = {
          id,
          type: 'building' as const,
          name: tags.name || `${category.charAt(0).toUpperCase() + category.slice(1)} Building`,
          layerId: 'buildings',
          scenarioId: activeScenarioId,
          coordinates,
          usageType,
          height,
          floors,
          population,
          parkingSpaces: Math.round(floors * 2.0),
          waterDemand: population * 135,
          electricityDemand: population * 5,
          constructionYear: parseInt(tags.start_date) || 2020,
          createdAt: new Date().toISOString(),
          updatedAt: new Date().toISOString(),

          // Upgraded planning properties
          category,
          state: 'existing' as const,
          residents,
          employees,
          students,
          patients,
          visitorsPerDay,
          parkingCapacity: Math.round(floors * 2.0),
          notes: '',

          // OSM Provenance
          osmId: el.id,
          originalOsmTags: tags,
          source: 'OSM' as const,
          originalFootprint: coordinates,
          isManuallyEdited: false
        };

        buildingObjs.push(buildingObj);
        count++;
      }

      if (buildingObjs.length > 0) {
        this.historyManager?.recordAdd?.(buildingObjs, `Import ${buildingObjs.length} OSM Buildings`);
        this.objectManager.addMultiple(buildingObjs);
      }
      return count;
    } catch (err) {
      console.error("OSM Buildings Import failed:", err);
      throw err;
    } finally {
      this.setIsImporting(false);
      this.notify();
    }
  }

  private getDistanceMeters(p1: [number, number], p2: [number, number]): number {
    const R = 6371000;
    const dLat = (p2[1] - p1[1]) * Math.PI / 180;
    const dLon = (p2[0] - p1[0]) * Math.PI / 180;
    const lat1 = p1[1] * Math.PI / 180;
    const lat2 = p2[1] * Math.PI / 180;
    const a = Math.sin(dLat / 2) * Math.sin(dLat / 2) +
              Math.cos(lat1) * Math.cos(lat2) *
              Math.sin(dLon / 2) * Math.sin(dLon / 2);
    const c = 2 * Math.atan2(Math.sqrt(a), Math.sqrt(1 - a));
    return R * c;
  }

  public async importOSMMetroInsideArea(area: Area, activeScenarioId: string): Promise<{ lines: number; stations: number }> {
    this.setIsImporting(true);
    try {
      const polyCoords = area.polygonCoordinates.map(pt => `${pt[1]} ${pt[0]}`).join(' ');
      const query = `[out:json][timeout:90];(
        way["railway"="subway"](poly:"${polyCoords}");
        way["railway"="construction"]["construction"="subway"](poly:"${polyCoords}");
        node["railway"="station"]["station"="subway"](poly:"${polyCoords}");
        way["railway"="station"]["station"="subway"](poly:"${polyCoords}");
      );out geom;`;
      const data = await this.fetchFromOverpass(query);
      if (!data || !data.elements) return { lines: 0, stations: 0 };

      let linesCount = 0;
      let stationsCount = 0;
      const metroObjs: any[] = [];

      for (const el of data.elements) {
        const id = `osm_m_${el.id}`;
        const tags = el.tags || {};
        const isStation = tags.railway === 'station';

        if (isStation) {
          let coordinates: [number, number, number] = [0, 0, 0];
          if (el.type === 'node') {
            coordinates = [el.lon, el.lat, 0];
          } else if (el.type === 'way' && el.geometry && el.geometry.length > 0) {
            let sumLon = 0, sumLat = 0;
            el.geometry.forEach((pt: any) => {
              sumLon += pt.lon;
              sumLat += pt.lat;
            });
            coordinates = [sumLon / el.geometry.length, sumLat / el.geometry.length, 0];
          } else {
            continue;
          }

          // Deduplicate overlapping stations within 100 meters
          let duplicateIdx = -1;
          for (let i = 0; i < metroObjs.length; i++) {
            const existing = metroObjs[i];
            if (existing.type === 'metro_station') {
              const dist = this.getDistanceMeters(
                [coordinates[0], coordinates[1]],
                [existing.coordinates[0], existing.coordinates[1]]
              );
              if (dist < 100) {
                duplicateIdx = i;
                break;
              }
            }
          }

          if (duplicateIdx !== -1) {
            const existingObj = metroObjs[duplicateIdx];
            const newName = tags.name;
            if (newName && (!existingObj.name || existingObj.name.includes('Subway Station') || existingObj.name === 'N/A')) {
              existingObj.name = newName;
              existingObj.stationName = newName;
            }
            continue;
          }

          const stationObj = {
            id,
            type: 'metro_station' as const,
            name: tags.name || `Subway Station ${el.id}`,
            layerId: 'metro',
            scenarioId: activeScenarioId,
            coordinates,
            stationName: tags.name || `Subway Station ${el.id}`,
            length: 140,
            width: 20,
            height: 8,
            elevation: 12,
            capacity: 25000,
            createdAt: new Date().toISOString(),
            updatedAt: new Date().toISOString()
          };

          metroObjs.push(stationObj);
          stationsCount++;
        } else {
          if (el.type !== 'way' || !el.geometry || el.geometry.length < 2) continue;

          // Double check tags to filter out arbitrary railway=construction
          const isSubway = tags.railway === 'subway';
          const isConstructionSubway = tags.railway === 'construction' && tags.construction === 'subway';

          if (!isSubway && !isConstructionSubway) continue;

          const status = isSubway ? 'operational' : 'under_construction';

          // Elevated metro track default height = 12m (above ground)
          const coordinates = el.geometry.map((pt: any) => [pt.lon, pt.lat, 12]);

          const lineObj = {
            id,
            type: 'metro_line' as const,
            name: tags.name || `Metro Line ${tags.ref || el.id}`,
            layerId: 'metro',
            scenarioId: activeScenarioId,
            coordinates,
            trackCount: 2,
            trackGauge: 1.435,
            deckWidth: 8.0,
            elevation: 12,
            pierSpacing: 30,
            status,
            tags: tags as Record<string, string>,
            createdAt: new Date().toISOString(),
            updatedAt: new Date().toISOString()
          };

          metroObjs.push(lineObj);
          linesCount++;
        }
      }

      if (metroObjs.length > 0) {
        this.historyManager?.recordAdd?.(metroObjs, `Import ${metroObjs.length} OSM Metro objects`);
        this.objectManager.addMultiple(metroObjs);
      }
      return { lines: linesCount, stations: stationsCount };
    } catch (err) {
      console.error("OSM Metro Import failed:", err);
      throw err;
    } finally {
      this.setIsImporting(false);
      this.notify();
    }
  }

  private async fetchFromOverpass(query: string): Promise<any> {
    this.importAbort ??= new AbortController();
    return this.overpass.query(query, this.importAbort.signal);
  }

  /** Cancels an in-flight OSM import (the Cancel button on the import overlay). */
  public cancelImport() {
    this.importAbort?.abort();
  }
}

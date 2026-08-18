import type { CityObject, RoadClassification, BuildingUsage, UtilityType, Area, BuildingCategory } from '../objects/types';
import { ObjectManager } from '../objects/ObjectManager';
import { HistoryManager } from '../history/HistoryManager';

export type EditingMode = 'select' | 'draw_road' | 'draw_building' | 'draw_junction' | 'draw_utility' | 'draw_flyover' | 'draw_metro' | 'place_station' | 'import_osm' | 'draw_zone' | 'draw_gateway' | 'draw_metro_flyover';

export class EditingEngine {
  private activeMode: EditingMode = 'select';
  private drawingPoints: [number, number, number][] = [];
  private isImporting: boolean = false;
  private savedAreas: Area[] = [];
  private areasAPI_URL = 'http://localhost:8000/api/areas';
  
  // Selected creation types
  public roadClass: RoadClassification = 'local';
  public buildingUsage: BuildingUsage = 'residential';
  public utilityType: UtilityType = 'water';

  public getIsImporting(): boolean {
    return this.isImporting;
  }

  public setIsImporting(val: boolean) {
    if (this.isImporting !== val) {
      this.isImporting = val;
      this.notify();
    }
  }

  private onChangeListeners: (() => void)[] = [];
  private objectManager: ObjectManager;
  private historyManager: HistoryManager;
  private getNetwork?: () => any;

  constructor(
    objectManager: ObjectManager,
    historyManager: HistoryManager,
    getNetwork?: () => any
  ) {
    this.objectManager = objectManager;
    this.historyManager = historyManager;
    this.getNetwork = getNetwork;
    this.fetchSavedAreas();
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

  public setMode(mode: EditingMode) {
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
    // Snap logic would go here: compare to other nearby coordinates
    const snapped = this.snapToGrid(point);
    this.drawingPoints.push(snapped);
    this.notify();
  }

  public clearDrawing() {
    this.drawingPoints = [];
    this.notify();
  }

  public cancelDrawing() {
    this.clearDrawing();
    this.setMode('select');
  }

  private snapToGrid(point: [number, number, number]): [number, number, number] {
    // Basic helper: Snap to nearest other object point within a threshold
    const objects = this.objectManager.getAll();
    const snapDistanceThreshold = 0.0001; // roughly 10 meters in lat/lng coordinates

    for (const obj of objects) {
      if (obj.type === 'junction') {
        const dist = this.getDistance(point, obj.coordinates);
        if (dist < snapDistanceThreshold) {
          return [...obj.coordinates] as [number, number, number];
        }
      } else if (obj.type === 'road' || obj.type === 'building' || obj.type === 'utility') {
        for (const coord of obj.coordinates) {
          const dist = this.getDistance(point, coord);
          if (dist < snapDistanceThreshold) {
            return [...coord] as [number, number, number];
          }
        }
      }
    }
    return point;
  }

  private getDistance(p1: [number, number, number], p2: [number, number, number]): number {
    const dx = p1[0] - p2[0];
    const dy = p1[1] - p2[1];
    return Math.sqrt(dx * dx + dy * dy);
  }

  public finalizeDrawing(scenarioId: string) {
    if (this.drawingPoints.length === 0) return;

    // Push history snapshot before modifying objects
    this.historyManager.pushState(this.objectManager.getAll());

    const id = Math.random().toString(36).substr(2, 9);
    const createdAt = new Date().toISOString();
    const name = `${this.activeMode.split('_')[1].toUpperCase()} #${id.slice(0, 4)}`;

    let newObj: CityObject | null = null;

    if (this.activeMode === 'draw_road') {
      if (this.drawingPoints.length < 2) return;
      newObj = {
        id,
        type: 'road',
        name,
        layerId: 'roads',
        scenarioId,
        coordinates: [...this.drawingPoints],
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
    } else if (this.activeMode === 'draw_building') {
      if (this.drawingPoints.length < 3) return;
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
      if (this.drawingPoints.length < 2) return;
      newObj = {
        id,
        type: 'utility',
        name,
        layerId: `${this.utilityType}_util`,
        scenarioId,
        coordinates: [...this.drawingPoints],
        utilityType: this.utilityType,
        depth: 1.5,
        capacity: 100,
        createdAt,
        updatedAt: createdAt
      };
    } else if (this.activeMode === 'draw_flyover') {
      if (this.drawingPoints.length < 2) return;
      newObj = {
        id,
        type: 'flyover',
        name: `Flyover #${id.slice(0, 4)}`,
        layerId: 'roads',
        scenarioId,
        coordinates: [...this.drawingPoints],
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
    } else if (this.activeMode === 'draw_metro_flyover') {
      if (this.drawingPoints.length < 2) return;
      newObj = {
        id,
        type: 'metro_flyover',
        name: `Metro-Flyover #${id.slice(0, 4)}`,
        layerId: 'roads',
        scenarioId,
        coordinates: [...this.drawingPoints],
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
    } else if (this.activeMode === 'draw_metro') {
      if (this.drawingPoints.length < 2) return;
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
      this.objectManager.add(newObj);
    }
    
    this.clearDrawing();
    this.setMode('select');
  }

  public getSavedAreas(): Area[] {
    return this.savedAreas;
  }

  public async fetchSavedAreas(): Promise<void> {
    try {
      const res = await fetch(this.areasAPI_URL);
      if (res.ok) {
        this.savedAreas = await res.json();
        this.notify();
      }
    } catch (e) {
      console.warn("Backend areas endpoint offline:", e);
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

    const res = await fetch(this.areasAPI_URL, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(areaObj)
    });

    if (!res.ok) {
      throw new Error("Failed to save area in backend database.");
    }

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

      const res = await fetch(`${this.areasAPI_URL}/${id}`, {
        method: 'DELETE'
      });
      if (res.ok) {
        this.savedAreas = this.savedAreas.filter(a => a.id !== id);

        if (deleteAssociatedData) {
          const allObjects = this.objectManager.getAll();
          const objsToDelete = allObjects.filter(obj => this.isObjectInArea(obj, area));
          this.objectManager.deleteMultiple(objsToDelete);
        }

        this.notify();
      }
    } catch (e) {
      console.warn("Failed to delete area in backend:", e);
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

  public async importOSMRoadsInsideArea(area: Area, activeScenarioId: string): Promise<number> {
    this.setIsImporting(true);
    try {
      const polyCoords = area.polygonCoordinates.map(pt => `${pt[1]} ${pt[0]}`).join(' ');
      const query = `[out:json][timeout:50];way["highway"](poly:"${polyCoords}");out geom;`;
      const data = await this.fetchFromOverpass(query);
      if (!data || !data.elements) return 0;

      let count = 0;
      const roadObjs: any[] = [];
      for (const el of data.elements) {
        if (el.type !== 'way' || !el.geometry || el.geometry.length < 2) continue;

        const id = `osm_${el.id}`;
        const tags = el.tags || {};
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
          scenarioId: activeScenarioId,
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
        count++;
      }

      this.objectManager.addMultiple(roadObjs);
      return count;
    } catch (err) {
      console.error("OSM Import failed:", err);
      throw err;
    } finally {
      this.setIsImporting(false);
      this.notify();
    }
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

      this.objectManager.addMultiple(buildingObjs);
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

      this.objectManager.addMultiple(metroObjs);
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
    const endpoints = [
      'https://overpass-api.de/api/interpreter',
      'https://overpass.kumi.systems/api/interpreter',
      'https://overpass.osm.ch/api/interpreter'
    ];

    let lastError: any = null;
    for (const endpoint of endpoints) {
      try {
        console.log(`[Overpass] Querying endpoint: ${endpoint}`);
        const url = `${endpoint}?data=${encodeURIComponent(query)}`;
        const response = await fetch(url, {
          headers: {
            'Accept': 'application/json'
          }
        });
        if (response.ok) {
          const data = await response.json();
          if (data && data.remark && data.remark.includes('timeout')) {
            throw new Error(`Overpass server returned busy/timeout: ${data.remark}`);
          }
          return data;
        }
        throw new Error(`HTTP Error ${response.status}: ${response.statusText}`);
      } catch (err) {
        console.warn(`[Overpass] Attempt failed on ${endpoint}:`, err);
        lastError = err;
      }
    }
    throw lastError || new Error("All Overpass API endpoints failed.");
  }
}

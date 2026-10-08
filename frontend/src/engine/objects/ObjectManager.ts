import type { CityObject, RoadObject, RoadSectionProfile, CarriagewayProfile, RoadsideProfile } from './types';
import { applyFlyoverElevationProfile } from './flyoverHelper';
import { bridgeGeometry } from './bridgeElevation';
import { remapRoadSections, repairRoadSections } from './roadSections';
import { cacheGetMany, cachePutMany } from '../storage/localCache';
import { BASE_SCENARIO_ID } from '../scenarios/ScenarioManager';
import { apiPost, apiDelete, apiPostBatch, apiDeleteBatch } from '../../lib/api';

/** Objects per save request, and requests in flight at once, when saving many objects. */
const SAVE_CHUNK = 1000;
const SAVES_AT_ONCE = 3;

export class ObjectManager {
  private objects: Map<string, CityObject> = new Map();
  private onChangeListener: ((changedTypes: Set<string>) => void)[] = [];
  /**
   * OpenStreetMap roads the user deleted, kept on this device so that filling
   * in missing OSM roads never brings them back.
   */
  private deletedOsm: Set<string> | null = null;
  private deletedOsmLoad: Promise<Set<string>> | null = null;

  constructor() {}

  private mapToSchema(obj: CityObject) {
    const { id, type, name, layerId, scenarioId, coordinates, ...rest } = obj;
    return {
      id,
      type,
      name,
      layerId,
      scenarioId,
      coordinates,
      properties: rest
    };
  }

  public async syncPost(obj: CityObject) {
    await apiPost('/api/objects', this.mapToSchema(obj));
  }

  public async syncDelete(id: string) {
    await apiDelete(`/api/objects/${id}`);
  }

  public async syncDeleteMultiple(ids: string[]) {
    await apiDeleteBatch('/api/objects', ids);
  }

  public async syncPostMultiple(objs: CityObject[]) {
    await apiPostBatch('/api/objects/batch', objs.map(o => this.mapToSchema(o)));
  }

  /** Ids of OpenStreetMap roads the user deleted. */
  public deletedOsmIds(): Promise<Set<string>> {
    if (this.deletedOsm) return Promise.resolve(this.deletedOsm);
    this.deletedOsmLoad ??= cacheGetMany<string[]>('osm-deleted', ['ids']).then(([ids]) => {
      // Deletions made before the list finished loading are kept too
      this.deletedOsm = new Set([...(ids ?? []), ...(this.deletedOsm ?? [])]);
      return this.deletedOsm;
    });
    return this.deletedOsmLoad;
  }

  private noteOsmDeletions(ids: string[], deleted: boolean) {
    const osm = ids.filter(id => id.startsWith('osm_'));
    if (osm.length === 0) return;
    this.deletedOsm ??= new Set();
    for (const id of osm) {
      if (deleted) this.deletedOsm.add(id);
      else this.deletedOsm.delete(id);
    }
    void cachePutMany('osm-deleted', [['ids', [...this.deletedOsm]]]);
  }

  /**
   * Adds objects (all at once: one update for the map and the network) and
   * waits until the backend has saved them, in chunks, a few at a time.
   * Rejects if any chunk was not saved, so the caller can avoid recording
   * work as done when it is not.
   */
  public async addMultipleAndSave(objs: CityObject[], chunk = SAVE_CHUNK): Promise<void> {
    if (objs.length === 0) return;
    this.addMultiple(objs, true);
    const saved = objs.map(o => this.objects.get(o.id)!).filter(Boolean);
    const chunks: CityObject[][] = [];
    for (let i = 0; i < saved.length; i += chunk) chunks.push(saved.slice(i, i + chunk));
    let nextChunk = 0;
    const worker = async () => {
      while (nextChunk < chunks.length) await this.syncPostMultiple(chunks[nextChunk++]);
    };
    await Promise.all(Array.from({ length: Math.min(SAVES_AT_ONCE, chunks.length) }, worker));
  }

  public onChange(callback: (changedTypes: Set<string>) => void) {
    this.onChangeListener.push(callback);
    return () => {
      this.onChangeListener = this.onChangeListener.filter(cb => cb !== callback);
    };
  }

  public notify(changedTypes?: Set<string>) {
    const types = changedTypes || new Set<string>();
    this.onChangeListener.forEach(cb => cb(types));
  }

  /**
   * Raises imported OSM bridges and flyovers to deck height (in memory; see
   * bridgeElevation). Changed roads are stored as new objects, as with any
   * update, so the renderer redraws them.
   */
  public liftBridges() {
    bridgeGeometry(this.objects.values()).forEach(({ coordinates, originalIndices }, road) => {
      const sections = remapRoadSections(repairRoadSections(road), road.coordinates, coordinates, originalIndices);
      this.objects.set(road.id, { ...road, coordinates, sections });
    });
  }

  public getAll(): CityObject[] {
    return Array.from(this.objects.values());
  }

  public getById(id: string): CityObject | undefined {
    return this.objects.get(id);
  }

  public getByScenario(scenarioId: string): CityObject[] {
    return this.getAll().filter(obj => obj.scenarioId === scenarioId);
  }

  public syncRoadProperties(road: RoadObject) {
    road.sections = repairRoadSections(road);
    if (road.sections.length === 0) {
      road.sections = this.synthesizeDefaultSections(road);
    }
    if (!road.sourceCoordinates) {
      road.sourceCoordinates = road.coordinates.map(point => [...point] as [number, number, number]);
    }
    
    const sec = road.sections[0];
    const carriagewayA = sec.carriagewayA;
    const carriagewayB = sec.carriagewayB;
    
    // Derive top-level fields
    road.laneCount = carriagewayA.lanes + (carriagewayB?.lanes || 0);
    road.isOneWay = !carriagewayB || carriagewayB.lanes === 0;
    
    const totalLanesWidth = (carriagewayA.lanes * carriagewayA.laneWidth) + (carriagewayB ? carriagewayB.lanes * carriagewayB.laneWidth : 0);
    const medianWidth = sec.hasMedian ? sec.medianWidth : 0;
    const leftFootpath = carriagewayA.leftRoadside.footpathWidth || 0;
    const rightFootpath = carriagewayB ? (carriagewayB.rightRoadside.footpathWidth || 0) : (carriagewayA.rightRoadside.footpathWidth || 0);
    
    road.width = totalLanesWidth + medianWidth + leftFootpath + rightFootpath;
    road.dividerWidth = medianWidth;
    road.hasDivider = sec.hasMedian;
    road.hasFootpath = leftFootpath > 0 || rightFootpath > 0;
    road.footpathWidth = Math.max(leftFootpath, rightFootpath);
    road.trafficCapacity = road.laneCount * 1000;
  }

  public synthesizeDefaultSections(road: RoadObject): RoadSectionProfile[] {
    const laneWidth = road.laneWidth || 3.5;
    const laneCount = road.laneCount || 2;
    const dividerWidth = road.dividerWidth || 0;
    const hasDivider = road.hasDivider || (dividerWidth > 0);
    const hasFootpath = road.hasFootpath || false;
    const footpathWidth = road.footpathWidth || 1.5;

    // Divide lanes among A and B
    let lanesA = laneCount;
    let lanesB = 0;
    
    if (!road.isOneWay) {
      lanesA = Math.ceil(laneCount / 2);
      lanesB = Math.floor(laneCount / 2);
      if (lanesB === 0 && laneCount > 1) {
        lanesB = 1;
        lanesA = laneCount - 1;
      }
    }

    const leftRoadside: RoadsideProfile = {
      footpathWidth: hasFootpath ? footpathWidth : 0,
      cycleTrackWidth: 0,
      vergeWidth: 0,
      parkingWidth: 0,
      drainageWidth: 0
    };

    const rightRoadside: RoadsideProfile = {
      footpathWidth: (hasFootpath && !hasDivider && lanesB > 0) || (hasFootpath && hasDivider) ? footpathWidth : 0,
      cycleTrackWidth: 0,
      vergeWidth: 0,
      parkingWidth: 0,
      drainageWidth: 0
    };

    const carriagewayA: CarriagewayProfile = {
      direction: road.isOneWay ? 'forward' : 'both',
      lanes: lanesA,
      laneWidth,
      leftRoadside: leftRoadside,
      rightRoadside: { footpathWidth: 0, cycleTrackWidth: 0, vergeWidth: 0, parkingWidth: 0, drainageWidth: 0 }
    };

    let carriagewayB: CarriagewayProfile | undefined = undefined;
    if (lanesB > 0) {
      carriagewayB = {
        direction: 'backward',
        lanes: lanesB,
        laneWidth,
        leftRoadside: { footpathWidth: 0, cycleTrackWidth: 0, vergeWidth: 0, parkingWidth: 0, drainageWidth: 0 },
        rightRoadside: rightRoadside
      };
    } else if (!hasDivider && !road.isOneWay) {
      // If undivided two-way, left and right roadsides apply to carriagewayA
      carriagewayA.rightRoadside = rightRoadside;
    } else if (road.isOneWay) {
      // One-way: left and right roadsides apply to carriagewayA
      carriagewayA.rightRoadside = rightRoadside;
    }

    const defaultSection: RoadSectionProfile = {
      startNodeIndex: 0,
      endNodeIndex: Math.max(0, road.coordinates.length - 1),
      totalRowWidth: road.width || (laneCount * laneWidth + dividerWidth + (hasFootpath ? footpathWidth * 2 : 0)),
      wideningPossible: true,
      hasMedian: hasDivider,
      medianWidth: dividerWidth,
      carriagewayA,
      carriagewayB,
      reservedSpaces: [],
      provenance: {
        originalSource: 'OSM',
        originalConfidence: 'estimated',
        geometryModified: false,
        profileModified: false,
        lastModifiedBy: 'importer',
        verificationStatus: 'unverified'
      }
    };

    return [defaultSection];
  }

  public add(obj: CityObject, skipSync = false) {
    let fresh = {
      ...obj,
      createdAt: obj.createdAt || new Date().toISOString(),
      updatedAt: new Date().toISOString(),
    } as CityObject;

    if (fresh.type === 'road') {
      this.syncRoadProperties(fresh as RoadObject);
    } else if (fresh.type === 'flyover' || fresh.type === 'metro_flyover') {
      applyFlyoverElevationProfile(fresh);
    }

    this.objects.set(obj.id, fresh);
    if (this.deletedOsm?.has(obj.id)) this.noteOsmDeletions([obj.id], false);
    this.notify(new Set([fresh.type]));
    if (!skipSync) {
      this.syncPost(fresh).catch((e) => {
        console.warn('[ObjectManager] syncPost failed — connectionState updated:', e);
        (window as any).showToast?.('Save failed: Unable to sync with backend server', 'error');
      });
    }
  }

  public addMultiple(objs: CityObject[], skipSync = false) {
    const freshObjs = objs.map(obj => {
      let fresh = {
        ...obj,
        createdAt: obj.createdAt || new Date().toISOString(),
        updatedAt: new Date().toISOString(),
      } as CityObject;

      if (fresh.type === 'road') {
        this.syncRoadProperties(fresh as RoadObject);
      } else if (fresh.type === 'flyover' || fresh.type === 'metro_flyover') {
        applyFlyoverElevationProfile(fresh);
      }
      return fresh;
    });

    freshObjs.forEach(obj => {
      this.objects.set(obj.id, obj);
    });
    if (this.deletedOsm && freshObjs.some(o => this.deletedOsm!.has(o.id))) this.noteOsmDeletions(freshObjs.map(o => o.id), false);
    // New OSM bridges get their deck heights, and their approaches may be among these roads
    if (freshObjs.some(o => o.type === 'road' && o.osmProvenance)) this.liftBridges();

    this.notify(new Set(freshObjs.map(o => o.type)));

    if (!skipSync && freshObjs.length > 0) {
      this.syncPostMultiple(freshObjs.map(obj => this.objects.get(obj.id)!)).catch((e) => {
        console.warn('[ObjectManager] syncPostMultiple failed — connectionState updated:', e);
        (window as any).showToast?.('Save failed: Unable to sync batch with backend server', 'error');
      });
    }
  }

  public update(id: string, updates: Partial<CityObject>, skipSync = false) {
    const existing = this.objects.get(id);
    if (!existing) return;

    let updated = {
      ...existing,
      ...updates,
      updatedAt: new Date().toISOString(),
    } as CityObject;

    if (updated.type === 'road') {
      // Explicit sections (undo/redo and section-aware editors) already refer
      // to the supplied geometry. Otherwise carry profiles through the edit.
      if (existing.type === 'road' && updates.coordinates && !Object.hasOwn(updates, 'sections')) {
        updated.sections = remapRoadSections(existing.sections ?? [], existing.coordinates, updated.coordinates);
      }
      this.syncRoadProperties(updated as RoadObject);
    } else if (updated.type === 'flyover' || updated.type === 'metro_flyover') {
      applyFlyoverElevationProfile(updated);
    }

    this.objects.set(id, updated);
    this.notify(new Set([updated.type]));
    if (!skipSync) {
      this.syncPost(updated).catch((e) => {
        console.warn('[ObjectManager] syncPost (update) failed — connectionState updated:', e);
        (window as any).showToast?.('Save failed: Unable to sync update with backend server', 'error');
      });
    }
  }

  public delete(id: string, skipSync = false) {
    const existing = this.objects.get(id);
    if (existing) {
      this.objects.delete(id);
      if (existing.scenarioId === BASE_SCENARIO_ID) this.noteOsmDeletions([id], true);
      this.notify(new Set([existing.type]));
      if (!skipSync) {
        this.syncDelete(id).catch((e) => {
          console.warn('[ObjectManager] syncDelete failed — connectionState updated:', e);
          (window as any).showToast?.('Delete failed: Unable to sync with backend server', 'error');
        });
      }
    }
  }

  public deleteMultiple(objs: CityObject[], skipSync = false) {
    let changed = false;
    const idsToSync: string[] = [];

    objs.forEach(obj => {
      if (this.objects.has(obj.id)) {
        this.objects.delete(obj.id);
        idsToSync.push(obj.id);
        changed = true;
      }
    });

    if (changed) {
      this.noteOsmDeletions(objs.filter(o => o.scenarioId === BASE_SCENARIO_ID).map(o => o.id), true);
      this.notify(new Set(objs.map(o => o.type)));
      if (!skipSync && idsToSync.length > 0) {
        this.syncDeleteMultiple(idsToSync).catch((e) => {
          console.warn('[ObjectManager] syncDeleteMultiple failed — connectionState updated:', e);
          (window as any).showToast?.('Delete failed: Unable to sync with backend server', 'error');
        });
      }
    }
  }

  public clear() {
    this.objects.clear();
    this.notify(new Set(['road', 'building', 'junction', 'flyover', 'utility', 'metro_line', 'metro_station', 'zone', 'gateway', 'metro_flyover']));
  }

  public loadFromGeoJSON(geojson: any, scenarioId: string) {
    // Basic import utility for GeoJSON
    if (!geojson || geojson.type !== 'FeatureCollection') return;
    
    geojson.features.forEach((feature: any) => {
      const props = feature.properties || {};
      const type = props.type || 'building';
      const id = feature.id || props.id || Math.random().toString(36).substr(2, 9);
      
      let coordinates: any;
      if (feature.geometry.type === 'Point') {
        coordinates = feature.geometry.coordinates; // [lng, lat, alt]
      } else if (feature.geometry.type === 'LineString') {
        coordinates = feature.geometry.coordinates; // [[lng, lat, alt], ...]
      } else if (feature.geometry.type === 'Polygon') {
        coordinates = feature.geometry.coordinates[0]; // Ring [[lng, lat, alt], ...]
      }

      const baseObj = {
        id,
        type,
        name: props.name || `${type.charAt(0).toUpperCase() + type.slice(1)} #${id.slice(0, 4)}`,
        layerId: props.layerId || `${type}s`,
        scenarioId,
        coordinates,
        createdAt: new Date().toISOString(),
        updatedAt: new Date().toISOString(),
      };

      if (type === 'road') {
        this.add({
          ...baseObj,
          type: 'road',
          roadClass: props.roadClass || 'local',
          width: props.width || 8,
          laneCount: props.laneCount || 2,
          laneWidth: props.laneWidth || 3.5,
          hasDivider: props.hasDivider ?? false,
          dividerWidth: props.dividerWidth || 2.0,
          hasFootpath: props.hasFootpath ?? true,
          footpathWidth: props.footpathWidth || 1.5,
          speedLimit: props.speedLimit || 50,
          isOneWay: props.isOneWay ?? false,
          trafficCapacity: props.trafficCapacity || 1200,
          connectedJunctions: props.connectedJunctions || [],
        });
      } else if (type === 'building') {
        const usageType = props.usageType || 'residential';
        const floors = props.floors || 4;
        const population = props.population || 40;
        this.add({
          ...baseObj,
          type: 'building',
          usageType,
          height: props.height || 15,
          floors,
          population,
          parkingSpaces: props.parkingSpaces || 10,
          waterDemand: props.waterDemand || 6000,
          electricityDemand: props.electricityDemand || 240,
          constructionYear: props.constructionYear || 2020,
          
          // Planning properties
          category: props.category || (usageType === 'commercial' ? 'commercial' : 'residential'),
          state: props.state || 'existing',
          source: props.source || 'municipal',
          residents: props.residents ?? (usageType === 'residential' ? population : 0),
          employees: props.employees ?? (usageType === 'commercial' ? Math.round(population * 0.8) : 0),
          parkingCapacity: props.parkingCapacity ?? (props.parkingSpaces || 10)
        });
      } else if (type === 'junction') {
        this.add({
          ...baseObj,
          type: 'junction',
          coordinates: coordinates as [number, number, number],
          connectedRoads: props.connectedRoads || [],
          hasSignals: props.hasSignals ?? true,
          signalTiming: props.signalTiming || 90,
          hasPedestrianCrossing: props.hasPedestrianCrossing ?? true,
        });
      } else if (type === 'flyover') {
        this.add({
          ...baseObj,
          type: 'flyover',
          roadClass: props.roadClass || 'arterial',
          width: props.width || 19,
          laneCount: props.laneCount || 4,
          laneWidth: props.laneWidth || 3.5,
          hasDivider: props.hasDivider ?? true,
          dividerWidth: props.dividerWidth || 2.0,
          hasFootpath: props.hasFootpath ?? true,
          footpathWidth: props.footpathWidth || 1.5,
          speedLimit: props.speedLimit || 80,
          isOneWay: props.isOneWay ?? false,
          elevation: props.elevation || 6.0,
          pierSpacing: props.pierSpacing || 30.0,
        });
      } else if (type === 'utility') {
        this.add({
          ...baseObj,
          type: 'utility',
          utilityType: props.utilityType || 'water',
          depth: props.depth || 1.5,
          capacity: props.capacity || 100,
        });
      }
    });
  }
}

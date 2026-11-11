import type { CityObject, RoadObject, RoadSectionProfile, CarriagewayProfile, RoadsideProfile } from './types';
import { applyFlyoverElevationProfile } from './flyoverHelper';
import { bridgeGeometry } from './bridgeElevation';
import { remapRoadSections, repairRoadSections } from './roadSections';
import { cacheGetMany, cachePutMany } from '../storage/localCache';
import { BASE_SCENARIO_ID } from '../scenarios/ScenarioManager';
import { apiPost, apiDelete, apiPostBatch, apiDeleteBatch } from '../../lib/api';

/** One entry of a proposal's change set as the backend returns it (docs/SCENARIOS_AND_VERSIONING.md). */
export interface ScenarioChange {
  objectId: string;
  op: 'add' | 'modify' | 'delete';
  scenarioId?: string;
  seq?: number;
  object?: { id: string; type: string; name: string; layerId: string; scenarioId?: string; coordinates: any; properties: Record<string, any> };
}
/** A write to a proposal's change set: its version of a base object, a tombstone, or back to the baseline's. */
export interface ChangeWrite { objectId: string; op: 'modify' | 'delete' | 'revert'; object?: ReturnType<ObjectManager['schemaOf']> }

/** Content of an object for comparing with the baseline's (its edit times and owning scenario left out). */
function contentKey(o: CityObject): string {
  return JSON.stringify(o, function (this: any, k, v) {
    if ((k === 'updatedAt' || k === 'scenarioId') && this && typeof this === 'object' && 'type' in this) return undefined;
    if (v && typeof v === 'object' && !Array.isArray(v)) return Object.fromEntries(Object.keys(v).sort().map(x => [x, v[x]]));
    return v;
  });
}
const ownerOf = (o: CityObject) => o.scenarioId ?? BASE_SCENARIO_ID;
import { BridgeFeasibilityEngine } from '../simulation/BridgeFeasibilityEngine';

/** Objects per save request, and requests in flight at once, when saving many objects. */
const SAVE_CHUNK = 1000;
const SAVES_AT_ONCE = 3;

/**
 * The city's objects, and the scenarios layered on them (docs/SCENARIOS_AND_VERSIONING.md).
 *
 * `objects` holds the baseline ('base') and every proposal's own objects (its adds), keyed by id, as stored in
 * city_objects. `overlays` holds each proposal's changes to baseline objects, keyed by the base id: its version
 * of the object (modify) or null (delete, a tombstone). The baseline rows are never changed while a proposal is
 * active: an edit of a base object there is copied on write into the proposal's overlay.
 *
 * getAll()/getById() show the active scenario's materialised view: baseline ⊕ the active proposal's changes.
 */
export class ObjectManager {
  private objects: Map<string, CityObject> = new Map();
  private overlays: Map<string, Map<string, CityObject | null>> = new Map();
  private scenarioSource: () => string = () => BASE_SCENARIO_ID;
  private onChangeListener: ((changedTypes: Set<string>) => void)[] = [];
  /**
   * OpenStreetMap roads the user deleted, kept on this device so that filling
   * in missing OSM roads never brings them back.
   */
  private deletedOsm: Set<string> | null = null;
  private deletedOsmLoad: Promise<Set<string>> | null = null;

  constructor() {}

  /** Where the active scenario comes from (the engine's ScenarioManager); tests set one with setActiveScenario. */
  public setScenarioSource(source: () => string) { this.scenarioSource = source; }
  public setActiveScenario(id: string) { this.scenarioSource = () => id; this.notify(); }
  public getActiveScenarioId(): string { return this.scenarioSource() || BASE_SCENARIO_ID; }

  public schemaOf(obj: CityObject) { return this.mapToSchema(obj); }

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

  /** Writes changes of a proposal to base objects (POST /api/scenarios/{id}/changes). Base rows are not written. */
  public async syncChanges(scenarioId: string, changes: ChangeWrite[]) {
    if (changes.length === 0) return;
    await apiPost(`/api/scenarios/${encodeURIComponent(scenarioId)}/changes`, changes);
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

  /** OSM way ids held as roads, whole or as pieces cut at a study-area boundary. */
  public osmWayIdsPresent(): Set<number> {
    const ids = new Set<number>();
    for (const o of this.objects.values()) if (o.type === 'road' && o.osmProvenance) ids.add(Number(o.osmProvenance.osmId));
    return ids;
  }

  /** The active scenario's objects: the baseline with the active proposal's changes applied, and its own objects. */
  public getAll(): CityObject[] {
    return this.viewOf(this.getActiveScenarioId());
  }

  /** What a scenario shows (baseline ⊕ its change set), whichever scenario is active. */
  public viewOf(scenarioId: string): CityObject[] {
    const out: CityObject[] = [];
    if (scenarioId === BASE_SCENARIO_ID) {
      for (const o of this.objects.values()) if (ownerOf(o) === BASE_SCENARIO_ID) out.push(o);
      return out;
    }
    const overlay = this.overlays.get(scenarioId);
    for (const o of this.objects.values()) {
      const owner = ownerOf(o);
      if (owner === scenarioId) out.push(o);
      else if (owner === BASE_SCENARIO_ID) {
        const ov = overlay?.get(o.id);
        if (ov === undefined) out.push(o);
        else if (ov !== null) out.push(ov);
      }
    }
    return out;
  }

  /** Every stored object of every scenario (the baseline, and each proposal's own objects), without overlays. */
  public getAllStored(): CityObject[] {
    return Array.from(this.objects.values());
  }

  /** The object with this id as the active scenario shows it (undefined when it is another proposal's or deleted here). */
  public getById(id: string): CityObject | undefined {
    const o = this.objects.get(id);
    if (!o) return undefined;
    const active = this.getActiveScenarioId(), owner = ownerOf(o);
    if (active === BASE_SCENARIO_ID) return owner === BASE_SCENARIO_ID ? o : undefined;
    if (owner === active) return o;
    if (owner !== BASE_SCENARIO_ID) return undefined;
    const ov = this.overlays.get(active)?.get(id);
    return ov === undefined ? o : ov ?? undefined;
  }

  public getByScenario(scenarioId: string): CityObject[] {
    return this.getAllStored().filter(obj => obj.scenarioId === scenarioId);
  }

  /** The proposal's changes to baseline objects: id → its version, or null for a tombstone. */
  public overlayOf(scenarioId: string): ReadonlyMap<string, CityObject | null> {
    return this.overlays.get(scenarioId) ?? new Map();
  }

  /** Whether a change to this id in the active scenario is a change to a baseline object inside a proposal. */
  private copyOnWrite(id: string): string | null {
    const active = this.getActiveScenarioId();
    if (active === BASE_SCENARIO_ID) return null;
    const o = this.objects.get(id);
    return o && ownerOf(o) === BASE_SCENARIO_ID ? active : null;
  }

  private overlayFor(scenarioId: string) {
    let m = this.overlays.get(scenarioId);
    if (!m) this.overlays.set(scenarioId, (m = new Map()));
    return m;
  }

  /**
   * The proposal's version of a base object. An object with the baseline's content (Undo back to it, or an edit
   * undone by hand) drops the change, so the proposal shows the baseline object itself again.
   */
  private putOverride(scenarioId: string, obj: CityObject, skipSync: boolean): CityObject {
    const base = this.objects.get(obj.id)!;
    const overlay = this.overlayFor(scenarioId);
    let shown: CityObject;
    let write: ChangeWrite;
    if (contentKey(obj) === contentKey(base)) {
      overlay.delete(obj.id);
      shown = base;
      write = { objectId: obj.id, op: 'revert' };
    } else {
      shown = { ...obj, scenarioId } as CityObject;
      overlay.set(obj.id, shown);
      write = { objectId: obj.id, op: 'modify', object: this.mapToSchema(shown) };
    }
    if (!skipSync) this.reportSync(this.syncChanges(scenarioId, [write]), 'Save failed: Unable to sync the proposal\'s change with backend server');
    return shown;
  }

  private putTombstones(scenarioId: string, ids: string[], skipSync: boolean) {
    const overlay = this.overlayFor(scenarioId);
    for (const id of ids) overlay.set(id, null);
    if (!skipSync && ids.length) this.reportSync(this.syncChanges(scenarioId, ids.map(objectId => ({ objectId, op: 'delete' as const }))), 'Delete failed: Unable to sync the proposal\'s change with backend server');
  }

  private reportSync(p: Promise<unknown>, message: string) {
    p.catch((e) => {
      console.warn('[ObjectManager] scenario change sync failed:', e);
      (globalThis as any).window?.showToast?.(message, 'error');
    });
  }

  /** Puts in the changes of proposals loaded from the backend (GET /api/scenario-changes); nothing is saved. */
  public loadChanges(changes: readonly ScenarioChange[]) {
    for (const c of changes) {
      const sid = c.scenarioId;
      if (!sid || sid === BASE_SCENARIO_ID) continue;
      if (c.op === 'delete') this.overlayFor(sid).set(c.objectId, null);
      else if (c.op === 'modify' && c.object) this.overlayFor(sid).set(c.objectId, this.unpack(c.object, sid));
    }
  }

  /** A stored row (id, type, name, layerId, coordinates, properties) as an object of `scenarioId`. */
  public unpack(row: NonNullable<ScenarioChange['object']>, scenarioId: string): CityObject {
    const now = new Date().toISOString();
    const o = { createdAt: now, updatedAt: now, ...row.properties, id: row.id, type: row.type, name: row.name, layerId: row.layerId, scenarioId, coordinates: row.coordinates } as CityObject;
    if (o.type === 'road') this.syncRoadProperties(o as RoadObject);
    return o;
  }

  /**
   * Makes a proposal's state exactly `changes` (after a restore or a duplicate made by the backend): its own
   * objects and its overlay are replaced; the baseline is untouched. Nothing is saved (the backend already has it).
   */
  public replaceScenarioState(scenarioId: string, changes: readonly ScenarioChange[]) {
    if (scenarioId === BASE_SCENARIO_ID) throw new Error('The baseline has no change set');
    const types = new Set<string>();
    for (const o of [...this.objects.values()]) if (o.scenarioId === scenarioId) { this.objects.delete(o.id); types.add(o.type); }
    for (const o of this.overlays.get(scenarioId)?.values() ?? []) if (o) types.add(o.type);
    this.overlays.delete(scenarioId);
    for (const c of changes) {
      if (c.op === 'add' && c.object) { const o = this.unpack(c.object, scenarioId); this.objects.set(o.id, o); types.add(o.type); }
      else if (c.op === 'modify' && c.object) { const o = this.unpack(c.object, scenarioId); this.overlayFor(scenarioId).set(o.id, o); types.add(o.type); }
      else if (c.op === 'delete') { this.overlayFor(scenarioId).set(c.objectId, null); const b = this.objects.get(c.objectId); if (b) types.add(b.type); }
    }
    this.notify(types.size ? types : undefined);
  }

  /** Forgets a deleted proposal's objects and changes (the backend already removed them). */
  public dropScenario(scenarioId: string): number {
    const own = this.getAllStored().filter(o => o.scenarioId === scenarioId);
    const n = own.length + (this.overlays.get(scenarioId)?.size ?? 0);
    this.overlays.delete(scenarioId);
    if (own.length) this.deleteMultiple(own, true);
    else this.notify();
    return n;
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
    // A drawn flyover's ramps take a share of the surface road's capacity (BridgeFeasibilityEngine): kept through every
    // later edit and reload of the road, not reset by them (docs/OVERHAUL.md §27)
    const cut = road.flyoverImpact?.capacityReductionPercent ?? 0;
    road.trafficCapacity = cut > 0 ? Math.round(road.laneCount * 1000 * (1 - cut / 100)) : road.laneCount * 1000;
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

  /**
   * Bridge feasibility checks of a flyover (on its ground-level path, before its elevation profile) against the
   * surface roads, and the capacity reduction each impacted surface road takes (ramp merge): the flyover with its
   * `feasibilityResult` and `surfaceRoadIds`, and for each impacted road the fields to update. Nothing is changed.
   */
  public flyoverFeasibility(obj: CityObject): { flyover: Partial<CityObject>; roadUpdates: { id: string; updates: Partial<RoadObject> }[] } {
    const flyover = { ...obj } as any;
    if (!flyover.groundCoordinates) applyFlyoverElevationProfile(flyover);
    const groundCoords: [number, number, number][] = flyover.groundCoordinates && flyover.groundCoordinates.length > 1
      ? flyover.groundCoordinates
      : flyover.coordinates;
    const surfaceRoads = Array.from(this.objects.values()).filter(o => o.type === 'road') as RoadObject[];
    const feasibility = new BridgeFeasibilityEngine().run(groundCoords, flyover.elevation ?? 6.0, flyover.laneCount ?? 4, surfaceRoads);
    const roadUpdates: { id: string; updates: Partial<RoadObject> }[] = [];
    for (const impact of feasibility.surfaceRoadImpacts) {
      if (!this.objects.has(impact.roadId)) continue;
      roadUpdates.push({ id: impact.roadId, updates: {
        trafficCapacity: impact.reducedCapacity,
        flyoverImpact: {
          flyoverId: obj.id,
          flyoverName: obj.name,
          capacityReductionPercent: impact.capacityReductionPercent,
          originalCapacity: impact.originalCapacity,
          reason: impact.reason
        },
      } });
    }
    return { flyover: { feasibilityResult: feasibility, surfaceRoadIds: roadUpdates.map(u => u.id) } as any, roadUpdates };
  }

  public add(obj: CityObject, skipSync = false) {
    const cow = this.copyOnWrite(obj.id);
    let fresh = {
      ...obj,
      createdAt: obj.createdAt || new Date().toISOString(),
      updatedAt: new Date().toISOString(),
    } as CityObject;

    if (fresh.type === 'road') {
      this.syncRoadProperties(fresh as RoadObject);
    } else if (fresh.type === 'flyover' || fresh.type === 'metro_flyover') {
      applyFlyoverElevationProfile(fresh);
      // The checks are worked out once, when the flyover is drawn (flyoverFeasibility); the capacity it takes from the
      // surface roads is applied by the drawing as part of the same Undo step (EditingEngine.finalizeDrawing), not here:
      // changed here, outside the history, Undo left those roads reduced (docs/OVERHAUL.md §27)
      if (!(fresh as any).feasibilityResult) Object.assign(fresh, this.flyoverFeasibility(fresh).flyover);
    }

    if (cow) {
      // Putting a base object back in a proposal (Undo of a delete there), or the proposal's version of it
      this.putOverride(cow, fresh, skipSync);
      this.notify(new Set([fresh.type]));
      return;
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

    const overridden: CityObject[] = [];
    const stored = freshObjs.filter(obj => {
      const cow = this.copyOnWrite(obj.id);
      if (cow) { overridden.push(this.putOverride(cow, obj, skipSync)); return false; }
      return true;
    });
    if (stored.length < freshObjs.length) {
      stored.forEach(obj => this.objects.set(obj.id, obj));
      if (stored.some(o => o.type === 'road' && o.osmProvenance)) this.liftBridges();
      this.notify(new Set(freshObjs.map(o => o.type)));
      if (!skipSync && stored.length > 0) this.syncPostMultiple(stored.map(obj => this.objects.get(obj.id)!)).catch((e) => {
        console.warn('[ObjectManager] syncPostMultiple failed — connectionState updated:', e);
        (window as any).showToast?.('Save failed: Unable to sync batch with backend server', 'error');
      });
      return;
    }
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

  /**
   * Changes an object. `replace` (Undo and Redo) puts back `updates` as the whole object: fields the other version
   * did not have go too (merged, a field an edit added, such as a flyover's impact on a road, stayed after Undo).
   */
  public update(id: string, updates: Partial<CityObject>, skipSync = false, replace = false) {
    const cow = this.copyOnWrite(id);
    const existing = cow ? this.getById(id) : this.objects.get(id);
    if (!existing) return;

    let updated = {
      ...(replace ? {} : existing),
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

    if (cow) {
      // A base object edited in a proposal: copied on write into the proposal, the baseline row stays as it is
      this.putOverride(cow, updated, skipSync);
      this.notify(new Set([updated.type]));
      return;
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
    const cow = this.copyOnWrite(id);
    if (cow) {
      // A base object deleted in a proposal: a tombstone there; the baseline and the device's OSM deletion list keep it
      const shown = this.getById(id);
      if (!shown) return;
      this.putTombstones(cow, [id], skipSync);
      this.notify(new Set([shown.type]));
      return;
    }
    const existing = this.objects.get(id);
    if (existing) {
      this.objects.delete(id);
      if (existing.scenarioId === BASE_SCENARIO_ID) this.noteOsmDeletions([id], true);
      if (existing.type === 'road' && existing.osmProvenance) this.liftBridges();
      this.notify(new Set([existing.type]));
      if (!skipSync) {
        this.syncDelete(id).catch((e) => {
          console.warn('[ObjectManager] syncDelete failed — connectionState updated:', e);
          (window as any).showToast?.('Delete failed: Unable to sync with backend server', 'error');
        });
      }
    }
  }

  /**
   * Removes objects. `recordOsmDeletion` (default) remembers removed OSM roads as deleted by the user, so later
   * loads do not bring them back; undoing an import, or replacing pieces of a way with the whole way, is not a
   * deletion by the user and passes false (docs/OVERHAUL.md §19).
   */
  public deleteMultiple(objs: CityObject[], skipSync = false, recordOsmDeletion = true) {
    let changed = false;
    const idsToSync: string[] = [];
    const active = this.getActiveScenarioId();
    if (active !== BASE_SCENARIO_ID) {
      // Base objects are never removed from the store inside a proposal: the visible ones get tombstones there
      const baseOwned = objs.filter(o => this.copyOnWrite(o.id));
      if (baseOwned.length) {
        const tomb = baseOwned.filter(o => this.getById(o.id));
        if (tomb.length) this.putTombstones(active, tomb.map(o => o.id), skipSync);
        const ids = new Set(baseOwned.map(o => o.id));
        const rest = objs.filter(o => !ids.has(o.id));
        if (rest.length) this.deleteMultiple(rest, skipSync, recordOsmDeletion);
        else if (tomb.length) this.notify(new Set(tomb.map(o => o.type)));
        return;
      }
    }

    objs.forEach(obj => {
      if (this.objects.has(obj.id)) {
        this.objects.delete(obj.id);
        idsToSync.push(obj.id);
        changed = true;
      }
    });

    if (changed) {
      if (recordOsmDeletion) this.noteOsmDeletions(objs.filter(o => o.scenarioId === BASE_SCENARIO_ID).map(o => o.id), true);
      // Heights round what went are worked out again, as when roads are added: an approach to a deleted deck goes
      // back down, and the whole way that replaced a clipped piece gets the heights it has without the piece
      // (worked out with both present, they differed from a direct import's by up to 1 m: docs/OVERHAUL.md §21)
      if (objs.some(o => o.type === 'road' && o.osmProvenance)) this.liftBridges();
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
    this.overlays.clear();
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

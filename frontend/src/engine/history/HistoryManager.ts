import type { CityObject, RoadObject } from '../objects/types';
import type { ObjectManager } from '../objects/ObjectManager';

export type HistoryDiff =
  | {
      type: 'add';
      description?: string;
      objects: CityObject[];
    }
  | {
      type: 'update';
      description?: string;
      id: string;
      before: CityObject;
      after: CityObject;
      /**
       * Heights the app works out itself on every load (bridge decks and their approaches, ObjectManager.liftBridges):
       * kept in memory only, never sent to the backend, which holds the stored points they are worked out from.
       */
      local?: boolean;
    }
  | {
      type: 'delete';
      description?: string;
      objects: CityObject[];
    }
  | {
      type: 'snapshot';
      description?: string;
      before: CityObject[];
      after: CityObject[];
    }
  | {
      // Several diffs that form one user action (e.g. drawing a road that also
      // splits an existing road to create a T-junction). Undone/redone atomically.
      type: 'batch';
      description?: string;
      diffs: HistoryDiff[];
    };

/** Consecutive updates to the same object+field within this window merge into one undo step. */
const COALESCE_WINDOW_MS = 1000;

// Legacy interface preserved for backwards compatibility
export interface HistoryState {
  objectsSnapshot: CityObject[];
}

export class HistoryManager {
  private undoStack: HistoryDiff[] = [];
  private redoStack: HistoryDiff[] = [];
  private maxDepth: number = 100;
  private onChangeListeners: (() => void)[] = [];
  private objectManager: ObjectManager | null = null;
  private lastSnapshot: CityObject[] | null = null;
  private lastCoalesceKey: string | null = null;
  private lastCoalesceAt = 0;

  constructor(objectManager?: ObjectManager) {
    if (objectManager) {
      this.objectManager = objectManager;
    }
  }

  public setObjectManager(objectManager: ObjectManager) {
    this.objectManager = objectManager;
  }

  public onChange(callback: () => void) {
    this.onChangeListeners.push(callback);
    return () => {
      this.onChangeListeners = this.onChangeListeners.filter(cb => cb !== callback);
    };
  }

  private notify() {
    this.onChangeListeners.forEach(cb => cb());
  }

  private locked = false;

  /** While locked (Simulation mode) undo and redo do nothing, so the road network cannot change. */
  public setLocked(locked: boolean) {
    if (this.locked === locked) return;
    this.locked = locked;
    this.notify();
  }

  private clone<T>(val: T): T {
    return JSON.parse(JSON.stringify(val));
  }

  /** Pushes an already-cloned diff, clearing redo and enforcing max depth. */
  private push(diff: HistoryDiff, coalesceKey: string | null = null) {
    this.redoStack = [];
    this.undoStack.push(diff);
    if (this.undoStack.length > this.maxDepth) {
      this.undoStack.shift();
    }
    this.lastCoalesceKey = coalesceKey;
    this.lastCoalesceAt = Date.now();
    this.notify();
  }

  /**
   * Records newly added object(s) in history.
   */
  public recordAdd(objects: CityObject | CityObject[], description?: string) {
    const list = Array.isArray(objects) ? objects : [objects];
    if (list.length === 0) return;
    this.push({
      type: 'add',
      objects: this.clone(list),
      description: description || `Add ${list.length} object(s)`
    });
  }

  /**
   * Records an updated object in history with before/after state.
   * Pass a `coalesceKey` (e.g. `${id}:name`) for rapid repeated edits such as
   * typing, so that one Undo reverts the whole edit rather than one keystroke.
   */
  public recordUpdate(before: CityObject, after: CityObject, description?: string, coalesceKey?: string) {
    const top = this.undoStack[this.undoStack.length - 1];
    if (
      coalesceKey &&
      top?.type === 'update' &&
      top.id === before.id &&
      this.lastCoalesceKey === coalesceKey &&
      Date.now() - this.lastCoalesceAt < COALESCE_WINDOW_MS
    ) {
      top.after = this.clone(after);
      this.redoStack = [];
      this.lastCoalesceAt = Date.now();
      this.notify();
      return;
    }

    this.push({
      type: 'update',
      id: before.id,
      before: this.clone(before),
      after: this.clone(after),
      description: description || `Update ${before.name || before.id}`
    }, coalesceKey ?? null);
  }

  /**
   * Records deleted object(s) in history.
   */
  public recordDelete(objects: CityObject | CityObject[], description?: string) {
    const list = Array.isArray(objects) ? objects : [objects];
    if (list.length === 0) return;
    this.push({
      type: 'delete',
      objects: this.clone(list),
      description: description || `Delete ${list.length} object(s)`
    });
  }

  /**
   * Pushes a custom structural diff onto the undo stack.
   */
  public pushDiff(diff: HistoryDiff) {
    if (diff.type === 'batch' && diff.diffs.length === 0) return;
    this.push(this.clone(diff));
  }

  /**
   * Backwards-compatible snapshot push.
   */
  public pushState(objects: CityObject[], description?: string) {
    const current = this.clone(objects);
    this.push({
      type: 'snapshot',
      before: this.lastSnapshot ?? [],
      after: current,
      description: description || (this.lastSnapshot ? 'State snapshot' : 'Initial state')
    });
    this.lastSnapshot = current;
  }

  // ── Applying diffs ──────────────────────────────────────────────────────────

  private applyToManager(diff: HistoryDiff, direction: 'undo' | 'redo') {
    const om = this.objectManager!;
    const undo = direction === 'undo';
    switch (diff.type) {
      // Objects put back are copies, so the store never shares arrays with the history (a later change in place
      // would alter what the next Undo or Redo puts back)
      case 'add':
        // Undoing an add (an import, a new road) puts things back as they were: not a deletion to remember
        if (undo) om.deleteMultiple(diff.objects, false, false);
        else om.addMultiple(this.clone(diff.objects));
        break;
      case 'update':
        // The whole object as it was, not merged into the current one (docs/OVERHAUL.md §27)
        om.update(diff.id, this.clone(undo ? diff.before : diff.after), !!diff.local, true);
        break;
      case 'delete':
        if (undo) om.addMultiple(this.clone(diff.objects));
        else om.deleteMultiple(diff.objects);
        break;
      case 'snapshot':
        om.clear();
        (undo ? diff.before : diff.after).forEach(o => om.add(o));
        break;
      case 'batch': {
        // Undo in reverse order so dependent changes unwind correctly
        const ordered = undo ? [...diff.diffs].reverse() : diff.diffs;
        ordered.forEach(d => this.applyToManager(d, direction));
        break;
      }
    }
  }

  private applyToArray(result: CityObject[], diff: HistoryDiff, direction: 'undo' | 'redo'): CityObject[] {
    const undo = direction === 'undo';
    switch (diff.type) {
      case 'add':
      case 'delete': {
        const removing = (diff.type === 'add') === undo;
        if (removing) {
          const removeIds = new Set(diff.objects.map(o => o.id));
          return result.filter(o => !removeIds.has(o.id));
        }
        return [...result, ...diff.objects];
      }
      case 'update': {
        const target = undo ? diff.before : diff.after;
        return result.map(o => (o.id === diff.id ? target : o));
      }
      case 'snapshot':
        return [...(undo ? diff.before : diff.after)];
      case 'batch': {
        const ordered = undo ? [...diff.diffs].reverse() : diff.diffs;
        return ordered.reduce((acc, d) => this.applyToArray(acc, d, direction), result);
      }
    }
  }

  /**
   * Undoes the last operation.
   * If ObjectManager is bound, mutates it directly and returns updated objects.
   * If currentObjects array is passed, returns the computed result array.
   */
  public undo(currentObjects?: CityObject[]): CityObject[] | null {
    if (this.locked || this.undoStack.length === 0) return null;

    const diff = this.undoStack.pop()!;
    this.redoStack.push(diff);
    this.lastCoalesceKey = null;

    if (this.objectManager) {
      this.applyToManager(diff, 'undo');
      this.notify();
      return this.objectManager.getAll();
    }

    const result = this.applyToArray(currentObjects ? [...currentObjects] : [], diff, 'undo');
    this.notify();
    return result;
  }

  /**
   * Redoes the last undone operation.
   * If ObjectManager is bound, mutates it directly and returns updated objects.
   * If currentObjects array is passed, returns the computed result array.
   */
  public redo(currentObjects?: CityObject[]): CityObject[] | null {
    if (this.locked || this.redoStack.length === 0) return null;

    const diff = this.redoStack.pop()!;
    this.undoStack.push(diff);
    this.lastCoalesceKey = null;

    if (this.objectManager) {
      this.applyToManager(diff, 'redo');
      this.notify();
      return this.objectManager.getAll();
    }

    const result = this.applyToArray(currentObjects ? [...currentObjects] : [], diff, 'redo');
    this.notify();
    return result;
  }

  public canUndo(): boolean {
    return !this.locked && this.undoStack.length > 0;
  }

  public canRedo(): boolean {
    return !this.locked && this.redoStack.length > 0;
  }

  public getUndoStackCount(): number {
    return this.undoStack.length;
  }

  public getRedoStackCount(): number {
    return this.redoStack.length;
  }

  public clear() {
    this.undoStack = [];
    this.redoStack = [];
    this.lastSnapshot = null;
    this.lastCoalesceKey = null;
    this.notify();
  }
}

/**
 * Deletes an object and records it for Undo: the Build panel's Delete button and the Delete key
 * (TwinCityEngine.deleteObjectWithHistory), here so the whole-network edit tests run the same code.
 */
export function deleteWithHistory(objects: ObjectManager, history: HistoryManager, id: string): CityObject | null {
  const obj = objects.getById(id);
  if (!obj) return null;
  const beforeAll = new Map(objects.getAll().map(o => [o.id, o]));
  // A drawn flyover gives back the capacity its ramps took from the surface roads, in the same Undo step
  const impacted = (obj.type === 'flyover' || obj.type === 'metro_flyover')
    ? objects.getAll().filter((o): o is RoadObject => o.type === 'road' && o.flyoverImpact?.flyoverId === id) : [];
  if (impacted.length) {
    const diffs: HistoryDiff[] = impacted.map(before => {
      const { flyoverImpact: _gone, ...after } = before;
      void _gone;
      return { type: 'update', id: before.id, before, after: after as CityObject, description: `Ramp merge removed from ${before.name || before.id}` };
    });
    for (const d of diffs) if (d.type === 'update') objects.update(d.id, d.after, false, true);
    for (const d of diffs) if (d.type === 'update') beforeAll.set(d.id, objects.getById(d.id)!);
    objects.delete(id);
    history.pushDiff({ type: 'batch', description: `Delete ${obj.name || obj.type}`, diffs: [...diffs, { type: 'delete', objects: [obj] }, ...heightDiffs(objects, beforeAll, id)] });
    return obj;
  }
  objects.delete(id);
  const heights = heightDiffs(objects, beforeAll, id);
  if (heights.length) history.pushDiff({ type: 'batch', description: `Delete ${obj.name || obj.type}`, diffs: [{ type: 'delete', objects: [obj] }, ...heights] });
  else history.recordDelete(obj, `Delete ${obj.name || obj.type}`);
  return obj;
}

/**
 * Roads whose heights the deletion worked out again (a ramp next to a deleted deck goes back down), as updates in
 * the same Undo step. Undo puts back the exact stored values; worked out again when the road came back they
 * differed in the last bits (1e-16 m on osm_327073028 after deleting osm_657054224, a different network key from
 * before the deletion: docs/OVERHAUL.md §27.7). In memory only, as the heights themselves (`local`).
 */
function heightDiffs(objects: ObjectManager, before: ReadonlyMap<string, CityObject>, deletedId: string): HistoryDiff[] {
  const out: HistoryDiff[] = [];
  for (const o of objects.getAll()) {
    const b = before.get(o.id);
    if (!b || b === o || o.id === deletedId) continue;
    out.push({ type: 'update', id: o.id, before: b, after: o, local: true, description: `Heights of ${o.name || o.id} worked out again` });
  }
  return out;
}

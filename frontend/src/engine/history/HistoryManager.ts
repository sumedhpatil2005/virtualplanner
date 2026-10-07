import type { CityObject } from '../objects/types';
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
      case 'add':
        if (undo) om.deleteMultiple(diff.objects);
        else om.addMultiple(diff.objects);
        break;
      case 'update':
        om.update(diff.id, undo ? diff.before : diff.after);
        break;
      case 'delete':
        if (undo) om.addMultiple(diff.objects);
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

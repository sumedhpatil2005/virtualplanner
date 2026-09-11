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
    };

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

  private clone<T>(val: T): T {
    return JSON.parse(JSON.stringify(val));
  }

  /**
   * Records newly added object(s) in history.
   */
  public recordAdd(objects: CityObject | CityObject[], description?: string) {
    const list = Array.isArray(objects) ? objects : [objects];
    if (list.length === 0) return;

    this.redoStack = [];
    this.undoStack.push({
      type: 'add',
      objects: this.clone(list),
      description: description || `Add ${list.length} object(s)`
    });

    if (this.undoStack.length > this.maxDepth) {
      this.undoStack.shift();
    }
    this.notify();
  }

  /**
   * Records an updated object in history with before/after state.
   */
  public recordUpdate(before: CityObject, after: CityObject, description?: string) {
    this.redoStack = [];
    this.undoStack.push({
      type: 'update',
      id: before.id,
      before: this.clone(before),
      after: this.clone(after),
      description: description || `Update ${before.name || before.id}`
    });

    if (this.undoStack.length > this.maxDepth) {
      this.undoStack.shift();
    }
    this.notify();
  }

  /**
   * Records deleted object(s) in history.
   */
  public recordDelete(objects: CityObject | CityObject[], description?: string) {
    const list = Array.isArray(objects) ? objects : [objects];
    if (list.length === 0) return;

    this.redoStack = [];
    this.undoStack.push({
      type: 'delete',
      objects: this.clone(list),
      description: description || `Delete ${list.length} object(s)`
    });

    if (this.undoStack.length > this.maxDepth) {
      this.undoStack.shift();
    }
    this.notify();
  }

  /**
   * Pushes a custom structural diff onto the undo stack.
   */
  public pushDiff(diff: HistoryDiff) {
    this.redoStack = [];
    this.undoStack.push(this.clone(diff));
    if (this.undoStack.length > this.maxDepth) {
      this.undoStack.shift();
    }
    this.notify();
  }

  /**
   * Backwards-compatible snapshot push.
   */
  public pushState(objects: CityObject[], description?: string) {
    const current = this.clone(objects);
    this.redoStack = [];

    if (this.lastSnapshot) {
      this.undoStack.push({
        type: 'snapshot',
        before: this.lastSnapshot,
        after: current,
        description: description || 'State snapshot'
      });
    } else {
      this.undoStack.push({
        type: 'snapshot',
        before: [],
        after: current,
        description: description || 'Initial state'
      });
    }

    this.lastSnapshot = current;

    if (this.undoStack.length > this.maxDepth) {
      this.undoStack.shift();
    }
    this.notify();
  }

  /**
   * Undoes the last operation.
   * If ObjectManager is bound, mutates it directly and returns updated objects.
   * If currentObjects array is passed, returns the computed result array.
   */
  public undo(currentObjects?: CityObject[]): CityObject[] | null {
    if (this.undoStack.length === 0) return null;

    const diff = this.undoStack.pop()!;
    this.redoStack.push(diff);

    // 1. Direct ObjectManager mutation path (fast, structural, no full clear)
    if (this.objectManager) {
      switch (diff.type) {
        case 'add':
          // Inverse of add: remove added objects
          this.objectManager.deleteMultiple(diff.objects);
          break;
        case 'update':
          // Inverse of update: revert to before
          this.objectManager.update(diff.id, diff.before);
          break;
        case 'delete':
          // Inverse of delete: restore objects
          this.objectManager.addMultiple(diff.objects);
          break;
        case 'snapshot':
          this.objectManager.clear();
          diff.before.forEach(o => this.objectManager!.add(o));
          break;
      }
      this.notify();
      return this.objectManager.getAll();
    }

    // 2. Pure array transformation fallback (if ObjectManager is not bound)
    let result: CityObject[] = currentObjects ? [...currentObjects] : [];

    switch (diff.type) {
      case 'add': {
        const removeIds = new Set(diff.objects.map(o => o.id));
        result = result.filter(o => !removeIds.has(o.id));
        break;
      }
      case 'update': {
        result = result.map(o => (o.id === diff.id ? diff.before : o));
        break;
      }
      case 'delete': {
        result = [...result, ...diff.objects];
        break;
      }
      case 'snapshot': {
        result = [...diff.before];
        break;
      }
    }

    this.notify();
    return result;
  }

  /**
   * Redoes the last undone operation.
   * If ObjectManager is bound, mutates it directly and returns updated objects.
   * If currentObjects array is passed, returns the computed result array.
   */
  public redo(currentObjects?: CityObject[]): CityObject[] | null {
    if (this.redoStack.length === 0) return null;

    const diff = this.redoStack.pop()!;
    this.undoStack.push(diff);

    // 1. Direct ObjectManager mutation path
    if (this.objectManager) {
      switch (diff.type) {
        case 'add':
          // Redo add: add objects back
          this.objectManager.addMultiple(diff.objects);
          break;
        case 'update':
          // Redo update: apply after
          this.objectManager.update(diff.id, diff.after);
          break;
        case 'delete':
          // Redo delete: remove objects again
          this.objectManager.deleteMultiple(diff.objects);
          break;
        case 'snapshot':
          this.objectManager.clear();
          diff.after.forEach(o => this.objectManager!.add(o));
          break;
      }
      this.notify();
      return this.objectManager.getAll();
    }

    // 2. Pure array transformation fallback
    let result: CityObject[] = currentObjects ? [...currentObjects] : [];

    switch (diff.type) {
      case 'add': {
        result = [...result, ...diff.objects];
        break;
      }
      case 'update': {
        result = result.map(o => (o.id === diff.id ? diff.after : o));
        break;
      }
      case 'delete': {
        const removeIds = new Set(diff.objects.map(o => o.id));
        result = result.filter(o => !removeIds.has(o.id));
        break;
      }
      case 'snapshot': {
        result = [...diff.after];
        break;
      }
    }

    this.notify();
    return result;
  }

  public canUndo(): boolean {
    return this.undoStack.length > 0;
  }

  public canRedo(): boolean {
    return this.redoStack.length > 0;
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
    this.notify();
  }
}

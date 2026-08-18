import type { CityObject } from '../objects/types';

export interface HistoryState {
  objectsSnapshot: CityObject[];
}

export class HistoryManager {
  private undoStack: HistoryState[] = [];
  private redoStack: HistoryState[] = [];
  private maxDepth: number = 30;
  private onChangeListeners: (() => void)[] = [];

  constructor() {}

  public onChange(callback: () => void) {
    this.onChangeListeners.push(callback);
    return () => {
      this.onChangeListeners = this.onChangeListeners.filter(cb => cb !== callback);
    };
  }

  private notify() {
    this.onChangeListeners.forEach(cb => cb());
  }

  public pushState(objects: CityObject[]) {
    // Deep clone objects to prevent shared reference mutations
    const snapshot = JSON.parse(JSON.stringify(objects));
    
    // Clear redo stack on new operation
    this.redoStack = [];
    
    this.undoStack.push({ objectsSnapshot: snapshot });
    if (this.undoStack.length > this.maxDepth) {
      this.undoStack.shift();
    }
    this.notify();
  }

  public undo(currentObjects: CityObject[]): CityObject[] | null {
    if (this.undoStack.length === 0) return null;

    const previous = this.undoStack.pop()!;
    // Push current to redo stack
    this.redoStack.push({ objectsSnapshot: JSON.parse(JSON.stringify(currentObjects)) });
    
    this.notify();
    return previous.objectsSnapshot;
  }

  public redo(currentObjects: CityObject[]): CityObject[] | null {
    if (this.redoStack.length === 0) return null;

    const next = this.redoStack.pop()!;
    // Push current to undo stack
    this.undoStack.push({ objectsSnapshot: JSON.parse(JSON.stringify(currentObjects)) });
    
    this.notify();
    return next.objectsSnapshot;
  }

  public canUndo(): boolean {
    return this.undoStack.length > 0;
  }

  public canRedo(): boolean {
    return this.redoStack.length > 0;
  }

  public clear() {
    this.undoStack = [];
    this.redoStack = [];
    this.notify();
  }
}

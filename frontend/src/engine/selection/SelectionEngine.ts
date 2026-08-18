import type { CityObjectType } from '../objects/types';

export class SelectionEngine {
  private selectedIds: Set<string> = new Set();
  private filterTypes: Set<CityObjectType> = new Set();
  private onChangeListeners: ((selectedIds: string[]) => void)[] = [];

  constructor() {}

  public onChange(callback: (selectedIds: string[]) => void) {
    this.onChangeListeners.push(callback);
    return () => {
      this.onChangeListeners = this.onChangeListeners.filter(cb => cb !== callback);
    };
  }

  private notify() {
    const list = Array.from(this.selectedIds);
    this.onChangeListeners.forEach(cb => cb(list));
  }

  public getSelection(): string[] {
    return Array.from(this.selectedIds);
  }

  public selectSingle(id: string | null) {
    this.selectedIds.clear();
    if (id) {
      this.selectedIds.add(id);
    }
    this.notify();
  }

  public selectMultiple(ids: string[]) {
    ids.forEach(id => this.selectedIds.add(id));
    this.notify();
  }

  public toggleSelect(id: string) {
    if (this.selectedIds.has(id)) {
      this.selectedIds.delete(id);
    } else {
      this.selectedIds.add(id);
    }
    this.notify();
  }

  public clearSelection() {
    if (this.selectedIds.size > 0) {
      this.selectedIds.clear();
      this.notify();
    }
  }

  public setFilterTypes(types: CityObjectType[]) {
    this.filterTypes = new Set(types);
  }

  public getFilterTypes(): CityObjectType[] {
    return Array.from(this.filterTypes);
  }

  public matchesFilter(type: CityObjectType): boolean {
    if (this.filterTypes.size === 0) return true;
    return this.filterTypes.has(type);
  }
}

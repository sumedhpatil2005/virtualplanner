export interface SubRenderer {
  /** Marks an object for (re)batching; meshes are pulled from the MeshCache when its tile builds. */
  render(objId: string): void;
  remove(objId: string): void;
  setSelection(objId: string, isSelected: boolean): void;
  clear(): void;
  unloadTile(tileKey: string): void;
}

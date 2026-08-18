import type { MeshData } from '../types';

export interface SubRenderer {
  render(objId: string, meshes: MeshData[]): void;
  remove(objId: string): void;
  setSelection(objId: string, isSelected: boolean): void;
  clear(): void;
  unloadTile(tileKey: string): void;
}

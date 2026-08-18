import type { MeshData } from '../types';

export class MeshCache {
  private cache = new Map<string, MeshData[]>();

  public get(objId: string): MeshData[] | undefined {
    return this.cache.get(objId);
  }

  public set(objId: string, meshes: MeshData[]): void {
    this.cache.set(objId, meshes);
  }

  public invalidate(objId: string): void {
    this.cache.delete(objId);
  }

  public clear(): void {
    this.cache.clear();
  }
}

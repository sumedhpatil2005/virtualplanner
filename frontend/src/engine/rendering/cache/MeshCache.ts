import type { MeshData } from '../types';

/** Default budget for CPU-side mesh buffers (the GPU keeps its own copy once built). */
export const DEFAULT_MESH_CACHE_BYTES = 256 * 1024 * 1024;

const sizeOf = (meshes: MeshData[]): number =>
  meshes.reduce(
    (sum, m) => sum + m.positions.byteLength + m.indices.byteLength + (m.normals?.byteLength ?? 0) + (m.uvs?.byteLength ?? 0),
    0
  );

/**
 * LRU cache of generated meshes with a byte budget (item 34).
 *
 * With a `loader`, a miss generates the meshes on demand, so evicting an entry
 * never makes an object disappear — it only costs a regeneration the next time
 * its tile is rebuilt. `Map` keeps insertion order, which doubles as recency.
 */
export class MeshCache {
  private cache = new Map<string, { meshes: MeshData[]; bytes: number }>();
  private totalBytes = 0;
  private loader: ((objId: string) => MeshData[] | undefined) | null = null;

  private maxBytes: number;

  constructor(maxBytes = DEFAULT_MESH_CACHE_BYTES) {
    this.maxBytes = maxBytes;
  }

  public setLoader(loader: (objId: string) => MeshData[] | undefined): void {
    this.loader = loader;
  }

  public get(objId: string): MeshData[] | undefined {
    const entry = this.cache.get(objId);
    if (entry) {
      // Move to most-recently-used
      this.cache.delete(objId);
      this.cache.set(objId, entry);
      return entry.meshes;
    }
    const loaded = this.loader?.(objId);
    if (loaded) this.set(objId, loaded);
    return loaded;
  }

  public has(objId: string): boolean {
    return this.cache.has(objId);
  }

  public set(objId: string, meshes: MeshData[]): void {
    this.invalidate(objId);
    const bytes = sizeOf(meshes);
    this.cache.set(objId, { meshes, bytes });
    this.totalBytes += bytes;
    this.evict();
  }

  public invalidate(objId: string): void {
    const entry = this.cache.get(objId);
    if (entry) {
      this.totalBytes -= entry.bytes;
      this.cache.delete(objId);
    }
  }

  public clear(): void {
    this.cache.clear();
    this.totalBytes = 0;
  }

  public getStats() {
    return { entries: this.cache.size, bytes: this.totalBytes, maxBytes: this.maxBytes };
  }

  private evict(): void {
    // Always keep the newest entry, even if it alone exceeds the budget
    for (const [id, entry] of this.cache) {
      if (this.totalBytes <= this.maxBytes || this.cache.size <= 1) break;
      this.cache.delete(id);
      this.totalBytes -= entry.bytes;
    }
  }
}

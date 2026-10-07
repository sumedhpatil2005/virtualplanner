import type { Bounds } from './StudyAreaExplorer';
import { OverpassClient } from '../editing/OverpassClient';
import type { LocalOsmIndex } from '../editing/LocalOsmIndex';
import { cacheGetMany, cachePutMany } from '../storage/localCache';

/**
 * Where the real traffic signals are, from OpenStreetMap (highway=traffic_signals
 * nodes): from the backend's local OSM extract where it covers the area,
 * otherwise from Overpass, fetched in fixed tiles and kept on this device
 * (IndexedDB) so a place is asked for once.
 */

/** Tile size in degrees (about 2.2 km). */
const TILE_DEG = 0.02;
/** Cached tiles older than this are fetched again. */
const MAX_AGE_MS = 30 * 24 * 3600 * 1000;

export type SignalPoint = [number, number];

interface CachedTile {
  fetchedAt: number;
  points: SignalPoint[];
}

const tileKey = (tx: number, ty: number) => `${tx}:${ty}`;

export class TrafficSignalSource {
  private readonly memory = new Map<string, SignalPoint[]>();
  private readonly overpass: OverpassClient;
  private readonly local: LocalOsmIndex | null;

  constructor(local: LocalOsmIndex | null = null, overpass = new OverpassClient()) {
    this.local = local;
    this.overpass = overpass;
  }

  /** Signals inside `bounds`. Rejects if OpenStreetMap cannot be reached and nothing is cached. */
  public async signalsIn(bounds: Bounds, signal?: AbortSignal): Promise<SignalPoint[]> {
    // The backend's OSM extract, where it covers the area: complete and quick, nothing to cache
    if (this.local && (await this.local.covers([bounds]))) {
      return (await this.local.signals([bounds])).map(n => [n.lon, n.lat] as SignalPoint);
    }
    const tiles: { key: string; tx: number; ty: number }[] = [];
    for (let tx = Math.floor(bounds.minLng / TILE_DEG); tx <= Math.floor(bounds.maxLng / TILE_DEG); tx++) {
      for (let ty = Math.floor(bounds.minLat / TILE_DEG); ty <= Math.floor(bounds.maxLat / TILE_DEG); ty++) {
        tiles.push({ key: tileKey(tx, ty), tx, ty });
      }
    }

    let missing = tiles.filter(t => !this.memory.has(t.key));
    if (missing.length > 0) {
      const cached = await cacheGetMany<CachedTile>('osm-signals', missing.map(t => t.key));
      missing.forEach((t, i) => {
        const c = cached[i];
        if (c && Date.now() - c.fetchedAt < MAX_AGE_MS) this.memory.set(t.key, c.points);
      });
      missing = missing.filter(t => !this.memory.has(t.key));
    }

    if (missing.length > 0) {
      const parts = missing
        .map(t => `node["highway"="traffic_signals"](${t.ty * TILE_DEG},${t.tx * TILE_DEG},${(t.ty + 1) * TILE_DEG},${(t.tx + 1) * TILE_DEG});`)
        .join('');
      const data = await this.overpass.query(`[out:json][timeout:30];(${parts});out skel qt;`, signal);
      if (typeof data?.remark === 'string') throw new Error(`OpenStreetMap did not finish the query: ${data.remark}`);
      const byTile = new Map<string, SignalPoint[]>(missing.map(t => [t.key, []]));
      for (const el of data?.elements ?? []) {
        if (el.type !== 'node' || typeof el.lon !== 'number') continue;
        byTile.get(tileKey(Math.floor(el.lon / TILE_DEG), Math.floor(el.lat / TILE_DEG)))?.push([el.lon, el.lat]);
      }
      const now = Date.now();
      byTile.forEach((points, key) => this.memory.set(key, points));
      // An all-empty answer may come from a mirror with partial data: use it now, but don't keep it
      if ([...byTile.values()].some(p => p.length > 0)) {
        void cachePutMany<CachedTile>('osm-signals', [...byTile].map(([key, points]) => [key, { fetchedAt: now, points }]));
      }
    }

    const out: SignalPoint[] = [];
    for (const t of tiles) {
      for (const p of this.memory.get(t.key)!) {
        if (p[0] >= bounds.minLng && p[0] <= bounds.maxLng && p[1] >= bounds.minLat && p[1] <= bounds.maxLat) out.push(p);
      }
    }
    return out;
  }
}

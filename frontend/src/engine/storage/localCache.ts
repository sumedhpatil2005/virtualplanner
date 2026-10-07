/**
 * A small key-value store in the browser's IndexedDB, for data fetched from
 * outside services that rarely changes (OpenStreetMap traffic signals, which
 * map tiles have been checked against OpenStreetMap), so it is fetched once
 * per device rather than once per session.
 *
 * Every call degrades to a no-op when IndexedDB is unavailable (private
 * windows, tests): callers then simply fetch again.
 */

const DB_NAME = 'twincity-cache';
const DB_VERSION = 2;
export const CACHE_STORES = ['osm-signals', 'osm-road-tiles', 'osm-deleted'] as const;
export type CacheStore = (typeof CACHE_STORES)[number];

let opening: Promise<IDBDatabase | null> | null = null;

function open(): Promise<IDBDatabase | null> {
  if (opening) return opening;
  opening = new Promise(resolve => {
    try {
      if (typeof indexedDB === 'undefined') return resolve(null);
      const req = indexedDB.open(DB_NAME, DB_VERSION);
      req.onupgradeneeded = () => {
        for (const name of CACHE_STORES) if (!req.result.objectStoreNames.contains(name)) req.result.createObjectStore(name);
      };
      req.onsuccess = () => resolve(req.result);
      req.onerror = () => resolve(null);
      req.onblocked = () => resolve(null);
    } catch {
      resolve(null);
    }
  });
  return opening;
}

/** Values for `keys` (undefined where none is stored), in order. */
export async function cacheGetMany<T>(store: CacheStore, keys: readonly string[]): Promise<(T | undefined)[]> {
  const db = await open();
  if (!db || keys.length === 0) return keys.map(() => undefined);
  return new Promise(resolve => {
    try {
      const tx = db.transaction(store, 'readonly');
      const os = tx.objectStore(store);
      const out: (T | undefined)[] = new Array(keys.length);
      keys.forEach((k, i) => {
        const req = os.get(k);
        req.onsuccess = () => (out[i] = req.result as T | undefined);
      });
      tx.oncomplete = () => resolve(out);
      tx.onerror = () => resolve(keys.map(() => undefined));
    } catch {
      resolve(keys.map(() => undefined));
    }
  });
}

export async function cachePutMany<T>(store: CacheStore, entries: readonly [string, T][]): Promise<void> {
  const db = await open();
  if (!db || entries.length === 0) return;
  await new Promise<void>(resolve => {
    try {
      const tx = db.transaction(store, 'readwrite');
      const os = tx.objectStore(store);
      for (const [k, v] of entries) os.put(v, k);
      tx.oncomplete = () => resolve();
      tx.onerror = () => resolve();
    } catch {
      resolve();
    }
  });
}

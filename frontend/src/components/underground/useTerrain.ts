import { useEffect, useState } from 'react';
import { terrainApi, type SubsurfaceEvidence, type TerrainProfile } from '../../lib/terrainApi';

export type Loadable<T> = { state: 'idle' } | { state: 'loading' } | { state: 'ok'; data: T } | { state: 'error'; error: string };

const cache = new Map<string, Promise<unknown>>();

function cached<T>(key: string, f: () => Promise<T>): Promise<T> {
  let p = cache.get(key) as Promise<T> | undefined;
  if (!p) {
    p = f();
    cache.set(key, p);
    p.catch(() => cache.delete(key));   // retry next time
    if (cache.size > 40) cache.delete(cache.keys().next().value as string);
  }
  return p;
}

function useLoad<T>(key: string | null, f: () => Promise<T>): Loadable<T> {
  const [v, setV] = useState<Loadable<T>>({ state: 'idle' });
  useEffect(() => {
    if (!key) { setV({ state: 'idle' }); return; }
    let alive = true;
    setV({ state: 'loading' });
    cached(key, f).then(data => { if (alive) setV({ state: 'ok', data }); },
      e => { if (alive) setV({ state: 'error', error: (e as Error).message }); });
    return () => { alive = false; };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [key]);
  return v;
}

type Coords = readonly (readonly number[])[];
const keyOf = (c: Coords | null | undefined) => (c && c.length >= 2 ? c.map(p => `${p[0].toFixed(7)},${p[1].toFixed(7)}`).join(';') : null);

/** DSM ground profile along a polyline (/api/terrain/profile). */
export function useTerrainProfile(coords: Coords | null | undefined, stepM = 30): Loadable<TerrainProfile> {
  const k = keyOf(coords);
  return useLoad(k ? `p|${stepM}|${k}` : null, () => terrainApi.profile(coords as Coords, stepM));
}

/** Wells / soil / sewers / boreholes near a polyline (/api/terrain/subsurface-evidence). */
export function useSubsurfaceEvidence(coords: Coords | null | undefined, radiusKm = 3): Loadable<SubsurfaceEvidence> {
  const k = keyOf(coords);
  return useLoad(k ? `e|${radiusKm}|${k}` : null, () => terrainApi.evidence(coords as Coords, radiusKm));
}

/**
 * Explore: pre-rendered DEM overlays (hillshade / slope PNG in EPSG:4326 with stated bounds, served by
 * GET /api/terrain/overlays) as Cesium SingleTileImageryProvider layers, and an elevation readout (GET /api/terrain/point)
 * for the cursor (debounced) and the selected object. Copernicus GLO-30 is a DSM: values include buildings/trees.
 * Nothing is drawn without data; a failed fetch is reported, never filled in.
 */
import { create } from 'zustand';
import { Cartesian2, ImageryLayer, Rectangle, ScreenSpaceEventHandler, ScreenSpaceEventType, SingleTileImageryProvider, Math as CesiumMath, type Viewer } from 'cesium';
import { engineInstance } from '../../engine/TwinCityEngine';
import { terrainApi, type OverlayMeta, type TerrainPoint } from '../../lib/terrainApi';

export type TerrainOverlayKey = 'hillshade' | 'slope';
export interface Readout { lon: number; lat: number; elevationM: number | null; status: string; from: 'cursor' | 'selection'; at: number }

interface Store {
  meta: OverlayMeta | null; metaError: string | null;
  shown: Record<TerrainOverlayKey, 'off' | 'loading' | 'shown' | 'error'>;
  error: string | null;
  cursor: Readout | null; selection: Readout | null; readoutOn: boolean;
  dataset: TerrainPoint['dataset'] | null;
  set: (p: Partial<Omit<Store, 'set'>>) => void;
}

export const useTerrainOverlayStore = create<Store>(set => ({
  meta: null, metaError: null, shown: { hillshade: 'off', slope: 'off' }, error: null,
  cursor: null, selection: null, readoutOn: false, dataset: null,
  set: p => set(p),
}));

const layers = new Map<TerrainOverlayKey, ImageryLayer>();

function viewer(): Viewer | null {
  const v = engineInstance.getViewer() as Viewer | null;
  return v && !v.isDestroyed() ? v : null;
}

export async function loadOverlayMeta(): Promise<OverlayMeta | null> {
  const st = useTerrainOverlayStore.getState();
  if (st.meta) return st.meta;
  try {
    const m = await terrainApi.overlays();
    st.set({ meta: m, metaError: null });
    return m;
  } catch (e) {
    st.set({ metaError: (e as Error).message });
    return null;
  }
}

export async function setTerrainOverlay(k: TerrainOverlayKey, on: boolean): Promise<void> {
  const st = useTerrainOverlayStore.getState();
  const v = viewer();
  const mark = (s: Store['shown'][TerrainOverlayKey], error: string | null = null) =>
    useTerrainOverlayStore.getState().set({ shown: { ...useTerrainOverlayStore.getState().shown, [k]: s }, error });
  const old = layers.get(k);
  if (!on) {
    if (old && v) v.imageryLayers.remove(old, true);
    layers.delete(k);
    mark('off');
    return;
  }
  if (old) return;
  mark('loading');
  const m = await loadOverlayMeta();
  if (!m || !v) { mark('error', st.metaError ?? 'viewer not ready'); return; }
  try {
    const b = m.bounds_wgs84;
    const provider = await SingleTileImageryProvider.fromUrl(terrainApi.overlayUrl(m.overlays[k].url), {
      rectangle: Rectangle.fromDegrees(b.west, b.south, b.east, b.north), credit: m.attribution,
    });
    const layer = v.imageryLayers.addImageryProvider(provider);
    layer.alpha = k === 'hillshade' ? 0.75 : 0.65;
    layers.set(k, layer);
    mark('shown');
    v.scene.requestRender();
  } catch (e) {
    mark('error', (e as Error).message);
  }
}

/** Test/inspection hook: what the overlay layers currently are. */
export function terrainOverlayLayers(): { key: TerrainOverlayKey; rectangle: number[]; alpha: number }[] {
  return [...layers.entries()].map(([key, l]) => {
    const r = l.imageryProvider.rectangle;
    return { key, alpha: l.alpha, rectangle: [r.west, r.south, r.east, r.north].map(x => CesiumMath.toDegrees(x)) };
  });
}

// ---- elevation readout -------------------------------------------------------------------------------------------
let handler: ScreenSpaceEventHandler | null = null;
let timer: ReturnType<typeof setTimeout> | null = null;
const seq: Record<Readout['from'], number> = { cursor: 0, selection: 0 };

/** Latest request per source wins (an older, slower response never overwrites a newer one). Errors clear the value. */
export async function sampleReadout(lon: number, lat: number, from: Readout['from']): Promise<Readout | null> {
  const my = ++seq[from];
  const st = () => useTerrainOverlayStore.getState();
  st().set({ [from]: { lon, lat, elevationM: null, status: 'loading', from, at: Date.now() } } as Partial<Store>);
  try {
    const p = await terrainApi.point(lon, lat);
    const r: Readout = { lon, lat, elevationM: p.elevation_m, status: p.status, from, at: Date.now() };
    if (my === seq[from]) st().set({ [from]: r, dataset: p.dataset, error: null } as Partial<Store>);
    return r;
  } catch (e) {
    if (my === seq[from]) st().set({ [from]: { lon, lat, elevationM: null, status: 'error', from, at: Date.now() }, error: (e as Error).message } as Partial<Store>);
    return null;
  }
}

/** Cancels pending readouts for a source (selection cleared / readout switched off). */
export function clearReadout(from: Readout['from']): void {
  seq[from]++;
  useTerrainOverlayStore.getState().set({ [from]: null } as Partial<Store>);
}

/** Cursor readout: pick the ellipsoid under the mouse (works without imagery/terrain tiles), sample after 250 ms still. */
export function setCursorReadout(on: boolean): void {
  useTerrainOverlayStore.getState().set({ readoutOn: on });
  if (handler) { handler.destroy(); handler = null; }
  if (timer) { clearTimeout(timer); timer = null; }
  if (!on) clearReadout('cursor');
  if (!on) return;
  const v = viewer();
  if (!v) return;
  handler = new ScreenSpaceEventHandler(v.scene.canvas);
  handler.setInputAction((m: { endPosition: Cartesian2 }) => {
    if (timer) clearTimeout(timer);
    const pos = Cartesian2.clone(m.endPosition);
    timer = setTimeout(() => {
      const c = v.camera.pickEllipsoid(pos, v.scene.globe.ellipsoid);
      if (!c) return;
      const g = v.scene.globe.ellipsoid.cartesianToCartographic(c);
      void sampleReadout(CesiumMath.toDegrees(g.longitude), CesiumMath.toDegrees(g.latitude), 'cursor');
    }, 250);
  }, ScreenSpaceEventType.MOUSE_MOVE);
}

/** A representative plan point of a city object: the point itself, or the middle vertex of a line/polygon. */
export function repPoint(o: { coordinates?: unknown }): [number, number] | null {
  const c = o.coordinates;
  if (!Array.isArray(c) || c.length === 0) return null;
  if (typeof c[0] === 'number') return [c[0] as number, c[1] as number];
  const mid = c[Math.floor(c.length / 2)] as number[];
  return Array.isArray(mid) && typeof mid[0] === 'number' ? [mid[0], mid[1]] : null;
}


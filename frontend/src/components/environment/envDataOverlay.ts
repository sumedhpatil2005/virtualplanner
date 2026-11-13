/**
 * Map rendering for the Environment data catalogue (GET /api/env-data). Nothing is loaded whole into the browser:
 * - raster rows: the backend renders a PNG for the current camera view (clipped to the layer's bounds) and Cesium drapes
 *   it as a SingleTileImageryProvider over exactly that rectangle; re-rendered when the camera stops moving.
 * - vector rows (derived streams): bbox API with a cap; the response says how many were not shown.
 * - trees: bbox API returns points (≤ cap) or grid clusters with the total.
 * - stations: CPCB/MPCB/IITM stations with known coordinates (stations without coordinates are listed, not drawn).
 * Entity ids are prefixed `env_overlay_` so the engine's pick handler never treats them as city objects; imagery layers
 * carry `__uosEnvOverlay` so the base-layer (Satellite) toggle leaves them alone.
 */
import { create } from 'zustand';
import {
  Cartesian2, Cartesian3, Color, CustomDataSource, HeightReference, ImageryLayer, LabelStyle, Math as CesiumMath, NearFarScalar,
  Rectangle, SingleTileImageryProvider, VerticalOrigin, type Viewer,
} from 'cesium';
import { engineInstance } from '../../engine/TwinCityEngine';
import { envDataApi, type AqStation, type EnvDataLayer } from '../../lib/envDataApi';
import { clipBbox, renderWidth } from './envDataModel';

export interface EnvDataOverlayState {
  status: 'off' | 'loading' | 'shown' | 'error';
  variant: string | null;
  bbox: number[] | null;
  bboxFrom: 'camera view' | 'layer bounds' | null;
  message: string | null;
  error: string | null;
}
const OFF: EnvDataOverlayState = { status: 'off', variant: null, bbox: null, bboxFrom: null, message: null, error: null };

interface Store {
  overlays: Record<string, EnvDataOverlayState>;
  set: (id: string, s: Partial<EnvDataOverlayState>) => void;
}
export const useEnvDataOverlayStore = create<Store>(set => ({
  overlays: {},
  set: (id, s) => set(st => ({ overlays: { ...st.overlays, [id]: { ...(st.overlays[id] ?? OFF), ...s } } })),
}));
export const overlayState = (id: string): EnvDataOverlayState => useEnvDataOverlayStore.getState().overlays[id] ?? OFF;

const imagery = new Map<string, ImageryLayer>();
const blobUrls = new Map<string, string>();
const sources = new Map<string, CustomDataSource>();
const active = new Map<string, EnvDataLayer>();
const seq = new Map<string, number>();
let removeMoveListener: (() => void) | null = null;
let moveTimer: ReturnType<typeof setTimeout> | null = null;
const STREAM_COLOR = Color.fromCssColorString('#29b6f6');
const TREE_COLOR = Color.fromCssColorString('#2e7d32');
const STATION_COLOR = Color.fromCssColorString('#ffb300');
export const RASTER_ALPHA = 0.85;
const TIMEOUT_MS = 60000;

function viewer(): Viewer | null {
  const v = engineInstance.getViewer() as Viewer | null;
  return v && !v.isDestroyed() ? v : null;
}

function viewBox(v: Viewer, layer: EnvDataLayer): { bbox: number[]; from: EnvDataOverlayState['bboxFrom']; view: number[] } | null {
  const r = v.camera.computeViewRectangle();
  const view = r ? [r.west, r.south, r.east, r.north].map(CesiumMath.toDegrees) : null;
  if (!view) return layer.bounds ? { bbox: layer.bounds, from: 'layer bounds', view: layer.bounds } : null;
  const c = clipBbox(view, layer.bounds);
  return c ? { bbox: c, from: 'camera view', view } : null;
}

function ensureMoveListener(v: Viewer) {
  if (removeMoveListener) return;
  removeMoveListener = v.camera.moveEnd.addEventListener(() => {
    if (moveTimer) clearTimeout(moveTimer);
    moveTimer = setTimeout(() => { for (const l of active.values()) if (l.kind !== 'stations') void draw(l); }, 400);
  });
}

function dropMapObjects(id: string, v: Viewer | null) {
  const il = imagery.get(id);
  if (il && v) v.imageryLayers.remove(il, true);
  imagery.delete(id);
  const bu = blobUrls.get(id);
  if (bu) URL.revokeObjectURL(bu);
  blobUrls.delete(id);
  const ds = sources.get(id);
  if (ds && v) v.dataSources.remove(ds, true);
  sources.delete(id);
}

/** Thrown when a newer draw (or a hide) superseded this one: nothing may be added to the map after that. */
class Superseded extends Error {}

async function swapSource(v: Viewer, id: string, ds: CustomDataSource, alive: () => boolean) {
  if (!alive()) throw new Superseded();
  const prev = sources.get(id);
  await v.dataSources.add(ds);
  if (!alive()) { v.dataSources.remove(ds, true); throw new Superseded(); }
  if (prev) v.dataSources.remove(prev, true);
  sources.set(id, ds);
}

async function drawRaster(v: Viewer, l: EnvDataLayer, st: EnvDataOverlayState, box: NonNullable<ReturnType<typeof viewBox>>, guard: () => boolean) {
  const width = renderWidth(box.view, box.bbox, v.canvas.clientWidth || 1440);
  const url = envDataApi.renderUrl(l.id, box.bbox, width, st.variant);
  const rect = Rectangle.fromDegrees(box.bbox[0], box.bbox[1], box.bbox[2], box.bbox[3]);
  // Probe first so an error is reported instead of an empty map
  const r = await fetch(url, { signal: AbortSignal.timeout(TIMEOUT_MS) });
  if (!r.ok) {
    let detail = `${r.status}`;
    try { const j = await r.json(); if (typeof j.detail === 'string') detail = `${r.status} ${j.detail}`; } catch { /* keep status */ }
    throw new Error(`server could not render this view (${detail})`);
  }
  const blob = await r.blob();
  if (!guard()) throw new Superseded();
  const blobUrl = URL.createObjectURL(blob);
  let provider: SingleTileImageryProvider;
  try { provider = await SingleTileImageryProvider.fromUrl(blobUrl, { rectangle: rect }); } catch (e) { URL.revokeObjectURL(blobUrl); throw e; }
  if (!guard()) { URL.revokeObjectURL(blobUrl); throw new Superseded(); }
  const layer = new ImageryLayer(provider, { alpha: RASTER_ALPHA });
  (layer as unknown as { __uosEnvOverlay: boolean }).__uosEnvOverlay = true;
  const prev = imagery.get(l.id);
  v.imageryLayers.add(layer);
  layer.show = true;
  layer.alpha = RASTER_ALPHA;
  if (prev) v.imageryLayers.remove(prev, true);
  imagery.set(l.id, layer);
  const prevBlob = blobUrls.get(l.id);
  if (prevBlob) URL.revokeObjectURL(prevBlob);
  blobUrls.set(l.id, blobUrl);
  return `Rendered by the server for the ${box.from} (${width} px wide).`;
}

const lift = (lon: number, lat: number) => Cartesian3.fromDegrees(lon, lat, 2);

async function drawStreams(v: Viewer, l: EnvDataLayer, box: NonNullable<ReturnType<typeof viewBox>>, alive: () => boolean) {
  const res = await envDataApi.features(l.id, box.bbox, 2000);
  if (!alive()) throw new Superseded();
  const ds = new CustomDataSource(`env-data-${l.id}`);
  for (const f of res.geojson.features) {
    const lines = f.geometry.type === 'MultiLineString' ? (f.geometry.coordinates as number[][][]) : [f.geometry.coordinates as number[][]];
    lines.forEach((c, i) => {
      if (c.length < 2) return;
      ds.entities.add({ id: `env_overlay_${l.id}_${f.id}_${i}`, polyline: { positions: c.map(p => lift(p[0], p[1])), width: 2, material: STREAM_COLOR } });
    });
  }
  await swapSource(v, l.id, ds, alive);
  return `${res.returned.toLocaleString()} of ${res.total.toLocaleString()} derived flow paths in the ${box.from}` +
    (res.not_shown ? ` (${res.not_shown.toLocaleString()} more not shown; zoom in).` : '.');
}

async function drawTrees(v: Viewer, l: EnvDataLayer, box: NonNullable<ReturnType<typeof viewBox>>, alive: () => boolean) {
  const res = await envDataApi.trees(box.bbox, 3000);
  if (!alive()) throw new Superseded();
  const ds = new CustomDataSource(`env-data-${l.id}`);
  if (res.mode === 'points') {
    for (const p of res.points) {
      ds.entities.add({
        id: `env_overlay_tree_${p.id}`, name: p.common_name ?? p.botanical_name ?? 'Tree',
        position: Cartesian3.fromDegrees(p.lon, p.lat),
        point: { pixelSize: 6, color: p.is_rare === 1 ? Color.fromCssColorString('#c0ca33') : TREE_COLOR, outlineColor: Color.BLACK, outlineWidth: 1,
          heightReference: HeightReference.CLAMP_TO_GROUND, disableDepthTestDistance: Number.POSITIVE_INFINITY },
        description: `${p.botanical_name ?? 'species UNKNOWN'} (${p.common_name ?? '—'}); girth ${p.girth_cm ?? '?'} cm, height ${p.height_m ?? '?'} m, ` +
          `canopy ${p.canopy_dia_m ?? '?'} m; ${p.condition ?? 'condition UNKNOWN'}; ${p.ownership ?? ''}; ward ${p.ward ?? '?'}. PMC tree census 2019 (as published).`,
      });
    }
  } else {
    // size by count relative to the 90th percentile, so one dense cell does not flatten the rest
    const ns = res.clusters.map(c => c.n).sort((a, b) => a - b);
    const maxN = Math.max(1, ns[Math.floor(ns.length * 0.9)] ?? 1);
    for (const c of res.clusters) {
      ds.entities.add({
        id: `env_overlay_treecl_${c.lon.toFixed(5)}_${c.lat.toFixed(5)}`, position: Cartesian3.fromDegrees(c.lon, c.lat),
        point: { pixelSize: 5 + 17 * Math.sqrt(Math.min(1, c.n / maxN)), color: TREE_COLOR.withAlpha(0.7), outlineColor: Color.WHITE, outlineWidth: 1,
          heightReference: HeightReference.CLAMP_TO_GROUND, disableDepthTestDistance: Number.POSITIVE_INFINITY },
        label: res.clusters.length <= 400 && c.n >= maxN * 0.5 ? { text: `${c.n >= 1000 ? `${(c.n / 1000).toFixed(c.n >= 10000 ? 0 : 1)}k` : c.n} trees`, font: '11px sans-serif',
          fillColor: Color.WHITE, outlineColor: Color.BLACK, outlineWidth: 3, style: LabelStyle.FILL_AND_OUTLINE, verticalOrigin: VerticalOrigin.CENTER,
          disableDepthTestDistance: Number.POSITIVE_INFINITY, heightReference: HeightReference.CLAMP_TO_GROUND } : undefined,
      });
    }
  }
  await swapSource(v, l.id, ds, alive);
  return res.mode === 'points'
    ? `${res.returned.toLocaleString()} trees in the ${box.from} (all of them; cap ${res.limit.toLocaleString()}).`
    : res.message;
}

let stationCache: AqStation[] | null = null;
export async function loadStations(): Promise<AqStation[]> {
  if (!stationCache) stationCache = (await envDataApi.airStations()).stations;
  return stationCache;
}

async function drawStations(v: Viewer, l: EnvDataLayer, alive: () => boolean) {
  const st = await loadStations();
  if (!alive()) throw new Superseded();
  const ds = new CustomDataSource(`env-data-${l.id}`);
  let drawn = 0;
  for (const s of st) {
    if (s.lon == null || s.lat == null) continue;
    drawn++;
    ds.entities.add({
      id: `env_overlay_aq_${s.station_id}`, name: s.name, position: Cartesian3.fromDegrees(s.lon, s.lat),
      point: { pixelSize: 11, color: s.has_series ? STATION_COLOR : Color.GRAY, outlineColor: Color.BLACK, outlineWidth: 1.5,
        heightReference: HeightReference.CLAMP_TO_GROUND, disableDepthTestDistance: Number.POSITIVE_INFINITY },
      label: { text: s.name.replace(/, Pune.*$/, ''), font: '12px sans-serif', fillColor: Color.WHITE, outlineColor: Color.BLACK, outlineWidth: 3,
        style: LabelStyle.FILL_AND_OUTLINE, verticalOrigin: VerticalOrigin.BOTTOM, pixelOffset: new Cartesian2(0, -10),
        heightReference: HeightReference.CLAMP_TO_GROUND, disableDepthTestDistance: Number.POSITIVE_INFINITY, translucencyByDistance: new NearFarScalar(2e4, 1, 2e5, 0.6) },
    });
  }
  await swapSource(v, l.id, ds, alive);
  return `${drawn} of ${st.length} stations drawn (${st.length - drawn} have UNKNOWN coordinates; grey = no downloaded series). No interpolated surface.`;
}

async function draw(l: EnvDataLayer): Promise<void> {
  const v = viewer();
  const store = useEnvDataOverlayStore.getState();
  if (!v) { store.set(l.id, { status: 'error', error: 'The map is not ready.' }); return; }
  const my = (seq.get(l.id) ?? 0) + 1;
  seq.set(l.id, my);
  const st = overlayState(l.id);
  store.set(l.id, { status: 'loading', error: null });
  const alive = () => seq.get(l.id) === my && active.has(l.id);
  try {
      let message: string;
    let box: ReturnType<typeof viewBox> = null;
    if (l.kind === 'stations') message = await drawStations(v, l, alive);
    else {
      box = viewBox(v, l);
      if (!box) {
        dropMapObjects(l.id, v);
        store.set(l.id, { status: 'shown', bbox: null, bboxFrom: null, message: 'The camera view does not overlap this layer (Pune study area).' });
        return;
      }
          message = l.kind === 'raster' ? await drawRaster(v, l, st, box, alive) : l.kind === 'points' ? await drawTrees(v, l, box, alive) : await drawStreams(v, l, box, alive);
    }
    if (!alive()) return;
    v.scene.requestRender();
    store.set(l.id, { status: 'shown', bbox: box?.bbox ?? null, bboxFrom: box?.from ?? null, message });
  } catch (e) {
    if (e instanceof Superseded || !alive()) return;
    const msg = e instanceof Error ? (e.name === 'TimeoutError' ? `no answer from the server within ${TIMEOUT_MS / 1000} s` : e.message) : String(e);
    dropMapObjects(l.id, v);   // never leave an older view's drawing under an error message
    store.set(l.id, { status: 'error', error: msg, message: null });
  }
}

/** Shows or hides one env-data layer; `variant` picks the date / property for rasters with variants. */
export async function setEnvDataVisible(l: EnvDataLayer, visible: boolean, variant?: string | null): Promise<void> {
  const v = viewer();
  const store = useEnvDataOverlayStore.getState();
  if (!visible) {
    active.delete(l.id);
    seq.set(l.id, (seq.get(l.id) ?? 0) + 1);
    dropMapObjects(l.id, v);
    store.set(l.id, { ...OFF, variant: overlayState(l.id).variant });
    v?.scene.requestRender();
    return;
  }
  if (variant !== undefined) store.set(l.id, { variant });
  else if (!overlayState(l.id).variant && l.variants.length) store.set(l.id, { variant: l.variants[0].id });
  active.set(l.id, l);
  if (v) ensureMoveListener(v);
  await draw(l);
}

export async function setEnvDataVariant(l: EnvDataLayer, variant: string): Promise<void> {
  useEnvDataOverlayStore.getState().set(l.id, { variant });
  if (active.has(l.id)) await draw(l);
}

/** Current camera view box [w,s,e,n] in degrees, or null. */
export function cameraBox(): number[] | null {
  const v = viewer();
  const r = v?.camera.computeViewRectangle();
  return r ? [r.west, r.south, r.east, r.north].map(CesiumMath.toDegrees) : null;
}

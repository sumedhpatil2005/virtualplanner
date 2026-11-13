/**
 * Map overlay for Explore → Municipal infrastructure (PMC via OpenCity) and merged building footprints
 * (docs/urbanos/INFRASTRUCTURE_DATA.md). Each shown layer loads only the features in the camera view from
 * GET /api/infra/layers/{id}/features (bbox, capped; the "N more not shown" count is reported), and reloads when the
 * camera stops. Nothing is drawn without data. Clicking a drawn feature opens it in the attribute inspector.
 *
 * Entity ids are `muni:<layer>:<fid>[:part]` so the engine's pick handler never treats them as city objects.
 */
import { create } from 'zustand';
import {
  Cartesian3, Color, CustomDataSource, Math as CesiumMath, PolygonHierarchy, ScreenSpaceEventHandler, ScreenSpaceEventType, defined, type Viewer,
} from 'cesium';
import { engineInstance } from '../../engine/TwinCityEngine';
import { infraApi, type InfraFeatureCollection, type InfraLayer } from '../../lib/infraApi';
import { colorOf, intersects, loadedLine, outsideLine } from './municipalModel';

export interface MuniLayerState { status: 'off' | 'loading' | 'shown' | 'error'; line: string | null; error: string | null; returned: number | null }
const OFF: MuniLayerState = { status: 'off', line: null, error: null, returned: null };

interface Store {
  layers: Record<string, MuniLayerState>;
  inspected: { layer: InfraLayer; props: Record<string, unknown> } | null;
  set: (id: string, s: Partial<MuniLayerState>) => void;
  inspect: (v: Store['inspected']) => void;
}
export const useMuniStore = create<Store>(set => ({
  layers: {},
  inspected: null,
  set: (id, s) => set(st => ({ layers: { ...st.layers, [id]: { ...(st.layers[id] ?? OFF), ...s } } })),
  inspect: v => set({ inspected: v }),
}));

const sources = new Map<string, CustomDataSource>();
const metaById = new Map<string, InfraLayer>();
const props = new Map<string, Record<string, unknown>>();   // `${layer}:${fid}` → properties of a drawn feature
const seq = new Map<string, number>();
let handler: ScreenSpaceEventHandler | null = null;
let moveUnsub: (() => void) | null = null;
let moveTimer: ReturnType<typeof setTimeout> | null = null;
const LIFT_M = 1.5;
const FILLED = new Set(['buildings', 'parks', 'stps', 'crematoriums', 'rivers']);

function viewer(): Viewer | null {
  const v = engineInstance.getViewer() as Viewer | null;
  return v && !v.isDestroyed() ? v : null;
}

export function viewBox(v: Viewer): number[] | null {
  const r = v.camera.computeViewRectangle();
  if (!r) return null;
  return [r.west, r.south, r.east, r.north].map(CesiumMath.toDegrees);
}

const pos = (ring: number[][]) => Cartesian3.fromDegreesArrayHeights(ring.flatMap(c => [c[0], c[1], LIFT_M]));

function drawGeometry(ds: CustomDataSource, id: string, layerId: string, g: { type: string; coordinates: unknown }, color: Color): void {
  const c = g.coordinates as never;
  switch (g.type) {
    case 'Point': {
      const [lon, lat] = c as number[];
      ds.entities.add({ id, position: Cartesian3.fromDegrees(lon, lat, LIFT_M), point: { pixelSize: layerId === 'bus_stops' ? 6 : 8, color, outlineColor: Color.BLACK, outlineWidth: 1, disableDepthTestDistance: Number.POSITIVE_INFINITY } });
      return;
    }
    case 'MultiPoint': (c as number[][]).forEach((p, i) => drawGeometry(ds, `${id}:${i}`, layerId, { type: 'Point', coordinates: p }, color)); return;
    case 'LineString':
      ds.entities.add({ id, polyline: { positions: pos(c as number[][]), width: layerId === 'sewer' || layerId === 'storm_drains' ? 2.5 : 2, material: color } });
      return;
    case 'MultiLineString': (c as number[][][]).forEach((l, i) => drawGeometry(ds, `${id}:${i}`, layerId, { type: 'LineString', coordinates: l }, color)); return;
    case 'Polygon': {
      const rings = c as number[][][];
      if (!rings.length || rings[0].length < 3) return;
      if (FILLED.has(layerId)) ds.entities.add({ id, polygon: { hierarchy: new PolygonHierarchy(pos(rings[0])), height: 0.5, material: color.withAlpha(layerId === 'buildings' ? 0.55 : 0.3), outline: false } });
      ds.entities.add({ id: `${id}:edge`, polyline: { positions: pos(rings[0]), width: layerId === 'buildings' ? 1 : 2, material: color } });
      return;
    }
    case 'MultiPolygon': (c as number[][][][]).forEach((p, i) => drawGeometry(ds, `${id}:${i}`, layerId, { type: 'Polygon', coordinates: p }, color)); return;
    default: return;
  }
}

function draw(ds: CustomDataSource, fc: InfraFeatureCollection): void {
  for (const f of fc.features) {
    const p = f.properties;
    props.set(`${fc.layer}:${p._fid}`, p);
    drawGeometry(ds, `muni:${fc.layer}:${p._fid}`, fc.layer, f.geometry, Color.fromCssColorString(colorOf(fc.layer, p)));
  }
}

function ensureHandlers(v: Viewer): void {
  if (!handler) {
    handler = new ScreenSpaceEventHandler(v.scene.canvas);
    handler.setInputAction((click: { position: { x: number; y: number } }) => {
      const picked = v.scene.pick(click.position as never);
      const id = defined(picked) && typeof picked.id?.id === 'string' ? (picked.id.id as string) : '';
      const m = /^muni:([a-z0-9_]+):(\d+)/.exec(id);
      if (!m) return;
      const meta = metaById.get(m[1]);
      const pr = props.get(`${m[1]}:${m[2]}`);
      if (meta && pr) useMuniStore.getState().inspect({ layer: meta, props: pr });
    }, ScreenSpaceEventType.LEFT_CLICK);
  }
  if (!moveUnsub) {
    moveUnsub = v.camera.moveEnd.addEventListener(() => {
      if (moveTimer) clearTimeout(moveTimer);
      moveTimer = setTimeout(() => { for (const id of sources.keys()) void load(id); }, 350);
    });
  }
}

async function load(id: string): Promise<void> {
  const v = viewer();
  const meta = metaById.get(id);
  const st = useMuniStore.getState();
  if (!v || !meta) { st.set(id, { status: 'error', error: 'The map is not ready.' }); return; }
  const bbox = viewBox(v);
  const n = (seq.get(id) ?? 0) + 1;
  seq.set(id, n);
  if (!bbox) { clearDrawn(id); st.set(id, { status: 'shown', line: 'Camera view could not be read (horizon in view): tilt down or zoom in to load features.', returned: 0, error: null }); return; }
  if (!intersects(bbox, meta.bbox)) { clearDrawn(id); st.set(id, { status: 'shown', line: outsideLine(), returned: 0, error: null }); return; }
  st.set(id, { status: 'loading', error: null });
  try {
    const fc = await infraApi.features(id, bbox);
    if (seq.get(id) !== n || !sources.has(id)) return;
    const ds = sources.get(id)!;
    ds.entities.suspendEvents();
    clearDrawn(id);
    draw(ds, fc);
    ds.entities.resumeEvents();
    v.scene.requestRender();
    st.set(id, { status: 'shown', line: loadedLine(fc), returned: fc.returned });
  } catch (e) {
    if (seq.get(id) === n && sources.has(id)) {
      clearDrawn(id);
      removeSource(id);   // an errored layer is off: camera moves do not retry it behind the user's back
      st.set(id, { status: 'error', error: `Could not load features: ${e instanceof Error ? e.message : String(e)}. Nothing drawn for this layer.` });
    }
  }
}

function removeSource(id: string): void {
  const ds = sources.get(id);
  const v = viewer();
  if (ds && v) v.dataSources.remove(ds, true);
  sources.delete(id);
}

function clearDrawn(id: string): void {
  sources.get(id)?.entities.removeAll();
  for (const k of [...props.keys()]) if (k.startsWith(`${id}:`)) props.delete(k);
  viewer()?.scene.requestRender();
}

/** Shows or hides one municipal / buildings layer. */
export async function setMuniLayerVisible(layer: InfraLayer, visible: boolean): Promise<void> {
  const v = viewer();
  const st = useMuniStore.getState();
  metaById.set(layer.id, layer);
  if (!visible) {
    seq.set(layer.id, (seq.get(layer.id) ?? 0) + 1);   // a response still in flight is discarded
    removeSource(layer.id);
    for (const k of [...props.keys()]) if (k.startsWith(`${layer.id}:`)) props.delete(k);
    if (st.inspected?.layer.id === layer.id) st.inspect(null);
    st.set(layer.id, OFF);
    return;
  }
  if (!v) { st.set(layer.id, { status: 'error', error: 'The map is not ready.' }); return; }
  if (!sources.has(layer.id)) {
    const ds = new CustomDataSource(`muni-${layer.id}`);
    await v.dataSources.add(ds);
    sources.set(layer.id, ds);
  }
  ensureHandlers(v);
  await load(layer.id);
}

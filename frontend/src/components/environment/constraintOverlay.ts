/**
 * Map overlay for OSM-derived constraint layers (water, heritage, railway) that exist in the backend's feasibility
 * layers but have no engine renderer. Features come from GET /api/feasibility/site-data, the same data feasibility
 * screening reads, for the layers' own coverage box (GET /api/feasibility/status → layers.bbox), or the camera view
 * when no coverage box is reported. Nothing is drawn without data; a failed fetch is reported, never filled in.
 *
 * Entity ids are prefixed `env_overlay_` so the engine's pick handler never treats them as city objects.
 */
import { create } from 'zustand';
import { Cartesian3, Color, CustomDataSource, HeightReference, LabelStyle, PolygonHierarchy, VerticalOrigin, Math as CesiumMath, type Viewer } from 'cesium';
import { engineInstance } from '../../engine/TwinCityEngine';
import { fetchSiteData } from '../../engine/feasibility/feasibilityApi';
import type { OsmElement } from '../../engine/feasibility/types';
import { API_BASE } from '../../lib/api';
import type { OverlayKey } from './envCatalogue';

export interface OverlayState {
  status: 'off' | 'loading' | 'shown' | 'error';
  /** Features drawn (as returned by the backend). */
  count: number | null;
  error: string | null;
  /** Box the features were requested for: [minLng, minLat, maxLng, maxLat]. */
  bbox: number[] | null;
  bboxFrom: 'layer coverage' | 'camera view' | null;
}

const OFF: OverlayState = { status: 'off', count: null, error: null, bbox: null, bboxFrom: null };

export const OVERLAY_STYLE: Record<OverlayKey, { label: string; css: string; color: Color }> = {
  water: { label: 'Water bodies & waterways', css: '#4FA3FF', color: Color.fromCssColorString('#4FA3FF') },
  heritage: { label: 'Heritage locators', css: '#E8B04A', color: Color.fromCssColorString('#E8B04A') },
  railway: { label: 'Railways', css: '#C9A0FF', color: Color.fromCssColorString('#C9A0FF') },
};

interface Store {
  overlays: Record<OverlayKey, OverlayState>;
  set: (k: OverlayKey, s: Partial<OverlayState>) => void;
}

export const useEnvOverlayStore = create<Store>(set => ({
  overlays: { water: OFF, heritage: OFF, railway: OFF },
  set: (k, s) => set(st => ({ overlays: { ...st.overlays, [k]: { ...st.overlays[k], ...s } } })),
}));

const sources = new Map<OverlayKey, CustomDataSource>();
let requestSeq = 0;

function viewer(): Viewer | null {
  const v = engineInstance.getViewer() as Viewer | null;
  return v && !v.isDestroyed() ? v : null;
}

async function coverageBox(): Promise<{ bbox: number[]; from: OverlayState['bboxFrom'] } | null> {
  try {
    const r = await fetch(`${API_BASE}/api/feasibility/status`);
    if (r.ok) {
      const j = await r.json();
      const b = j?.layers?.bbox;
      if (Array.isArray(b) && b.length === 4) return { bbox: b, from: 'layer coverage' };
    }
  } catch { /* fall back to the camera */ }
  const v = viewer();
  const rect = v?.camera.computeViewRectangle();
  if (!rect) return null;
  return { bbox: [rect.west, rect.south, rect.east, rect.north].map(CesiumMath.toDegrees), from: 'camera view' };
}

// City models sit at ellipsoid height (engine/layers/LayerManager: terrain is off by default), so overlays are drawn just
// above it rather than clamped to terrain: clamped ground primitives load asynchronously and did not show in the scene.
const LIFT_M = 1.5;
const ring = (pts: { lon: number; lat: number }[]) => Cartesian3.fromDegreesArrayHeights(pts.flatMap(p => [p.lon, p.lat, LIFT_M]));

function draw(ds: CustomDataSource, key: OverlayKey, els: OsmElement[]): number {
  const { color } = OVERLAY_STYLE[key];
  let n = 0;
  for (const e of els) {
    const id = `env_overlay_${key}_${e.type}_${e.id}`;
    const name = e.tags?.name ?? e.tags?.['name:en'] ?? undefined;
    if (e.type === 'node' && e.lon !== undefined && e.lat !== undefined) {
      ds.entities.add({
        id, name,
        position: Cartesian3.fromDegrees(e.lon, e.lat),
        point: { pixelSize: 9, color, outlineColor: Color.BLACK, outlineWidth: 1.5, heightReference: HeightReference.CLAMP_TO_GROUND, disableDepthTestDistance: Number.POSITIVE_INFINITY },
        label: name && key === 'heritage' ? { text: name, font: '12px sans-serif', fillColor: Color.WHITE, outlineColor: Color.BLACK, outlineWidth: 3, style: LabelStyle.FILL_AND_OUTLINE, verticalOrigin: VerticalOrigin.BOTTOM, pixelOffset: undefined, heightReference: HeightReference.CLAMP_TO_GROUND, disableDepthTestDistance: Number.POSITIVE_INFINITY, distanceDisplayCondition: undefined, scale: 1 } : undefined,
      });
      n++;
    } else if (e.outer && e.outer.length) {
      e.outer.forEach((o, i) => {
        if (o.length < 3) return;
        ds.entities.add({ id: `${id}_${i}`, name, polygon: { hierarchy: new PolygonHierarchy(ring(o)), height: 0.5, material: color.withAlpha(0.35), outline: false } });
        ds.entities.add({ id: `${id}_${i}_edge`, name, polyline: { positions: ring(o), width: 2, material: color, clampToGround: false } });
      });
      n++;
    } else if (e.geometry && e.geometry.length >= 2) {
      ds.entities.add({ id, name, polyline: { positions: ring(e.geometry), width: key === 'railway' ? 2 : 3, material: color, clampToGround: false } });
      n++;
    } else if (e.members?.length) {
      e.members.forEach((m, i) => { if (m.geometry?.length >= 2) ds.entities.add({ id: `${id}_m${i}`, name, polyline: { positions: ring(m.geometry), width: 2, material: color, clampToGround: false } }); });
      n++;
    }
  }
  return n;
}

/** Shows or hides one overlay. Showing fetches the features (once per show) and draws them. */
export async function setOverlayVisible(key: OverlayKey, visible: boolean): Promise<void> {
  const st = useEnvOverlayStore.getState();
  const v = viewer();
  if (!visible) {
    const ds = sources.get(key);
    if (ds && v) v.dataSources.remove(ds, true);
    sources.delete(key);
    st.set(key, OFF);
    return;
  }
  if (!v) { st.set(key, { status: 'error', error: 'The map is not ready.' }); return; }
  const seq = ++requestSeq;
  st.set(key, { status: 'loading', error: null, count: null });
  try {
    const cov = await coverageBox();
    if (!cov) throw new Error('No area to request: layer coverage unknown and the camera view could not be read.');
    // near_bbox only bounds the dense layers (buildings, roads, trees) the overlay does not use: keep it tiny.
    const [x0, y0] = cov.bbox;
    const res = await fetchSiteData(cov.bbox, [x0, y0, x0 + 0.0001, y0 + 0.0001]);
    if (seq !== requestSeq && useEnvOverlayStore.getState().overlays[key].status !== 'loading') return;
    const layerStatus = res.layers[key];
    if (!layerStatus?.available) throw new Error(layerStatus?.reason ?? 'Layer not available');
    const prev = sources.get(key);
    if (prev) v.dataSources.remove(prev, true);
    const ds = new CustomDataSource(`env-overlay-${key}`);
    const n = draw(ds, key, res.elements[key] ?? []);
    await v.dataSources.add(ds);
    sources.set(key, ds);
    v.scene.requestRender();
    st.set(key, { status: 'shown', count: n, bbox: cov.bbox, bboxFrom: cov.from });
  } catch (e) {
    st.set(key, { status: 'error', error: e instanceof Error ? e.message : String(e) });
  }
}

import { describe, expect, it, vi } from 'vitest';

// A slow overlay load that finishes after the user switched it off must add nothing (no stale layer).
let release: (() => void) | null = null;
vi.mock('cesium', () => ({
  Cartesian2: class {}, ImageryLayer: class {}, ScreenSpaceEventHandler: class {}, ScreenSpaceEventType: {}, Math: { toDegrees: (x: number) => x },
  Rectangle: { fromDegrees: (...a: number[]) => ({ west: a[0], south: a[1], east: a[2], north: a[3] }) },
  SingleTileImageryProvider: { fromUrl: () => new Promise(res => { release = () => res({ rectangle: { west: 0, south: 0, east: 1, north: 1 } }); }) },
}));
const added: unknown[] = [];
const viewer = {
  isDestroyed: () => false, scene: { requestRender: () => {} },
  imageryLayers: { addImageryProvider: (p: unknown) => { const l = { p, alpha: 1 }; added.push(l); return l; }, remove: (l: unknown) => { added.splice(added.indexOf(l), 1); } },
};
vi.mock('../TwinCityEngine', () => ({ engineInstance: { getViewer: () => viewer } }));
vi.mock('../../lib/terrainApi', () => ({
  terrainApi: {
    overlays: async () => ({ bounds_wgs84: { west: 73.7, south: 18.4, east: 74.05, north: 18.7 }, attribution: 'test', overlays: { hillshade: { url: '/h.png' }, slope: { url: '/s.png' } } }),
    overlayUrl: (u: string) => u,
  },
}));

describe('terrain overlay toggles', () => {
  it('on → off while loading leaves no layer and the state off', async () => {
    const { setTerrainOverlay, useTerrainOverlayStore } = await import('../../components/explore/terrainOverlay');
    const on = setTerrainOverlay('slope', true);
    await new Promise(r => setTimeout(r, 0));
    expect(useTerrainOverlayStore.getState().shown.slope).toBe('loading');
    await setTerrainOverlay('slope', false);
    release!();
    await on;
    expect(added.length).toBe(0);
    expect(useTerrainOverlayStore.getState().shown.slope).toBe('off');
  });
  it('a normal on adds exactly one layer, off removes it', async () => {
    const { setTerrainOverlay, useTerrainOverlayStore } = await import('../../components/explore/terrainOverlay');
    const on = setTerrainOverlay('hillshade', true);
    await new Promise(r => setTimeout(r, 0));
    release!();
    await on;
    expect(added.length).toBe(1);
    expect(useTerrainOverlayStore.getState().shown.hillshade).toBe('shown');
    await setTerrainOverlay('hillshade', false);
    expect(added.length).toBe(0);
  });
});

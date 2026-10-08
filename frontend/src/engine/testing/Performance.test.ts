import { describe, it, expect, vi, afterEach } from 'vitest';

vi.mock('cesium', async () => {
  const { cesiumRenderMock } = await import('./__setup__/cesiumRenderMock');
  return cesiumRenderMock();
});

import { Viewer } from 'cesium';
import { RenderManager } from '../rendering/RenderManager';
import { MeshCache } from '../rendering/cache/MeshCache';
import { GeometryContext } from '../rendering/geometry/GeometryContext';
import { filterObjectsForScenario } from '../scenarios/scenarioFilter';
import { OverpassClient, OverpassCancelledError } from '../editing/OverpassClient';
import { ObjectManager } from '../objects/ObjectManager';
import type { CityObject, BuildingObject, JunctionObject, RoadObject } from '../objects/types';
import type { MeshData } from '../rendering/types';

const now = new Date().toISOString();
const building = (id: string, x: number, y = 18.5): BuildingObject => ({
  id, type: 'building', name: id, layerId: 'buildings', scenarioId: 'base',
  coordinates: [[x, y, 0], [x + 0.0002, y, 0], [x + 0.0002, y + 0.0002, 0], [x, y + 0.0002, 0], [x, y, 0]],
  usageType: 'residential', height: 30, floors: 10, population: 100, parkingSpaces: 10,
  waterDemand: 1, electricityDemand: 1, constructionYear: 2020, createdAt: now, updatedAt: now,
} as BuildingObject);
const road = (id: string, coords: [number, number, number][]): RoadObject => ({
  id, type: 'road', name: id, layerId: 'roads', scenarioId: 'base', coordinates: coords,
  roadClass: 'local', width: 10, laneCount: 2, laneWidth: 3.5, hasDivider: false, dividerWidth: 0,
  hasFootpath: false, footpathWidth: 0, speedLimit: 40, isOneWay: false, trafficCapacity: 1000,
  connectedJunctions: [], createdAt: now, updatedAt: now,
} as RoadObject);
const mesh = (vertices: number): MeshData => ({
  positions: new Float64Array(vertices * 3), indices: new Uint32Array(0), material: { color: '#fff' } as any,
});

const setupRenderManager = (height = 800) => {
  const viewer = new Viewer('x' as any) as any;
  viewer.camera.positionCartographic.height = height;
  const rm = new RenderManager();
  rm.initialize(viewer);
  return rm;
};
const loadAll = (rm: RenderManager, objs: CityObject[]) => {
  const grid = rm.getSpatialGrid();
  rm.updateVisibleTiles([...new Set(objs.flatMap(o => grid.getTileKeysForObject(o.id)))]);
  vi.runAllTimers();
};

afterEach(() => {
  vi.useRealTimers();
});

describe('Item 26 — change detection without JSON.stringify', () => {
  it('ObjectManager replaces objects on update, so identity marks a change', () => {
    const om = new ObjectManager();
    om.add(building('b', 73.7), true);
    const before = om.getById('b');
    om.update('b', { name: 'x' }, true);
    expect(om.getById('b')).not.toBe(before);
  });

  it('does not regenerate meshes when nothing changed, and does for an edit', () => {
    vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout'] });
    const rm = setupRenderManager();
    const objs = [building('b1', 73.70), building('b2', 73.71)];
    rm.reconcile(objs);
    loadAll(rm, objs);

    const gen = vi.spyOn((rm as any).generator, 'generateMeshData');
    rm.reconcile(objs);
    vi.runAllTimers();
    expect(gen).not.toHaveBeenCalled();

    rm.reconcile([{ ...objs[0], name: 'edited' }, objs[1]]);
    vi.runAllTimers();
    expect(gen.mock.calls.map(c => (c[0] as CityObject).id)).toEqual(['b1']);
  });
});

describe('Item 27 — type/spatial index instead of per-object scans', () => {
  it('finds junctions and road endpoints near a point', () => {
    const j: JunctionObject = {
      id: 'j', type: 'junction', name: 'j', layerId: 'junctions', scenarioId: 'base', coordinates: [73.7001, 18.5, 0],
      connectedRoads: [], hasSignals: false, signalTiming: 0, hasPedestrianCrossing: false, createdAt: now, updatedAt: now,
    };
    const far: JunctionObject = { ...j, id: 'far', coordinates: [73.9, 18.9, 0] };
    const r = road('r', [[73.7, 18.5, 0], [73.71, 18.5, 0]]);
    const ctx = new GeometryContext(new Map<string, CityObject>([[j.id, j], [far.id, far], [r.id, r]]));

    expect(ctx.junctionsNear(73.7, 18.5).map(x => x.id)).toEqual(['j']);
    expect(ctx.roadsWithEndpointNear(73.71, 18.5).map(x => x.id)).toEqual(['r']);
    expect(ctx.roadsWithEndpointNear(73.705, 18.5)).toEqual([]); // mid-road is not an endpoint
    expect(ctx.ofType('junction')).toHaveLength(2);
  });
});

describe('Item 28 — linear scenario filtering', () => {
  it('matches the old quadratic result', () => {
    const base = [building('a', 73.70), building('b', 73.71), building('c', 73.72)];
    const all: CityObject[] = [...base, { ...base[1], scenarioId: 'p', name: 'override' }, building('d', 73.73)];
    all[4] = { ...all[4], scenarioId: 'p' };
    all.push({ ...building('e', 73.74), scenarioId: 'other' });

    const legacy = all.filter(obj => {
      const isBase = obj.scenarioId === 'base';
      if (!isBase && obj.scenarioId !== 'p') return false;
      if (isBase) return !all.some(o => o.id === obj.id && o.scenarioId === 'p');
      return true;
    });
    expect(filterObjectsForScenario(all, 'p')).toEqual(legacy);
    expect(filterObjectsForScenario(all, 'base').map(o => o.id)).toEqual(['a', 'b', 'c']);
  });
});

describe('Item 29 — road tinting touches only that road’s tiles', () => {
  it('looks up only the tiles the road occupies', () => {
    vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout'] });
    const rm = setupRenderManager();
    const roads = Array.from({ length: 30 }, (_, i) => road(`r${i}`, [[73.70 + i * 0.01, 18.5, 0], [73.701 + i * 0.01, 18.5, 0]]));
    rm.reconcile(roads);
    loadAll(rm, roads);

    const renderer = rm.getRoadRenderer() as any;
    const lookups = vi.spyOn(renderer.tilePrimitives, 'get');
    rm.setRoadColor('r3', '#ff0000');
    expect(lookups.mock.calls.length).toBe(renderer.objectTiles.get('r3').length);
  });
});

describe('Item 32 — only the LOD tier in use is built', () => {
  it('builds the medium building tier at 800 m and adds close only when zooming in', () => {
    vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout'] });
    const rm = setupRenderManager(800);
    const objs = [building('b1', 73.70)];
    rm.reconcile(objs);
    loadAll(rm, objs);

    const renderer = rm.getBuildingRenderer() as any;
    const layers = () => [...renderer.tilePrimitives.values()].flatMap((m: Map<string, unknown>) => [...m.keys()]);
    expect(layers()).toEqual(['medium']);

    renderer.updateLOD(300);
    vi.runAllTimers();
    expect(layers().sort()).toEqual(['close', 'medium']);

    // Zooming back out only toggles visibility — no rebuild
    const rebuild = vi.spyOn(renderer, 'rebuildDirtyTiles');
    renderer.updateLOD(800);
    vi.runAllTimers();
    expect(rebuild).not.toHaveBeenCalled();
    const prims = [...renderer.tilePrimitives.values()][0] as Map<string, any>;
    expect(prims.get('medium').show).toBe(true);
    expect(prims.get('close').show).toBe(false);
  });
});

describe('Item 34 — bounded mesh cache', () => {
  it('evicts least-recently-used entries past the byte budget', () => {
    const bytes = mesh(10).positions.byteLength; // 240
    const cache = new MeshCache(bytes * 2);
    cache.set('a', [mesh(10)]);
    cache.set('b', [mesh(10)]);
    cache.get('a'); // a is now most recent
    cache.set('c', [mesh(10)]);
    expect(cache.has('a')).toBe(true);
    expect(cache.has('b')).toBe(false);
    expect(cache.getStats().bytes).toBeLessThanOrEqual(bytes * 2);
  });

  it('regenerates evicted meshes through the loader instead of losing them', () => {
    const cache = new MeshCache(1);
    const loader = vi.fn((id: string) => (id === 'x' ? [mesh(5)] : undefined));
    cache.setLoader(loader);
    cache.set('x', [mesh(5)]);
    cache.set('y', [mesh(5)]); // evicts x
    expect(cache.has('x')).toBe(false);
    expect(cache.get('x')).toHaveLength(1);
    expect(loader).toHaveBeenCalledWith('x');
  });
});

describe('Item 33 — Overpass client', () => {
  const ok = (body: unknown) => new Response(JSON.stringify(body), { status: 200 });
  const noSleep = () => Promise.resolve();

  it('skips a rate-limited mirror and cools it down using Retry-After', async () => {
    let t = 0;
    const fetchImpl = vi.fn()
      .mockResolvedValueOnce(new Response('', { status: 429, headers: { 'Retry-After': '120' } }))
      .mockResolvedValueOnce(ok({ elements: [1] }));
    const client = new OverpassClient({ endpoints: ['https://a.test/x', 'https://b.test/x'], fetchImpl, sleep: noSleep, now: () => t });

    expect(await client.query('q')).toEqual({ elements: [1] });
    // Mirror "a" is now cooling down: the next query goes straight to "b"
    fetchImpl.mockResolvedValueOnce(ok({ elements: [2] }));
    await client.query('q');
    expect(String(fetchImpl.mock.calls[2][0])).toContain('b.test');

    t = 121_000;
    fetchImpl.mockResolvedValueOnce(ok({ elements: [3] }));
    await client.query('q');
    expect(String(fetchImpl.mock.calls[3][0])).toContain('a.test');
  });

  it('reports when every mirror is cooling down instead of hammering them', async () => {
    const fetchImpl = vi.fn().mockResolvedValue(new Response('', { status: 429 }));
    const client = new OverpassClient({ endpoints: ['https://a.test/x'], fetchImpl, sleep: noSleep, now: () => 0 });
    await expect(client.query('q')).rejects.toThrow(/busy/);
    await expect(client.query('q')).rejects.toThrow(/Try again in 30 s/);
    expect(fetchImpl).toHaveBeenCalledTimes(1);
  });

  it('does not retry a malformed query on other mirrors', async () => {
    const fetchImpl = vi.fn().mockResolvedValue(new Response('parse error', { status: 400 }));
    const client = new OverpassClient({ endpoints: ['https://a.test/x', 'https://b.test/x'], fetchImpl, sleep: noSleep });
    await expect(client.query('bad')).rejects.toThrow(/400/);
    expect(fetchImpl).toHaveBeenCalledTimes(1);
  });

  it('times out a hung request and can be cancelled', async () => {
    const hang = (_: unknown, init: RequestInit) =>
      new Promise<Response>((_, reject) => init.signal!.addEventListener('abort', () => reject(new Error('aborted'))));

    const slow = new OverpassClient({ endpoints: ['https://a.test/x'], fetchImpl: vi.fn(hang) as any, requestTimeoutMs: 20, sleep: noSleep });
    await expect(slow.query('q')).rejects.toThrow(/did not respond/);

    const controller = new AbortController();
    const cancellable = new OverpassClient({ endpoints: ['https://a.test/x'], fetchImpl: vi.fn(hang) as any, sleep: noSleep });
    const pending = cancellable.query('q', controller.signal);
    controller.abort();
    await expect(pending).rejects.toBeInstanceOf(OverpassCancelledError);
  });
});

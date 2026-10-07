/**
 * Phase 4 performance benchmark — opt-in, prints timings for the report.
 *
 *   PowerShell:  $env:BENCH=1; npx vitest run --config vitest.config.ts PerformanceBench
 *   bash:        BENCH=1 npx vitest run --config vitest.config.ts PerformanceBench
 *   (set BENCH_OUT=<file.json> to also save the numbers)
 *
 * Builds a synthetic city at the real data scale (~3,900 buildings, ~3,500
 * roads, junctions) and times the hot paths named in the execution plan.
 * Cesium is mocked, so numbers cover the JavaScript work, not GPU upload.
 */
import { describe, it, expect, vi } from 'vitest';
import { writeFileSync } from 'fs';

vi.mock('cesium', async () => {
  const { cesiumRenderMock } = await import('./__setup__/cesiumRenderMock');
  return cesiumRenderMock();
});

import { RenderManager } from '../rendering/RenderManager';
import { ObjectManager } from '../objects/ObjectManager';
import { filterObjectsForScenario } from '../scenarios/scenarioFilter';
import { Viewer } from 'cesium';
import type { CityObject, RoadObject, BuildingObject, JunctionObject } from '../objects/types';

const BUILDINGS = 3914;
const ROADS = 3512;
const JUNCTIONS = 400;

function buildSyntheticCity(): CityObject[] {
  const objs: CityObject[] = [];
  const lon0 = 73.70, lat0 = 18.57, step = 0.0009;
  const now = new Date().toISOString();

  for (let i = 0; i < BUILDINGS; i++) {
    const x = lon0 + (i % 63) * step, y = lat0 + Math.floor(i / 63) * step;
    objs.push({
      id: `b${i}`, type: 'building', name: `B${i}`, layerId: 'buildings', scenarioId: 'base',
      coordinates: [[x, y, 0], [x + 0.0003, y, 0], [x + 0.0003, y + 0.0003, 0], [x, y + 0.0003, 0], [x, y, 0]],
      usageType: 'residential', height: 30, floors: 10, population: 100, parkingSpaces: 10,
      waterDemand: 15000, electricityDemand: 600, constructionYear: 2020, createdAt: now, updatedAt: now,
    } as BuildingObject);
  }
  for (let i = 0; i < ROADS; i++) {
    const x = lon0 + (i % 60) * step, y = lat0 + Math.floor(i / 60) * step;
    const horizontal = i % 2 === 0;
    objs.push({
      id: `r${i}`, type: 'road', name: `R${i}`, layerId: 'roads', scenarioId: 'base',
      coordinates: [[x, y, 0], horizontal ? [x + step, y, 0] : [x, y + step, 0]],
      roadClass: 'local', width: 10, laneCount: 2, laneWidth: 3.5, hasDivider: false, dividerWidth: 0,
      hasFootpath: true, footpathWidth: 1.5, speedLimit: 40, isOneWay: false, trafficCapacity: 1000,
      connectedJunctions: [], createdAt: now, updatedAt: now,
    } as RoadObject);
  }
  for (let i = 0; i < JUNCTIONS; i++) {
    const x = lon0 + (i % 60) * step, y = lat0 + Math.floor(i / 60) * step;
    objs.push({
      id: `j${i}`, type: 'junction', name: `J${i}`, layerId: 'junctions', scenarioId: 'base',
      coordinates: [x, y, 0], connectedRoads: [], hasSignals: true, signalTiming: 90,
      hasPedestrianCrossing: true, createdAt: now, updatedAt: now,
    } as JunctionObject);
  }
  // Go through ObjectManager so roads carry their derived cross-section data, as in the app
  const om = new ObjectManager();
  om.addMultiple(objs, true);
  // A proposal overriding ~200 base objects, to exercise scenario filtering
  om.addMultiple(objs.slice(0, 200).map(o => ({ ...o, id: `${o.id}_p`, scenarioId: 'proposal' })), true);
  return om.getAll();
}

const time = (fn: () => void): number => {
  const t = performance.now();
  fn();
  return performance.now() - t;
};
const r1 = (n: number) => Math.round(n * 10) / 10;

describe.runIf(!!process.env.BENCH)('Phase 4 benchmark', () => {
  it('times the render hot paths', () => {
    vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout'] });
    const city = buildSyntheticCity();
    const baseCity = city.filter(o => o.scenarioId === 'base');
    const rm = new RenderManager();
    rm.initialize(new Viewer('x' as any));

    const initial = time(() => rm.reconcile(baseCity));
    const noChange = time(() => rm.reconcile(baseCity));
    const edited = baseCity.map(o => (o.id === 'b10' ? { ...o, name: 'edited' } : o));
    const oneEdit = time(() => rm.reconcile(edited));

    // Load every tile, build primitives (flushing the renderers' debounce timers)
    const grid = rm.getSpatialGrid() as any;
    const allTiles: string[] = Array.from(new Set(baseCity.flatMap(o => grid.getTileKeysForObject(o.id) as string[])));
    const loadTiles = time(() => {
      rm.updateVisibleTiles(allTiles);
      vi.runAllTimers();
    });
    const primitives = (['getRoadRenderer', 'getBuildingRenderer', 'getTransitRenderer'] as const)
      .reduce((n, g) => n + [...((rm as any)[g]() as any).tilePrimitives.values()]
        .reduce((m: number, v: any) => m + (Array.isArray(v) ? v.length : v.size), 0), 0);

    // One traffic tick: re-colour every road (SimulationManager does this every 100 ms)
    const roads = baseCity.filter(o => o.type === 'road');
    const recolourAll = time(() => roads.forEach(r => rm.setRoadColor(r.id, '#ff0000')));

    // Scenario filtering (TwinCityEngine.getFilteredObjects) with a proposal active
    const filterScenario = time(() => filterObjectsForScenario(city, 'proposal'));
    const filterScenarioLegacy = time(() => {
      // Pre-Phase-4 algorithm, kept for the before/after comparison
      city.filter(obj => {
        const isBaseObj = obj.scenarioId === 'base';
        const isScenarioObj = obj.scenarioId === 'proposal';
        if (!isBaseObj && !isScenarioObj) return false;
        if (isBaseObj) return !city.some(o => o.id === obj.id && o.scenarioId === 'proposal');
        return true;
      });
    });

    let cachedVertices = 0;
    for (const o of baseCity) {
      for (const m of rm.getMeshCache().get(o.id) ?? []) cachedVertices += m.positions.length / 3;
    }
    vi.useRealTimers();

    const rows = {
      objects: city.length,
      'reconcile: initial (ms)': Math.round(initial),
      'reconcile: no change, e.g. layer toggle (ms)': r1(noChange),
      'reconcile: 1 edited object (ms)': r1(oneEdit),
      'load all tiles + build primitives (ms)': Math.round(loadTiles),
      'primitives built': primitives,
      'traffic tick: recolour all roads (ms)': r1(recolourAll),
      'scenario filter, proposal active (ms)': r1(filterScenario),
      'scenario filter, old O(n²) algorithm (ms)': r1(filterScenarioLegacy),
      'mesh cache vertices held': cachedVertices,
    };
    console.table(rows);
    if (process.env.BENCH_OUT) writeFileSync(process.env.BENCH_OUT, JSON.stringify(rows, null, 2));
    expect(city.length).toBeGreaterThan(7000);
  }, 300_000);
});

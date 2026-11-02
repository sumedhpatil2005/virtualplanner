import { describe, it, expect, afterEach } from 'vitest';
import { TerrainHeightField, cellsFor, cellKeyOf, CELL_DEG, type GroundSampler } from '../terrain/TerrainHeightField';
import { setGroundField, groundAt, sceneHeight, modelHeight, scenePoint, withFlatGround, groundRevision } from '../terrain/groundHeight';
import { ProceduralGeometryGenerator } from '../rendering/geometry/ProceduralGeometryGenerator';
import { normalizeIonToken } from '../../lib/cesiumToken';
import type { BuildingObject } from '../objects/types';

// Mocked terrain: a plane rising 100 m per 0.01° east and 50 m per 0.01° north from 560 m
const plane = (lng: number, lat: number) => 560 + (lng - 73.74) * 10000 + (lat - 18.59) * 5000;
const planeSampler: GroundSampler = async pts => pts.map(p => plane(p.lng, p.lat));

afterEach(() => setGroundField(null));

describe('terrain height field (mocked sampler)', () => {
  it('samples only the cells holding geometry and interpolates a plane exactly', async () => {
    const cells = cellsFor([[73.745, 18.595, 0], [73.746, 18.596, 6], [73.755, 18.595, 0]]);
    expect(cells.size).toBe(2);
    const f = new TerrainHeightField();
    expect(await f.addCells(cells, planeSampler, 11)).toBe(2);
    expect(f.heightAt(73.7451, 18.5953)).toBeCloseTo(plane(73.7451, 18.5953), 6);
    expect(f.heightAt(73.7577, 18.5999)).toBeCloseTo(plane(73.7577, 18.5999), 6);
    // Already held cells are not sampled again
    let calls = 0;
    expect(await f.addCells(cells, async p => { calls++; return planeSampler(p); }, 11)).toBe(0);
    expect(calls).toBe(0);
  });

  it('fills unknown samples with the cell median and skips a cell with none', async () => {
    const key = cellKeyOf(73.745, 18.595), empty = cellKeyOf(73.765, 18.595);
    const f = new TerrainHeightField();
    // 5x5 samples per cell, first cell first (cell edges touch, so index, not position, says which cell a sample is for)
    const sampler: GroundSampler = async pts => pts.map((_, i) => (i >= 25 ? undefined : i === 0 ? NaN : 600));
    expect(await f.addCells([key, empty], sampler, 5)).toBe(1);
    expect(f.has(key) && !f.has(empty)).toBe(true);
    expect(f.heightAt(73.74 + 0.0001, 18.59 + 0.0001)).toBeCloseTo(600, 6); // the NaN corner took the median
    expect(f.heightAt(73.765, 18.595)).toBeCloseTo(600, 6); // outside: field median, not 0
  });

  it('rejects a sampler that fails or answers with the wrong count, so the engine can fall back', async () => {
    const f = new TerrainHeightField();
    await expect(f.addCells(['1:1'], async () => { throw new Error('ion unreachable'); })).rejects.toThrow('ion unreachable');
    await expect(f.addCells(['1:1'], async () => [1, 2, 3])).rejects.toThrow(/heights for/);
    expect(f.cellCount).toBe(0);
  });

  it('cell keys tile the plane at 0.01°', () => {
    expect(cellKeyOf(73.7449, 18.5999)).toBe(`${Math.floor(73.7449 / CELL_DEG)}:${Math.floor(18.5999 / CELL_DEG)}`);
  });
});

describe('placing model heights on the ground', () => {
  it('without terrain the ground is the ellipsoid', () => {
    expect(groundAt(73.745, 18.595)).toBe(0);
    expect(sceneHeight(73.745, 18.595, 7)).toBe(7);
  });

  it('keeps bridge offsets relative to the sampled ground, and converts picks back', async () => {
    const f = new TerrainHeightField();
    await f.addCells(cellsFor([[73.745, 18.595]]), planeSampler, 11);
    const rev = groundRevision();
    setGroundField(f);
    expect(groundRevision()).toBe(rev + 1);
    const g = plane(73.7452, 18.5957);
    expect(sceneHeight(73.7452, 18.5957, 0)).toBeCloseTo(g, 6); // road at grade
    expect(sceneHeight(73.7452, 18.5957, 7.5)).toBeCloseTo(g + 7.5, 6); // flyover deck 7.5 m above the ground
    expect(modelHeight(73.7452, 18.5957, g + 7.5)).toBeCloseTo(7.5, 6); // a pick on the deck stores 7.5, not 567.5
    expect((scenePoint(73.7452, 18.5957, 2) as unknown as { z: number }).z).toBeCloseTo(g + 2, 6);
  });

  it('holds a building flat at the lowest ground under its footprint', async () => {
    const f = new TerrainHeightField();
    await f.addCells(cellsFor([[73.745, 18.595]]), planeSampler, 11);
    setGroundField(f);
    const footprint = [[73.7450, 18.5950], [73.7454, 18.5950], [73.7454, 18.5954], [73.7450, 18.5954]];
    withFlatGround(footprint, () => {
      expect(groundAt(73.7454, 18.5954)).toBeCloseTo(plane(73.7450, 18.5950), 6);
      expect(groundAt(73.7450, 18.5950)).toBeCloseTo(plane(73.7450, 18.5950), 6);
    });
    expect(groundAt(73.7454, 18.5954)).toBeCloseTo(plane(73.7454, 18.5954), 6); // released after
  });

  it('lifts generated meshes by the ground height', async () => {
    const building = {
      id: 'b1', type: 'building', name: 'b1', layerId: 'buildings', scenarioId: 'base', usageType: 'residential', floors: 3, height: 10,
      coordinates: [[73.7450, 18.5950, 0], [73.7452, 18.5950, 0], [73.7452, 18.5952, 0], [73.7450, 18.5952, 0], [73.7450, 18.5950, 0]],
      createdAt: '', updatedAt: '',
    } as unknown as BuildingObject;
    const gen = new ProceduralGeometryGenerator();
    const radius = (m: { positions: ArrayLike<number> }) => Math.hypot(m.positions[0], m.positions[1], m.positions[2]);
    const flat = gen.generateMeshData(building)[0];
    const f = new TerrainHeightField();
    await f.addCells(cellsFor(building.coordinates), planeSampler, 11);
    setGroundField(f);
    const raised = gen.generateMeshData(building)[0];
    expect(radius(raised) - radius(flat)).toBeCloseTo(plane(73.7450, 18.5950), 0);
  });
});

describe('Cesium ion token', () => {
  it('treats empty values and example placeholders as no token', () => {
    for (const t of [undefined, '', '   ', 'YOUR_CESIUM_ION_TOKEN_HERE', '<token>', '"your-token-here"', 'undefined']) expect(normalizeIonToken(t)).toBeNull();
    expect(normalizeIonToken('  abc.def.ghi  ')).toBe('abc.def.ghi');
  });
});

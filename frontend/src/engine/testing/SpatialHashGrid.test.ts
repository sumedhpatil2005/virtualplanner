import { describe, it, expect } from 'vitest';
import { SpatialHashGrid } from '../rendering/spatial/SpatialHashGrid';

describe('SpatialHashGrid Bounds Protection', () => {
  it('handles normal Pune-sized bounds correctly', () => {
    const grid = new SpatialHashGrid(300);
    // Pune study area bounds: ~73.85 to 73.86 lng, 18.52 to 18.53 lat
    const keys = grid.getTileKeysForBounds(73.850, 18.520, 73.860, 18.530);
    expect(keys.length).toBeGreaterThan(0);
    // Should be a small, reasonable number of tiles
    expect(keys.length).toBeLessThan(50);
  });

  it('handles small local viewport safely', () => {
    const grid = new SpatialHashGrid(300);
    const keys = grid.getTileKeysForBounds(73.8567, 18.5204, 73.8568, 18.5205);
    expect(keys.length).toBe(1);
    expect(keys[0]).toContain('tile_');
  });

  it('protects against global/full-globe bounds', () => {
    const grid = new SpatialHashGrid(300);
    const startTime = performance.now();
    // Global bounds: -180 to 180 lng, -85 to 85 lat
    const keys = grid.getTileKeysForBounds(-180, -85, 180, 85);
    const duration = performance.now() - startTime;

    console.log(`[TEST] Global bounds query returned ${keys.length} keys in ${duration.toFixed(2)}ms`);
    // Should complete instantly
    expect(duration).toBeLessThan(50);
    // Maximum grid limit is 20x20 cells (or 21x21 inclusive edge cells)
    expect(keys.length).toBeLessThanOrEqual(21 * 21);
  });

  it('never generates more than configured maximum for extremely large bounds', () => {
    const grid = new SpatialHashGrid(300);
    // Large bounds covering half the continent
    const keys = grid.getTileKeysForBounds(50, 10, 100, 40);
    expect(keys.length).toBeLessThanOrEqual(21 * 21);
  });

  it('handles empty or invalid bounds safely', () => {
    const grid = new SpatialHashGrid(300);
    // Empty bounds or inverted bounds
    const keys = grid.getTileKeysForBounds(0, 0, 0, 0);
    expect(keys.length).toBe(1); // single tile
  });
});

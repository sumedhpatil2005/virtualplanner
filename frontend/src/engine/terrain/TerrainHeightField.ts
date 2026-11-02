/**
 * Ground heights for placing the city model on terrain.
 *
 * Every object's coordinates carry a height *above the ground* (0 for a road
 * at grade, the deck height for a bridge or flyover). Without terrain the
 * ground is the WGS84 ellipsoid (height 0). With terrain on, the ground in
 * west Pune is about 560 m above the ellipsoid, so geometry left at 0 is
 * buried under the terrain surface.
 *
 * The height field samples the terrain once on a regular grid over every
 * 0.01° cell that holds model geometry (sampleTerrainMostDetailed in the
 * engine; any sampler here) and interpolates bilinearly between samples.
 * Scene height = ground(lng, lat) + model height, so bridge and flyover
 * offsets stay relative to the sampled ground beneath them.
 *
 * Missing samples (a tile that failed) take the median of their cell, and a
 * cell with no valid sample at all is not added; a point outside every
 * sampled cell gets the field's overall median, never a guessed slope.
 */

export const CELL_DEG = 0.01;
/** Samples per cell side; 41 gives a 0.00025° (~27 m) spacing. */
export const SAMPLES_PER_SIDE = 41;

export type CellKey = string;
export interface GroundSample { lng: number; lat: number }
/** Returns one height (m above the ellipsoid) per point, or undefined/NaN where unknown. */
export type GroundSampler = (points: readonly GroundSample[]) => Promise<readonly (number | undefined)[]>;

export const cellKeyOf = (lng: number, lat: number): CellKey => `${Math.floor(lng / CELL_DEG)}:${Math.floor(lat / CELL_DEG)}`;

/** Cells holding any of the given points. */
export function cellsFor(points: Iterable<readonly number[]>): Set<CellKey> {
  const out = new Set<CellKey>();
  for (const p of points) if (Number.isFinite(p[0]) && Number.isFinite(p[1])) out.add(cellKeyOf(p[0], p[1]));
  return out;
}

interface Cell { x0: number; y0: number; step: number; n: number; h: Float64Array }

const median = (v: number[]) => { const s = [...v].sort((a, b) => a - b); return s.length ? (s.length % 2 ? s[(s.length - 1) / 2] : (s[s.length / 2 - 1] + s[s.length / 2]) / 2) : NaN; };

export class TerrainHeightField {
  private readonly cells = new Map<CellKey, Cell>();
  private fallback = 0;

  get cellCount() { return this.cells.size; }
  has(key: CellKey) { return this.cells.has(key); }
  keys() { return [...this.cells.keys()]; }

  /** Samples the given cells (skipping ones already held). Returns how many cells were added. */
  async addCells(keys: Iterable<CellKey>, sampler: GroundSampler, n = SAMPLES_PER_SIDE): Promise<number> {
    const todo = [...keys].filter(k => !this.cells.has(k));
    if (!todo.length) return 0;
    const points: GroundSample[] = [];
    const step = CELL_DEG / (n - 1);
    for (const key of todo) {
      const [cx, cy] = key.split(':').map(Number);
      for (let j = 0; j < n; j++) for (let i = 0; i < n; i++) points.push({ lng: cx * CELL_DEG + i * step, lat: cy * CELL_DEG + j * step });
    }
    const heights = await sampler(points);
    if (heights.length !== points.length) throw new Error(`Terrain sampler returned ${heights.length} heights for ${points.length} points`);
    let added = 0;
    todo.forEach((key, c) => {
      const [cx, cy] = key.split(':').map(Number);
      const h = new Float64Array(n * n);
      const valid: number[] = [];
      for (let k = 0; k < n * n; k++) {
        const v = heights[c * n * n + k];
        h[k] = typeof v === 'number' && Number.isFinite(v) ? v : NaN;
        if (!Number.isNaN(h[k])) valid.push(h[k]);
      }
      if (!valid.length) return;
      const m = median(valid);
      for (let k = 0; k < n * n; k++) if (Number.isNaN(h[k])) h[k] = m;
      this.cells.set(key, { x0: cx * CELL_DEG, y0: cy * CELL_DEG, step, n, h });
      added++;
    });
    const all: number[] = [];
    this.cells.forEach(cell => all.push(median(Array.from(cell.h))));
    this.fallback = all.length ? median(all) : 0;
    return added;
  }

  /** Ground height (m above the ellipsoid) at a point, bilinear between samples. */
  heightAt(lng: number, lat: number): number {
    const cell = this.cells.get(cellKeyOf(lng, lat));
    if (!cell) return this.fallback;
    const { x0, y0, step, n, h } = cell;
    const fx = Math.min(n - 1, Math.max(0, (lng - x0) / step)), fy = Math.min(n - 1, Math.max(0, (lat - y0) / step));
    const i = Math.min(n - 2, Math.floor(fx)), j = Math.min(n - 2, Math.floor(fy));
    const tx = fx - i, ty = fy - j;
    const a = h[j * n + i], b = h[j * n + i + 1], c = h[(j + 1) * n + i], d = h[(j + 1) * n + i + 1];
    return a * (1 - tx) * (1 - ty) + b * tx * (1 - ty) + c * (1 - tx) * ty + d * tx * ty;
  }

  /** Lowest ground under a footprint: a building's base sits flat at this height (no floating corner). */
  minHeightUnder(points: readonly (readonly number[])[]): number {
    let m = Infinity;
    for (const p of points) m = Math.min(m, this.heightAt(p[0], p[1]));
    return Number.isFinite(m) ? m : this.fallback;
  }
}

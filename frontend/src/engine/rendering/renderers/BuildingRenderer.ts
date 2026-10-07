import type { MeshData } from '../types';
import { TileBatchRenderer } from './TileBatchRenderer';

const TIERS = ['far', 'medium', 'close'] as const;

/**
 * Buildings. The generator emits three meshes per building — [far footprint,
 * medium extrusion, close detailed extrusion] — and only the tier for the
 * current camera height is built.
 */
export class BuildingRenderer extends TileBatchRenderer {
  protected layerOf(_mesh: MeshData, index: number, meshes: MeshData[]): string | null {
    if (meshes.length < 3) return null;
    return TIERS[index] ?? null;
  }

  protected isLayerVisible(layer: string, height: number): boolean {
    if (layer === 'far') return height >= 2000;
    if (layer === 'medium') return height >= 500 && height < 2000;
    return height < 500;
  }
}

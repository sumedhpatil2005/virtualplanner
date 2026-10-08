import type { MeshData } from '../types';
import { TileBatchRenderer } from './TileBatchRenderer';

/** Ground-level road geometry, batched per tile and material layer. */
export class RoadRenderer extends TileBatchRenderer {
  protected layerOf(mesh: MeshData): string {
    return mesh.layerId || 'asphalt';
  }

  protected isLayerVisible(layer: string, height: number): boolean {
    switch (layer) {
      case 'marking':
        return height < 1200;
      case 'divider':
      case 'sidewalk':
        return height < 1500;
      case 'curb':
        return height < 400;
      default:
        return true; // asphalt, cycleway, verge, parking, drainage
    }
  }

  protected colorLayer(): string {
    return 'asphalt';
  }

  protected onRebuilt(ms: number): void {
    (window as any).last_road_rebuild_time = ms;
  }

  /** Traffic tint for one road. */
  public setRoadColor(roadId: string, colorHex: string): void {
    this.setColor(roadId, colorHex);
  }
}

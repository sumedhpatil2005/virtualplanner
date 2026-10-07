import type { MeshData } from '../types';
import { TileBatchRenderer } from './TileBatchRenderer';

/** Flyovers, metro lines and stations, utilities and junctions. */
export class TransitRenderer extends TileBatchRenderer {
  protected layerOf(mesh: MeshData): string {
    return mesh.layerId || 'transit_deck';
  }

  protected isLayerVisible(layer: string, height: number): boolean {
    switch (layer) {
      case 'transit_rails':
      case 'transit_junction':
      case 'transit_deck_details':
      case 'transit_pillars_details':
        return height < 1500;
      case 'transit_utility':
        return height < 800;
      default:
        return true; // deck, station, pillars and anything else
    }
  }

  protected colorLayer(): string {
    return 'transit_deck';
  }

  protected isAlwaysTranslucent(layer: string): boolean {
    return layer === 'transit_station';
  }

  /** Traffic tint for a flyover deck. */
  public setTransitColor(transitId: string, colorHex: string): void {
    this.setColor(transitId, colorHex);
  }
}

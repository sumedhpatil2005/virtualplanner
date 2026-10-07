export interface Layer {
  id: string;
  name: string;
  category: 'base' | 'infrastructure' | 'utilities' | 'simulations';
  visible: boolean;
  opacity: number;
  /** False for layers where transparency has no meaning or no renderer (the UI hides the slider). */
  supportsOpacity: boolean;
}

/**
 * Maps an object's stored `layerId` to the registry layer that controls it.
 * Older data and importers used a few legacy ids; they all resolve here so a
 * toggle always affects exactly the objects it names.
 */
export function resolveLayerId(rawLayerId: string): string {
  switch (rawLayerId) {
    case 'transit':
      return 'metro';
    case 'electricity_util': // EditingEngine used `${utilityType}_util` with 'electricity'
      return 'electric_util';
    default:
      return rawLayerId;
  }
}

/** Registry layer id for a newly drawn utility of the given type. */
export function utilityLayerId(utilityType: string): string {
  return resolveLayerId(`${utilityType}_util`);
}

export class LayerManager {
  private layers: Map<string, Layer> = new Map();
  private onChangeListeners: ((layers: Layer[]) => void)[] = [];

  constructor() {
    this.initializeDefaultLayers();
  }

  private initializeDefaultLayers() {
    const defaults: Layer[] = [
      { id: 'satellite', name: 'Satellite Imagery', category: 'base', visible: true, opacity: 1.0, supportsOpacity: true },
      // Off by default: city models sit at ellipsoid height, so real terrain (~560 m in Pune) would bury them
      { id: 'terrain', name: 'Terrain Relief', category: 'base', visible: false, opacity: 1.0, supportsOpacity: false },
      { id: 'roads', name: 'Road Network', category: 'infrastructure', visible: true, opacity: 1.0, supportsOpacity: true },
      { id: 'buildings', name: '3D Buildings', category: 'infrastructure', visible: true, opacity: 1.0, supportsOpacity: true },
      { id: 'junctions', name: 'Junctions & Signals', category: 'infrastructure', visible: true, opacity: 1.0, supportsOpacity: true },
      { id: 'metro', name: 'Elevated Metro Network', category: 'infrastructure', visible: true, opacity: 1.0, supportsOpacity: true },
      { id: 'demand_zones', name: 'Zoning Map', category: 'infrastructure', visible: true, opacity: 1.0, supportsOpacity: true },
      { id: 'gateways', name: 'Gateways', category: 'infrastructure', visible: true, opacity: 1.0, supportsOpacity: true },
      { id: 'water_util', name: 'Water Pipe Network', category: 'utilities', visible: false, opacity: 0.8, supportsOpacity: true },
      { id: 'electric_util', name: 'Electric Grid', category: 'utilities', visible: false, opacity: 0.8, supportsOpacity: true },
      { id: 'sewage_util', name: 'Sewage Lines', category: 'utilities', visible: false, opacity: 0.8, supportsOpacity: true },
      { id: 'gas_util', name: 'Gas Mains', category: 'utilities', visible: false, opacity: 0.8, supportsOpacity: true },
      { id: 'fiber_util', name: 'Fiber Network', category: 'utilities', visible: false, opacity: 0.8, supportsOpacity: true },
      { id: 'traffic_network_debug', name: 'Show Traffic Network', category: 'simulations', visible: false, opacity: 1.0, supportsOpacity: false },
    ];

    defaults.forEach(layer => this.layers.set(layer.id, layer));
  }

  public onChange(callback: (layers: Layer[]) => void) {
    this.onChangeListeners.push(callback);
    return () => {
      this.onChangeListeners = this.onChangeListeners.filter(cb => cb !== callback);
    };
  }

  private notify() {
    const list = Array.from(this.layers.values());
    this.onChangeListeners.forEach(cb => cb(list));
  }

  public getAll(): Layer[] {
    return Array.from(this.layers.values());
  }

  public get(id: string): Layer | undefined {
    return this.layers.get(resolveLayerId(id));
  }

  public setVisibility(id: string, visible: boolean) {
    const layer = this.layers.get(id);
    if (layer && layer.visible !== visible) {
      this.layers.set(id, { ...layer, visible });
      this.notify();
    }
  }

  public setOpacity(id: string, opacity: number) {
    const layer = this.layers.get(id);
    if (layer && layer.supportsOpacity) {
      this.layers.set(id, { ...layer, opacity: Math.max(0, Math.min(1, opacity)) });
      this.notify();
    }
  }

  public isVisible(id: string): boolean {
    return this.get(id)?.visible ?? false;
  }

  /** Opacity for a (possibly legacy) layer id; unknown layers are fully opaque. */
  public getOpacity(id: string): number {
    return this.get(id)?.opacity ?? 1;
  }
}

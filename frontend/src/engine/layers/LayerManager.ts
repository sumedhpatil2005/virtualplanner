export interface Layer {
  id: string;
  name: string;
  category: 'base' | 'infrastructure' | 'utilities' | 'simulations';
  visible: boolean;
  opacity: number;
}

export class LayerManager {
  private layers: Map<string, Layer> = new Map();
  private onChangeListeners: ((layers: Layer[]) => void)[] = [];

  constructor() {
    this.initializeDefaultLayers();
  }

  private initializeDefaultLayers() {
    const defaults: Layer[] = [
      { id: 'satellite', name: 'Satellite Imagery', category: 'base', visible: true, opacity: 1.0 },
      { id: 'terrain', name: 'Terrain Layer', category: 'base', visible: true, opacity: 1.0 },
      { id: 'roads', name: 'Road Network', category: 'infrastructure', visible: true, opacity: 1.0 },
      { id: 'buildings', name: '3D Buildings', category: 'infrastructure', visible: true, opacity: 1.0 },
      { id: 'junctions', name: 'Junctions & Signals', category: 'infrastructure', visible: true, opacity: 1.0 },
      { id: 'metro', name: 'Elevated Metro Network', category: 'infrastructure', visible: true, opacity: 1.0 },
      { id: 'demand_zones', name: 'Zoning Map', category: 'infrastructure', visible: true, opacity: 0.6 },
      { id: 'gateways', name: 'Gateways', category: 'infrastructure', visible: true, opacity: 1.0 },
      { id: 'water_util', name: 'Water Pipe Network', category: 'utilities', visible: false, opacity: 0.8 },
      { id: 'electric_util', name: 'Electric Grid', category: 'utilities', visible: false, opacity: 0.8 },
      { id: 'sewage_util', name: 'Sewage Lines', category: 'utilities', visible: false, opacity: 0.8 },
      { id: 'traffic_network_debug', name: 'Show Traffic Network', category: 'simulations', visible: false, opacity: 0.85 },
      { id: 'traffic_sim', name: 'Traffic Congestion Map', category: 'simulations', visible: false, opacity: 0.85 },
      { id: 'flood_sim', name: 'Flood Inundation Map', category: 'simulations', visible: false, opacity: 0.85 },
      { id: 'population_sim', name: 'Population Density Map', category: 'simulations', visible: false, opacity: 0.85 },
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

  public setVisibility(id: string, visible: boolean) {
    const layer = this.layers.get(id);
    if (layer) {
      this.layers.set(id, { ...layer, visible });
      this.notify();
    }
  }

  public setOpacity(id: string, opacity: number) {
    const layer = this.layers.get(id);
    if (layer) {
      this.layers.set(id, { ...layer, opacity: Math.max(0, Math.min(1, opacity)) });
      this.notify();
    }
  }

  public isVisible(id: string): boolean {
    return this.layers.get(id)?.visible ?? false;
  }
}

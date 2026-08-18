import { describe, it, expect, vi, beforeEach } from 'vitest';

// Mock Cesium dependencies
vi.mock('cesium', () => {
  return {
    Viewer: class {
      scene = {
        primitives: {
          add: vi.fn(),
          remove: vi.fn()
        }
      };
      camera = {
        changed: {
          addEventListener: vi.fn()
        },
        positionCartographic: {
          height: 800
        }
      };
    },
    Primitive: class {
      show = true;
      constructor() {}
    },
    GroundPrimitive: class {
      show = true;
      constructor() {}
    },
    Geometry: class {
      constructor(opts: any) {
        Object.assign(this, opts);
      }
    },
    GeometryAttribute: class {
      constructor(opts: any) {
        Object.assign(this, opts);
      }
    },
    GeometryAttributes: class {
      constructor(opts: any) {
        Object.assign(this, opts);
      }
    },
    ComponentDatatype: {
      DOUBLE: 'DOUBLE'
    },
    PrimitiveType: {
      TRIANGLES: 'TRIANGLES'
    },
    BoundingSphere: class {
      constructor(_center: any, _radius: any) {}
    },
    Cartesian3: class {
      constructor(_x: any, _y: any, _z: any) {}
    },
    GeometryInstance: class {
      constructor(opts: any) {
        Object.assign(this, opts);
      }
    },
    ColorGeometryInstanceAttribute: {
      fromColor: () => ({})
    },
    Color: {
      fromCssColorString: () => ({})
    },
    PerInstanceColorAppearance: class {},
    Math: {
      toDegrees: (val: number) => val * (180 / Math.PI)
    }
  };
});

// Import modules to test after mocking
import { RenderManager } from '../rendering/RenderManager';
import { Viewer } from 'cesium';
import type { MetroLineObject, MetroStationObject, CityObject } from '../objects/types';

describe('LOD / RenderManager Regression Test', () => {
  let renderManager: RenderManager;
  let mockViewer: any;

  beforeEach(() => {
    mockViewer = new Viewer('cesiumContainer' as any);
    renderManager = new RenderManager();
    renderManager.initialize(mockViewer);
  });

  it('renders a short metro segment immediately when its first coordinate is in loaded tiles', () => {
    // 1. Setup loaded tiles (e.g. tile containing the visible coordinate)
    // Coords: [73.837, 18.511]
    const tileKey = renderManager.getSpatialGrid().getTileKey(73.837, 18.511);
    (renderManager as any).loadedTiles.add(tileKey);

    const shortMetro: MetroLineObject = {
      id: 'short_metro_line',
      type: 'metro_line',
      name: 'Short Segment',
      layerId: 'metro',
      scenarioId: 'base',
      coordinates: [
        [73.837, 18.511, 12],
        [73.838, 18.512, 12]
      ],
      trackCount: 2,
      trackGauge: 1.435,
      deckWidth: 8,
      elevation: 12,
      pierSpacing: 30,
      createdAt: new Date().toISOString(),
      updatedAt: new Date().toISOString()
    };

    // 2. Register the object
    renderManager.registerObject(shortMetro);

    // 3. Verify it is registered and rendered in the TransitRenderer
    const transitRenderer = renderManager.getTransitRenderer();
    expect((transitRenderer as any).transitToTileMap.has('short_metro_line')).toBe(true);
  });

  it('renders a long metro line immediately when any of its intersected tiles are loaded, even if the first coordinate tile is outside the viewport', () => {
    // Coords start at [73.805, 18.507] (swargate/outside) and cross F1TC tile [73.837, 18.511]
    const outerTileKey = renderManager.getSpatialGrid().getTileKey(73.805, 18.507);
    const visibleTileKey = renderManager.getSpatialGrid().getTileKey(73.837, 18.511);

    // Visible tile is loaded, but outer tile is NOT
    (renderManager as any).loadedTiles.add(visibleTileKey);
    expect((renderManager as any).loadedTiles.has(outerTileKey)).toBe(false);

    const longMetro: MetroLineObject = {
      id: 'long_metro_line',
      type: 'metro_line',
      name: 'Long Line',
      layerId: 'metro',
      scenarioId: 'base',
      coordinates: [
        [73.805, 18.507, 12], // outside
        [73.837, 18.511, 12], // crosses visible tile
        [73.864, 18.530, 12]  // outside
      ],
      trackCount: 2,
      trackGauge: 1.435,
      deckWidth: 8,
      elevation: 12,
      pierSpacing: 30,
      createdAt: new Date().toISOString(),
      updatedAt: new Date().toISOString()
    };

    // Register long metro line
    renderManager.registerObject(longMetro);

    // Under the old first-coordinate check, this would be false because outerTileKey is not loaded.
    // Under the new intersection check, it should be true because visibleTileKey is loaded!
    const transitRenderer = renderManager.getTransitRenderer();
    expect((transitRenderer as any).transitToTileMap.has('long_metro_line')).toBe(true);
  });

  it('aligns a metro station with the nearest metro track segment and generates multi-part meshes', () => {
    const generator = (renderManager as any).generator;

    const track: MetroLineObject = {
      id: 'test_track',
      type: 'metro_line',
      name: 'Test Track',
      layerId: 'metro',
      scenarioId: 'base',
      coordinates: [
        [73.830, 18.511, 12],
        [73.840, 18.511, 12]
      ],
      trackCount: 2,
      trackGauge: 1.435,
      deckWidth: 8,
      elevation: 12,
      pierSpacing: 30,
      createdAt: new Date().toISOString(),
      updatedAt: new Date().toISOString()
    };

    const station: MetroStationObject = {
      id: 'test_station',
      type: 'metro_station',
      name: 'Test Station',
      layerId: 'metro',
      scenarioId: 'base',
      coordinates: [73.835, 18.511, 12],
      stationName: 'Test Station',
      length: 140,
      width: 20,
      height: 8,
      elevation: 12,
      capacity: 25000,
      createdAt: new Date().toISOString(),
      updatedAt: new Date().toISOString()
    };

    const allObjects = new Map<string, CityObject>();
    allObjects.set(track.id, track);
    allObjects.set(station.id, station);

    const meshes = generator.generateMeshData(station, allObjects);
    
    // We expect 4 pillars, 2 beams, 1 concourse deck, 1 platform deck, 2 railings, 5 steel ribs, and 1 canopy = 16 meshes total
    expect(meshes.length).toBe(16);
    
    const layerIds = meshes.map((m: any) => m.layerId);
    expect(layerIds).toContain('transit_pillars');
    expect(layerIds).toContain('transit_deck');
    expect(layerIds).toContain('transit_station');
  });
});

import { Cartesian3 } from 'cesium';
import { renderManagerInstance } from '../rendering/RenderManager';

export function runProgressivePerformanceTest(engine: any) {
  const baseLng = 73.8567;
  const baseLat = 18.5204;

  const generateMockBuildings = (count: number) => {
    const list = [];
    const side = Math.ceil(Math.sqrt(count));
    const step = 0.00045;

    for (let i = 0; i < count; i++) {
      const row = Math.floor(i / side);
      const col = i % side;
      const lng = baseLng + col * step - (side * step) / 2;
      const lat = baseLat + row * step - (side * step) / 2;

      const coords: [number, number, number][] = [
        [lng, lat, 0],
        [lng + 0.00012, lat, 0],
        [lng + 0.00012, lat + 0.00012, 0],
        [lng, lat + 0.00012, 0],
        [lng, lat, 0]
      ];

      list.push({
        id: `test_b_${i}`,
        type: 'building' as const,
        name: `Test Building ${i}`,
        layerId: 'buildings',
        scenarioId: 'base',
        coordinates: coords,
        usageType: 'residential' as const,
        height: 15,
        floors: 5,
        population: 60,
        createdAt: new Date().toISOString(),
        updatedAt: new Date().toISOString()
      });
    }
    return list;
  };

  const executeBatchTest = async (size: number) => {
    console.log(`%c[PerfTest] Starting test for ${size} buildings...`, 'color: #38bdf8; font-weight: bold;');
    engine.objects.clear();
    await new Promise(resolve => setTimeout(resolve, 200));

    const startTime = performance.now();
    const buildings = generateMockBuildings(size);
    buildings.forEach(b => engine.objects.add(b));
    
    await new Promise(resolve => setTimeout(resolve, 300));
    const endTime = performance.now();
    const totalTimeMs = endTime - startTime;

    const fpsStart = performance.now();
    let frames = 0;
    while (performance.now() - fpsStart < 1000) {
      await new Promise(resolve => requestAnimationFrame(resolve));
      frames++;
    }
    const sampledFPS = frames;

    const primitivesCount = engine.getPrimitivesCount();
    const mem = (performance as any).memory;
    const heapMB = mem ? Math.round(mem.usedJSHeapSize / (1024 * 1024)) : 0;

    return {
      size,
      timeMs: Math.round(totalTimeMs),
      primitives: primitivesCount,
      fps: sampledFPS,
      heapMB
    };
  };

  const runAll = async () => {
    console.log('%c==================================================', 'color: #6366f1;');
    console.log('%c         TWINCITY PERFORMANCE BENCHMARK SUITE       ', 'color: #6366f1; font-weight: bold;');
    console.log('%c==================================================', 'color: #6366f1;');
    
    const r1 = await executeBatchTest(1000);
    const r2 = await executeBatchTest(5000);
    const r3 = await executeBatchTest(10000);

    engine.objects.clear();
    engine.loadSampleData();

    console.log('%c================ Benchmark Results ================\n', 'color: #6366f1; font-weight: bold;');
    console.table([r1, r2, r3]);
    console.log('%c==================================================', 'color: #6366f1;');
  };

  runAll();
}

export function runRoadPerformanceTest(engine: any) {
  const baseLng = 73.8567;
  const baseLat = 18.5204;

  const generateMockRoads = (count: number) => {
    const list = [];
    const side = Math.ceil(Math.sqrt(count));
    const step = 0.0005; 

    for (let i = 0; i < count; i++) {
      const row = Math.floor(i / side);
      const col = i % side;
      const lng = baseLng + col * step - (side * step) / 2;
      const lat = baseLat + row * step - (side * step) / 2;

      list.push({
        id: `test_r_${i}`,
        type: 'road' as const,
        name: `Test Road ${i}`,
        layerId: 'roads',
        scenarioId: 'base',
        coordinates: [
          [lng, lat, 0],
          [lng + 0.00025, lat + 0.00025, 0]
        ],
        roadClass: 'local' as const,
        width: 10,
        laneCount: 2,
        laneWidth: 3.5,
        hasDivider: true,
        dividerWidth: 1.0,
        hasFootpath: true,
        footpathWidth: 1.5,
        speedLimit: 50,
        isOneWay: false,
        trafficCapacity: 1200,
        connectedJunctions: [],
        createdAt: new Date().toISOString(),
        updatedAt: new Date().toISOString()
      });
    }
    return list;
  };

  const executeBatchTest = async (size: number) => {
    console.log(`%c[RoadPerfTest] Starting test for ${size} roads...`, 'color: #8b5cf6; font-weight: bold;');
    
    // Clear old
    engine.objects.clear();
    await new Promise(resolve => setTimeout(resolve, 300));

    const startTime = performance.now();
    
    // Insert mock roads
    const roads = generateMockRoads(size);
    roads.forEach(r => engine.objects.add(r));
    
    // Wait for the debounced renderer frame rebuild
    await new Promise(resolve => setTimeout(resolve, 300));

    const endTime = performance.now();
    const totalTimeMs = endTime - startTime;

    // 1. Measure stationary FPS
    const fpsStart = performance.now();
    let stationaryFrames = 0;
    while (performance.now() - fpsStart < 1000) {
      await new Promise(resolve => requestAnimationFrame(resolve));
      stationaryFrames++;
    }

    // 2. Measure panning FPS
    const panStart = performance.now();
    let panFrames = 0;
    let time = 0;
    while (performance.now() - panStart < 1000) {
      time += 0.05;
      if (engine.viewer) {
        engine.viewer.camera.setView({
          destination: Cartesian3.fromDegrees(baseLng + Math.sin(time) * 0.008, baseLat + Math.cos(time) * 0.008, 1200)
        });
      }
      await new Promise(resolve => requestAnimationFrame(resolve));
      panFrames++;
    }

    // Recover camera view
    if (engine.viewer) {
      engine.viewer.camera.setView({
        destination: Cartesian3.fromDegrees(baseLng, baseLat, 1200)
      });
    }

    // 3. Collect spatial primitives and instance counts
    const roadRenderer = renderManagerInstance.getRoadRenderer();
    const activeRoadPrimitives = Array.from((roadRenderer as any).tilePrimitives.values())
      .reduce((sum: number, layerMap: any) => sum + layerMap.size, 0);

    const grid = renderManagerInstance.getSpatialGrid();
    const activeTiles = Array.from((roadRenderer as any).tilePrimitives.keys()) as string[];
    const visibleRoadIds = grid.getObjectsInTiles(activeTiles);
    // Approximate active instances based on generated components
    const activeGeometryInstances = visibleRoadIds.length * 4;

    const mem = (performance as any).memory;
    const heapMB = mem ? Math.round(mem.usedJSHeapSize / (1024 * 1024)) : 0;
    const rebuildTimeMs = (window as any).last_road_rebuild_time || 0.1;

    console.log(
      `%c[RoadPerfTest] Size: ${size} | Active Primitives: ${activeRoadPrimitives} | Instances: ${activeGeometryInstances} | FPS (Stat/Pan): ${stationaryFrames}/${panFrames} | Rebuild Time: ${rebuildTimeMs.toFixed(1)}ms | Heap: ${heapMB}MB`, 
      'color: #10b981; font-weight: bold;'
    );

    return {
      size,
      timeMs: Math.round(totalTimeMs),
      activeRoadPrimitives,
      activeGeometryInstances,
      stationaryFPS: stationaryFrames,
      panningFPS: panFrames,
      rebuildTimeMs: Math.round(rebuildTimeMs),
      heapMB
    };
  };

  const runAll = async () => {
    console.log('%c==================================================', 'color: #8b5cf6;');
    console.log('%c         TWINCITY ROAD PERFORMANCE BENCHMARK       ', 'color: #8b5cf6; font-weight: bold;');
    console.log('%c==================================================', 'color: #8b5cf6;');
    
    const r1 = await executeBatchTest(500);
    const r2 = await executeBatchTest(1500);
    const r3 = await executeBatchTest(3000);

    // Restore defaults
    engine.objects.clear();
    engine.loadSampleData();

    console.log('%c================ Benchmark Results ================\n', 'color: #8b5cf6; font-weight: bold;');
    console.table([r1, r2, r3]);
    console.log('%c==================================================', 'color: #8b5cf6;');
  };

  runAll();
}

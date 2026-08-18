import { describe, it, expect } from 'vitest';
import { ProceduralGeometryGenerator } from '../rendering/geometry/ProceduralGeometryGenerator';
import type { CityObject } from '../objects/types';

describe('Startup Runtime Validation', () => {
  it('loads all database objects and verifies procedural geometry generation', async () => {
    console.log('[TEST] Fetching objects from http://localhost:8000/api/objects...');
    let data: CityObject[] = [];
    try {
      const res = await fetch('http://localhost:8000/api/objects');
      if (res.ok) {
        data = await res.json();
      }
    } catch (err) {
      console.warn('[TEST] Backend offline, skipping database objects test.', err);
      return;
    }

    console.log(`[TEST] Loaded ${data.length} objects from database.`);
    
    // Flat-map properties to match the frontend unpacked format
    const unpackedData = data.map((obj: any) => {
      return {
        id: obj.id,
        type: obj.type as any,
        name: obj.name,
        layerId: obj.layerId,
        scenarioId: obj.scenarioId,
        coordinates: obj.coordinates,
        createdAt: new Date().toISOString(),
        updatedAt: new Date().toISOString(),
        ...obj.properties
      } as any;
    });

    const allObjectsMap = new Map<string, CityObject>(unpackedData.map(o => [o.id, o]));
    const generator = new ProceduralGeometryGenerator();

    let successCount = 0;
    let failCount = 0;
    let emptyMeshCount = 0;
    let nanCount = 0;

    unpackedData.forEach(obj => {
      try {
        const meshes = generator.generateMeshData(obj, allObjectsMap);
        successCount++;
        
        meshes.forEach(mesh => {
          if (!mesh.positions || mesh.positions.length === 0) {
            emptyMeshCount++;
            console.error(`[TEST] EMPTY POSITIONS for object ${obj.id} (type: ${obj.type}), layerId: ${mesh.layerId}`);
          }
          if (!mesh.indices || mesh.indices.length === 0) {
            emptyMeshCount++;
            console.error(`[TEST] EMPTY INDICES for object ${obj.id} (type: ${obj.type}), layerId: ${mesh.layerId}`);
          }
          
          for (let i = 0; i < mesh.positions.length; i++) {
            if (isNaN(mesh.positions[i])) {
              nanCount++;
              console.error(`[TEST] NaN POSITION at index ${i} for object ${obj.id} (type: ${obj.type}), layerId: ${mesh.layerId}`);
              break;
            }
          }
        });
      } catch (err: any) {
        failCount++;
        console.error(`[TEST] CRITICAL GEOMETRY ERROR on object ${obj.id} (type: ${obj.type}):`, err.message, err.stack);
      }
    });

    console.log(`[TEST] Geometry summary: ${successCount} succeeded, ${failCount} failed, ${emptyMeshCount} empty meshes, ${nanCount} NaN coordinates.`);
    expect(failCount).toBe(0);
    expect(emptyMeshCount).toBe(0);
    expect(nanCount).toBe(0);
  }, 20000);
});

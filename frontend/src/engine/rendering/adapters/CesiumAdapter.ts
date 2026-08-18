import { 
  Geometry, 
  GeometryAttribute, 
  ComponentDatatype, 
  PrimitiveType, 
  BoundingSphere, 
  Cartesian3,
  GeometryInstance, 
  ColorGeometryInstanceAttribute, 
  Color, 
  Primitive, 
  GroundPrimitive, 
  PerInstanceColorAppearance 
} from 'cesium';
import type { MeshData } from '../types';

export class CesiumAdapter {
  /**
   * Translates flat positions and indices buffers into a Cesium.Geometry
   */
  public static buildGeometry(mesh: MeshData): Geometry {
    const doublePositions = new Float64Array(mesh.positions);
    const uintIndices = new Uint32Array(mesh.indices);

    const attributes: any = {
      position: new GeometryAttribute({
        componentDatatype: ComponentDatatype.DOUBLE,
        componentsPerAttribute: 3,
        values: doublePositions
      })
    };

    // Calculate bounding sphere manually to bypass typing definition errors
    let minX = Infinity, minY = Infinity, minZ = Infinity;
    let maxX = -Infinity, maxY = -Infinity, maxZ = -Infinity;
    for (let i = 0; i < doublePositions.length; i += 3) {
      const x = doublePositions[i];
      const y = doublePositions[i + 1];
      const z = doublePositions[i + 2];
      if (x < minX) minX = x;
      if (x > maxX) maxX = x;
      if (y < minY) minY = y;
      if (y > maxY) maxY = y;
      if (z < minZ) minZ = z;
      if (z > maxZ) maxZ = z;
    }
    const centerX = (minX + maxX) / 2;
    const centerY = (minY + maxY) / 2;
    const centerZ = (minZ + maxZ) / 2;

    let maxDistSq = 0;
    for (let i = 0; i < doublePositions.length; i += 3) {
      const distSq = (doublePositions[i] - centerX) ** 2 + 
                     (doublePositions[i+1] - centerY) ** 2 + 
                     (doublePositions[i+2] - centerZ) ** 2;
      if (distSq > maxDistSq) maxDistSq = distSq;
    }
    const radius = Math.sqrt(maxDistSq);

    const center = new Cartesian3(centerX, centerY, centerZ);
    const boundingSphere = new BoundingSphere(center, radius);

    return new Geometry({
      attributes,
      indices: uintIndices,
      primitiveType: PrimitiveType.TRIANGLES,
      boundingSphere
    });
  }

  /**
   * Converts MeshData into a low-level, ground-clamped Cesium GroundPrimitive
   */
  public static convertMeshToGroundPrimitive(mesh: MeshData, objectId: string): GroundPrimitive {
    const geometry = this.buildGeometry(mesh);
    const colorAttribute = ColorGeometryInstanceAttribute.fromColor(
      Color.fromCssColorString(mesh.material.color)
    );

    const instance = new GeometryInstance({
      geometry,
      attributes: {
        color: colorAttribute
      },
      id: objectId
    });

    const isTranslucent = mesh.material.color.startsWith('rgba') || mesh.material.color.length > 7;

    return new GroundPrimitive({
      geometryInstances: instance,
      appearance: new PerInstanceColorAppearance({
        flat: true,
        translucent: isTranslucent
      }),
      asynchronous: false
    });
  }

  /**
   * Converts MeshData into a low-level elevated Cesium Primitive
   */
  public static convertMeshToPrimitive(mesh: MeshData, objectId: string): Primitive {
    const geometry = this.buildGeometry(mesh);
    const colorAttribute = ColorGeometryInstanceAttribute.fromColor(
      Color.fromCssColorString(mesh.material.color)
    );

    const instance = new GeometryInstance({
      geometry,
      attributes: {
        color: colorAttribute
      },
      id: objectId
    });

    const isTranslucent = mesh.material.color.startsWith('rgba') || mesh.material.color.length > 7;

    return new Primitive({
      geometryInstances: instance,
      appearance: new PerInstanceColorAppearance({
        flat: true,
        translucent: isTranslucent
      }),
      asynchronous: false
    });
  }
}

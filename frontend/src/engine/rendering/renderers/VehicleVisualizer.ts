import { Viewer, PointPrimitiveCollection, Cartesian3, Color } from 'cesium';

export class VehicleVisualizer {
  private viewer: Viewer;
  private collection: PointPrimitiveCollection | null = null;
  private pointMap = new Map<string, any>(); // vehicleId -> PointPrimitive

  constructor(viewer: Viewer) {
    this.viewer = viewer;
    // Add point primitive collection to Cesium scene
    this.collection = this.viewer.scene.primitives.add(new PointPrimitiveCollection());
  }

  /**
   * Updates or creates a 3D point representing a vehicle.
   */
  public updateVehicle(id: string, coords: [number, number, number]): void {
    if (!this.collection) return;
    
    // Elevate point slightly (e.g., +1.5 meters) so it sits nicely above the road surface
    const position = Cartesian3.fromDegrees(coords[0], coords[1], (coords[2] || 0) + 1.5);

    let point = this.pointMap.get(id);
    if (!point) {
      point = this.collection.add({
        position: position,
        color: Color.fromCssColorString('#f97316'), // Vibrant orange-500
        pixelSize: 8,
        outlineColor: Color.WHITE,
        outlineWidth: 1.5
      });
      this.pointMap.set(id, point);
    } else {
      point.position = position;
    }
  }

  /**
   * Removes a vehicle point primitive from the scene.
   */
  public removeVehicle(id: string): void {
    if (!this.collection) return;
    const point = this.pointMap.get(id);
    if (point) {
      this.collection.remove(point);
      this.pointMap.delete(id);
    }
  }

  /**
   * Cleans up all vehicle visual primitives.
   */
  public clear(): void {
    if (this.collection && !this.viewer.isDestroyed()) {
      try {
        this.viewer.scene.primitives.remove(this.collection);
      } catch (e) {
        // Scene or collection may have already been cleaned up
      }
      this.collection = null;
    }
    this.pointMap.clear();
  }
}

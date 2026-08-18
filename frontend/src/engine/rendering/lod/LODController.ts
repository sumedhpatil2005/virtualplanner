import { Viewer, Math as CesiumMath } from 'cesium';
import { renderManagerInstance } from '../RenderManager';

export class LODController {
  private viewer: Viewer;
  private lastHeight: number = -1;
  private lastEvaluationTime: number = 0;
  private evaluationTimeout: any = null;

  constructor(viewer: Viewer) {
    this.viewer = viewer;
  }

  public initCameraListeners(): void {
    this.viewer.camera.changed.addEventListener(() => {
      this.evaluateLODAndTilesThrottled();
    });
    this.evaluateLODAndTiles();
  }

  private evaluateLODAndTilesThrottled(): void {
    const now = performance.now();
    const delay = 150; // Throttle visibility updates to 150ms

    if (now - this.lastEvaluationTime > delay) {
      if (this.evaluationTimeout) {
        clearTimeout(this.evaluationTimeout);
        this.evaluationTimeout = null;
      }
      this.evaluateLODAndTiles();
      this.lastEvaluationTime = now;
    } else {
      if (this.evaluationTimeout) {
        clearTimeout(this.evaluationTimeout);
      }
      this.evaluationTimeout = setTimeout(() => {
        this.evaluateLODAndTiles();
        this.lastEvaluationTime = performance.now();
        this.evaluationTimeout = null;
      }, delay);
    }
  }

  private evaluateLODAndTiles(): void {
    const camera = this.viewer.camera;
    if (!camera.positionCartographic) return;
    const height = camera.positionCartographic.height;

    // Skip tile visibility updates if camera is zoomed out extremely far (above 50,000m)
    if (height > 50000) {
      renderManagerInstance.updateVisibleTiles([]);
      return;
    }

    // 1. Calculate visible tiles based on viewport bounds
    const rectangle = camera.computeViewRectangle();
    let visibleTileKeys: string[] = [];

    let useFallback = !rectangle;
    if (rectangle) {
      const west = CesiumMath.toDegrees(rectangle.west);
      const east = CesiumMath.toDegrees(rectangle.east);
      const south = CesiumMath.toDegrees(rectangle.south);
      const north = CesiumMath.toDegrees(rectangle.north);

      const width = Math.abs(east - west);
      const heightDeg = Math.abs(north - south);

      // If camera is close to ground (< 5000m) but the view rectangle covers more than 0.2 degrees (~22km),
      // it means the perspective view extends to the horizon. Fall back to focused camera coordinates.
      if (height < 5000 && (width > 0.2 || heightDeg > 0.2)) {
        useFallback = true;
      } else {
        visibleTileKeys = renderManagerInstance.getSpatialGrid().getTileKeysForBounds(
          west, south, east, north
        );
      }
    }

    if (useFallback) {
      const cameraLng = CesiumMath.toDegrees(camera.positionCartographic.longitude);
      const cameraLat = CesiumMath.toDegrees(camera.positionCartographic.latitude);
      visibleTileKeys = renderManagerInstance.getSpatialGrid().getTileKeysForBounds(
        cameraLng - 0.01, cameraLat - 0.01, cameraLng + 0.01, cameraLat + 0.01
      );
    }

    renderManagerInstance.updateVisibleTiles(visibleTileKeys);

    // 2. Perform detail visibility toggling (LOD Tiers)
    if (Math.abs(height - this.lastHeight) > 10) {
      this.lastHeight = height;
      renderManagerInstance.getRoadRenderer().updateLOD(height);
      renderManagerInstance.getBuildingRenderer().updateLOD(height);
      renderManagerInstance.getTransitRenderer().updateLOD(height);
    }
  }
}

import type { RoadObject, FlyoverObject, MetroFlyoverObject } from '../objects/types';
import { ObjectManager } from '../objects/ObjectManager';

export interface SnapResult {
  point: [number, number, number];
  type: 'endpoint' | 'edge' | 'junction' | 'none';
  targetObjId?: string;
  targetType?: string;
  targetName?: string;
  isStart?: boolean;
  isEnd?: boolean;
  segmentIndex?: number;
  elevation?: number;
  description?: string;
}

export class SnapManager {
  private objectManager: ObjectManager;
  // Snap tolerance in degrees (~18m at equator, ~12m at mid-latitudes)
  private readonly vertexSnapRadius = 0.00015;
  // Segment snap tolerance in degrees (~10m)
  private readonly edgeSnapRadius = 0.00010;

  constructor(objectManager: ObjectManager) {
    this.objectManager = objectManager;
  }

  /**
   * Evaluates candidate objects and finds the best magnetic snap point for a given [lng, lat, alt].
   */
  public findSnap(
    rawPoint: [number, number, number],
    excludeObjId?: string
  ): SnapResult {
    const objects = this.objectManager.getAll();
    let bestResult: SnapResult = {
      point: rawPoint,
      type: 'none'
    };
    let minDistance = Infinity;

    // 1. High priority: Check existing Junction nodes
    for (const obj of objects) {
      if (obj.id === excludeObjId) continue;

      if (obj.type === 'junction') {
        const jCoords = obj.coordinates;
        const d = this.distanceDeg(rawPoint, jCoords);
        if (d < this.vertexSnapRadius && d < minDistance) {
          minDistance = d;
          bestResult = {
            point: [jCoords[0], jCoords[1], jCoords[2] || 0],
            type: 'junction',
            targetObjId: obj.id,
            targetType: 'junction',
            targetName: obj.name || 'Junction',
            elevation: jCoords[2] || 0,
            description: `Snap to ${obj.name || 'Junction'}`
          };
        }
      }
    }

    if (bestResult.type === 'junction') {
      return bestResult;
    }

    // 2. High priority: Check Endpoints of Roads, Flyovers, and Metro lines
    for (const obj of objects) {
      if (obj.id === excludeObjId) continue;
      if (obj.type !== 'road' && obj.type !== 'flyover' && obj.type !== 'metro_flyover' && obj.type !== 'metro_line') {
        continue;
      }

      const linearObj = obj as (RoadObject | FlyoverObject | MetroFlyoverObject);
      const coords = linearObj.coordinates;
      if (!coords || coords.length === 0) continue;

      const baseElevation = (linearObj as any).elevation || 0;

      // Check Start Vertex
      const startPt = coords[0];
      const dStart = this.distanceDeg(rawPoint, startPt);
      if (dStart < this.vertexSnapRadius && dStart < minDistance) {
        minDistance = dStart;
        bestResult = {
          point: [startPt[0], startPt[1], startPt[2] || baseElevation],
          type: 'endpoint',
          targetObjId: linearObj.id,
          targetType: linearObj.type,
          targetName: linearObj.name,
          isStart: true,
          isEnd: false,
          elevation: baseElevation,
          description: `Snap to ${linearObj.name || linearObj.type} Start`
        };
      }

      // Check End Vertex
      const endPt = coords[coords.length - 1];
      const dEnd = this.distanceDeg(rawPoint, endPt);
      if (dEnd < this.vertexSnapRadius && dEnd < minDistance) {
        minDistance = dEnd;
        bestResult = {
          point: [endPt[0], endPt[1], endPt[2] || baseElevation],
          type: 'endpoint',
          targetObjId: linearObj.id,
          targetType: linearObj.type,
          targetName: linearObj.name,
          isStart: false,
          isEnd: true,
          elevation: baseElevation,
          description: `Snap to ${linearObj.name || linearObj.type} End`
        };
      }

      // Check Intermediate Vertices
      for (let i = 1; i < coords.length - 1; i++) {
        const midPt = coords[i];
        const dMid = this.distanceDeg(rawPoint, midPt);
        if (dMid < this.vertexSnapRadius && dMid < minDistance) {
          minDistance = dMid;
          bestResult = {
            point: [midPt[0], midPt[1], midPt[2] || baseElevation],
            type: 'endpoint',
            targetObjId: linearObj.id,
            targetType: linearObj.type,
            targetName: linearObj.name,
            segmentIndex: i,
            elevation: baseElevation,
            description: `Snap to ${linearObj.name || linearObj.type} Vertex #${i}`
          };
        }
      }
    }

    if (bestResult.type === 'endpoint') {
      return bestResult;
    }

    // 3. Medium priority: Check Edge / Mid-segment (T-Junction snap)
    for (const obj of objects) {
      if (obj.id === excludeObjId) continue;
      if (obj.type !== 'road' && obj.type !== 'flyover' && obj.type !== 'metro_flyover') {
        continue;
      }

      const linearObj = obj as RoadObject;
      const coords = linearObj.coordinates;
      if (!coords || coords.length < 2) continue;

      const baseElevation = (linearObj as any).elevation || 0;

      for (let s = 0; s < coords.length - 1; s++) {
        const p1 = coords[s];
        const p2 = coords[s + 1];

        const { distance, closestPt, t } = this.pointToSegmentDistance(
          rawPoint[0], rawPoint[1],
          p1[0], p1[1],
          p2[0], p2[1]
        );

        // Ignore if very close to endpoints (already handled above)
        if (t < 0.05 || t > 0.95) continue;

        if (distance < this.edgeSnapRadius && distance < minDistance) {
          minDistance = distance;
          const alt1 = p1[2] || baseElevation;
          const alt2 = p2[2] || baseElevation;
          const interpolatedAlt = alt1 + t * (alt2 - alt1);

          bestResult = {
            point: [closestPt[0], closestPt[1], interpolatedAlt],
            type: 'edge',
            targetObjId: linearObj.id,
            targetType: linearObj.type,
            targetName: linearObj.name,
            segmentIndex: s,
            elevation: interpolatedAlt,
            description: `T-Junction with ${linearObj.name || linearObj.type}`
          };
        }
      }
    }

    return bestResult;
  }

  private distanceDeg(p1: [number, number, number], p2: [number, number, number]): number {
    const dx = p1[0] - p2[0];
    const dy = p1[1] - p2[1];
    return Math.sqrt(dx * dx + dy * dy);
  }

  private pointToSegmentDistance(
    px: number, py: number,
    x1: number, y1: number,
    x2: number, y2: number
  ): { distance: number; closestPt: [number, number]; t: number } {
    const dx = x2 - x1;
    const dy = y2 - y1;
    const len2 = dx * dx + dy * dy;
    if (len2 === 0) {
      const dist = Math.sqrt((px - x1) ** 2 + (py - y1) ** 2);
      return { distance: dist, closestPt: [x1, y1], t: 0 };
    }

    let t = ((px - x1) * dx + (py - y1) * dy) / len2;
    t = Math.max(0, Math.min(1, t));

    const cx = x1 + t * dx;
    const cy = y1 + t * dy;
    const dist = Math.sqrt((px - cx) ** 2 + (py - cy) ** 2);
    return { distance: dist, closestPt: [cx, cy], t };
  }
}

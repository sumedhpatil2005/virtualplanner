import type { RoadObject } from '../objects/types';
import type { TrafficNetwork, TrafficNode, TrafficEdge, TurnMovement, TurnDirection } from '../objects/trafficTypes';
import { SpatialHashGrid } from '../rendering/spatial/SpatialHashGrid';

/**
 * Calculates geodesic distance between two points in meters using the Haversine formula.
 */
function getDistanceMeters(lon1: number, lat1: number, lon2: number, lat2: number): number {
  const R = 6371000;
  const dLat = ((lat2 - lat1) * Math.PI) / 180;
  const dLon = ((lon2 - lon1) * Math.PI) / 180;
  const a =
    Math.sin(dLat / 2) * Math.sin(dLat / 2) +
    Math.cos((lat1 * Math.PI) / 180) *
      Math.cos((lat2 * Math.PI) / 180) *
      Math.sin(dLon / 2) *
      Math.sin(dLon / 2);
  const c = 2 * Math.atan2(Math.sqrt(a), Math.sqrt(1 - a));
  return R * c;
}

/**
 * Calculates segment-to-segment mathematical intersection point in 2D.
 */
function lineIntersection(
  x1: number, y1: number, x2: number, y2: number,
  x3: number, y3: number, x4: number, y4: number
): [number, number] | null {
  const denom = (y4 - y3) * (x2 - x1) - (x4 - x3) * (y2 - y1);
  if (denom === 0) return null; // Parallel

  const ua = ((x4 - x3) * (y1 - y3) - (y4 - y3) * (x1 - x3)) / denom;
  const ub = ((x2 - x1) * (y1 - y3) - (y2 - y1) * (x1 - x3)) / denom;

  if (ua >= 0 && ua <= 1 && ub >= 0 && ub <= 1) {
    const x = x1 + ua * (x2 - x1);
    const y = y1 + ua * (y2 - y1);
    return [x, y];
  }
  return null;
}

/**
 * Computes point-to-segment distance in degrees.
 */
function pointToSegmentDistance(
  px: number, py: number,
  x1: number, y1: number,
  x2: number, y2: number
): { distance: number; closestPt: [number, number] } {
  const dx = x2 - x1;
  const dy = y2 - y1;
  const len2 = dx * dx + dy * dy;
  if (len2 === 0) {
    const dist = Math.sqrt((px - x1) ** 2 + (py - y1) ** 2);
    return { distance: dist, closestPt: [x1, y1] };
  }

  let t = ((px - x1) * dx + (py - y1) * dy) / len2;
  t = Math.max(0, Math.min(1, t));

  const cx = x1 + t * dx;
  const cy = y1 + t * dy;
  const dist = Math.sqrt((px - cx) ** 2 + (py - cy) ** 2);
  return { distance: dist, closestPt: [cx, cy] };
}

/** OSM coordinates carry 7 decimals, so a node shared by two ways has the same key in both. */
const vertexKey = (pt: readonly number[]) => `${pt[0].toFixed(7)},${pt[1].toFixed(7)}`;

function sharedVertices(a: readonly (readonly number[])[], b: readonly (readonly number[])[]): Set<string> {
  const keysA = new Set(a.map(vertexKey));
  const shared = new Set<string>();
  for (const pt of b) {
    const key = vertexKey(pt);
    if (keysA.has(key)) shared.add(key);
  }
  return shared;
}

/** A place where two roads cross at different heights (bridge, flyover, tunnel) and do not connect. */
export interface GradeSeparation {
  coordinates: [number, number]; // [longitude, latitude]
  upperZ: number;
  lowerZ: number;
  roadIds: [string, string];
}

/** Road ends and crossings closer than this (in degrees, ~6 m) join at a junction. */
export const JOIN_TOLERANCE_DEG = 0.00006;
/** Roads further apart vertically than this (m) pass over each other instead of joining. */
export const GRADE_SEPARATION_M = 3.0;

export class TrafficNetworkBuilder {
  private readonly spatialTolerance = JOIN_TOLERANCE_DEG;

  public build(roads: RoadObject[]): { network: TrafficNetwork; diagnostics: string; gradeSeparations: GradeSeparation[] } {
    const startTime = performance.now();
    const roadMap = new Map<string, RoadObject>(roads.map(r => [r.id, r]));

    // 1. Calculate bounding boxes & Populate Spatial Hash Grid
    const roadBboxes = new Map<string, { minX: number; maxX: number; minY: number; maxY: number }>();
    const grid = new SpatialHashGrid(150); // 150m cell size is optimal for intersection snapping

    roads.forEach(r => {
      let minX = Infinity, maxX = -Infinity, minY = Infinity, maxY = -Infinity;
      r.coordinates.forEach(c => {
        if (c[0] < minX) minX = c[0];
        if (c[0] > maxX) maxX = c[0];
        if (c[1] < minY) minY = c[1];
        if (c[1] > maxY) maxY = c[1];
      });
      roadBboxes.set(r.id, { minX, maxX, minY, maxY });
      grid.insertObject(r.id, r.coordinates);
    });

    const splits = new Map<string, Map<number, [number, number, number][]>>();
    const getOrInitRoadSplits = (roadId: string) => {
      let map = splits.get(roadId);
      if (!map) {
        map = new Map<number, [number, number, number][]>();
        splits.set(roadId, map);
      }
      return map;
    };

    const addSplitPt = (roadId: string, sIndex: number, pt: [number, number, number]) => {
      const roadSplits = getOrInitRoadSplits(roadId);
      if (!roadSplits.has(sIndex)) roadSplits.set(sIndex, []);
      const list = roadSplits.get(sIndex)!;
      const exists = list.some(item => Math.abs(item[0] - pt[0]) < 0.000001 && Math.abs(item[1] - pt[1]) < 0.000001);
      if (!exists) list.push(pt);
    };

    let bridgeTunnelCrossingsCount = 0;
    const gradeSeparations: GradeSeparation[] = [];
    // Each pair is checked once: from the road that comes first in the list
    const order = new Map<string, number>(roads.map((r, i) => [r.id, i]));

    // 2. Spatial grid matching (O(N) search)
    for (let i = 0; i < roads.length; i++) {
      const roadA = roads[i];
      const boxA = roadBboxes.get(roadA.id)!;

      // Retrieve candidate roads sharing the same spatial tiles
      const cells = grid.getTileKeysForObject(roadA.id);
      const candidates = grid.getObjectsInTiles(cells);

      for (const candId of candidates) {
        if ((order.get(candId) ?? -1) <= i) continue;

        const roadB = roadMap.get(candId);
        if (!roadB) continue;

        const boxB = roadBboxes.get(roadB.id)!;

        // Bbox check
        const overlap = !(
          boxA.maxX + this.spatialTolerance < boxB.minX - this.spatialTolerance ||
          boxA.minX - this.spatialTolerance > boxB.maxX + this.spatialTolerance ||
          boxA.maxY + this.spatialTolerance < boxB.minY - this.spatialTolerance ||
          boxA.minY - this.spatialTolerance > boxB.maxY + this.spatialTolerance
        );
        if (!overlap) continue;

        // Layer / Bridge / Tunnel check
        const provA = roadA.osmProvenance;
        const provB = roadB.osmProvenance;
        let gradeSeparated = false;

        if (provA && provB && provA.layer !== provB.layer) {
          gradeSeparated = true;
        }
        // OSM ways on different layers still join where they share a node: a
        // bridge (layer 1) meets its approach roads (layer 0) at its end nodes.
        const shared = gradeSeparated ? sharedVertices(roadA.coordinates, roadB.coordinates) : null;
        const layerSeparatedAt = (pt: readonly number[]) => gradeSeparated && !shared!.has(vertexKey(pt));

        // X-crossing check (Segment-Segment intersection)
        for (let sA = 0; sA < roadA.coordinates.length - 1; sA++) {
          const pA1 = roadA.coordinates[sA];
          const pA2 = roadA.coordinates[sA + 1];

          for (let sB = 0; sB < roadB.coordinates.length - 1; sB++) {
            const pB1 = roadB.coordinates[sB];
            const pB2 = roadB.coordinates[sB + 1];

            const crossing = lineIntersection(
              pA1[0], pA1[1], pA2[0], pA2[1],
              pB1[0], pB1[1], pB2[0], pB2[1]
            );

            if (crossing) {
              const dxA = pA2[0] - pA1[0];
              const dyA = pA2[1] - pA1[1];
              const ua = dxA !== 0 ? (crossing[0] - pA1[0]) / dxA : (crossing[1] - pA1[1]) / (dyA || 1);

              const dxB = pB2[0] - pB1[0];
              const dyB = pB2[1] - pB1[1];
              const ub = dxB !== 0 ? (crossing[0] - pB1[0]) / dxB : (crossing[1] - pB1[1]) / (dyB || 1);

              const z_A = pA1[2] + ua * (pA2[2] - pA1[2]);
              const z_B = pB1[2] + ub * (pB2[2] - pB1[2]);

              // A crossing at a shared node is a junction; the vertex checks below join it
              if (gradeSeparated && shared!.has(vertexKey(crossing))) continue;

              if (gradeSeparated || Math.abs(z_A - z_B) > GRADE_SEPARATION_M) {
                bridgeTunnelCrossingsCount++;
                // Same height but different OSM layers: the higher layer is on top
                const aOnTop = z_A !== z_B ? z_A > z_B : (provA?.layer ?? 0) >= (provB?.layer ?? 0);
                gradeSeparations.push({
                  coordinates: crossing,
                  upperZ: Math.max(z_A, z_B),
                  lowerZ: Math.min(z_A, z_B),
                  roadIds: aOnTop ? [roadA.id, roadB.id] : [roadB.id, roadA.id]
                });
                continue;
              }

              const splitPt: [number, number, number] = [crossing[0], crossing[1], (z_A + z_B) / 2];
              addSplitPt(roadA.id, sA, splitPt);
              addSplitPt(roadB.id, sB, splitPt);
            }
          }
        }

        // Near-misses / T-junctions checks
        // Vertices of A to segments of B
        for (const ptA of roadA.coordinates) {
          for (let sB = 0; sB < roadB.coordinates.length - 1; sB++) {
            const pB1 = roadB.coordinates[sB];
            const pB2 = roadB.coordinates[sB + 1];

            const res = pointToSegmentDistance(ptA[0], ptA[1], pB1[0], pB1[1], pB2[0], pB2[1]);
            if (res.distance < this.spatialTolerance) {
              const dxB = pB2[0] - pB1[0];
              const dyB = pB2[1] - pB1[1];
              const ub = dxB !== 0 ? (res.closestPt[0] - pB1[0]) / dxB : (res.closestPt[1] - pB1[1]) / (dyB || 1);
              const z_B = pB1[2] + ub * (pB2[2] - pB1[2]);

              if (layerSeparatedAt(ptA) || Math.abs(ptA[2] - z_B) > GRADE_SEPARATION_M) {
                bridgeTunnelCrossingsCount++;
                continue;
              }

              const splitPt: [number, number, number] = [res.closestPt[0], res.closestPt[1], (ptA[2] + z_B) / 2];

              const distToStart = Math.sqrt((res.closestPt[0] - pB1[0])**2 + (res.closestPt[1] - pB1[1])**2);
              const distToEnd = Math.sqrt((res.closestPt[0] - pB2[0])**2 + (res.closestPt[1] - pB2[1])**2);

              if (distToStart > 0.000001 && distToEnd > 0.000001) {
                addSplitPt(roadB.id, sB, splitPt);
              }

              const sA = roadA.coordinates.indexOf(ptA);
              const targetIdx = sA === roadA.coordinates.length - 1 ? sA - 1 : sA;
              addSplitPt(roadA.id, targetIdx, ptA);
            }
          }
        }

        // Vertices of B to segments of A
        for (const ptB of roadB.coordinates) {
          for (let sA = 0; sA < roadA.coordinates.length - 1; sA++) {
            const pA1 = roadA.coordinates[sA];
            const pA2 = roadA.coordinates[sA + 1];

            const res = pointToSegmentDistance(ptB[0], ptB[1], pA1[0], pA1[1], pA2[0], pA2[1]);
            if (res.distance < this.spatialTolerance) {
              const dxA = pA2[0] - pA1[0];
              const dyA = pA2[1] - pA1[1];
              const ua = dxA !== 0 ? (res.closestPt[0] - pA1[0]) / dxA : (res.closestPt[1] - pA1[1]) / (dyA || 1);
              const z_A = pA1[2] + ua * (pA2[2] - pA1[2]);

              if (layerSeparatedAt(ptB) || Math.abs(ptB[2] - z_A) > GRADE_SEPARATION_M) {
                bridgeTunnelCrossingsCount++;
                continue;
              }

              const splitPt: [number, number, number] = [res.closestPt[0], res.closestPt[1], (ptB[2] + z_A) / 2];

              const distToStart = Math.sqrt((res.closestPt[0] - pA1[0])**2 + (res.closestPt[1] - pA1[1])**2);
              const distToEnd = Math.sqrt((res.closestPt[0] - pA2[0])**2 + (res.closestPt[1] - pA2[1])**2);

              if (distToStart > 0.000001 && distToEnd > 0.000001) {
                addSplitPt(roadA.id, sA, splitPt);
              }

              const sB = roadB.coordinates.indexOf(ptB);
              const targetIdx = sB === roadB.coordinates.length - 1 ? sB - 1 : sB;
              addSplitPt(roadB.id, targetIdx, ptB);
            }
          }
        }
      }
    }

    // 3. Build edges & nodes mapping with spatial node clustering
    const edgesMap = new Map<string, TrafficEdge>();
    const nodeCoordsMap = new Map<string, [number, number, number]>();
    const nodeIncomingMap = new Map<string, string[]>();
    const nodeOutgoingMap = new Map<string, string[]>();

    const activeNodes: { id: string; coords: [number, number, number] }[] = [];
    const nodeCoordsById = new Map<string, [number, number, number]>();
    // Nodes bucketed into tolerance-sized cells, so a match is always in the 3x3 neighbourhood
    const nodeCells = new Map<number, number[]>();
    // Numeric cell keys, unique while |lat / tol| < 2^21 (it is under 1.6 million)
    const cellKeyOf = (cx: number, cy: number) => cx * 4194304 + cy;
    const tol = this.spatialTolerance;

    const getNodeId = (coord: [number, number, number]): string => {
      const cx = Math.floor(coord[0] / tol);
      const cy = Math.floor(coord[1] / tol);
      // Earliest-created matching node wins, as with a linear scan in creation order
      let match = -1;
      for (let dx = -1; dx <= 1; dx++) {
        for (let dy = -1; dy <= 1; dy++) {
          const cell = nodeCells.get(cellKeyOf(cx + dx, cy + dy));
          if (!cell) continue;
          for (const idx of cell) {
            if (match !== -1 && idx >= match) continue;
            const n = activeNodes[idx];
            const dist = Math.sqrt((n.coords[0] - coord[0])**2 + (n.coords[1] - coord[1])**2);
            const zDist = Math.abs((n.coords[2] || 0) - (coord[2] || 0));
            if (dist < tol && zDist < GRADE_SEPARATION_M) match = idx;
          }
        }
      }
      if (match !== -1) {
        return activeNodes[match].id;
      }
      const zVal = coord[2] || 0;
      const id = `node_${coord[0].toFixed(5)}_${coord[1].toFixed(5)}_${zVal.toFixed(1)}`;
      const cellKey = cellKeyOf(cx, cy);
      const cell = nodeCells.get(cellKey);
      if (cell) cell.push(activeNodes.length);
      else nodeCells.set(cellKey, [activeNodes.length]);
      activeNodes.push({ id, coords: coord });
      if (!nodeCoordsById.has(id)) nodeCoordsById.set(id, coord);
      return id;
    };

    const registerNodeEdge = (nodeId: string, edgeId: string, incoming: boolean) => {
      if (incoming) {
        let list = nodeIncomingMap.get(nodeId);
        if (!list) {
          list = [];
          nodeIncomingMap.set(nodeId, list);
        }
        if (!list.includes(edgeId)) list.push(edgeId);
      } else {
        let list = nodeOutgoingMap.get(nodeId);
        if (!list) {
          list = [];
          nodeOutgoingMap.set(nodeId, list);
        }
        if (!list.includes(edgeId)) list.push(edgeId);
      }
    };

    roads.forEach(road => {
      const roadSplits = splits.get(road.id);
      const coordSegments: [number, number, number][][] = [];
      let currentSegment: [number, number, number][] = [road.coordinates[0]];

      for (let s = 0; s < road.coordinates.length - 1; s++) {
        const p1 = road.coordinates[s];
        const p2 = road.coordinates[s + 1];
        const segSplits = roadSplits?.get(s);

        if (segSplits && segSplits.length > 0) {
          segSplits.sort((a, b) => {
            const distA = (a[0] - p1[0]) ** 2 + (a[1] - p1[1]) ** 2;
            const distB = (b[0] - p1[0]) ** 2 + (b[1] - p1[1]) ** 2;
            return distA - distB;
          });

          segSplits.forEach(pt => {
            currentSegment.push(pt);
            coordSegments.push(currentSegment);
            currentSegment = [pt];
          });
        }
        currentSegment.push(p2);
      }
      coordSegments.push(currentSegment);

      coordSegments.forEach((coords, idx) => {
        if (coords.length < 2) return;

        const startPt = coords[0];
        const endPt = coords[coords.length - 1];

        const startNodeId = getNodeId(startPt);
        const endNodeId = getNodeId(endPt);

        const startClusterCoords = nodeCoordsById.get(startNodeId)!;
        const endClusterCoords = nodeCoordsById.get(endNodeId)!;

        nodeCoordsMap.set(startNodeId, startClusterCoords);
        nodeCoordsMap.set(endNodeId, endClusterCoords);

        let length = 0;
        for (let i = 0; i < coords.length - 1; i++) {
          length += getDistanceMeters(coords[i][0], coords[i][1], coords[i+1][0], coords[i+1][1]);
        }

        if (length < 0.1) return;

        const firstSection = road.sections && road.sections[0];
        const carriagewayA = firstSection?.carriagewayA;
        const carriagewayB = firstSection?.carriagewayB;

        const isOneWay = road.isOneWay;
        const totalLanes = road.laneCount || 2;
        const totalCapacity = road.trafficCapacity || (totalLanes * 1000);

        const lanesFwd = carriagewayA ? carriagewayA.lanes : Math.max(1, Math.ceil(totalLanes / (isOneWay ? 1 : 2)));
        const lanesBwd = (carriagewayB && carriagewayB.lanes > 0) ? carriagewayB.lanes : (isOneWay ? 0 : Math.max(1, Math.floor(totalLanes / 2)));

        const capacityFwd = (carriagewayA && totalLanes > 0) 
          ? Math.round(totalCapacity * (lanesFwd / totalLanes)) 
          : Math.round(totalCapacity / (isOneWay ? 1 : 2));
        
        const capacityBwd = (carriagewayB && lanesBwd > 0 && totalLanes > 0) 
          ? Math.round(totalCapacity * (lanesBwd / totalLanes)) 
          : Math.round(totalCapacity / 2);

        const edgeId = `${road.id}_seg_${idx}_fwd`;
        const edge: TrafficEdge = {
          id: edgeId,
          roadId: road.id,
          fromNodeId: startNodeId,
          toNodeId: endNodeId,
          coordinates: coords,
          length,
          lanes: lanesFwd,
          direction: isOneWay ? 'forward' : 'both',
          speedLimit: road.speedLimit,
          capacity: capacityFwd
        };
        edgesMap.set(edgeId, edge);
        registerNodeEdge(startNodeId, edgeId, false);
        registerNodeEdge(endNodeId, edgeId, true);

        if (!isOneWay && lanesBwd > 0) {
          const edgeId = `${road.id}_seg_${idx}_bwd`;
          const edge: TrafficEdge = {
            id: edgeId,
            roadId: road.id,
            fromNodeId: endNodeId,
            toNodeId: startNodeId,
            coordinates: [...coords].reverse(),
            length,
            lanes: lanesBwd,
            direction: 'backward',
            speedLimit: road.speedLimit,
            capacity: capacityBwd
          };
          edgesMap.set(edgeId, edge);
          registerNodeEdge(endNodeId, edgeId, false);
          registerNodeEdge(startNodeId, edgeId, true);
        }
      });
    });

    // 4. Node building and turn movements analysis
    const nodesMap = new Map<string, TrafficNode>();
    let roundaboutsCount = 0;
    let suspiciousJunctionsCount = 0;

    nodeCoordsMap.forEach((coords, nodeId) => {
      const incoming = nodeIncomingMap.get(nodeId) || [];
      const outgoing = nodeOutgoingMap.get(nodeId) || [];

      let isRoundaboutNode = false;
      const associatedRoadIds = new Set<string>();

      incoming.forEach(eId => {
        const edge = edgesMap.get(eId);
        if (edge) {
          associatedRoadIds.add(edge.roadId);
          const road = roadMap.get(edge.roadId);
          if (road?.osmProvenance?.roundabout) isRoundaboutNode = true;
        }
      });
      outgoing.forEach(eId => {
        const edge = edgesMap.get(eId);
        if (edge) {
          associatedRoadIds.add(edge.roadId);
          const road = roadMap.get(edge.roadId);
          if (road?.osmProvenance?.roundabout) isRoundaboutNode = true;
        }
      });

      if (isRoundaboutNode) roundaboutsCount++;
      if (associatedRoadIds.size > 4) suspiciousJunctionsCount++;

      const allowedMovements: TurnMovement[] = [];

      incoming.forEach(incId => {
        const incEdge = edgesMap.get(incId);
        if (!incEdge || incEdge.coordinates.length < 2) return;

        const p1 = incEdge.coordinates[incEdge.coordinates.length - 2];
        const p2 = incEdge.coordinates[incEdge.coordinates.length - 1];
        const angleInc = Math.atan2(p2[1] - p1[1], p2[0] - p1[0]);

        outgoing.forEach(outId => {
          const outEdge = edgesMap.get(outId);
          if (!outEdge || outEdge.coordinates.length < 2) return;

          const isDeadEnd = outgoing.length === 1 && incoming.length === 1;
          if (incEdge.roadId === outEdge.roadId && incEdge.direction !== outEdge.direction && !isDeadEnd) {
            return;
          }

          const op1 = outEdge.coordinates[0];
          const op2 = outEdge.coordinates[1];
          const angleOut = Math.atan2(op2[1] - op1[1], op2[0] - op1[0]);

          let angleDiff = angleOut - angleInc;
          while (angleDiff > Math.PI) angleDiff -= Math.PI * 2;
          while (angleDiff < -Math.PI) angleDiff += Math.PI * 2;
          const diffDegrees = (angleDiff * 180) / Math.PI;

          let direction: TurnDirection = 'straight';
          if (Math.abs(diffDegrees) <= 35) {
            direction = 'straight';
          } else if (diffDegrees > 35 && diffDegrees < 145) {
            direction = 'right';
          } else if (diffDegrees < -35 && diffDegrees > -145) {
            direction = 'left';
          } else {
            direction = 'u_turn';
          }

          allowedMovements.push({
            fromSegmentId: incId,
            toSegmentId: outId,
            allowed: true,
            direction
          });
        });
      });

      nodesMap.set(nodeId, {
        id: nodeId,
        coordinates: coords,
        incomingSegments: incoming,
        outgoingSegments: outgoing,
        hasSignals: false,
        allowedMovements
      });
    });

    // Every edge is attached to two nodes, so a road has a node exactly when it has an edge
    const roadsWithEdges = new Set<string>();
    edgesMap.forEach(e => roadsWithEdges.add(e.roadId));
    const disconnectedRoadsCount = roads.filter(r => !roadsWithEdges.has(r.id)).length;

    const endTime = performance.now();
    const processTime = (endTime - startTime).toFixed(1);

    const diagnostics = `--- Traffic Network Compilation Diagnostics ---
Processing Time: ${processTime}ms
Total Input Roads: ${roads.length}
Total Detected Junctions (Nodes): ${nodesMap.size}
Total Traffic Edges Generated: ${edgesMap.size}
Roads with no connections: ${disconnectedRoadsCount}
Detected Bridge/Tunnel Crossings: ${bridgeTunnelCrossingsCount}
Detected Roundabout Nodes: ${roundaboutsCount}
Suspicious Intersections (>4 connections): ${suspiciousJunctionsCount}
-----------------------------------------------`;

    return {
      network: {
        nodes: nodesMap,
        edges: edgesMap
      },
      diagnostics,
      gradeSeparations
    };
  }
}

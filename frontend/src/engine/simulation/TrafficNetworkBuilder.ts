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

export class TrafficNetworkBuilder {
  private readonly spatialTolerance = 0.00006; // ~6 meters in degrees

  public build(roads: RoadObject[]): { network: TrafficNetwork; diagnostics: string } {
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
    const checkedPairs = new Set<string>();

    // 2. Spatial grid matching (O(N) search)
    for (let i = 0; i < roads.length; i++) {
      const roadA = roads[i];
      const boxA = roadBboxes.get(roadA.id)!;

      // Retrieve candidate roads sharing the same spatial tiles
      const cells = grid.getTileKeysForObject(roadA.id);
      const candidates = grid.getObjectsInTiles(cells);

      for (const candId of candidates) {
        if (candId === roadA.id) continue;

        // Ensure unique pairs are checked only once
        const pairKey = roadA.id < candId ? `${roadA.id}_vs_${candId}` : `${candId}_vs_${roadA.id}`;
        if (checkedPairs.has(pairKey)) continue;
        checkedPairs.add(pairKey);

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

              if (gradeSeparated || Math.abs(z_A - z_B) > 3.0) {
                bridgeTunnelCrossingsCount++;
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

              if (gradeSeparated || Math.abs(ptA[2] - z_B) > 3.0) {
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

              if (gradeSeparated || Math.abs(ptB[2] - z_A) > 3.0) {
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

    const getNodeId = (coord: [number, number, number]): string => {
      const existing = activeNodes.find(n => {
        const dist = Math.sqrt((n.coords[0] - coord[0])**2 + (n.coords[1] - coord[1])**2);
        const zDist = Math.abs((n.coords[2] || 0) - (coord[2] || 0));
        return dist < this.spatialTolerance && zDist < 3.0;
      });
      if (existing) {
        return existing.id;
      }
      const zVal = coord[2] || 0;
      const id = `node_${coord[0].toFixed(5)}_${coord[1].toFixed(5)}_${zVal.toFixed(1)}`;
      activeNodes.push({ id, coords: coord });
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

        const startClusterCoords = activeNodes.find(n => n.id === startNodeId)!.coords;
        const endClusterCoords = activeNodes.find(n => n.id === endNodeId)!.coords;

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

          if (incEdge.roadId === outEdge.roadId && incEdge.direction !== outEdge.direction) {
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

    let disconnectedRoadsCount = 0;
    roads.forEach(r => {
      const hasNode = Array.from(nodesMap.values()).some(n => {
        return n.incomingSegments.some(e => e.startsWith(r.id)) ||
               n.outgoingSegments.some(e => e.startsWith(r.id));
      });
      if (!hasNode) disconnectedRoadsCount++;
    });

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
      diagnostics
    };
  }
}

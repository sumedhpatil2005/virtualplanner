import type { FlyoverObject, MetroFlyoverObject } from './types';
import type { TrafficNetwork } from './trafficTypes';

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

function resampleCoordinates(coords: number[][], interval: number): number[][] {
  if (coords.length < 2) return coords;
  const newCoords: number[][] = [];
  
  for (let i = 0; i < coords.length - 1; i++) {
    const p1 = coords[i];
    const p2 = coords[i + 1];
    newCoords.push(p1);
    
    const dist = getDistanceMeters(p1[0], p1[1], p2[0], p2[1]);
    const numSegments = Math.floor(dist / interval);
    
    if (numSegments > 1) {
      for (let j = 1; j < numSegments; j++) {
        const t = j / numSegments;
        newCoords.push([
          p1[0] + (p2[0] - p1[0]) * t,
          p1[1] + (p2[1] - p1[1]) * t,
          (p1[2] || 0) + ((p2[2] || 0) - (p1[2] || 0)) * t
        ]);
      }
    }
  }
  newCoords.push(coords[coords.length - 1]);
  return newCoords;
}

export function applyFlyoverElevationProfile(flyover: any) {
  if (!flyover.coordinates || flyover.coordinates.length < 2) return;

  const elevation = flyover.elevation || 6.0;

  // Resample coordinates to have at most 10m spacing
  flyover.coordinates = resampleCoordinates(flyover.coordinates, 10.0);

  // Calculate cumulative distance along path
  const distanceList: number[] = [0];
  let totalDist = 0;
  for (let i = 1; i < flyover.coordinates.length; i++) {
    const dist = getDistanceMeters(
      flyover.coordinates[i - 1][0],
      flyover.coordinates[i - 1][1],
      flyover.coordinates[i][0],
      flyover.coordinates[i][1]
    );
    totalDist += dist;
    distanceList.push(totalDist);
  }

  const rampLength = 40.0; // 40 meters default ramp length
  const actualRampLength = Math.min(rampLength, totalDist / 2);

  // Preserve/Reconstruct ground coordinates to avoid double-elevation accumulation
  if (!flyover.groundCoordinates || flyover.groundCoordinates.length !== flyover.coordinates.length) {
    const averageElev = flyover.coordinates.reduce((sum: number, c: any) => sum + (c[2] || 0), 0) / flyover.coordinates.length;
    if (averageElev > 1.0) {
      flyover.groundCoordinates = flyover.coordinates.map((c: any, i: number) => {
        const d = distanceList[i];
        let offset = 0;
        if (d < actualRampLength) {
          offset = (d / actualRampLength) * elevation;
        } else if (d > totalDist - actualRampLength) {
          const remaining = totalDist - d;
          offset = (remaining / actualRampLength) * elevation;
        } else {
          offset = elevation;
        }
        return [c[0], c[1], Math.max(0, c[2] - offset)];
      });
    } else {
      flyover.groundCoordinates = flyover.coordinates.map((c: any) => [c[0], c[1], c[2] || 0]);
    }
  }

  const baseCoords = flyover.groundCoordinates;

  // Apply profile to coordinates.
  // RAMP_FOOT_CLEARANCE: The ramp starts 0.25m above ground so the base road
  // surface is always visible beneath the ramp ends (prevents z-fighting with surface road).
  const RAMP_FOOT_CLEARANCE = 0.25;

  flyover.coordinates = baseCoords.map((c: any, i: number) => {
    const d = distanceList[i];
    let offset = 0;
    if (d < actualRampLength) {
      const t = d / actualRampLength;
      // Smooth cubic ease-in for ramp rise: t³ ensures a gradual start
      const easedT = t * t * (3 - 2 * t); // smoothstep
      offset = RAMP_FOOT_CLEARANCE + easedT * (elevation - RAMP_FOOT_CLEARANCE);
    } else if (d > totalDist - actualRampLength) {
      const remaining = totalDist - d;
      const t = remaining / actualRampLength;
      const easedT = t * t * (3 - 2 * t);
      offset = RAMP_FOOT_CLEARANCE + easedT * (elevation - RAMP_FOOT_CLEARANCE);
    } else {
      offset = elevation;
    }
    return [c[0], c[1], c[2] + offset];
  });
}

export function getFlyoverConnectionStatus(
  flyover: FlyoverObject | MetroFlyoverObject | any,
  network: TrafficNetwork | null
): {
  connected: boolean;
  startConnected: boolean;
  endConnected: boolean;
  startNodeId?: string;
  endNodeId?: string;
} {
  if (!network || !network.nodes || !network.edges || !flyover.coordinates || flyover.coordinates.length < 2) {
    return { connected: false, startConnected: false, endConnected: false };
  }

  const flyoverId = flyover.id;
  const startCoord = flyover.coordinates[0];
  const endCoord = flyover.coordinates[flyover.coordinates.length - 1];

  let startNodeId: string | undefined;
  let endNodeId: string | undefined;

  // Spatial tolerance used in builder is 0.00006 degrees (~6 meters)
  const tol = 0.00006;

  network.nodes.forEach(node => {
    const startDist = Math.sqrt((node.coordinates[0] - startCoord[0]) ** 2 + (node.coordinates[1] - startCoord[1]) ** 2);
    if (startDist < tol && Math.abs((node.coordinates[2] || 0) - (startCoord[2] || 0)) < 3.0) {
      startNodeId = node.id;
    }

    const endDist = Math.sqrt((node.coordinates[0] - endCoord[0]) ** 2 + (node.coordinates[1] - endCoord[1]) ** 2);
    if (endDist < tol && Math.abs((node.coordinates[2] || 0) - (endCoord[2] || 0)) < 3.0) {
      endNodeId = node.id;
    }
  });

  if (!startNodeId || !endNodeId) {
    return { connected: false, startConnected: !!startNodeId, endConnected: !!endNodeId };
  }

  let startConnected = false;
  let endConnected = false;

  const startNode = network.nodes.get(startNodeId);
  if (startNode) {
    const allEdges = [...startNode.incomingSegments, ...startNode.outgoingSegments];
    startConnected = allEdges.some(edgeId => {
      const edge = network.edges.get(edgeId);
      return edge && edge.roadId !== flyoverId;
    });
  }

  const endNode = network.nodes.get(endNodeId);
  if (endNode) {
    const allEdges = [...endNode.incomingSegments, ...endNode.outgoingSegments];
    endConnected = allEdges.some(edgeId => {
      const edge = network.edges.get(edgeId);
      return edge && edge.roadId !== flyoverId;
    });
  }

  return {
    connected: startConnected && endConnected,
    startConnected,
    endConnected,
    startNodeId,
    endNodeId
  };
}

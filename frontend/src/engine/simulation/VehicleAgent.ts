export interface VehicleAgent {
  id: string;
  route: string[]; // TrafficEdge IDs
  currentEdgeIndex: number;
  distanceOnEdge: number; // meters from start of current edge
  coordinates: [number, number, number]; // [lon, lat, alt]
  speed: number; // m/s
  isFinished: boolean;
}

/**
 * Interpolates WGS84 coordinates along a 3D polyline path at a specific distance (meters) from the start.
 */
export function interpolateCoordsAlongPolyline(
  coords: [number, number, number][],
  distance: number
): [number, number, number] {
  if (coords.length === 0) return [0, 0, 0];
  if (coords.length === 1 || distance <= 0) return coords[0];

  let accumulated = 0;
  for (let i = 0; i < coords.length - 1; i++) {
    const p1 = coords[i];
    const p2 = coords[i + 1];

    // Compute segment length in meters using standard planar approximation
    const lonMetersPerDegree = 111000 * Math.cos((p1[1] * Math.PI) / 180);
    const latMetersPerDegree = 111000;
    
    const dx = (p2[0] - p1[0]) * lonMetersPerDegree;
    const dy = (p2[1] - p1[1]) * latMetersPerDegree;
    const dz = (p2[2] || 0) - (p1[2] || 0);
    
    const segLen = Math.sqrt(dx * dx + dy * dy + dz * dz);

    if (accumulated + segLen >= distance) {
      const t = (distance - accumulated) / (segLen || 1);
      return [
        p1[0] + t * (p2[0] - p1[0]),
        p1[1] + t * (p2[1] - p1[1]),
        (p1[2] || 0) + t * ((p2[2] || 0) - (p1[2] || 0))
      ];
    }
    accumulated += segLen;
  }

  return coords[coords.length - 1]; // Return final point if distance overrun
}

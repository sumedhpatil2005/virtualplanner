const EARTH_RADIUS_M = 6_371_000;

/** Great-circle distance in metres between two [lon, lat] points. */
export function haversineMeters(a: readonly number[], b: readonly number[]): number {
  const toRad = (d: number) => (d * Math.PI) / 180;
  const dLat = toRad(b[1] - a[1]);
  const dLon = toRad(b[0] - a[0]);
  const h = Math.sin(dLat / 2) ** 2 + Math.cos(toRad(a[1])) * Math.cos(toRad(b[1])) * Math.sin(dLon / 2) ** 2;
  return 2 * EARTH_RADIUS_M * Math.atan2(Math.sqrt(h), Math.sqrt(1 - h));
}

/** Length in metres of a [lon, lat, …] polyline. */
export function polylineLengthMeters(coords: readonly (readonly number[])[]): number {
  let total = 0;
  for (let i = 1; i < coords.length; i++) total += haversineMeters(coords[i - 1], coords[i]);
  return total;
}

/** Area in km² of the lon/lat bounding box around all points (0 if fewer than 2 distinct points). */
export function boundingBoxAreaKm2(points: readonly (readonly number[])[]): number {
  if (points.length === 0) return 0;
  let minLon = Infinity, maxLon = -Infinity, minLat = Infinity, maxLat = -Infinity;
  for (const p of points) {
    minLon = Math.min(minLon, p[0]); maxLon = Math.max(maxLon, p[0]);
    minLat = Math.min(minLat, p[1]); maxLat = Math.max(maxLat, p[1]);
  }
  const width = haversineMeters([minLon, minLat], [maxLon, minLat]);
  const height = haversineMeters([minLon, minLat], [minLon, maxLat]);
  return (width * height) / 1_000_000;
}

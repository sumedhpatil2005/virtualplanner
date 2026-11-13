/** Polyline length in metres (haversine on lng/lat pairs); null for fewer than two points. */
export function lengthM(coords: readonly (readonly number[])[]): number | null {
  if (!coords || coords.length < 2) return null;
  const R = 6371008.8, rad = Math.PI / 180;
  let d = 0;
  for (let i = 1; i < coords.length; i++) {
    const [lo1, la1] = coords[i - 1], [lo2, la2] = coords[i];
    const a = Math.sin(((la2 - la1) * rad) / 2) ** 2 + Math.cos(la1 * rad) * Math.cos(la2 * rad) * Math.sin(((lo2 - lo1) * rad) / 2) ** 2;
    d += 2 * R * Math.asin(Math.sqrt(a));
  }
  return d;
}

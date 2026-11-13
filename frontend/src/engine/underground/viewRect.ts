import type { UndergroundAlignmentObject } from '../objects/types';

/** Lon/lat box around the alignments with a margin (m), for limiting ground translucency. */
export function alignmentsRect(as: UndergroundAlignmentObject[], marginM = 300): [number, number, number, number] | null {
  const pts = as.flatMap(a => a.coordinates);
  if (pts.length === 0) return null;
  const lat = pts.reduce((s, p) => s + p[1], 0) / pts.length;
  const dLat = marginM / 110574, dLon = marginM / (111320 * Math.cos((lat * Math.PI) / 180));
  return [Math.min(...pts.map(p => p[0])) - dLon, Math.min(...pts.map(p => p[1])) - dLat, Math.max(...pts.map(p => p[0])) + dLon, Math.max(...pts.map(p => p[1])) + dLat];
}


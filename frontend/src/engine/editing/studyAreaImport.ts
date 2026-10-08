import type { Area } from '../objects/types';

export type InfrastructureCategory = 'roads' | 'buildings' | 'metro' | 'signals';
export const INFRASTRUCTURE_CATEGORIES: InfrastructureCategory[] = ['roads', 'buildings', 'metro', 'signals'];
export interface ImportCategoryReport { category: InfrastructureCategory; added: number; preserved: number; skipped: number; source?: 'local' | 'Overpass' | 'cache'; error?: string; }
export interface StudyAreaImportReport { areaId: string; areaName: string; categories: ImportCategoryReport[]; cancelled: boolean; completed: boolean; }
export interface StudyAreaImportProgress { category: InfrastructureCategory; phase: 'fetching' | 'saving'; completed: number; total: number; }
export type Point = [number, number, number];

export function areaFromBoundary(id: string, name: string, coordinates: Point[]): Area {
  const ring = coordinates.map(p => [...p] as Point);
  if (ring.length < 3 || ring.some(p => !Number.isFinite(p[0]) || !Number.isFinite(p[1]))) throw new Error('A study area needs a valid polygon boundary.');
  if (!same(ring[0], ring[ring.length - 1])) ring.push([...ring[0]]);
  return { id, name, polygonCoordinates: ring, minLon: Math.min(...ring.map(p => p[0])), maxLon: Math.max(...ring.map(p => p[0])), minLat: Math.min(...ring.map(p => p[1])), maxLat: Math.max(...ring.map(p => p[1])), createdAt: new Date().toISOString() };
}
const same = (a: readonly number[], b: readonly number[]) => a[0] === b[0] && a[1] === b[1];
const geometry = (g: any[]): Point[] | null => g?.length >= 2 && g.every(p => Number.isFinite(p.lon) && Number.isFinite(p.lat)) ? g.map(p => [p.lon, p.lat, 0]) : null;

/** Assemble complete endpoint-connected outer ways. Never close missing fragments or fill courtyards. */
export function buildingRing(el: any): Point[] | null {
  if (el.type === 'way') {
    const ring = geometry(el.geometry);
    return ring && ring.length >= 4 && same(ring[0], ring[ring.length - 1]) ? ring : null;
  }
  if (el.type !== 'relation' || !Array.isArray(el.members) || el.members.some((m: any) => m.role === 'inner')) return null;
  const outer = el.members.filter((m: any) => m.type === 'way' && (m.role === 'outer' || m.role === ''));
  if (!outer.length) return null;
  const pieces = outer.map((m: any) => geometry(m.geometry));
  if (pieces.some((p: Point[] | null) => !p)) return null;
  const ring = [...pieces.shift()!] as Point[];
  while (pieces.length && !same(ring[0], ring[ring.length - 1])) {
    const matches = pieces.map((p: Point[] | null, i: number) => ({ p: p!, i })).filter(({ p }: { p: Point[] }) => same(ring[ring.length - 1], p[0]) || same(ring[ring.length - 1], p[p.length - 1]));
    if (matches.length !== 1) return null;
    const { p, i } = matches[0];
    if (!same(ring[ring.length - 1], p[0])) p.reverse();
    ring.push(...p.slice(1)); pieces.splice(i, 1);
  }
  return !pieces.length && ring.length >= 4 && same(ring[0], ring[ring.length - 1]) ? ring : null;
}

export function pointInArea(point: readonly number[], area: Area): boolean {
  const ring = area.polygonCoordinates; let inside = false;
  for (let i = 0, j = ring.length - 1; i < ring.length; j = i++) {
    const a = ring[j], b = ring[i];
    const cross = (point[0] - a[0]) * (b[1] - a[1]) - (point[1] - a[1]) * (b[0] - a[0]);
    if (Math.abs(cross) < 1e-12 && point[0] >= Math.min(a[0], b[0]) && point[0] <= Math.max(a[0], b[0]) && point[1] >= Math.min(a[1], b[1]) && point[1] <= Math.max(a[1], b[1])) return true;
    if ((a[1] > point[1]) !== (b[1] > point[1]) && point[0] < (b[0] - a[0]) * (point[1] - a[1]) / (b[1] - a[1]) + a[0]) inside = !inside;
  }
  return inside;
}
/** Polygon overlap, including crossing segments with no vertex inside the polygon. */
export function geometryTouchesArea(points: readonly (readonly number[])[], area: Area): boolean {
  if (points.some(p => pointInArea(p, area))) return true;
  const ring = area.polygonCoordinates;
  if (points.length > 3 && same(points[0], points[points.length - 1])) {
    // A footprint that wholly contains the study area has no vertex inside it.
    const footprint = areaFromBoundary('footprint', '', points as Point[]);
    if (ring.some(p => pointInArea(p, footprint))) return true;
  }
  const orient = (a: readonly number[], b: readonly number[], c: readonly number[]) => (b[0]-a[0])*(c[1]-a[1])-(b[1]-a[1])*(c[0]-a[0]);
  for (let i = 1; i < points.length; i++) for (let j = 1; j < ring.length; j++) {
    const a = points[i-1], b = points[i], c = ring[j-1], d = ring[j];
    if (orient(a,b,c)*orient(a,b,d) < 0 && orient(c,d,a)*orient(c,d,b) < 0) return true;
  }
  return false;
}

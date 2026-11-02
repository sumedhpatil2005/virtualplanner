/**
 * The ground the scene is drawn on: the ellipsoid (0 m) when terrain is off,
 * the sampled terrain when it is on. Everything that turns model coordinates
 * into scene positions goes through here, so roads, buildings, bridges,
 * vehicles and overlays all sit on the same ground.
 *
 * Model coordinates never include the ground: a picked point on the terrain
 * is converted back with modelHeight() before it is stored.
 */
import { Cartesian3 } from 'cesium';
import type { TerrainHeightField } from './TerrainHeightField';

let field: TerrainHeightField | null = null;
let revision = 0;
let flatBase: number | null = null;

export function setGroundField(f: TerrainHeightField | null) {
  field = f;
  revision++;
}
export const getGroundField = () => field;
/** Changes whenever the ground changes (for caches of generated geometry). */
export const groundRevision = () => revision;

/** Ground height at a point (0 without terrain). */
export function groundAt(lng: number, lat: number): number {
  if (flatBase !== null) return flatBase;
  return field ? field.heightAt(lng, lat) : 0;
}

/** Scene height for a model height (above ground). */
export const sceneHeight = (lng: number, lat: number, h: number) => h + groundAt(lng, lat);
/** Model height (above ground) for a picked scene height. */
export const modelHeight = (lng: number, lat: number, sceneH: number) => sceneH - (field ? field.heightAt(lng, lat) : 0);

/** Cartesian3.fromDegrees on the current ground. */
export function scenePoint(lng: number, lat: number, h = 0, result?: Cartesian3): Cartesian3 {
  return Cartesian3.fromDegrees(lng, lat, sceneHeight(lng, lat, h), undefined, result);
}

/**
 * Runs `fn` with the ground held flat at the lowest point under `footprint`,
 * so a building's base and roof stay level on sloping ground.
 */
export function withFlatGround<T>(footprint: readonly (readonly number[])[], fn: () => T): T {
  if (!field || !footprint.length) return fn();
  const prev = flatBase;
  flatBase = field.minHeightUnder(footprint);
  try { return fn(); } finally { flatBase = prev; }
}

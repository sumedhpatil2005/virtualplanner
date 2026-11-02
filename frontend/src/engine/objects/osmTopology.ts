import type { CityObject } from './types';

/**
 * Whether a road's connections come from OpenStreetMap: an imported OSM way
 * whose ends are where OSM put them and whose shape nobody edited. Such roads
 * join other OSM ways only at the nodes they share (OSM records that), never
 * just because they cross or come close. Roads the user drew or reshaped
 * join by geometry instead.
 *
 * Heights may differ from the source (bridge decks and ramps are raised in
 * memory) and extra points may have been added along the way; neither
 * changes where the road meets others.
 */
export function hasOsmTopology(r: CityObject | undefined): boolean {
  if (r?.type !== 'road' || !r.osmProvenance) return false;
  if (r.sections?.some(s => s.provenance?.geometryModified)) return false;
  const src = r.sourceCoordinates;
  const same = (a?: readonly number[], b?: readonly number[]) => !!a && !!b && a[0] === b[0] && a[1] === b[1];
  return !src || (same(src[0], r.coordinates[0]) && same(src[src.length - 1], r.coordinates[r.coordinates.length - 1]));
}

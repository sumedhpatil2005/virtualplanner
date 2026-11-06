import type { DrivableObject } from './StudyAreaExplorer';
import { motorVehicleAccess } from '../editing/osmDrivability';

/**
 * Roads open only for local access (docs/OVERHAUL.md §17, §19): the rule the
 * area assignment and the live micro-simulation share, so a campus or gated
 * road is a through route in neither.
 */
/** OSM access values under which a road is for local access only (OSRM car profile, restricted_access_tag_list). */
export const RESTRICTED_ACCESS = new Set(['private', 'destination', 'delivery', 'customers', 'permit', 'residents']);
/**
 * Generalised cost (s) of entering a restricted road from a public one. Prohibitive, so through routes avoid
 * restricted roads whenever any public route exists; finite, so trips that start or end on one are still routed.
 * The number of entries a trip makes is then fixed by the network's layout, not by the link costs, so it is left
 * out of the reported times, the relative gap and the line search.
 */
export const RESTRICTED_ENTRY_S = 1e7;

/** True for an OSM road that motor traffic may use only to reach places along it (private, destination, ...). */
export function isAccessRestricted(road: DrivableObject | undefined): boolean {
  if (road?.type !== 'road') return false;
  const tags = road.osmProvenance?.originalTags;
  if (!tags) return false;
  const access = motorVehicleAccess(tags);
  return !!access && RESTRICTED_ACCESS.has(access);
}

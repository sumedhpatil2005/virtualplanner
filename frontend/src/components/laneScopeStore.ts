import { engineInstance } from '../engine/TwinCityEngine';
import { DEFAULT_LANE_EDIT_SCOPE, type LaneEditScope } from '../engine/editing/roadEdits';

/**
 * The lane edit scope chosen in Build (LaneScopeControl.tsx), read by PropertiesPanel when it applies a lane edit.
 * A choice holds for the road it was made on: another road reads the default (carriageway) until a scope is picked on
 * it. (The control used to reset a single global scope in an effect when the road changed; a late effect then
 * overwrote the first scope click on a newly selected road, so "This segment only" applied to the whole carriageway.)
 */
let chosen: { roadId: string; scope: LaneEditScope } | null = null;
let appliedAt = 0;
const listeners = new Set<() => void>();
const emit = () => listeners.forEach(l => l());
export const subscribeLaneScope = (l: () => void) => { listeners.add(l); return () => { listeners.delete(l); }; };

/** The scope the next lane edit on this road uses. */
export const getLaneEditScope = (roadId: string): LaneEditScope => (chosen && chosen.roadId === roadId ? chosen.scope : DEFAULT_LANE_EDIT_SCOPE);
export const setLaneEditScope = (roadId: string, s: LaneEditScope) => { chosen = { roadId, scope: s }; emit(); };
/** How many lane edits were applied (the control clears its preview when it changes). */
export const laneEditAppliedCount = () => appliedAt;
/** Called after a lane edit is applied: the preview highlight clears. */
export const laneEditApplied = () => { appliedAt++; engineInstance.highlightRoads(null, 'lane-scope'); emit(); };

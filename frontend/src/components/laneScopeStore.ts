import { engineInstance } from '../engine/TwinCityEngine';
import { DEFAULT_LANE_EDIT_SCOPE, type LaneEditScope } from '../engine/editing/roadEdits';

/** The lane edit scope chosen in Build (LaneScopeControl.tsx), read by PropertiesPanel when it applies a lane edit. */
let scope: LaneEditScope = DEFAULT_LANE_EDIT_SCOPE;
let appliedAt = 0;
const listeners = new Set<() => void>();
const emit = () => listeners.forEach(l => l());
export const subscribeLaneScope = (l: () => void) => { listeners.add(l); return () => { listeners.delete(l); }; };

/** The scope the next lane edit uses. */
export const getLaneEditScope = (): LaneEditScope => scope;
export const setLaneEditScope = (s: LaneEditScope) => { scope = s; emit(); };
/** How many lane edits were applied (the control clears its preview when it changes). */
export const laneEditAppliedCount = () => appliedAt;
/** Called after a lane edit is applied: the preview highlight clears. */
export const laneEditApplied = () => { appliedAt++; engineInstance.highlightRoads(null, 'lane-scope'); emit(); };

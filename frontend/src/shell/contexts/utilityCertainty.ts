import { BASE_SCENARIO_ID } from '../../engine/scenarios/ScenarioManager';
import type { UtilityObject } from '../../engine/objects/types';

export const UTILITY_LABEL: Record<UtilityObject['utilityType'], string> = {
  water: 'Water', electricity: 'Electric', sewage: 'Sewer', gas: 'Gas', fiber: 'Telecom / fibre',
};

/** Drawing default for a new utility conduit (EditingEngine draw_utility). */
export const DEFAULT_DEPTH_M = 1.5;

/**
 * How certain a utility's position and depth are. Nothing in UrbanOS imports utility records or surveys yet, so every
 * utility is drawn by hand: on a proposal it is a design value (hypothetical); on the base city it is an unsourced
 * entry (unknown). Never "measured". ASCE 38 quality levels are not recorded.
 */
export function utilityCertainty(u: UtilityObject): { level: 'hypothetical' | 'unknown'; why: string } {
  return u.scenarioId === BASE_SCENARIO_ID
    ? { level: 'unknown', why: 'Entered by hand on the base city; no utility record or survey (ASCE 38 quality level not recorded)' }
    : { level: 'hypothetical', why: 'Drawn as part of a proposal; position and depth are design values' };
}


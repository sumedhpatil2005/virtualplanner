import type { CityObject } from '../objects/types';
import { BASE_SCENARIO_ID } from './ScenarioManager';

/**
 * Objects visible in a scenario: everything in base plus the scenario's own
 * objects, where a scenario object with the same id as a base object replaces it.
 *
 * O(n): override ids are collected into a Set first. The previous version ran
 * `all.some(...)` inside `all.filter(...)`, which is O(n²) whenever a proposal
 * is active (~55M comparisons for 7,400 objects).
 */
export function filterObjectsForScenario(all: readonly CityObject[], activeScenarioId: string): CityObject[] {
  if (activeScenarioId === BASE_SCENARIO_ID) {
    return all.filter(o => o.scenarioId === BASE_SCENARIO_ID);
  }
  const overridden = new Set<string>();
  for (const o of all) {
    if (o.scenarioId === activeScenarioId) overridden.add(o.id);
  }
  return all.filter(o =>
    o.scenarioId === activeScenarioId || (o.scenarioId === BASE_SCENARIO_ID && !overridden.has(o.id))
  );
}

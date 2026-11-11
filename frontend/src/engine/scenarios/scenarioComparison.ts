import type { CityObject, BuildingObject, RoadObject } from '../objects/types';
import { polylineLengthMeters } from '../objects/geo';

export interface ScenarioComparison {
  popDelta: number;
  waterDelta: number; // litres/day
  elecDelta: number; // kWh/day
  newRoadLaneKm: number;
  newFlyoverKm: number;
  newMetroKm: number;
  newStations: number;
  newBuildings: number;
  /** Baseline objects the proposal changes (its own version) or removes (tombstones). */
  changedExisting: number;
  removedExisting: number;
}

const sumBuildings = (objs: CityObject[], key: 'population' | 'waterDemand' | 'electricityDemand') =>
  objs.reduce((acc, o) => (o.type === 'building' ? acc + ((o as BuildingObject)[key] || 0) : acc), 0);

/**
 * What a proposal changes against the baseline, from the two materialised views (ObjectManager.viewOf): base and
 * proposal = baseline ⊕ its change set. Lane-km and building totals are net changes, so widening, deleting
 * (tombstones) and new objects all count. Everything here is derived from object data — no invented figures.
 */
export function compareScenario(baseView: CityObject[], scenarioView: CityObject[]): ScenarioComparison {
  const baseIds = new Set(baseView.map(o => o.id));
  const scenIds = new Set(scenarioView.map(o => o.id));
  const own = scenarioView.filter(o => !baseIds.has(o.id));
  const km = (o: CityObject) => polylineLengthMeters(o.coordinates as number[][]) / 1000;
  const laneKm = (objs: CityObject[]) => objs.filter(o => o.type === 'road').reduce((acc, o) => acc + km(o) * ((o as RoadObject).laneCount || 0), 0);
  const byId = new Map(baseView.map(o => [o.id, o]));

  return {
    popDelta: sumBuildings(scenarioView, 'population') - sumBuildings(baseView, 'population'),
    waterDelta: sumBuildings(scenarioView, 'waterDemand') - sumBuildings(baseView, 'waterDemand'),
    elecDelta: sumBuildings(scenarioView, 'electricityDemand') - sumBuildings(baseView, 'electricityDemand'),
    newRoadLaneKm: laneKm(scenarioView) - laneKm(baseView),
    newFlyoverKm: own.filter(o => o.type === 'flyover' || o.type === 'metro_flyover').reduce((acc, o) => acc + km(o), 0),
    newMetroKm: own.filter(o => o.type === 'metro_line' || o.type === 'metro_flyover').reduce((acc, o) => acc + km(o), 0),
    newStations: own.filter(o => o.type === 'metro_station').length,
    newBuildings: own.filter(o => o.type === 'building').length,
    changedExisting: scenarioView.filter(o => baseIds.has(o.id) && byId.get(o.id) !== o).length,
    removedExisting: baseView.filter(o => !scenIds.has(o.id)).length,
  };
}

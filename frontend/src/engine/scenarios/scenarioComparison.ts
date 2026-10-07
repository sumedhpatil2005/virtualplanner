import { BASE_SCENARIO_ID } from './ScenarioManager';
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
}

const sumBuildings = (objs: CityObject[], key: 'population' | 'waterDemand' | 'electricityDemand') =>
  objs.reduce((acc, o) => (o.type === 'building' ? acc + ((o as BuildingObject)[key] || 0) : acc), 0);

/** Everything here is derived from object data — no invented figures. */
export function compareScenario(all: CityObject[], scenarioId: string): ScenarioComparison {
  const base = all.filter(o => o.scenarioId === BASE_SCENARIO_ID);
  const own = all.filter(o => o.scenarioId === scenarioId);
  const combined = [...base, ...own];
  const km = (o: CityObject) => polylineLengthMeters(o.coordinates as number[][]) / 1000;

  return {
    popDelta: sumBuildings(combined, 'population') - sumBuildings(base, 'population'),
    waterDelta: sumBuildings(combined, 'waterDemand') - sumBuildings(base, 'waterDemand'),
    elecDelta: sumBuildings(combined, 'electricityDemand') - sumBuildings(base, 'electricityDemand'),
    newRoadLaneKm: own.filter(o => o.type === 'road').reduce((acc, o) => acc + km(o) * ((o as RoadObject).laneCount || 0), 0),
    newFlyoverKm: own.filter(o => o.type === 'flyover' || o.type === 'metro_flyover').reduce((acc, o) => acc + km(o), 0),
    newMetroKm: own.filter(o => o.type === 'metro_line' || o.type === 'metro_flyover').reduce((acc, o) => acc + km(o), 0),
    newStations: own.filter(o => o.type === 'metro_station').length,
    newBuildings: own.filter(o => o.type === 'building').length,
  };
}

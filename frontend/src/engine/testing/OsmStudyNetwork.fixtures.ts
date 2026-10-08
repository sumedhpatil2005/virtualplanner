import type { RoadObject } from '../objects/types';

/** Roads for tests: imported from OpenStreetMap, or built by the user. */

let osmIds = 1000;

const base = (id: string, coordinates: [number, number, number][]): RoadObject => ({
  id, type: 'road', name: id, layerId: 'roads', scenarioId: 'base', coordinates,
  roadClass: 'arterial', width: 10, laneCount: 2, laneWidth: 3.5,
  hasDivider: false, dividerWidth: 0, hasFootpath: false, footpathWidth: 0,
  speedLimit: 50, isOneWay: false, trafficCapacity: 2000,
  connectedJunctions: [], createdAt: '', updatedAt: '',
});

export const osmRoad = (id: string, coordinates: [number, number, number][]): RoadObject => ({
  ...base(id, coordinates),
  osmProvenance: { osmId: osmIds++, originalTags: { highway: 'primary' }, layer: 0, bridge: false, tunnel: false, roundabout: false },
});

export const builtRoad = (id: string, coordinates: [number, number, number][]): RoadObject => base(id, coordinates);

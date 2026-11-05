import type { RoadObject, RoadSectionProfile } from '../objects/types';

/**
 * The changes a Build properties edit of one field makes to a road (moved here
 * from PropertiesPanel.tsx unchanged so it can be tested): lanes per direction
 * live in the first section's carriageways, and the derived totals (laneCount,
 * width, trafficCapacity) follow them. `synthesize` builds default sections for
 * a road that has none.
 */
export function roadFieldUpdates(r: RoadObject, field: string, value: any, synthesize: (r: RoadObject) => RoadSectionProfile[]): Partial<RoadObject> {
  const rUpdates: Partial<RoadObject> = {};

  let sections = r.sections ? JSON.parse(JSON.stringify(r.sections)) : synthesize(r);
  if (!sections || sections.length === 0) {
    sections = synthesize(r);
  }

  const firstSection = sections[0];
  let carriagewayA = firstSection.carriagewayA;
  let carriagewayB = firstSection.carriagewayB;

  let isOneWay = r.isOneWay;
  let laneWidth = r.laneWidth || 3.5;
  let hasDivider = r.hasDivider;
  let dividerWidth = r.dividerWidth || 2.0;
  let hasFootpath = r.hasFootpath;
  let footpathWidth = r.footpathWidth || 1.5;

  if (field === 'isOneWay') {
    isOneWay = Boolean(value);
    rUpdates.isOneWay = isOneWay;
  } else if (field === 'hasDivider') {
    hasDivider = Boolean(value);
    rUpdates.hasDivider = hasDivider;
  } else if (field === 'dividerWidth') {
    dividerWidth = Number(value);
    rUpdates.dividerWidth = dividerWidth;
  } else if (field === 'hasFootpath') {
    hasFootpath = Boolean(value);
    rUpdates.hasFootpath = hasFootpath;
  } else if (field === 'footpathWidth') {
    footpathWidth = Number(value);
    rUpdates.footpathWidth = footpathWidth;
  } else if (field === 'laneWidth') {
    laneWidth = Number(value);
    rUpdates.laneWidth = laneWidth;
  }

  if (field === 'isOneWay') {
    if (isOneWay) {
      carriagewayA.direction = 'forward';
      firstSection.carriagewayB = undefined;
      carriagewayB = undefined;
    } else {
      carriagewayA.direction = 'both';
      const defaultBwdLanes = 1;
      firstSection.carriagewayB = {
        direction: 'backward',
        lanes: defaultBwdLanes,
        laneWidth,
        leftRoadside: { footpathWidth: 0, cycleTrackWidth: 0, vergeWidth: 0, parkingWidth: 0, drainageWidth: 0 },
        rightRoadside: { footpathWidth: hasFootpath ? footpathWidth : 0, cycleTrackWidth: 0, vergeWidth: 0, parkingWidth: 0, drainageWidth: 0 }
      };
      carriagewayB = firstSection.carriagewayB;
    }
  } else if (field === 'lanesForward') {
    carriagewayA.lanes = Math.max(1, Number(value));
  } else if (field === 'lanesBackward') {
    if (isOneWay) {
      firstSection.carriagewayB = undefined;
      carriagewayB = undefined;
    } else {
      if (!carriagewayB) {
        firstSection.carriagewayB = {
          direction: 'backward',
          lanes: Math.max(1, Number(value)),
          laneWidth,
          leftRoadside: { footpathWidth: 0, cycleTrackWidth: 0, vergeWidth: 0, parkingWidth: 0, drainageWidth: 0 },
          rightRoadside: { footpathWidth: hasFootpath ? footpathWidth : 0, cycleTrackWidth: 0, vergeWidth: 0, parkingWidth: 0, drainageWidth: 0 }
        };
        carriagewayB = firstSection.carriagewayB;
      } else {
        carriagewayB.lanes = Math.max(1, Number(value));
      }
    }
  }

  carriagewayA.laneWidth = laneWidth;
  if (carriagewayB) carriagewayB.laneWidth = laneWidth;

  firstSection.hasMedian = hasDivider && !isOneWay;
  firstSection.medianWidth = firstSection.hasMedian ? dividerWidth : 0;

  carriagewayA.leftRoadside.footpathWidth = hasFootpath ? footpathWidth : 0;
  if (carriagewayB) {
    carriagewayB.rightRoadside.footpathWidth = hasFootpath ? footpathWidth : 0;
    carriagewayA.rightRoadside.footpathWidth = 0;
  } else {
    carriagewayA.rightRoadside.footpathWidth = hasFootpath ? footpathWidth : 0;
  }

  const laneCount = carriagewayA.lanes + (carriagewayB?.lanes || 0);
  rUpdates.laneCount = laneCount;
  rUpdates.sections = sections;

  const totalLanesWidth = (carriagewayA.lanes * laneWidth) + (carriagewayB ? carriagewayB.lanes * laneWidth : 0);
  const medianWidth = firstSection.hasMedian ? dividerWidth : 0;
  const leftFootpath = carriagewayA.leftRoadside.footpathWidth || 0;
  const rightFootpath = carriagewayB ? (carriagewayB.rightRoadside.footpathWidth || 0) : (carriagewayA.rightRoadside.footpathWidth || 0);
  rUpdates.width = totalLanesWidth + medianWidth + leftFootpath + rightFootpath;
  rUpdates.trafficCapacity = laneCount * 1000;

  rUpdates.laneWidth = laneWidth;
  rUpdates.hasDivider = hasDivider && !isOneWay;
  rUpdates.dividerWidth = rUpdates.hasDivider ? dividerWidth : 0;
  rUpdates.hasFootpath = hasFootpath;
  rUpdates.footpathWidth = footpathWidth;

  if (field === 'speedLimit' || field === 'trafficCapacity') {
    (rUpdates as any)[field] = Number(value);
  } else if (field === 'roadClass' || field === 'name') {
    (rUpdates as any)[field] = value;
  }
  return rUpdates;
}

export type LaneField = 'lanesForward' | 'lanesBackward';

/**
 * The roads a Build lane edit changes and how: `[{ id, updates }]`.
 * Today only the road the user selected.
 */
export function laneEditPlan(roads: readonly RoadObject[], roadId: string, field: LaneField, value: number, synthesize: (r: RoadObject) => RoadSectionProfile[]): { id: string; updates: Partial<RoadObject> }[] {
  const road = roads.find(r => r.id === roadId);
  if (!road) return [];
  return [{ id: road.id, updates: roadFieldUpdates(road, field, value, synthesize) }];
}

import type { CityObject, RoadObject, RoadSectionProfile } from '../objects/types';
import type { HistoryDiff } from '../history/HistoryManager';
import { carriagewayRun, SECTION_MAX_M, type CarriagewayPiece } from '../simulation/roadSection';

/**
 * The changes a Build properties edit of one field makes to a road (moved here
 * from PropertiesPanel.tsx unchanged so it can be tested): lanes per direction
 * live in the first section's carriageways, and the derived totals (laneCount,
 * width, trafficCapacity) follow them. `synthesize` builds default sections for
 * a road that has none.
 */
export function roadFieldUpdates(r: RoadObject, field: string, value: any, synthesize: (r: RoadObject) => RoadSectionProfile[]): Partial<RoadObject> {
  // A field that is not part of the cross-section changes only itself. Before, every edit also rebuilt the road's
  // cross-section from its top-level fields, so changing the speed limit or class of a one-way road added a
  // footpath on its right and widened it by 1.5 m (docs/OVERHAUL.md §27)
  if (field === 'speedLimit' || field === 'trafficCapacity') return { [field]: Number(value) };
  if (field === 'roadClass' || field === 'name') return { [field]: value };
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

  // The lanes or direction are now the user's: the simulation's correction layer must not override them (networkCorrections.ts)
  if (field === 'lanesForward' || field === 'lanesBackward' || field === 'isOneWay') {
    const was = firstSection.provenance ?? { originalSource: r.osmProvenance ? 'OSM' : 'manual', originalConfidence: 'estimated', geometryModified: false, verificationStatus: 'unverified' };
    firstSection.provenance = { ...was, profileModified: true, lastModifiedBy: 'manual' };
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

/** Pieces of one carriageway followed at most this far from the edited piece (m), as a road section (roadSection.ts). */
export const LANE_EDIT_MAX_M = SECTION_MAX_M;
/**
 * The roads as the analysis sees them (SimulationMode.roadView: the network corrections applied on top of the
 * stored roads, which stay unchanged). Given to a lane edit so its "Entire carriageway" is the carriageway the
 * analysis reads a direction's capacity from; road ids are kept, geometry may be reversed.
 */
export type RoadView = (roads: readonly RoadObject[]) => readonly RoadObject[];
const M_PER_DEG_LAT = 111320;
const lengthM = (c: readonly (readonly number[])[]) => {
  let n = 0;
  for (let i = 1; i < c.length; i++) n += Math.hypot((c[i][0] - c[i - 1][0]) * M_PER_DEG_LAT * Math.cos(c[i][1] * Math.PI / 180), (c[i][1] - c[i - 1][1]) * M_PER_DEG_LAT);
  return n;
};
/** Lanes a road has in the direction a field edits (the first section's carriageways, as the panel and the traffic network read them). */
export function directionLanes(r: RoadObject, field: LaneField): number {
  const sec = r.sections?.[0];
  if (field === 'lanesForward') return sec?.carriagewayA?.lanes ?? Math.ceil((r.laneCount || 2) / (r.isOneWay ? 1 : 2));
  return r.isOneWay ? 0 : sec ? sec.carriagewayB?.lanes ?? 0 : Math.floor((r.laneCount || 2) / 2);
}

/**
 * The pieces of the carriageway a lane edit is meant for: the selected road's
 * carriageway in the edited direction (carriagewayRun, roadSection.ts: the
 * same definition the analysis reads a direction's capacity from), followed
 * only while the lanes in the edited direction stay those of the selected
 * piece. OSM splits one carriageway into many ways (Sangamwadi Bridge
 * eastbound is a 60 m approach, the 368 m deck and a 136 m approach), and a
 * road's capacity is that of its narrowest stretch, so widening only the
 * clicked way left the bridge's capacity where it was (docs/OVERHAUL.md §14,
 * §21). Returns each piece with the field to edit on it (a two-way way drawn
 * the other way round has its directions swapped).
 */
export function carriagewayPieces(roads: readonly RoadObject[], roadId: string, field: LaneField, view?: RoadView): { road: RoadObject; field: LaneField }[] {
  const sel = roads.find(r => r.id === roadId);
  if (!sel || sel.coordinates.length < 2) return [];
  // A one-way road has no lanes against its direction to edit
  if (sel.isOneWay && field === 'lanesBackward') return [{ road: sel, field }];
  // The run is found on the roads as the analysis sees them (the network corrections applied: a way reversed,
  // made one-way or two-way), so the edit reaches the stretch the analysis reads the capacity from; each piece's
  // field is then turned back to the stored way's drawing direction
  const seen = view ? view(roads) : roads;
  const rawById = new Map(roads.map(r => [r.id, r]));
  const reversed = (v: RoadObject) => {
    const r = rawById.get(v.id);
    if (!r || r === v || r.coordinates.length < 2) return false;
    const a = r.coordinates, b = v.coordinates;
    return a[0] !== a[a.length - 1] && b[0][0] === a[a.length - 1][0] && b[0][1] === a[a.length - 1][1] && !(b[0][0] === a[0][0] && b[0][1] === a[0][1]);
  };
  const flip = (f: LaneField): LaneField => (f === 'lanesForward' ? 'lanesBackward' : 'lanesForward');
  const selSeen = seen.find(r => r.id === roadId) ?? sel;
  const fieldSeen = reversed(selSeen) ? flip(field) : field;
  if (selSeen.isOneWay && fieldSeen === 'lanesBackward') return [{ road: sel, field }];
  const lanes = directionLanes(selSeen, fieldSeen);
  const fieldOf = (along: boolean): LaneField => (along ? 'lanesForward' : 'lanesBackward');
  const storedField = (p: CarriagewayPiece) => (p.road.id === roadId ? field : reversed(p.road as RoadObject) ? flip(fieldOf(p.along)) : fieldOf(p.along));
  // A stored one-way way that a correction makes two-way has no lanes against its stored direction to set (and
  // lanes set in Build switch the correction's lane and two-way fix off): the edit stops before it
  const editable = (p: CarriagewayPiece) => { const raw = rawById.get(p.road.id); return !!raw && !(raw.isOneWay && storedField(p) === 'lanesBackward'); };
  const run = carriagewayRun(seen, roadId, fieldSeen === 'lanesForward', p => directionLanes(p.road as RoadObject, fieldOf(p.along)) === lanes && editable(p));
  return run.map(p => ({ road: rawById.get(p.road.id)!, field: storedField(p) }));
}

/**
 * How far a Build lane edit reaches (docs/OVERHAUL.md §16): the whole
 * connected carriageway (carriagewayPieces, the default) or only the selected
 * OpenStreetMap way.
 */
export type LaneEditScope = 'carriageway' | 'segment';
export const DEFAULT_LANE_EDIT_SCOPE: LaneEditScope = 'carriageway';

/** The pieces a lane edit with this scope changes, the selected road first. */
export function laneEditPieces(roads: readonly RoadObject[], roadId: string, field: LaneField, scope: LaneEditScope = DEFAULT_LANE_EDIT_SCOPE, view?: RoadView): { road: RoadObject; field: LaneField }[] {
  if (scope === 'segment') {
    const sel = roads.find(r => r.id === roadId);
    return sel ? [{ road: sel, field }] : [];
  }
  return carriagewayPieces(roads, roadId, field, view);
}

/**
 * What a lane edit with this scope would change, for the preview before it is
 * applied: the road ids (exactly those laneEditPlan then edits), how many, and
 * their total length ("3 pieces · 564 m").
 */
export function laneEditPreview(roads: readonly RoadObject[], roadId: string, field: LaneField, scope: LaneEditScope = DEFAULT_LANE_EDIT_SCOPE, view?: RoadView): { roadIds: string[]; count: number; lengthM: number; label: string } {
  const pieces = laneEditPieces(roads, roadId, field, scope, view);
  const len = Math.round(pieces.reduce((n, p) => n + lengthM(p.road.coordinates), 0));
  return { roadIds: pieces.map(p => p.road.id), count: pieces.length, lengthM: len, label: `${pieces.length} piece${pieces.length === 1 ? '' : 's'} · ${len.toLocaleString('en-US')} m` };
}

/**
 * The roads a Build lane edit changes and how: `[{ id, updates }]`, the
 * selected road first, then (scope 'carriageway', the default) the other
 * pieces of its carriageway (carriagewayPieces).
 */
export function laneEditPlan(roads: readonly RoadObject[], roadId: string, field: LaneField, value: number, synthesize: (r: RoadObject) => RoadSectionProfile[], scope: LaneEditScope = DEFAULT_LANE_EDIT_SCOPE, view?: RoadView): { id: string; updates: Partial<RoadObject> }[] {
  return laneEditPieces(roads, roadId, field, scope, view).map(p => ({ id: p.road.id, updates: roadFieldUpdates(p.road, p.field, value, synthesize) }));
}

/** What a Build road edit needs of the object store and the undo history (ObjectManager, HistoryManager). */
export interface RoadEditStore {
  getAll(): CityObject[];
  getById(id: string): CityObject | undefined;
  update(id: string, updates: Partial<CityObject>): void;
  synthesizeDefaultSections(r: RoadObject): RoadSectionProfile[];
}
export interface RoadEditHistory {
  pushDiff(diff: HistoryDiff): void;
  recordUpdate(before: CityObject, after: CityObject, description?: string, coalesceKey?: string): void;
}

/**
 * Applies one Build properties edit of a road and records it for Undo, exactly as the properties panel does
 * (moved here from PropertiesPanel.tsx so the whole-network edit tests run the same code, docs/OVERHAUL.md §27):
 * a lane edit covers the chosen scope (laneEditPlan) as one batch step when it reaches more than one piece;
 * every other edit, and a lane edit of one piece, is a single update coalesced per road and field. `selected`
 * is the road as the panel holds it. Returns the road ids changed and the selected road as edited.
 */
export function commitRoadFieldEdit(objects: RoadEditStore, history: RoadEditHistory, selected: RoadObject, field: string, value: unknown,
  scope: LaneEditScope = DEFAULT_LANE_EDIT_SCOPE, view?: RoadView): { ids: string[]; selected: RoadObject } {
  const synthesize = (r: RoadObject) => objects.synthesizeDefaultSections(r);
  if (field === 'lanesForward' || field === 'lanesBackward') {
    const roads = objects.getAll().filter((o): o is RoadObject => o.type === 'road');
    const plan = laneEditPlan(roads, selected.id, field, Number(value), synthesize, scope, view);
    if (plan.length > 1) {
      const before = plan.map(p => objects.getById(p.id)!);
      history.pushDiff({ type: 'batch', description: `Update ${selected.name || selected.id} lanes (${plan.length} pieces)`,
        diffs: plan.map((p, i) => ({ type: 'update' as const, id: p.id, before: before[i], after: { ...before[i], ...p.updates } as CityObject })) });
      for (const p of plan) objects.update(p.id, p.updates);
      return { ids: plan.map(p => p.id), selected: { ...selected, ...plan[0].updates } as RoadObject };
    }
  }
  const updates = roadFieldUpdates(selected, field, value, synthesize);
  const merged = { ...selected, ...updates } as RoadObject;
  // Coalesce per object+field so typing or dragging a slider is one Undo step
  history.recordUpdate(selected, merged, `Update ${selected.name || selected.id} ${field}`, `${selected.id}:${field}`);
  objects.update(selected.id, updates);
  return { ids: [selected.id], selected: merged };
}

/** The changes a Build properties edit of one field makes to a drawn flyover (moved from PropertiesPanel.tsx unchanged). */
export function flyoverFieldUpdates(obj: CityObject, field: string, value: any): Partial<CityObject> {
  const f = obj as any;
  const fUpdates: any = {};
  let laneCount = f.laneCount;
  let laneWidth = f.laneWidth || 3.5;
  let hasDivider = f.hasDivider;
  let dividerWidth = f.dividerWidth || 2.0;
  let hasFootpath = f.hasFootpath;
  let footpathWidth = f.footpathWidth || 1.5;

  if (field === 'laneCount') laneCount = Number(value);
  else if (field === 'lanesForward') {
    const bwdLanes = f.isOneWay ? 0 : Math.floor(f.laneCount / 2);
    laneCount = Number(value) + bwdLanes;
  } else if (field === 'lanesBackward') {
    const fwdLanes = Math.ceil(f.laneCount / (f.isOneWay ? 1 : 2));
    laneCount = fwdLanes + Number(value);
  }
  else if (field === 'laneWidth') laneWidth = Number(value);
  else if (field === 'hasDivider') hasDivider = Boolean(value);
  else if (field === 'dividerWidth') dividerWidth = Number(value);
  else if (field === 'hasFootpath') hasFootpath = Boolean(value);
  else if (field === 'footpathWidth') footpathWidth = Number(value);
  else if (field === 'elevation' || field === 'pierSpacing') {
    (fUpdates as any)[field] = Number(value);
  }

  fUpdates.laneCount = laneCount;
  fUpdates.laneWidth = laneWidth;
  fUpdates.hasDivider = hasDivider;
  fUpdates.dividerWidth = dividerWidth;
  fUpdates.hasFootpath = hasFootpath;
  fUpdates.footpathWidth = footpathWidth;

  const asphaltWidth = (laneCount * laneWidth) + (hasDivider ? dividerWidth : 0);
  fUpdates.width = asphaltWidth + (hasFootpath ? footpathWidth * 2 : 0);

  if (field === 'speedLimit') {
    fUpdates.speedLimit = Number(value);
  } else if (field === 'isOneWay') {
    fUpdates.isOneWay = Boolean(value);
  } else if (field === 'roadClass' || field === 'name') {
    (fUpdates as any)[field] = value;
  }
  return fUpdates;
}

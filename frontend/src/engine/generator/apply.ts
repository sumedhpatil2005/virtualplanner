import type { ObjectManager } from '../objects/ObjectManager';
import type { HistoryManager } from '../history/HistoryManager';
import type { CityObject, FlyoverObject, RoadObject } from '../objects/types';
import { BASE_SCENARIO_ID } from '../scenarios/ScenarioManager';
import { applyJunctionEdit } from '../editing/junctionEdits';
import { commitRoadFieldEdit } from '../editing/roadEdits';
import { TrafficNetworkBuilder } from '../simulation/TrafficNetworkBuilder';
import type { Candidate, CandidateEdit } from './candidates';

/**
 * Writes a candidate's edits into ONE proposal scenario through the scenario
 * copy-on-write system (docs/SCENARIOS_AND_VERSIONING.md): junction edits as
 * the scenario's junction objects, road field edits with the Build editor's own
 * function (commitRoadFieldEdit, one Undo step each), drawn objects through the
 * Build drawing path when the caller gives one (`draw`), else added as plain
 * objects. Refuses to run with the baseline active, so a generator bug cannot
 * reach the baseline.
 */
export interface DrawFn { (edit: Extract<CandidateEdit, { op: 'draw' }>, scenarioId: string): string | null }

export function applyCandidate(objects: ObjectManager, history: HistoryManager, scenarioId: string, c: Candidate, draw?: DrawFn): { changedIds: string[]; drawnIds: string[] } {
  if (scenarioId === BASE_SCENARIO_ID || objects.getActiveScenarioId() !== scenarioId) throw new Error('Candidates are applied only inside their own active proposal scenario.');
  const changedIds: string[] = [], drawnIds: string[] = [];
  for (const e of c.edits) {
    if (e.op === 'junction_edit') {
      changedIds.push(applyJunctionEdit(objects, history, e.spec, scenarioId, e.centre).id);
    } else if (e.op === 'road_field') {
      const road = objects.getById(e.roadId);
      if (!road || road.type !== 'road') continue;
      changedIds.push(...commitRoadFieldEdit(objects, history, road as RoadObject, e.field, e.value, e.scope).ids);
    } else {
      const id = draw ? draw(e, scenarioId) : drawPlain(objects, history, e, scenarioId);
      if (id) { drawnIds.push(id); changedIds.push(id); }
    }
  }
  return { changedIds, drawnIds };
}

/** A drawn road or flyover added as an object (headless path; the browser uses the Build drawing path). */
function drawPlain(objects: ObjectManager, history: HistoryManager, e: Extract<CandidateEdit, { op: 'draw' }>, scenarioId: string): string {
  const now = new Date().toISOString();
  const id = `gen_${e.mode === 'draw_flyover' ? 'fly' : 'road'}_${Math.abs(hash(JSON.stringify(e.points))).toString(36)}`;
  const common = { id, name: e.name, scenarioId, createdAt: now, updatedAt: now, coordinates: e.points.map(p => [...p] as [number, number, number]), roadClass: e.roadClass,
    laneCount: e.laneCount, laneWidth: 3.5, hasDivider: false, dividerWidth: 0, hasFootpath: false, footpathWidth: 0, speedLimit: 40, isOneWay: e.isOneWay };
  const obj: CityObject = e.mode === 'draw_flyover'
    ? { ...common, type: 'flyover', layerId: 'flyovers', width: 3.5 * e.laneCount + 1, elevation: 6, pierSpacing: 30 } as FlyoverObject
    : { ...common, type: 'road', layerId: 'roads', width: 3.5 * e.laneCount, trafficCapacity: 1000 * e.laneCount, connectedJunctions: [] } as RoadObject;
  history.recordAdd(obj, `Add ${e.name}`);
  objects.add(obj);
  return id;
}

function hash(s: string) { let h = 0; for (let i = 0; i < s.length; i++) h = (h * 31 + s.charCodeAt(i)) | 0; return h; }

export interface TopologyReport {
  ok: boolean;
  /** Per drawn object: whether both ends share a node with the rest of the network, and routes on and off it exist. */
  objects: { id: string; endsJoined: [boolean, boolean]; reachableFromNetwork: boolean; reachesNetwork: boolean; unconfirmedCrossings: number }[];
  problems: string[];
}

/**
 * Topology check of a candidate's drawn objects in the scenario's view: builds the traffic graph with the same
 * builder the simulation uses and checks that each drawn object's ends are nodes shared with other roads and that a
 * route leads onto it from the network and off it into the network. Uncertain level crossings recorded by the
 * drawing path (levelCrossings, decision 'unconfirmed') are reported, never joined.
 */
export function checkCandidateTopology(view: readonly CityObject[], drawnIds: readonly string[]): TopologyReport {
  const drivable = view.filter(o => o.type === 'road' || o.type === 'flyover' || o.type === 'metro_flyover') as RoadObject[];
  const { network } = new TrafficNetworkBuilder().build(drivable);
  const problems: string[] = [];
  const objects = drawnIds.map(id => {
    const own = [...network.edges.values()].filter(e => e.roadId === id);
    const o = view.find(x => x.id === id) as (RoadObject | FlyoverObject | undefined);
    const unconfirmed = (o?.levelCrossings ?? []).filter(x => x.decision === 'unconfirmed').length;
    if (!own.length || !o) { problems.push(`${id}: not in the traffic graph.`); return { id, endsJoined: [false, false] as [boolean, boolean], reachableFromNetwork: false, reachesNetwork: false, unconfirmedCrossings: unconfirmed }; }
    const ownIds = new Set(own.map(e => e.id));
    const nodes = new Set(own.flatMap(e => [e.fromNodeId, e.toNodeId]));
    const sharedNode = (n: string) => { const nd = network.nodes.get(n)!; return [...nd.incomingSegments, ...nd.outgoingSegments].some(s => !ownIds.has(s)); };
    const nearest = (p: readonly number[]) => [...nodes].sort((a, b) => d2(network.nodes.get(a)!.coordinates, p) - d2(network.nodes.get(b)!.coordinates, p))[0];
    const ends: [boolean, boolean] = [sharedNode(nearest(o.coordinates[0])), sharedNode(nearest(o.coordinates.at(-1)!))];
    const entersFrom = own.some(e => network.nodes.get(e.fromNodeId)!.incomingSegments.some(s => !ownIds.has(s)));
    const leavesTo = own.some(e => network.nodes.get(e.toNodeId)!.outgoingSegments.some(s => !ownIds.has(s)));
    if (!ends[0] || !ends[1]) problems.push(`${o.name}: ${!ends[0] && !ends[1] ? 'neither end is' : !ends[0] ? 'its start is not' : 'its end is not'} joined to another road.`);
    if (!entersFrom || !leavesTo) problems.push(`${o.name}: no route ${!entersFrom ? 'onto' : 'off'} it from the network.`);
    if (unconfirmed) problems.push(`${o.name}: ${unconfirmed} crossing(s) could be a bridge, tunnel or ramp; kept separate until the user confirms.`);
    return { id, endsJoined: ends, reachableFromNetwork: entersFrom, reachesNetwork: leavesTo, unconfirmedCrossings: unconfirmed };
  });
  return { ok: objects.every(o => o.endsJoined[0] && o.endsJoined[1] && o.reachableFromNetwork && o.reachesNetwork), objects, problems };
}

const d2 = (a: readonly number[], b: readonly number[]) => (a[0] - b[0]) ** 2 + (a[1] - b[1]) ** 2;

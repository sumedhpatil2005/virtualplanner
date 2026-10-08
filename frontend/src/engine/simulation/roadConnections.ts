import type { RoadObject } from '../objects/types';
import { TrafficNetworkBuilder } from './TrafficNetworkBuilder';
import { boundsOf, type DrivableObject } from './StudyAreaExplorer';

/** What a road joins, as the traffic graph sees it. Road ids, nearest first. */
export interface RoadConnections {
  /** Roads meeting it where it starts; empty when that end is loose. */
  start: string[];
  /** Roads meeting it where it ends; empty when that end is loose. */
  end: string[];
  /** Roads joining it somewhere in between. */
  along: string[];
  /** Roads it crosses above without a link, and below. */
  over: string[];
  under: string[];
}

/** Roads this close (m) around the road are compiled; joins are within ~6 m. */
const MARGIN_M = 30;
const M_PER_DEG_LAT = 111320;

/**
 * Compiles only the roads around `road` into a graph and reads off what it
 * joins at each end, along its length, and where it passes over or under.
 */
export function roadConnections(road: DrivableObject, roads: readonly DrivableObject[]): RoadConnections {
  const b = boundsOf(road.coordinates);
  const dLat = MARGIN_M / M_PER_DEG_LAT;
  const dLng = MARGIN_M / (M_PER_DEG_LAT * Math.cos((((b.minLat + b.maxLat) / 2) * Math.PI) / 180));
  const nearby = roads.filter(r => {
    if (r.id === road.id) return true;
    if (!r.coordinates || r.coordinates.length < 2) return false;
    const o = boundsOf(r.coordinates);
    return o.minLng <= b.maxLng + dLng && o.maxLng >= b.minLng - dLng && o.minLat <= b.maxLat + dLat && o.maxLat >= b.minLat - dLat;
  });
  const { network, gradeSeparations } = new TrafficNetworkBuilder().build(nearby as RoadObject[]);

  const own = [...network.edges.values()].filter(e => e.roadId === road.id);
  const nodes = new Set(own.flatMap(e => [e.fromNodeId, e.toNodeId]));
  const nearestNode = (c: readonly number[]) => {
    let best = '';
    let bestD = Infinity;
    nodes.forEach(id => {
      const n = network.nodes.get(id)!.coordinates;
      const d = (n[0] - c[0]) ** 2 + (n[1] - c[1]) ** 2;
      if (d < bestD) {
        bestD = d;
        best = id;
      }
    });
    return best;
  };
  const othersAt = (nodeId: string) => {
    const node = network.nodes.get(nodeId);
    if (!node) return [];
    const ids = new Set<string>();
    for (const e of [...node.incomingSegments, ...node.outgoingSegments]) {
      const roadId = network.edges.get(e)?.roadId;
      if (roadId && roadId !== road.id) ids.add(roadId);
    }
    return [...ids];
  };

  const startNode = nearestNode(road.coordinates[0]);
  const endNode = nearestNode(road.coordinates[road.coordinates.length - 1]);
  const start = othersAt(startNode);
  const end = othersAt(endNode);
  const along = new Set<string>();
  nodes.forEach(id => {
    if (id !== startNode && id !== endNode) othersAt(id).forEach(r => along.add(r));
  });
  [...start, ...end].forEach(r => along.delete(r));

  const over = new Set<string>();
  const under = new Set<string>();
  for (const g of gradeSeparations) {
    if (g.roadIds[0] === road.id) over.add(g.roadIds[1]);
    else if (g.roadIds[1] === road.id) under.add(g.roadIds[0]);
  }
  return { start, end, along: [...along], over: [...over], under: [...under] };
}

import type { CityObject, RoadObject, FlyoverObject, MetroFlyoverObject } from '../objects/types';
import type { TrafficNetwork, TrafficEdge, TrafficNode } from '../objects/trafficTypes';
import { TrafficNetworkBuilder, GRADE_SEPARATION_M, type GradeSeparation } from './TrafficNetworkBuilder';
import { MinHeap } from './Pathfinder';
import { isUserBuilt } from '../objects/builtBy';
import { connectEnds, AUTO_CONNECT_M } from '../editing/autoConnect';

/**
 * Study-area selection for Simulation mode.
 *
 * The user clicks one or more roads (the "seeds"); the area grows outward along
 * the road network up to a distance limit. Only roads near the seeds are compiled
 * into a graph, so a click costs work proportional to the area, not the city.
 */

/** Objects vehicles can drive on. Metro flyovers carry a road deck under the tracks. */
export type DrivableObject = RoadObject | FlyoverObject | MetroFlyoverObject;

export const isDrivable = (o: CityObject): o is DrivableObject =>
  o.type === 'road' || o.type === 'flyover' || o.type === 'metro_flyover';

export const STUDY_RANGE_MIN_M = 100;
export const STUDY_RANGE_MAX_M = 5000;
export const STUDY_RANGE_STEP_M = 50;

/** A road end this close to another road, without connecting, is reported as a near miss. */
const NEAR_MISS_M = 25;
/** A built road with this share of its length within DUPLICATE_M of mapped roads is reported as a copy of them. */
const DUPLICATE_SHARE = 0.8;
const DUPLICATE_M = 25;
const DUPLICATE_MIN_LENGTH_M = 50;
/** An OSM road end with another road this close already joins it in the network (the builder's tolerance). */
const JOINS_ALREADY_M = 7;
/**
 * A lookup of the roads whose boxes overlap a query box, through a coarse
 * grid: a few cells are read instead of every road.
 */
function roadGrid(index: RoadIndex, roads: readonly DrivableObject[]): (box: Bounds) => DrivableObject[] {
  const cells = new Map<string, DrivableObject[]>();
  const cellOf = (lng: number, lat: number) => [Math.floor(lng / JOIN_CELL_DEG), Math.floor(lat / JOIN_CELL_DEG)];
  for (const r of roads) {
    const b = index.bounds.get(r.id)!;
    const [x0, y0] = cellOf(b.minLng, b.minLat);
    const [x1, y1] = cellOf(b.maxLng, b.maxLat);
    for (let x = x0; x <= x1; x++) {
      for (let y = y0; y <= y1; y++) {
        const key = x + ':' + y;
        const list = cells.get(key);
        if (list) list.push(r);
        else cells.set(key, [r]);
      }
    }
  }
  return box => {
    const out = new Set<DrivableObject>();
    const [x0, y0] = cellOf(box.minLng, box.minLat);
    const [x1, y1] = cellOf(box.maxLng, box.maxLat);
    for (let x = x0; x <= x1; x++) {
      for (let y = y0; y <= y1; y++) {
        for (const o of cells.get(x + ':' + y) ?? []) {
          if (boundsIntersect(index.bounds.get(o.id)!, box)) out.add(o);
        }
      }
    }
    return [...out];
  };
}

/** Grid cell for finding roads near a place (degrees, about 220 m). */
const JOIN_CELL_DEG = 0.002;
/** Extra margin around the area when choosing which roads to compile. */
const BUILD_MARGIN_M = 30;

export type StudyDirection = 'both' | 'downstream' | 'upstream';
export type SegmentRole = 'seed' | 'both' | 'downstream' | 'upstream';
export type JunctionKind = 't_junction' | 'crossroads' | 'complex' | 'roundabout' | 'dead_end';
export type BoundaryKind = 'entry' | 'exit' | 'entry_exit';
export type ProblemSeverity = 'error' | 'warning' | 'info';
export type ProblemKind = 'near_miss' | 'one_way_trap' | 'one_way_source' | 'isolated' | 'no_alternative' | 'dead_end' | 'open_end' | 'duplicate';

export interface Bounds {
  minLng: number;
  minLat: number;
  maxLng: number;
  maxLat: number;
}

/** One physical stretch of road between two junctions (both travel directions). */
export interface StudySegment {
  key: string;
  roadId: string;
  coordinates: [number, number, number][];
  lengthM: number;
  role: SegmentRole;
  /** Network distance from the seed roads, in metres. */
  distanceM: number;
}

export interface StudyJunction {
  nodeId: string;
  coordinates: [number, number, number];
  kind: JunctionKind;
  arms: number;
  distanceM: number;
}

/** Where the study area is cut: traffic enters or leaves the area here. */
export interface StudyBoundaryPoint {
  nodeId: string;
  coordinates: [number, number, number];
  kind: BoundaryKind;
}

export interface StudyProblem {
  id: string;
  kind: ProblemKind;
  severity: ProblemSeverity;
  title: string;
  detail: string;
  location: [number, number, number];
  roadIds: string[];
  distanceM: number;
}

export interface StudyAreaOptions {
  seedRoadIds: string[];
  rangeMeters: number;
  direction: StudyDirection;
}

export interface StudyArea extends StudyAreaOptions {
  segments: StudySegment[];
  junctions: StudyJunction[];
  boundary: StudyBoundaryPoint[];
  gradeSeparations: GradeSeparation[];
  problems: StudyProblem[];
  bounds: Bounds;
  /** The local graph the area was grown on, for the simulation steps that follow. */
  network: TrafficNetwork;
  stats: {
    roads: number;
    segments: number;
    junctions: number;
    lengthKm: number;
    entries: number;
    exits: number;
    /** Roads compiled into the local graph, out of all drivable roads in the scenario. */
    compiledRoads: number;
    totalRoads: number;
    buildMs: number;
    reusedBuild: boolean;
  };
}

// ─── Geometry (local planar approximation; fine at study-area scale) ─────────

const M_PER_DEG_LAT = 111320;
const mPerDegLng = (lat: number) => M_PER_DEG_LAT * Math.cos((lat * Math.PI) / 180);

export const boundsOf = (coords: readonly (readonly number[])[]): Bounds => {
  const b = { minLng: Infinity, minLat: Infinity, maxLng: -Infinity, maxLat: -Infinity };
  for (const c of coords) {
    if (c[0] < b.minLng) b.minLng = c[0];
    if (c[0] > b.maxLng) b.maxLng = c[0];
    if (c[1] < b.minLat) b.minLat = c[1];
    if (c[1] > b.maxLat) b.maxLat = c[1];
  }
  return b;
};

const expandBounds = (b: Bounds, meters: number): Bounds => {
  const dLat = meters / M_PER_DEG_LAT;
  const dLng = meters / mPerDegLng((b.minLat + b.maxLat) / 2);
  return { minLng: b.minLng - dLng, minLat: b.minLat - dLat, maxLng: b.maxLng + dLng, maxLat: b.maxLat + dLat };
};

const unionBounds = (a: Bounds, b: Bounds): Bounds => ({
  minLng: Math.min(a.minLng, b.minLng),
  minLat: Math.min(a.minLat, b.minLat),
  maxLng: Math.max(a.maxLng, b.maxLng),
  maxLat: Math.max(a.maxLat, b.maxLat),
});

const boundsIntersect = (a: Bounds, b: Bounds) =>
  a.minLng <= b.maxLng && a.maxLng >= b.minLng && a.minLat <= b.maxLat && a.maxLat >= b.minLat;

const boundsContain = (outer: Bounds, inner: Bounds) =>
  inner.minLng >= outer.minLng && inner.maxLng <= outer.maxLng && inner.minLat >= outer.minLat && inner.maxLat <= outer.maxLat;

export function polylineLengthM(coords: readonly (readonly number[])[]): number {
  let len = 0;
  for (let i = 0; i < coords.length - 1; i++) {
    const dx = (coords[i + 1][0] - coords[i][0]) * mPerDegLng(coords[i][1]);
    const dy = (coords[i + 1][1] - coords[i][1]) * M_PER_DEG_LAT;
    len += Math.sqrt(dx * dx + dy * dy);
  }
  return len;
}

/** Horizontal distance (m) from a point to a polyline, and the polyline's height at the closest point. */
function distanceToPolyline(lng: number, lat: number, coords: readonly (readonly number[])[]): { distM: number; z: number } {
  const kx = mPerDegLng(lat);
  let best = { distM: Infinity, z: 0 };
  for (let i = 0; i < coords.length; i++) {
    const a = coords[i];
    const b = coords[Math.min(i + 1, coords.length - 1)];
    const ax = (a[0] - lng) * kx, ay = (a[1] - lat) * M_PER_DEG_LAT;
    const bx = (b[0] - lng) * kx, by = (b[1] - lat) * M_PER_DEG_LAT;
    const dx = bx - ax, dy = by - ay;
    const len2 = dx * dx + dy * dy;
    const t = len2 > 0 ? Math.max(0, Math.min(1, -(ax * dx + ay * dy) / len2)) : 0;
    const px = ax + t * dx, py = ay + t * dy;
    const d = Math.sqrt(px * px + py * py);
    if (d < best.distM) best = { distM: d, z: (a[2] || 0) + t * ((b[2] || 0) - (a[2] || 0)) };
  }
  return best;
}

/** Suggested range for a seed road: 2.5× its length, so parallel routes fall inside the area. */
export function suggestedRangeM(seedLengthM: number): number {
  const r = Math.round((seedLengthM * 2.5) / STUDY_RANGE_STEP_M) * STUDY_RANGE_STEP_M;
  return clampRangeM(Math.max(300, r));
}

export function clampRangeM(meters: number): number {
  return Math.min(STUDY_RANGE_MAX_M, Math.max(STUDY_RANGE_MIN_M, meters));
}

/** An imported OSM road whose ends are where OSM put them. */
function isUneditedOsm(r: DrivableObject | undefined): boolean {
  if (r?.type !== 'road' || !r.osmProvenance || r.sections?.[0]?.provenance.geometryModified) return false;
  const src = r.sourceCoordinates;
  const same = (a?: readonly number[], b?: readonly number[]) => !!a && !!b && a[0] === b[0] && a[1] === b[1];
  return !src || (same(src[0], r.coordinates[0]) && same(src[src.length - 1], r.coordinates[r.coordinates.length - 1]));
}

/** Both travel directions of one stretch of road share this key. */
const segmentKey = (edgeId: string) => edgeId.replace(/_(fwd|bwd)$/, '');

// ─── Graph search ────────────────────────────────────────────────────────────

/**
 * Network distance from the sources, following travel direction (forward) or
 * against it. Nodes beyond `range` are recorded but not expanded further.
 */
function shortestDistances(net: TrafficNetwork, sources: Set<string>, range: number, forward: boolean): Map<string, number> {
  const dist = new Map<string, number>();
  const heap = new MinHeap();
  sources.forEach(s => {
    dist.set(s, 0);
    heap.insert(s, 0);
  });
  while (!heap.isEmpty()) {
    const { nodeId, score } = heap.extractMin()!;
    if (score > (dist.get(nodeId) ?? Infinity) || score >= range) continue;
    const node = net.nodes.get(nodeId);
    if (!node) continue;
    for (const edgeId of forward ? node.outgoingSegments : node.incomingSegments) {
      const edge = net.edges.get(edgeId);
      if (!edge) continue;
      const next = forward ? edge.toNodeId : edge.fromNodeId;
      const d = score + edge.length;
      if (d < (dist.get(next) ?? Infinity)) {
        dist.set(next, d);
        heap.insert(next, d);
      }
    }
  }
  return dist;
}

class UnionFind {
  private parent = new Map<string, string>();
  find(x: string): string {
    let root = x;
    while (this.parent.has(root) && this.parent.get(root) !== root) root = this.parent.get(root)!;
    // Path compression
    let cur = x;
    while (cur !== root) {
      const next = this.parent.get(cur)!;
      this.parent.set(cur, root);
      cur = next;
    }
    if (!this.parent.has(root)) this.parent.set(root, root);
    return root;
  }
  union(a: string, b: string) {
    const ra = this.find(a), rb = this.find(b);
    if (ra !== rb) this.parent.set(ra, rb);
  }
}

// ─── Explorer ────────────────────────────────────────────────────────────────

interface RoadIndex {
  revision: number;
  roads: Map<string, DrivableObject>;
  bounds: Map<string, Bounds>;
}

interface LocalBuild {
  revision: number;
  box: Bounds;
  network: TrafficNetwork;
  gradeSeparations: GradeSeparation[];
  compiledIds: string[];
  /** Node id -> keys of the road stretches meeting there. */
  arms: Map<string, Set<string>>;
  buildMs: number;
  /** Compiled roads overlapping a box (built when first needed). */
  near?: (box: Bounds) => DrivableObject[];
}

const SEVERITY_ORDER: Record<ProblemSeverity, number> = { error: 0, warning: 1, info: 2 };

function nearMissProblem(
  node: TrafficNode,
  roadIds: string[],
  miss: { id: string; distM: number },
  roadName: (id: string) => string
): Omit<StudyProblem, 'distanceM'> {
  return {
    id: `near_miss_${node.id}`,
    kind: 'near_miss',
    severity: 'error',
    title: `"${roadName(roadIds[0])}" stops ${Math.round(miss.distM)} m short of "${roadName(miss.id)}"`,
    detail: 'The two roads do not connect, so no traffic can pass between them. Roads join when their ends are within about 6 m at the same height.',
    location: node.coordinates,
    roadIds: [...roadIds, miss.id],
  };
}

export class StudyAreaExplorer {
  private readonly builder = new TrafficNetworkBuilder();
  private index: RoadIndex | null = null;
  private cachedBuild: LocalBuild | null = null;

  /**
   * Grows a study area from the seed roads. `revision` identifies the state of
   * the road network: compiled graphs are reused until it changes.
   */
  public explore(roads: DrivableObject[], revision: number, options: StudyAreaOptions): StudyArea {
    const index = this.getIndex(roads, revision);
    const seeds = [...new Set(options.seedRoadIds)].filter(id => index.roads.has(id));
    if (seeds.length === 0) {
      throw new Error('The selected road is not part of the active scenario any more.');
    }
    const range = clampRangeM(options.rangeMeters);
    const seedBox = seeds.map(id => index.bounds.get(id)!).reduce(unionBounds);
    const needed = expandBounds(seedBox, range + BUILD_MARGIN_M);

    let build = this.cachedBuild;
    let reusedBuild = !!build && build.revision === revision && boundsContain(build.box, needed);
    if (!reusedBuild) build = this.compile(index, revision, needed);
    let grown = this.grow(build!, seeds, range, options.direction);
    if (!grown) {
      throw new Error('The selected road has no drivable length.');
    }

    // Area edges can run past the compiled box; compile once more so their far
    // ends see every road that meets them (otherwise exits look like dead ends).
    const reach = expandBounds(grown.reachBounds, BUILD_MARGIN_M);
    if (!boundsContain(build!.box, reach)) {
      build = this.compile(index, revision, unionBounds(needed, reach));
      reusedBuild = false;
      grown = this.grow(build, seeds, range, options.direction)!;
    }

    return this.describe(index, build!, grown, { seedRoadIds: seeds, rangeMeters: range, direction: options.direction }, reusedBuild);
  }

  /** The drivable road nearest to a point, within `maxDistM`, or null. */
  public nearestRoad(roads: DrivableObject[], revision: number, lng: number, lat: number, maxDistM: number): string | null {
    const index = this.getIndex(roads, revision);
    const probe = expandBounds({ minLng: lng, minLat: lat, maxLng: lng, maxLat: lat }, maxDistM);
    let bestId: string | null = null;
    let bestDist = maxDistM;
    for (const [id, b] of index.bounds) {
      if (!boundsIntersect(b, probe)) continue;
      const { distM } = distanceToPolyline(lng, lat, index.roads.get(id)!.coordinates);
      if (distM <= bestDist) {
        bestId = id;
        bestDist = distM;
      }
    }
    return bestId;
  }

  private getIndex(roads: DrivableObject[], revision: number): RoadIndex {
    if (this.index && this.index.revision === revision) return this.index;
    const index: RoadIndex = { revision, roads: new Map(), bounds: new Map() };
    for (const r of roads) {
      if (!r.coordinates || r.coordinates.length < 2) continue;
      index.roads.set(r.id, r);
      index.bounds.set(r.id, boundsOf(r.coordinates));
    }
    this.index = index;
    this.cachedBuild = null;
    return index;
  }

  /** Compiles only the roads touching `box` into a traffic graph. */
  private compile(index: RoadIndex, revision: number, box: Bounds): LocalBuild {
    const start = performance.now();
    const compiled: DrivableObject[] = [];
    index.bounds.forEach((b, id) => {
      if (boundsIntersect(b, box)) compiled.push(index.roads.get(id)!);
    });
    // Loose ends join the network (saved roads are not changed): a road the user
    // built joins any road it stops just short of, and an OpenStreetMap road that
    // meets nothing joins a built road there (one that replaced its old link).
    // OSM roads never join each other this way: OSM records which of them meet.
    const built = new Set(compiled.filter(isUserBuilt).map(r => r.id));
    const nearEnds = built.size > 0 ? this.roadsNearEnds(index, compiled) : null;
    const joined = !nearEnds ? compiled : compiled.map(r => {
      const userBuilt = built.has(r.id);
      const near = nearEnds(r);
      if (!userBuilt && !near.some(o => built.has(o.id))) return r;
      const coordinates = connectEnds(r.coordinates, near, r.id, userBuilt ? {} : { canJoin: id => built.has(id), touchingM: JOINS_ALREADY_M });
      return coordinates ? ({ ...r, coordinates } as DrivableObject) : r;
    });
    // Flyovers carry the same fields the builder reads from roads
    const { network, gradeSeparations } = this.builder.build(joined as RoadObject[]);

    const arms = new Map<string, Set<string>>();
    const addArm = (nodeId: string, key: string) => {
      let set = arms.get(nodeId);
      if (!set) arms.set(nodeId, (set = new Set()));
      set.add(key);
    };
    network.edges.forEach(e => {
      const key = segmentKey(e.id);
      addArm(e.fromNodeId, key);
      addArm(e.toNodeId, key);
    });

    const build: LocalBuild = {
      revision,
      box,
      network,
      gradeSeparations,
      compiledIds: compiled.map(r => r.id),
      arms,
      buildMs: performance.now() - start,
    };
    this.cachedBuild = build;
    return build;
  }

  /** For each road, the other roads passing within joining distance of either of its ends. */
  private roadsNearEnds(index: RoadIndex, roads: DrivableObject[]): (r: DrivableObject) => DrivableObject[] {
    const near = roadGrid(index, roads);
    return r => {
      const c = r.coordinates;
      const out = new Set<DrivableObject>();
      for (const end of [c[0], c[c.length - 1]]) {
        for (const o of near(expandBounds({ minLng: end[0], minLat: end[1], maxLng: end[0], maxLat: end[1] }, AUTO_CONNECT_M + 5))) {
          if (o !== r) out.add(o);
        }
      }
      return [...out];
    };
  }

  /** Grows outward from the seeds and decides which road stretches are in the area. */
  private grow(build: LocalBuild, seeds: string[], range: number, direction: StudyDirection) {
    const net = build.network;
    const seedSet = new Set(seeds);
    const sources = new Set<string>();
    net.edges.forEach(e => {
      if (seedSet.has(e.roadId)) {
        sources.add(e.fromNodeId);
        sources.add(e.toNodeId);
      }
    });
    if (sources.size === 0) return null;

    const down = shortestDistances(net, sources, range, true);
    const up = shortestDistances(net, sources, range, false);
    const wantDown = direction !== 'upstream';
    const wantUp = direction !== 'downstream';

    interface Entry { seg: StudySegment; seed: boolean; down: boolean; up: boolean; nodes: [string, string] }
    const included = new Map<string, Entry>();
    // Stretches within range in either direction, whatever is displayed; used for connectivity checks
    const withinRange = new Map<string, { roadId: string; nodes: [string, string] }>();

    net.edges.forEach(e => {
      const key = segmentKey(e.id);
      const isSeed = seedSet.has(e.roadId);
      const dDown = down.get(e.fromNodeId) ?? Infinity;
      const dUp = up.get(e.toNodeId) ?? Infinity;
      if (isSeed || dDown < range || dUp < range) withinRange.set(key, { roadId: e.roadId, nodes: [e.fromNodeId, e.toNodeId] });

      const inDown = wantDown && dDown < range;
      const inUp = wantUp && dUp < range;
      if (!isSeed && !inDown && !inUp) return;

      let entry = included.get(key);
      if (!entry) {
        entry = {
          seg: {
            key,
            roadId: e.roadId,
            coordinates: e.coordinates,
            lengthM: e.length,
            role: 'seed',
            distanceM: Infinity,
          },
          seed: isSeed,
          down: false,
          up: false,
          nodes: [e.fromNodeId, e.toNodeId],
        };
        included.set(key, entry);
      }
      entry.down ||= inDown;
      entry.up ||= inUp;
      const d = isSeed ? 0 : Math.min(inDown ? dDown : Infinity, inUp ? dUp : Infinity);
      entry.seg.distanceM = Math.min(entry.seg.distanceM, d);
    });

    included.forEach(entry => {
      entry.seg.role = entry.seed ? 'seed' : entry.down && entry.up ? 'both' : entry.down ? 'downstream' : 'upstream';
    });

    const nodeDistance = (nodeId: string) =>
      Math.min(wantDown ? down.get(nodeId) ?? Infinity : Infinity, wantUp ? up.get(nodeId) ?? Infinity : Infinity);

    const reachBounds = [...included.values()]
      .map(e => boundsOf(e.seg.coordinates))
      .reduce(unionBounds);

    return { seeds, seedSet, sources, range, wantDown, wantUp, included, withinRange, nodeDistance, reachBounds };
  }

  private describe(
    index: RoadIndex,
    build: LocalBuild,
    grown: NonNullable<ReturnType<StudyAreaExplorer['grow']>>,
    options: StudyAreaOptions,
    reusedBuild: boolean
  ): StudyArea {
    const net = build.network;
    const { included, range } = grown;
    const roadName = (id: string) => index.roads.get(id)?.name || 'Unnamed road';

    // Nodes touched by the area
    const areaNodes = new Set<string>();
    included.forEach(e => {
      areaNodes.add(e.nodes[0]);
      areaNodes.add(e.nodes[1]);
    });

    const junctions: StudyJunction[] = [];
    const boundary: StudyBoundaryPoint[] = [];
    const problems: StudyProblem[] = [];

    areaNodes.forEach(nodeId => {
      const node = net.nodes.get(nodeId);
      if (!node) return;

      // Cordon crossings: stretches that meet the area here but are not in it
      const exit = grown.wantDown && node.outgoingSegments.some(id => !included.has(segmentKey(id)));
      const entry = grown.wantUp && node.incomingSegments.some(id => !included.has(segmentKey(id)));
      if (exit || entry) {
        boundary.push({ nodeId, coordinates: node.coordinates, kind: exit && entry ? 'entry_exit' : exit ? 'exit' : 'entry' });
      }

      const distanceM = grown.nodeDistance(nodeId);
      const arms = build.arms.get(nodeId)?.size ?? 0;
      const roadIds = this.roadsAt(net, node);

      // A road the user built that meets no other road at its end: nothing drives on from there
      if (arms === 1 && !exit && !entry) {
        const open = this.openEnd(index, build, node, roadIds, roadName);
        if (open) {
          problems.push({ ...open, distanceM });
          return;
        }
      }
      if (distanceM >= range) return;

      const roundabout = roadIds.some(id => {
        const r = index.roads.get(id);
        return r?.type === 'road' && !!r.osmProvenance?.roundabout;
      });
      const kind: JunctionKind | null =
        arms === 1 ? 'dead_end'
        : arms < 3 ? null
        : roundabout ? 'roundabout'
        : arms === 3 ? 't_junction'
        : arms === 4 ? 'crossroads'
        : 'complex';
      if (kind) junctions.push({ nodeId, coordinates: node.coordinates, kind, arms, distanceM });

      const problem = this.nodeProblem(index, build, node, arms, roadIds, roadName);
      if (problem) problems.push({ ...problem, distanceM });
    });

    // Two road ends facing each other across one gap are one problem, not two
    const seenGaps = new Set(problems.filter(p => p.kind === 'near_miss').map(p => [...p.roadIds].sort().join('|')));
    problems.push(...this.isolatedProblems(index, build, grown, roadName).filter(p =>
      p.kind !== 'near_miss' || !seenGaps.has([...p.roadIds].sort().join('|'))
    ));
    problems.push(...this.duplicateProblems(index, build, new Set([...included.values()].map(e => e.seg.roadId)), roadName));
    const noAlternative = this.noAlternativeProblem(index, net, grown);
    if (noAlternative) problems.push(noAlternative);
    problems.sort((a, b) => SEVERITY_ORDER[a.severity] - SEVERITY_ORDER[b.severity] || a.distanceM - b.distanceM);

    const segments = [...included.values()].map(e => e.seg).sort((a, b) => a.distanceM - b.distanceM);
    const areaRoadIds = new Set(segments.map(s => s.roadId));
    const bounds = grown.reachBounds;
    const gradeSeparations = build.gradeSeparations.filter(g =>
      (areaRoadIds.has(g.roadIds[0]) || areaRoadIds.has(g.roadIds[1])) &&
      boundsContain(bounds, { minLng: g.coordinates[0], maxLng: g.coordinates[0], minLat: g.coordinates[1], maxLat: g.coordinates[1] })
    );

    return {
      ...options,
      segments,
      junctions,
      boundary,
      gradeSeparations,
      problems,
      bounds,
      network: net,
      stats: {
        roads: areaRoadIds.size,
        segments: segments.length,
        junctions: junctions.filter(j => j.kind !== 'dead_end').length,
        lengthKm: segments.reduce((sum, s) => sum + s.lengthM, 0) / 1000,
        entries: boundary.filter(b => b.kind !== 'exit').length,
        exits: boundary.filter(b => b.kind !== 'entry').length,
        compiledRoads: build.compiledIds.length,
        totalRoads: index.roads.size,
        buildMs: Math.round(build.buildMs),
        reusedBuild,
      },
    };
  }

  private roadsAt(net: TrafficNetwork, node: TrafficNode): string[] {
    const ids = new Set<string>();
    for (const id of [...node.incomingSegments, ...node.outgoingSegments]) {
      const e = net.edges.get(id);
      if (e) ids.add(e.roadId);
    }
    return [...ids];
  }

  /** Near misses, one-way traps and dead ends at one junction. */
  private nodeProblem(
    index: RoadIndex,
    build: LocalBuild,
    node: TrafficNode,
    arms: number,
    roadIds: string[],
    roadName: (id: string) => string
  ): Omit<StudyProblem, 'distanceM'> | null {
    const here = roadName(roadIds[0]);
    const base = { location: node.coordinates, roadIds };

    if (arms === 1) {
      const miss = this.findNearMiss(index, build, node, new Set(roadIds));
      if (miss) return nearMissProblem(node, roadIds, miss, roadName);
    }
    if (node.incomingSegments.length > 0 && node.outgoingSegments.length === 0) {
      return {
        ...base,
        id: `trap_${node.id}`,
        kind: 'one_way_trap',
        severity: 'warning',
        title: `One-way trap on "${here}"`,
        detail: 'Every road here points in and none leads out, so vehicles that arrive can never leave. Check the one-way directions.',
      };
    }
    if (node.outgoingSegments.length > 0 && node.incomingSegments.length === 0) {
      return {
        ...base,
        id: `source_${node.id}`,
        kind: 'one_way_source',
        severity: 'warning',
        title: `No way in at "${here}"`,
        detail: 'Every road here points away, so no vehicle can ever arrive. Check the one-way directions.',
      };
    }
    if (arms === 1) {
      return {
        ...base,
        id: `dead_end_${node.id}`,
        kind: 'dead_end',
        severity: 'info',
        title: `Dead end on "${here}"`,
        detail: 'The road stops here. That is fine for a cul-de-sac; otherwise extend it to meet another road.',
      };
    }
    return null;
  }

  /**
   * The end of a road the user built that meets nothing: no road within
   * reach to join. No traffic is invented there; the user is told that the
   * road leads nowhere yet.
   */
  private openEnd(
    index: RoadIndex,
    build: LocalBuild,
    node: TrafficNode,
    roadIds: string[],
    roadName: (id: string) => string,
  ): Omit<StudyProblem, 'distanceM'> | null {
    const road = index.roads.get(roadIds[0]);
    if (roadIds.length !== 1 || !road || !isUserBuilt(road)) return null;
    if (this.findNearMiss(index, build, node, new Set(roadIds))) return null;
    return {
      id: `open_end_${node.id}`,
      kind: 'open_end',
      severity: 'warning',
      title: `"${roadName(road.id)}" leads nowhere at this end`,
      detail: 'No mapped road continues from this end, so no traffic can use it to go anywhere. Extend it to the road it should meet in Build.',
      location: node.coordinates,
      roadIds,
    };
  }

  /**
   * Roads the user built that run along mapped (OSM) roads for nearly all
   * their length: usually drawn by hand while the real road was not loaded.
   * Traffic takes the mapped road, so the copy only clutters the map.
   */
  private duplicateProblems(index: RoadIndex, build: LocalBuild, areaRoadIds: Set<string>, roadName: (id: string) => string): StudyProblem[] {
    const out: StudyProblem[] = [];
    const allMapped = build.compiledIds.map(cid => index.roads.get(cid)!).filter(o => o && !isUserBuilt(o));
    if (allMapped.length === 0) return out;
    for (const id of areaRoadIds) {
      const road = index.roads.get(id);
      if (!road || !isUserBuilt(road)) continue;
      const probe = expandBounds(index.bounds.get(id)!, DUPLICATE_M);
      const mapped = allMapped.filter(o => boundsIntersect(index.bounds.get(o.id)!, probe));
      if (mapped.length === 0) continue;

      // Points every 20 m along the road, and the mapped road nearest each
      const samples: number[][] = [];
      let length = 0;
      const c = road.coordinates;
      for (let i = 1; i < c.length; i++) {
        const seg = Math.hypot((c[i][0] - c[i - 1][0]) * mPerDegLng(c[i][1]), (c[i][1] - c[i - 1][1]) * M_PER_DEG_LAT);
        length += seg;
        const n = Math.max(1, Math.round(seg / 20));
        for (let k = 0; k < n; k++) {
          const t = k / n;
          samples.push([c[i - 1][0] + t * (c[i][0] - c[i - 1][0]), c[i - 1][1] + t * (c[i][1] - c[i - 1][1]), (c[i - 1][2] || 0) + t * ((c[i][2] || 0) - (c[i - 1][2] || 0))]);
        }
      }
      if (length < DUPLICATE_MIN_LENGTH_M) continue;
      const near = new Map<string, number>();
      let covered = 0;
      for (const [lng, lat, z] of samples) {
        let best: { id: string; distM: number } | null = null;
        for (const o of mapped) {
          const hit = distanceToPolyline(lng, lat, o.coordinates);
          if (Math.abs(hit.z - z) > GRADE_SEPARATION_M) continue;
          if (hit.distM <= DUPLICATE_M && (!best || hit.distM < best.distM)) best = { id: o.id, distM: hit.distM };
        }
        if (best) {
          covered++;
          near.set(best.id, (near.get(best.id) ?? 0) + 1);
        }
      }
      if (covered < samples.length * DUPLICATE_SHARE) continue;
      const along = [...near.entries()].sort((a, b) => b[1] - a[1])[0][0];
      out.push({
        id: `duplicate_${id}`,
        kind: 'duplicate',
        severity: 'warning',
        title: `"${roadName(id)}" runs along "${roadName(along)}"`,
        detail: `Most of it lies within ${DUPLICATE_M} m of roads already on the map, so it is probably a copy drawn before those roads were loaded. Traffic uses the mapped road; delete this one in Build if it is the same road.`,
        location: c[Math.floor(c.length / 2)] as [number, number, number],
        roadIds: [id, along],
        distanceM: 0,
      });
    }
    return out;
  }

  private findNearMiss(index: RoadIndex, build: LocalBuild, node: TrafficNode, exclude: Set<string>): { id: string; distM: number } | null {
    const [lng, lat, z] = node.coordinates;
    const probe = expandBounds({ minLng: lng, minLat: lat, maxLng: lng, maxLat: lat }, NEAR_MISS_M);
    // OSM records which ways join, so two unedited OSM roads that stop short of each other really do
    const fromOsm = [...exclude].every(id => isUneditedOsm(index.roads.get(id)));
    let best: { id: string; distM: number } | null = null;
    build.near ??= roadGrid(index, build.compiledIds.map(id => index.roads.get(id)!));
    for (const road of build.near(probe)) {
      const id = road.id;
      if (exclude.has(id)) continue;
      if (fromOsm && isUneditedOsm(road)) continue;
      const hit = distanceToPolyline(lng, lat, road.coordinates);
      if (Math.abs(hit.z - (z || 0)) > GRADE_SEPARATION_M) continue;
      if (hit.distM < NEAR_MISS_M && (!best || hit.distM < best.distM)) best = { id, distM: hit.distM };
    }
    return best;
  }

  /** Road pieces lying within range of the seeds that have no road link to them. */
  private isolatedProblems(
    index: RoadIndex,
    build: LocalBuild,
    grown: NonNullable<ReturnType<StudyAreaExplorer['grow']>>,
    roadName: (id: string) => string
  ): StudyProblem[] {
    const net = build.network;
    const uf = new UnionFind();
    net.edges.forEach(e => uf.union(e.fromNodeId, e.toNodeId));
    const seedRoots = new Set([...grown.sources].map(id => uf.find(id)));

    const components = new Map<string, { nodes: Set<string>; roadIds: Set<string> }>();
    net.edges.forEach((e: TrafficEdge) => {
      const root = uf.find(e.fromNodeId);
      if (seedRoots.has(root)) return;
      let comp = components.get(root);
      if (!comp) components.set(root, (comp = { nodes: new Set(), roadIds: new Set() }));
      comp.nodes.add(e.fromNodeId);
      comp.nodes.add(e.toNodeId);
      comp.roadIds.add(e.roadId);
    });

    const seedCoords = grown.seeds.map(id => index.roads.get(id)!.coordinates);
    const problems: StudyProblem[] = [];
    components.forEach((comp, root) => {
      let nearDist = Infinity;
      let nearCoords: [number, number, number] | null = null;
      for (const nodeId of comp.nodes) {
        const c = net.nodes.get(nodeId)!.coordinates;
        for (const seed of seedCoords) {
          const { distM } = distanceToPolyline(c[0], c[1], seed);
          if (distM < nearDist) {
            nearDist = distM;
            nearCoords = c;
          }
        }
      }
      if (!nearCoords || nearDist > grown.range) return;

      const roadIds = [...comp.roadIds];

      // Usually the piece is cut off by a road end that just misses another road
      for (const nodeId of comp.nodes) {
        if (build.arms.get(nodeId)?.size !== 1) continue;
        const node = net.nodes.get(nodeId)!;
        const miss = this.findNearMiss(index, build, node, comp.roadIds);
        if (!miss) continue;
        const own = this.roadsAt(net, node);
        problems.push({
          ...nearMissProblem(node, own, miss, roadName),
          distanceM: nearDist,
        });
        return;
      }

      const elevated = roadIds.find(id => index.roads.get(id)?.type !== 'road');
      const first = roadName(elevated ?? roadIds[0]);
      problems.push({
        id: `isolated_${root}`,
        kind: 'isolated',
        severity: 'warning',
        title: elevated ? `"${first}" is not connected` : `${roadIds.length} road${roadIds.length > 1 ? 's' : ''} not connected to the study area`,
        detail: elevated
          ? 'This elevated road has no ramp joining the rest of the area within range, so no traffic can use it.'
          : `"${first}"${roadIds.length > 1 ? ` and ${roadIds.length - 1} more` : ''} lie within range but have no road link to the selected road inside it.`,
        location: nearCoords,
        roadIds,
        distanceM: nearDist,
      });
    });
    return problems;
  }

  /**
   * Whether traffic crossing the area has to use the seed roads. For every
   * place where traffic enters the area, the exits it can reach are compared
   * with and without the seed roads, following one-way directions. Only when
   * some entry-exit pair loses its last route is there no alternative; a side
   * street served only by the seed road does not count, since no traffic
   * passes through it.
   */
  private noAlternativeProblem(index: RoadIndex, net: TrafficNetwork, grown: NonNullable<ReturnType<StudyAreaExplorer['grow']>>): StudyProblem | null {
    const inRange = (edgeId: string) => grown.withinRange.has(segmentKey(edgeId));
    const nodes = new Set<string>();
    grown.withinRange.forEach(({ nodes: [a, b] }) => {
      nodes.add(a);
      nodes.add(b);
    });

    // Edge crossings away from the seed roads (traffic entering on a seed road has no choice to make)
    const entries: string[] = [];
    const exits = new Set<string>();
    nodes.forEach(id => {
      const node = net.nodes.get(id);
      if (!node || grown.sources.has(id)) return;
      if (node.incomingSegments.some(e => !inRange(e))) entries.push(id);
      if (node.outgoingSegments.some(e => !inRange(e))) exits.add(id);
    });

    let pairs = 0;
    let dependent = 0;
    if (entries.length > 0 && exits.size > 0) {
      // Numbered copy of the in-range graph: reachability is then plain array work
      const nodeIdx = new Map<string, number>();
      nodes.forEach(id => nodeIdx.set(id, nodeIdx.size));
      const outStart = new Int32Array(nodeIdx.size + 1);
      const targets: number[] = [];
      const viaSeed: number[] = [];
      nodeIdx.forEach((i, id) => {
        outStart[i] = targets.length;
        for (const edgeId of net.nodes.get(id)?.outgoingSegments ?? []) {
          const e = net.edges.get(edgeId);
          const to = e && inRange(edgeId) ? nodeIdx.get(e.toNodeId) : undefined;
          if (to === undefined) continue;
          targets.push(to);
          viaSeed.push(grown.seedSet.has(e!.roadId) ? 1 : 0);
        }
      });
      outStart[nodeIdx.size] = targets.length;
      const seen = new Int32Array(nodeIdx.size);
      let stamp = 0;
      const stack = new Int32Array(nodeIdx.size);
      const reach = (from: number, useSeeds: boolean) => {
        stamp++;
        let top = 0;
        stack[top++] = from;
        seen[from] = stamp;
        while (top > 0) {
          const n = stack[--top];
          for (let k = outStart[n]; k < outStart[n + 1]; k++) {
            const t = targets[k];
            if (seen[t] === stamp || (!useSeeds && viaSeed[k])) continue;
            seen[t] = stamp;
            stack[top++] = t;
          }
        }
        return stamp;
      };
      const exitIdx = [...exits].map(id => nodeIdx.get(id)!);
      for (const entry of entries) {
        const from = nodeIdx.get(entry)!;
        const withSeeds = new Uint8Array(exitIdx.length);
        const s1 = reach(from, true);
        exitIdx.forEach((x, k) => (withSeeds[k] = seen[x] === s1 ? 1 : 0));
        const s2 = reach(from, false);
        exitIdx.forEach((x, k) => {
          if (x === from || !withSeeds[k]) return;
          pairs++;
          if (seen[x] !== s2) dependent++;
        });
      }
      if (dependent === 0) return null;
    } else if (!this.splitsWithoutSeeds(grown)) {
      // Nothing leads in or out, so judge by shape alone: does the area fall apart without the seeds?
      return null;
    }

    const seed = index.roads.get(grown.seeds[0])!;
    const mid = seed.coordinates[Math.floor(seed.coordinates.length / 2)];
    return {
      id: 'no_alternative',
      kind: 'no_alternative',
      severity: 'warning',
      title: 'No alternative route within range',
      detail: pairs > 0
        ? `For ${dependent} of the ${pairs} entry-to-exit routes across the area, the selected road is the only way through. That traffic has no parallel route to move to, so changes to this road cannot show it redistributing. Increase the range.`
        : 'Without the selected road the area splits in two, so traffic has no parallel route to move to. Changes to this road cannot show traffic redistributing. Increase the range.',
      location: [mid[0], mid[1], mid[2] || 0],
      roadIds: grown.seeds,
      distanceM: 0,
    };
  }

  /** Whether the roads within range fall into separate pieces without the seed roads. */
  private splitsWithoutSeeds(grown: NonNullable<ReturnType<StudyAreaExplorer['grow']>>): boolean {
    const others: [string, string][] = [];
    grown.withinRange.forEach(({ roadId, nodes }) => {
      if (!grown.seedSet.has(roadId)) others.push(nodes);
    });

    const attachments = new Set<string>();
    for (const [a, b] of others) {
      if (grown.sources.has(a)) attachments.add(a);
      if (grown.sources.has(b)) attachments.add(b);
    }
    if (attachments.size < 2) return false;

    const uf = new UnionFind();
    for (const [a, b] of others) uf.union(a, b);
    return new Set([...attachments].map(n => uf.find(n))).size > 1;
  }
}

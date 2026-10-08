import type { CityObject, CityObjectType, JunctionObject, RoadObject, FlyoverObject, MetroFlyoverObject } from '../../objects/types';

type Drivable = RoadObject | FlyoverObject | MetroFlyoverObject;
/** Cell size for finding roads that pass through an area (degrees, about 110 m). */
const SEGMENT_CELL_DEG = 0.001;

/** Grid cell size in degrees (~55 m) for point lookups. Queries scan the 3×3 neighbourhood. */
const CELL_DEG = 0.0005;

const cellKey = (lon: number, lat: number) => `${Math.floor(lon / CELL_DEG)}:${Math.floor(lat / CELL_DEG)}`;

function neighbourhood<T>(buckets: Map<string, T[]>, lon: number, lat: number): T[] {
  const cx = Math.floor(lon / CELL_DEG);
  const cy = Math.floor(lat / CELL_DEG);
  const out: T[] = [];
  for (let dx = -1; dx <= 1; dx++) {
    for (let dy = -1; dy <= 1; dy++) {
      const bucket = buckets.get(`${cx + dx}:${cy + dy}`);
      if (bucket) out.push(...bucket);
    }
  }
  return out;
}

/**
 * Read-only lookup structures over the scene, built once per reconcile and
 * shared by every mesh generated in it. Replaces per-object scans of all
 * ~7,400 objects (3,512 roads × 7,400 ≈ 26M iterations at startup).
 *
 * Indexes are built lazily on first use. Nearest-neighbour helpers only return
 * candidates from nearby cells; callers still apply their exact distance test,
 * which must be tighter than one cell (≈55 m).
 */
export class GeometryContext {
  readonly all: ReadonlyMap<string, CityObject>;
  private byType = new Map<CityObjectType, CityObject[]>();
  private junctionBuckets: Map<string, JunctionObject[]> | null = null;
  private roadEndpointBuckets: Map<string, RoadObject[]> | null = null;
  private segmentBuckets: Map<string, Drivable[]> | null = null;

  constructor(all: ReadonlyMap<string, CityObject>) {
    this.all = all;
  }

  ofType<T extends CityObject = CityObject>(type: CityObjectType): T[] {
    let list = this.byType.get(type);
    if (!list) {
      list = [];
      for (const o of this.all.values()) if (o.type === type) list.push(o);
      this.byType.set(type, list);
    }
    return list as T[];
  }

  /** Junctions whose centre lies within about one grid cell of the point. */
  junctionsNear(lon: number, lat: number): JunctionObject[] {
    if (!this.junctionBuckets) {
      this.junctionBuckets = new Map();
      for (const j of this.ofType<JunctionObject>('junction')) {
        const key = cellKey(j.coordinates[0], j.coordinates[1]);
        const bucket = this.junctionBuckets.get(key);
        if (bucket) bucket.push(j);
        else this.junctionBuckets.set(key, [j]);
      }
    }
    return neighbourhood(this.junctionBuckets, lon, lat);
  }

  /** Roads with a start or end point within about one grid cell of the point (deduplicated). */
  roadsWithEndpointNear(lon: number, lat: number): RoadObject[] {
    if (!this.roadEndpointBuckets) {
      this.roadEndpointBuckets = new Map();
      for (const r of this.ofType<RoadObject>('road')) {
        const c = r.coordinates;
        if (!c || c.length === 0) continue;
        const keys = new Set([cellKey(c[0][0], c[0][1]), cellKey(c[c.length - 1][0], c[c.length - 1][1])]);
        for (const key of keys) {
          const bucket = this.roadEndpointBuckets.get(key);
          if (bucket) bucket.push(r);
          else this.roadEndpointBuckets.set(key, [r]);
        }
      }
    }
    return Array.from(new Set(neighbourhood(this.roadEndpointBuckets, lon, lat)));
  }

  /** Roads, flyovers and metro flyovers with a piece passing through the box (deduplicated). */
  drivablesNear(minLng: number, minLat: number, maxLng: number, maxLat: number): Drivable[] {
    if (!this.segmentBuckets) {
      this.segmentBuckets = new Map();
      const cell = (v: number) => Math.floor(v / SEGMENT_CELL_DEG);
      for (const type of ['road', 'flyover', 'metro_flyover'] as const) {
        for (const r of this.ofType<Drivable>(type)) {
          const c = r.coordinates;
          if (!c || c.length < 2) continue;
          const keys = new Set<string>();
          for (let i = 1; i < c.length; i++) {
            for (let x = cell(Math.min(c[i - 1][0], c[i][0])); x <= cell(Math.max(c[i - 1][0], c[i][0])); x++) {
              for (let y = cell(Math.min(c[i - 1][1], c[i][1])); y <= cell(Math.max(c[i - 1][1], c[i][1])); y++) keys.add(x + ':' + y);
            }
          }
          for (const key of keys) {
            const bucket = this.segmentBuckets.get(key);
            if (bucket) bucket.push(r);
            else this.segmentBuckets.set(key, [r]);
          }
        }
      }
    }
    const out = new Set<Drivable>();
    const cell = (v: number) => Math.floor(v / SEGMENT_CELL_DEG);
    for (let x = cell(minLng); x <= cell(maxLng); x++) {
      for (let y = cell(minLat); y <= cell(maxLat); y++) {
        for (const r of this.segmentBuckets.get(x + ':' + y) ?? []) out.add(r);
      }
    }
    return [...out];
  }
}

/**
 * Whole-network edit isolation harness (docs/OVERHAUL.md §27). Loads a project database export the way the app
 * does at start-up (TwinCityEngine: every road through syncRoadProperties, then liftBridges), applies Build edits
 * through the same functions the UI calls (deleteWithHistory, commitRoadFieldEdit, EditingEngine.connectRoadEnd /
 * finalizeDrawing, flyoverFieldUpdates + recordUpdate) and checks, for every object of the network, what changed.
 *
 * Objects are compared by reference first (the store replaces an object whenever it changes it), then by a
 * canonical serialisation (keys sorted, `updatedAt` left out: every store write stamps it, also on undo) of the
 * ones whose reference changed. The initial objects are deep-frozen, so an edit that changed one in place would
 * throw instead of slipping past the reference compare.
 */
import { ObjectManager } from '../objects/ObjectManager';
import { HistoryManager } from '../history/HistoryManager';
import type { CityObject, RoadObject } from '../objects/types';
import { networkContentKey } from '../simulation/StudyDemand';
import { elevatedLayer, depressedLevel, isOsmBridge } from '../objects/bridgeElevation';
import { roadKeys } from '../simulation/roadSection';
import { isDrivable } from '../simulation/StudyAreaExplorer';

export interface DbRow { id: string; type: string; name: string; layerId: string; scenarioId: string; coordinates: any; properties: Record<string, any> }

/** Unpacks database rows into road objects exactly as TwinCityEngine's start-up load does. */
export function unpackRows(rows: readonly DbRow[], om: ObjectManager): CityObject[] {
  return rows.filter(o => o.type === 'road').map(o => {
    const u: any = { id: o.id, type: o.type, name: o.name, layerId: o.layerId, scenarioId: o.scenarioId, coordinates: structuredClone(o.coordinates), createdAt: '2026-11-09T00:00:00.000Z', updatedAt: '2026-11-09T00:00:00.000Z', ...structuredClone(o.properties) };
    om.syncRoadProperties(u);
    return u;
  });
}

/** An ObjectManager loaded as the app loads the database (no backend writes), and its history. */
export function loadNetwork(rows: readonly DbRow[], freeze = true) {
  const om = new ObjectManager();
  const noop = async () => {};
  Object.assign(om, { syncPost: noop, syncPostMultiple: noop, syncDelete: noop, syncDeleteMultiple: noop });
  (om as any).deletedOsm = new Set<string>();
  const map = (om as any).objects as Map<string, CityObject>;
  for (const u of unpackRows(rows, om)) map.set(u.id, u);
  om.liftBridges();
  if (freeze) for (const o of om.getAll()) deepFreeze(o);
  const history = new HistoryManager(om);
  return { om, history };
}

export function deepFreeze<T>(o: T): T {
  if (o && typeof o === 'object' && !Object.isFrozen(o)) {
    Object.freeze(o);
    for (const v of Object.values(o as object)) deepFreeze(v);
  }
  return o;
}

export type Snap = Map<string, CityObject>;
export const snap = (om: ObjectManager): Snap => new Map(om.getAll().map(o => [o.id, o]));
export const roadsOf = (om: ObjectManager) => om.getAll().filter((o): o is RoadObject => o.type === 'road');
/** The network key Simulate uses (SimulationMode: every drivable object, flyovers included; no junction edits, no signals here). */
export const keyOf = (om: ObjectManager) => networkContentKey(om.getAll().filter(isDrivable), [], []);

/** Keys sorted at every level, `updatedAt` left out. */
export function canon(o: unknown): string {
  return JSON.stringify(o, function (this: any, k, v) {
    if (k === 'updatedAt' && this && typeof this === 'object' && 'type' in this) return undefined;
    if (v && typeof v === 'object' && !Array.isArray(v)) return Object.fromEntries(Object.keys(v).sort().map(x => [x, v[x]]));
    return v;
  });
}

/** Ids whose content differs between two snapshots (added, removed or changed). */
export function contentChanged(a: Snap, b: Snap): string[] {
  const out: string[] = [];
  for (const [id, o] of a) {
    const p = b.get(id);
    if (!p) { out.push(id); continue; }
    if (p !== o && canon(p) !== canon(o)) out.push(id);
  }
  for (const id of b.keys()) if (!a.has(id)) out.push(id);
  return out.sort();
}

/** Top-level fields that differ between two versions of an object (updatedAt left out). */
export function fieldsChanged(a: CityObject | undefined, b: CityObject | undefined): string[] {
  if (!a || !b) return ['(presence)'];
  const ks = new Set([...Object.keys(a), ...Object.keys(b)]);
  ks.delete('updatedAt');
  return [...ks].filter(k => canon((a as any)[k]) !== canon((b as any)[k])).sort();
}

/** Whether every plan point of `a` is in `b`, in order. */
function planPointsKept(a: RoadObject, b: RoadObject): boolean {
  let j = 0;
  for (const p of a.coordinates) {
    while (j < b.coordinates.length && (b.coordinates[j][0] !== p[0] || b.coordinates[j][1] !== p[1])) j++;
    if (j === b.coordinates.length) return false;
    j++;
  }
  return true;
}

/**
 * Whether `b` differs from `a` only in heights, with points inserted by densifying a ramp or the points such
 * densifying had inserted taken out again (a ramp that no longer climbs to a deleted bridge or underpass goes back to
 * its stored points, as a fresh load gives; the delete check also compares with a fresh load), sections remapped.
 */
export function onlyHeightsChanged(a: RoadObject, b: RoadObject): boolean {
  const f = fieldsChanged(a, b).filter(x => x !== 'coordinates' && x !== 'sections');
  if (f.length) return false;
  // Every plan point of the one with fewer points is in the other, in order
  if (!(b.coordinates.length >= a.coordinates.length ? planPointsKept(a, b) : planPointsKept(b, a))) return false;
  // Sections differ only in their vertex ranges
  const strip = (r: RoadObject) => canon((r.sections ?? []).map(s => ({ ...s, startNodeIndex: 0, endNodeIndex: 0 })));
  return strip(a) === strip(b);
}

/** Seeded random numbers (repeatable samples). */
export function rng(seed: number) {
  let s = seed >>> 0;
  return () => (s = (Math.imul(s, 1103515245) + 12345) >>> 0) / 4294967296;
}

const M = 111320;
export const distM = (a: readonly number[], b: readonly number[]) => Math.hypot((b[0] - a[0]) * M * Math.cos(a[1] * Math.PI / 180), (b[1] - a[1]) * M);
export const lengthM = (c: readonly (readonly number[])[]) => { let n = 0; for (let i = 1; i < c.length; i++) n += distM(c[i - 1], c[i]); return n; };
export const vkey = (p: readonly number[]) => `${p[0].toFixed(7)},${p[1].toFixed(7)}`;

/** Kinds of road the samples are stratified by. */
export type Stratum = 'bridge' | 'underpass' | 'approach' | 'slip' | 'dual' | 'oneway-local' | 'twoway-main' | 'twoway-local' | 'unnamed';
export const STRATA: Stratum[] = ['bridge', 'underpass', 'approach', 'slip', 'dual', 'oneway-local', 'twoway-main', 'twoway-local', 'unnamed'];
const RANK: Record<string, number> = { highway: 4, arterial: 3, collector: 2, local: 1 };

export function stratumOf(r: RoadObject): Stratum {
  if (isOsmBridge(r.osmProvenance)) return 'bridge';
  if (depressedLevel(r) > 0) return 'underpass';
  if (r.coordinates.some(p => Math.abs(p[2] || 0) > 0.01)) return 'approach';
  if (/_link$/.test(r.osmProvenance?.originalTags?.highway ?? '')) return 'slip';
  if (roadKeys(r).size === 0) return 'unnamed';
  const main = (RANK[r.roadClass] ?? 1) >= 2;
  if (r.isOneWay) return main ? 'dual' : 'oneway-local';
  return main ? 'twoway-main' : 'twoway-local';
}

/** `n` road ids, as evenly as the strata allow (round robin over strata, random within each), seeded. */
export function stratifiedSample(roads: readonly RoadObject[], n: number, seed: number, filter: (r: RoadObject) => boolean = () => true): { id: string; stratum: Stratum }[] {
  const rand = rng(seed);
  const by = new Map<Stratum, string[]>(STRATA.map(s => [s, []]));
  for (const r of [...roads].sort((a, b) => (a.id < b.id ? -1 : 1))) if (r.coordinates.length >= 2 && filter(r)) by.get(stratumOf(r))!.push(r.id);
  for (const l of by.values()) for (let i = l.length - 1; i > 0; i--) { const j = Math.floor(rand() * (i + 1)); [l[i], l[j]] = [l[j], l[i]]; }
  const out: { id: string; stratum: Stratum }[] = [];
  const pos = new Map<Stratum, number>(STRATA.map(s => [s, 0]));
  while (out.length < n) {
    let any = false;
    for (const s of STRATA) {
      const l = by.get(s)!, i = pos.get(s)!;
      if (i < l.length && out.length < n) { out.push({ id: l[i], stratum: s }); pos.set(s, i + 1); any = true; }
    }
    if (!any) break;
  }
  return out;
}

/** Spatial index of roads by ~200 m cell, for nearby-road lookups. */
export function roadGrid(roads: readonly CityObject[], cellDeg = 0.002) {
  const cells = new Map<string, CityObject[]>();
  const c = (x: number) => Math.floor(x / cellDeg);
  for (const r of roads) {
    const seen = new Set<string>();
    for (const p of r.coordinates as number[][]) { const k = `${c(p[0])},${c(p[1])}`; if (!seen.has(k)) { seen.add(k); (cells.get(k) ?? cells.set(k, []).get(k)!).push(r); } }
  }
  return {
    near(points: readonly (readonly number[])[], ring = 1): CityObject[] {
      const out = new Set<CityObject>();
      for (const p of points) for (let dx = -ring; dx <= ring; dx++) for (let dy = -ring; dy <= ring; dy++) for (const r of cells.get(`${c(p[0]) + dx},${c(p[1]) + dy}`) ?? []) out.add(r);
      return [...out];
    },
  };
}

/**
 * The roads whose heights a deletion may change (docs/OVERHAUL.md §21: heights round what went are worked out
 * again): OSM roads joined to the deleted road through a chain of shared points, each link of the chain a
 * structure (bridge or cut) or a ground road within ramp reach (3 layers x 6.5 m at 5% = 390 m) of the deleted
 * road. Returns a predicate for "this changed road is a documented neighbour".
 */
export const RAMP_REACH_M = (3 * 6.5) / 0.05;
export function documentedNeighbours(deleted: RoadObject, before: Snap, changed: readonly string[]): Set<string> {
  const pool = new Set(changed.filter(id => id !== deleted.id));
  const ok = new Set<string>();
  const frontier = [deleted];
  const keysOf = (r: RoadObject) => new Set(r.coordinates.map(vkey));
  const near = (r: RoadObject) => r.coordinates.some(p => deleted.coordinates.some(q => distM(p, q) <= RAMP_REACH_M));
  while (frontier.length) {
    const cur = frontier.pop()!;
    const ks = keysOf(cur);
    for (const id of [...pool]) {
      const r = before.get(id) as RoadObject | undefined;
      if (!r || r.type !== 'road' || !r.osmProvenance) continue;
      if (!r.coordinates.some(p => ks.has(vkey(p)))) continue;
      if (!(elevatedLayer(r) > 0 || depressedLevel(r) > 0 || near(r))) continue;
      pool.delete(id); ok.add(id); frontier.push(r);
    }
  }
  return ok;
}

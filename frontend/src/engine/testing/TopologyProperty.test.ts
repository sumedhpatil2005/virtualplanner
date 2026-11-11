import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest';
import fs from 'fs';
import path from 'path';
import { EditingEngine } from '../editing/EditingEngine';
import type { ObjectManager } from '../objects/ObjectManager';
import { deleteWithHistory, type HistoryManager } from '../history/HistoryManager';
import { TrafficNetworkBuilder } from '../simulation/TrafficNetworkBuilder';
import { Pathfinder } from '../simulation/Pathfinder';
import type { CityObject, RoadObject } from '../objects/types';
import type { TrafficNetwork } from '../objects/trafficTypes';
import { isOsmBridge, isOsmTunnel } from '../objects/bridgeElevation';
import { contentChanged, fieldsChanged, keyOf, loadNetwork, rng, roadGrid, snap, vkey, distM, type DbRow, type Snap } from './editHarness';

/**
 * Network topology property test (docs/TOPOLOGY_RECONSTRUCTION.md).
 *
 * For random locations across the whole network (VP_OBJECTS = export of the project database; without it the
 * Sangamwadi OSM fixture), a synthetic road is drawn through the code the Build tools run (EditingEngine.addDrawingPoint /
 * finalizeDrawing, deleteWithHistory) for each connection case, and the mission §4 acceptance criteria are checked on
 * the objects and on the traffic network the simulation builds (TrafficNetworkBuilder, Pathfinder):
 *  - no zero-length segment in any added or changed road;
 *  - only the new road and the roads it joins (one vertex inserted where it meets them, nothing else) change;
 *  - an end within 0.5 m of a road at the same level (≤ 3 m apart vertically) shares a graph node with it;
 *  - a crossing is classified from OSM tags and heights, independently of the implementation:
 *      heights > 3 m apart → separate (flyover, tunnel); tags or heights say "not on the ground" but heights are within
 *      3 m (bridge/tunnel/layer≠0/embankment/cutting tag, a drawn flyover, a ramp > 0.5 m off the ground) → uncertain: must NOT be joined
 *      and must be flagged for confirmation; otherwise (both on the ground, untagged) → junction: must share a node;
 *  - no new node within 1 m (and 3 m vertically) of another node: no duplicate junctions;
 *  - routing: from the new road's other end there is a route onto every road it joins;
 *  - undo gives the exact objects and network key back, redo the exact edited state.
 *
 * VP_N samples per case (default 200 on a database, 20 on the fixture); VP_CASES = comma list; VP_REPORT = directory
 * for <case>.json; VP_SEED.
 */

const DB = process.env.VP_OBJECTS;
const fixtureRows = (): DbRow[] => {
  const fx = JSON.parse(fs.readFileSync(path.join(__dirname, 'fixtures/sangamwadi.json'), 'utf8')) as { roads: any[] };
  return fx.roads.filter(r => r.type === 'road').map(({ id, type, name, layerId, scenarioId, coordinates, ...properties }) => ({ id, type, name, layerId, scenarioId, coordinates, properties }));
};
const N = Number(process.env.VP_N ?? (DB ? 200 : 20));
const SEED = Number(process.env.VP_SEED ?? 4242);
const ALL = ['end-mid', 'end-node', 'cross-grade', 'cross-flyover', 'cross-tunnel', 'cross-uncertain', 'ramp-foot', 'bridge-end', 'multi', 'move-end', 'delete-reconnect'];
const CASES = new Set((process.env.VP_CASES ?? ALL.join(',')).split(','));
const STRICT = process.env.VP_STRICT !== '0';
/** The whole-network key is slow on the database (all 18k roads): checked on every KEY_EVERY-th sample; the byte compare of every object runs on all. */
const KEY_EVERY = Number(process.env.VP_KEY_EVERY ?? (DB ? 10 : 1));
let sampleNo = 0;
const keyNow = () => (sampleNo % KEY_EVERY === 0 ? keyOf(om) : '');

type Pt = [number, number, number];
interface Violation { kase: string; sample: number; at: string; rule: string; detail: string }
const reports: Record<string, { samples: number; drawn: number; violations: Violation[]; byRule: Record<string, number>; notes: Record<string, number>; seconds: number }> = {};

let om: ObjectManager;
let history: HistoryManager;
let editing: EditingEngine;
let start: Snap;
let startKey: string;
let grid: ReturnType<typeof roadGrid>;
const readRows = (): DbRow[] => (DB ? JSON.parse(fs.readFileSync(DB, 'utf8')) : fixtureRows());
function setup() {
  ({ om, history } = loadNetwork(readRows()));
  editing = new EditingEngine(om, history, undefined, {} as any);
  start = snap(om);
  startKey = keyOf(om);
  grid = roadGrid(om.getAll());
}
beforeAll(() => { vi.spyOn(EditingEngine.prototype, 'fetchSavedAreas').mockResolvedValue(); setup(); }, 600000);
afterAll(() => {
  vi.restoreAllMocks();
  if (process.env.VP_REPORT) for (const [k, r] of Object.entries(reports)) fs.writeFileSync(path.join(process.env.VP_REPORT, `${k}.json`), JSON.stringify(r, null, 1));
});

// ---------- geometry ----------
const M = 111320;
const kxOf = (lat: number) => M * Math.cos(lat * Math.PI / 180);
const z = (p: readonly number[]) => p[2] || 0;
/** Point `m` metres from p along unit plan direction (ux east, uy north). */
const offset = (p: readonly number[], ux: number, uy: number, m: number, h = 0): Pt => [p[0] + ux * m / kxOf(p[1]), p[1] + uy * m / M, h];
const lerp = (a: readonly number[], b: readonly number[], t: number): Pt => [a[0] + t * (b[0] - a[0]), a[1] + t * (b[1] - a[1]), z(a) + t * (z(b) - z(a))];
function segDir(a: readonly number[], b: readonly number[]) { const k = kxOf(a[1]); const dx = (b[0] - a[0]) * k, dy = (b[1] - a[1]) * M, l = Math.hypot(dx, dy) || 1; return { ux: dx / l, uy: dy / l, len: l }; }
/** Plan intersections of two polylines: point, heights of each there, segment indices. */
function crossings(a: readonly (readonly number[])[], b: readonly (readonly number[])[]) {
  const out: { p: Pt; za: number; zb: number; sa: number; sb: number; ta: number; tb: number }[] = [];
  for (let i = 0; i < a.length - 1; i++) for (let j = 0; j < b.length - 1; j++) {
    const p = a[i], q = a[i + 1], r = b[j], s = b[j + 1];
    const dx = q[0] - p[0], dy = q[1] - p[1], ex = s[0] - r[0], ey = s[1] - r[1];
    const den = dx * ey - dy * ex;
    if (Math.abs(den) < 1e-20) continue;
    const t = ((r[0] - p[0]) * ey - (r[1] - p[1]) * ex) / den, u = ((r[0] - p[0]) * dy - (r[1] - p[1]) * dx) / den;
    if (t < 0 || t > 1 || u < 0 || u > 1) continue;
    const pt = lerp(p, q, t);
    out.push({ p: pt, za: pt[2], zb: z(r) + u * (z(s) - z(r)), sa: i, sb: j, ta: t, tb: u });
  }
  return out;
}
function nearestOn(p: readonly number[], line: readonly (readonly number[])[]) {
  let best = { d: Infinity, z: 0 };
  const k = kxOf(p[1]);
  for (let i = 0; i < line.length - 1; i++) {
    const a = line[i], b = line[i + 1];
    const ax = (a[0] - p[0]) * k, ay = (a[1] - p[1]) * M, bx = (b[0] - p[0]) * k, by = (b[1] - p[1]) * M;
    const dx = bx - ax, dy = by - ay, l2 = dx * dx + dy * dy;
    const t = l2 > 0 ? Math.max(0, Math.min(1, -(ax * dx + ay * dy) / l2)) : 0;
    const d = Math.hypot(ax + t * dx, ay + t * dy);
    if (d < best.d) best = { d, z: z(a) + t * (z(b) - z(a)) };
  }
  return best;
}

// ---------- the oracle: what a crossing should be, from tags and heights only ----------
type Drivable = RoadObject | (CityObject & { coordinates: Pt[] });
const drivable = (o: CityObject | undefined): o is Drivable => !!o && (o.type === 'road' || o.type === 'flyover' || o.type === 'metro_flyover');
function levelTag(o: Drivable): 'ground' | 'bridge' | 'tunnel' | 'layer' | 'earthwork' | 'structure' {
  if (o.type !== 'road') return 'structure';
  const p = (o as RoadObject).osmProvenance;
  if (!p) return 'ground';
  if (isOsmBridge(p)) return 'bridge';
  if (isOsmTunnel(p)) return 'tunnel';
  if ((p.layer ?? 0) !== 0) return 'layer';
  // OSM embankment=* / cutting=* (any value but "no"): raised or sunk, height not modelled
  const t = p.originalTags ?? {};
  if (['embankment', 'cutting'].some(k => t[k] && t[k].trim().toLowerCase() !== 'no')) return 'earthwork';
  return 'ground';
}
export function expectedCrossing(a: Drivable, b: Drivable, za: number, zb: number): 'junction' | 'separate' | 'uncertain' {
  if (Math.abs(za - zb) > 3) return 'separate';
  if (levelTag(a) !== 'ground' || levelTag(b) !== 'ground') return 'uncertain';
  if (Math.abs(za) > 0.5 || Math.abs(zb) > 0.5) return 'uncertain';
  return 'junction';
}

// ---------- network helpers ----------
/** A junction may sit up to the builder's join tolerance (JOIN_TOLERANCE_DEG ≈ 6.7 m) from the point (node clustering). */
const JOIN_M = 7;
let dbgNew = '';
function dbg(net: TrafficNetwork, otherId: string, p: readonly number[]) {
  const fmt = (id: string) => [...nodesOf(net, id)].map(n => ({ n, d: nodeDist(net, n, p) })).filter(x => x.d < 30).map(x => `${x.n}@${x.d.toFixed(1)}m`).join(' ');
  return `| new: ${fmt(dbgNew)} | other: ${fmt(otherId)}`;
}
function localNet(ids: Iterable<string>) {
  const roads = [...new Set(ids)].map(id => om.getById(id)).filter(drivable) as RoadObject[];
  return new TrafficNetworkBuilder().build(roads).network;
}
function nodesOf(net: TrafficNetwork, roadId: string) {
  const s = new Set<string>();
  for (const e of net.edges.values()) if (e.roadId === roadId) { s.add(e.fromNodeId); s.add(e.toNodeId); }
  return s;
}
const nodeDist = (net: TrafficNetwork, id: string, p: readonly number[]) => { const n = net.nodes.get(id); return n ? distM(n.coordinates, p) : Infinity; };
function routeExists(net: TrafficNetwork, from: Iterable<string>, to: Iterable<string>) {
  const T = [...to];
  for (const f of from) for (const t of T) if (f !== t && (Pathfinder.findPath(net, f, t) || Pathfinder.findPath(net, t, f))) return true;
  return false;
}

// ---------- sampling pools ----------
interface SegRef { id: string; s: number }
let pools: Record<string, SegRef[]> | null = null;
let junctionPts: Pt[] = [];
let bridgeEnds: { id: string; p: Pt }[] = [];
function buildPools() {
  const P: Record<string, SegRef[]> = { ground: [], deck: [], tunnel: [], uncertain: [] };
  const deg = new Map<string, { n: number; p: Pt; ground: boolean }>();
  bridgeEnds = [];
  for (const o of om.getAll()) {
    if (o.type !== 'road') continue;
    const r = o as RoadObject, c = r.coordinates, tag = levelTag(r);
    for (let i = 0; i < c.length - 1; i++) {
      const len = distM(c[i], c[i + 1]);
      if (len < 8) continue; // decks and ramps are densified to <= 12 m points (bridgeElevation)
      const za = z(c[i]), zb = z(c[i + 1]);
      if (tag === 'ground' && Math.abs(za) < 0.05 && Math.abs(zb) < 0.05) { if (len >= 25) P.ground.push({ id: r.id, s: i }); }
      else if (tag === 'bridge' && za > 5 && zb > 5) P.deck.push({ id: r.id, s: i });
      else if (za < -5 && zb < -5) P.tunnel.push({ id: r.id, s: i });
      else if (tag !== 'ground' && Math.abs(za) < 1 && Math.abs(zb) < 1) P.uncertain.push({ id: r.id, s: i });
    }
    for (const p of c) {
      const k = vkey(p); const d = deg.get(k);
      if (d) d.n++; else deg.set(k, { n: 1, p: p as Pt, ground: tag === 'ground' && Math.abs(z(p)) < 0.05 });
    }
    if (tag === 'bridge') for (const p of [c[0], c[c.length - 1]]) bridgeEnds.push({ id: r.id, p: p as Pt });
  }
  junctionPts = [...deg.values()].filter(d => d.n >= 3 && d.ground).map(d => d.p);
  pools = P;
  console.log(`pools: ground ${P.ground.length}, deck ${P.deck.length}, tunnel ${P.tunnel.length}, uncertain ${P.uncertain.length}, junctions(3+) ${junctionPts.length}, bridge ends ${bridgeEnds.length}`);
}

// ---------- drawing ----------
function draw(mode: 'draw_road' | 'draw_flyover', pts: Pt[], move?: { index: number; to: Pt }): string | null {
  editing.setMode(mode);
  for (const p of pts) editing.addDrawingPoint(p);
  if (move) editing.getDrawingPoints()[move.index] = move.to; // a drawing point dragged before finishing (TwinCityEngine drag handler)
  const ids0 = new Set(om.getAll().map(o => o.id));
  editing.finalizeDrawing('base');
  editing.setMode('select');
  const added = om.getAll().filter(o => !ids0.has(o.id));
  return added.length === 1 ? added[0].id : null;
}

/**
 * Checks one drawn object against the acceptance criteria. `s0` = before the drawing, `s1` = after.
 * `bad(rule, detail)` records a violation.
 */
function verifyDrawn(newId: string, s0: Snap, s1: Snap, bad0: (rule: string, detail: string) => void, notes: Record<string, number>, expectJoin: string[] = []) {
  const nr = s1.get(newId) as Drivable;
  // VP_DUMPDIR: the drawn road and the drawing points of every failing sample, to reproduce it
  const bad = (rule: string, detail: string) => {
    bad0(rule, detail);
    if (process.env.VP_DUMPDIR) fs.appendFileSync(path.join(process.env.VP_DUMPDIR, 'dump.jsonl'), JSON.stringify({ rule, detail, nr, before: (s0.get(detail.split(' ')[0]) ?? null) }) + '\n');
  };
  const nc = nr.coordinates as Pt[];
  const note = (k: string) => (notes[k] = (notes[k] ?? 0) + 1);
  // zero length
  const zeroLen = (c: readonly (readonly number[])[]) => c.some((p, i) => i > 0 && distM(c[i - 1], p) < 0.01 && Math.abs(z(c[i - 1]) - z(p)) < 0.01);
  if (zeroLen(nc)) bad('zero-length segment (new road)', newId);
  // what changed
  const ptsOfNew = new Set(nc.map(vkey));
  const changed = contentChanged(s0, s1).filter(id => id !== newId);
  const joinedByVertex = new Set<string>();
  for (const id of changed) {
    const b = s0.get(id) as RoadObject | undefined, a = s1.get(id) as RoadObject | undefined;
    if (!b || !a) { bad('unrelated object added/removed', id); continue; }
    const f = fieldsChanged(b, a);
    if (zeroLen(a.coordinates)) bad('zero-length segment (changed road)', id);
    const capCut = nr.type !== 'road' && f.some(x => x === 'trafficCapacity' || x === 'flyoverImpact');
    if (capCut) note('flyover capacity cut (documented)');
    if (capCut && f.every(x => x === 'trafficCapacity' || x === 'flyoverImpact')) continue;
    const geomOnly = f.every(x => x === 'coordinates' || x === 'sections' || (capCut && (x === 'trafficCapacity' || x === 'flyoverImpact')));
    const old = new Set(b.coordinates.map(q => `${vkey(q)}|${z(q).toFixed(4)}`));
    const keptAll = b.coordinates.every(q => a.coordinates.some(r => vkey(r) === vkey(q) && Math.abs(z(r) - z(q)) < 1e-9));
    const addedPts = a.coordinates.filter(q => !old.has(`${vkey(q)}|${z(q).toFixed(4)}`));
    if (!geomOnly || !keptAll || addedPts.length === 0 || !addedPts.every(q => ptsOfNew.has(vkey(q)))) {
      bad('unrelated road changed', `${id}: fields ${f}; kept ${keptAll}; added ${addedPts.length}`);
    } else joinedByVertex.add(id);
  }
  // network
  const local = new Set<string>([newId]);
  for (const o of grid.near(nc, 2)) local.add(o.id);
  for (const o of om.getAll()) if (drivable(o) && (o.type !== 'road' || !start.has(o.id))) local.add(o.id); // drawn objects are few
  const net = localNet(local);
  const own = nodesOf(net, newId);
  dbgNew = newId;
  if (!own.size) { bad('new road has no graph edges', newId); return; }
  const others = [...local].filter(id => id !== newId).map(id => om.getById(id)).filter(drivable) as Drivable[];
  const shared = (o: Drivable) => { const on = nodesOf(net, o.id); return [...own].filter(n => on.has(n)); };
  const ends = [nc[0], nc[nc.length - 1]];
  const joined = new Set<string>();
  // ends
  for (const [ei, e] of ends.entries()) {
    for (const o of others) {
      const h = nearestOn(e, o.coordinates);
      if (h.d > 0.5 || Math.abs(h.z - z(e)) > 3) continue;
      const sh = shared(o).filter(n => nodeDist(net, n, e) < JOIN_M);
      if (!sh.length) bad('end on a road but not joined in the graph', `${ei ? 'end' : 'start'} on ${o.id} (${levelTag(o)}, dz ${(h.z - z(e)).toFixed(2)}) ${dbg(net, o.id, e)}`);
      else { joined.add(o.id); note('end joined'); }
    }
  }
  // crossings: junctions first (they define `joined`), then the ones that must stay apart
  const flags: any[] = (nr as any).levelCrossings ?? [];
  const pending: { o: Drivable; x: ReturnType<typeof crossings>[number]; kind: 'separate' | 'uncertain' }[] = [];
  for (const o of others) {
    const oc = o.coordinates;
    for (const x of crossings(nc, oc)) {
      if (ends.some(e => distM(e, x.p) < 1)) continue; // an end, checked above
      // Passing through the other road's own end: that end is where it meets the road(s) it continues from
      const kind = expectedCrossing(nr, o, x.za, x.zb);
      if (kind !== 'junction' && (distM(oc[0], x.p) < 1 || distM(oc[oc.length - 1], x.p) < 1)) { note('crossing at the other road\'s end'); continue; }
      note(`crossing ${kind}`);
      if (kind !== 'junction') { pending.push({ o, x, kind }); continue; }
      // A junction crossing within the join tolerance of an end merges into the end's junction (node clustering)
      const near = shared(o).filter(n => nodeDist(net, n, x.p) < JOIN_M);
      // The junction is explicit in the objects too: a vertex of both roads at the crossing (junction tools, rendering)
      if (!(nc.some(q => distM(q, x.p) < 0.5) && oc.some(q => distM(q, x.p) < 0.5))) bad('at-grade crossing not split in the objects', `${o.id}`);
      if (!near.length) bad('at-grade crossing not joined', `${o.id} at ${vkey(x.p)} za ${x.za.toFixed(2)} zb ${x.zb.toFixed(2)} ${dbg(net, o.id, x.p)}`);
      else joined.add(o.id);
      if (flags.some(f => f.roadId === o.id && distM(f.point, x.p) < 2)) bad('crossing flagged though certain', `${o.id} ${kind}`);
    }
  }
  // Nodes where the new road legitimately meets other roads (ends, junctions): a road held apart may also touch them
  const legit = new Set<string>();
  for (const id of joined) for (const n of shared(om.getById(id) as Drivable)) legit.add(n);
  for (const { o, x, kind } of pending) {
    // Through a node the other road shares (in OSM) with a road the new road joins there: OSM joins ways only where
    // they meet (Key:layer), so the other road is at that road's level at this node, like at its own end
    if (kind === 'uncertain' && o.coordinates.some(q => distM(q, x.p) < 1 && [...joined].some(id => id !== o.id && (om.getById(id) as Drivable | undefined)?.coordinates.some(r => vkey(r) === vkey(q))))) { note('crossing at a node shared with a joined road'); continue; }
    const near = shared(o).filter(n => nodeDist(net, n, x.p) < JOIN_M && !legit.has(n) && !ends.some(e => nodeDist(net, n, e) < 1));
    if (near.length && process.env.VP_DUMP && !fs.existsSync(process.env.VP_DUMP)) fs.writeFileSync(process.env.VP_DUMP, JSON.stringify({ nr, o, local: [...local] }));
    if (near.length) bad(kind === 'separate' ? 'false junction at grade-separated crossing' : 'uncertain crossing joined without confirmation', `${o.id} (${levelTag(o)}) za ${x.za.toFixed(2)} zb ${x.zb.toFixed(2)} ${dbg(net, o.id, x.p)}`);
    if (kind === 'uncertain' && !flags.some(f => f.roadId === o.id && f.decision === 'unconfirmed' && distM(f.point, x.p) < 2)) bad('uncertain crossing not flagged for confirmation', `${o.id} (${levelTag(o)})`);
    if (kind === 'separate' && flags.some(f => f.roadId === o.id && distM(f.point, x.p) < 2)) bad('crossing flagged though certain', `${o.id} ${kind}`);
  }
  // The road the end was drawn onto: joined, unless the drawing snap moved the end onto another road's point (UI snap)
  for (const id of expectJoin) {
    const o = om.getById(id) as Drivable | undefined;
    const onIt = !!o && ends.some(e => nearestOn(e, o.coordinates).d <= 0.5);
    if (!joined.has(id) && onIt) bad('expected join missing', id);
    else if (!onIt) note('end snapped to another road point');
  }
  for (const id of joinedByVertex) if (!joined.has(id)) bad('road given a vertex but not joined', `${id} ${dbg(net, id, nc[nc.length - 1])}`);
  // duplicates: a node of the new road with another node within 1 m at the same level
  for (const n of own) {
    const c = net.nodes.get(n)!.coordinates;
    for (const m of net.nodes.values()) if (m.id !== n && distM(m.coordinates, c) < 1 && Math.abs(z(m.coordinates) - z(c)) < 3) { bad('duplicate node', `${n} ~ ${m.id}`); break; }
  }
  // routing onto every joined road from the new road
  for (const id of joined) {
    if (!routeExists(net, own, nodesOf(net, id))) bad('no route onto joined road', id);
  }
}

/** Undo → exact s0, redo → exact s1, undo again; returns false if the state could not be restored. */
function undoRedo(s0: Snap, s1: Snap, k0: string, k1: string, steps: number, bad: (rule: string, detail: string) => void) {
  for (let i = 0; i < steps; i++) history.undo();
  const u = contentChanged(s0, snap(om));
  if (u.length) bad('undo not exact', u.slice(0, 4).map(id => `${id}:${fieldsChanged(s0.get(id), snap(om).get(id))}`).join('; '));
  if (k0 && keyOf(om) !== k0) bad('undo key', '');
  for (let i = 0; i < steps; i++) history.redo();
  const r = contentChanged(s1, snap(om));
  if (r.length) bad('redo not exact', r.slice(0, 4).join(','));
  if (k1 && keyOf(om) !== k1) bad('redo key', '');
  for (let i = 0; i < steps; i++) history.undo();
}

function runCase(kase: string, body: (rand: () => number, bad: (rule: string, detail: string) => void, notes: Record<string, number>) => boolean) {
  if (!pools) buildPools();
  const t0 = performance.now();
  const rand = rng(SEED + ALL.indexOf(kase) * 7919);
  const sink: Violation[] = [], notes: Record<string, number> = {};
  let drawn = 0;
  for (let i = 0; i < N; i++) {
    sampleNo = i;
    const bad = (rule: string, detail: string) => sink.push({ kase, sample: i, at: '', rule, detail: detail.slice(0, 300) });
    try { if (body(rand, bad, notes)) drawn++; } catch (e: any) { bad('threw', String(e?.stack ?? e).slice(0, 300)); }
    const back = contentChanged(start, snap(om));
    if (back.length) { bad('not back at start', back.slice(0, 4).join(',')); setup(); }
  }
  const byRule: Record<string, number> = {};
  for (const v of sink) byRule[v.rule] = (byRule[v.rule] ?? 0) + 1;
  const seconds = Math.round((performance.now() - t0) / 1000);
  reports[kase] = { samples: N, drawn, violations: sink, byRule, notes, seconds };
  const failedSamples = new Set(sink.map(v => v.sample)).size;
  console.log(`${kase}: ${N} samples, ${drawn} drawn, ${failedSamples} failing samples, ${sink.length} violations ${JSON.stringify(byRule)} notes ${JSON.stringify(notes)} ${seconds}s`);
  for (const v of sink.slice(0, 8)) console.log('  ', JSON.stringify(v));
  if (STRICT) expect(byRule).toEqual({});
}

const pick = <T,>(rand: () => number, l: readonly T[]) => l[Math.floor(rand() * l.length)];
const segOf = (r: SegRef) => { const c = (om.getById(r.id) as RoadObject).coordinates; return [c[r.s], c[r.s + 1]] as const; };

/** A two-point road crossing segment `ref` at right angles at t, `half` m each side, at height h. */
function crossing(ref: SegRef, t: number, half: number, h: number): Pt[] {
  const [a, b] = segOf(ref); const p = lerp(a, b, t); const { ux, uy } = segDir(a, b);
  return [offset(p, -uy, ux, half, h), offset(p, uy, -ux, half, h)];
}

const T = 6 * 3600 * 1000;
describe(`Topology property test (${DB ? 'project database' : 'Sangamwadi fixture'}, ${N} per case)`, () => {
  /** One drawing: snapshot, draw, verify, undo/redo. */
  const once = (mode: 'draw_road' | 'draw_flyover', pts: Pt[], bad: any, notes: any, expectJoin: string[] = [], move?: { index: number; to: Pt }) => {
    const s0 = snap(om), k0 = keyNow();
    const id = draw(mode, pts, move);
    if (!id) { bad('nothing drawn', ''); return false; }
    const s1 = snap(om), k1 = keyNow();
    verifyDrawn(id, s0, s1, bad, notes, expectJoin);
    undoRedo(s0, s1, k0, k1, 1, bad);
    return true;
  };

  it.runIf(CASES.has('end-mid'))('road end drawn onto an existing road mid-segment', () => runCase('end-mid', (rand, bad, notes) => {
    const ref = pick(rand, pools!.ground); const [a, b] = segOf(ref);
    const p = lerp(a, b, 0.3 + 0.4 * rand()); const { ux, uy } = segDir(a, b);
    const side = rand() < 0.5 ? 1 : -1;
    return once('draw_road', [offset(p, -uy * side, ux * side, 40 + 30 * rand()), p], bad, notes, [ref.id]);
  }), T);

  it.runIf(CASES.has('end-node'))('road end drawn onto an existing junction node (3+ roads)', () => runCase('end-node', (rand, bad, notes) => {
    const j = pick(rand, junctionPts); const ang = rand() * 2 * Math.PI;
    const ids = (grid.near([j], 1).filter(o => o.type === 'road' && (o.coordinates as Pt[]).some(q => vkey(q) === vkey(j))) as RoadObject[]).map(r => r.id);
    return once('draw_road', [offset(j, Math.cos(ang), Math.sin(ang), 40 + 30 * rand()), [j[0], j[1], z(j)]], bad, notes, ids);
  }), T);

  it.runIf(CASES.has('cross-grade'))('road crossing an at-grade road mid-way', () => runCase('cross-grade', (rand, bad, notes) => {
    const ref = pick(rand, pools!.ground);
    return once('draw_road', crossing(ref, 0.3 + 0.4 * rand(), 30 + 20 * rand(), 0), bad, notes, [ref.id]);
  }), T);

  it.runIf(CASES.has('cross-flyover'))('ground road crossing under a flyover / bridge deck', () => runCase('cross-flyover', (rand, bad, notes) => {
    if (!pools!.deck.length) { notes.noDeck = (notes.noDeck ?? 0) + 1; return false; }
    return once('draw_road', crossing(pick(rand, pools!.deck), 0.2 + 0.6 * rand(), 30 + 20 * rand(), 0), bad, notes);
  }), T);

  it.runIf(CASES.has('cross-tunnel'))('ground road crossing over a tunnel / underpass', () => runCase('cross-tunnel', (rand, bad, notes) => {
    if (!pools!.tunnel.length) { notes.noTunnel = (notes.noTunnel ?? 0) + 1; return false; }
    return once('draw_road', crossing(pick(rand, pools!.tunnel), 0.2 + 0.6 * rand(), 30 + 20 * rand(), 0), bad, notes);
  }), T);

  it.runIf(CASES.has('cross-uncertain'))('ground road crossing a bridge/layer-tagged piece at ground height (level unknown)', () => runCase('cross-uncertain', (rand, bad, notes) => {
    if (!pools!.uncertain.length) { notes.noUncertain = (notes.noUncertain ?? 0) + 1; return false; }
    const ref = pick(rand, pools!.uncertain); const [a, b] = segOf(ref); const t = 0.3 + 0.4 * rand();
    return once('draw_road', crossing(ref, t, 30 + 20 * rand(), lerp(a, b, t)[2]), bad, notes);
  }), T);

  it.runIf(CASES.has('ramp-foot'))('flyover drawn with its ramp foot on a ground road mid-segment', () => runCase('ramp-foot', (rand, bad, notes) => {
    const ref = pick(rand, pools!.ground); const [a, b] = segOf(ref);
    const p = lerp(a, b, 0.3 + 0.4 * rand()); const { ux, uy } = segDir(a, b);
    return once('draw_flyover', [offset(p, -uy, ux, 150 + 100 * rand()), [p[0], p[1], 0]], bad, notes, [ref.id]);
  }), T);

  it.runIf(CASES.has('bridge-end'))('road end drawn onto a bridge end (clicked at the deck)', () => runCase('bridge-end', (rand, bad, notes) => {
    if (!bridgeEnds.length) return false;
    const be = pick(rand, bridgeEnds); const ang = rand() * 2 * Math.PI;
    return once('draw_road', [offset(be.p, Math.cos(ang), Math.sin(ang), 50 + 30 * rand(), z(be.p)), [be.p[0], be.p[1], z(be.p)]], bad, notes, [be.id]);
  }), T);

  it.runIf(CASES.has('multi'))('three roads drawn to one point of a road (multi-arm junction)', () => runCase('multi', (rand, bad, notes) => {
    const ref = pick(rand, pools!.ground); const [a, b] = segOf(ref);
    const p = lerp(a, b, 0.3 + 0.4 * rand()); const { ux, uy } = segDir(a, b);
    const s0 = snap(om), k0 = keyNow();
    const ids: string[] = [];
    let hub: Pt = p;
    for (const ang of [Math.PI / 2, Math.PI / 2 + 0.6, -Math.PI / 2]) {
      const c = Math.cos(ang), s = Math.sin(ang);
      const dir = [ux * c - uy * s, ux * s + uy * c];
      const before = snap(om);
      // Later arms are clicked on the junction the first arm made (where its end ended up)
      const id = draw('draw_road', [offset(p, dir[0], dir[1], 45 + 20 * rand()), hub]);
      if (id && !ids.length) hub = [...(om.getById(id) as RoadObject).coordinates.at(-1)!] as Pt;
      if (!id) { bad('nothing drawn', ''); break; }
      verifyDrawn(id, before, snap(om), bad, notes, [ref.id]);
      ids.push(id);
    }
    // All arms meet at one graph node (where the snap put the first arm's end), with the road(s) there
    if (ids.length === 3) {
      const q = (om.getById(ids[0]) as RoadObject).coordinates.at(-1)!;
      const local = new Set<string>([ref.id, ...ids, ...grid.near([q], 1).map(o => o.id)]);
      const net = localNet(local);
      const endNode = (id: string) => { const c = (om.getById(id) as RoadObject).coordinates.at(-1)!; return [...nodesOf(net, id)].sort((x, y) => nodeDist(net, x, c) - nodeDist(net, y, c))[0]; };
      const ns = new Set(ids.map(endNode));
      if (ns.size !== 1) bad('arms not at one node', [...ns].join(' '));
      else { const n = net.nodes.get([...ns][0])!; if (n.incomingSegments.length < 4) bad('junction arms', `${n.incomingSegments.length} incoming`); else notes.multiArmNode = (notes.multiArmNode ?? 0) + 1; }
    }
    const s1 = snap(om), k1 = keyNow();
    undoRedo(s0, s1, k0, k1, ids.length, bad);
    return true;
  }), T);

  it.runIf(CASES.has('move-end'))('road end moved (dragged) to another road before finishing', () => runCase('move-end', (rand, bad, notes) => {
    const ref = pick(rand, pools!.ground); const [a, b] = segOf(ref);
    const p1 = lerp(a, b, 0.25); const p2 = lerp(a, b, 0.75); const { ux, uy } = segDir(a, b);
    const s0 = snap(om);
    const ok = once('draw_road', [offset(p1, -uy, ux, 50), p1], bad, notes, [ref.id], { index: 1, to: p2 });
    // Only p2 got the junction vertex: redo/undo already checked; check the drawn state again for the split location
    void s0;
    return ok;
  }), T);

  it.runIf(CASES.has('delete-reconnect'))('road drawn to a road, deleted, drawn again to the same point', () => runCase('delete-reconnect', (rand, bad, notes) => {
    const ref = pick(rand, pools!.ground); const [a, b] = segOf(ref);
    const p = lerp(a, b, 0.3 + 0.4 * rand()); const { ux, uy } = segDir(a, b);
    const f = offset(p, -uy, ux, 50);
    const s0 = snap(om), k0 = keyNow();
    const id1 = draw('draw_road', [f, p]);
    if (!id1) { bad('nothing drawn', ''); return false; }
    const joinedByDraw = new Set(contentChanged(s0, snap(om)));
    deleteWithHistory(om, history, id1);
    const sDel = snap(om);
    // after deletion only the junction vertex the drawing inserted remains (on the road it joined), nothing else
    const left = contentChanged(s0, sDel);
    for (const id of left) if (!joinedByDraw.has(id)) bad('delete left other changes', id);
    if (left.length) notes.junctionVertexKeptAfterDelete = (notes.junctionVertexKeptAfterDelete ?? 0) + 1;
    const before = snap(om);
    const id2 = draw('draw_road', [f, p]);
    if (!id2) { bad('nothing drawn', ''); return false; }
    const s1 = snap(om);
    verifyDrawn(id2, before, s1, bad, notes, [ref.id]);
    const r = s1.get(ref.id) as RoadObject;
    if (r.coordinates.filter(q => distM(q, p) < 0.5).length > 1) bad('duplicate vertex at reconnect point', ref.id);
    undoRedo(s0, s1, k0, keyNow(), 3, bad);
    return true;
  }), T);
});

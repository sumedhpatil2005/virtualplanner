import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest';
import fs from 'fs';
import path from 'path';
import { EditingEngine } from '../editing/EditingEngine';
import { SAME_LEVEL_SNAP_M } from '../editing/SnapManager';
import type { ObjectManager } from '../objects/ObjectManager';
import { deleteWithHistory, type HistoryManager } from '../history/HistoryManager';
import { commitRoadFieldEdit, laneEditPreview, laneEditPieces, directionLanes, flyoverFieldUpdates, type LaneEditScope, type LaneField } from '../editing/roadEdits';
import { findRoadEndGaps } from '../editing/roadGaps';
import { applyNetworkCorrections, validateCorrectionLayer } from '../simulation/networkCorrections';
import { TrafficNetworkBuilder } from '../simulation/TrafficNetworkBuilder';
import { Pathfinder } from '../simulation/Pathfinder';
import type { CityObject, RoadObject } from '../objects/types';
import { checkCarriagewayScope, indexRoads } from './carriagewayInvariants';
import {
  canon, contentChanged, documentedNeighbours, fieldsChanged, keyOf, loadNetwork, onlyHeightsChanged, rng, roadGrid, roadsOf,
  snap, stratifiedSample, stratumOf, vkey, distM, lengthM, type DbRow, type Snap,
} from './editHarness';

/**
 * Build edits change only what they are meant to, across the whole network (docs/OVERHAUL.md §27).
 *
 * For a stratified random sample of roads per operation (bridges and flyovers, underpasses, ramp approaches, slip
 * roads, one-way main roads (dual carriageways), one-way local, two-way main, two-way local, unnamed), each Build
 * edit is applied through the code the UI runs, and every object of the network is compared before and after:
 * only the intended ids change (heights of a deletion's neighbours recomputed only where §21 says, and then equal
 * to a fresh load without the road); the network key changes; Undo gives back byte-identical objects (keys sorted,
 * `updatedAt` left out) and the exact key; Redo gives back the edited state exactly; the deleted-roads list and
 * clipped pieces stay consistent; the "Entire carriageway" scope keeps the §21 invariants.
 *
 * Network: VP_OBJECTS = an export of the project database (array of /api/objects rows); without it the real OSM
 * roads round Sangamwadi Bridge (fixtures/sangamwadi.json) with a smaller sample. VP_N = samples per operation
 * (default 200 on a database, 24 on the fixture). VP_OPS = comma list of operations to run (default all).
 * VP_REPORT = a directory for the JSON report of each operation.
 */

const DB = process.env.VP_OBJECTS;
const fixtureRows = (): DbRow[] => {
  const fx = JSON.parse(fs.readFileSync(path.join(__dirname, 'fixtures/sangamwadi.json'), 'utf8')) as { roads: any[] };
  return fx.roads.filter(r => r.type === 'road').map(({ id, type, name, layerId, scenarioId, coordinates, ...properties }) => ({ id, type, name, layerId, scenarioId, coordinates, properties }));
};
const N = Number(process.env.VP_N ?? (DB ? 200 : 24));
const OPS = new Set((process.env.VP_OPS ?? 'delete,lanes-segment,lanes-carriageway,speed,class,oneway,reshape,reconnect,flyover-elevation,sequence').split(','));
const layer = validateCorrectionLayer(JSON.parse(fs.readFileSync(path.join(__dirname, '../../../../backend/data/network_corrections/pune_west_v1.json'), 'utf8')));
const view = (raw: readonly RoadObject[]) => applyNetworkCorrections(raw, layer, true).roads as RoadObject[];

interface Violation { op: string; id: string; stratum: string; rule: string; detail: string }
const reports: Record<string, { samples: number; byStratum: Record<string, number>; violations: Violation[]; notes: Record<string, number>; seconds: number }> = {};

/** Read again when needed rather than kept: the database export is large and the sandbox's memory is shared. */
const readRows = (): DbRow[] => (DB ? JSON.parse(fs.readFileSync(DB, 'utf8')) : fixtureRows());
let om: ObjectManager;
let history: HistoryManager;
let editing: EditingEngine;
let start: Snap;
let startKey: string;

function setup() {
  ({ om, history } = loadNetwork(readRows()));
  editing = new EditingEngine(om, history, undefined, {} as any);
  start = snap(om);
  startKey = keyOf(om);
}

beforeAll(() => {
  vi.spyOn(EditingEngine.prototype, 'fetchSavedAreas').mockResolvedValue();
  setup();
}, 600000);
afterAll(() => {
  vi.restoreAllMocks();
  if (process.env.VP_REPORT) for (const [op, r] of Object.entries(reports)) fs.writeFileSync(path.join(process.env.VP_REPORT, `${op}.json`), JSON.stringify(r, null, 1));
});

const deleted = () => new Set((om as any).deletedOsm as Set<string>);
const roadById = (s: Snap, id: string) => s.get(id) as RoadObject;
/** Fields a Build properties edit rewrites from the road's own values on every edit (roadFieldUpdates): derived or cosmetic. */
const DERIVED = new Set(['laneCount', 'width', 'trafficCapacity', 'laneWidth', 'hasDivider', 'dividerWidth', 'hasFootpath', 'footpathWidth']);

/** Runs `op` and checks the network and history around it. Returns false when the network had to be reloaded. */
function checked(opName: string, sample: { id: string; stratum: string }, out: Violation[], notes: Record<string, number>, op: () => {
  intended: Set<string>;
  /** null when a change to `id` (not intended) is documented, else why it is not. */
  extra?: (id: string, before: Snap, after: Snap, changed: string[]) => string | null;
  /** Further checks on the edited state. */
  after?: (before: Snap, after: Snap, changed: string[]) => void;
  expectChange?: boolean;
} | null) {
  const bad = (rule: string, detail: string) => out.push({ op: opName, id: sample.id, stratum: sample.stratum, rule, detail: detail.slice(0, 400) });
  const s0 = snap(om), del0 = deleted(), undo0 = history.getUndoStackCount();
  let r: ReturnType<typeof op>;
  try { r = op(); } catch (e: any) { bad('threw', String(e?.stack ?? e)); setup(); return false; }
  if (!r) { notes.skipped = (notes.skipped ?? 0) + 1; return true; }
  const s1 = snap(om), k1 = keyOf(om), del1 = deleted();
  const ch = contentChanged(s0, s1);
  for (const id of ch) {
    if (r.intended.has(id)) continue;
    const why = r.extra ? r.extra(id, s0, s1, ch) : 'not intended';
    if (why !== null) bad('unrelated change', `${id} (${s0.get(id) ? stratumOf(s0.get(id) as RoadObject) : 'new'}): ${why}; fields ${fieldsChanged(s0.get(id), s1.get(id)).join(',')}`);
    else notes.documentedRecompute = (notes.documentedRecompute ?? 0) + 1;
  }
  if (r.expectChange !== false && !ch.some(id => r!.intended.has(id))) bad('no change', `intended ${[...r.intended].join(',')}`);
  if (ch.length && k1 === startKey) bad('key unchanged', `${ch.length} objects changed`);
  if (!ch.length && k1 !== startKey) bad('key changed without content change', k1);
  r.after?.(s0, s1, ch);
  if (history.getUndoStackCount() !== undo0 + 1) bad('undo steps', `${history.getUndoStackCount() - undo0} steps recorded`);
  // Undo, redo, undo
  history.undo();
  const s2 = snap(om);
  const u = contentChanged(s0, s2);
  if (u.length) bad('undo not identical', u.slice(0, 5).map(id => `${id}: ${fieldsChanged(s0.get(id), s2.get(id)).join(',')}`).join('; '));
  if (keyOf(om) !== startKey) bad('undo key', `${keyOf(om)} != ${startKey}`);
  if (canon([...deleted()].sort()) !== canon([...del0].sort())) bad('deleted list after undo', `${[...deleted()].filter(x => !del0.has(x))}`);
  history.redo();
  const s3 = snap(om);
  const rr = contentChanged(s1, s3);
  if (rr.length) bad('redo not identical', rr.slice(0, 5).map(id => `${id}: ${fieldsChanged(s1.get(id), s3.get(id)).join(',')}`).join('; '));
  if (keyOf(om) !== k1) bad('redo key', `${keyOf(om)} != ${k1}`);
  if (canon([...deleted()].sort()) !== canon([...del1].sort())) bad('deleted list after redo', '');
  history.undo();
  const back = contentChanged(start, snap(om));
  if (back.length) { bad('not back at start', back.slice(0, 5).join(',')); setup(); return false; }
  return true;
}

function runOp(opName: string, pick: (roads: RoadObject[]) => { id: string; stratum: string }[], op: (s: { id: string; stratum: string }, i: number) => Parameters<typeof checked>[4] extends () => infer R ? R : never) {
  const t0 = performance.now();
  const out: Violation[] = [], notes: Record<string, number> = {};
  const samples = pick(roadsOf(om));
  const byStratum: Record<string, number> = {};
  samples.forEach((s, i) => {
    byStratum[s.stratum] = (byStratum[s.stratum] ?? 0) + 1;
    checked(opName, s, out, notes, () => op(s, i));
  });
  const seconds = Math.round((performance.now() - t0) / 1000);
  reports[opName] = { samples: samples.length, byStratum, violations: out, notes, seconds };
  const rules: Record<string, number> = {};
  for (const v of out) rules[v.rule] = (rules[v.rule] ?? 0) + 1;
  console.log(`${opName}: ${samples.length} samples ${JSON.stringify(byStratum)}, ${out.length} violations ${JSON.stringify(rules)}, notes ${JSON.stringify(notes)}, ${seconds} s`);
  for (const v of out.slice(0, 30)) console.log(JSON.stringify(v));
  return out;
}

const T = 4 * 3600 * 1000;
const sel = (id: string) => om.getById(id) as RoadObject;

describe(`Build edits change only what they are meant to (${DB ? 'project database' : 'Sangamwadi fixture'}, ${N} samples per operation)`, () => {
  it.runIf(OPS.has('delete'))('delete a road: only the road goes; heights round it as a fresh load; undo/redo exact', () => {
    const out = runOp('delete', roads => stratifiedSample(roads, N, 101, r => !!r.osmProvenance), s => {
      const victim = sel(s.id);
      if (!deleteWithHistory(om, history, s.id)) return null;
      return {
        intended: new Set([s.id]),
        extra: (id, before, after, changed) => {
          const b = before.get(id) as RoadObject, a = after.get(id) as RoadObject;
          if (!b || !a || b.type !== 'road' || a.type !== 'road') return 'added or removed';
          if (!onlyHeightsChanged(b, a)) return 'more than heights';
          return documentedNeighbours(victim, before, changed).has(id) ? null : 'heights changed away from the deleted road';
        },
        after: (_before, after, changed) => {
          if (!deleted().has(s.id)) out.push({ op: 'delete', id: s.id, stratum: s.stratum, rule: 'deleted list', detail: 'id not recorded as deleted' });
          if ([...after.keys()].some(k => k.startsWith(`${s.id}_`))) out.push({ op: 'delete', id: s.id, stratum: s.stratum, rule: 'orphaned pieces', detail: '' });
          // The heights round it are those a fresh load of what is left gives (only worth the cost where heights moved)
          if (changed.length > 1) {
            const fresh = loadNetwork(readRows().filter(r => r.id !== s.id), false).om;
            const diff = contentChanged(snap(fresh), after).filter(id => id !== s.id);
            if (diff.length) out.push({ op: 'delete', id: s.id, stratum: s.stratum, rule: 'not as a fresh load', detail: diff.slice(0, 5).map(id => `${id}: ${fieldsChanged(fresh.getById(id), after.get(id))}`).join('; ') });
          }
        },
      };
    });
    expect(out).toEqual([]);
  }, T);

  const laneOp = (scope: LaneEditScope) => (s: { id: string; stratum: string }, i: number) => {
    const r = sel(s.id);
    const rand = rng(7000 + i);
    const field: LaneField = !r.isOneWay && rand() < 0.5 ? 'lanesBackward' : 'lanesForward';
    const cur = directionLanes(r, field);
    const value = cur <= 1 ? cur + 1 : cur >= 6 ? cur - 1 : rand() < 0.5 ? cur + 1 : cur - 1;
    const roads = roadsOf(om);
    const preview = laneEditPreview(roads, s.id, field, scope, view);
    const pieces = laneEditPieces(roads, s.id, field, scope, view);
    const inv = scope === 'carriageway' ? checkCarriagewayScope(roads, indexRoads(roads), s.id, field) : [];
    commitRoadFieldEdit(om, history, { ...r }, field, value, scope, view);
    return {
      intended: new Set(preview.roadIds),
      after: (before: Snap, after: Snap, changed: string[]) => {
        const add = (rule: string, detail: string) => violationsSink.push({ op: `lanes-${scope}`, id: s.id, stratum: s.stratum, rule, detail });
        for (const v of inv) add(`carriageway invariant: ${v.rule}`, v.detail);
        if (canon(preview.roadIds.slice().sort()) !== canon(changed.filter(x => preview.roadIds.includes(x)).sort())) add('preview != changed', `${preview.roadIds} vs ${changed}`);
        for (const p of pieces) {
          const b = roadById(before, p.road.id), a = roadById(after, p.road.id);
          if (directionLanes(a, p.field) !== value) add('lanes not set', `${p.road.id} ${p.field} ${directionLanes(a, p.field)} != ${value}`);
          const other: LaneField = p.field === 'lanesForward' ? 'lanesBackward' : 'lanesForward';
          if (directionLanes(a, other) !== directionLanes(b, other)) add('other direction changed', `${p.road.id} ${other} ${directionLanes(b, other)} -> ${directionLanes(a, other)}`);
          const f = fieldsChanged(b, a).filter(x => x !== 'sections' && !DERIVED.has(x));
          if (f.length) add('fields beyond lanes', `${p.road.id}: ${f}`);
          for (const x of fieldsChanged(b, a).filter(x => DERIVED.has(x) && x !== 'laneCount' && x !== 'width' && x !== 'trafficCapacity')) notesSink[`side effect ${x}`] = (notesSink[`side effect ${x}`] ?? 0) + 1;
        }
        if (preview.count > 1) notesSink.multiPiece = (notesSink.multiPiece ?? 0) + 1;
      },
    };
  };
  let violationsSink: Violation[] = [];
  let notesSink: Record<string, number> = {};
  const withSinks = (name: string, f: () => Violation[]) => { violationsSink = []; notesSink = {}; const out = f(); const all = [...out, ...violationsSink]; reports[name].violations = all; Object.assign(reports[name].notes, notesSink); if (violationsSink.length) { console.log(`${name} after-checks: ${violationsSink.length}`); for (const v of violationsSink.slice(0, 30)) console.log(JSON.stringify(v)); } console.log(`${name} side notes ${JSON.stringify(notesSink)}`); return all; };

  for (const scope of ['segment', 'carriageway'] as LaneEditScope[]) {
    it.runIf(OPS.has(`lanes-${scope}`))(`lanes, ${scope} scope: only the previewed pieces, only the edited direction; undo/redo exact`, () => {
      const all = withSinks(`lanes-${scope}`, () => runOp(`lanes-${scope}`, roads => stratifiedSample(roads, N, scope === 'segment' ? 202 : 303), laneOp(scope)));
      expect(all).toEqual([]);
    }, T);
  }

  const fieldOp = (field: 'speedLimit' | 'roadClass' | 'isOneWay', value: (r: RoadObject, i: number) => unknown, allowed: string[]) => (s: { id: string; stratum: string }, i: number) => {
    const r = sel(s.id);
    commitRoadFieldEdit(om, history, { ...r }, field, value(r, i), 'carriageway', view);
    return {
      intended: new Set([s.id]),
      after: (before: Snap, after: Snap) => {
        const f = fieldsChanged(before.get(s.id), after.get(s.id)).filter(x => x !== field && !allowed.includes(x) && !DERIVED.has(x));
        if (f.length) violationsSink.push({ op: field, id: s.id, stratum: s.stratum, rule: 'fields beyond the edit', detail: f.join(',') });
        for (const x of fieldsChanged(before.get(s.id), after.get(s.id)).filter(x => DERIVED.has(x))) notesSink[`side effect ${x}`] = (notesSink[`side effect ${x}`] ?? 0) + 1;
      },
    };
  };
  const SPEEDS = [20, 30, 40, 50, 60, 80];
  const CLASSES = ['local', 'collector', 'arterial', 'highway'];
  it.runIf(OPS.has('speed'))('speed limit: only the road; undo/redo exact', () => {
    const all = withSinks('speed', () => runOp('speed', roads => stratifiedSample(roads, N, 404), fieldOp('speedLimit', (r, i) => SPEEDS.filter(x => x !== r.speedLimit)[i % 5], [])));
    expect(all).toEqual([]);
  }, T);
  it.runIf(OPS.has('class'))('road class: only the road; undo/redo exact', () => {
    const all = withSinks('class', () => runOp('class', roads => stratifiedSample(roads, N, 505), fieldOp('roadClass', (r, i) => CLASSES.filter(x => x !== r.roadClass)[i % 3], [])));
    expect(all).toEqual([]);
  }, T);
  it.runIf(OPS.has('oneway'))('one-way toggle: only the road; undo/redo exact', () => {
    const all = withSinks('oneway', () => runOp('oneway', roads => stratifiedSample(roads, N, 606), fieldOp('isOneWay', r => !r.isOneWay, ['sections'])));
    expect(all).toEqual([]);
  }, T);

  it.runIf(OPS.has('reshape'))('reshape (Road ends: Connect): only the road and the road it joins, plan points kept; joined in the traffic network; undo/redo exact', () => {
    const grid = roadGrid(om.getAll());
    const gapOf = new Map<string, ReturnType<typeof findRoadEndGaps>[number]>();
    for (const r of roadsOf(om)) {
      const near = grid.near([r.coordinates[0], r.coordinates[r.coordinates.length - 1]]);
      const g = findRoadEndGaps(r, near);
      if (g.length) gapOf.set(r.id, g[0]);
    }
    console.log(`roads with an end gap: ${gapOf.size}`);
    const all = withSinks('reshape', () => runOp('reshape', roads => stratifiedSample(roads, N, 707, r => gapOf.has(r.id)), s => {
      const gap = gapOf.get(s.id)!;
      const r = sel(s.id);
      editing.connectRoadEnd(gap, grid.near([r.coordinates[0], r.coordinates[r.coordinates.length - 1]]));
      return {
        intended: new Set([s.id, gap.targetRoadId]),
        after: (before: Snap, after: Snap) => {
          for (const id of [s.id, gap.targetRoadId]) {
            const b = roadById(before, id), a = roadById(after, id);
            const f = fieldsChanged(b, a).filter(x => x !== 'coordinates' && x !== 'sections');
            if (f.length) violationsSink.push({ op: 'reshape', id, stratum: s.stratum, rule: 'fields beyond geometry', detail: f.join(',') });
            // Every plan point kept, one inserted at most
            let j = 0, kept = 0;
            for (const p of b.coordinates) { while (j < a.coordinates.length && vkey(a.coordinates[j]) !== vkey(p)) j++; if (j < a.coordinates.length) { kept++; j++; } }
            if (kept !== b.coordinates.length || a.coordinates.length - b.coordinates.length > 1) violationsSink.push({ op: 'reshape', id, stratum: s.stratum, rule: 'plan points moved', detail: `${kept}/${b.coordinates.length} kept, ${a.coordinates.length - b.coordinates.length} added` });
          }
          const local = grid.near(roadById(after, s.id).coordinates, 2).map(o => after.get(o.id)).filter((o): o is RoadObject => o?.type === 'road');
          const { network } = new TrafficNetworkBuilder().build(local);
          const nodes = (id: string) => new Set([...network.edges.values()].filter(e => e.roadId === id).flatMap(e => [e.fromNodeId, e.toNodeId]));
          const a = nodes(s.id), b = nodes(gap.targetRoadId);
          if (![...a].some(n => b.has(n))) violationsSink.push({ op: 'reshape', id: s.id, stratum: s.stratum, rule: 'not joined in the traffic network', detail: gap.targetRoadId });
        },
      };
    }));
    expect(all).toEqual([]);
  }, T);

  it.runIf(OPS.has('reconnect'))('delete a piece, then draw a road across the gap: joined at both ends at their heights, used by routes; undo/redo exact', () => {
    const grid = roadGrid(om.getAll());
    // Pieces that join other roads at both ends
    const ends = new Map<string, number>();
    for (const r of roadsOf(om)) for (const p of r.coordinates) ends.set(vkey(p), (ends.get(vkey(p)) ?? 0) + 1);
    const joinedBothEnds = (r: RoadObject) => (ends.get(vkey(r.coordinates[0])) ?? 0) > 1 && (ends.get(vkey(r.coordinates[r.coordinates.length - 1])) ?? 0) > 1 && !!r.osmProvenance && r.coordinates.length >= 2 && distM(r.coordinates[0], r.coordinates[r.coordinates.length - 1]) > 20;
    let reconnectSink: Violation[] = [];
    const reconnectNotes: Record<string, number> = {};
    const t0 = performance.now();
    const samples = stratifiedSample(roadsOf(om), N, 808, joinedBothEnds);
    const byStratum: Record<string, number> = {};
    for (const s of samples) {
      byStratum[s.stratum] = (byStratum[s.stratum] ?? 0) + 1;
      const bad = (rule: string, detail: string) => reconnectSink.push({ op: 'reconnect', id: s.id, stratum: s.stratum, rule, detail: detail.slice(0, 400) });
      const victim = sel(s.id);
      const a = victim.coordinates[0], b = victim.coordinates[victim.coordinates.length - 1];
      const localIds = new Set(grid.near(victim.coordinates, 3).map(o => o.id));
      const localRoads = () => [...localIds].map(id => om.getById(id)).filter((o): o is RoadObject => o?.type === 'road');
      // Routes between the two ends of the gap: between the end nodes of `endsOf`'s own edges (node ids come from
      // position and height, so the same ends are found in every build)
      const route = (roads: RoadObject[], endsOf: string, ends?: [string, string]) => {
        const { network } = new TrafficNetworkBuilder().build(roads);
        const own = [...network.edges.values()].filter(e => e.roadId === endsOf);
        const nodeAt = (p: readonly number[]) => own.flatMap(e => [e.fromNodeId, e.toNodeId]).map(id => network.nodes.get(id)!).filter(Boolean)
          .reduce((best, n) => { const d = distM(n.coordinates, p) + Math.abs((n.coordinates[2] || 0) - (p[2] || 0)); return d < best.d ? { id: n.id, d } : best; }, { id: '', d: Infinity }).id;
        const [from, to] = ends ?? [nodeAt(a), nodeAt(b)];
        const find = (x: string, y: string) => (x && y ? Pathfinder.findPath(network, x, y) : null);
        const path = find(from, to) ?? find(to, from);
        const cost = (path ?? []).reduce((n, e) => { const x = network.edges.get(e)!; return n + x.length / ((x.speedLimit || 50) / 3.6); }, 0);
        // A chain of the road's own edges from one end to the other
        const chain = (() => {
          const seen = new Set([from]), stack = [from];
          while (stack.length) { const n = stack.pop()!; for (const e of own) if (e.fromNodeId === n && !seen.has(e.toNodeId)) { seen.add(e.toNodeId); stack.push(e.toNodeId); } }
          const seen2 = new Set([to]), stack2 = [to];
          while (stack2.length) { const n = stack2.pop()!; for (const e of own) if (e.fromNodeId === n && !seen2.has(e.toNodeId)) { seen2.add(e.toNodeId); stack2.push(e.toNodeId); } }
          return seen.has(to) || seen2.has(from);
        })();
        return { path, cost, chain, ends: [from, to] as [string, string], roadIds: new Set((path ?? []).map(e => network.edges.get(e)!.roadId)) };
      };
      const s0 = snap(om);
      const before = route(localRoads(), s.id);
      deleteWithHistory(om, history, s.id);
      const s1 = snap(om);
      const gapRoute = route(localRoads(), s.id, before.ends);
      // Draw a two-point road from one end of the gap to the other, clicking the ends (ground pick: height 0; the snap finds the road there)
      editing.setMode('draw_road');
      editing.addDrawingPoint([a[0], a[1], 0]);
      editing.addDrawingPoint([b[0], b[1], 0]);
      const idsBefore = new Set(om.getAll().map(o => o.id));
      try { editing.finalizeDrawing('base'); } catch (e: any) { bad('draw threw', String(e?.message)); }
      editing.setMode('select');
      const s2 = snap(om);
      const added = [...s2.keys()].filter(id => !idsBefore.has(id));
      if (added.length !== 1) { bad('drawn road', `${added.length} objects added`); }
      const nr = om.getById(added[0]) as RoadObject | undefined;
      if (nr) {
        localIds.add(nr.id);
        // A road the new road's end lies on, at the same level, gets one vertex there (the junction): where the
        // deleted piece's end was on a deck or in an underpass, the ground click joins the ground road the snap finds
        // there instead (docs/OVERHAUL.md §27.4). Nothing else may change.
        const endKeys = new Set([vkey(nr.coordinates[0]), vkey(nr.coordinates[nr.coordinates.length - 1])]);
        const endZ = new Map([[vkey(nr.coordinates[0]), nr.coordinates[0][2] || 0], [vkey(nr.coordinates[nr.coordinates.length - 1]), nr.coordinates[nr.coordinates.length - 1][2] || 0]]);
        const splitAtEnd = (id: string) => {
          const b = s1.get(id) as RoadObject, a = s2.get(id) as RoadObject;
          if (b?.type !== 'road' || a?.type !== 'road' || a.coordinates.length !== b.coordinates.length + 1) return false;
          if (fieldsChanged(b, a).some(f => f !== 'coordinates' && f !== 'sections')) return false;
          const old = new Set(b.coordinates.map(q => `${vkey(q)},${(q[2] || 0).toFixed(3)}`));
          const added = a.coordinates.filter(q => !old.has(`${vkey(q)},${(q[2] || 0).toFixed(3)}`));
          return added.length === 1 && endKeys.has(vkey(added[0])) && Math.abs((added[0][2] || 0) - endZ.get(vkey(added[0]))!) < 0.01
            && b.coordinates.every(q => a.coordinates.some(r => vkey(r) === vkey(q) && (r[2] || 0) === (q[2] || 0)));
        };
        const changedOthers = contentChanged(s1, s2).filter(id => id !== nr.id);
        const other = changedOthers.filter(id => !splitAtEnd(id));
        if (changedOthers.length > other.length) reconnectNotes.endJoinedAnotherRoad = (reconnectNotes.endJoinedAnotherRoad ?? 0) + 1;
        if (other.length) bad('drawing changed other roads', other.slice(0, 5).map(id => `${id} (${stratumOf(s1.get(id) as RoadObject)}): ${fieldsChanged(s1.get(id), s2.get(id))}`).join('; '));
        // Joined at both ends, at the height of the road there
        const after = snap(om);
        for (const [end, p, v] of [['start', nr.coordinates[0], a], ['end', nr.coordinates[nr.coordinates.length - 1], b]] as const) {
          // The Road tool picks the ground: where the deleted piece's end was on a deck or in an underpass (more than
          // the 2.5 m level-aware snap from the ground, 47f93fa) the new end stays on the ground and must not join the
          // deck in mid-air; it is not expected to rejoin that end (the Flyover tool does that)
          if (Math.abs(v[2] || 0) > SAME_LEVEL_SNAP_M) {
            reconnectNotes.elevatedEndNotRejoined = (reconnectNotes.elevatedEndNotRejoined ?? 0) + 1;
            if (Math.abs(p[2] || 0) > SAME_LEVEL_SNAP_M) bad('ground road end in mid-air', `${end} ${p[2]}`);
            continue;
          }
          const at = [...after.values()].filter((o): o is RoadObject => o.type === 'road' && o.id !== nr.id && localIds.has(o.id)).flatMap(o => o.coordinates.filter(q => vkey(q) === vkey(p)));
          if (!at.length) bad('end not on a road', `${end} ${vkey(p)}`);
          else if (!at.some(q => Math.abs((q[2] || 0) - (p[2] || 0)) < 0.01)) bad('end height', `${end} ${p[2]} vs ${at.map(q => q[2])}`);
        }
        const re = route(localRoads(), nr.id);
        // Routable end to end on its own, and the fastest route uses it unless another road is faster
        if (!re.chain) bad('new road not routable between the gap ends', `${re.ends}`);
        if (!re.path) bad('no route across the gap', '');
        else if (!re.roadIds.has(nr.id)) {
          const viaNew = lengthM(nr.coordinates) / (nr.speedLimit / 3.6);
          if (re.cost > viaNew + 0.5) bad('route does not use the new road', `${[...re.roadIds].slice(0, 6)} ${re.cost.toFixed(1)} s vs ${viaNew.toFixed(1)} s`);
          else reconnectNotes.fasterRouteElsewhere = (reconnectNotes.fasterRouteElsewhere ?? 0) + 1;
        }
        if (re.roadIds.has(nr.id)) reconnectNotes.routeUsesNewRoad = (reconnectNotes.routeUsesNewRoad ?? 0) + 1;
        if (!before.path) reconnectNotes.noRouteBefore = (reconnectNotes.noRouteBefore ?? 0) + 1;
        if (!gapRoute.path) reconnectNotes.gapDisconnected = (reconnectNotes.gapDisconnected ?? 0) + 1;
      }
      const k2 = keyOf(om);
      // Undo the drawing, then the deletion; redo both; undo both
      history.undo();
      if (contentChanged(s1, snap(om)).length) bad('undo draw not identical', contentChanged(s1, snap(om)).slice(0, 5).join(','));
      history.undo();
      if (contentChanged(s0, snap(om)).length) bad('undo delete not identical', contentChanged(s0, snap(om)).slice(0, 5).join(','));
      if (keyOf(om) !== startKey) bad('undo key', '');
      if (deleted().has(s.id)) bad('deleted list after undo', '');
      history.redo(); history.redo();
      if (contentChanged(s2, snap(om)).length) bad('redo not identical', contentChanged(s2, snap(om)).slice(0, 5).join(','));
      if (keyOf(om) !== k2) bad('redo key', '');
      history.undo(); history.undo();
      if (contentChanged(start, snap(om)).length) { bad('not back at start', ''); setup(); }
    }
    const seconds = Math.round((performance.now() - t0) / 1000);
    reports.reconnect = { samples: samples.length, byStratum, violations: reconnectSink, notes: reconnectNotes, seconds };
    const rules: Record<string, number> = {};
    for (const v of reconnectSink) rules[v.rule] = (rules[v.rule] ?? 0) + 1;
    console.log(`reconnect: ${samples.length} samples ${JSON.stringify(byStratum)}, ${reconnectSink.length} violations ${JSON.stringify(rules)}, notes ${JSON.stringify(reconnectNotes)}, ${seconds} s`);
    for (const v of reconnectSink.slice(0, 30)) console.log(JSON.stringify(v));
    expect(reconnectSink).toEqual([]);
    reconnectSink = [];
  }, T);

  /** A custom check loop for operations of more than one undo step; returns the violations, logs and reports them. */
  const loop = (name: string, samples: { id: string; stratum: string }[], body: (s: { id: string; stratum: string }, bad: (rule: string, detail: string) => void, notes: Record<string, number>, i: number) => void) => {
    const sink: Violation[] = [], notes: Record<string, number> = {}, byStratum: Record<string, number> = {};
    const t0 = performance.now();
    samples.forEach((s, i) => {
      byStratum[s.stratum] = (byStratum[s.stratum] ?? 0) + 1;
      const bad = (rule: string, detail: string) => sink.push({ op: name, id: s.id, stratum: s.stratum, rule, detail: detail.slice(0, 400) });
      try { body(s, bad, notes, i); } catch (e: any) { bad('threw', String(e?.stack ?? e)); }
      const back = contentChanged(start, snap(om));
      if (back.length) { bad('not back at start', back.slice(0, 5).join(',')); setup(); }
    });
    const seconds = Math.round((performance.now() - t0) / 1000);
    reports[name] = { samples: samples.length, byStratum, violations: sink, notes, seconds };
    const rules: Record<string, number> = {};
    for (const v of sink) rules[v.rule] = (rules[v.rule] ?? 0) + 1;
    console.log(`${name}: ${samples.length} samples ${JSON.stringify(byStratum)}, ${sink.length} violations ${JSON.stringify(rules)}, notes ${JSON.stringify(notes)}, ${seconds} s`);
    for (const v of sink.slice(0, 30)) console.log(JSON.stringify(v));
    return sink;
  };
  const diffText = (a: Snap, b: Snap, ids: string[]) => ids.slice(0, 5).map(id => `${id}: ${fieldsChanged(a.get(id), b.get(id))}`).join('; ');

  it.runIf(OPS.has('flyover-elevation'))('draw a flyover across a road, then change its deck elevation: undo/redo of both exact, nothing else changes', () => {
    const samples = stratifiedSample(roadsOf(om), Math.min(N, 100), 909);
    const sink = loop('flyover-elevation', samples, (s, bad, notes) => {
      const r = sel(s.id);
      // A 160 m flyover centred on the road's middle, at right angles to it, its ends clicked on open ground
      const c = r.coordinates, m = Math.max(0, Math.floor((c.length - 2) / 2));
      const p = c[m], q = c[m + 1];
      const kx = Math.cos(p[1] * Math.PI / 180);
      const dx = (q[0] - p[0]) * kx, dy = q[1] - p[1], len = Math.hypot(dx, dy) || 1e-9;
      const h = 80 / 111320, mid = [(p[0] + q[0]) / 2, (p[1] + q[1]) / 2];
      const A: [number, number, number] = [mid[0] - (dy / len) * h / kx, mid[1] + (dx / len) * h, 0], B: [number, number, number] = [mid[0] + (dy / len) * h / kx, mid[1] - (dx / len) * h, 0];
      const s0 = snap(om);
      editing.setMode('draw_flyover');
      editing.addDrawingPoint(A); editing.addDrawingPoint(B);
      const ids0 = new Set(s0.keys());
      editing.finalizeDrawing('base');
      editing.setMode('select');
      const s1 = snap(om), k1 = keyOf(om);
      const fly = [...s1.values()].find(o => !ids0.has(o.id));
      if (!fly) { bad('no flyover', ''); return; }
      const changed = contentChanged(s0, s1).filter(id => id !== fly.id);
      for (const id of changed) {
        const f = fieldsChanged(s0.get(id), s1.get(id));
        if (f.every(x => x === 'coordinates' || x === 'sections')) notes.roadsSplitAtFlyoverEnds = (notes.roadsSplitAtFlyoverEnds ?? 0) + 1;
        else notes[`surface road fields ${f}`] = (notes[`surface road fields ${f}`] ?? 0) + 1;
      }
      if (k1 === startKey) bad('key unchanged by drawing', '');
      history.undo();
      const u = contentChanged(s0, snap(om));
      if (u.length) bad('undo draw not identical', diffText(s0, snap(om), u));
      if (keyOf(om) !== startKey) bad('undo draw key', '');
      history.redo();
      const rd = contentChanged(s1, snap(om));
      if (rd.length) bad('redo draw not identical', diffText(s1, snap(om), rd));
      if (keyOf(om) !== k1) bad('redo draw key', '');
      // Deck elevation, as the properties panel edits it (flyoverFieldUpdates, one coalesced update)
      const cur = om.getById(fly.id)!;
      const updates = flyoverFieldUpdates(cur, 'elevation', 9);
      const merged = { ...cur, ...updates } as CityObject;
      history.recordUpdate(cur, merged, `Update ${cur.name} elevation`, `${cur.id}:elevation`);
      om.update(cur.id, updates);
      const s2 = snap(om), k2 = keyOf(om);
      const e = contentChanged(s1, s2);
      if (e.join() !== fly.id) bad('elevation changed more than the flyover', diffText(s1, s2, e.filter(x => x !== fly.id)));
      if (k2 === k1) notes.keyUnchangedByElevation = (notes.keyUnchangedByElevation ?? 0) + 1;
      history.undo();
      if (contentChanged(s1, snap(om)).length) bad('undo elevation not identical', diffText(s1, snap(om), contentChanged(s1, snap(om))));
      history.redo();
      if (contentChanged(s2, snap(om)).length) bad('redo elevation not identical', '');
      // Deleting the flyover gives the surface roads their capacity back; only the roads split at its ends keep a change
      deleteWithHistory(om, history, fly.id);
      const s3 = snap(om);
      const splitAtEnds = new Set(changed.filter(id => fieldsChanged(s0.get(id), s1.get(id)).includes('coordinates')));
      const left = contentChanged(s0, s3).filter(id => !splitAtEnds.has(id));
      if (left.length) bad('flyover deleted: roads not as before it', diffText(s0, s3, left));
      history.undo();
      if (contentChanged(s2, snap(om)).length) bad('undo flyover delete not identical', diffText(s2, snap(om), contentChanged(s2, snap(om))));
      history.undo(); history.undo();
      if (keyOf(om) !== startKey) bad('undo both key', '');
    });
    expect(sink).toEqual([]);
  }, T);

  it.runIf(OPS.has('sequence'))('random sequences of 20 edits with undo and redo in between return to the identical start', () => {
    const runs = Number(process.env.VP_SEQ_RUNS ?? (DB ? 12 : 6));
    const clock = vi.spyOn(Date, 'now');
    let now = Date.parse('2026-11-09T12:00:00Z');
    clock.mockImplementation(() => (now += 5000)); // separate user actions: no coalescing of quick repeats
    const samples = Array.from({ length: runs }, (_, i) => ({ id: `run${i}`, stratum: 'mixed' }));
    const sink = loop('sequence', samples, (s, bad, notes, run) => {
      const rand = rng(31337 + run);
      const states: Snap[] = [snap(om)];
      const keys: string[] = [startKey];
      let pos = 0;
      const pickRoad = () => { const rs = roadsOf(om); return rs[Math.floor(rand() * rs.length)]; };
      for (let step = 0; step < 20; step++) {
        const kind = Math.floor(rand() * 7);
        const r = pickRoad();
        const field: LaneField = !r.isOneWay && rand() < 0.5 ? 'lanesBackward' : 'lanesForward';
        const cur = directionLanes(r, field);
        if (kind === 0) deleteWithHistory(om, history, r.id);
        else if (kind === 1 || kind === 2) commitRoadFieldEdit(om, history, { ...r }, field, cur <= 1 ? cur + 1 : cur - 1, kind === 1 ? 'segment' : 'carriageway', view);
        else if (kind === 3) commitRoadFieldEdit(om, history, { ...r }, 'speedLimit', SPEEDS.filter(x => x !== r.speedLimit)[step % 5], 'carriageway', view);
        else if (kind === 4) commitRoadFieldEdit(om, history, { ...r }, 'roadClass', CLASSES.filter(x => x !== r.roadClass)[step % 3], 'carriageway', view);
        else if (kind === 5) commitRoadFieldEdit(om, history, { ...r }, 'isOneWay', !r.isOneWay, 'carriageway', view);
        else {
          const g = findRoadEndGaps(r, roadGrid(om.getAll()).near([r.coordinates[0], r.coordinates[r.coordinates.length - 1]]))[0];
          if (g) editing.connectRoadEnd(g, roadGrid(om.getAll()).near([r.coordinates[0], r.coordinates[r.coordinates.length - 1]]));
          else deleteWithHistory(om, history, r.id);
        }
        notes[`op${kind}`] = (notes[`op${kind}`] ?? 0) + 1;
        states.length = pos + 1; keys.length = pos + 1;
        states.push(snap(om)); keys.push(keyOf(om)); pos++;
        if (history.getUndoStackCount() < pos) bad('undo steps', `${history.getUndoStackCount()} < ${pos} at step ${step}`);
        // Now and then a few undos and redos
        if (rand() < 0.35) {
          const moves = 1 + Math.floor(rand() * 4);
          for (let m = 0; m < moves; m++) {
            if (rand() < 0.6 && pos > 0) { history.undo(); pos--; } else if (pos < states.length - 1) { history.redo(); pos++; } else continue;
            const d = contentChanged(states[pos], snap(om));
            if (d.length) bad('state after undo/redo', `step ${step} pos ${pos}: ${diffText(states[pos], snap(om), d)}`);
          }
          if (keyOf(om) !== keys[pos]) bad('key after undo/redo', `step ${step} pos ${pos}`);
        }
      }
      // Redo to the end of the branch, then undo everything
      while (pos < states.length - 1) { history.redo(); pos++; }
      const endDiff = contentChanged(states[pos], snap(om));
      if (endDiff.length) bad('end state after redo', diffText(states[pos], snap(om), endDiff));
      if (keyOf(om) !== keys[pos]) bad('end key after redo', '');
      while (pos > 0) {
        history.undo(); pos--;
        const d = contentChanged(states[pos], snap(om));
        if (d.length) { bad('state after undo', `pos ${pos}: ${diffText(states[pos], snap(om), d)}`); break; }
      }
      if (keyOf(om) !== startKey) bad('start key', '');
      if (deleted().size) bad('deleted list not empty at start', [...deleted()].slice(0, 5).join(','));
    });
    clock.mockRestore();
    expect(sink).toEqual([]);
  }, T);
});

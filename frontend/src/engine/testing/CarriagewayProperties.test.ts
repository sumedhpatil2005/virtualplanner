import { describe, it, expect } from 'vitest';
import fs from 'fs';
import path from 'path';
import type { RoadObject } from '../objects/types';
import { ObjectManager } from '../objects/ObjectManager';
import { HistoryManager } from '../history/HistoryManager';
import { laneEditPlan, laneEditPreview, type LaneField } from '../editing/roadEdits';
import { roadKeys } from '../simulation/roadSection';
import { checkCarriagewayScope, indexRoads, type Violation } from './carriagewayInvariants';

/**
 * "Entire carriageway" never changes an unrelated way (docs/OVERHAUL.md §21): for every named way of the
 * real OpenStreetMap roads round Sangamwadi Bridge (fixtures/sangamwadi.json), in each direction it has,
 * the scope holds only the same road, of the same kind (one-way or two-way), contiguous in the direction of
 * travel, no slip road unless the selected way is one, never the opposite carriageway, no main road of
 * another name met at a joint, no fork (a flyover and its at-grade road, a slip road of the same name); the
 * preview is exactly what the edit changes, and an edit and its undo leave every other way byte-identical.
 *
 * With VP_OBJECTS set to an export of a project database (an array of /api/objects rows), the same checks
 * run on 200 random arterial and highway ways of it (seeded, so the sample is repeatable).
 */
const fx = JSON.parse(fs.readFileSync(path.join(__dirname, 'fixtures/sangamwadi.json'), 'utf8')) as { roads: RoadObject[] };

function cases(roads: readonly RoadObject[], ids: readonly string[]) {
  const out: [string, LaneField][] = [];
  for (const id of ids) {
    const r = roads.find(x => x.id === id)!;
    if (roadKeys(r).size === 0) continue;
    out.push([id, 'lanesForward']);
    if (!r.isOneWay) out.push([id, 'lanesBackward']);
  }
  return out;
}

function checkAll(roads: readonly RoadObject[], ids: readonly string[]) {
  const idx = indexRoads(roads);
  const violations: Violation[] = [];
  const cs = cases(roads, ids);
  let multi = 0;
  for (const [id, field] of cs) {
    violations.push(...checkCarriagewayScope(roads, idx, id, field));
    if (laneEditPreview(roads, id, field).count > 1) multi++;
  }
  return { violations, cases: cs.length, multi };
}

describe('carriageway scope properties on real roads', () => {
  it('holds for every named way round Sangamwadi Bridge, both directions', () => {
    const roads = fx.roads.filter(r => r.type === 'road');
    const { violations, cases: n, multi } = checkAll(roads, roads.map(r => r.id));
    console.log(`Sangamwadi fixture: ${n} cases, ${multi} multi-piece, ${violations.length} violations`);
    for (const v of violations) console.log(JSON.stringify(v));
    expect(n).toBeGreaterThan(200);
    expect(multi).toBeGreaterThan(40); // the checks see real multi-piece carriageways, not only single ways
    expect(violations).toEqual([]);
  });

  it('an edit and its undo touch only the previewed ways (every other way byte-identical)', () => {
    const roads = fx.roads.filter(r => r.type === 'road');
    const sample = cases(roads, roads.map(r => r.id)).filter(([id, f]) => laneEditPreview(roads, id, f).count > 1).filter((_, i) => i % 7 === 0);
    expect(sample.length).toBeGreaterThan(5);
    for (const [id, field] of sample) {
      const om = new ObjectManager();
      om.addMultiple(structuredClone(roads), true);
      const history = new HistoryManager(om);
      const snapshot = () => new Map(om.getAll().map(o => [o.id, JSON.stringify({ ...o, updatedAt: undefined, createdAt: undefined })]));
      const before = snapshot();
      const preview = laneEditPreview(om.getAll() as RoadObject[], id, field);
      const plan = laneEditPlan(om.getAll() as RoadObject[], id, field, 4, r => om.synthesizeDefaultSections(r));
      const prior = plan.map(p => structuredClone(om.getById(p.id)!));
      history.pushDiff({ type: 'batch', diffs: plan.map((p, i) => ({ type: 'update', id: p.id, before: prior[i], after: { ...prior[i], ...p.updates } as RoadObject })), description: 'lanes' });
      for (const p of plan) om.update(p.id, p.updates, true);
      const after = snapshot();
      const changed = [...after].filter(([k, v]) => before.get(k) !== v).map(([k]) => k).sort();
      expect(changed, `${id} ${field}`).toEqual([...preview.roadIds].filter(x => before.get(x) !== after.get(x)).sort());
      expect(changed.every(x => preview.roadIds.includes(x)), `${id} ${field}`).toBe(true);
      history.undo();
      const undone = snapshot();
      expect([...undone].filter(([k, v]) => before.get(k) !== v).map(([k]) => k), `${id} ${field} undo`).toEqual([]);
    }
  });
});

describe.skipIf(!process.env.VP_OBJECTS)('carriageway scope properties on a project database', () => {
  it('holds for 200 random arterial and highway ways', () => {
    const data = JSON.parse(fs.readFileSync(process.env.VP_OBJECTS!, 'utf8')) as any[];
    const om = new ObjectManager();
    const objs = (om as any).objects as Map<string, any>;
    for (const o of data) {
      if (o.type !== 'road') continue;
      const u: any = { id: o.id, type: o.type, name: o.name, layerId: o.layerId, scenarioId: o.scenarioId, coordinates: o.coordinates, ...o.properties };
      om.syncRoadProperties(u);
      objs.set(u.id, u);
    }
    const roads = om.getAll() as RoadObject[];
    const main = roads.filter(r => (r.roadClass === 'arterial' || r.roadClass === 'highway') && roadKeys(r).size > 0).map(r => r.id).sort();
    let s = 20261106;
    const rnd = () => (s = (s * 1103515245 + 12345) % 2147483648) / 2147483648;
    const pick = new Set<string>();
    while (pick.size < Math.min(200, main.length)) pick.add(main[Math.floor(rnd() * main.length)]);
    const { violations, cases: n, multi } = checkAll(roads, [...pick]);
    console.log(`project database: ${pick.size} ways, ${n} cases, ${multi} multi-piece, ${violations.length} violations`);
    for (const v of violations) console.log(JSON.stringify(v));
    expect(violations).toEqual([]);
  }, 600000);
});

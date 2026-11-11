/**
 * Traffic Data Manager, engine side (docs/TRAFFIC_DATA.md). All counts are
 * SYNTHETIC fixtures, not observations.
 */
import { describe, it, expect } from 'vitest';
import { toPcu, vehPerHour, MissingPcuFactorError, forwardBearingLabel, minutesOf, type EngineCountRow, type PcuFactorSet } from '../data/trafficData';
import { checkCounts, roadDirectionFlow, countChecksCsv } from '../data/countValidation';
import { countsToConstraints, TAG_M31_TABLE5 } from '../data/odmeConstraints';
import { geh } from '../calibration/geh';

const IRC10: Pick<PcuFactorSet, 'factors' | 'name' | 'version'> = {
  name: 'IRC:106-1990 Table 1, 10%-and-above', version: 1,
  factors: { two_wheeler: 0.75, car: 1.0, auto_rickshaw: 2.0, lcv: 2.0, bus: 3.7, hcv: 3.7 },
};

const row = (o: Partial<EngineCountRow>): EngineCountRow => ({
  ref_kind: 'road_direction', road_id: 'osm_1', direction: 'fwd', junction_ref: null, approach_road_id: null, from_road_id: null, to_road_id: null,
  dataset_id: 'tds_syn_m', dataset_name: 'SYNTHETIC measured', kind: 'measured', role: 'validation', synthetic: true,
  day_type: 'weekday', count_date: null, hour: 9, period: '09:00–10:00', span: false, complete: true, minutes: 60,
  veh_h: 1000, pcu_h: null, pcu_set_name: null, class_counts: {}, ...o,
});

describe('PCU and rates', () => {
  it('converts a classified count with a named factor set', () => {
    expect(toPcu({ two_wheeler: 400, car: 200, bus: 10 }, IRC10)).toBeCloseTo(400 * 0.75 + 200 + 37);
  });
  it('refuses a class the set has no factor for (never guesses)', () => {
    expect(() => toPcu({ car: 1, other: 2 }, IRC10)).toThrow(MissingPcuFactorError);
    expect(toPcu({ car: 1, other: 0 }, IRC10)).toBe(1);
  });
  it('turns a period count into veh/h and rejects bad periods', () => {
    expect(vehPerHour(150, '08:00', '08:15')).toBe(600);
    expect(vehPerHour(150, '08:15', '08:00')).toBeNull();
    expect(minutesOf('24:00')).toBe(1440);
    expect(minutesOf('25:00')).toBeNull();
  });
  it('labels a road\'s drawn direction by compass', () => {
    expect(forwardBearingLabel([[73.85, 18.5], [73.86, 18.5]])).toEqual({ fwd: 'towards E', bwd: 'towards W' });
  });
});

describe('counts vs model (validation evidence)', () => {
  const flows = {
    areaLinkVph: new Map([['osm_1_seg_0_fwd', 800], ['osm_1_seg_1_fwd', 900], ['osm_1_seg_0_bwd', 300], ['osm_12_seg_0_fwd', 5000]]),
    linkVph: new Map([['osm_1_seg_1_fwd', 700]]),
  };
  it('reads the busiest piece per direction and does not confuse road osm_12 with osm_1', () => {
    expect(roadDirectionFlow(flows.areaLinkVph, 'osm_1', 'fwd')).toBe(900);
    expect(roadDirectionFlow(flows.areaLinkVph, 'osm_1', 'bwd')).toBe(300);
    expect(roadDirectionFlow(flows.areaLinkVph, 'osm_1', 'both')).toBe(1200);
    expect(roadDirectionFlow(flows.areaLinkVph, 'osm_9', 'fwd')).toBeNull();
  });
  it('gives observed, assigned, simulated and GEH per count, at the run hour only', () => {
    const r = checkCounts([row({}), row({ hour: 8, period: '08:00–09:00' }), row({ direction: 'bwd', veh_h: 300 })], flows, 9);
    expect(r.rows).toHaveLength(2);
    const fwd = r.rows[0];
    expect([fwd.observedVph, fwd.assignedVph, fwd.simulatedVph]).toEqual([1000, 900, 700]);
    expect(fwd.gehSimulated).toBeCloseTo(geh(700, 1000));
    expect(r.rows[1].simulatedVph).toBeNull(); // bwd is not in the corridor: unknown, not 0
    expect(r.rows[1].gehSimulated).toBeNull();
    expect(r.skipped[0].reason).toMatch(/run is for 09:00/);
    expect(r.assigned.n).toBe(2);
    expect(countChecksCsv(r).split('\n')).toHaveLength(3);
  });
  it('keeps measured and estimated rows apart (no averaging)', () => {
    const r = checkCounts([row({}), row({ dataset_id: 'tds_e', kind: 'estimated', veh_h: 1600 })], flows, 9);
    expect(r.rows.map(x => [x.count.kind, x.observedVph])).toEqual([['measured', 1000], ['estimated', 1600]]);
  });
  it('skips incomplete hours, weekend counts, turns and roads outside the area, with reasons', () => {
    const r = checkCounts([
      row({ complete: false, veh_h: null, minutes: 15 }), row({ day_type: 'sunday' }),
      row({ ref_kind: 'turn', road_id: null, direction: null, junction_ref: 'j', from_road_id: 'a', to_road_id: 'b' }), row({ road_id: 'osm_404' }),
    ], flows, 9);
    expect(r.rows).toHaveLength(0);
    expect(r.skipped.map(s => s.reason)).toEqual([
      expect.stringMatching(/incomplete hour \(15 min/), expect.stringMatching(/sunday count/), expect.stringMatching(/not compared yet/), 'road is not in this study area',
    ]);
  });
});

describe('ODME interface (counts → constraints)', () => {
  const edges = ['osm_1_seg_0_fwd', 'osm_1_seg_1_fwd', 'osm_1_seg_0_bwd'];
  it('uses calibration datasets only and holds validation datasets out', () => {
    const b = countsToConstraints([row({ role: 'calibration' }), row({ dataset_id: 'tds_v', role: 'validation' }), row({ dataset_id: 'tds_u', role: 'unused' })], edges, { hour: 9 });
    expect(b.constraints).toHaveLength(1);
    expect(b.constraints[0]).toMatchObject({ type: 'link', linkIds: ['osm_1_seg_0_fwd', 'osm_1_seg_1_fwd'], observed: 1000, kind: 'measured' });
    expect(b.heldOutDatasetIds).toEqual(['tds_v']);
  });
  it('needs explicit permission for estimated data and a PCU value for pcu/h', () => {
    const est = row({ role: 'calibration', kind: 'estimated' });
    expect(countsToConstraints([est], edges, { hour: 9 }).constraints).toHaveLength(0);
    expect(countsToConstraints([est], edges, { hour: 9, allowEstimated: true }).constraints[0]).toMatchObject({ kind: 'estimated' });
    expect(countsToConstraints([row({ role: 'calibration' })], edges, { hour: 9, unit: 'pcu/h' }).skipped[0].reason).toMatch(/no PCU/);
  });
  it('carries turning counts and the TAG M3.1 Table 5 limits', () => {
    const b = countsToConstraints([row({ role: 'calibration', ref_kind: 'turn', road_id: null, direction: null, junction_ref: 'ljunction:1', from_road_id: 'a', to_road_id: 'b' })], edges, { hour: 9 });
    expect(b.constraints[0]).toMatchObject({ type: 'turn', fromRoadId: 'a', toRoadId: 'b' });
    expect(TAG_M31_TABLE5.cellSlope).toEqual([0.98, 1.02]);
  });
});

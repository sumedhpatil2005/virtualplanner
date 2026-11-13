/**
 * View-model logic of the Projects & Reports workspaces (lib/planningProjects.ts, lib/planningReports.ts).
 * Object values are SYNTHETIC.
 */
import { describe, it, expect } from 'vitest';
import {
  draftFromObject, draftsFromChangeSet, isDraft, groupIssuesByClass, openActionableCount, otherSideLabel, staleState,
  staleReasonText, cardSummary, geometryBounds, zRangeText, type ChangeSetEntry,
} from '../../lib/planningProjects';
import { lastExport } from '../../lib/planningReports';
import type { ProjectIssue } from '../../lib/coordinationApi';

const obj = (type: string, properties: Record<string, unknown>, id = `${type}_1`): ChangeSetEntry =>
  ({ objectId: id, op: 'add', object: { id, type, name: `SYNTHETIC ${type}`, coordinates: [[73.8, 18.5, 0], [73.81, 18.5, 0]], properties } });

describe('proposal elements from an alternative', () => {
  it('flyover: underside from the design elevation, top UNKNOWN (never 0), hypothetical, width from the object', () => {
    const d = draftFromObject(obj('flyover', { width: 12, elevation: 6.5 }), 'scn_a', null);
    expect(isDraft(d)).toBe(true);
    if (!isDraft(d)) return;
    expect(d.input).toMatchObject({ kind: 'flyover', element_ref: 'flyover_1', scenario_id: 'scn_a', z_min_m: 6.5, z_max_m: null, width_m: 12, certainty: 'hypothetical', z_ref: 'ground' });
  });
  it('utility: depth is cover to crown; bottom only with a diameter; placeholder depth stays UNKNOWN', () => {
    const a = draftFromObject(obj('utility', { depth: 2, diameterMm: 600, depthCertainty: 'estimated' }), 's', null);
    const b = draftFromObject(obj('utility', { depth: 2 }), 's', null);
    const c = draftFromObject(obj('utility', { depth: 1.5, depthCertainty: 'unknown' }), 's', null);
    if (!isDraft(a) || !isDraft(b) || !isDraft(c)) throw new Error('expected drafts');
    expect([a.input.z_max_m, a.input.z_min_m, a.input.width_m, a.input.certainty]).toEqual([-2, -2.6, 0.6, 'estimated']);
    expect([b.input.z_max_m, b.input.z_min_m, b.input.width_m]).toEqual([-2, null, null]);
    expect([c.input.z_max_m, c.input.z_min_m, c.input.certainty]).toEqual([null, null, 'unknown']);
  });
  it('station uses platform level + height; road is at grade with depth UNKNOWN; building foundation UNKNOWN', () => {
    const s = draftFromObject(obj('metro_station', { elevation: 12, height: 8, width: 20 }), 's', 'v1');
    const r = draftFromObject(obj('road', {}), 's', null);
    const bl = draftFromObject(obj('building', { height: 30 }), 's', null);
    if (!isDraft(s) || !isDraft(r) || !isDraft(bl)) throw new Error('expected drafts');
    expect([s.input.z_min_m, s.input.z_max_m, s.input.scenario_version_id]).toEqual([12, 20, 'v1']);
    expect([r.input.z_min_m, r.input.z_max_m, r.input.width_m]).toEqual([null, 0, null]);
    expect([bl.input.z_min_m, bl.input.z_max_m]).toEqual([null, 30]);
    expect(r.basis.join(' ')).toMatch(/Width UNKNOWN/);
  });
  it('skips deletions, demand objects and already registered objects', () => {
    const changes: ChangeSetEntry[] = [
      obj('flyover', { elevation: 6 }, 'f1'), obj('zone', {}, 'z1'), { objectId: 'base_road_9', op: 'delete' },
      obj('utility', { depth: 1 }, 'u1'), { ...obj('road', { width: 10 }, 'base_road_3'), op: 'modify' },
    ];
    const { drafts, skipped } = draftsFromChangeSet(changes, 's', null, new Set(['s:u1']));
    expect(drafts.map(d => d.objectId)).toEqual(['f1', 'base_road_3']);
    expect(drafts[1].op).toBe('modify');
    expect(skipped.map(s => s.objectId).sort()).toEqual(['base_road_9', 'u1', 'z1']);
    expect(skipped.find(s => s.objectId === 'u1')?.reason).toMatch(/already registered/);
  });
});

const issue = (over: Partial<ProjectIssue>): ProjectIssue => ({
  id: 'c', run_id: 'r', project_a_id: 'A', element_a_id: 'e', segment_a: null, b_type: 'project_element', project_b_id: 'B', b_ref: 'eb', segment_b: null,
  class: 'potential_conflict', class_label: 'Potential conflict', horizontal_distance_m: 0, vertical_gap_m: null, certainty: 'unknown', reasons: [],
  permission_triggers: [], evidence: {}, status: 'open', status_by: null, status_note: null, status_at: null, status_carried_from: null, created_at: '',
  raised_by_project: 'A', other_project: 'B', run_stale: null, ...over,
});

describe('conflicts', () => {
  it('groups by class, most severe first, and counts only open conflict / potential conflict', () => {
    const list = [issue({ id: '1', class: 'vertically_separated' }), issue({ id: '2', class: 'conflict' }), issue({ id: '3' }),
      issue({ id: '4', status: 'acknowledged' }), issue({ id: '5', class: 'unknown_no_coverage' })];
    expect(groupIssuesByClass(list).map(g => [g.cls, g.items.length])).toEqual([['conflict', 1], ['potential_conflict', 2], ['vertically_separated', 1], ['unknown_no_coverage', 1]]);
    expect(openActionableCount(list)).toBe(2);
  });
  it('names the other side; a finding raised by the other project says so', () => {
    const names = { B: 'Metro ext' };
    expect(otherSideLabel(issue({}), names, 'A')).toBe('Project “Metro ext”');
    expect(otherSideLabel(issue({ raised_by_project: 'B', other_project: 'B' }), names, 'A')).toMatch(/raised by them/);
    expect(otherSideLabel(issue({ other_project: null, b_type: 'osm_metro', project_b_id: null }), names, 'A')).toMatch(/OpenStreetMap/);
  });
});

describe('staleness and cards', () => {
  it('null staleness is UNKNOWN, not current', () => {
    expect(staleState({ stale: null })).toBe('unknown');
    expect(staleState(null)).toBe('unknown');
    expect(staleState({ stale: false })).toBe('current');
    expect(staleState({ stale: true })).toBe('stale');
    expect(staleReasonText('other_project_changed:pp_1')).toBe('another project changed');
  });
  it('card summary counts alternatives, open conflicts, stale and unknown (latest detection run only)', () => {
    const s = cardSummary({
      links: [{ entity_type: 'scenario' }, { entity_type: 'scenario' }, { entity_type: 'dataset' }], elements: 3,
      issues: [issue({}), issue({ status: 'resolved' })],
      stale: { runs: [{ stale: true }], assessments: [{ stale: null }], coordination_runs: [{ stale: true }, { stale: true }] },
    });
    expect(s).toEqual({ alternatives: 2, elements: 3, openConflicts: 1, staleAssessments: 2, unknownStale: 1 });
  });
  it('bounds and z text never turn UNKNOWN into 0', () => {
    expect(geometryBounds({ type: 'LineString', coordinates: [[73.8, 18.5], [73.81, 18.52]] })).toEqual({ minLng: 73.8, minLat: 18.5, maxLng: 73.81, maxLat: 18.52 });
    expect(geometryBounds(null)).toBeNull();
    expect(zRangeText(null, null)).toBe('Depth UNKNOWN');
    expect(zRangeText(6.5, null)).toBe('bottom +6.5 m · top UNKNOWN');
    expect(zRangeText(-2.6, -2)).toBe('-2.6 to -2.0 m');
  });
});

describe('reports', () => {
  it('last generated = newest export event with that label; none = null (never)', () => {
    const ev = [
      { action: 'export', entity_type: 'project_report', label: 'PDF report', at: '2026-11-13T10:00:00' },
      { action: 'export', entity_type: 'project_report', label: 'PDF report', at: '2026-11-13T11:00:00' },
      { action: 'export', entity_type: 'project_report', label: 'CSV conflict summary', at: '2026-11-13T12:00:00' },
      { action: 'update', entity_type: 'project', label: 'PDF report', at: '2026-11-13T13:00:00' },
    ];
    expect(lastExport(ev, 'PDF report')).toBe('2026-11-13T11:00:00');
    expect(lastExport(ev, 'DOCX report')).toBeNull();
  });
});

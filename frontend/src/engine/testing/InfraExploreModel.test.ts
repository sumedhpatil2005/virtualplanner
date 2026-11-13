import { describe, expect, it } from 'vitest';
import { colorOf, featuresText, inspectorRows, intersects, loadedLine, orderLayers } from '../../components/explore/municipalModel';
import { otherSideEvidence, otherSideLabel } from '../../lib/planningProjects';
import type { InfraLayer } from '../../lib/infraApi';
import type { ProjectIssue } from '../../lib/coordinationApi';

// SYNTHETIC layer metadata and features (not Pune data)
const layer = (id: string, extra: Partial<InfraLayer> = {}): InfraLayer => ({
  id, title: id, group: 'Municipal infrastructure (PMC via OpenCity)', subgroup: 'Drainage & sewer', dataset_id: `ds_${id}`, dataset_dir: '/x',
  input_sha256: 'abc', publisher: 'SYNTHETIC publisher', via: 'SYNTHETIC portal', source_url: null,
  licence: 'SYNTHETIC licence. UrbanOS treats reuse as NON-COMMERCIAL', licence_url: null, source_updated: null, retrieved_at: '2026-11-13 21:48 IST',
  data_class: 'observed', suitability: 'screening', active: true, notes: '', feature_count: 3, bbox: null, available: true, ...extra,
});

describe('municipal layers (Explore)', () => {
  it('orders subgroups and puts the active version first', () => {
    const g = orderLayers([layer('wards_2017', { subgroup: 'Boundaries', active: false }), layer('wards_2025', { subgroup: 'Boundaries' }), layer('sewer')]);
    expect(g.map(x => x.subgroup)).toEqual(['Drainage & sewer', 'Boundaries']);
    expect(g[1].layers.map(l => l.id)).toEqual(['wards_2025', 'wards_2017']);
  });

  it('inspector shows provenance first; missing date is UNKNOWN, licence flagged, sewer depth marked DESIGN', () => {
    const r = inspectorRows(layer('sewer'), { _fid: 1, _ext_id: 'x', pipeline_i: 'SYN-1', invert_depth_min_m: 2.5, invert_depth_max_m: 3.2, diameter_m: 0.6 });
    const by = Object.fromEntries(r.provenance.map(x => [x.label, x]));
    expect(by['Source date'].value).toBe('UNKNOWN');
    expect(by['Source date'].tone).toBe('unknown');
    expect(by.Licence.tone).toBe('warn');
    expect(by.Class.value).toMatch(/Observed/);
    const a = Object.fromEntries(r.attributes.map(x => [x.label, x.value]));
    expect(a['Depth to invert']).toMatch(/DESIGN levels, unverified/);
    expect(a['Diameter']).toBe('600 mm');
    expect(inspectorRows(layer('sewer'), { _fid: 1, _ext_id: 'x', pipeline_d: '600' }).attributes.find(x => x.label === 'pipeline_d')!.value).toBe('600 mm (internal diameter)');
    expect(a['Quality level']).toMatch(/QL-D/);
    expect(a.pipeline_i).toBe('SYN-1');
  });

  it('building inspector: per-feature class, confidence and height UNKNOWN', () => {
    const r = inspectorRows(layer('buildings', { data_class: 'derived' }), { _fid: 2, _ext_id: 'q', source: 'ms_global_ml_buildings', source_id: 'q:1', data_class: 'inferred', confidence: null, status: 'ml_only_candidate', height_m: null });
    expect(r.provenance.find(x => x.label === 'Class')!.value).toMatch(/Inferred/);
    const a = Object.fromEntries(r.attributes.map(x => [x.label, x.value]));
    expect(a.Confidence).toMatch(/UNKNOWN/);
    expect(a.Height).toMatch(/UNKNOWN/);
    expect(a['OSM agreement']).toMatch(/not in OSM/);
    expect(colorOf('buildings', { source: 'osm' })).not.toBe(colorOf('buildings', { source: 'ms_global_ml_buildings' }));
  });

  it('status line reports the cap and the count not shown', () => {
    expect(loadedLine({ returned: 2000, total_in_bbox: 10450, not_shown: 8450, truncated: true, cap: 2000 })).toMatch(/8,450 more in view not shown/);
    expect(loadedLine({ returned: 0, total_in_bbox: 0, not_shown: 0, truncated: false, cap: 2000 })).toMatch(/not evidence/);
    expect(loadedLine({ returned: 1, total_in_bbox: 1, not_shown: 0, truncated: false, cap: 2000 })).toBe('1 feature in view');
    expect(intersects([74.5, 19, 74.6, 19.1], [73.7, 18.4, 74.05, 18.7])).toBe(false);
    expect(intersects([73.8, 18.5, 73.9, 18.6], [73.7, 18.4, 74.05, 18.7])).toBe(true);
    expect(intersects([0, 0, 1, 1], null)).toBe(true);
    expect(featuresText(44482)).toBe('44,482 features');
    expect(featuresText(null)).toBe('count UNKNOWN');
    expect(loadedLine({ returned: 0, total_in_bbox: null, not_shown: null, truncated: true, cap: 2000, too_large: true, message: 'Zoom in' })).toBe('Zoom in');
  });
});

describe('conflict evidence for buildings and PMC records', () => {
  const issue = (b_type: string, b: Record<string, unknown>) => ({ b_type, b_ref: 'r', other_project: null, raised_by_project: 'p', evidence: { b } }) as unknown as ProjectIssue;
  it('names source, class, confidence and UNKNOWN height for a building', () => {
    const i = issue('building', { source: 'google_open_buildings_v3', source_id: 'SYN', data_class: 'inferred', confidence: 0.81, osm_agreement: 'ml_only_candidate', height_m: null });
    expect(otherSideLabel(i, {}, 'p')).toBe('Possible building (ML footprint)');
    const e = otherSideEvidence(i)!;
    expect(e).toMatch(/Google Open Buildings/);
    expect(e).toMatch(/inferred/);
    expect(e).toMatch(/confidence 0.81 \(model score 0–1\)/);
    expect(e).toMatch(/height UNKNOWN/);
    expect(e).toMatch(/foundation depth UNKNOWN/);
  });
  it('shows QL-D and design-level depth for a sewer record; UNKNOWN when no levels', () => {
    const s = issue('subsurface_utility', { utility_type: 'sewer', external_id: 'SYN-1', quality_level: 'QL-D', source: 'PMC via OpenCity', z_max_m: -1.9, z_min_m: -3.2, levels_status: 'design, unverified' });
    expect(otherSideLabel(s, {}, 'p')).toBe('Sewer record SYN-1');
    expect(otherSideEvidence(s)).toMatch(/QL-D · z -1.90 to -3.20 m \(design, unverified\)/);
    const u = issue('subsurface_utility', { utility_type: 'storm_drain', quality_level: 'QL-D', source: 'PMC via OpenCity', z_max_m: null, z_min_m: null });
    expect(otherSideEvidence(u)).toMatch(/depth UNKNOWN/);
    expect(otherSideEvidence(issue('baseline_road', {}))).toBeNull();
  });
});

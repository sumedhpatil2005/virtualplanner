/**
 * Data catalogue view-model (components/data/dataCatalogueModel.ts). Fixtures are SYNTHETIC.
 */
import { describe, expect, it } from 'vitest';
import {
  UNKNOWN, bestDate, catalogueSummary, dataStatusValue, featureFailsValidation, filterDatasets, footprint, formatBytes, groupDatasets,
  groupFeatures, provenanceRows, qualitySummary,
} from '../../components/data/dataCatalogueModel';
import type { DsDataset, DsVersion, FeatureReadiness } from '../../lib/datasetsApi';

const version = (o: Partial<DsVersion> = {}): DsVersion => ({
  id: 'v1', dataset_id: 'd', version_label: 'v1', review_status: 'active', observation_start: null, observation_end: null,
  published_date: null, source_updated_date: null, retrieved_at: null, sha256: null, coverage_bbox: null, has_coverage_polygon: false,
  crs: null, resolution: null, format: null, size_bytes: null, data_class: null, suitability: null, accuracy_statement: '',
  licence_text: 'UNKNOWN', licence_url: '', http: {}, stats: {}, notes: '', origin: 'seed', origin_path: null, supersedes_id: null,
  reviewed_by: null, reviewed_at: null, review_note: null, created_at: null, quality_checks: [], ...o,
});
const ds = (o: Partial<DsDataset> = {}): DsDataset => ({
  id: 'd', title: 'SYNTHETIC dataset', description: '', theme: 'dem', source_id: null, source: null, catalogue_ref: null, backs_catalogue: [],
  recommended_sources: [], limitations: '', max_age_days: null, update_check: {}, origin: 'seed', status: 'not_acquired',
  active_version_id: null, pending_version_ids: [], version_count: 0, active_version: null, ...o,
});
const src = { id: 's', name: 'S', publisher: 'SYNTHETIC publisher', url: 'https://example.invalid', access_method: 'download', licence_text: 'X',
  licence_url: '', robots_notes: '', tos_notes: '', official: false, registration_required: false, notes: '', origin: 'seed' };

describe('provenance', () => {
  it('missing values render UNKNOWN, never blank or zero', () => {
    const rows = Object.fromEntries(provenanceRows(ds({ status: 'available', active_version: version() })));
    expect(rows.Publisher).toBe(UNKNOWN);
    expect(rows.CRS).toBe(UNKNOWN);
    expect(rows['Format · size']).toBe(`${UNKNOWN} · ${UNKNOWN}`);
    expect(rows.Licence).toBe('UNKNOWN');
    expect(rows.Class).toBe('not classified');
    expect(rows.Retrieved).toMatch(/never stored/);
  });
  it('best date prefers observation end, then source update, then publication', () => {
    expect(bestDate(version({ observation_end: '2026-11-01T21:21:36Z', published_date: '2020' }))).toEqual({ kind: 'data up to', value: '2026-11-01T21:21:36Z' });
    expect(bestDate(version({ published_date: '2008' }))).toEqual({ kind: 'published', value: '2008' });
    expect(bestDate(version())).toBeNull();
  });
  it('maps onto the shared DataStatus badge; not acquired / pending is "not imported"', () => {
    expect(dataStatusValue(ds())).toEqual({ status: 'not_imported' });
    expect(dataStatusValue(ds({ status: 'pending_review', active_version: null }))).toEqual({ status: 'not_imported' });
    const v = dataStatusValue(ds({ status: 'available', source: src, active_version: version({ observation_end: '2026-11-01', licence_text: 'ODbL 1.0' }) }));
    expect(v).toMatchObject({ status: 'available', source: 'SYNTHETIC publisher', date: 'data up to 2026-11-01', licence: 'ODbL 1.0' });
    const u = dataStatusValue(ds({ status: 'available', active_version: version() }));
    expect(u).toMatchObject({ status: 'available', source: '', date: '', licence: '' }); // DataStatus shows "unknown" for each
  });
  it('formats sizes; null is UNKNOWN', () => {
    expect(formatBytes(221868283)).toBe('212 MB');
    expect(formatBytes(null)).toBe(UNKNOWN);
  });
});

describe('coverage footprint', () => {
  it('unknown coverage draws nothing', () => {
    expect(footprint(null)).toMatchObject({ kind: 'none', rect: null, percentOfPune: null });
  });
  it('a coverage larger than the frame covers it, 100% of the study box', () => {
    const f = footprint([67.3, 14.37, 80.9, 25.45]);
    expect(f.kind).toBe('covers');
    expect(f.percentOfPune).toBe(100);
    expect(f.rect).toEqual({ x: 0, y: 0, w: 200, h: 160 });
  });
  it('partial coverage is clipped and its share of the study box is reported', () => {
    const f = footprint([73.72, 18.49, 73.89, 18.6215]);
    expect(f.kind).toBe('partial');
    expect(f.percentOfPune).toBeGreaterThan(20);
    expect(f.percentOfPune).toBeLessThan(25);
    expect(f.rect!.w).toBeGreaterThan(0);
  });
  it('a coverage elsewhere is outside', () => {
    expect(footprint([72.8, 18.9, 73.0, 19.1]).kind).toBe('outside');
  });
});

describe('catalogue grouping', () => {
  const list = [
    ds({ id: 'a', title: 'B title', status: 'available', active_version: version({ data_class: 'observed' }) }),
    ds({ id: 'b', title: 'A title', status: 'available', active_version: version() }),
    ds({ id: 'c', status: 'synthetic', theme: 'demo_seed' }),
    ds({ id: 'd', status: 'not_acquired', title: 'Flood lines', theme: 'flood_lines' }),
  ];
  it('groups by status in honesty order, sorted by title, empty groups dropped', () => {
    const g = groupDatasets(list);
    expect(g.map(x => x.status)).toEqual(['available', 'synthetic', 'not_acquired']);
    expect(g[0].items.map(d => d.id)).toEqual(['b', 'a']);
  });
  it('filters by text and theme', () => {
    expect(filterDatasets(list, 'flood', null).map(d => d.id)).toEqual(['d']);
    expect(filterDatasets(list, '', 'demo_seed').map(d => d.id)).toEqual(['c']);
  });
  it('summarises counts', () => {
    expect(catalogueSummary(list)).toEqual({ available: 2, synthetic: 1, pending_review: 0, not_acquired: 1, total: 4 });
  });
  it('quality summary: worst is fail > warn > unknown > pass; not_applicable ignored', () => {
    const q = (status: 'pass' | 'warn' | 'fail' | 'unknown' | 'not_applicable') => ({ check: status, status, value: null, detail: '', run_at: null });
    expect(qualitySummary([q('pass'), q('warn'), q('fail')]).worst).toBe('fail');
    expect(qualitySummary([q('pass'), q('unknown')]).worst).toBe('unknown');
    expect(qualitySummary([q('not_applicable')]).worst).toBeNull();
  });
});

describe('features', () => {
  const f = (o: Partial<FeatureReadiness>): FeatureReadiness => ({
    id: 'x', workspace: 'simulate', capability: 'Traffic', name: 'x', description: '', status: 'blocked', capped: false,
    status_cap: null, status_cap_reason: null, reasons: [], dependencies: [], ...o,
  });
  it('groups by capability in the fixed order with counts', () => {
    const g = groupFeatures([f({ id: 't', status: 'partial' }), f({ id: 'e', capability: 'Explore', status: 'ready' }), f({ id: 'z', capability: 'Zeta' })]);
    expect(g.map(x => x.capability)).toEqual(['Explore', 'Traffic', 'Zeta']);
    expect(g[1].counts).toEqual({ ready: 0, partial: 1, blocked: 0 });
  });
  it('flags the traffic validation failure for the trust badge', () => {
    expect(featureFailsValidation(f({ status_cap_reason: 'Model FAILS validation (TAG M3.1: 0 of 15 …)' }))).toBe(true);
    expect(featureFailsValidation(f({}))).toBe(false);
  });
});

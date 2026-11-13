import { describe, expect, it, vi } from 'vitest';
import { otherSideLabel, recordRef, sideBLabel, sideBRefShown } from '../../lib/planningProjects';
import { baseImageryErrorMessage, watchImageryErrors } from '../../lib/baseImageryErrors';
import type { ProjectIssue } from '../../lib/coordinationApi';

const f = (b_type: string, b_ref: string, b: Record<string, unknown> = {}) => ({ b_type, b_ref, evidence: { b } }) as never;

describe('side B labels (Underground conflict check + Projects conflicts)', () => {
  it('layer-level rows name the layer in words, never the raw id', () => {
    expect(sideBLabel(f('layer', 'building'))).toBe('Layer: Building footprints');
    expect(sideBLabel(f('layer', 'subsurface_utility'))).toBe('Layer: Utility records');
    expect(sideBLabel(f('layer', 'baseline_road'))).toBe('Layer: Existing roads (base city)');
    expect(sideBLabel(f('layer', 'osm_metro'))).toBe('Layer: Existing metro (OpenStreetMap)');
    expect(sideBLabel(f('layer', 'some_new_layer'))).toBe('Layer: some new layer');
    expect(sideBRefShown(f('layer', 'building'))).toBe(false);
  });
  it('pair rows: buildings and utility records in words; the ref is still shown for buildings', () => {
    expect(sideBLabel(f('building', 'bld_1', { source: 'osm' }))).toBe('Existing building (OSM footprint)');
    expect(sideBLabel(f('building', 'bld_2', { source: 'google_open_buildings_v3' }))).toBe('Possible building (ML footprint)');
    expect(sideBLabel(f('subsurface_utility', 'u1', { utility_type: 'sewer', external_id: 'S-9' }))).toBe('Sewer record S-9');
    expect(sideBLabel(f('project_element', 'pel_1'))).toBe('Other project element');
    // GeoServer feature ids (layer.N) read as a record number, not the raw layer id (QA 2026-11-14)
    expect(sideBLabel(f('subsurface_utility', 'u2', { utility_type: 'storm_drain', external_id: 'pmc_storm_water_drains.631' }))).toBe('Storm drain record #631');
    expect(recordRef('ND-CO-27413')).toBe('ND-CO-27413');
    expect(sideBRefShown(f('building', 'bld_1'))).toBe(true);
  });
  it('Projects keeps project names first', () => {
    const i = { ...f('layer', 'building'), other_project: null, raised_by_project: 'p' } as unknown as ProjectIssue;
    expect(otherSideLabel(i, {}, 'p')).toBe('Layer: Building footprints');
  });
});

describe('base imagery errors', () => {
  const coll = () => {
    const listeners: ((l: unknown) => void)[] = [];
    const mk = () => { const fns: ((e: unknown) => void)[] = []; return { errorEvent: { addEventListener: (fn: (e: unknown) => void) => fns.push(fn) }, fire: (e: unknown) => fns.forEach(x => x(e)) }; };
    const first = mk();
    return { first, mk, c: { length: 1, get: () => first, layerAdded: { addEventListener: (fn: (l: unknown) => void) => { listeners.push(fn); return () => {}; } } }, add: (l: unknown) => listeners.forEach(x => x(l)) };
  };
  it('reports a failed base layer once, in words, for current and later layers', () => {
    const t = coll(); const notify = vi.fn();
    watchImageryErrors(t.c as never, notify);
    t.first.fire({ statusCode: 401 });
    const later = t.mk(); t.add(later); later.fire({ statusCode: 500 });
    expect(notify).toHaveBeenCalledTimes(1);
    expect(notify.mock.calls[0][0]).toMatch(/HTTP 401.*VITE_CESIUM_ION_TOKEN/);
  });
  it('messages for other failures', () => {
    expect(baseImageryErrorMessage({ statusCode: 503 })).toMatch(/HTTP 503/);
    expect(baseImageryErrorMessage(new Error('x'))).toMatch(/no response/);
  });
});

describe('Explore inspector dates', () => {
  it('ISO timestamps are shown in words with their zone', async () => {
    const { readableWhen } = await import('../../components/explore/municipalModel');
    expect(readableWhen('2026-11-13T21:33:43+05:30')).toBe('2026-11-13 21:33 IST (UTC+05:30)');
    expect(readableWhen('2025-11-25T15:53:16.852943 UTC (CKAN last_modified)')).toBe('2025-11-25 15:53 UTC (CKAN last_modified)');
    expect(readableWhen('2025-01-02T03:04:05Z')).toBe('2025-01-02 03:04 UTC');
    expect(readableWhen('Fri 2026-11-13 9:48 PM IST (UTC+05:30)')).toBe('Fri 2026-11-13 9:48 PM IST (UTC+05:30)');
  });
});

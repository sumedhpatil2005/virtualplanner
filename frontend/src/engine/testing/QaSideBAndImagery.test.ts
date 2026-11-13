import { describe, expect, it, vi } from 'vitest';
import { otherSideLabel, sideBLabel, sideBRefShown } from '../../lib/planningProjects';
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

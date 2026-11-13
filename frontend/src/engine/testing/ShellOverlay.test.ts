import { describe, it, expect, beforeEach, vi } from 'vitest';

vi.mock('../TwinCityEngine', () => ({ engineInstance: { setAppMode: () => {} } }));
import { dualOverlay, useShellStore, DUAL_OVERLAY_MIN_WIDTH } from '../../shell/useShellStore';

/** Tablet layout rules of the shell (docs/urbanos/SHELL_AND_DESIGN_SYSTEM.md §4). */
const reset = (over: Partial<ReturnType<typeof useShellStore.getState>>) =>
  useShellStore.setState({ contextOpen: true, inspectorOpen: false, drawerOpen: false, workspace: 'explore', viewport: 'tablet', width: 1024, ...over });

describe('shell overlay rules', () => {
  beforeEach(() => reset({}));

  it('allows context + inspector together only on wide tablets in the dual workspaces', () => {
    expect(dualOverlay('desktop', 1440, 'projects')).toBe(true);
    expect(dualOverlay('tablet', 1024, 'explore')).toBe(true);
    expect(dualOverlay('tablet', 1024, 'design')).toBe(true);
    expect(dualOverlay('tablet', 1024, 'environment')).toBe(true);
    expect(dualOverlay('tablet', 1024, 'projects')).toBe(false);
    expect(dualOverlay('tablet', 1024, 'simulate')).toBe(false);
    expect(dualOverlay('tablet', DUAL_OVERLAY_MIN_WIDTH - 1, 'explore')).toBe(false);
    expect(dualOverlay('phone', 390, 'explore')).toBe(false);
  });

  it('keeps the context panel when the inspector opens on a 1024 px tablet in Environment', () => {
    reset({ workspace: 'environment' });
    useShellStore.getState().setInspectorOpen(true);
    const s = useShellStore.getState();
    expect([s.contextOpen, s.inspectorOpen]).toEqual([true, true]);
  });

  it('one overlay at a time on a portrait tablet; a selection keeps Explore/Environment panels', () => {
    reset({ width: 768 });
    useShellStore.getState().revealSelection();
    expect([useShellStore.getState().contextOpen, useShellStore.getState().inspectorOpen]).toEqual([true, false]);
    reset({ width: 768, workspace: 'design' });
    useShellStore.getState().revealSelection();
    expect([useShellStore.getState().contextOpen, useShellStore.getState().inspectorOpen]).toEqual([false, true]);
  });

  it('on a phone the drawer and the sheets are mutually exclusive', () => {
    reset({ viewport: 'phone', width: 390, workspace: 'underground' });
    useShellStore.getState().setDrawerOpen(true);
    let s = useShellStore.getState();
    expect([s.drawerOpen, s.contextOpen, s.inspectorOpen]).toEqual([true, false, false]);
    s.setContextOpen(true);
    s = useShellStore.getState();
    expect([s.drawerOpen, s.contextOpen]).toEqual([false, true]);
  });
});

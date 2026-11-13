import { create } from 'zustand';
import { engineInstance } from '../engine/TwinCityEngine';
import { modeForWorkspace, type WorkspaceId } from './workspaces';

export type Viewport = 'phone' | 'tablet' | 'laptop' | 'desktop';

/** Breakpoints from PRODUCT_UX_RESEARCH §5.4: <768 phone (bottom sheet), 768–1024 tablet (one overlay), 1025–1279 laptop. */
export function viewportFor(width: number): Viewport {
  return width < 768 ? 'phone' : width <= 1024 ? 'tablet' : width < 1280 ? 'laptop' : 'desktop';
}

/** Tablet and phone: only one of context panel / inspector may cover the map at a time (see dualOverlay). */
const oneAtATime = (v: Viewport) => v === 'phone' || v === 'tablet';

/**
 * Workspaces whose workflow needs the context panel and the inspector together (Explore search → details, Environment
 * "Screen this proposal" on the selection, Design / Underground tool + properties). Projects (432 px context) and
 * Simulate (study panel is the inspector) keep the one-overlay rule.
 */
export const DUAL_OVERLAY_WORKSPACES: readonly WorkspaceId[] = ['explore', 'design', 'underground', 'environment'];
/** Minimum window width for both overlays at tablet size: rail 72 + context 296 + inspector ≤ 352 leaves ≥ 280 px of map. */
export const DUAL_OVERLAY_MIN_WIDTH = 1000;
/** Workspaces whose context panel shows the selected object itself, so a selection need not close it on one-overlay sizes. */
export const SUMMARY_IN_CONTEXT: readonly WorkspaceId[] = ['explore', 'environment'];

/** True when context panel and inspector may both be open over the map (always on laptop/desktop, where they dock). */
export function dualOverlay(v: Viewport, width: number, ws: WorkspaceId): boolean {
  if (!oneAtATime(v)) return true;
  return v === 'tablet' && width >= DUAL_OVERLAY_MIN_WIDTH && DUAL_OVERLAY_WORKSPACES.includes(ws);
}

export interface ShellState {
  workspace: WorkspaceId;
  contextOpen: boolean;
  inspectorOpen: boolean;
  drawerOpen: boolean;
  drawerTab: string | null;
  paletteOpen: boolean;
  viewport: Viewport;
  /** Window width in CSS px (for the tablet dual-overlay rule). */
  width: number;
  /** A planning project the command palette asked the Projects workspace to open. */
  openProjectId: string | null;
  projectsTab: 'projects' | 'data';

  /** Switches workspace and drives engine.setAppMode (the only place the shell changes the engine mode). */
  /** context: 'toggle' (rail click: re-clicking the active workspace collapses its panel), 'open', or 'keep'. */
  setWorkspace: (ws: WorkspaceId, opts?: { context?: 'toggle' | 'open' | 'keep' }) => void;
  /** Mirrors an engine-initiated mode change into the shell without calling back into the engine. */
  syncWorkspace: (ws: WorkspaceId) => void;
  setContextOpen: (open: boolean) => void;
  toggleContext: () => void;
  setInspectorOpen: (open: boolean) => void;
  /** A new map selection: opens the inspector, unless the context panel already shows the selection on a one-overlay size. */
  revealSelection: () => void;
  setDrawerOpen: (open: boolean) => void;
  setDrawerTab: (tab: string) => void;
  setPaletteOpen: (open: boolean) => void;
  setViewport: (v: Viewport, width?: number) => void;
  openProject: (id: string | null) => void;
  setProjectsTab: (t: 'projects' | 'data') => void;
}

const initialWidth = typeof window === 'undefined' ? 1440 : window.innerWidth;
const initialViewport: Viewport = viewportFor(initialWidth);
/** Opening one overlay closes the other unless both are allowed here. */
const exclusive = (s: Pick<ShellState, 'viewport' | 'width' | 'workspace'>) => !dualOverlay(s.viewport, s.width, s.workspace);

const s0Width = () => (typeof window === 'undefined' ? 1440 : window.innerWidth);

export const useShellStore = create<ShellState>((set, get) => ({
  workspace: 'explore',
  // Phones start with the map clear; tablets show the context panel (one overlay); wider windows dock it.
  contextOpen: initialViewport !== 'phone',
  inspectorOpen: initialViewport === 'desktop',
  drawerOpen: false,
  drawerTab: null,
  paletteOpen: false,
  viewport: initialViewport,
  width: initialWidth,
  openProjectId: null,
  projectsTab: 'projects',

  setWorkspace: (ws, opts) => {
    const s = get();
    const sameWs = s.workspace === ws;
    const how = opts?.context ?? 'open';
    const contextOpen = how === 'keep' ? s.contextOpen : how === 'toggle' && sameWs ? !s.contextOpen : true;
    set({
      workspace: ws,
      contextOpen,
      inspectorOpen: contextOpen && exclusive({ ...s, workspace: ws }) ? false : s.inspectorOpen,
      drawerTab: sameWs ? s.drawerTab : null,
    });
    engineInstance.setAppMode(modeForWorkspace(ws));
  },
  syncWorkspace: ws => set(s => (s.workspace === ws ? s : { workspace: ws, drawerTab: null })),
  // Phone: the drawer, the context sheet and the inspector sheet share the space above the tab bar, so one at a time.
  setContextOpen: open => set(s => ({
    contextOpen: open,
    inspectorOpen: open && exclusive(s) ? false : s.inspectorOpen,
    drawerOpen: open && s.viewport === 'phone' ? false : s.drawerOpen,
  })),
  toggleContext: () => get().setContextOpen(!get().contextOpen),
  setInspectorOpen: open => set(s => ({
    inspectorOpen: open,
    contextOpen: open && exclusive(s) ? false : s.contextOpen,
    drawerOpen: open && s.viewport === 'phone' ? false : s.drawerOpen,
  })),
  revealSelection: () => {
    const s = get();
    if (s.contextOpen && exclusive(s) && SUMMARY_IN_CONTEXT.includes(s.workspace)) return;
    s.setInspectorOpen(true);
  },
  setDrawerOpen: open => set(s => (open && s.viewport === 'phone' ? { drawerOpen: true, contextOpen: false, inspectorOpen: false } : { drawerOpen: open })),
  setDrawerTab: tab => set({ drawerTab: tab }),
  setPaletteOpen: open => set({ paletteOpen: open }),
  setViewport: (v, width = s0Width()) => set(s => {
    if (s.viewport === v && s.width === width) return s;
    // Entering a one-overlay size with both open: keep the inspector (it holds the current selection)
    const both = s.contextOpen && s.inspectorOpen && !dualOverlay(v, width, s.workspace);
    return { viewport: v, width, contextOpen: both ? false : s.contextOpen };
  }),
  openProject: id => set({ openProjectId: id, projectsTab: 'projects' }),
  setProjectsTab: t => set({ projectsTab: t }),
}));

import { create } from 'zustand';
import { engineInstance } from '../engine/TwinCityEngine';
import { modeForWorkspace, type WorkspaceId } from './workspaces';

export type Viewport = 'phone' | 'tablet' | 'laptop' | 'desktop';

/** Breakpoints from PRODUCT_UX_RESEARCH §5.4: <768 phone (bottom sheet), 768–1024 tablet (one overlay), 1025–1279 laptop. */
export function viewportFor(width: number): Viewport {
  return width < 768 ? 'phone' : width <= 1024 ? 'tablet' : width < 1280 ? 'laptop' : 'desktop';
}

/** Tablet and phone: only one of context panel / inspector may cover the map at a time. */
const oneAtATime = (v: Viewport) => v === 'phone' || v === 'tablet';

export interface ShellState {
  workspace: WorkspaceId;
  contextOpen: boolean;
  inspectorOpen: boolean;
  drawerOpen: boolean;
  drawerTab: string | null;
  paletteOpen: boolean;
  viewport: Viewport;
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
  setDrawerOpen: (open: boolean) => void;
  setDrawerTab: (tab: string) => void;
  setPaletteOpen: (open: boolean) => void;
  setViewport: (v: Viewport) => void;
  openProject: (id: string | null) => void;
  setProjectsTab: (t: 'projects' | 'data') => void;
}

const initialViewport: Viewport = typeof window === 'undefined' ? 'desktop' : viewportFor(window.innerWidth);

export const useShellStore = create<ShellState>((set, get) => ({
  workspace: 'explore',
  // Phones start with the map clear; tablets show the context panel (one overlay); wider windows dock it.
  contextOpen: initialViewport !== 'phone',
  inspectorOpen: initialViewport === 'desktop',
  drawerOpen: false,
  drawerTab: null,
  paletteOpen: false,
  viewport: initialViewport,
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
      inspectorOpen: contextOpen && oneAtATime(s.viewport) ? false : s.inspectorOpen,
      drawerTab: sameWs ? s.drawerTab : null,
    });
    engineInstance.setAppMode(modeForWorkspace(ws));
  },
  syncWorkspace: ws => set(s => (s.workspace === ws ? s : { workspace: ws, drawerTab: null })),
  setContextOpen: open => set(s => ({ contextOpen: open, inspectorOpen: open && oneAtATime(s.viewport) ? false : s.inspectorOpen })),
  toggleContext: () => get().setContextOpen(!get().contextOpen),
  setInspectorOpen: open => set(s => ({ inspectorOpen: open, contextOpen: open && oneAtATime(s.viewport) ? false : s.contextOpen })),
  setDrawerOpen: open => set({ drawerOpen: open }),
  setDrawerTab: tab => set({ drawerTab: tab }),
  setPaletteOpen: open => set({ paletteOpen: open }),
  setViewport: v => set(s => {
    if (s.viewport === v) return s;
    // Entering a one-overlay size with both open: keep the inspector (it holds the current selection)
    const both = s.contextOpen && s.inspectorOpen && oneAtATime(v);
    return { viewport: v, contextOpen: both ? false : s.contextOpen };
  }),
  openProject: id => set({ openProjectId: id, projectsTab: 'projects' }),
  setProjectsTab: t => set({ projectsTab: t }),
}));

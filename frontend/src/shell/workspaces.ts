import { Map as MapIcon, PencilRuler, ArrowDownToLine, Leaf, Activity, FolderKanban, FileText, type LucideIcon } from 'lucide-react';
import type { AppMode } from '../engine/TwinCityEngine';

/** The seven workspaces (UX_ARCHITECTURE §2; names, icons and purposes from PRODUCT_UX_RESEARCH §2.2). */
export type WorkspaceId = 'explore' | 'design' | 'underground' | 'environment' | 'simulate' | 'projects' | 'reports';

export interface WorkspaceDef {
  id: WorkspaceId;
  /** Rail label (≤ 11 characters, always visible). */
  label: string;
  /** Full title, shown as the context panel title and in the command palette. */
  title: string;
  icon: LucideIcon;
  /** One-line purpose, used as the tooltip. */
  purpose: string;
  /** Hotkey shown in the palette: Alt+1…7. */
  key: string;
}

export const WORKSPACES: WorkspaceDef[] = [
  { id: 'explore', label: 'Explore', title: 'City Explorer', icon: MapIcon, purpose: 'Browse the city: layers and object details', key: '1' },
  { id: 'design', label: 'Design', title: 'Infrastructure Planning', icon: PencilRuler, purpose: 'Draw and edit proposed surface infrastructure; alternatives and versions', key: '2' },
  { id: 'underground', label: 'Underground', title: 'Underground Planning', icon: ArrowDownToLine, purpose: 'Utilities in the scene, their depth and how certain it is', key: '3' },
  { id: 'environment', label: 'Environment', title: 'Environmental Intelligence', icon: Leaf, purpose: 'Which environmental and constraint data exists, and which is unknown', key: '4' },
  { id: 'simulate', label: 'Simulate', title: 'Simulation & Analysis', icon: Activity, purpose: 'Study traffic around a road; test changes', key: '5' },
  { id: 'projects', label: 'Projects', title: 'Projects & Coordination', icon: FolderKanban, purpose: 'Planning projects, decisions, audit; traffic data', key: '6' },
  { id: 'reports', label: 'Reports', title: 'Reports', icon: FileText, purpose: 'Export the reports the backend can produce', key: '7' },
];

export const workspaceById = (id: WorkspaceId): WorkspaceDef => WORKSPACES.find(w => w.id === id)!;

/**
 * Engine contract (UX_ARCHITECTURE §2): design/underground → Build, simulate → Simulate, everything else → View.
 * Simulate still locks editing (the engine does that in setAppMode).
 */
export function modeForWorkspace(ws: WorkspaceId): AppMode {
  return ws === 'design' || ws === 'underground' ? 'build' : ws === 'simulate' ? 'simulate' : 'view';
}

/**
 * The reverse direction, for engine-initiated mode changes (Simulate's close button, "Edit in Build" from a
 * Simulate problem, Esc in Simulate). Returns null when the current workspace already fits the mode.
 */
export function workspaceForMode(mode: AppMode, current: WorkspaceId): WorkspaceId | null {
  if (modeForWorkspace(current) === mode) return null;
  return mode === 'build' ? 'design' : mode === 'simulate' ? 'simulate' : 'explore';
}

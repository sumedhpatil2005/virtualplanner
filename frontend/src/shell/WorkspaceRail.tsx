import React, { useRef } from 'react';
import { WORKSPACES, type WorkspaceId } from './workspaces';
import { useShellStore } from './useShellStore';

/**
 * Workspace rail: icon + always-visible short label (PRODUCT_UX_RESEARCH §2.2, §5.5). Up/Down (Left/Right on the phone
 * tab bar) move focus; Enter/Space activates. Re-clicking the active workspace collapses/expands its panel.
 * Projects keeps the old "Planning projects" pill's data-testid (open-planning).
 */
export const WorkspaceRail: React.FC = () => {
  const workspace = useShellStore(s => s.workspace);
  const contextOpen = useShellStore(s => s.contextOpen);
  const setWorkspace = useShellStore(s => s.setWorkspace);
  const refs = useRef<(HTMLButtonElement | null)[]>([]);
  const onKey = (e: React.KeyboardEvent, i: number) => {
    const n = WORKSPACES.length;
    const next = e.key === 'ArrowDown' || e.key === 'ArrowRight' ? (i + 1) % n : e.key === 'ArrowUp' || e.key === 'ArrowLeft' ? (i - 1 + n) % n : -1;
    if (next < 0) return;
    e.preventDefault();
    refs.current[next]?.focus();
  };
  return (
    <nav className="uos-rail" aria-label="Workspaces" data-coach="mode-switch">
      {WORKSPACES.map((w, i) => {
        const Icon = w.icon;
        const active = w.id === workspace;
        return (
          <button
            key={w.id}
            ref={el => { refs.current[i] = el; }}
            type="button"
            onClick={() => setWorkspace(w.id as WorkspaceId, { context: 'toggle' })}
            onKeyDown={e => onKey(e, i)}
            aria-current={active ? 'page' : undefined}
            aria-label={w.label}
            aria-expanded={active ? contextOpen : undefined}
            title={`${w.title}: ${w.purpose} (Alt+${w.key})`}
            data-testid={w.id === 'projects' ? 'open-planning' : `ws-${w.id}`}
            data-workspace={w.id}
            className={`uos-rail-btn ${active ? 'is-active' : ''}`}
          >
            <Icon size={20} aria-hidden />
            <span className="uos-rail-label">{w.label}</span>
          </button>
        );
      })}
    </nav>
  );
};

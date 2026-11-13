import React, { useEffect, useRef, useState } from 'react';
import { ChevronDown, GitFork, Keyboard, Search } from 'lucide-react';
import { engineInstance } from '../engine/TwinCityEngine';
import { ScenarioSelector } from '../components/ScenarioSelector';
import { ConnectionBadge } from '../components/ui/ConnectionBadge';
import { IconButton } from '../components/ui/IconButton';
import { TopBarTrustSlot } from './TopBarTrustSlot';
import { useShellStore } from './useShellStore';
import { workspaceById } from './workspaces';

const isMac = typeof navigator !== 'undefined' && /Mac|iPhone|iPad/.test(navigator.platform);

function useActiveScenarioName(): string {
  const [name, setName] = useState(() => engineInstance.scenarios.getActiveScenario()?.name ?? 'Base city');
  useEffect(() => engineInstance.scenarios.onChange(() => setName(engineInstance.scenarios.getActiveScenario()?.name ?? 'Base city')), []);
  return name;
}

/**
 * Alternative switcher. ScenarioSelector (which owns #scenario-select) is mounted exactly once: in Design's context
 * panel while that is open, otherwise in this popover on demand.
 */
const AlternativeChip: React.FC = () => {
  const name = useActiveScenarioName();
  const designVisible = useShellStore(s => s.workspace === 'design' && s.contextOpen);
  const [open, setOpen] = useState(false);
  const ref = useRef<HTMLDivElement>(null);
  useEffect(() => {
    if (!open) return;
    const onDown = (e: PointerEvent) => { if (ref.current && !ref.current.contains(e.target as Node) && !(e.target as Element).closest?.('[aria-modal="true"]')) setOpen(false); };
    const onKey = (e: KeyboardEvent) => { if (e.key === 'Escape') setOpen(false); };
    window.addEventListener('pointerdown', onDown);
    window.addEventListener('keydown', onKey);
    return () => { window.removeEventListener('pointerdown', onDown); window.removeEventListener('keydown', onKey); };
  }, [open]);
  const onClick = () => {
    if (designVisible) { document.getElementById('uos-alternatives')?.scrollIntoView({ block: 'start', behavior: 'smooth' }); return; }
    setOpen(o => !o);
  };
  return (
    <div className="relative min-w-0" ref={ref}>
      <button type="button" onClick={onClick} aria-expanded={open && !designVisible} aria-haspopup="dialog" data-testid="alternative-switcher"
        title="Active alternative: switch, create, compare with the base city, versions" className="uos-chip">
        <GitFork size={14} aria-hidden className="text-accent shrink-0" />
        <span className="text-meta text-text-2 hidden sm:inline">Alternative</span>
        <span className="text-label font-medium text-text-1 truncate max-w-[14rem]">{name}</span>
        <ChevronDown size={14} aria-hidden className="text-text-2 shrink-0" />
      </button>
      {open && !designVisible && (
        <div className="uos-popover" role="dialog" aria-label="Alternatives">
          <ScenarioSelector />
        </div>
      )}
    </div>
  );
};

export const TopBar: React.FC<{ onHelp: () => void; trust?: React.ReactNode }> = ({ onHelp, trust }) => {
  const workspace = useShellStore(s => s.workspace);
  const setPaletteOpen = useShellStore(s => s.setPaletteOpen);
  const ws = workspaceById(workspace);
  return (
    <header className="uos-topbar" aria-label="Top bar">
      <div className="flex items-center gap-2 min-w-0">
        <span className="uos-wordmark" aria-label="UrbanOS">Urban<span className="text-accent">OS</span></span>
        <span className="uos-ws-title hidden md:inline text-label text-text-2 truncate">{ws.title}</span>
      </div>
      <AlternativeChip />
      <button type="button" className="uos-search" onClick={() => setPaletteOpen(true)} aria-label="Search and commands" aria-keyshortcuts={isMac ? 'Meta+K' : 'Control+K'} data-testid="open-command-palette">
        <Search size={14} aria-hidden />
        <span className="uos-search-text" title="Search workspaces, tools, layers, alternatives and projects">Search tools, layers, projects…</span>
        <kbd className="uos-kbd">{isMac ? '⌘K' : 'Ctrl K'}</kbd>
      </button>
      <div className="flex items-center gap-1.5 ml-auto">
        <TopBarTrustSlot>{trust}</TopBarTrustSlot>
        <ConnectionBadge />
        <IconButton icon={Keyboard} label="Keyboard shortcuts" onClick={onHelp} size="sm" tooltip="left" />
      </div>
    </header>
  );
};

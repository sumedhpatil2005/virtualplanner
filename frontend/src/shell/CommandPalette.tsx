import React, { useEffect, useMemo, useRef, useState } from 'react';
import { Search, Layers as LayersIcon, GitFork, FolderKanban, Keyboard, Database, Eye, EyeOff, type LucideIcon } from 'lucide-react';
import { engineInstance } from '../engine/TwinCityEngine';
import { TOOLS } from '../components/tools';
import { planningApi, type Project } from '../engine/planning/planningApi';
import { WORKSPACES } from './workspaces';
import { useShellStore } from './useShellStore';

interface Command {
  id: string;
  group: 'Workspaces' | 'Tools' | 'Layers' | 'Alternatives' | 'Projects' | 'Actions';
  label: string;
  hint?: string;
  icon: LucideIcon;
  run: () => void;
}

const norm = (s: string) => s.toLowerCase();
/** Every query word must appear in the label or hint (simple, predictable matching). */
const matches = (c: Command, q: string) => {
  const hay = norm(`${c.label} ${c.hint ?? ''} ${c.group}`);
  return norm(q).split(/\s+/).filter(Boolean).every(w => hay.includes(w));
};

/**
 * Ctrl/⌘K palette (PRODUCT_UX_RESEARCH §1 "Command / locator search", QGIS locator). Every result performs a real
 * action: switch workspace, pick a tool (opens Design), toggle a layer, switch alternative, open a planning project
 * (fetched from the API when the palette opens), open traffic data, show shortcuts.
 */
export const CommandPalette: React.FC<{ onHelp: () => void }> = ({ onHelp }) => {
  const open = useShellStore(s => s.paletteOpen);
  const setOpen = useShellStore(s => s.setPaletteOpen);
  const [q, setQ] = useState('');
  const [active, setActive] = useState(0);
  const [projects, setProjects] = useState<Project[] | null>(null);
  const [projectsError, setProjectsError] = useState<string | null>(null);
  const inputRef = useRef<HTMLInputElement>(null);
  const listRef = useRef<HTMLUListElement>(null);
  const returnFocus = useRef<HTMLElement | null>(null);

  useEffect(() => {
    if (!open) return;
    returnFocus.current = document.activeElement as HTMLElement | null;
    setQ(''); setActive(0);
    setTimeout(() => inputRef.current?.focus(), 0);
    planningApi.projects().then(p => { setProjects(p); setProjectsError(null); }).catch((e: Error) => { setProjects([]); setProjectsError(e.message); });
    return () => { returnFocus.current?.focus?.(); };
  }, [open]);

  const commands = useMemo<Command[]>(() => {
    if (!open) return [];
    const st = useShellStore.getState();
    const out: Command[] = [];
    for (const w of WORKSPACES) out.push({ id: `ws:${w.id}`, group: 'Workspaces', label: w.label, hint: `${w.title} · Alt+${w.key}`, icon: w.icon, run: () => st.setWorkspace(w.id) });
    for (const t of TOOLS) out.push({
      id: `tool:${t.mode}`, group: 'Tools', label: t.label, hint: `${t.short}${t.hotkey ? ` · key ${t.hotkey}` : ''} · Design`, icon: t.icon,
      run: () => { st.setWorkspace('design'); engineInstance.editing.setMode(t.mode); },
    });
    for (const l of engineInstance.layers.getAll()) out.push({
      id: `layer:${l.id}`, group: 'Layers', label: `${l.visible ? 'Hide' : 'Show'} ${l.name}`, hint: 'layer', icon: l.visible ? EyeOff : Eye,
      run: () => engineInstance.layers.setVisibility(l.id, !l.visible),
    });
    const activeScenario = engineInstance.scenarios.getActiveScenarioId();
    for (const s of engineInstance.scenarios.getAll()) out.push({
      id: `alt:${s.id}`, group: 'Alternatives', label: `Switch to ${s.name}`, hint: s.id === activeScenario ? 'active' : s.isBase ? 'base city' : `proposal ${s.year}`, icon: GitFork,
      run: () => engineInstance.scenarios.setActiveScenario(s.id),
    });
    for (const p of projects ?? []) out.push({
      id: `proj:${p.id}`, group: 'Projects', label: `Open project ${p.name}`, hint: 'planning project', icon: FolderKanban,
      run: () => { st.setWorkspace('projects'); st.openProject(p.id); },
    });
    out.push({ id: 'act:data', group: 'Actions', label: 'Open traffic data', hint: 'counts, import', icon: Database, run: () => { st.setWorkspace('projects'); st.setProjectsTab('data'); } });
    out.push({ id: 'act:layers', group: 'Actions', label: 'Open layers', hint: 'Explore', icon: LayersIcon, run: () => st.setWorkspace('explore') });
    out.push({ id: 'act:help', group: 'Actions', label: 'Keyboard shortcuts', hint: '?', icon: Keyboard, run: onHelp });
    return out;
  }, [open, projects, onHelp]);

  const results = useMemo(() => (q.trim() ? commands.filter(c => matches(c, q)) : commands), [commands, q]);
  useEffect(() => { setActive(0); }, [q]);
  useEffect(() => { listRef.current?.querySelector<HTMLElement>(`[data-index="${active}"]`)?.scrollIntoView({ block: 'nearest' }); }, [active]);

  if (!open) return null;
  const run = (c: Command | undefined) => { if (!c) return; setOpen(false); c.run(); };
  const onKey = (e: React.KeyboardEvent) => {
    if (e.key === 'ArrowDown') { e.preventDefault(); setActive(i => Math.min(results.length - 1, i + 1)); }
    else if (e.key === 'ArrowUp') { e.preventDefault(); setActive(i => Math.max(0, i - 1)); }
    else if (e.key === 'Enter') { e.preventDefault(); run(results[active]); }
    else if (e.key === 'Escape') { e.preventDefault(); setOpen(false); }
  };

  let lastGroup = '';
  return (
    <div className="uos-palette-backdrop" onPointerDown={e => { if (e.target === e.currentTarget) setOpen(false); }}>
      <div className="uos-palette" role="dialog" aria-modal="true" aria-label="Command palette" data-testid="command-palette">
        <div className="uos-palette-input">
          <Search size={16} aria-hidden className="text-text-2" />
          <input ref={inputRef} value={q} onChange={e => setQ(e.target.value)} onKeyDown={onKey}
            role="combobox" aria-expanded="true" aria-controls="uos-palette-list" aria-activedescendant={results[active] ? `uos-cmd-${active}` : undefined}
            aria-label="Search workspaces, tools, layers, alternatives and projects" placeholder="Search workspaces, tools, layers, alternatives, projects…" />
        </div>
        <ul id="uos-palette-list" role="listbox" ref={listRef} className="uos-palette-list" aria-label="Results">
          {results.length === 0 && <li className="px-3 py-3 text-label text-text-2">No match.</li>}
          {results.map((c, i) => {
            const header = c.group !== lastGroup ? c.group : null;
            lastGroup = c.group;
            const Icon = c.icon;
            return (
              <React.Fragment key={c.id}>
                {header && <li role="presentation" className="uos-palette-group">{header}</li>}
                <li id={`uos-cmd-${i}`} role="option" aria-selected={i === active} data-index={i} data-command={c.id}
                  className={`uos-palette-item ${i === active ? 'is-active' : ''}`}
                  onPointerMove={() => setActive(i)} onClick={() => run(c)}>
                  <Icon size={16} aria-hidden className="shrink-0 text-text-2" />
                  <span className="flex-1 min-w-0 truncate text-body text-text-1">{c.label}</span>
                  {c.hint && <span className="text-meta text-text-3 truncate max-w-[45%]">{c.hint}</span>}
                </li>
              </React.Fragment>
            );
          })}
          {projectsError && <li role="presentation" className="px-3 py-2 text-meta text-warn">Planning projects unavailable ({projectsError}).</li>}
        </ul>
        <div className="uos-palette-foot text-meta text-text-3">↑↓ to move · Enter to run · Esc to close</div>
      </div>
    </div>
  );
};

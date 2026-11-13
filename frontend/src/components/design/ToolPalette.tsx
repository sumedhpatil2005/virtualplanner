import React, { useEffect, useRef, useState } from 'react';
import { ChevronDown, ChevronRight, Undo2, Redo2, X } from 'lucide-react';
import { engineInstance } from '../../engine/TwinCityEngine';
import type { EditingMode } from '../../engine/editing/EditingEngine';
import { TOOLS, TOOL_CATEGORIES, OPEN_TOOLBAR_EVENT, toolsInCategory, type ToolCategory } from '../tools';
import { AnchoredPopover } from '../ui/AnchoredPopover';
import { ToolSettings } from './ToolSettings';
import { ImportProgressOverlay } from './ImportAreaPanel';

const C = {
  text1: 'var(--text-1, #E6EAF0)', text2: 'var(--text-2, #A9B3C1)', text3: 'var(--text-3, #8B95A3)',
  surface1: 'var(--surface-1, #161B22)', surface2: 'var(--surface-2, #1E252E)', surface3: 'var(--surface-3, #283039)',
  border: 'var(--border, #333C47)', accent: 'var(--accent, #5AA2FF)',
};

/**
 * Design workspace tool palette (docs/urbanos/UX_ARCHITECTURE.md §3): tools in collapsible
 * categories, compact two-line buttons, tooltips with verb + noun, hotkey and what the tool
 * creates. The active tool's settings open in a popover beside the palette (fixed-position,
 * viewport-clamped), so they never cover another group and are never clipped by a scrolling
 * panel (CODE_UI_AUDIT §3). Only tools backed by a working EditingEngine mode are listed.
 *
 * Mount it in the Design context panel (any width ≥ 232 px); it fills its container's width.
 */
const ToolPalette: React.FC<{ className?: string }> = ({ className = '' }) => {
  const [activeMode, setActiveMode] = useState<EditingMode>('select');
  const [canUndo, setCanUndo] = useState(false);
  const [canRedo, setCanRedo] = useState(false);
  const [collapsed, setCollapsed] = useState<Set<ToolCategory>>(new Set());
  const [settingsOpen, setSettingsOpen] = useState(true);
  const rootRef = useRef<HTMLDivElement>(null);
  const [root, setRoot] = useState<HTMLDivElement | null>(null);
  const buttons = useRef(new Map<EditingMode, HTMLButtonElement>());

  useEffect(() => {
    setRoot(rootRef.current);
    const unsubEdit = engineInstance.editing.onChange(() => setActiveMode(engineInstance.editing.getMode()));
    const unsubHistory = engineInstance.history.onChange(() => {
      setCanUndo(engineInstance.history.canUndo());
      setCanRedo(engineInstance.history.canRedo());
    });
    setCanUndo(engineInstance.history.canUndo());
    setCanRedo(engineInstance.history.canRedo());
    setActiveMode(engineInstance.editing.getMode());
    const expandAll = () => setCollapsed(new Set());
    window.addEventListener(OPEN_TOOLBAR_EVENT, expandAll);
    return () => { unsubEdit(); unsubHistory(); window.removeEventListener(OPEN_TOOLBAR_EVENT, expandAll); };
  }, []);

  // A newly chosen tool always shows its settings (and its group)
  useEffect(() => {
    setSettingsOpen(true);
    const cat = TOOLS.find(t => t.mode === activeMode)?.category;
    if (cat) setCollapsed(c => { if (!c.has(cat)) return c; const n = new Set(c); n.delete(cat); return n; });
  }, [activeMode]);

  const choose = (mode: EditingMode) => {
    if (mode === activeMode && mode !== 'select') { setSettingsOpen(o => !o); return; }
    engineInstance.editing.setMode(mode);
  };
  const toggle = (c: ToolCategory) => setCollapsed(s => { const n = new Set(s); if (n.has(c)) n.delete(c); else n.add(c); return n; });
  const active = TOOLS.find(t => t.mode === activeMode);

  return (
    <div ref={rootRef} data-testid="tool-palette" data-coach="toolbar" aria-label="Design tools" role="toolbar" aria-orientation="vertical"
      className={`flex flex-col gap-1 rounded-lg border p-2 pointer-events-auto select-none ${className}`}
      style={{ background: C.surface1, borderColor: C.border, color: C.text1 }}>
      <div className="flex items-center justify-between px-1 pb-1">
        <span className="text-[11px] font-semibold uppercase tracking-wide" style={{ color: C.text3 }}>Design tools</span>
        <span className="flex items-center gap-0.5">
          <button type="button" onClick={() => engineInstance.history.undo()} disabled={!canUndo} title="Undo (Ctrl+Z)" aria-label="Undo" data-testid="tool-undo"
            className="h-7 w-7 inline-flex items-center justify-center rounded disabled:opacity-40 disabled:cursor-not-allowed cursor-pointer hover:bg-white/5" style={{ color: C.text2 }}><Undo2 size={15} /></button>
          <button type="button" onClick={() => engineInstance.history.redo()} disabled={!canRedo} title="Redo (Ctrl+Y)" aria-label="Redo" data-testid="tool-redo"
            className="h-7 w-7 inline-flex items-center justify-center rounded disabled:opacity-40 disabled:cursor-not-allowed cursor-pointer hover:bg-white/5" style={{ color: C.text2 }}><Redo2 size={15} /></button>
        </span>
      </div>
      {TOOL_CATEGORIES.map(cat => {
        const tools = toolsInCategory(cat.id);
        if (!tools.length) return null;
        const isCollapsed = collapsed.has(cat.id) && cat.id !== 'select';
        const hasActive = tools.some(t => t.mode === activeMode);
        return (
          <section key={cat.id} data-testid={`tool-group-${cat.id}`} className="flex flex-col">
            {cat.id !== 'select' && (
              <button type="button" onClick={() => toggle(cat.id)} aria-expanded={!isCollapsed}
                className="flex items-center gap-1 px-1 h-5 mt-1 text-[11px] font-semibold uppercase tracking-wide rounded cursor-pointer hover:bg-white/5 text-left"
                style={{ color: hasActive ? C.accent : C.text3 }}>
                {isCollapsed ? <ChevronRight size={12} aria-hidden="true" /> : <ChevronDown size={12} aria-hidden="true" />}
                {cat.label}
                {isCollapsed && <span className="ml-auto font-normal normal-case tracking-normal" style={{ color: C.text3 }}>{tools.length}</span>}
              </button>
            )}
            {!isCollapsed && (
              <div className="flex flex-wrap gap-1 pt-0.5">
                {tools.map(tool => {
                  const Icon = tool.icon;
                  const isActive = tool.mode === activeMode;
                  return (
                    <button key={tool.mode} type="button" ref={el => { if (el) buttons.current.set(tool.mode, el); else buttons.current.delete(tool.mode); }}
                      onClick={() => choose(tool.mode)} data-testid={`tool-${tool.mode}`} aria-label={tool.label} aria-pressed={isActive}
                      title={`${tool.label}${tool.hotkey ? ` (${tool.hotkey})` : ''}: ${tool.description}`}
                      className="inline-flex items-center gap-1.5 h-8 pl-2 pr-2 rounded-md border text-[12px] font-medium whitespace-nowrap cursor-pointer transition-colors"
                      style={isActive
                        ? { background: 'color-mix(in srgb, var(--accent, #5AA2FF) 22%, transparent)', borderColor: C.accent, color: C.text1 }
                        : { background: C.surface2, borderColor: 'transparent', color: C.text2 }}>
                      <Icon size={15} aria-hidden="true" style={isActive ? { color: C.accent } : undefined} />
                      {tool.shortLabel}
                      {tool.hotkey && <kbd className="text-[10px] font-normal tabular-nums" style={{ color: C.text3, fontFamily: 'inherit' }} aria-hidden="true">{tool.hotkey}</kbd>}
                    </button>
                  );
                })}
              </div>
            )}
          </section>
        );
      })}
      <AnchoredPopover anchor={root} alignTop={buttons.current.get(activeMode) ?? null} open={!!active && activeMode !== 'select' && settingsOpen}
        onClose={() => setSettingsOpen(false)} placement="right" width={activeMode === 'import_osm' ? 300 : 264}
        label={`${active?.label ?? ''} settings`} testId="tool-settings">
        {active && (
          <div className="flex flex-col gap-2">
            <div className="flex items-start justify-between gap-2 border-b pb-1.5" style={{ borderColor: C.border }}>
              <div className="flex items-center gap-1.5 min-w-0">
                <active.icon size={14} aria-hidden="true" style={{ color: C.accent }} />
                <span className="font-semibold text-[13px] truncate">{active.label}</span>
              </div>
              <button type="button" onClick={() => setSettingsOpen(false)} aria-label="Hide tool settings" title="Hide settings (click the tool again to show)"
                className="h-6 w-6 inline-flex items-center justify-center rounded cursor-pointer hover:bg-white/5 shrink-0" style={{ color: C.text2 }}><X size={14} /></button>
            </div>
            <p className="text-[11px] leading-snug" style={{ color: C.text3 }}>{active.description}</p>
            <ToolSettings mode={activeMode} />
          </div>
        )}
      </AnchoredPopover>
      <ImportProgressOverlay />
    </div>
  );
};

export default ToolPalette;
export { ToolPalette };

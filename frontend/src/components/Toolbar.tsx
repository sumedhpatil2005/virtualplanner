import React, { useEffect, useState } from 'react';
import { Undo2, Redo2, Construction } from 'lucide-react';
import { engineInstance } from '../engine/TwinCityEngine';
import type { EditingMode } from '../engine/editing/EditingEngine';
import { TOOLS } from './tools';
import { ToolSettings } from './design/ToolSettings';
import { ImportProgressOverlay } from './design/ImportAreaPanel';

/**
 * Build mode's drawing and editing tools: the legacy flat strip, kept working until the shell
 * mounts design/ToolPalette.tsx instead. Settings and the OSM import UI are shared with the palette.
 */
export const Toolbar: React.FC = () => {
  const [activeMode, setActiveMode] = useState<EditingMode>('select');
  const [canUndo, setCanUndo] = useState(false);
  const [canRedo, setCanRedo] = useState(false);

  useEffect(() => {
    const unsubEdit = engineInstance.editing.onChange(() => setActiveMode(engineInstance.editing.getMode()));
    const unsubHistory = engineInstance.history.onChange(() => {
      setCanUndo(engineInstance.history.canUndo());
      setCanRedo(engineInstance.history.canRedo());
    });
    setCanUndo(engineInstance.history.canUndo());
    setCanRedo(engineInstance.history.canRedo());
    setActiveMode(engineInstance.editing.getMode());
    return () => { unsubEdit(); unsubHistory(); };
  }, []);

  return (
    <div data-coach="toolbar" className="relative z-40 flex items-center gap-2 pointer-events-auto w-max">
        <div className="rounded-2xl p-1.5 flex items-center gap-1 bg-slate-950/90 backdrop-blur-xl border border-white/10 shadow-2xl shadow-black/40 animate-fade-in">
          {TOOLS.map((tool) => {
              const Icon = tool.icon;
              const isActive = activeMode === tool.mode;
              const shortcut = tool.hotkey ? ` (${tool.hotkey})` : '';
              return (
              <div key={tool.mode} className="relative">
                <button
                  onClick={() => engineInstance.editing.setMode(tool.mode)}
                  title={`${tool.label}${shortcut}: ${tool.description}`}
                  aria-label={tool.label}
                  aria-pressed={isActive}
                  data-testid={`tool-${tool.mode}`}
                  className={`w-16 flex flex-col items-center gap-1 px-1 py-1.5 rounded-xl transition cursor-pointer ${
                    isActive ? 'bg-indigo-500 text-white' : 'text-slate-300 hover:text-white hover:bg-white/5'
                  }`}
                >
                  <Icon size={18} />
                  <span className="text-xs font-medium leading-none whitespace-nowrap">{tool.shortLabel}</span>
                </button>

                {/* Floating active sub-settings directly below button (above would clip off-screen) */}
                {isActive && activeMode !== 'select' && (
                  <div className="absolute top-14 left-1/2 transform -translate-x-1/2 bg-slate-950/95 backdrop-blur-xl rounded-xl p-2.5 flex flex-col gap-2 w-60 text-sm shadow-2xl border border-indigo-500/20 animate-fade-in" data-testid="tool-settings">
                    <div className="font-semibold text-slate-300 flex items-center gap-1.5 border-b border-white/5 pb-1">
                      <Construction size={12} className="text-indigo-400" />
                      <span>Settings</span>
                    </div>
                    {activeMode === 'import_osm'
                      ? <div className="flex flex-col gap-2 max-h-[calc(100vh-23rem)] min-h-48 overflow-y-auto"><ToolSettings mode={activeMode} /></div>
                      : <ToolSettings mode={activeMode} />}
                  </div>
                )}
              </div>
            );
          })}

          <div className="h-8 w-px bg-white/10 mx-1" />

          <button onClick={() => engineInstance.history.undo()} disabled={!canUndo} title="Undo (Ctrl+Z)" aria-label="Undo" data-testid="tool-undo"
            className={`p-2 rounded-full transition-all duration-200 cursor-pointer ${canUndo ? 'text-slate-300 hover:text-slate-50 hover:bg-slate-800/40' : 'text-slate-600 cursor-not-allowed opacity-50'}`}>
            <Undo2 size={16} />
          </button>
          <button onClick={() => engineInstance.history.redo()} disabled={!canRedo} title="Redo (Ctrl+Y)" aria-label="Redo" data-testid="tool-redo"
            className={`p-2 rounded-full transition-all duration-200 cursor-pointer ${canRedo ? 'text-slate-300 hover:text-slate-50 hover:bg-slate-800/40' : 'text-slate-600 cursor-not-allowed opacity-50'}`}>
            <Redo2 size={16} />
          </button>
        </div>
      <ImportProgressOverlay />
    </div>
  );
};

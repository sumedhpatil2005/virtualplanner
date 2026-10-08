import { useState, useEffect, useCallback } from 'react';
import { Viewport3D } from './components/Viewport3D';
import { Toolbar } from './components/Toolbar';
import { PropertiesPanel } from './components/PropertiesPanel';
import { InfoPanel } from './components/InfoPanel';
import { LayerManager } from './components/LayerManager';
import { ScenarioSelector } from './components/ScenarioSelector';
import { SimulationPanel } from './components/SimulationPanel';
import { SimulationHud } from './components/SimulationHud';
import { ModeBar } from './components/ModeBar';
import { ConnectionBadge } from './components/ui/ConnectionBadge';
import { ConfirmDialog } from './components/ui/ConfirmDialog';
import { ShortcutsOverlay } from './components/ui/ShortcutsOverlay';
import { CoachMarks } from './components/ui/CoachMarks';
import { useKeyboardShortcuts } from './hooks/useKeyboardShortcuts';
import { useAppMode, useSelectedId } from './hooks/useAppMode';
import { engineInstance } from './engine/TwinCityEngine';
import { Compass, Layers, X, Keyboard, FolderOpen } from 'lucide-react';

const pillBase = 'h-11 px-4 rounded-full flex items-center gap-2 border border-white/10 shadow-xl cursor-pointer transition text-sm font-semibold backdrop-blur-xl';
const pillClass = `${pillBase} bg-slate-950/90 text-slate-200 hover:text-white`;

function App() {
  const mode = useAppMode();
  const selectedId = useSelectedId();
  const [isLayersOpen, setIsLayersOpen] = useState(false);
  // View mode's project list can be put away; picking something brings the panel back
  const [isProjectsOpen, setIsProjectsOpen] = useState(true);
  const [isHelpOpen, setIsHelpOpen] = useState(false);
  const [pendingDeleteId, setPendingDeleteId] = useState<string | null>(null);
  const [toast, setToast] = useState<{ message: string; type: 'success' | 'error' | 'info' } | null>(null);

  // Expose global showToast helper
  useEffect(() => {
    let timeoutId: any;
    (window as any).showToast = (message: string, type: 'success' | 'error' | 'info' = 'info') => {
      setToast({ message, type });
      if (timeoutId) clearTimeout(timeoutId);
      timeoutId = setTimeout(() => setToast(null), 5000);
    };
    return () => {
      if (timeoutId) clearTimeout(timeoutId);
      delete (window as any).showToast;
    };
  }, []);

  useKeyboardShortcuts({
    onRequestDelete: setPendingDeleteId,
    onToggleHelp: () => setIsHelpOpen(open => !open),
  });

  const closeHelp = useCallback(() => setIsHelpOpen(false), []);
  const cancelDelete = useCallback(() => setPendingDeleteId(null), []);
  const confirmDelete = useCallback(() => {
    if (pendingDeleteId && engineInstance.deleteObjectWithHistory(pendingDeleteId)) {
      (window as any).showToast?.('Deleted. Ctrl+Z to undo.', 'info');
    }
    setPendingDeleteId(null);
  }, [pendingDeleteId]);

  const pendingDeleteObj = pendingDeleteId ? engineInstance.objects.getById(pendingDeleteId) : undefined;

  // One panel on the right, depending on what the user is doing
  const isDebugSelection = !!selectedId && selectedId.startsWith('debug_');
  const panel =
    mode === 'simulate' ? <SimulationPanel />
    : mode === 'build' || isDebugSelection ? (selectedId ? <PropertiesPanel key={selectedId} /> : null)
    : isProjectsOpen || selectedId ? <InfoPanel onClose={() => setIsProjectsOpen(false)} />
    : null;

  return (
    <div className={`fixed inset-0 overflow-hidden bg-[#060913] text-slate-100 z-0 ${panel ? 'panel-open' : ''}`}>
      {/* 3D map */}
      <div className="absolute inset-0 w-full h-full z-0 select-none">
        <Viewport3D />
      </div>

      {/* Top left: name, connection, scenario */}
      <div className="absolute top-4 left-4 z-20 flex flex-col items-start gap-2 pointer-events-auto w-72">
        <div className="w-full rounded-2xl px-3 py-2.5 flex items-center justify-between bg-slate-950/90 backdrop-blur-xl border border-white/10 shadow-2xl shadow-black/40">
          <div className="flex items-center gap-2.5">
            <div className="p-1.5 rounded-lg bg-indigo-500/15 text-indigo-300">
              <Compass size={18} />
            </div>
            <span className="text-base font-semibold text-white">TwinCity</span>
          </div>
          <div className="flex items-center gap-1">
            <button
              onClick={() => setIsHelpOpen(true)}
              title="Keyboard shortcuts (?)"
              aria-label="Keyboard shortcuts"
              className="p-1.5 rounded-lg text-slate-400 hover:text-white hover:bg-white/5 cursor-pointer transition"
            >
              <Keyboard size={16} />
            </button>
            <ConnectionBadge />
          </div>
        </div>
        <ScenarioSelector />
      </div>

      {/* Top centre: mode, and Build's tools */}
      <div className="absolute top-4 left-1/2 -translate-x-1/2 z-30 flex flex-col items-center gap-2 pointer-events-none">
        <ModeBar />
      </div>
      {mode === 'build' && <div className="build-toolbar absolute z-30 flex justify-center pointer-events-none"><Toolbar /></div>}

      {/* Right: the panel for the current mode */}
      <div className="absolute right-4 top-4 bottom-4 z-20 flex flex-col items-end pointer-events-none">
        {panel ?? (mode === 'view' && (
          <button onClick={() => setIsProjectsOpen(true)} className={`${pillClass} pointer-events-auto`}>
            <FolderOpen size={16} /> Your projects
          </button>
        ))}
      </div>

      {/* Bottom left: layers */}
      {mode === 'simulate' && <SimulationHud />}
      <div className="absolute bottom-4 left-4 z-20 pointer-events-auto flex flex-col items-start gap-2">
        {isLayersOpen && (
          <div className="animate-fade-in mb-1">
            <LayerManager />
          </div>
        )}
        <button
          onClick={() => setIsLayersOpen(!isLayersOpen)}
          aria-expanded={isLayersOpen}
          className={isLayersOpen ? `${pillBase} bg-indigo-500 text-white` : pillClass}
        >
          <Layers size={16} />
          <span>Layers</span>
        </button>
      </div>

      {/* Notifications, bottom centre above the drawing hints */}
      {toast && (
        <div className="fixed bottom-24 left-1/2 -translate-x-1/2 z-10000 pointer-events-auto animate-fade-in" role="status" aria-live="polite">
          <div className={`px-4 py-3 rounded-2xl border flex items-center gap-3 text-sm shadow-2xl max-w-lg backdrop-blur-xl ${
            toast.type === 'error'
              ? 'border-rose-400/30 text-rose-100 bg-rose-950/90'
              : toast.type === 'success'
                ? 'border-emerald-400/30 text-emerald-100 bg-emerald-950/90'
                : 'border-white/10 text-slate-100 bg-slate-950/90'
          }`}>
            <span>{toast.message}</span>
            <button
              onClick={() => setToast(null)}
              aria-label="Dismiss notification"
              className="ml-1 text-slate-400 hover:text-white transition cursor-pointer"
            >
              <X size={16} />
            </button>
          </div>
        </div>
      )}

      <ConfirmDialog
        isOpen={!!pendingDeleteObj}
        title="Delete"
        message={`Delete "${pendingDeleteObj?.name || pendingDeleteObj?.type || 'this object'}"? You can undo this with Ctrl+Z.`}
        confirmText="Delete"
        onConfirm={confirmDelete}
        onCancel={cancelDelete}
      />
      <ShortcutsOverlay isOpen={isHelpOpen} onClose={closeHelp} />
      <CoachMarks />
    </div>
  );
}

export default App;

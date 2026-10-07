import React, { useEffect, useState } from 'react';
import {
  Building,
  Undo2,
  Redo2,
  Construction,
  Train,
  Globe,
} from 'lucide-react';
import { engineInstance } from '../engine/TwinCityEngine';
import type { EditingMode } from '../engine/editing/EditingEngine';
import { TOOLS } from './tools';
import { OverpassCancelledError } from '../engine/editing/OverpassClient';

const reportImportError = (err: any) => {
  if (err instanceof OverpassCancelledError) {
    (window as any).showToast?.('Import cancelled. Nothing was added.', 'info');
    return;
  }
  console.error(err);
  (window as any).showToast?.(`Import failed: ${err?.message || err}`, 'error');
};

/** Build mode's drawing and editing tools. */
export const Toolbar: React.FC = () => {
  const [activeMode, setActiveMode] = useState<EditingMode>('select');
  const [isImporting, setIsImporting] = useState(false);
  const [canUndo, setCanUndo] = useState(false);
  const [canRedo, setCanRedo] = useState(false);

  // Area Selection Drawing State
  const [drawingPointsCount, setDrawingPointsCount] = useState(0);
  const [savedAreas, setSavedAreas] = useState<any[]>([]);
  const [selectedAreaId, setSelectedAreaId] = useState<string | null>(null);
  const [showNameModal, setShowNameModal] = useState(false);
  const [areaName, setAreaName] = useState('');

  // Sync state with engine
  useEffect(() => {
    const unsubEdit = engineInstance.editing.onChange(() => {
      const mode = engineInstance.editing.getMode();
      setActiveMode(mode);
      setIsImporting(engineInstance.editing.getIsImporting());
      setDrawingPointsCount(engineInstance.editing.getDrawingPoints().length);
      setSavedAreas(engineInstance.editing.getSavedAreas());
    });

    const unsubSelection = engineInstance.selection.onChange(() => {
      const activeSel = engineInstance.selection.getSelection();
      setSelectedAreaId(activeSel[0] || null);
    });

    const unsubHistory = engineInstance.history.onChange(() => {
      setCanUndo(engineInstance.history.canUndo());
      setCanRedo(engineInstance.history.canRedo());
    });

    // Initial check
    setCanUndo(engineInstance.history.canUndo());
    setCanRedo(engineInstance.history.canRedo());
    setSavedAreas(engineInstance.editing.getSavedAreas());
    setActiveMode(engineInstance.editing.getMode());

    return () => {
      unsubEdit();
      unsubSelection();
      unsubHistory();
    };
  }, []);

  const handleToolSelect = (mode: EditingMode) => {
    engineInstance.editing.setMode(mode);
  };

  const handleUndo = () => {
    engineInstance.history.undo();
  };

  const handleRedo = () => {
    engineInstance.history.redo();
  };

  const handleFinishArea = () => {
    if (drawingPointsCount < 3) {
      (window as any).showToast?.("Please place at least 3 points on the map to define a boundary.", "error");
      return;
    }
    setAreaName(`Area ${Math.random().toString(36).substr(2, 4).toUpperCase()}`);
    setShowNameModal(true);
  };

  const handleSaveAreaConfirm = async () => {
    if (!areaName.trim()) {
      (window as any).showToast?.("Area name cannot be empty.", "error");
      return;
    }
    try {
      const newArea = await engineInstance.editing.saveArea(areaName);
      (window as any).showToast?.(`Area "${newArea.name}" saved successfully to project!`, "success");
      setShowNameModal(false);
      // Auto-select the newly saved area
      engineInstance.selection.selectSingle(newArea.id);
    } catch (err: any) {
      (window as any).showToast?.(err.message || "Failed to save area.", "error");
    }
  };

  const handleAreaSelect = (areaId: string) => {
    engineInstance.selection.selectSingle(areaId);
  };

  const handleDeleteArea = async (areaId: string) => {
    if (confirm("Are you sure you want to delete this saved Area boundary and ALL its imported OSM infrastructure? The infrastructure deletion can be undone with Ctrl+Z.")) {
      try {
        await engineInstance.editing.deleteArea(areaId, true);
        (window as any).showToast?.("Area and associated infrastructure deleted from project.", "info");
        engineInstance.selection.selectSingle(null);
      } catch (err: any) {
        (window as any).showToast?.(err.message || "Failed to delete area.", "error");
      }
    }
  };

  const handleImportRoads = async () => {
    const activeArea = savedAreas.find(a => a.id === selectedAreaId);
    if (!activeArea) return;
    try {
      (window as any).showToast?.(`Querying Overpass API for roads in "${activeArea.name}"...`, "info");
      const count = await engineInstance.editing.importOSMRoadsInsideArea(activeArea, 'base');
      const skipped = Object.values(engineInstance.editing.lastRoadImportSkipped).reduce((a, b) => a + b, 0);
      const skippedNote = skipped > 0 ? ` Skipped ${skipped} footpaths, cycleways and other ways vehicles can't use.` : '';
      (window as any).showToast?.(`Successfully imported ${count} roads inside "${activeArea.name}"!${skippedNote}`, "success");
    } catch (err: any) {
      reportImportError(err);
    }
  };

  const handleImportBuildings = async () => {
    const activeArea = savedAreas.find(a => a.id === selectedAreaId);
    if (!activeArea) return;
    try {
      const startTime = performance.now();
      (window as any).showToast?.(`Querying Overpass API for buildings in "${activeArea.name}"...`, "info");
      const count = await engineInstance.editing.importOSMBuildingsInsideArea(activeArea, 'base');
      const endTime = performance.now();

      const importTimeSec = ((endTime - startTime) / 1000).toFixed(1);
      const fps = (window as any).twincity_fps || 60;
      const primitivesCount = engineInstance.getPrimitivesCount();
      const mem = (performance as any).memory;
      const heapMB = mem ? Math.round(mem.usedJSHeapSize / (1024 * 1024)) : 0;

      (window as any).showToast?.(
        `Import: ${count} buildings in ${importTimeSec}s | FPS: ${fps} | Primitives: ${primitivesCount} | Heap: ${heapMB}MB`,
        "success"
      );
    } catch (err: any) {
      reportImportError(err);
    }
  };

  const handleImportMetro = async () => {
    const activeArea = savedAreas.find(a => a.id === selectedAreaId);
    if (!activeArea) return;
    try {
      (window as any).showToast?.(`Querying Overpass API for subway network in "${activeArea.name}"...`, "info");
      const result = await engineInstance.editing.importOSMMetroInsideArea(activeArea, 'base');
      (window as any).showToast?.(`Successfully imported ${result.lines} metro lines and ${result.stations} stations inside "${activeArea.name}"!`, "success");
    } catch (err: any) {
      reportImportError(err);
    }
  };

  const activeArea = savedAreas.find(a => a.id === selectedAreaId);

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
                  onClick={() => handleToolSelect(tool.mode)}
                  title={`${tool.label}${shortcut}`}
                  aria-label={tool.label}
                  aria-pressed={isActive}
                  className={`w-16 flex flex-col items-center gap-1 px-1 py-1.5 rounded-xl transition cursor-pointer ${
                    isActive ? 'bg-indigo-500 text-white' : 'text-slate-300 hover:text-white hover:bg-white/5'
                  }`}
                >
                  <Icon size={18} />
                  <span className="text-xs font-medium leading-none whitespace-nowrap">{tool.short}</span>
                </button>

                {/* Floating active sub-settings directly below button (above would clip off-screen) */}
                {isActive && activeMode !== 'select' && (
                  <div className="absolute top-14 left-1/2 transform -translate-x-1/2 glass-panel rounded-xl p-2.5 flex flex-col gap-2 w-60 text-sm shadow-2xl border border-indigo-500/10 animate-fade-in">
                    <div className="font-semibold text-slate-300 flex items-center gap-1.5 border-b border-white/5 pb-1">
                      <Construction size={12} className="text-indigo-400" />
                      <span>Settings</span>
                    </div>

                    {(activeMode === 'draw_road' || activeMode === 'draw_flyover') && (
                      <div className="flex flex-col gap-0.5">
                        <label className="text-xs text-slate-500 uppercase font-semibold">Class</label>
                        <select
                          value={engineInstance.editing.roadClass}
                          onChange={(e) => {
                            engineInstance.editing.roadClass = e.target.value as any;
                          }}
                          className="bg-slate-900 border border-slate-700/50 rounded p-1 text-slate-300 focus:outline-none text-sm"
                        >
                          <option value="highway">Highway</option>
                          <option value="arterial">Arterial</option>
                          <option value="collector">Collector</option>
                          <option value="local">Local</option>
                        </select>
                      </div>
                    )}

                    {activeMode === 'draw_building' && (
                      <div className="flex flex-col gap-0.5">
                        <label className="text-xs text-slate-500 uppercase font-semibold">Zoning</label>
                        <select
                          value={engineInstance.editing.buildingUsage}
                          onChange={(e) => {
                            engineInstance.editing.buildingUsage = e.target.value as any;
                          }}
                          className="bg-slate-900 border border-slate-700/50 rounded p-1 text-slate-300 focus:outline-none text-sm"
                        >
                          <option value="residential">Residential</option>
                          <option value="commercial">Commercial</option>
                          <option value="industrial">Industrial</option>
                          <option value="educational">Education</option>
                        </select>
                      </div>
                    )}

                    {activeMode === 'draw_utility' && (
                      <div className="flex flex-col gap-0.5">
                        <label className="text-xs text-slate-500 uppercase font-semibold">Trunk</label>
                        <select
                          value={engineInstance.editing.utilityType}
                          onChange={(e) => {
                            engineInstance.editing.utilityType = e.target.value as any;
                          }}
                          className="bg-slate-900 border border-slate-700/50 rounded p-1 text-slate-300 focus:outline-none text-sm"
                        >
                          <option value="water">Water</option>
                          <option value="electricity">Electrical</option>
                          <option value="sewage">Sewage</option>
                          <option value="fiber">Fiber</option>
                        </select>
                      </div>
                    )}

                    {activeMode === 'import_osm' && (
                      <div className="flex flex-col gap-2 max-h-72 overflow-y-auto">
                        <div className="text-xs text-slate-400 font-medium leading-relaxed">
                          {drawingPointsCount > 0 ? (
                            <div className="flex flex-col gap-1.5">
                              <span className="text-amber-400 font-semibold">{drawingPointsCount} vertices placed</span>
                              <div className="flex gap-1">
                                <button
                                  onClick={handleFinishArea}
                                  className="flex-1 bg-indigo-600 hover:bg-indigo-500 text-white rounded py-1 font-bold text-xs cursor-pointer"
                                >
                                  Save Area
                                </button>
                                <button
                                  onClick={() => engineInstance.editing.clearDrawing()}
                                  className="bg-slate-800 hover:bg-slate-700 text-slate-300 rounded px-2 py-1 cursor-pointer"
                                >
                                  Clear
                                </button>
                              </div>
                            </div>
                          ) : (
                            <span>Draw an area boundary by clicking 3+ points on the map.</span>
                          )}
                        </div>

                        {/* List of Saved Areas */}
                        <div className="border-t border-white/5 pt-2 flex flex-col gap-1.5">
                          <label className="text-xs text-slate-500 uppercase font-semibold">Saved Areas</label>
                          {savedAreas.length === 0 ? (
                            <span className="text-xs text-slate-600 italic">No saved areas yet</span>
                          ) : (
                            <div className="flex flex-col gap-1 max-h-32 overflow-y-auto">
                              {savedAreas.map(area => {
                                const isSelected = selectedAreaId === area.id;
                                return (
                                  <div
                                    key={area.id}
                                    onClick={() => handleAreaSelect(area.id)}
                                    className={`flex items-center justify-between rounded p-1.5 cursor-pointer border text-xs transition-all ${
                                      isSelected
                                        ? 'bg-indigo-950/30 text-indigo-400 border-indigo-500/30 font-semibold'
                                        : 'bg-slate-900/60 text-slate-300 border-slate-700/30 hover:bg-slate-800/40'
                                    }`}
                                  >
                                    <span className="truncate max-w-[80px]">{area.name}</span>
                                    {isSelected && (
                                      <button
                                        onClick={(e) => {
                                          e.stopPropagation();
                                          handleDeleteArea(area.id);
                                        }}
                                        className="text-red-500 hover:text-red-400 px-1 font-bold"
                                        title="Delete Area"
                                      >
                                        Delete
                                      </button>
                                    )}
                                  </div>
                                );
                              })}
                            </div>
                          )}
                        </div>

                        {/* Selected Area Actions */}
                        {activeArea && (
                          <div className="border-t border-white/5 pt-2 flex flex-col gap-1.5">
                            <div className="text-xs text-indigo-400 font-semibold bg-indigo-950/40 rounded p-1 text-center">
                              Selected: {activeArea.name}
                            </div>
                            <button
                              onClick={handleImportRoads}
                              className="w-full bg-emerald-600 hover:bg-emerald-500 text-white rounded py-1.5 font-bold text-xs cursor-pointer flex items-center justify-center gap-1 shadow-md shadow-emerald-600/10"
                            >
                              <Globe size={10} />
                              Import Roads
                            </button>
                            <button
                              onClick={handleImportBuildings}
                              className="w-full bg-blue-600 hover:bg-blue-500 text-white rounded py-1.5 font-bold text-xs cursor-pointer flex items-center justify-center gap-1 shadow-md shadow-blue-600/10"
                            >
                              <Building size={10} />
                              Import Buildings
                            </button>
                            <button
                              onClick={handleImportMetro}
                              className="w-full bg-purple-600 hover:bg-purple-500 text-white rounded py-1.5 font-bold text-xs cursor-pointer flex items-center justify-center gap-1 shadow-md shadow-purple-600/10"
                            >
                              <Train size={10} />
                              Import Metro
                            </button>
                          </div>
                        )}
                      </div>
                    )}
                  </div>
                )}
              </div>
            );
          })}

          <div className="h-8 w-px bg-white/10 mx-1" />

          {/* Undo/Redo & Actions */}
          <button
            onClick={handleUndo}
            disabled={!canUndo}
            title="Undo (Ctrl+Z)"
            className={`p-2 rounded-full transition-all duration-200 cursor-pointer ${
              canUndo ? 'text-slate-300 hover:text-slate-50 hover:bg-slate-800/40' : 'text-slate-600 cursor-not-allowed opacity-50'
            }`}
          >
            <Undo2 size={16} />
          </button>
          <button
            onClick={handleRedo}
            disabled={!canRedo}
            title="Redo (Ctrl+Y)"
            className={`p-2 rounded-full transition-all duration-200 cursor-pointer ${
              canRedo ? 'text-slate-300 hover:text-slate-50 hover:bg-slate-800/40' : 'text-slate-600 cursor-not-allowed opacity-50'
            }`}
          >
            <Redo2 size={16} />
          </button>
        </div>

      {isImporting && (
        <div className="fixed inset-0 bg-slate-950/75 backdrop-blur-sm flex flex-col items-center justify-center z-[9999] pointer-events-auto">
          <div className="glass-panel p-6 rounded-2xl flex flex-col items-center gap-4 max-w-sm border border-indigo-500/20 text-center shadow-2xl" role="dialog" aria-modal="true" aria-label="Importing from OpenStreetMap">
            <Globe className="text-indigo-400 animate-spin" size={40} />
            <div>
              <h3 className="text-slate-100 font-semibold text-sm">Querying OpenStreetMap</h3>
              <p className="text-slate-400 text-xs mt-1">Downloading data inside the selected area. Busy mirrors are skipped automatically; each request times out after 60 s.</p>
            </div>
            <button
              onClick={() => engineInstance.editing.cancelImport()}
              autoFocus
              className="bg-slate-800 hover:bg-slate-700 text-slate-200 rounded-xl px-4 py-1.5 text-xs font-semibold cursor-pointer animate-none"
            >
              Cancel import
            </button>
          </div>
        </div>
      )}

      {/* Name Input Modal Dialog */}
      {showNameModal && (
        <div className="fixed inset-0 bg-slate-950/75 backdrop-blur-sm flex flex-col items-center justify-center z-[9999] pointer-events-auto">
          <div className="glass-panel p-6 rounded-2xl flex flex-col gap-4 max-w-sm border border-indigo-500/20 shadow-2xl animate-scale-in">
            <div className="flex flex-col gap-1 text-center">
              <h3 className="text-slate-100 font-semibold text-sm">Save Area Boundary</h3>
              <p className="text-slate-400 text-xs">Enter a descriptive name for this permanent project area boundary.</p>
            </div>
            <input
              type="text"
              autoFocus
              value={areaName}
              onChange={(e) => setAreaName(e.target.value)}
              onKeyDown={(e) => {
                if (e.key === 'Enter') handleSaveAreaConfirm();
                else if (e.key === 'Escape') setShowNameModal(false);
              }}
              placeholder="e.g. Pune Central Loop"
              className="bg-slate-950/80 border border-slate-700/60 rounded-xl px-4 py-2.5 text-slate-100 placeholder-slate-500 text-xs focus:outline-none focus:border-indigo-500 transition-all"
            />
            <div className="flex gap-2 text-xs font-semibold">
              <button
                onClick={handleSaveAreaConfirm}
                className="flex-1 bg-indigo-600 hover:bg-indigo-500 text-white rounded-xl py-2 cursor-pointer transition-all"
              >
                Save Area
              </button>
              <button
                onClick={() => setShowNameModal(false)}
                className="bg-slate-800 hover:bg-slate-700 text-slate-300 rounded-xl px-4 py-2 cursor-pointer transition-all"
              >
                Cancel
              </button>
            </div>
          </div>
        </div>
      )}
    </div>
  );
};

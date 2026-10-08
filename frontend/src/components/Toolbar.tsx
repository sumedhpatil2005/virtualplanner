import React, { useEffect, useState } from 'react';
import { createPortal } from 'react-dom';
import {
  Undo2,
  Redo2,
  Construction,
  Globe,
} from 'lucide-react';
import { engineInstance } from '../engine/TwinCityEngine';
import type { EditingMode } from '../engine/editing/EditingEngine';
import { TOOLS } from './tools';
import { INFRASTRUCTURE_CATEGORIES, type InfrastructureCategory, type StudyAreaImportProgress, type StudyAreaImportReport } from '../engine/editing/studyAreaImport';
import type { Area } from '../engine/objects/types';
import { STUDY_AREA_ROADS_PREFIX } from '../engine/simulation/osmCoverage';

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
  const [categories, setCategories] = useState<InfrastructureCategory[]>([...INFRASTRUCTURE_CATEGORIES]);
  const [progress, setProgress] = useState<StudyAreaImportProgress | null>(null);
  const [report, setReport] = useState<StudyAreaImportReport | null>(null);
  const [savingBoundary, setSavingBoundary] = useState(false);

  // Sync state with engine
  useEffect(() => {
    const unsubEdit = engineInstance.editing.onChange(() => {
      const mode = engineInstance.editing.getMode();
      setActiveMode(mode);
      setIsImporting(engineInstance.editing.getIsImporting());
      setDrawingPointsCount(engineInstance.editing.getDrawingPoints().length);
      setSavedAreas(engineInstance.editing.getSavedAreas().filter(area => !area.id.startsWith(STUDY_AREA_ROADS_PREFIX)));
      setProgress(engineInstance.editing.studyAreaImportProgress ? { ...engineInstance.editing.studyAreaImportProgress } : null);
      const currentReport = engineInstance.editing.studyAreaImportReport;
      setReport(currentReport ? { ...currentReport, categories: currentReport.categories.map(c => ({ ...c })) } : null);
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
    setSavedAreas(engineInstance.editing.getSavedAreas().filter(area => !area.id.startsWith(STUDY_AREA_ROADS_PREFIX)));
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
    if (!categories.length) { (window as any).showToast?.('Choose at least one infrastructure category.', 'error'); return; }
    try {
      if (savingBoundary) return;
      setSavingBoundary(true);
      const newArea = await engineInstance.editing.saveArea(areaName.trim());
      (window as any).showToast?.(`Area "${newArea.name}" saved successfully to project!`, "success");
      setShowNameModal(false);
      // Auto-select the newly saved area
      engineInstance.selection.selectSingle(newArea.id);
      await handleImportAll(newArea);
    } catch (err: any) {
      (window as any).showToast?.(err.message || "Failed to save area.", "error");
    } finally { setSavingBoundary(false); }
  };

  const handleAreaSelect = (areaId: string) => {
    engineInstance.selection.selectSingle(areaId);
  };

  const handleDeleteArea = async (areaId: string) => {
    if (confirm("Delete this saved study area boundary? Imported infrastructure is kept.")) {
      try {
        await engineInstance.editing.deleteArea(areaId);
        (window as any).showToast?.("Study area boundary deleted. Imported infrastructure is kept.", "info");
        engineInstance.selection.selectSingle(null);
      } catch (err: any) {
        (window as any).showToast?.(err.message || "Failed to delete area.", "error");
      }
    }
  };

  const activeArea: Area | undefined = savedAreas.find(a => a.id === selectedAreaId) ?? (selectedAreaId ? engineInstance.editing.studyAreaFromZone(selectedAreaId) ?? undefined : undefined);

  const handleImportAll = async (area = activeArea, selected = categories) => {
    if (!area) return;
    try {
      const outcome = await engineInstance.editing.importStudyArea(area, engineInstance.scenarios.getActiveScenarioId(), selected);
      const added = outcome.categories.filter(c => c.category !== 'signals').reduce((n, c) => n + c.added, 0);
      (window as any).showToast?.(`${outcome.cancelled ? 'Import cancelled' : outcome.completed ? 'Import saved' : 'Import partially complete'}: ${added} new objects. See the study area summary.`, outcome.completed ? 'success' : 'info');
    } catch (err: any) { (window as any).showToast?.(err.message || 'Import failed.', 'error'); }
  };

  const categoryChoices = (
    <fieldset className="flex flex-col gap-1 text-xs text-slate-300" disabled={isImporting || savingBoundary}>
      <legend className="text-slate-400 mb-1">Infrastructure to import</legend>
      {INFRASTRUCTURE_CATEGORIES.map(category => (
        <label key={category} className="flex items-center gap-2 cursor-pointer">
          <input type="checkbox" checked={categories.includes(category)} onChange={event => setCategories(current => event.target.checked ? [...current, category] : current.filter(c => c !== category))} />
          {category === 'metro' ? 'Metro lines and stations' : category === 'signals' ? 'Mapped traffic signals' : category.charAt(0).toUpperCase() + category.slice(1)}
        </label>
      ))}
    </fieldset>
  );

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
                  <div className="absolute top-14 left-1/2 transform -translate-x-1/2 bg-slate-950/95 backdrop-blur-xl rounded-xl p-2.5 flex flex-col gap-2 w-60 text-sm shadow-2xl border border-indigo-500/20 animate-fade-in">
                    <div className="font-semibold text-slate-300 flex items-center gap-1.5 border-b border-white/5 pb-1">
                      <Construction size={12} className="text-indigo-400" />
                      <span>Settings</span>
                    </div>
                    {activeMode === 'draw_junction' && <p className="text-xs text-slate-300 leading-relaxed">Move onto a road connection. The cyan footprint shows the roads that will join; red means placement is unavailable. Click to place, then use Select to edit signals and crossings.</p>}

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
                      <div className="flex flex-col gap-2 max-h-[calc(100vh-23rem)] min-h-48 overflow-y-auto">
                        <div className="text-xs text-slate-400 font-medium leading-relaxed">
                          {drawingPointsCount > 0 ? (
                            <div className="flex flex-col gap-1.5">
                              <span className="text-amber-400 font-semibold">{drawingPointsCount} vertices placed</span>
                              <div className="flex gap-1">
                                <button
                                  onClick={handleFinishArea}
                                  className="flex-1 bg-indigo-600 hover:bg-indigo-500 text-white rounded py-1 font-bold text-xs cursor-pointer"
                                >
                                  {savingBoundary ? 'Saving…' : 'Create and import'}
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
                            <span>Click 3+ points to draw a study area, or select a saved area or demand zone.</span>
                          )}
                        </div>

                        {/* List of Saved Areas */}
                        <div className="border-t border-white/5 pt-2 flex flex-col gap-1.5">
                          <label className="text-xs text-slate-500 uppercase font-semibold">Saved study areas</label>
                          {savedAreas.length === 0 ? (
                            <span className="text-xs text-slate-600 italic">No saved areas yet</span>
                          ) : (
                            <div className="flex flex-col gap-1 max-h-32 overflow-y-auto">
                              {savedAreas.map(area => {
                                const isSelected = selectedAreaId === area.id;
                                return (
                                  <div
                                    key={area.id}
                                    className={`flex items-center justify-between rounded p-1.5 cursor-pointer border text-xs transition-all ${
                                      isSelected
                                        ? 'bg-indigo-950/30 text-indigo-400 border-indigo-500/30 font-semibold'
                                        : 'bg-slate-900/60 text-slate-300 border-slate-700/30 hover:bg-slate-800/40'
                                    }`}
                                  >
                                    <button type="button" aria-pressed={isSelected} onClick={() => handleAreaSelect(area.id)} className="truncate flex-1 text-left cursor-pointer">{area.name}</button>
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
                            {categoryChoices}
                            <button onClick={() => handleImportAll()} disabled={!categories.length || isImporting}
                              className="w-full bg-emerald-600 hover:bg-emerald-500 disabled:opacity-50 text-white rounded py-1.5 font-bold text-xs cursor-pointer flex items-center justify-center gap-1">
                              <Globe size={10} /> {categories.length === 4 ? 'Import all infrastructure' : 'Import selected infrastructure'}
                            </button>
                            <p className="text-xs text-slate-500">Existing objects and manual edits are preserved. Full connecting roads crossing the boundary are retained.</p>
                          </div>
                        )}
                        {report && !isImporting && (
                          <div className="border-t border-white/10 pt-2 text-xs flex flex-col gap-1" role="status">
                            <strong className="text-slate-200">{report.cancelled ? 'Cancelled' : report.completed ? 'Saved' : 'Partial import'} · {report.areaName}</strong>
                            {report.categories.map(c => <div key={c.category} className={c.error ? 'text-amber-300' : 'text-slate-400'}>
                              {c.category}: {c.error ? `failed — ${c.error}` : c.category === 'signals' ? `${c.added} mapped signals available` : `${c.added} added, ${c.preserved} preserved, ${c.skipped} unsupported/skipped`} {c.source && !c.error ? `(${c.source})` : ''}
                            </div>)}
                            {report.categories.some(c => c.error) && activeArea && <button className="text-indigo-300 underline" onClick={() => handleImportAll(activeArea, report.categories.filter(c => c.error).map(c => c.category))}>Retry failed categories</button>}
                            {report.cancelled && activeArea && <button className="text-indigo-300 underline" onClick={() => handleImportAll()}>Resume import</button>}
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

      {isImporting && createPortal(
        <div className="fixed inset-0 bg-slate-950/75 backdrop-blur-sm flex flex-col items-center justify-center z-[9999] pointer-events-auto">
          <div className="glass-panel p-6 rounded-2xl flex flex-col items-center gap-4 max-w-sm border border-indigo-500/20 text-center shadow-2xl" role="dialog" aria-modal="true" aria-label="Importing from OpenStreetMap">
            <Globe className="text-indigo-400 animate-spin" size={40} />
            <div>
              <h3 className="text-slate-100 font-semibold text-sm">{progress ? `${progress.phase === 'saving' ? 'Saving' : 'Loading'} ${progress.category}` : 'Importing study area'}</h3>
              <p className="text-slate-400 text-xs mt-1">{progress ? `${progress.completed} of ${progress.total} categories complete. ` : ''}Completed categories stay saved if you cancel. Any save already in progress will finish.</p>
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
      , document.body)}

      {/* Name Input Modal Dialog */}
      {showNameModal && createPortal(
        <div className="fixed inset-0 bg-slate-950/75 backdrop-blur-sm flex flex-col items-center justify-center z-[9999] pointer-events-auto">
          <div className="glass-panel p-6 rounded-2xl flex flex-col gap-4 max-w-sm border border-indigo-500/20 shadow-2xl animate-scale-in">
            <div className="flex flex-col gap-1 text-center">
              <h3 className="text-slate-100 font-semibold text-sm">Create study area</h3>
              <p className="text-slate-400 text-xs">Name the boundary and choose the infrastructure to import.</p>
            </div>
            {categoryChoices}
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
                disabled={savingBoundary || !categories.length}
                className="flex-1 bg-indigo-600 hover:bg-indigo-500 text-white rounded-xl py-2 cursor-pointer transition-all"
              >
                {savingBoundary ? 'Saving…' : 'Create and import'}
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
      , document.body)}
    </div>
  );
};

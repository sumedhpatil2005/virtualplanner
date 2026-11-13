import React, { useEffect, useState } from 'react';
import { createPortal } from 'react-dom';
import { Download } from 'lucide-react';
import { engineInstance } from '../../engine/TwinCityEngine';
import { INFRASTRUCTURE_CATEGORIES, type InfrastructureCategory, type StudyAreaImportProgress, type StudyAreaImportReport } from '../../engine/editing/studyAreaImport';
import type { Area } from '../../engine/objects/types';
import { STUDY_AREA_ROADS_PREFIX } from '../../engine/simulation/osmCoverage';

/**
 * "Import area (OSM)" (was the "Draw area" tool): draw or pick a study-area polygon and import
 * OpenStreetMap infrastructure inside it from the local OSM index. Moved verbatim out of
 * Toolbar.tsx so the old Toolbar and the new ToolPalette share one implementation.
 */
export const ImportAreaPanel: React.FC = () => {
  const [isImporting, setIsImporting] = useState(false);
  const [drawingPointsCount, setDrawingPointsCount] = useState(0);
  const [savedAreas, setSavedAreas] = useState<any[]>([]);
  const [selectedAreaId, setSelectedAreaId] = useState<string | null>(null);
  const [showNameModal, setShowNameModal] = useState(false);
  const [areaName, setAreaName] = useState('');
  const [categories, setCategories] = useState<InfrastructureCategory[]>([...INFRASTRUCTURE_CATEGORIES]);
  const [report, setReport] = useState<StudyAreaImportReport | null>(null);
  const [savingBoundary, setSavingBoundary] = useState(false);
  // "Map Selected Area" keeps only what lies inside the drawn polygon, cutting roads at its edge
  const [clipOnSave, setClipOnSave] = useState(true);
  const [redrawingId, setRedrawingId] = useState<string | null>(null);

  useEffect(() => {
    const sync = () => {
      setIsImporting(engineInstance.editing.getIsImporting());
      setDrawingPointsCount(engineInstance.editing.getDrawingPoints().length);
      setRedrawingId(engineInstance.editing.getRedrawingAreaId());
      setSavedAreas(engineInstance.editing.getSavedAreas().filter(area => !area.id.startsWith(STUDY_AREA_ROADS_PREFIX)));
      const currentReport = engineInstance.editing.studyAreaImportReport;
      setReport(currentReport ? { ...currentReport, categories: currentReport.categories.map(c => ({ ...c })) } : null);
    };
    sync();
    setSelectedAreaId(engineInstance.selection.getSelection()[0] || null);
    const unsubEdit = engineInstance.editing.onChange(sync);
    const unsubSelection = engineInstance.selection.onChange(() => setSelectedAreaId(engineInstance.selection.getSelection()[0] || null));
    return () => { unsubEdit(); unsubSelection(); };
  }, []);

  const handleFinishArea = (clip: boolean) => {
    if (drawingPointsCount < 3) {
      (window as any).showToast?.("Please place at least 3 points on the map to define a boundary.", "error");
      return;
    }
    setClipOnSave(clip);
    const redrawn = redrawingId ? savedAreas.find(a => a.id === redrawingId) : undefined;
    setAreaName(redrawn?.name ?? `Area ${Math.random().toString(36).substr(2, 4).toUpperCase()}`);
    setShowNameModal(true);
  };

  const handleRedrawArea = (areaId: string) => {
    try {
      engineInstance.editing.beginRedrawArea(areaId);
      (window as any).showToast?.('Boundary loaded for editing: drag its points, drag a white midpoint to add one, right-click a point to remove it. Map it again to save.', 'info');
    } catch (err: any) {
      (window as any).showToast?.(err.message || 'Could not edit that boundary.', 'error');
    }
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
      await handleImportAll(newArea, categories, clipOnSave);
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

  const handleImportAll = async (area = activeArea, selected = categories, clip = false) => {
    if (!area) return;
    try {
      const outcome = await engineInstance.editing.importStudyArea(area, engineInstance.scenarios.getActiveScenarioId(), selected, { clipToBoundary: clip });
      const added = outcome.categories.filter(c => c.category !== 'signals').reduce((n, c) => n + c.added, 0);
      const cuts = clip && outcome.boundaryCuts ? ` ${outcome.boundaryCuts} road ends cut at the boundary (gateway candidates).` : '';
      (window as any).showToast?.(`${outcome.cancelled ? 'Import cancelled' : outcome.completed ? (clip ? 'Area mapped' : 'Import saved') : 'Import partially complete'}: ${added} new objects.${cuts} See the study area summary.`, outcome.completed ? 'success' : 'info');
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
    <>
                      <div className="flex flex-col gap-2">
                        <div className="text-xs text-slate-400 font-medium leading-relaxed">
                          {drawingPointsCount > 0 ? (
                            <div className="flex flex-col gap-1.5">
                              <span className="text-amber-400 font-semibold">
                                {redrawingId ? 'Editing boundary · ' : 'Import area · '}{drawingPointsCount} {drawingPointsCount === 1 ? 'point' : 'points'}{drawingPointsCount < 3 ? ` (${3 - drawingPointsCount} more needed)` : ''}
                              </span>
                              <span className="text-slate-500">Drag a red point to move it, drag a white midpoint to add one, right-click a point to remove it.</span>
                              <button
                                onClick={() => handleFinishArea(true)}
                                disabled={drawingPointsCount < 3 || savingBoundary || isImporting}
                                title="Import roads, buildings, junctions and other supported features inside this polygon only; roads are cut at its edge"
                                className="w-full bg-emerald-600 hover:bg-emerald-500 disabled:opacity-50 text-white rounded py-1.5 font-bold text-xs cursor-pointer"
                              >
                                {savingBoundary ? 'Saving…' : 'Map Selected Area'}
                              </button>
                              <div className="flex gap-1">
                                <button
                                  onClick={() => handleFinishArea(false)}
                                  disabled={drawingPointsCount < 3 || savingBoundary || isImporting}
                                  title="Keep whole roads and buildings that touch the boundary"
                                  className="flex-1 bg-indigo-700/70 hover:bg-indigo-600 disabled:opacity-50 text-white rounded py-1 text-xs cursor-pointer"
                                >
                                  Import whole features
                                </button>
                                <button
                                  onClick={() => engineInstance.editing.removeDrawingPoint(drawingPointsCount - 1)}
                                  className="bg-slate-800 hover:bg-slate-700 text-slate-300 rounded px-2 py-1 cursor-pointer"
                                  title="Remove the last point"
                                >
                                  Undo point
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
                            <span><strong className="text-slate-300">Import area from OpenStreetMap:</strong> click 3 or more points on the map to outline a polygon, then Map Selected Area. Or select a saved area or demand zone.</span>
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
                                        onClick={(e) => { e.stopPropagation(); handleRedrawArea(area.id); }}
                                        className="text-indigo-300 hover:text-indigo-200 px-1"
                                        title="Edit this boundary's points"
                                      >
                                        Edit
                                      </button>
                                    )}
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
                            <button onClick={() => handleImportAll(activeArea, categories, true)} disabled={!categories.length || isImporting}
                              className="w-full bg-emerald-600 hover:bg-emerald-500 disabled:opacity-50 text-white rounded py-1.5 font-bold text-xs cursor-pointer flex items-center justify-center gap-1">
                              <Download size={10} /> Map Selected Area
                            </button>
                            <button onClick={() => handleImportAll(activeArea, categories, false)} disabled={!categories.length || isImporting}
                              className="w-full bg-indigo-700/70 hover:bg-indigo-600 disabled:opacity-50 text-white rounded py-1 text-xs cursor-pointer flex items-center justify-center gap-1">
                              {categories.length === 4 ? 'Import all, whole features' : 'Import selected, whole features'}
                            </button>
                            <p className="text-xs text-slate-500">Map Selected Area keeps only what lies inside the polygon and cuts roads at its edge (cut ends become gateway candidates in Simulate; no traffic is added there). Whole features keeps full roads crossing the boundary. Existing objects and manual edits are preserved either way.</p>
                          </div>
                        )}
                        {report && !isImporting && (
                          <div className="border-t border-white/10 pt-2 text-xs flex flex-col gap-1" role="status">
                            <strong className="text-slate-200">{report.cancelled ? 'Cancelled' : report.completed ? 'Saved' : 'Partial import'} · {report.areaName}{report.clippedToBoundary ? ' (cut to boundary)' : ''}</strong>
                            {report.clippedToBoundary && <div className="text-slate-400">{report.boundaryCuts ?? 0} road ends cut at the boundary</div>}
                            {report.categories.map(c => <div key={c.category} className={c.error ? 'text-amber-300' : 'text-slate-400'}>
                              {c.category}: {c.error ? `failed — ${c.error}` : c.category === 'signals' ? `${c.added} mapped signals available` : `${c.added} added, ${c.preserved} preserved, ${c.skipped} unsupported/skipped`} {c.source && !c.error ? `(${c.source})` : ''}
                            </div>)}
                            {report.categories.some(c => c.error) && activeArea && <button className="text-indigo-300 underline" onClick={() => handleImportAll(activeArea, report.categories.filter(c => c.error).map(c => c.category))}>Retry failed categories</button>}
                            {report.cancelled && activeArea && <button className="text-indigo-300 underline" onClick={() => handleImportAll()}>Resume import</button>}
                          </div>
                        )}
                      </div>
                    
      {/* Name Input Modal Dialog */}
      {showNameModal && createPortal(
        <div className="fixed inset-0 bg-slate-950/75 backdrop-blur-sm flex flex-col items-center justify-center z-[9999] pointer-events-auto">
          <div className="glass-panel p-6 rounded-2xl flex flex-col gap-4 max-w-sm border border-indigo-500/20 shadow-2xl animate-scale-in">
            <div className="flex flex-col gap-1 text-center">
              <h3 className="text-slate-100 font-semibold text-sm">{clipOnSave ? 'Map Selected Area' : 'Create study area'}</h3>
              <p className="text-slate-400 text-xs">{clipOnSave ? 'Name the area and choose what to map. Only what lies inside the polygon is imported; roads are cut at its edge.' : 'Name the boundary and choose the infrastructure to import. Whole features touching it are kept.'}</p>
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
                {savingBoundary ? 'Saving…' : clipOnSave ? 'Map Selected Area' : 'Create and import'}
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
    </>
  );
};

/** Full-screen progress while an OSM import runs (mounted by whichever toolbar is on screen). */
export const ImportProgressOverlay: React.FC = () => {
  const [isImporting, setIsImporting] = useState(false);
  const [progress, setProgress] = useState<StudyAreaImportProgress | null>(null);
  useEffect(() => engineInstance.editing.onChange(() => {
    setIsImporting(engineInstance.editing.getIsImporting());
    setProgress(engineInstance.editing.studyAreaImportProgress ? { ...engineInstance.editing.studyAreaImportProgress } : null);
  }), []);
  return (
    <>
      {isImporting && createPortal(
        <div className="fixed inset-0 bg-slate-950/75 backdrop-blur-sm flex flex-col items-center justify-center z-[9999] pointer-events-auto">
          <div className="glass-panel p-6 rounded-2xl flex flex-col items-center gap-4 max-w-sm border border-indigo-500/20 text-center shadow-2xl" role="dialog" aria-modal="true" aria-label="Importing from OpenStreetMap">
            <Download className="text-indigo-400 animate-pulse" size={40} />
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

    </>
  );
};

import React, { useEffect, useState } from 'react';
import { 
  MousePointer, 
  Route, 
  Building, 
  Compass, 
  Settings, 
  Undo2, 
  Redo2, 
  Construction,
  Layers,
  Train,
  MapPin,
  Globe,
  X,
  Square,
  DoorOpen,
  Hammer,
  LineChart
} from 'lucide-react';
import { engineInstance } from '../engine/TwinCityEngine';
import type { EditingMode } from '../engine/editing/EditingEngine';

export const Toolbar: React.FC = () => {
  const [isOpen, setIsOpen] = useState(false);
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
  const [planningMode, setPlanningMode] = useState(engineInstance.isPlanningModeActive());

  // Sync state with engine
  useEffect(() => {
    const unsubEdit = engineInstance.editing.onChange(() => {
      setActiveMode(engineInstance.editing.getMode());
      setIsImporting(engineInstance.editing.getIsImporting());
      setDrawingPointsCount(engineInstance.editing.getDrawingPoints().length);
      setSavedAreas(engineInstance.editing.getSavedAreas());
      setPlanningMode(engineInstance.isPlanningModeActive());
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
    const previousState = engineInstance.history.undo(engineInstance.objects.getAll());
    if (previousState) {
      engineInstance.objects.clear();
      previousState.forEach(obj => engineInstance.objects.add(obj));
    }
  };

  const handleRedo = () => {
    const nextState = engineInstance.history.redo(engineInstance.objects.getAll());
    if (nextState) {
      engineInstance.objects.clear();
      nextState.forEach(obj => engineInstance.objects.add(obj));
    }
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
    if (confirm("Are you sure you want to delete this saved Area boundary and ALL its imported OSM infrastructure?")) {
      await engineInstance.editing.deleteArea(areaId, true);
      (window as any).showToast?.("Area and associated infrastructure deleted from project.", "info");
      engineInstance.selection.selectSingle(null);
    }
  };

  const handleImportRoads = async () => {
    const activeArea = savedAreas.find(a => a.id === selectedAreaId);
    if (!activeArea) return;
    try {
      (window as any).showToast?.(`Querying Overpass API for roads in "${activeArea.name}"...`, "info");
      const count = await engineInstance.editing.importOSMRoadsInsideArea(activeArea, 'base');
      (window as any).showToast?.(`Successfully imported ${count} roads inside "${activeArea.name}"!`, "success");
    } catch (err: any) {
      console.error(err);
      (window as any).showToast?.(`Import failed: ${err.message || err}. Overpass might be rate-limited. Please try again!`, "error");
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
      console.error(err);
      (window as any).showToast?.(`Import failed: ${err.message || err}. Overpass might be busy. Please try again!`, "error");
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
      console.error(err);
      (window as any).showToast?.(`Metro import failed: ${err.message || err}. Please try again!`, "error");
    }
  };

  const activeArea = savedAreas.find(a => a.id === selectedAreaId);

  const tools = [
    { mode: 'select' as EditingMode, label: 'Select Object', icon: MousePointer },
    { mode: 'draw_zone' as EditingMode, label: 'Create Zone (Polygon)', icon: Square },
    { mode: 'draw_gateway' as EditingMode, label: 'Create Gateway', icon: DoorOpen },
    { mode: 'draw_road' as EditingMode, label: 'Draw Road Path', icon: Route },
    { mode: 'draw_flyover' as EditingMode, label: 'Draw Elevated Flyover', icon: Layers },
    { mode: 'draw_metro' as EditingMode, label: 'Draw Elevated Metro Line', icon: Train },
    { mode: 'draw_metro_flyover' as EditingMode, label: 'Draw Metro + Flyover', icon: Hammer },
    { mode: 'place_station' as EditingMode, label: 'Place Metro Station', icon: MapPin },
    { mode: 'draw_building' as EditingMode, label: 'Draw Building Footprint', icon: Building },
    { mode: 'draw_junction' as EditingMode, label: 'Create Road Junction', icon: Compass },
    { mode: 'draw_utility' as EditingMode, label: 'Lay Utility Conduit', icon: Settings },
    { mode: 'import_osm' as EditingMode, label: 'Import OSM Roads', icon: Globe },
  ];

  return (
    <div className="fixed top-[20.5rem] left-6 z-40 flex items-center gap-2 pointer-events-auto">
      {/* Floating Action Button Trigger */}
      <button
        onClick={() => setIsOpen(!isOpen)}
        title={isOpen ? "Collapse Toolbar" : "Expand Editing Tools"}
        className={`w-12 h-12 rounded-full flex items-center justify-center border shadow-xl cursor-pointer transition-all duration-300 hover:scale-105 active:scale-95 ${
          isOpen 
            ? 'bg-red-950/80 text-red-400 border-red-500/20' 
            : 'bg-indigo-600 text-white border-indigo-500/30 shadow-indigo-600/20'
        }`}
      >
        {isOpen ? <X size={20} /> : <Construction size={20} />}
      </button>

      {/* Collapsible Horizontal Action Bar */}
      {isOpen && (
        <div className="glass-panel rounded-full p-1.5 flex items-center gap-1.5 shadow-2xl border border-white/5 animate-fade-in">
          
          {/* Mode Switcher Segmented Control */}
          <div className="flex bg-slate-950/80 rounded-full p-1 border border-slate-800/60 mr-1 shrink-0">
            <button
              onClick={() => {
                setPlanningMode(false);
                engineInstance.setPlanningModeActive(false);
              }}
              title="Switch to Normal/Analyze Mode"
              className={`px-3 py-1.5 rounded-full text-[10px] font-bold transition-all duration-200 flex items-center gap-1 cursor-pointer ${
                !planningMode 
                  ? 'bg-blue-600 text-white shadow-md shadow-blue-500/25' 
                  : 'text-slate-400 hover:text-slate-200'
              }`}
            >
              <LineChart size={12} />
              <span>Analyze</span>
            </button>
            <button
              onClick={() => {
                setPlanningMode(true);
                engineInstance.setPlanningModeActive(true);
              }}
              title="Switch to Planning/Edit Mode"
              className={`px-3 py-1.5 rounded-full text-[10px] font-bold transition-all duration-200 flex items-center gap-1 cursor-pointer ${
                planningMode 
                  ? 'bg-indigo-600 text-white shadow-md shadow-indigo-500/25' 
                  : 'text-slate-400 hover:text-slate-200'
              }`}
            >
              <Hammer size={12} />
              <span>Plan</span>
            </button>
          </div>

          {tools
            .filter((tool) => planningMode || tool.mode === 'select')
            .map((tool) => {
              const Icon = tool.icon;
              const isActive = activeMode === tool.mode;
              return (
              <div key={tool.mode} className="relative">
                <button
                  onClick={() => handleToolSelect(tool.mode)}
                  title={tool.label}
                  className={`p-2.5 rounded-full transition-all duration-200 cursor-pointer ${
                    isActive 
                      ? 'bg-indigo-600 text-white shadow-md shadow-indigo-500/20 scale-105' 
                      : 'text-slate-400 hover:text-slate-100 hover:bg-slate-800/40'
                  }`}
                >
                  <Icon size={18} />
                </button>

                {/* Floating active sub-settings directly above button */}
                {isActive && activeMode !== 'select' && (
                  <div className="absolute bottom-14 left-1/2 transform -translate-x-1/2 glass-panel rounded-xl p-2.5 flex flex-col gap-1.5 w-44 text-xs shadow-2xl border border-indigo-500/10 animate-fade-in">
                    <div className="font-semibold text-slate-300 flex items-center gap-1.5 border-b border-white/5 pb-1">
                      <Construction size={12} className="text-indigo-400" />
                      <span>Settings</span>
                    </div>

                    {(activeMode === 'draw_road' || activeMode === 'draw_flyover') && (
                      <div className="flex flex-col gap-0.5">
                        <label className="text-[9px] text-slate-500 uppercase font-semibold">Class</label>
                        <select 
                          value={engineInstance.editing.roadClass} 
                          onChange={(e) => {
                            engineInstance.editing.roadClass = e.target.value as any;
                          }}
                          className="bg-slate-900 border border-slate-700/50 rounded p-1 text-slate-300 focus:outline-none text-[11px]"
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
                        <label className="text-[9px] text-slate-500 uppercase font-semibold">Zoning</label>
                        <select 
                          value={engineInstance.editing.buildingUsage} 
                          onChange={(e) => {
                            engineInstance.editing.buildingUsage = e.target.value as any;
                          }}
                          className="bg-slate-900 border border-slate-700/50 rounded p-1 text-slate-300 focus:outline-none text-[11px]"
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
                        <label className="text-[9px] text-slate-500 uppercase font-semibold">Trunk</label>
                        <select 
                          value={engineInstance.editing.utilityType} 
                          onChange={(e) => {
                            engineInstance.editing.utilityType = e.target.value as any;
                          }}
                          className="bg-slate-900 border border-slate-700/50 rounded p-1 text-slate-300 focus:outline-none text-[11px]"
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
                        <div className="text-[10px] text-slate-400 font-medium leading-relaxed">
                          {drawingPointsCount > 0 ? (
                            <div className="flex flex-col gap-1.5">
                              <span className="text-amber-400 font-semibold">{drawingPointsCount} vertices placed</span>
                              <div className="flex gap-1">
                                <button
                                  onClick={handleFinishArea}
                                  className="flex-1 bg-indigo-600 hover:bg-indigo-500 text-white rounded py-1 font-bold text-[10px] cursor-pointer"
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
                          <label className="text-[9px] text-slate-500 uppercase font-semibold">Saved Areas</label>
                          {savedAreas.length === 0 ? (
                            <span className="text-[10px] text-slate-600 italic">No saved areas yet</span>
                          ) : (
                            <div className="flex flex-col gap-1 max-h-32 overflow-y-auto">
                              {savedAreas.map(area => {
                                const isSelected = selectedAreaId === area.id;
                                return (
                                  <div 
                                    key={area.id}
                                    onClick={() => handleAreaSelect(area.id)}
                                    className={`flex items-center justify-between rounded p-1.5 cursor-pointer border text-[10px] transition-all ${
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
                            <div className="text-[9px] text-indigo-400 font-semibold bg-indigo-950/40 rounded p-1 text-center">
                              Selected: {activeArea.name}
                            </div>
                            <button
                              onClick={handleImportRoads}
                              className="w-full bg-emerald-600 hover:bg-emerald-500 text-white rounded py-1.5 font-bold text-[10px] cursor-pointer flex items-center justify-center gap-1 shadow-md shadow-emerald-600/10"
                            >
                              <Globe size={10} />
                              Import Roads
                            </button>
                            <button
                              onClick={handleImportBuildings}
                              className="w-full bg-blue-600 hover:bg-blue-500 text-white rounded py-1.5 font-bold text-[10px] cursor-pointer flex items-center justify-center gap-1 shadow-md shadow-blue-600/10"
                            >
                              <Building size={10} />
                              Import Buildings
                            </button>
                            <button
                              onClick={handleImportMetro}
                              className="w-full bg-purple-600 hover:bg-purple-500 text-white rounded py-1.5 font-bold text-[10px] cursor-pointer flex items-center justify-center gap-1 shadow-md shadow-purple-600/10"
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

          <div className="h-6 w-[1px] bg-white/10 mx-1" />

          {/* Undo/Redo & Actions */}
          <button
            onClick={handleUndo}
            disabled={!canUndo}
            title="Undo"
            className={`p-2 rounded-full transition-all duration-200 cursor-pointer ${
              canUndo ? 'text-slate-300 hover:text-slate-50 hover:bg-slate-800/40' : 'text-slate-600 cursor-not-allowed opacity-50'
            }`}
          >
            <Undo2 size={16} />
          </button>
          <button
            onClick={handleRedo}
            disabled={!canRedo}
            title="Redo"
            className={`p-2 rounded-full transition-all duration-200 cursor-pointer ${
              canRedo ? 'text-slate-300 hover:text-slate-50 hover:bg-slate-800/40' : 'text-slate-600 cursor-not-allowed opacity-50'
            }`}
          >
            <Redo2 size={16} />
          </button>
        </div>
      )}

      {isImporting && (
        <div className="fixed inset-0 bg-slate-950/75 backdrop-blur-sm flex flex-col items-center justify-center z-[9999] pointer-events-auto">
          <div className="glass-panel p-6 rounded-2xl flex flex-col items-center gap-4 max-w-sm border border-indigo-500/20 text-center animate-pulse shadow-2xl">
            <Globe className="text-indigo-400 animate-spin" size={40} />
            <div>
              <h3 className="text-slate-100 font-semibold text-sm">Querying OpenStreetMap</h3>
              <p className="text-slate-400 text-xs mt-1">Downloading 3D road layouts inside the drawn polygon selection boundary...</p>
            </div>
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
              value={areaName}
              onChange={(e) => setAreaName(e.target.value)}
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

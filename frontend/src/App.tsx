import { useState, useEffect } from 'react';
import { Viewport3D } from './components/Viewport3D';
import { Toolbar } from './components/Toolbar';
import { PropertiesPanel } from './components/PropertiesPanel';
import { LayerManager } from './components/LayerManager';
import { ScenarioSelector } from './components/ScenarioSelector';
import { SimulationPanel } from './components/SimulationPanel';
import { Compass, Layers, BarChart3, Activity, X } from 'lucide-react';

function App() {
  const [isLayersOpen, setIsLayersOpen] = useState(false);
  const [isAnalyticsOpen, setIsAnalyticsOpen] = useState(true);
  const [isSimulationOpen, setIsSimulationOpen] = useState(false);
  const [toast, setToast] = useState<{ message: string; type: 'success' | 'error' | 'info' } | null>(null);

  // Expose global showToast helper
  useEffect(() => {
    console.log('[STARTUP] UI ready');
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

  return (
    <div className="fixed inset-0 overflow-hidden bg-[#060913] text-slate-100 select-none z-0">
      
      {/* 3D Immersive Workspace (CesiumJS Canvas) */}
      <div className="absolute inset-0 w-full h-full z-0">
        <Viewport3D />
      </div>

      {/* Floating GUI Panels (Overlaid on top of Cesium) */}
      
      {/* 1. TOP LEFT: Branding + Scenario selection */}
      <div className="absolute top-4 left-4 z-20 flex flex-col gap-2 pointer-events-auto w-80">
        <div className="glass-panel rounded-2xl p-4 border border-indigo-500/10 flex items-center gap-3 shadow-2xl">
          <div className="p-2 rounded-xl bg-indigo-950/80 border border-indigo-500/35 text-indigo-300">
            <Compass size={22} className="animate-spin-slow" />
          </div>
          <div>
            <h1 className="text-sm font-bold text-slate-200 tracking-wider m-0 p-0 leading-none">
              TwinCity Engine
            </h1>
            <p className="text-[9px] text-indigo-400/90 font-semibold font-mono tracking-wider mt-1 uppercase">
              Digital Twin Platform v2.0
            </p>
          </div>
        </div>
        <ScenarioSelector />
      </div>

      {/* 2. FAR LEFT CENTER: Collapsible horizontal CAD toolbar */}
      <Toolbar />

      {/* 3. BOTTOM LEFT: Collapsible Layer Control Panel */}
      <div className="absolute bottom-4 left-4 z-20 pointer-events-auto flex flex-col items-start gap-2">
        {isLayersOpen && (
          <div className="animate-fade-in mb-1">
            <LayerManager />
          </div>
        )}
        <button
          onClick={() => setIsLayersOpen(!isLayersOpen)}
          title={isLayersOpen ? "Collapse Layers" : "Expand Layers"}
          className={`w-12 h-12 rounded-full flex items-center justify-center border shadow-xl cursor-pointer transition-all duration-300 hover:scale-105 active:scale-95 ${
            isLayersOpen 
              ? 'bg-indigo-600 text-white border-indigo-500/30 shadow-indigo-600/20' 
              : 'bg-slate-900/95 text-indigo-400 border-white/5 hover:text-indigo-300'
          }`}
        >
          <Layers size={20} />
        </button>
      </div>

      {/* 4. RIGHT SIDE: Collapsible Properties Inspector / City Analytics */}
      <div className="absolute right-4 top-4 bottom-4 z-20 pointer-events-auto flex flex-col items-end gap-2">
        {!isAnalyticsOpen && (
          <button
            onClick={() => setIsAnalyticsOpen(true)}
            title="Open City Analytics & Properties"
            className="w-12 h-12 rounded-full bg-slate-900/95 text-indigo-400 border border-white/5 flex items-center justify-center shadow-xl cursor-pointer transition-all duration-300 hover:scale-105 hover:text-indigo-300 active:scale-95"
          >
            <BarChart3 size={20} />
          </button>
        )}
        {isAnalyticsOpen && (
          <PropertiesPanel onClose={() => setIsAnalyticsOpen(false)} />
        )}
      </div>

      {/* 5. BOTTOM RIGHT/CENTER: Collapsible Simulation Panel */}
      <div className={`absolute bottom-4 z-20 pointer-events-auto flex flex-col items-end gap-2 transition-all duration-300 ${
        isAnalyticsOpen ? 'right-[22rem]' : 'right-4'
      }`}>
        {isSimulationOpen && (
          <div className="animate-fade-in mb-1">
            <SimulationPanel onClose={() => setIsSimulationOpen(false)} />
          </div>
        )}
        {!isSimulationOpen && (
          <button
            onClick={() => setIsSimulationOpen(true)}
            title="Open Model Simulations"
            className="w-12 h-12 rounded-full bg-slate-900/95 text-indigo-400 border border-white/5 flex items-center justify-center shadow-xl cursor-pointer transition-all duration-300 hover:scale-105 hover:text-indigo-300 active:scale-95"
          >
            <Activity size={20} />
          </button>
        )}
      </div>

      {/* 6. TOP CENTER: Floating Toast Notifications */}
      {toast && (
        <div className="fixed top-6 left-1/2 transform -translate-x-1/2 z-[10000] pointer-events-auto animate-fade-in">
          <div className={`glass-panel px-4 py-3 rounded-2xl border flex items-center gap-3 text-xs shadow-2xl max-w-md ${
            toast.type === 'error' 
              ? 'border-red-500/20 text-red-300 bg-red-950/80 backdrop-blur-md' 
              : toast.type === 'success'
                ? 'border-emerald-500/20 text-emerald-300 bg-emerald-950/80 backdrop-blur-md'
                : 'border-indigo-500/20 text-indigo-300 bg-slate-900/90 backdrop-blur-md'
          }`}>
            <span className={`w-2 h-2 rounded-full shrink-0 animate-pulse ${
              toast.type === 'error' ? 'bg-red-400' : toast.type === 'success' ? 'bg-emerald-400' : 'bg-indigo-400'
            }`} />
            <span className="font-medium tracking-wide">{toast.message}</span>
            <button 
              onClick={() => setToast(null)} 
              className="ml-2 text-slate-500 hover:text-slate-300 transition cursor-pointer"
            >
              <X size={14} />
            </button>
          </div>
        </div>
      )}

    </div>
  );
}

export default App;

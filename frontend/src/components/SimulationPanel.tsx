import React, { useEffect, useState } from 'react';
import { Play, Square, Flame, Droplets, Users, BarChart3, Loader2, X } from 'lucide-react';
import { engineInstance } from '../engine/TwinCityEngine';
import type { SimulationType } from '../engine/simulation/SimulationManager';

interface SimulationPanelProps {
  onClose?: () => void;
}

export const SimulationPanel: React.FC<SimulationPanelProps> = ({ onClose }) => {
  const [isRunning, setIsRunning] = useState<Record<SimulationType, boolean>>({
    traffic: false,
    flood: false,
    population: false
  });

  const [activeTab, setActiveTab] = useState<SimulationType>('traffic');

  const [trafficRes, setTrafficRes] = useState<any>(null);
  const [floodRes, setFloodRes] = useState<any>(null);
  const [popRes, setPopRes] = useState<any>(null);

  useEffect(() => {
    const checkState = () => {
      setIsRunning({
        traffic: engineInstance.simulations.isRunning('traffic'),
        flood: engineInstance.simulations.isRunning('flood'),
        population: engineInstance.simulations.isRunning('population')
      });
      setTrafficRes(engineInstance.simulations.getTrafficResults());
      setFloodRes(engineInstance.simulations.getFloodResults());
      setPopRes(engineInstance.simulations.getPopulationResults());
    };

    const unsub = engineInstance.simulations.onChange(checkState);
    checkState();
    return unsub;
  }, []);

  const handleRunSim = (type: SimulationType) => {
    if (isRunning[type]) {
      engineInstance.simulations.stopSimulation(type);
      // Turn off corresponding simulation layer
      if (type === 'traffic') engineInstance.layers.setVisibility('traffic_sim', false);
      if (type === 'flood') engineInstance.layers.setVisibility('flood_sim', false);
      if (type === 'population') engineInstance.layers.setVisibility('population_sim', false);
    } else {
      engineInstance.simulations.startSimulation(type, engineInstance.objects.getAll(), () => {
        // Automatically toggle corresponding overlay layer on completion
        if (type === 'traffic') engineInstance.layers.setVisibility('traffic_sim', true);
        if (type === 'flood') engineInstance.layers.setVisibility('flood_sim', true);
        if (type === 'population') engineInstance.layers.setVisibility('population_sim', true);
      });
    }
  };

  const tabs = [
    { id: 'traffic' as SimulationType, label: 'Traffic Flow', icon: Flame, color: 'text-amber-400' },
    { id: 'flood' as SimulationType, label: 'Flood Model', icon: Droplets, color: 'text-sky-400' },
    { id: 'population' as SimulationType, label: 'Demographics', icon: Users, color: 'text-emerald-400' }
  ];

  return (
    <div className="w-80 glass-panel rounded-2xl p-4 flex flex-col h-[340px] pointer-events-auto shadow-2xl border border-white/5">
      {/* Simulation Selector Tabs */}
      <div className="flex gap-1 border-b border-white/5 pb-2 mb-3 items-center">
        {tabs.map((tab) => {
          const Icon = tab.icon;
          const isSelected = activeTab === tab.id;
          return (
            <button
              key={tab.id}
              onClick={() => setActiveTab(tab.id)}
              className={`flex-1 flex flex-col items-center gap-1 py-1.5 rounded-xl border transition cursor-pointer ${
                isSelected 
                  ? 'bg-slate-800/60 border-indigo-500/30 text-indigo-200' 
                  : 'border-transparent text-slate-400 hover:text-slate-200 hover:bg-slate-800/20'
              }`}
            >
              <Icon size={16} className={tab.color} />
              <span className="text-[9px] font-medium tracking-wide">{tab.label}</span>
            </button>
          );
        })}
        {onClose && (
          <button
            onClick={onClose}
            title="Collapse Simulations"
            className="p-1 rounded-xl border border-transparent text-slate-400 hover:text-slate-100 hover:bg-slate-800/40 cursor-pointer transition flex items-center justify-center h-8 w-8"
          >
            <X size={15} />
          </button>
        )}
      </div>

      {/* Main Tab Workspace */}
      <div className="flex-1 flex flex-col overflow-hidden justify-between">
        <div className="flex-1 overflow-y-auto pr-1 space-y-3.5">
          {activeTab === 'traffic' && (
            <TrafficSimContent 
              results={trafficRes} 
              running={isRunning.traffic} 
              onRun={() => handleRunSim('traffic')} 
            />
          )}
          {activeTab === 'flood' && (
            <FloodSimContent 
              results={floodRes} 
              running={isRunning.flood} 
              onRun={() => handleRunSim('flood')} 
            />
          )}
          {activeTab === 'population' && (
            <PopulationSimContent 
              results={popRes} 
              running={isRunning.population} 
              onRun={() => handleRunSim('population')} 
            />
          )}
        </div>
      </div>
    </div>
  );
};

/* --- TAB SPECIFIC IMPLEMENTATIONS --- */

interface TabContentProps {
  results: any;
  running: boolean;
  onRun: () => void;
}

const TrafficLegend: React.FC = () => {
  return (
    <div className="bg-slate-900/30 p-2.5 rounded-xl border border-white/5 space-y-2">
      <div className="text-[10px] text-slate-400 uppercase font-semibold">Traffic Flow Legend</div>
      <div className="grid grid-cols-4 gap-1 text-[9px] text-center font-medium">
        <div className="flex flex-col items-center">
          <div className="w-full h-1.5 rounded-full bg-emerald-500 mb-1" />
          <span className="text-slate-300">Free Flow</span>
        </div>
        <div className="flex flex-col items-center">
          <div className="w-full h-1.5 rounded-full bg-yellow-500 mb-1" />
          <span className="text-slate-300">Moderate</span>
        </div>
        <div className="flex flex-col items-center">
          <div className="w-full h-1.5 rounded-full bg-orange-500 mb-1" />
          <span className="text-slate-300">Heavy</span>
        </div>
        <div className="flex flex-col items-center">
          <div className="w-full h-1.5 rounded-full bg-red-500 mb-1" />
          <span className="text-slate-300">Severe</span>
        </div>
      </div>
      <div className="text-[8px] text-slate-500 border-t border-white/5 pt-1 text-center">
        Elevated colored lines represent traffic on the flyover deck.
      </div>
    </div>
  );
};

const TrafficSimContent: React.FC<TabContentProps> = ({ results, running, onRun }) => {
  return (
    <div className="space-y-3 flex flex-col h-full justify-between">
      {running ? (
        <SimLoading message="Iterating vehicle pathways and routing algorithms..." />
      ) : results ? (
        <div className="space-y-2.5">
          <div className="grid grid-cols-2 gap-2 text-xs">
            <div className="bg-slate-900/30 p-2.5 rounded-xl border border-white/5">
              <span className="text-slate-500 text-[10px]">Average Speed</span>
              <div className="text-slate-200 font-semibold mt-0.5">{results.averageSpeed} km/h</div>
            </div>
            <div className="bg-slate-900/30 p-2.5 rounded-xl border border-white/5">
              <span className="text-slate-500 text-[10px]">Travel Time Index</span>
              <div className="text-slate-200 font-semibold mt-0.5">{results.travelTimeIndex.toFixed(2)}x</div>
            </div>
          </div>

          {/* Custom SVG Congestion Levels of Service Bar */}
          <div className="space-y-1 bg-slate-900/30 p-2.5 rounded-xl border border-white/5">
            <div className="flex justify-between text-[10px] text-slate-400">
              <span>LOS Distribution (A-F)</span>
              <span className="text-slate-300 font-mono">Congestion Index</span>
            </div>
            <div className="flex h-3 w-full rounded-full overflow-hidden mt-1.5">
              <div style={{ width: `${results.levelOfService.A}%` }} className="bg-emerald-500" title="LOS A (Free Flow)" />
              <div style={{ width: `${results.levelOfService.B}%` }} className="bg-green-500" title="LOS B" />
              <div style={{ width: `${results.levelOfService.C}%` }} className="bg-yellow-500" title="LOS C" />
              <div style={{ width: `${results.levelOfService.D}%` }} className="bg-amber-500" title="LOS D" />
              <div style={{ width: `${results.levelOfService.E}%` }} className="bg-orange-500" title="LOS E" />
              <div style={{ width: `${results.levelOfService.F}%` }} className="bg-red-500" title="LOS F (Gridlock)" />
            </div>
            <div className="flex justify-between text-[8px] text-slate-500 mt-1">
              <span>Free (A/B): {results.levelOfService.A + results.levelOfService.B}%</span>
              <span>Delay (E/F): {results.levelOfService.E + results.levelOfService.F}%</span>
            </div>
          </div>
        </div>
      ) : (
        <SimIdleAlert message="Calculates level of service congestion splits based on road lane width, dividers, and residential buildings population densities." />
      )}

      {!running && <TrafficLegend />}

      <button 
        onClick={onRun}
        className={`w-full py-2.5 rounded-xl text-xs font-semibold cursor-pointer border flex items-center justify-center gap-1.5 transition-all ${
          running 
            ? 'bg-red-950/20 text-red-400 border-red-500/25 hover:bg-red-900/20' 
            : results 
              ? 'bg-amber-600/10 text-amber-300 border-amber-500/20 hover:bg-amber-600/20' 
              : 'bg-indigo-600 text-white hover:bg-indigo-500 border-indigo-500/20 shadow-md shadow-indigo-500/10'
        }`}
      >
        {running ? <Square size={13} fill="currentColor" /> : <Play size={13} fill="currentColor" />}
        {running ? 'Halt Simulation' : results ? 'Flush & Recalculate' : 'Execute Traffic Model'}
      </button>
    </div>
  );
};

const FloodSimContent: React.FC<TabContentProps> = ({ results, running, onRun }) => {
  return (
    <div className="space-y-3 flex flex-col h-full justify-between">
      {running ? (
        <SimLoading message="Processing terrain contours, rainfall inputs, and drainage pipes flow rates..." />
      ) : results ? (
        <div className="space-y-2.5">
          <div className="bg-slate-900/30 p-3 rounded-xl border border-white/5 space-y-2">
            <div className="flex justify-between text-xs border-b border-white/5 pb-2">
              <span className="text-slate-500">Max Water Depth</span>
              <span className="text-sky-400 font-semibold">{results.waterDepthMax} meters</span>
            </div>
            <div className="flex justify-between text-xs border-b border-white/5 pb-2">
              <span className="text-slate-500">Submerged Buildings</span>
              <span className="text-slate-200 font-semibold">{Object.keys(results.floodedBuildingIds).length} units</span>
            </div>
            <div className="flex justify-between text-xs">
              <span className="text-slate-500">Affected Citizens</span>
              <span className="text-amber-400 font-semibold">{results.affectedPopulation.toLocaleString()} people</span>
            </div>
          </div>
        </div>
      ) : (
        <SimIdleAlert message="Simulates storm rainfall inundation overlay, highlighting flood depths across local topography elevations and low-elevation basements." />
      )}

      <button 
        onClick={onRun}
        className={`w-full py-2.5 rounded-xl text-xs font-semibold cursor-pointer border flex items-center justify-center gap-1.5 transition-all ${
          running 
            ? 'bg-red-950/20 text-red-400 border-red-500/25 hover:bg-red-900/20' 
            : results 
              ? 'bg-sky-600/10 text-sky-300 border-sky-500/20 hover:bg-sky-600/20' 
              : 'bg-indigo-600 text-white hover:bg-indigo-500 border-indigo-500/20'
        }`}
      >
        {running ? <Square size={13} fill="currentColor" /> : <Play size={13} fill="currentColor" />}
        {running ? 'Halt Simulation' : results ? 'Flush & Recalculate' : 'Run 100-Year Flood Model'}
      </button>
    </div>
  );
};

const PopulationSimContent: React.FC<TabContentProps> = ({ results, running, onRun }) => {
  return (
    <div className="space-y-3 flex flex-col h-full justify-between">
      {running ? (
        <SimLoading message="Processing residential population capacity limits and mixed-use commercial workspace demands..." />
      ) : results ? (
        <div className="space-y-2.5">
          <div className="bg-slate-900/30 p-2.5 rounded-xl border border-white/5 space-y-2">
            <div className="flex justify-between text-xs border-b border-white/5 pb-2">
              <span className="text-slate-500">Demographic Count</span>
              <span className="text-slate-200 font-semibold">{results.totalPopulation.toLocaleString()} citizens</span>
            </div>
            <div className="flex justify-between text-xs border-b border-white/5 pb-2">
              <span className="text-slate-500">Average Density</span>
              <span className="text-emerald-400 font-semibold">{results.averageDensity} people/km²</span>
            </div>
            <div className="flex justify-between text-xs">
              <span className="text-slate-500">Peak Transit Trips</span>
              <span className="text-indigo-400 font-semibold">{results.peakMovementVolume.toLocaleString()} trips/h</span>
            </div>
          </div>
        </div>
      ) : (
        <SimIdleAlert message="Calculates utility load requirements (water grid liters/day and electrical grid megawatt/hours) and peak-hour pedestrian commute flow trips." />
      )}

      <button 
        onClick={onRun}
        className={`w-full py-2.5 rounded-xl text-xs font-semibold cursor-pointer border flex items-center justify-center gap-1.5 transition-all ${
          running 
            ? 'bg-red-950/20 text-red-400 border-red-500/25 hover:bg-red-900/20' 
            : results 
              ? 'bg-emerald-600/10 text-emerald-300 border-emerald-500/20 hover:bg-emerald-600/20' 
              : 'bg-indigo-600 text-white hover:bg-indigo-500 border-indigo-500/20'
        }`}
      >
        {running ? <Square size={13} fill="currentColor" /> : <Play size={13} fill="currentColor" />}
        {running ? 'Halt Simulation' : results ? 'Flush & Recalculate' : 'Compute Demographic Loads'}
      </button>
    </div>
  );
};

/* --- HELPER WIDGETS --- */

const SimIdleAlert: React.FC<{ message: string }> = ({ message }) => {
  return (
    <div className="bg-slate-900/20 border border-white/5 rounded-xl p-3 flex flex-col items-center justify-center text-center py-6">
      <BarChart3 size={32} className="text-slate-600 mb-2" />
      <span className="text-xs font-semibold text-slate-400 mb-1">Analytical Model Idle</span>
      <p className="text-[10px] text-slate-500 leading-relaxed px-2">
        {message}
      </p>
    </div>
  );
};

const SimLoading: React.FC<{ message: string }> = ({ message }) => {
  return (
    <div className="flex flex-col items-center justify-center h-32 text-center">
      <Loader2 className="w-8 h-8 text-indigo-500 animate-spin mb-3" />
      <span className="text-xs font-semibold text-slate-300">Calculating Engine Parameters</span>
      <p className="text-[10px] text-slate-500 max-w-xs mt-1 leading-normal">
        {message}
      </p>
    </div>
  );
};

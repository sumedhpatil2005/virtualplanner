import React, { useEffect, useState } from 'react';
import { GitFork, ArrowLeftRight, TrendingUp, TrendingDown, Landmark, Activity } from 'lucide-react';
import { engineInstance } from '../engine/TwinCityEngine';
import type { Scenario } from '../engine/scenarios/ScenarioManager';

export const ScenarioSelector: React.FC = () => {
  const [scenarios, setScenarios] = useState<Scenario[]>([]);
  const [activeId, setActiveId] = useState('base');
  const [compareMode, setCompareMode] = useState(false);
  const [comparisonMetrics, setComparisonMetrics] = useState<any>(null);

  useEffect(() => {
    const unsub = engineInstance.scenarios.onChange((scens, active) => {
      setScenarios(scens);
      setActiveId(active);
    });

    setScenarios(engineInstance.scenarios.getAll());
    setActiveId(engineInstance.scenarios.getActiveScenarioId());

    return unsub;
  }, []);

  // Compute comparison metrics when active scenario changes or compareMode is toggled
  useEffect(() => {
    if (!compareMode || activeId === 'base') {
      setComparisonMetrics(null);
      return;
    }

    const all = engineInstance.objects.getAll();
    
    // Base Objects
    const baseObjects = all.filter(o => o.scenarioId === 'base');
    
    // Scenario Objects (base plus overrides / additions)
    const activeObjects = all.filter(o => {
      const isBaseObj = o.scenarioId === 'base';
      const isScenarioObj = o.scenarioId === activeId;
      if (!isBaseObj && !isScenarioObj) return false;
      
      // Override check
      if (isBaseObj) {
        const overrideExists = all.some(sub => sub.id === o.id && sub.scenarioId === activeId);
        if (overrideExists) return false;
      }
      return true;
    });

    // Compute Base statistics
    const basePop = baseObjects.filter(o => o.type === 'building').reduce((acc, b: any) => acc + b.population, 0);
    const baseWater = baseObjects.filter(o => o.type === 'building').reduce((acc, b: any) => acc + b.waterDemand, 0);
    const baseElec = baseObjects.filter(o => o.type === 'building').reduce((acc, b: any) => acc + b.electricityDemand, 0);

    // Compute Scenario statistics
    const activePop = activeObjects.filter(o => o.type === 'building').reduce((acc, b: any) => acc + b.population, 0);
    const activeWater = activeObjects.filter(o => o.type === 'building').reduce((acc, b: any) => acc + b.waterDemand, 0);
    const activeElec = activeObjects.filter(o => o.type === 'building').reduce((acc, b: any) => acc + b.electricityDemand, 0);

    // Compute Construction Cost estimation
    // Filter objects newly created for the proposal (not base)
    const proposedObjects = all.filter(o => o.scenarioId === activeId);
    let cost = 0;
    proposedObjects.forEach((obj: any) => {
      if (obj.type === 'flyover') {
        cost += obj.constructionCost || 12.5;
      } else if (obj.type === 'road') {
        cost += (obj.laneCount * 1.5); // Estimate 1.5M per lane per unit
      } else if (obj.type === 'building') {
        cost += (obj.floors * 0.8); // Estimate 0.8M per floor
      }
    });

    // Congestion Improvement Estimation
    let travelTimeDiff = 0;
    if (activeId === 'proposal_2028') travelTimeDiff = 18; // 18% faster
    else if (activeId === 'proposal_2030') travelTimeDiff = 8;
    else if (activeId === 'proposal_2035') travelTimeDiff = 32;

    setComparisonMetrics({
      popDelta: activePop - basePop,
      waterDelta: activeWater - baseWater,
      elecDelta: activeElec - baseElec,
      costEstimate: cost,
      travelTimeSaving: travelTimeDiff
    });
  }, [activeId, compareMode]);

  const handleScenarioChange = (id: string) => {
    engineInstance.scenarios.setActiveScenario(id);
  };

  const activeScenario = scenarios.find(s => s.id === activeId);

  return (
    <div className="glass-panel rounded-2xl p-4 flex flex-col pointer-events-auto shadow-2xl border border-white/5 gap-3 w-80">
      {/* Dropdown Selector */}
      <div className="flex flex-col gap-1.5">
        <label className="text-[10px] font-bold text-slate-500 uppercase tracking-widest font-mono flex items-center gap-1.5">
          <GitFork size={13} className="text-indigo-400" />
          Planning Scenario
        </label>
        <select
          value={activeId}
          onChange={(e) => handleScenarioChange(e.target.value)}
          className="w-full bg-slate-900 border border-slate-700/50 rounded-xl p-2.5 text-xs text-slate-200 focus:outline-none focus:border-indigo-500 cursor-pointer"
        >
          {scenarios.map((scen) => (
            <option key={scen.id} value={scen.id}>
              {scen.name} ({scen.year})
            </option>
          ))}
        </select>
      </div>

      {/* Description */}
      {activeScenario && (
        <p className="text-[10px] text-slate-400 leading-relaxed bg-slate-900/20 p-2 rounded-lg border border-white/5">
          {activeScenario.description}
        </p>
      )}

      {/* Comparison Toggle */}
      {activeId !== 'base' && (
        <div className="flex items-center justify-between border-t border-white/5 pt-2.5">
          <span className="text-[10px] font-semibold text-slate-300 flex items-center gap-1.5">
            <ArrowLeftRight size={13} className="text-indigo-400" />
            Compare with Base City
          </span>
          <label className="relative inline-flex items-center cursor-pointer">
            <input 
              type="checkbox" 
              checked={compareMode}
              onChange={(e) => setCompareMode(e.target.checked)}
              className="sr-only peer"
            />
            <div className="w-8 h-4 bg-slate-800 rounded-full peer peer-focus:ring-0 peer-checked:after:translate-x-full peer-checked:after:border-white after:content-[''] after:absolute after:top-0.5 after:left-[2px] after:bg-slate-400 after:border-slate-300 after:border after:rounded-full after:h-3 after:w-3 after:transition-all peer-checked:bg-indigo-600 peer-checked:after:bg-slate-100"></div>
          </label>
        </div>
      )}

      {/* Comparison Metrics Panel */}
      {compareMode && comparisonMetrics && (
        <div className="bg-indigo-950/20 border border-indigo-500/20 rounded-xl p-3 space-y-2.5 animate-fade-in">
          <div className="text-[9px] font-bold text-indigo-400 uppercase tracking-widest font-mono flex items-center gap-1 border-b border-indigo-500/10 pb-1.5">
            <Activity size={11} /> Proposal Performance Delta
          </div>

          <div className="space-y-2">
            {/* Travel Time */}
            <div className="flex items-center justify-between text-xs">
              <span className="text-slate-400 text-[10px]">Travel Time Savings</span>
              <span className="text-emerald-400 font-semibold flex items-center gap-0.5">
                <TrendingDown size={12} /> {comparisonMetrics.travelTimeSaving}% congestion drop
              </span>
            </div>

            {/* Construction Cost */}
            <div className="flex items-center justify-between text-xs">
              <span className="text-slate-400 text-[10px]">CapEx Estimate</span>
              <span className="text-amber-400 font-semibold flex items-center gap-0.5">
                <Landmark size={12} /> ${comparisonMetrics.costEstimate.toFixed(1)}M
              </span>
            </div>

            {/* Population Delta */}
            <div className="flex items-center justify-between text-xs">
              <span className="text-slate-400 text-[10px]">Extra Pop. Served</span>
              <span className="text-emerald-400 font-semibold flex items-center gap-0.5">
                <TrendingUp size={12} /> +{comparisonMetrics.popDelta.toLocaleString()} citizens
              </span>
            </div>

            {/* Resources Utility loads */}
            <div className="flex items-center justify-between text-xs">
              <span className="text-slate-400 text-[10px]">Water Load Delta</span>
              <span className={`font-semibold text-[10px] ${comparisonMetrics.waterDelta > 0 ? 'text-red-400' : 'text-emerald-400'}`}>
                {comparisonMetrics.waterDelta > 0 ? `+${(comparisonMetrics.waterDelta / 1000).toFixed(1)} m³/d` : 'No change'}
              </span>
            </div>

            <div className="flex items-center justify-between text-xs">
              <span className="text-slate-400 text-[10px]">Electric Load Delta</span>
              <span className={`font-semibold text-[10px] ${comparisonMetrics.elecDelta > 0 ? 'text-red-400' : 'text-emerald-400'}`}>
                {comparisonMetrics.elecDelta > 0 ? `+${(comparisonMetrics.elecDelta / 1000).toFixed(1)} MWh/d` : 'No change'}
              </span>
            </div>
          </div>
        </div>
      )}
    </div>
  );
};

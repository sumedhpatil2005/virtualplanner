import React, { useEffect, useState } from 'react';
import { Eye, EyeOff, Layers, Sliders } from 'lucide-react';
import { engineInstance } from '../engine/TwinCityEngine';
import type { Layer } from '../engine/layers/LayerManager';

export const LayerManager: React.FC = () => {
  const [layers, setLayers] = useState<Layer[]>([]);

  useEffect(() => {
    const unsub = engineInstance.layers.onChange((updatedLayers) => {
      setLayers(updatedLayers);
    });
    setLayers(engineInstance.layers.getAll());
    return unsub;
  }, []);

  const handleToggle = (id: string, currentVal: boolean) => {
    engineInstance.layers.setVisibility(id, !currentVal);
  };

  const handleOpacityChange = (id: string, opacity: number) => {
    engineInstance.layers.setOpacity(id, opacity);
  };

  const categories = [
    { id: 'base', name: 'Base Maps' },
    { id: 'infrastructure', name: 'Built Infrastructure' },
    { id: 'utilities', name: 'Sub-surface Utilities' },
    { id: 'simulations', name: 'Simulation Heatmaps' }
  ];

  return (
    <div className="w-64 glass-panel rounded-2xl p-4 flex flex-col h-[320px] pointer-events-auto shadow-2xl border border-white/5">
      {/* Header */}
      <div className="flex items-center gap-2 border-b border-white/5 pb-2.5 mb-3">
        <Layers size={16} className="text-indigo-400" />
        <span className="font-semibold text-xs text-slate-200 uppercase tracking-wider">Layer Registry</span>
      </div>

      {/* Layer List grouped by category */}
      <div className="flex-1 overflow-y-auto space-y-4 pr-1">
        {categories.map((cat) => {
          const catLayers = layers.filter(l => l.category === cat.id);
          if (catLayers.length === 0) return null;

          return (
            <div key={cat.id} className="space-y-1.5">
              <div className="text-[9px] font-bold text-slate-500 uppercase tracking-widest font-mono">
                {cat.name}
              </div>
              <div className="space-y-1">
                {catLayers.map((layer) => {
                  return (
                    <div 
                      key={layer.id} 
                      className={`flex flex-col gap-1.5 p-1.5 rounded-lg transition-all ${
                        layer.visible ? 'bg-slate-900/20' : 'opacity-60'
                      }`}
                    >
                      <div className="flex items-center justify-between">
                        <span className="text-[11px] font-medium text-slate-300">
                          {layer.name}
                        </span>
                        <button
                          onClick={() => handleToggle(layer.id, layer.visible)}
                          className="text-slate-400 hover:text-slate-200 cursor-pointer transition"
                        >
                          {layer.visible ? <Eye size={13} /> : <EyeOff size={13} />}
                        </button>
                      </div>

                      {/* Opacity slider for visible layers */}
                      {layer.visible && (
                        <div className="flex items-center gap-1.5 px-0.5">
                          <Sliders size={9} className="text-slate-500" />
                          <input 
                            type="range"
                            min="0"
                            max="1"
                            step="0.05"
                            value={layer.opacity}
                            onChange={(e) => handleOpacityChange(layer.id, Number(e.target.value))}
                            className="w-full h-0.5 bg-slate-800 rounded-lg appearance-none cursor-pointer accent-indigo-500"
                          />
                          <span className="text-[8px] text-slate-500 w-5 text-right">
                            {Math.round(layer.opacity * 100)}%
                          </span>
                        </div>
                      )}
                    </div>
                  );
                })}
              </div>
            </div>
          );
        })}
      </div>
    </div>
  );
};

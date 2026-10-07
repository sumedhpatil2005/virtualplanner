import React, { useEffect } from 'react';
import { Link2, Eye, CheckCircle2 } from 'lucide-react';
import { engineInstance } from '../engine/TwinCityEngine';
import type { RoadObject } from '../engine/objects/types';
import type { RoadEndGap } from '../engine/editing/roadGaps';

/**
 * Road ends that stop just short of another road, with a reviewed Connect fix.
 * Shown for a selected ground road; connecting needs Build mode.
 */
export const RoadGapPanel: React.FC<{ road: RoadObject }> = ({ road }) => {
  // Recomputed on every render: the selected road object changes identity whenever roads are edited
  const gaps = engineInstance.findRoadGaps(road.id);
  const canEdit = engineInstance.isPlanningModeActive();

  // Never leave a preview line behind when the road is deselected or the gap closes
  useEffect(() => () => engineInstance.previewRoadGap(null), [road.id]);

  const connect = (gap: RoadEndGap) => {
    try {
      engineInstance.connectRoadGap(gap);
      (window as any).showToast?.('Roads connected. Ctrl+Z to undo.', 'success');
    } catch (err: any) {
      (window as any).showToast?.(err?.message || 'Could not connect the roads.', 'error');
    }
  };

  const targetName = (gap: RoadEndGap) => engineInstance.objects.getById(gap.targetRoadId)?.name || 'another road';

  return (
    <div className="bg-slate-950/50 p-3 rounded-lg border border-white/5 space-y-2 mt-3">
      <div className="text-sm text-slate-400 uppercase font-semibold border-b border-white/5 pb-1.5">Road ends</div>
      {gaps.length === 0 ? (
        <div className="flex items-center gap-1.5 text-sm text-emerald-400">
          <CheckCircle2 size={12} /> No ends stopping just short of another road.
        </div>
      ) : (
        <>
          {gaps.map(gap => (
            <div key={gap.end} className="space-y-1.5">
              <p className="text-sm text-amber-300 leading-snug">
                The {gap.end === 'start' ? 'start' : 'end'} of this road stops {Math.round(gap.gapM)} m short of "{targetName(gap)}", so no traffic can pass between them.
              </p>
              <div className="flex gap-1.5">
                <button
                  onClick={() => engineInstance.simMode.flyTo(gap.endPoint)}
                  className="flex items-center gap-1 px-2 py-1 rounded-lg text-xs text-slate-300 bg-slate-800/60 hover:bg-slate-700/60 cursor-pointer"
                >
                  <Eye size={11} /> Show
                </button>
                <button
                  onClick={() => connect(gap)}
                  onMouseEnter={() => engineInstance.previewRoadGap(gap)}
                  onMouseLeave={() => engineInstance.previewRoadGap(null)}
                  onFocus={() => engineInstance.previewRoadGap(gap)}
                  onBlur={() => engineInstance.previewRoadGap(null)}
                  disabled={!canEdit}
                  title={canEdit ? 'Extend this road to meet the other one (hover to preview)' : 'Switch to Build mode to edit roads'}
                  className={`flex items-center gap-1 px-2 py-1 rounded-lg text-xs font-semibold ${
                    canEdit
                      ? 'text-emerald-200 bg-emerald-900/40 hover:bg-emerald-800/50 cursor-pointer'
                      : 'text-slate-500 bg-slate-800/40 cursor-not-allowed'
                  }`}
                >
                  <Link2 size={11} /> Connect
                </button>
              </div>
            </div>
          ))}
          <p className="text-xs text-slate-500 leading-snug">
            Check the map first: a gap can be real, such as a wall or a gate. Connect only roads that meet on the ground.
          </p>
        </>
      )}
    </div>
  );
};

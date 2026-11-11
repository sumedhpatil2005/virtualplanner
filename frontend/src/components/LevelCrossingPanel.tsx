import React from 'react';
import { Eye, Link2, Layers } from 'lucide-react';
import { engineInstance } from '../engine/TwinCityEngine';

/**
 * Crossings of a drawn road whose level the data does not settle (a bridge, tunnel or layer tag, a drawn flyover, or a
 * ramp height off the ground, with heights within 3 m): kept apart in the traffic network until the user decides.
 * docs/TOPOLOGY_RECONSTRUCTION.md.
 */
export const LevelCrossingPanel: React.FC<{ roadId: string }> = ({ roadId }) => {
  const list = engineInstance.uncertainCrossings(roadId);
  if (list.length === 0) return null;
  const canEdit = engineInstance.isPlanningModeActive();
  const name = (id: string) => engineInstance.objects.getById(id)?.name || 'another road';
  const act = (index: number, decision: 'junction' | 'separate') => {
    try {
      engineInstance.resolveLevelCrossing(roadId, index, decision);
      (window as any).showToast?.(decision === 'junction' ? 'Junction made: traffic can turn here. Ctrl+Z to undo.' : 'Kept separate: the roads pass each other. Ctrl+Z to undo.', 'success');
    } catch (err: any) {
      (window as any).showToast?.(err?.message || 'Could not change the crossing.', 'error');
    }
  };
  return (
    <div data-testid="level-crossings" className="bg-slate-950/50 p-3 rounded-lg border border-amber-500/20 space-y-2 mt-3">
      <div className="text-sm text-slate-400 uppercase font-semibold border-b border-white/5 pb-1.5 flex items-center gap-1.5"><Layers size={12} /> Crossings to check</div>
      {list.map(f => (
        <div key={f.index} className="space-y-1.5">
          <p className="text-sm text-amber-300 leading-snug">
            Crosses "{name(f.roadId)}": level unknown ({f.reason}). Kept separate for now: no traffic turns here.
          </p>
          <div className="flex gap-1.5 flex-wrap">
            <button onClick={() => engineInstance.simMode.flyTo(f.point)} className="flex items-center gap-1 px-2 py-1 rounded-lg text-xs text-slate-300 bg-slate-800/60 hover:bg-slate-700/60 cursor-pointer"><Eye size={11} /> Show</button>
            <button data-testid="confirm-junction" disabled={!canEdit} onClick={() => act(f.index, 'junction')} className={`flex items-center gap-1 px-2 py-1 rounded-lg text-xs font-semibold ${canEdit ? 'text-emerald-200 bg-emerald-900/40 hover:bg-emerald-800/50 cursor-pointer' : 'text-slate-500 bg-slate-800/40 cursor-not-allowed'}`}><Link2 size={11} /> Confirm junction</button>
            <button data-testid="keep-separate" disabled={!canEdit} onClick={() => act(f.index, 'separate')} className={`flex items-center gap-1 px-2 py-1 rounded-lg text-xs font-semibold ${canEdit ? 'text-slate-200 bg-slate-800/60 hover:bg-slate-700/60 cursor-pointer' : 'text-slate-500 bg-slate-800/40 cursor-not-allowed'}`}>Keep separate</button>
          </div>
        </div>
      ))}
      <p className="text-xs text-slate-500 leading-snug">Check the map or a site visit: confirm a junction only where the roads meet at the same level.</p>
    </div>
  );
};

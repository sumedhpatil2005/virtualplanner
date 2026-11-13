import React, { useEffect, useState } from 'react';
import { undergroundView } from '../../engine/underground/UndergroundView';
import type { UndergroundAlignmentObject } from '../../engine/objects/types';
import { alignmentsRect } from '../../engine/underground/viewRect';

/** Ground opacity, X-ray, and "limit to alignments" (Cesium globe translucency). Real controls on the globe. */
export const ViewControls: React.FC<{ alignments: UndergroundAlignmentObject[] }> = ({ alignments }) => {
  const [s, setS] = useState(undergroundView.getSettings());
  const [active, setActive] = useState(undergroundView.isActive());
  const [limit, setLimit] = useState(s.rectangleDeg !== null);
  useEffect(() => undergroundView.onChange(() => { setS(undergroundView.getSettings()); setActive(undergroundView.isActive()); }), []);
  const rect = alignmentsRect(alignments);
  const rectKey = rect?.join(',') ?? '';
  // Keep the limited area following the alignments
  useEffect(() => { if (limit) undergroundView.update({ rectangleDeg: rect }); }, [limit, rectKey]); // eslint-disable-line react-hooks/exhaustive-deps
  const pct = Math.round(s.groundOpacity * 100);
  return (
    <div className="flex flex-col gap-2" data-testid="ug-view-controls">
      <label className="flex items-center gap-3 text-label text-text-2">
        <span className="w-24 shrink-0">Ground opacity</span>
        <input type="range" min={0} max={100} step={5} value={pct} className="flex-1" data-testid="ug-ground-opacity" aria-label="Ground opacity (%)"
          onChange={e => undergroundView.update({ groundOpacity: Number(e.target.value) / 100 })} disabled={!active} />
        <span className="w-10 text-right tabular-nums text-text-1" data-testid="ug-ground-opacity-value">{pct}%</span>
      </label>
      <div className="flex flex-wrap gap-x-4 gap-y-1">
        <label className="flex items-center gap-2 text-label text-text-2 min-h-8">
          <input type="checkbox" checked={s.xray} data-testid="ug-xray" onChange={e => undergroundView.update({ xray: e.target.checked })} disabled={!active} /> X-ray
        </label>
        <label className="flex items-center gap-2 text-label text-text-2 min-h-8" title={rect ? 'Only the ground around the alignments is see-through' : 'Draw an alignment first'}>
          <input type="checkbox" checked={limit} data-testid="ug-limit-rect" disabled={!active || !rect}
            onChange={e => { setLimit(e.target.checked); undergroundView.update({ rectangleDeg: e.target.checked ? rect : null }); }} /> Only around alignments
        </label>
      </div>
      <p className="text-meta text-text-3">{active ? 'Camera may go below ground here (collision off). Leaving Underground restores the normal view.' : 'Map not ready.'}</p>
    </div>
  );
};

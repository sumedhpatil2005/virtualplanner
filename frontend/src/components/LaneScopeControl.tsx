import React, { useEffect, useMemo, useRef, useState, useSyncExternalStore } from 'react';
import { engineInstance } from '../engine/TwinCityEngine';
import type { RoadObject } from '../engine/objects/types';
import { DEFAULT_LANE_EDIT_SCOPE, laneEditPreview, type LaneEditScope, type LaneField } from '../engine/editing/roadEdits';
import { subscribeLaneScope, getLaneEditScope, setLaneEditScope, laneEditAppliedCount } from './laneScopeStore';

/**
 * Lane edit scope in Build (docs/OVERHAUL.md §16): whether a lane change
 * covers the whole connected carriageway (the default: the other OSM pieces of
 * the same road running the same way, roadEdits.carriagewayPieces) or only the
 * selected way. While the lane controls are hovered or focused, or once a
 * scope is picked, the ways the edit will change are highlighted on the map
 * and counted here ("3 pieces · 564 m"). The highlight clears when the road is
 * deselected and after the edit is applied.
 */

const OPTIONS: { id: LaneEditScope; label: string; title: string }[] = [
  { id: 'carriageway', label: 'Entire carriageway', title: 'Change the lanes on every connected piece of this road running this way (same name and lanes), up to a junction with another main road, a fork or 900 m' },
  { id: 'segment', label: 'This segment only', title: 'Change the lanes on the selected OpenStreetMap way only' },
];

/**
 * Wraps the lane selects of a road: tracks hover and focus (and which
 * direction's select, from `data-lane-field`), then shows the scope control
 * and the preview under them.
 */
export const LaneScopeControl: React.FC<{ road: RoadObject; children: React.ReactNode }> = ({ road, children }) => {
  const current = useSyncExternalStore(subscribeLaneScope, getLaneEditScope);
  const applied = useSyncExternalStore(subscribeLaneScope, laneEditAppliedCount);
  const [hover, setHover] = useState(false);
  const [focus, setFocus] = useState(false);
  const [pinned, setPinned] = useState(false);
  const [suppressed, setSuppressed] = useState(false);
  const [field, setField] = useState<LaneField>('lanesForward');

  // Another road: back to the default scope, nothing highlighted
  useEffect(() => {
    setLaneEditScope(DEFAULT_LANE_EDIT_SCOPE);
    setPinned(false);
    setField('lanesForward');
  }, [road.id]);
  // After an edit is applied the highlight stays off until the pointer leaves the controls
  const appliedOnMount = useRef(applied);
  useEffect(() => { if (applied !== appliedOnMount.current) { setPinned(false); setSuppressed(true); } }, [applied]);

  const preview = useMemo(() => {
    const roads = engineInstance.objects.getAll().filter((o): o is RoadObject => o.type === 'road');
    return laneEditPreview(roads, road.id, field, current);
  }, [road, field, current]);

  const active = (hover || focus || pinned) && !suppressed;
  useEffect(() => {
    engineInstance.highlightRoads(active ? preview.roadIds : null, 'lane-scope');
  }, [active, preview]);
  useEffect(() => () => engineInstance.highlightRoads(null, 'lane-scope'), []);

  const fieldOf = (t: EventTarget) => (t instanceof Element ? (t.closest('[data-lane-field]')?.getAttribute('data-lane-field') as LaneField | null) : null);
  return (
    <div
      className="flex flex-col gap-3.5"
      data-testid="lane-edit-block"
      onMouseEnter={() => setHover(true)}
      onMouseLeave={() => { setHover(false); setSuppressed(false); }}
      onMouseOver={e => { const f = fieldOf(e.target); if (f) setField(f); }}
      onFocus={e => { setFocus(true); const f = fieldOf(e.target); if (f) setField(f); }}
      onBlur={e => { if (!e.currentTarget.contains(e.relatedTarget as Node | null)) setFocus(false); }}
    >
      {children}
      <div className="flex flex-col gap-1" data-testid="lane-scope" data-scope={current}>
        <label className="text-xs text-slate-400 uppercase font-semibold">Apply lane changes to</label>
        <div role="radiogroup" aria-label="Apply lane changes to" className="grid grid-cols-2 gap-1 rounded-lg bg-slate-900 border border-slate-700/50 p-0.5">
          {OPTIONS.map(o => (
            <button
              key={o.id}
              type="button"
              role="radio"
              aria-checked={current === o.id}
              title={o.title}
              data-testid={`lane-scope-${o.id}`}
              onClick={() => { setLaneEditScope(o.id); setPinned(true); setSuppressed(false); }}
              className={`rounded-md px-2 py-1 text-[11px] font-medium transition-colors ${current === o.id ? 'bg-indigo-500/30 text-indigo-100 border border-indigo-400/40' : 'text-slate-400 border border-transparent hover:text-slate-200'}`}
            >
              {o.label}
            </button>
          ))}
        </div>
        <p className="flex items-center gap-1.5 text-[11px] text-slate-400" data-testid="lane-scope-preview" data-road-ids={preview.roadIds.join(',')} data-count={preview.count} data-length-m={preview.lengthM}>
          <span className="inline-block h-1.5 w-3 rounded-full" style={{ background: '#e879f9', opacity: active ? 1 : 0.45 }} aria-hidden />
          Will change {preview.label}{field === 'lanesBackward' ? ' (backward lanes)' : ''}
          {active && <span className="text-fuchsia-300">· shown on map</span>}
        </p>
      </div>
    </div>
  );
};

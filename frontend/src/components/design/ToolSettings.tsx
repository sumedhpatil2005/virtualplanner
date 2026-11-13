import React, { useState } from 'react';
import { engineInstance } from '../../engine/TwinCityEngine';
import type { EditingMode } from '../../engine/editing/EditingEngine';
import { DEFAULT_BUILDING_FLOORS, DEFAULT_ZONE_POPULATION, DEFAULT_ZONE_EMPLOYMENT, DEFAULT_UTILITY_DEPTH_M, GATEWAY_SNAP_M, clampFloors } from '../../engine/editing/EditingEngine';
import type { RoadClassification, BuildingUsage, UtilityType } from '../../engine/objects/types';
import { CertaintyBadge } from '../ui/badges/CertaintyBadge';
import type { Certainty } from '../ui/badges/honesty';
import { ImportAreaPanel } from './ImportAreaPanel';

const field = 'flex flex-col gap-0.5';
const lbl = 'text-[11px] font-semibold uppercase tracking-wide flex items-center gap-1.5';
const input = 'rounded border px-1.5 py-1 text-[13px] focus:outline-none w-full';
const inputStyle: React.CSSProperties = { background: 'var(--surface-2, #1E252E)', borderColor: 'var(--border-strong, #4A5563)', color: 'var(--text-1, #E6EAF0)' };
const labelStyle: React.CSSProperties = { color: 'var(--text-2, #A9B3C1)' };
const note: React.CSSProperties = { color: 'var(--text-3, #8B95A3)' };

/** Utility types offered: each has its own layer in the Layers panel (water, electric, sewage, gas, fiber). */
const UTILITY_TYPE_OPTIONS: { value: UtilityType; label: string }[] = [
  { value: 'water', label: 'Water' },
  { value: 'sewage', label: 'Sewage' },
  { value: 'electricity', label: 'Electrical' },
  { value: 'gas', label: 'Gas' },
  { value: 'fiber', label: 'Fibre / telecom' },
];

const CERTAINTY_OPTIONS: { value: Certainty; label: string }[] = [
  { value: 'hypothetical', label: 'Hypothetical (design / assumed)' },
  { value: 'estimated', label: 'Estimated' },
  { value: 'measured', label: 'Measured (survey / record)' },
  { value: 'unknown', label: 'Unknown' },
];

/**
 * Per-tool settings. Every field writes the EditingEngine tool setting that the next drawn
 * object uses; defaults are shown as HYPOTHETICAL (docs/urbanos/DESIGN_TOOLS_AND_HONESTY.md §4).
 */
export const ToolSettings: React.FC<{ mode: EditingMode }> = ({ mode }) => {
  const e = engineInstance.editing;
  const [, bump] = useState(0);
  const set = (fn: () => void) => { fn(); bump(n => n + 1); };

  if (mode === 'draw_junction') return <p className="text-[12px] leading-relaxed" style={labelStyle}>Move onto a road connection. The cyan footprint shows the roads that will join; red means placement is unavailable. Click to place, then use Select to edit signals and crossings.</p>;

  if (mode === 'draw_road' || mode === 'draw_flyover') return (
    <div className={field} data-testid="tool-setting-road-class">
      <label className={lbl} style={labelStyle} htmlFor="ts-road-class">Road class</label>
      <select id="ts-road-class" value={e.roadClass} onChange={ev => set(() => { e.roadClass = ev.target.value as RoadClassification; })} className={input} style={inputStyle}>
        <option value="highway">Highway</option><option value="arterial">Arterial</option><option value="collector">Collector</option><option value="local">Local</option>
      </select>
      <p className="text-[11px]" style={note}>Sets width, lanes, speed limit and capacity defaults; edit them on the object after drawing.</p>
    </div>
  );

  if (mode === 'draw_building') return (
    <div className="flex flex-col gap-2">
      <div className={field}>
        <label className={lbl} style={labelStyle} htmlFor="ts-building-use">Building use</label>
        <select id="ts-building-use" value={e.buildingUsage} onChange={ev => set(() => { e.buildingUsage = ev.target.value as BuildingUsage; })} className={input} style={inputStyle}>
          <option value="residential">Residential</option><option value="commercial">Commercial</option><option value="industrial">Industrial</option><option value="educational">Education</option>
        </select>
      </div>
      <div className={field}>
        <label className={lbl} style={labelStyle} htmlFor="ts-building-floors">Floors <CertaintyBadge certainty="hypothetical" note="Design input for the next building." /></label>
        <input id="ts-building-floors" data-testid="tool-setting-floors" type="number" min={1} max={200} step={1} value={e.buildingFloors}
          onChange={ev => set(() => { e.buildingFloors = clampFloors(Number(ev.target.value)); })} className={input} style={inputStyle} />
        <p className="text-[11px]" style={note}>Height = floors × 3 m. Default {DEFAULT_BUILDING_FLOORS}. Population, parking and utility demand are derived from it and are also hypothetical.</p>
      </div>
    </div>
  );

  if (mode === 'draw_utility') return (
    <div className="flex flex-col gap-2">
      <div className={field}>
        <label className={lbl} style={labelStyle} htmlFor="ts-utility-type">Utility type</label>
        <select id="ts-utility-type" data-testid="tool-setting-utility-type" value={e.utilityType} onChange={ev => set(() => { e.utilityType = ev.target.value as UtilityType; })} className={input} style={inputStyle}>
          {UTILITY_TYPE_OPTIONS.map(o => <option key={o.value} value={o.value}>{o.label}</option>)}
        </select>
      </div>
      <div className="grid grid-cols-2 gap-2">
        <div className={field}>
          <label className={lbl} style={labelStyle} htmlFor="ts-utility-depth">Depth (m)</label>
          <input id="ts-utility-depth" data-testid="tool-setting-utility-depth" type="number" min={0.1} max={60} step={0.1} value={e.utilityDepthM}
            onChange={ev => set(() => { const v = Number(ev.target.value); e.utilityDepthM = Number.isFinite(v) && v > 0 ? v : DEFAULT_UTILITY_DEPTH_M; })} className={input} style={inputStyle} />
        </div>
        <div className={field}>
          <label className={lbl} style={labelStyle} htmlFor="ts-utility-diameter">Diameter (mm)</label>
          <input id="ts-utility-diameter" data-testid="tool-setting-utility-diameter" type="number" min={1} step={1} placeholder="Unknown" value={e.utilityDiameterMm ?? ''}
            onChange={ev => set(() => { const v = Number(ev.target.value); e.utilityDiameterMm = ev.target.value === '' || !Number.isFinite(v) || v <= 0 ? null : v; })} className={input} style={inputStyle} />
        </div>
      </div>
      <div className={field}>
        <label className={lbl} style={labelStyle} htmlFor="ts-utility-depth-cert">Depth is <CertaintyBadge certainty={e.utilityDepthCertainty} /></label>
        <select id="ts-utility-depth-cert" data-testid="tool-setting-utility-depth-certainty" value={e.utilityDepthCertainty} onChange={ev => set(() => { e.utilityDepthCertainty = ev.target.value as Certainty; })} className={input} style={inputStyle}>
          {CERTAINTY_OPTIONS.map(o => <option key={o.value} value={o.value}>{o.label}</option>)}
        </select>
        <p className="text-[11px]" style={note}>Default depth {DEFAULT_UTILITY_DEPTH_M} m is an assumption. A blank diameter is stored as unknown, not 0.</p>
      </div>
    </div>
  );

  if (mode === 'draw_zone') return (
    <div className="flex flex-col gap-2">
      <p className="text-[12px]" style={labelStyle}>A traffic demand zone (not a land-use zoning plan). Its values are what-if inputs.</p>
      <div className="grid grid-cols-2 gap-2">
        <div className={field}>
          <label className={lbl} style={labelStyle} htmlFor="ts-zone-pop">Residents</label>
          <input id="ts-zone-pop" data-testid="tool-setting-zone-population" type="number" min={0} step={100} value={e.zonePopulation} onChange={ev => set(() => { e.zonePopulation = Math.max(0, Number(ev.target.value) || 0); })} className={input} style={inputStyle} />
        </div>
        <div className={field}>
          <label className={lbl} style={labelStyle} htmlFor="ts-zone-emp">Jobs</label>
          <input id="ts-zone-emp" data-testid="tool-setting-zone-employment" type="number" min={0} step={100} value={e.zoneEmployment} onChange={ev => set(() => { e.zoneEmployment = Math.max(0, Number(ev.target.value) || 0); })} className={input} style={inputStyle} />
        </div>
      </div>
      <p className="text-[11px] flex items-center gap-1.5 flex-wrap" style={note}><CertaintyBadge certainty="hypothetical" /> Defaults {DEFAULT_ZONE_POPULATION.toLocaleString('en-IN')} residents / {DEFAULT_ZONE_EMPLOYMENT.toLocaleString('en-IN')} jobs are placeholders, not data.</p>
    </div>
  );

  if (mode === 'draw_gateway') return (
    <div className="flex flex-col gap-1.5">
      <p className="text-[12px]" style={labelStyle}>Click within {GATEWAY_SNAP_M} m of a road node; the gateway snaps to the nearest node.</p>
      <p className="text-[11px] flex items-center gap-1.5 flex-wrap" style={note}><CertaintyBadge certainty="hypothetical" /> Inbound/outbound flows and mode split start as placeholders. Enter observed values in the inspector.</p>
    </div>
  );

  if (mode === 'import_osm') return <ImportAreaPanel />;
  return null;
};

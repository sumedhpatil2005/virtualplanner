import React from 'react';
import { Layers } from 'lucide-react';
import { EmptyState } from '../ui/EmptyState';
import type { Well } from '../../lib/terrainApi';
import { useActiveAlignment } from './common';
import { useSubsurfaceEvidence } from './useTerrain';

const box = 'rounded border p-2 flex flex-col gap-1';
const boxStyle: React.CSSProperties = { borderColor: 'var(--border, #2C3540)', background: 'var(--surface-1, #161B22)' };
const th = 'text-left font-semibold px-1.5 py-0.5';
const td = 'px-1.5 py-0.5 tabular-nums';
const n = (v: number | null | undefined, d = 1, u = '') => (v === null || v === undefined || !Number.isFinite(v) ? 'Unknown' : `${v.toFixed(d)}${u}`);
const km = (m: number) => (m >= 1000 ? `${(m / 1000).toFixed(2)} km` : `${Math.round(m)} m`);

/** Depth-to-water sparkline (m bgl, deeper = lower). Plots only the observations; no smoothing, no gap filling. */
const Sparkline: React.FC<{ w: Well }> = ({ w }) => {
  const s = w.series;
  if (s.length < 2) return <span className="text-text-3">{s.length} observation{s.length === 1 ? '' : 's'}</span>;
  const W = 140, H = 28;
  const t = s.map(o => Date.parse(o.date)), v = s.map(o => o.depth_m_bgl);
  const t0 = Math.min(...t), t1 = Math.max(...t), v0 = Math.min(...v), v1 = Math.max(...v);
  const pts = s.map((_, i) => [((t[i] - t0) / (t1 - t0 || 1)) * (W - 4) + 2, ((v[i] - v0) / (v1 - v0 || 1)) * (H - 4) + 2]);
  return (
    <svg width={W} height={H} role="img" aria-label={`Depth to water ${s[0].date} to ${s[s.length - 1].date}, ${n(v0)}–${n(v1)} m bgl`} data-testid="ug-ev-sparkline">
      <title>{`${s.length} observations ${s[0].date} → ${s[s.length - 1].date}; range ${n(v0)}–${n(v1)} m bgl (down = deeper)`}</title>
      <polyline points={pts.map(p => p.join(',')).join(' ')} fill="none" stroke="#38bdf8" strokeWidth={1} />
      {pts.map((p, i) => <circle key={i} cx={p[0]} cy={p[1]} r={1.2} fill="#38bdf8" />)}
    </svg>
  );
};

/** Drawer tab: evidence near the active alignment (wells, soil, sewers, boreholes). Nothing interpolated. */
export const SubsurfaceEvidenceView: React.FC = () => {
  const { active } = useActiveAlignment();
  const ev = useSubsurfaceEvidence(active?.coordinates);
  if (!active) return <EmptyState icon={Layers} title="No underground alignment in this alternative">Draw one with the Tunnel tool to list evidence near it.</EmptyState>;
  if (ev.state === 'loading' || ev.state === 'idle') return <div className="text-meta text-text-3 p-2">Loading evidence near {active.name}…</div>;
  if (ev.state === 'error') return <div className="text-meta p-2" style={{ color: 'var(--danger, #f87171)' }} data-testid="ug-ev-error">Evidence service unavailable: {ev.error}. Ground data near this alignment: UNKNOWN.</div>;
  const e = ev.data;
  const gw = e.groundwater, so = e.soil, sw = e.sewers, bh = e.boreholes;
  return (
    <div className="flex flex-col gap-2 text-meta text-text-2" data-testid="ug-evidence">
      <div className="text-text-3">{e.honesty} Distances in EPSG:32643. Chainages are measured on UTM 43N and can differ from the editor's by ≤0.1 %.</div>
      <div className="grid gap-2" style={{ gridTemplateColumns: 'repeat(auto-fit, minmax(min(100%, 380px), 1fr))' }}>
        <section className={box} style={boxStyle} data-testid="ug-ev-wells">
          <div className="text-text-1 font-medium">Groundwater wells within {gw.radius_km} km · {gw.wells.length} <span className="text-text-3 font-normal">— point observation, not interpolated</span></div>
          <div className="text-text-3">{gw.statement} Source: NWDP (CGWB / GSDA manual readings), {gw.dataset.dataset_id} {gw.dataset.version ?? ''}.</div>
          {gw.wells.length === 0
            ? <div data-testid="ug-ev-wells-none">{gw.status}. Groundwater level at the alignment: UNKNOWN.</div>
            : <div className="overflow-x-auto"><table className="w-full"><thead><tr className="text-text-3"><th className={th}>Well</th><th className={th}>Distance</th><th className={th}>Latest, m bgl</th><th className={th}>Date</th><th className={th}>Series</th></tr></thead>
              <tbody>{gw.wells.map(w => (
                <tr key={w.station_id} data-testid="ug-ev-well">
                  <td className={td} title={`${w.station_id} · ${w.agency ?? ''} · well depth ${n(w.well_depth_m)} · aquifer ${w.aquifer ?? 'Unknown'}`}>{w.village ?? w.station_id} <span className="text-text-3">{w.agency}</span></td>
                  <td className={td}>{km(w.distance_m)}</td>
                  <td className={td}>{w.latest ? w.latest.depth_m_bgl.toFixed(2) : 'Unknown'}</td>
                  <td className={td}>{w.latest?.date ?? '—'}</td>
                  <td className={td}><Sparkline w={w} /> <span className="text-text-3">{w.n_obs} observations since {w.first_date ?? 'Unknown'}</span></td>
                </tr>))}</tbody></table></div>}
        </section>
        <section className={box} style={boxStyle} data-testid="ug-ev-boreholes">
          <div className="text-text-1 font-medium">Boreholes within {bh.radius_km} km · {bh.records.length}</div>
          {bh.records.length === 0
            ? <div data-testid="ug-ev-boreholes-none"><span className="font-semibold" style={{ color: 'var(--warning, #fbbf24)' }}>{bh.message}</span>. {bh.import_hint} <span className="text-text-3">({bh.source})</span></div>
            : bh.records.map(r => <div key={r.id}>{r.external_id} · {km(r.distance_m)} away · final depth {n(r.final_depth_m, 1, ' m')}</div>)}
          <div className="text-text-1 font-medium mt-1">Topsoil (SoilGrids 2.0, {so.depth}) · {so.points.length} points every ≈250 m, {so.n_unknown ?? 0} UNKNOWN</div>
          <div className="text-text-3">{so.statement}</div>
          <div className="overflow-x-auto"><table className="w-full" data-testid="ug-ev-soil"><thead><tr className="text-text-3"><th className={th}>Ch (m)</th>{so.properties.map(p => <th key={p.key} className={th}>{p.label} ({p.unit})</th>)}</tr></thead>
            <tbody>{so.points.filter((_, i, arr) => arr.length <= 8 || i % Math.ceil(arr.length / 8) === 0 || i === arr.length - 1).map(p => (
              <tr key={p.chainage_m_utm}><td className={td}>{Math.round(p.chainage_m_utm)}</td>
                {so.properties.map(pr => <td key={pr.key} className={td}>{p.values[pr.key] === null ? <span className="text-unknown">UNKNOWN</span> : p.values[pr.key]}</td>)}</tr>))}</tbody></table></div>
        </section>
      </div>
      <section className={box} style={boxStyle} data-testid="ug-ev-sewers">
        <div className="text-text-1 font-medium">PMC sewers: {sw.crossings.length} crossing the alignment · {sw.near.length + sw.near_not_shown} within {sw.near_m ?? 50} m <span className="text-text-3 font-normal">— design/unverified, ASCE 38 QL-D</span></div>
        <div className="text-text-3">{sw.statement} Publisher: {sw.publisher}.{sw.datum_check ? ` Datum check: DSM − published manhole top level, median ${sw.datum_check.median_dsm_minus_top_level_m} m (p10 ${sw.datum_check.p10} m, p90 ${sw.datum_check.p90} m, ${sw.datum_check.n} pipes) — ${sw.datum_check.note}` : ''}</div>
        {sw.crossings.length > 0 && (
          <div className="overflow-x-auto" style={{ maxHeight: 180 }}><table className="w-full"><thead><tr className="text-text-3"><th className={th}>Ch (m)</th><th className={th}>Pipe</th><th className={th}>Ø</th><th className={th}>Invert at crossing (m, as published)</th><th className={th}>DSM (m)</th><th className={th}>Invert below DSM</th><th className={th}>QL</th></tr></thead>
            <tbody>{sw.crossings.map((c, i) => (
              <tr key={`${c.pipeline_id}-${i}`} data-testid="ug-ev-sewer-crossing"><td className={td}>{Math.round(c.chainage_m_utm)}</td><td className={td} title={`${c.type ?? ''} · ${c.material ?? ''} · ${c.sewer_district ?? ''} · ${c.level_method}`}>{c.label ?? c.pipeline_id}</td>
                <td className={td}>{n(c.diameter_m, 2, ' m')}</td><td className={td}>{n(c.invert_at_crossing_m, 2)}</td><td className={td}>{n(c.dsm_at_crossing_m, 1)}</td>
                <td className={td}>{n(c.invert_below_dsm_m, 1, ' m')}</td><td className={td}>QL-D</td></tr>))}</tbody></table></div>)}
        {sw.near.length > 0 && <div data-testid="ug-ev-sewer-near">Near, not crossing: {sw.near.slice(0, 8).map(s => `${s.label ?? s.pipeline_id} (${Math.round(s.distance_m)} m away, ch ${Math.round(s.nearest_chainage_m_utm)} m)`).join(' · ')}{sw.near.length > 8 ? ` · +${sw.near.length - 8} listed by the API` : ''}{sw.near_not_shown > 0 ? ` · ${sw.near_not_shown} more not shown (cap)` : ''}</div>}
      </section>
    </div>
  );
};

/**
 * Environment data panels: land-cover class areas (current view / selected proposal footprint), air-quality station
 * series (parameter selector, data date, sample counts; no surface), rainfall statistics (IMD 0.25° cells, CHIRPS box
 * average, IMD district via NWDP; descriptive only — not IDF curves, not design storms).
 */
import React, { useEffect, useMemo, useState } from 'react';
import { Loader2 } from 'lucide-react';
import { envDataApi, type AqSeries, type AqStation, type LandcoverAreas, type RainfallSummary } from '../../lib/envDataApi';
import { engineInstance } from '../../engine/TwinCityEngine';
import { isProposalObject } from '../../engine/feasibility/proposal';
import { useSelectedId } from '../../hooks/useAppMode';
import { istDate, lineFootprint, MONTHS, seriesPath } from './envDataModel';
import { cameraBox, loadStations } from './envDataOverlay';

const selCls = 'rounded-md bg-white/[0.05] border border-white/10 px-1.5 py-0.5 text-label text-text-1 focus:outline-none focus:border-cyan-400/60';
const fmt = (v: number, d = 0) => v.toLocaleString(undefined, { maximumFractionDigits: d, minimumFractionDigits: d });

const Err: React.FC<{ e: string | null; id: string }> = ({ e, id }) => e ? <p className="text-meta text-warn" role="status" data-testid={id}>{e}</p> : null;

// ── land cover areas ───────────────────────────────────────────────────────────
export const LandcoverAreasPanel: React.FC = () => {
  const [res, setRes] = useState<(LandcoverAreas & { label: string }) | null>(null);
  const [busy, setBusy] = useState(false);
  const [err, setErr] = useState<string | null>(null);
  const selectedId = useSelectedId();
  const sel = selectedId ? engineInstance.objects.getById(selectedId) : undefined;
  const prop = sel && isProposalObject(sel) ? sel : null;
  const run = (p: Promise<LandcoverAreas>, label: string) => {
    setBusy(true); setErr(null);
    p.then(r => setRes({ ...r, label })).catch((e: Error) => setErr(e.message)).finally(() => setBusy(false));
  };
  const view = () => {
    const b = cameraBox();
    if (!b) { setErr('Camera view could not be read.'); return; }
    run(envDataApi.landcoverAreasBbox(b), 'Current camera view');
  };
  const footprint = () => {
    if (!prop) return;
    const g = lineFootprint(prop.coordinates.map(c => [c[0], c[1]] as [number, number]), (prop as { width?: number }).width ?? 0);
    if (!g) { setErr('Selected object has no usable footprint (needs ≥ 2 points and a width).'); return; }
    run(envDataApi.landcoverAreasPolygon(g, 'footprint'), `Footprint of “${prop.name || prop.type}” (centreline ± width/2, approximate)`);
  };
  return (
    <div className="space-y-1.5" data-testid="env-landcover-areas">
      <div className="flex flex-wrap gap-2">
        <button type="button" className="uos-btn uos-btn-sm" data-testid="env-lc-view" onClick={view} disabled={busy}>Class areas: current view</button>
        <button type="button" className="uos-btn uos-btn-sm" data-testid="env-lc-footprint" onClick={footprint} disabled={busy || !prop}
          title={prop ? undefined : 'Select a road, flyover or double-deck proposal first'}>Selected proposal footprint</button>
        {busy && <Loader2 size={14} className="animate-spin text-text-2" aria-hidden />}
      </div>
      <Err e={err} id="env-lc-error" />
      {res && (
        <div data-testid="env-lc-result">
          <p className="text-meta text-text-2">{res.label}: {fmt(res.area_km2, 3)} km² · ESA WorldCover 2021 · derived · screening only</p>
          <table className="w-full text-label tabular-nums mt-1">
            <tbody>
              {res.classes.map(c => (
                <tr key={c.value}>
                  <td className="py-0.5"><span className="inline-block h-2.5 w-2.5 rounded-sm mr-1.5 align-middle" style={{ background: c.color }} aria-hidden />{c.label}</td>
                  <td className="text-right text-text-1">{fmt(c.km2, c.km2 < 1 ? 3 : 1)} km²</td>
                  <td className="text-right text-text-2 w-14">{c.pct == null ? '—' : `${fmt(c.pct, 1)}%`}</td>
                </tr>
              ))}
            </tbody>
          </table>
          {res.nodata_pixels > 0 && <p className="text-meta text-text-3">{fmt(res.nodata_pixels)} pixels outside the data (not counted in %).</p>}
          <p className="text-meta text-text-3">{res.method}. Land cover is not land use or zoning.</p>
        </div>
      )}
    </div>
  );
};

// ── charts ─────────────────────────────────────────────────────────────────────
const LineChart: React.FC<{ values: number[]; labels: [string, string]; unit: string; testId: string; color?: string }> = ({ values, labels, unit, testId, color = '#ffb300' }) => {
  const W = 300, H = 90;
  const { d, min, max } = seriesPath(values, W, H);
  return (
    <figure className="space-y-0.5" data-testid={testId} data-points={values.length}>
      <div className="flex justify-between text-meta text-text-3 tabular-nums"><span>max {fmt(max, 1)} {unit}</span><span>min {fmt(min, 1)}</span></div>
      <svg viewBox={`0 0 ${W} ${H}`} className="w-full h-[90px] rounded bg-white/[0.03] border border-white/10" role="img" aria-label={`Series ${labels[0]} to ${labels[1]}`}>
        <path d={d} fill="none" stroke={color} strokeWidth={1.2} />
      </svg>
      <figcaption className="flex justify-between text-meta text-text-3"><span>{labels[0]}</span><span>{labels[1]}</span></figcaption>
    </figure>
  );
};

const Bars: React.FC<{ items: { label: string; v: number; flag?: boolean }[]; unit: string; testId: string; color?: string }> = ({ items, unit, testId, color = '#4FA3FF' }) => {
  const max = Math.max(1, ...items.map(i => i.v));
  return (
    <div className="flex items-end gap-px h-[80px] rounded bg-white/[0.03] border border-white/10 px-1 pt-1" data-testid={testId} role="img"
      aria-label={`Bar chart, ${items.length} bars, max ${fmt(max)} ${unit}`}>
      {items.map(i => (
        <div key={i.label} className="flex-1 min-w-0" title={`${i.label}: ${fmt(i.v, 1)} ${unit}${i.flag ? ' — flagged suspect (as stored)' : ''}`}
          style={{ height: `${(i.v / max) * 100}%`, background: i.flag ? '#E8B04A' : color, opacity: i.flag ? 1 : 0.85 }} />
      ))}
    </div>
  );
};

// ── air quality ────────────────────────────────────────────────────────────────
export const AirQualityPanel: React.FC = () => {
  const [stations, setStations] = useState<AqStation[] | null>(null);
  const [sid, setSid] = useState<string>('');
  const [param, setParam] = useState('pm25_ugm3');
  const [agg, setAgg] = useState<'day' | 'month'>('day');
  const [series, setSeries] = useState<AqSeries | null>(null);
  const [err, setErr] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  useEffect(() => {
    loadStations().then(s => { setStations(s); const first = s.find(x => x.has_series && x.lon != null) ?? s.find(x => x.has_series); if (first) setSid(first.station_id); })
      .catch((e: Error) => setErr(e.message));
  }, []);
  const st = stations?.find(s => s.station_id === sid);
  const params = st ? Object.entries(st.parameters) : [];
  useEffect(() => {
    if (!st || !st.has_series) { setSeries(null); return; }
    const p = st.parameters[param] ? param : Object.keys(st.parameters)[0];
    if (p !== param) { setParam(p); return; }
    setBusy(true); setErr(null);
    envDataApi.airSeries(sid, p, agg).then(setSeries).catch((e: Error) => setErr(e.message)).finally(() => setBusy(false));
  }, [sid, param, agg, st]);
  const partial = series ? series.points.filter(p => series.samples_per_full_bucket && p.n < series.samples_per_full_bucket).length : 0;
  return (
    <div className="space-y-1.5" data-testid="env-air-panel">
      {!stations && !err && <p className="text-label text-text-2 flex items-center gap-2"><Loader2 size={14} className="animate-spin" aria-hidden />Loading stations…</p>}
      <Err e={err} id="env-air-error" />
      {stations && (
        <>
          <div className="flex flex-wrap items-center gap-2">
            <select className={selCls} aria-label="Station" data-testid="env-air-station" value={sid} onChange={e => setSid(e.target.value)}>
              {stations.map(s => <option key={s.station_id} value={s.station_id} disabled={!s.has_series}>{s.name}{s.has_series ? '' : ' — no series downloaded'}{s.lon == null ? ' (coords UNKNOWN)' : ''}</option>)}
            </select>
            <select className={selCls} aria-label="Parameter" data-testid="env-air-param" value={param} onChange={e => setParam(e.target.value)}>
              {params.map(([k, v]) => <option key={k} value={k}>{v.label} ({v.unit})</option>)}
            </select>
            <select className={selCls} aria-label="Aggregation" data-testid="env-air-agg" value={agg} onChange={e => setAgg(e.target.value as 'day' | 'month')}>
              <option value="day">Daily mean</option><option value="month">Monthly mean</option>
            </select>
            {busy && <Loader2 size={14} className="animate-spin text-text-2" aria-hidden />}
          </div>
          {st && (
            <p className="text-meta text-text-2" data-testid="env-air-meta">
              {st.name} · {st.agency ?? 'agency UNKNOWN'} · Observed · coordinates {st.lon != null ? 'from CPCB list' : 'UNKNOWN (not drawn)'} ·
              data {istDate(st.parameters[param]?.first)} → {istDate(st.parameters[param]?.last)} · {fmt(st.parameters[param]?.samples ?? 0)} 15-min samples
            </p>
          )}
          {series && series.points.length > 0 && (
            <>
              <LineChart values={series.points.map(p => p.v)} labels={[istDate(series.first), istDate(series.last)]} unit={series.unit} testId="env-air-chart" />
              <p className="text-meta text-text-3">{series.label} {agg === 'day' ? 'daily' : 'monthly'} mean of published 15-min values, {series.points.length} buckets with data
                {series.samples_per_full_bucket ? `; ${partial} days have fewer than ${series.samples_per_full_bucket} samples` : ''}. No gap filling, no interpolation, not a NAAQS compliance check.</p>
            </>
          )}
        </>
      )}
      <p className="text-meta text-text-3">Source: CPCB CCR station data via OpenCity (CPCB / MPCB / IITM). Licence as stated by OpenCity: Other (Public Domain); ODbL unless stated.</p>
    </div>
  );
};

// ── rainfall ───────────────────────────────────────────────────────────────────
export const RainfallPanel: React.FC = () => {
  const [s, setS] = useState<RainfallSummary | null>(null);
  const [err, setErr] = useState<string | null>(null);
  const [ci, setCi] = useState(0);
  useEffect(() => { envDataApi.rainfallSummary().then(setS).catch((e: Error) => setErr(e.message)); }, []);
  const cell = s?.imd_grid.cells[ci];
  const top = useMemo(() => cell ? [...cell.daily_max_by_year].sort((a, b) => b.mm - a.mm).slice(0, 5) : [], [cell]);
  const chirpsYears = s ? Object.entries(s.chirps_box.annual_total_mm).filter(([y]) => +y >= 2000) : [];
  return (
    <div className="space-y-2" data-testid="env-rain-panel">
      <p className="text-label font-semibold" style={{ color: 'var(--warn, #E8B04A)' }} data-testid="env-rain-statement">Descriptive statistics only — not IDF curves, not design storms.</p>
      {!s && !err && <p className="text-label text-text-2 flex items-center gap-2"><Loader2 size={14} className="animate-spin" aria-hidden />Loading rainfall…</p>}
      <Err e={err} id="env-rain-error" />
      {s && cell && (
        <>
          <label className="flex items-center gap-2 text-meta text-text-2">IMD 0.25° cell
            <select className={selCls} data-testid="env-rain-cell" value={ci} onChange={e => setCi(+e.target.value)}>
              {s.imd_grid.cells.map((c, i) => <option key={i} value={i}>{c.cell_lon.toFixed(2)}°E {c.cell_lat.toFixed(2)}°N (~27 km)</option>)}
            </select>
          </label>
          <div>
            <p className="text-meta text-text-2">Annual total, {cell.annual[0]?.year}–{cell.annual[cell.annual.length - 1]?.year} (mm; amber = flagged suspect, value as stored)</p>
            <Bars items={cell.annual.map(a => ({ label: `${a.year}`, v: a.mm, flag: !!a.qa_flag }))} unit="mm" testId="env-rain-annual" />
            {cell.suspect_years.length > 0 && <p className="text-meta text-warn" data-testid="env-rain-flags">Suspect: {cell.suspect_years.join(', ')} — {s.imd_grid.suspect_rule}.</p>}
          </div>
          <div>
            <p className="text-meta text-text-2">Monthly mean total (mm)</p>
            <Bars items={cell.monthly_mean_mm.map(m => ({ label: MONTHS[m.month - 1], v: m.mm }))} unit="mm" testId="env-rain-monthly" />
            <div className="flex justify-between text-meta text-text-3"><span>Jan</span><span>Dec</span></div>
          </div>
          <div data-testid="env-rain-dailymax">
            <p className="text-meta text-text-2">Highest daily totals in this cell (mm/day, IMD day):</p>
            <ul className="text-label tabular-nums">{top.map(t => <li key={t.year} className="flex justify-between"><span>{t.date}</span><span className="text-text-1">{fmt(t.mm, 1)}{cell.suspect_years.includes(t.year) ? ' · suspect year' : ''}</span></li>)}</ul>
          </div>
          <div>
            <p className="text-meta text-text-2">CHIRPS v2 study-box average, annual total 2000–{chirpsYears[chirpsYears.length - 1]?.[0]} (mm; estimated)</p>
            <LineChart values={chirpsYears.map(([, v]) => v)} labels={[chirpsYears[0]?.[0] ?? '', chirpsYears[chirpsYears.length - 1]?.[0] ?? '']} unit="mm" testId="env-rain-chirps" color="#4FA3FF" />
          </div>
          <p className="text-meta text-text-3" data-testid="env-rain-nwdp">IMD district daily (Pune, via NWDP): {s.nwdp_district.rows.length} days published, {s.nwdp_district.first} → {s.nwdp_district.last}; licence UNKNOWN.</p>
          <p className="text-meta text-text-3">IMD gridded {s.imd_grid.period}; licence UNKNOWN (cite Pai et al. 2014). CHIRPS: public domain. {s.statement}</p>
        </>
      )}
    </div>
  );
};

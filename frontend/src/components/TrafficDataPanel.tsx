import React, { useCallback, useEffect, useMemo, useState } from 'react';
import { AlertTriangle, Crosshair, Database, FileUp, Loader2, Trash2, ChevronDown, CheckCircle2 } from 'lucide-react';
import { engineInstance } from '../engine/TwinCityEngine';
import { useSelectedId } from '../hooks/useAppMode';
import { SidePanel, PanelHeader, PanelBody, Section, Button, Notice, Segmented } from './ui/kit';
import {
  trafficApi, TrafficApiError, toPcu, vehPerHour, minutesOf, forwardBearingLabel, fileToBase64, KIND_LABEL, DAY_TYPES,
  type Dataset, type DatasetKind, type DatasetMeta, type DatasetRole, type DayType, type Direction, type FieldError,
  type HourRow, type ImportPreview, type PcuFactorSet, type VehicleClass,
} from '../engine/data/trafficData';

/**
 * Traffic Data Manager (docs/TRAFFIC_DATA.md): datasets with provenance,
 * manual entry against a road picked on the map, CSV/Excel import with
 * column mapping and per-row errors, and a per-road hourly view.
 * Counts are evidence about traffic at a place, never demand.
 */

const KIND_STYLE: Record<DatasetKind, string> = {
  measured: 'bg-emerald-500/15 text-emerald-300 border-emerald-400/30',
  estimated: 'bg-amber-500/15 text-amber-300 border-amber-400/30',
  manual: 'bg-sky-500/15 text-sky-300 border-sky-400/30',
};
const KIND_TITLE: Record<DatasetKind, string> = {
  measured: 'Counted in the field (survey, ATCC, video).',
  estimated: 'An estimate, not a count. Never merged with measured data.',
  manual: 'Typed in by a user; see the dataset provenance for where the figures came from.',
};
export const ProvenanceBadge: React.FC<{ kind: DatasetKind; synthetic?: boolean }> = ({ kind, synthetic }) => (
  <span className="inline-flex gap-1">
    <span data-kind={kind} title={KIND_TITLE[kind]} className={`inline-flex items-center rounded-md border px-1.5 py-px text-[10px] font-semibold uppercase tracking-wide ${KIND_STYLE[kind]}`}>{KIND_LABEL[kind]}</span>
    {synthetic && <span title="Test or demo data, not an observation" className="inline-flex items-center rounded-md border px-1.5 py-px text-[10px] font-semibold uppercase tracking-wide bg-slate-500/20 text-slate-300 border-slate-400/30">Synthetic</span>}
  </span>
);

const ROLE_LABEL: Record<DatasetRole, string> = { validation: 'Validation', calibration: 'Calibration', unused: 'Not used' };
const DAY_LABEL: Record<DayType, string> = { weekday: 'Weekday', saturday: 'Saturday', sunday: 'Sunday', holiday: 'Holiday', weekend: 'Weekend', all_days: 'All days' };
const FIELD_LABEL: Record<string, string> = {
  ref_kind: 'Count type', road_id: 'Road id', direction: 'Direction (fwd/bwd/both)', direction_label: 'Direction label', junction_ref: 'Junction',
  approach_road_id: 'Approach road', from_road_id: 'From road', to_road_id: 'To road', turn: 'Turn', day_type: 'Day type', count_date: 'Date',
  period_start: 'Start time', period_end: 'End time', hour: 'Hour (0–23)', total_count: 'Total vehicles', lon: 'Longitude', lat: 'Latitude',
  quality_flag: 'Quality flag', notes: 'Notes',
};

const inputCls = 'w-full rounded-lg bg-white/[0.05] border border-white/10 px-2 py-1.5 text-sm text-white placeholder:text-slate-500 focus:outline-none focus:border-cyan-400/60';
const labelCls = 'block text-xs text-slate-400 mb-1';
const fmt = (v: number | null | undefined, d = 0) => (v === null || v === undefined ? '–' : v.toLocaleString(undefined, { maximumFractionDigits: d }));

const errText = (e: unknown): { message: string; problems?: { index?: number; row?: number; errors: FieldError[] }[] } => {
  if (e instanceof TrafficApiError) {
    const d = e.detail as { message?: string; problems?: { index: number; errors: FieldError[] }[]; invalid_rows?: { row: number; errors: FieldError[] }[] } | string;
    if (typeof d === 'string') return { message: d };
    if (Array.isArray(d)) return { message: (d as { msg?: string; loc?: string[] }[]).map(x => `${x.loc?.slice(-1)[0] ?? ''}: ${x.msg}`).join('; ') };
    return { message: d?.message ?? e.message, problems: d?.problems ?? d?.invalid_rows };
  }
  return { message: e instanceof Error ? e.message : String(e) };
};

type Tab = 'datasets' | 'enter' | 'import' | 'road';

export const TrafficDataPanel: React.FC<{ onClose: () => void }> = ({ onClose }) => {
  const [tab, setTab] = useState<Tab>('datasets');
  const [datasets, setDatasets] = useState<Dataset[] | null>(null);
  const [classes, setClasses] = useState<VehicleClass[]>([]);
  const [sets, setSets] = useState<PcuFactorSet[]>([]);
  const [error, setError] = useState<string | null>(null);
  const [user, setUserState] = useState(() => localStorage.getItem('td-user') ?? '');
  const setUser = (v: string) => { setUserState(v); localStorage.setItem('td-user', v); };
  const [roadId, setRoadId] = useState<string | null>(null);

  const reload = useCallback(async () => {
    try {
      const [d, c, s] = await Promise.all([trafficApi.datasets(), trafficApi.classes(), trafficApi.pcuSets()]);
      setDatasets(d); setClasses(c); setSets(s); setError(null);
    } catch (e) { setError(errText(e).message); }
  }, []);
  useEffect(() => { void reload(); }, [reload]);

  return (
    <SidePanel label="Traffic data" wide>
      <PanelHeader title="Traffic data" subtitle="Counts you enter or import. Evidence for checking the model, never demand." onClose={onClose} closeLabel="Close traffic data" />
      <PanelBody>
        <div data-testid="traffic-data-panel" className="space-y-4">
          <Segmented<Tab> label="Traffic data section" value={tab} onChange={setTab}
            options={[{ value: 'datasets', label: 'Datasets' }, { value: 'enter', label: 'Enter' }, { value: 'import', label: 'Import' }, { value: 'road', label: 'By road' }]} />
          <div>
            <label className={labelCls} htmlFor="td-user">Your name (recorded with every change)</label>
            <input id="td-user" className={inputCls} value={user} onChange={e => setUser(e.target.value)} placeholder="e.g. A. Engineer" />
          </div>
          {error && <Notice tone="bad" icon={AlertTriangle} action={<Button size="sm" variant="ghost" onClick={() => void reload()}>Retry</Button>}>Traffic data could not be loaded: {error}</Notice>}
          {tab === 'datasets' && <DatasetList datasets={datasets} sets={sets} user={user} onChanged={reload} />}
          {tab === 'enter' && <ManualEntry datasets={datasets ?? []} classes={classes} sets={sets} user={user} roadId={roadId} setRoadId={setRoadId} onChanged={reload} />}
          {tab === 'import' && <ImportWizard sets={sets} user={user} onDone={async () => { await reload(); setTab('datasets'); }} />}
          {tab === 'road' && <RoadView datasets={datasets ?? []} roadId={roadId} setRoadId={setRoadId} />}
        </div>
      </PanelBody>
    </SidePanel>
  );
};

// ── datasets ──────────────────────────────────────────────────────────────────

const DatasetList: React.FC<{ datasets: Dataset[] | null; sets: PcuFactorSet[]; user: string; onChanged: () => Promise<void> }> = ({ datasets, sets, user, onChanged }) => {
  const [open, setOpen] = useState<string | null>(null);
  const [busy, setBusy] = useState<string | null>(null);
  const [msg, setMsg] = useState<string | null>(null);
  if (!datasets) return <Notice icon={Loader2} spin>Loading datasets…</Notice>;
  if (!datasets.length) return <p className="text-sm text-slate-400">No traffic data yet. Enter counts by hand or import a CSV / Excel file.</p>;
  const setRole = async (d: Dataset, role: DatasetRole) => {
    if (!user.trim()) { setMsg('Enter your name first: changes are recorded with who made them.'); return; }
    setBusy(d.id);
    try { await trafficApi.patchDataset(d.id, { edited_by: user.trim(), role }); await onChanged(); setMsg(null); } catch (e) { setMsg(errText(e).message); }
    setBusy(null);
  };
  const remove = async (d: Dataset) => {
    if (!user.trim()) { setMsg('Enter your name first.'); return; }
    if (!window.confirm(`Delete "${d.name}" and its ${d.record_count ?? 0} records? The deletion is kept in the audit log.`)) return;
    setBusy(d.id);
    try { await trafficApi.deleteDataset(d.id, user.trim()); await onChanged(); } catch (e) { setMsg(errText(e).message); }
    setBusy(null);
  };
  const setName = (id: number | null) => { const s = sets.find(x => x.id === id); return s ? `${s.name} (v${s.version})` : 'none chosen'; };
  const kinds = new Set(datasets.filter(d => d.role !== 'unused').map(d => d.kind));
  return (
    <Section title={`${datasets.length} dataset${datasets.length === 1 ? '' : 's'}`}>
      {msg && <Notice tone="warn" icon={AlertTriangle}>{msg}</Notice>}
      {kinds.has('measured') && kinds.has('estimated') && <Notice tone="warn" icon={AlertTriangle}>Measured and estimated datasets are both in use. They are compared separately, row by row, and never averaged.</Notice>}
      <ul className="space-y-2" data-testid="dataset-list">
        {datasets.map(d => (
          <li key={d.id} className="rounded-xl border border-white/10 bg-white/[0.03]" data-dataset={d.id}>
            <button className="w-full text-left px-3 py-2 flex items-start gap-2 cursor-pointer" onClick={() => setOpen(o => (o === d.id ? null : d.id))} aria-expanded={open === d.id}>
              <div className="flex-1 min-w-0">
                <div className="flex flex-wrap items-center gap-1.5"><span className="text-sm font-semibold text-white break-words">{d.name}</span><ProvenanceBadge kind={d.kind} synthetic={d.synthetic} /></div>
                <p className="text-xs text-slate-400 mt-0.5">{d.provider} · {d.collected_from ?? 'date not given'}{d.collected_to && d.collected_to !== d.collected_from ? ` to ${d.collected_to}` : ''} · {d.record_count ?? 0} records</p>
              </div>
              <ChevronDown size={14} className={`mt-1 shrink-0 text-slate-400 transition ${open === d.id ? 'rotate-180' : ''}`} />
            </button>
            <div className="px-3 pb-2">
              <div role="radiogroup" aria-label={`Use of ${d.name}`} className="flex gap-1 text-xs">
                {(['validation', 'calibration', 'unused'] as DatasetRole[]).map(r => (
                  <button key={r} role="radio" aria-checked={d.role === r} disabled={busy === d.id} onClick={() => void setRole(d, r)}
                    className={`rounded-md border px-2 py-0.5 cursor-pointer ${d.role === r ? 'border-cyan-300 bg-cyan-500/20 text-white' : 'border-white/10 text-slate-300 hover:text-white'}`}>{ROLE_LABEL[r]}</button>
                ))}
              </div>
            </div>
            {open === d.id && (
              <div className="border-t border-white/5 px-3 py-2 text-xs text-slate-300 space-y-1">
                <p><span className="text-slate-500">Location:</span> {d.location_desc}</p>
                <p><span className="text-slate-500">Period:</span> {d.period_desc}</p>
                <p><span className="text-slate-500">Classification:</span> {d.classification}</p>
                {d.method && <p><span className="text-slate-500">Method:</span> {d.method}</p>}
                <p><span className="text-slate-500">Assumptions:</span> {d.assumptions || 'none stated'}</p>
                <p><span className="text-slate-500">Adjustments:</span> {d.adjustments || 'none'}</p>
                <p><span className="text-slate-500">PCU factors:</span> {setName(d.pcu_factor_set_id)}</p>
                <p><span className="text-slate-500">Entered by:</span> {d.entered_by} · {d.created_at?.slice(0, 16).replace('T', ' ')} UTC</p>
                {d.imported_file_name && <p><span className="text-slate-500">File:</span> {d.imported_file_name} (sha256 {d.imported_file_sha256?.slice(0, 12)}…)</p>}
                {d.import_report && d.import_report.rejected > 0 && (
                  <div className="rounded-lg border border-amber-400/20 bg-amber-500/5 p-2">
                    <p className="text-amber-200 font-medium">{d.import_report.rejected} of {d.import_report.rows_in_file} rows were rejected at import and are not in this dataset:</p>
                    <ul className="mt-1 space-y-0.5">{d.import_report.rejected_rows.slice(0, 20).map(r => <li key={r.row}>Row {r.row}: {r.errors.map(e => `${FIELD_LABEL[e.field] ?? e.field} ${e.message}`).join('; ')}</li>)}</ul>
                  </div>
                )}
                <div className="pt-1"><Button size="sm" variant="ghost" icon={Trash2} disabled={busy === d.id} onClick={() => void remove(d)}>Delete dataset</Button></div>
              </div>
            )}
          </li>
        ))}
      </ul>
      <p className="text-[11px] text-slate-500 leading-snug">Validation datasets are compared with the simulation after a run (Simulate → Details → Checks against traffic counts). Calibration datasets are reserved for matrix estimation, which is not implemented yet. Not used: kept, but read by nothing.</p>
    </Section>
  );
};

// ── dataset metadata form (provenance) ───────────────────────────────────────

const emptyMeta = (user: string): DatasetMeta => ({
  name: '', provider: '', kind: 'measured', method: '', collected_from: '', collected_to: '', location_desc: '', period_desc: '',
  classification: 'Two-wheeler, car, auto-rickshaw, bus, LCV, HCV, other', assumptions: '', adjustments: '', pcu_factor_set_id: null,
  role: 'validation', entered_by: user, synthetic: false,
});

const MetaForm: React.FC<{ meta: DatasetMeta; setMeta: (m: DatasetMeta) => void; sets: PcuFactorSet[] }> = ({ meta, setMeta, sets }) => {
  const f = (k: keyof DatasetMeta) => (e: React.ChangeEvent<HTMLInputElement | HTMLTextAreaElement | HTMLSelectElement>) => setMeta({ ...meta, [k]: e.target.value });
  return (
    <div className="space-y-2" data-testid="dataset-meta-form">
      <div className="grid grid-cols-2 gap-2">
        <div className="col-span-2"><label className={labelCls}>Dataset name *</label><input aria-label="Dataset name" className={inputCls} value={meta.name} onChange={f('name')} /></div>
        <div className="col-span-2"><label className={labelCls}>Source or provider *</label><input aria-label="Source or provider" className={inputCls} value={meta.provider} onChange={f('provider')} placeholder="e.g. PMC traffic cell survey 2025" /></div>
        <div className="col-span-2">
          <label className={labelCls}>Kind of data *</label>
          <Segmented<DatasetKind> label="Kind of data" value={meta.kind} onChange={v => setMeta({ ...meta, kind: v })}
            options={[{ value: 'measured', label: 'Measured' }, { value: 'estimated', label: 'Estimated' }, { value: 'manual', label: 'Manual' }]} />
        </div>
        <div><label className={labelCls}>Collected from</label><input type="date" aria-label="Collected from" className={inputCls} value={meta.collected_from ?? ''} onChange={f('collected_from')} /></div>
        <div><label className={labelCls}>Collected to</label><input type="date" aria-label="Collected to" className={inputCls} value={meta.collected_to ?? ''} onChange={f('collected_to')} /></div>
        <div className="col-span-2"><label className={labelCls}>Location *</label><input aria-label="Location" className={inputCls} value={meta.location_desc} onChange={f('location_desc')} placeholder="e.g. Karve Road near Nal Stop" /></div>
        <div className="col-span-2"><label className={labelCls}>Time period represented *</label><input aria-label="Time period" className={inputCls} value={meta.period_desc} onChange={f('period_desc')} placeholder="e.g. weekday 08:00–11:00, 15-min intervals" /></div>
        <div className="col-span-2"><label className={labelCls}>Vehicle classification *</label><input aria-label="Vehicle classification" className={inputCls} value={meta.classification} onChange={f('classification')} /></div>
        <div className="col-span-2"><label className={labelCls}>Method</label><input aria-label="Method" className={inputCls} value={meta.method ?? ''} onChange={f('method')} placeholder="e.g. manual classified count, video" /></div>
        <div className="col-span-2"><label className={labelCls}>Assumptions</label><textarea aria-label="Assumptions" rows={2} className={inputCls} value={meta.assumptions ?? ''} onChange={f('assumptions')} /></div>
        <div className="col-span-2"><label className={labelCls}>Adjustments applied (factors, expansion…)</label><textarea aria-label="Adjustments" rows={2} className={inputCls} value={meta.adjustments ?? ''} onChange={f('adjustments')} /></div>
        <div className="col-span-2">
          <label className={labelCls}>PCU factor set</label>
          <select aria-label="PCU factor set" className={inputCls} value={meta.pcu_factor_set_id ?? ''} onChange={e => setMeta({ ...meta, pcu_factor_set_id: e.target.value ? Number(e.target.value) : null })}>
            <option value="">None (no PCU conversion)</option>
            {sets.filter(s => s.latest).map(s => <option key={s.id} value={s.id}>{s.name} (v{s.version})</option>)}
          </select>
        </div>
        <div className="col-span-2">
          <label className={labelCls}>Use for</label>
          <Segmented<DatasetRole> label="Use for" value={meta.role ?? 'unused'} onChange={v => setMeta({ ...meta, role: v })}
            options={[{ value: 'validation', label: 'Validation' }, { value: 'calibration', label: 'Calibration' }, { value: 'unused', label: 'Not used' }]} />
        </div>
        <label className="col-span-2 flex items-center gap-2 text-xs text-slate-300"><input type="checkbox" checked={!!meta.synthetic} onChange={e => setMeta({ ...meta, synthetic: e.target.checked })} /> Synthetic test / demo data (not an observation)</label>
      </div>
    </div>
  );
};

const metaMissing = (m: DatasetMeta, user: string) => [
  !user.trim() && 'your name', !m.name.trim() && 'name', !m.provider.trim() && 'source', !m.location_desc.trim() && 'location',
  !m.period_desc.trim() && 'time period', !m.classification.trim() && 'classification',
].filter(Boolean) as string[];

// ── manual entry ──────────────────────────────────────────────────────────────

const roadInfo = (id: string | null) => {
  if (!id) return null;
  const o = engineInstance.objects.getById(id);
  if (!o || (o.type !== 'road' && o.type !== 'flyover' && o.type !== 'metro_flyover')) return null;
  return { id, name: o.name || id, bearing: forwardBearingLabel(o.coordinates as number[][]) };
};

const RoadPicker: React.FC<{ roadId: string | null; setRoadId: (id: string | null) => void }> = ({ roadId, setRoadId }) => {
  const selectedId = useSelectedId();
  const [armed, setArmed] = useState(false);
  useEffect(() => {
    if (armed && selectedId && roadInfo(selectedId)) { setRoadId(selectedId); setArmed(false); }
  }, [armed, selectedId, setRoadId]);
  const info = roadInfo(roadId);
  return (
    <div className="space-y-1.5" data-testid="road-picker">
      <div className="flex items-center gap-2">
        <Button size="sm" icon={Crosshair} variant={armed ? 'primary' : 'secondary'} onClick={() => setArmed(a => !a)}>{armed ? 'Click a road on the map…' : 'Pick road on map'}</Button>
        {selectedId && roadInfo(selectedId) && selectedId !== roadId && <Button size="sm" variant="ghost" onClick={() => setRoadId(selectedId)}>Use selected road</Button>}
      </div>
      {info ? <p className="text-xs text-slate-300" data-road={info.id}><span className="font-semibold text-white">{info.name}</span> <span className="text-slate-500">({info.id})</span></p>
        : <p className="text-xs text-slate-500">{roadId ? `Road ${roadId} is not loaded on the map.` : 'No road chosen.'}</p>}
    </div>
  );
};

const ManualEntry: React.FC<{ datasets: Dataset[]; classes: VehicleClass[]; sets: PcuFactorSet[]; user: string; roadId: string | null; setRoadId: (id: string | null) => void; onChanged: () => Promise<void> }> = ({ datasets, classes, sets, user, roadId, setRoadId, onChanged }) => {
  const [datasetId, setDatasetId] = useState<string>('');
  const [meta, setMeta] = useState<DatasetMeta>(() => emptyMeta(user));
  const [direction, setDirection] = useState<Direction>('fwd');
  const [dayType, setDayType] = useState<DayType>('weekday');
  const [start, setStart] = useState('08:00');
  const [end, setEnd] = useState('09:00');
  const [counts, setCounts] = useState<Record<string, string>>({});
  const [busy, setBusy] = useState(false);
  const [result, setResult] = useState<{ ok: boolean; text: string; errors?: FieldError[] } | null>(null);
  const ds = datasets.find(d => d.id === datasetId);
  const set = sets.find(s => s.id === (ds ? ds.pcu_factor_set_id : meta.pcu_factor_set_id)) ?? null;
  const info = roadInfo(roadId);
  const parsed = useMemo(() => {
    const cc: Record<string, number> = {}; const bad: string[] = [];
    for (const [k, v] of Object.entries(counts)) {
      if (v.trim() === '') continue;
      if (!/^\d+$/.test(v.trim())) bad.push(k); else cc[k] = Number(v);
    }
    return { cc, bad };
  }, [counts]);
  const veh = Object.values(parsed.cc).reduce((a, b) => a + b, 0);
  const vph = vehPerHour(veh, start, end);
  let pcuH: number | null = null, pcuNote = '';
  if (!set) pcuNote = 'no PCU factor set chosen';
  else if (vph !== null) {
    try { pcuH = toPcu(parsed.cc, set) * 60 / (minutesOf(end)! - minutesOf(start)!); } catch (e) { pcuNote = (e as Error).message; }
  }
  const save = async () => {
    setResult(null);
    if (!user.trim()) { setResult({ ok: false, text: 'Enter your name first.' }); return; }
    if (!roadId) { setResult({ ok: false, text: 'Pick a road on the map first.' }); return; }
    if (parsed.bad.length) { setResult({ ok: false, text: `Not whole numbers: ${parsed.bad.join(', ')}.` }); return; }
    setBusy(true);
    try {
      let id = datasetId;
      if (!id) {
        const miss = metaMissing(meta, user);
        if (miss.length) { setResult({ ok: false, text: `The new dataset needs: ${miss.join(', ')}.` }); setBusy(false); return; }
        const created = await trafficApi.createDataset({ ...meta, entered_by: user.trim(), collected_from: meta.collected_from || null, collected_to: meta.collected_to || null });
        id = created.id; setDatasetId(id);
      }
      const label = direction === 'both' ? 'both directions' : info?.bearing?.[direction] ?? '';
      const [saved] = await trafficApi.addRecords(id, user.trim(), [{ ref_kind: 'road_direction', road_id: roadId, direction, direction_label: label, day_type: dayType, period_start: start, period_end: end, class_counts: parsed.cc }]);
      setResult({ ok: true, text: `Saved: ${fmt(saved.veh_h)} veh/h${saved.pcu_h !== null ? `, ${fmt(saved.pcu_h)} PCU/h` : ''}${saved.pcu_note ? ` (PCU: ${saved.pcu_note})` : ''}.` });
      await onChanged();
    } catch (e) {
      const t = errText(e);
      setResult({ ok: false, text: t.message, errors: t.problems?.flatMap(p => p.errors) });
    }
    setBusy(false);
  };
  return (
    <div className="space-y-4" data-testid="manual-entry">
      <Section title="Dataset">
        <select aria-label="Dataset" className={inputCls} value={datasetId} onChange={e => setDatasetId(e.target.value)}>
          <option value="">New dataset…</option>
          {datasets.map(d => <option key={d.id} value={d.id}>{d.name} ({KIND_LABEL[d.kind]})</option>)}
        </select>
        {ds ? <p className="text-xs text-slate-400 flex items-center gap-1.5"><ProvenanceBadge kind={ds.kind} synthetic={ds.synthetic} /> {ds.provider}</p> : <MetaForm meta={meta} setMeta={setMeta} sets={sets} />}
      </Section>
      <Section title="Where">
        <RoadPicker roadId={roadId} setRoadId={setRoadId} />
        <Segmented<Direction> label="Direction" value={direction} onChange={setDirection}
          options={[{ value: 'fwd', label: info?.bearing ? `Drawn way (${info.bearing.fwd})` : 'Drawn way' }, { value: 'bwd', label: info?.bearing ? `Against (${info.bearing.bwd})` : 'Against' }, { value: 'both', label: 'Both' }]} />
      </Section>
      <Section title="When">
        <div className="grid grid-cols-3 gap-2">
          <div><label className={labelCls}>Day type</label><select aria-label="Day type" className={inputCls} value={dayType} onChange={e => setDayType(e.target.value as DayType)}>{DAY_TYPES.map(d => <option key={d} value={d}>{DAY_LABEL[d]}</option>)}</select></div>
          <div><label className={labelCls}>From</label><input aria-label="From time" className={inputCls} value={start} onChange={e => setStart(e.target.value)} placeholder="08:00" /></div>
          <div><label className={labelCls}>To</label><input aria-label="To time" className={inputCls} value={end} onChange={e => setEnd(e.target.value)} placeholder="09:00" /></div>
        </div>
      </Section>
      <Section title="Vehicles counted in the period">
        <div className="grid grid-cols-2 gap-2">
          {classes.map(c => (
            <div key={c.code}><label className={labelCls} title={c.description}>{c.label}{set ? <span className="text-slate-500"> · {c.code in set.factors ? `${set.factors[c.code]} PCU` : 'no PCU factor'}</span> : null}</label>
              <input aria-label={`${c.label} count`} inputMode="numeric" className={`${inputCls} ${parsed.bad.includes(c.code) ? 'border-rose-400/60' : ''}`} value={counts[c.code] ?? ''} onChange={e => setCounts({ ...counts, [c.code]: e.target.value })} /></div>
          ))}
        </div>
        <div className="rounded-xl bg-white/[0.04] border border-white/5 px-3 py-2 text-sm" data-testid="entry-rates">
          <p><span className="text-white font-semibold tabular-nums">{vph === null ? '–' : fmt(vph)}</span> veh/h · <span className="text-white font-semibold tabular-nums">{pcuH === null ? '–' : fmt(pcuH)}</span> PCU/h</p>
          <p className="text-xs text-slate-500">{set ? `PCU by ${set.name} (v${set.version}).` : ''} {pcuNote}{vph === null ? ' Period must be HH:MM to HH:MM, end after start.' : ''}</p>
        </div>
      </Section>
      {result && <Notice tone={result.ok ? 'good' : 'bad'} icon={result.ok ? CheckCircle2 : AlertTriangle}>{result.text}{result.errors?.length ? <ul className="mt-1 text-xs">{result.errors.map((e, i) => <li key={i}>{FIELD_LABEL[e.field] ?? e.field}: {e.message}</li>)}</ul> : null}</Notice>}
      <Button variant="primary" className="w-full" icon={busy ? Loader2 : Database} spin={busy} disabled={busy} onClick={() => void save()}>Save count</Button>
    </div>
  );
};

// ── import wizard ─────────────────────────────────────────────────────────────

const ImportWizard: React.FC<{ sets: PcuFactorSet[]; user: string; onDone: () => Promise<void> }> = ({ sets, user, onDone }) => {
  const [file, setFile] = useState<{ name: string; b64: string } | null>(null);
  const [sheet, setSheet] = useState<string | null>(null);
  const [preview, setPreview] = useState<ImportPreview | null>(null);
  const [mapping, setMapping] = useState<Record<string, string>>({});
  const [defaults, setDefaults] = useState<Record<string, string>>({ ref_kind: 'road_direction', day_type: 'weekday' });
  const [meta, setMeta] = useState<DatasetMeta>(() => emptyMeta(user));
  const [skip, setSkip] = useState(false);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const run = async (f = file, m: Record<string, string> | null = mapping, sh = sheet) => {
    if (!f) return;
    setBusy(true); setError(null);
    try {
      const p = await trafficApi.preview({ file_name: f.name, content_base64: f.b64, sheet: sh, mapping: m, defaults });
      setPreview(p); setMapping(p.mapping);
    } catch (e) { setError(errText(e).message); setPreview(null); }
    setBusy(false);
  };
  const onFile = async (e: React.ChangeEvent<HTMLInputElement>) => {
    const f = e.target.files?.[0];
    if (!f) return;
    const next = { name: f.name, b64: await fileToBase64(f) };
    setFile(next); setSheet(null); setMapping({});
    setMeta(m => ({ ...m, name: m.name || f.name.replace(/\.(csv|xlsx)$/i, '') }));
    await run(next, null, null);
  };
  const commit = async () => {
    if (!file || !preview) return;
    const miss = metaMissing(meta, user);
    if (miss.length) { setError(`The dataset needs: ${miss.join(', ')}.`); return; }
    setBusy(true); setError(null);
    try {
      await trafficApi.commit({ file_name: file.name, content_base64: file.b64, sheet, mapping, defaults, skip_invalid: skip,
        dataset: { ...meta, entered_by: user.trim(), collected_from: meta.collected_from || null, collected_to: meta.collected_to || null } });
      (window as unknown as { showToast?: (m: string, t: string) => void }).showToast?.(`Imported ${preview.valid_count} rows into "${meta.name}".`, 'success');
      setFile(null); setPreview(null);
      await onDone();
    } catch (e) { setError(errText(e).message); }
    setBusy(false);
  };
  const targets = preview ? ['', ...preview.fields, ...preview.class_codes.map(c => `class:${c}`)] : [];
  return (
    <div className="space-y-4" data-testid="import-wizard">
      <Section title="1. File">
        <label className="flex items-center gap-2 rounded-xl border border-dashed border-white/20 px-3 py-3 text-sm text-slate-300 cursor-pointer hover:border-cyan-400/50">
          <FileUp size={16} /> {file ? file.name : 'Choose a CSV or Excel (.xlsx) file'}
          <input data-testid="import-file" type="file" accept=".csv,.xlsx" className="hidden" onChange={e => void onFile(e)} />
        </label>
        <p className="text-[11px] text-slate-500">First row = column names. One row per count: a road id, a direction (fwd/bwd/both), a period (start + end, or an hour 0–23), and vehicles by class or a total.</p>
        {preview && preview.sheets.length > 1 && (
          <select aria-label="Sheet" className={inputCls} value={sheet ?? preview.sheets[0]} onChange={e => { setSheet(e.target.value); void run(file, null, e.target.value); }}>
            {preview.sheets.map(s => <option key={s}>{s}</option>)}
          </select>
        )}
      </Section>
      {busy && <Notice icon={Loader2} spin>Reading the file…</Notice>}
      {error && <Notice tone="bad" icon={AlertTriangle}>{error}</Notice>}
      {preview && (
        <>
          <Section title="2. Map columns">
            <table className="w-full text-xs" data-testid="column-mapping">
              <thead><tr className="text-slate-500"><th className="text-left font-medium py-1">Column in file</th><th className="text-left font-medium">Means</th><th className="text-left font-medium">First value</th></tr></thead>
              <tbody>{preview.columns.map((c, i) => (
                <tr key={c + i} className="border-t border-white/5">
                  <td className="py-1 pr-2 text-slate-200">{c}</td>
                  <td className="pr-2"><select aria-label={`Map ${c}`} className="w-full rounded-md bg-white/[0.05] border border-white/10 px-1 py-0.5 text-xs text-white" value={mapping[c] ?? ''} onChange={e => setMapping({ ...mapping, [c]: e.target.value })}>
                    {targets.map(t => <option key={t} value={t}>{t === '' ? '— ignore —' : t.startsWith('class:') ? `Vehicles: ${t.slice(6)}` : FIELD_LABEL[t] ?? t}</option>)}
                  </select></td>
                  <td className="text-slate-400 truncate max-w-[6rem]">{preview.sample[0]?.[i] ?? ''}</td>
                </tr>
              ))}</tbody>
            </table>
            <div className="grid grid-cols-2 gap-2">
              <div><label className={labelCls}>Count type when no column says</label><select aria-label="Default count type" className={inputCls} value={defaults.ref_kind ?? ''} onChange={e => setDefaults({ ...defaults, ref_kind: e.target.value })}><option value="road_direction">Road, one direction</option><option value="junction_approach">Junction approach</option><option value="turn">Turning movement</option></select></div>
              <div><label className={labelCls}>Day type when no column says</label><select aria-label="Default day type" className={inputCls} value={defaults.day_type ?? ''} onChange={e => setDefaults({ ...defaults, day_type: e.target.value })}>{DAY_TYPES.map(d => <option key={d} value={d}>{DAY_LABEL[d]}</option>)}</select></div>
            </div>
            <Button size="sm" disabled={busy} onClick={() => void run(file, Object.fromEntries(Object.entries(mapping).filter(([, v]) => v)))}>Check rows with this mapping</Button>
          </Section>
          <Section title="3. Check">
            <div data-testid="import-summary" className={`rounded-xl border px-3 py-2 text-sm ${preview.error_count ? 'border-amber-400/30 bg-amber-500/5' : 'border-emerald-400/30 bg-emerald-500/5'}`}>
              <span className="font-semibold text-white">{preview.valid_count}</span> valid · <span className={`font-semibold ${preview.error_count ? 'text-amber-300' : 'text-white'}`}>{preview.error_count}</span> with problems · {preview.row_count} rows
            </div>
            {preview.invalid_rows.length > 0 && (
              <ul className="max-h-48 overflow-y-auto space-y-1 text-xs text-rose-100" data-testid="import-errors">
                {preview.invalid_rows.map(r => <li key={r.row} className="rounded-md bg-rose-500/10 px-2 py-1">Row {r.row}: {r.errors.map(e => `${FIELD_LABEL[e.field] ?? e.field}: ${e.message}${e.value ? ` ('${e.value}')` : ''}`).join('; ')}</li>)}
              </ul>
            )}
            {preview.rows.length > 0 && (
              <table className="w-full text-[11px] tabular-nums" data-testid="import-preview-rows">
                <thead><tr className="text-slate-500"><th className="text-left font-medium">Row</th><th className="text-left font-medium">Road</th><th className="text-left font-medium">Dir</th><th className="text-left font-medium">Period</th><th className="text-right font-medium">Veh</th></tr></thead>
                <tbody>{preview.rows.slice(0, 8).map(r => {
                  const v = Object.values(r.record.class_counts ?? {}).reduce((a, b) => a + b, 0) || r.record.total_count || 0;
                  return <tr key={r.row} className={`border-t border-white/5 ${r.errors.length ? 'text-rose-300' : 'text-slate-300'}`}><td>{r.row}</td><td className="truncate max-w-[7rem]">{r.record.road_id ?? r.record.junction_ref ?? '–'}</td><td>{r.record.direction ?? '–'}</td><td>{r.record.period_start ?? '?'}–{r.record.period_end ?? '?'}</td><td className="text-right">{v}</td></tr>;
                })}</tbody>
              </table>
            )}
          </Section>
          <Section title="4. Provenance">
            <MetaForm meta={meta} setMeta={setMeta} sets={sets} />
          </Section>
          {preview.error_count > 0 && (
            <label className="flex items-start gap-2 text-xs text-amber-100"><input type="checkbox" checked={skip} onChange={e => setSkip(e.target.checked)} className="mt-0.5" />
              Import only the {preview.valid_count} valid rows. The {preview.error_count} rejected rows are listed in the dataset's import report; nothing is corrected.</label>
          )}
          <Button variant="primary" className="w-full" icon={busy ? Loader2 : Database} spin={busy} disabled={busy || preview.valid_count === 0 || (preview.error_count > 0 && !skip)} onClick={() => void commit()}>
            Import {preview.valid_count} rows
          </Button>
        </>
      )}
    </div>
  );
};

// ── per-road view ─────────────────────────────────────────────────────────────

const RoadView: React.FC<{ datasets: Dataset[]; roadId: string | null; setRoadId: (id: string | null) => void }> = ({ datasets, roadId, setRoadId }) => {
  const [data, setData] = useState<{ ds: Dataset; set: string | null; hours: HourRow[] }[] | null>(null);
  const [error, setError] = useState<string | null>(null);
  useEffect(() => {
    if (!roadId) { setData(null); return; }
    let live = true;
    Promise.all(datasets.filter(d => (d.record_count ?? 0) > 0).map(d => trafficApi.hourly(d.id, roadId).then(h => ({ ds: d, set: h.pcu_set_name, hours: h.hours }))))
      .then(r => { if (live) { setData(r.filter(x => x.hours.length)); setError(null); } })
      .catch(e => live && setError(errText(e).message));
    return () => { live = false; };
  }, [roadId, datasets]);
  const info = roadInfo(roadId);
  const max = Math.max(1, ...(data ?? []).flatMap(d => d.hours.map(h => h.veh_h ?? 0)));
  return (
    <div className="space-y-3" data-testid="road-view">
      <RoadPicker roadId={roadId} setRoadId={setRoadId} />
      {error && <Notice tone="bad" icon={AlertTriangle}>{error}</Notice>}
      {roadId && data && !data.length && <p className="text-sm text-slate-400">No counts on this road.</p>}
      {data?.map(({ ds, set, hours }) => (
        <div key={ds.id} className="rounded-xl border border-white/10 bg-white/[0.03] p-2.5 space-y-1.5">
          <p className="flex flex-wrap items-center gap-1.5 text-sm text-white font-semibold">{ds.name} <ProvenanceBadge kind={ds.kind} synthetic={ds.synthetic} /></p>
          <table className="w-full text-xs tabular-nums">
            <thead><tr className="text-slate-500"><th className="text-left font-medium">Hour</th><th className="text-left font-medium">Dir</th><th className="text-left font-medium">Day</th><th className="font-medium" /><th className="text-right font-medium">veh/h</th><th className="text-right font-medium">PCU/h</th></tr></thead>
            <tbody>{hours.map((h, i) => (
              <tr key={i} className="border-t border-white/5" title={h.complete ? '' : `Only ${h.minutes} min counted: no hourly flow`}>
                <td className="py-0.5 text-slate-300">{h.period}</td>
                <td className="text-slate-400">{h.key.direction === 'fwd' ? (info?.bearing?.fwd ?? 'fwd') : h.key.direction === 'bwd' ? (info?.bearing?.bwd ?? 'bwd') : h.key.direction ?? h.key.ref_kind}</td>
                <td className="text-slate-400">{DAY_LABEL[h.day_type]}</td>
                <td className="w-16"><div className="h-1.5 rounded bg-white/10"><div className="h-full rounded bg-emerald-400" style={{ width: `${Math.round(100 * (h.veh_h ?? 0) / max)}%` }} /></div></td>
                <td className="text-right text-slate-100">{h.complete ? fmt(h.veh_h) : <span className="text-amber-300">{h.minutes} min</span>}</td>
                <td className="text-right text-slate-300" title={h.pcu_note ?? ''}>{fmt(h.pcu_h)}</td>
              </tr>
            ))}</tbody>
          </table>
          <p className="text-[11px] text-slate-500">PCU: {set ?? 'no factor set chosen'}. An hour shows a flow only when its counts cover all 60 minutes; nothing is extrapolated.</p>
        </div>
      ))}
    </div>
  );
};

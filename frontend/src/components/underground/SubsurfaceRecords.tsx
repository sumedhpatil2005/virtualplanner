import React, { useState } from 'react';
import { Database, Upload } from 'lucide-react';
import { coordinationApi, type SubsurfaceRecord } from '../../lib/coordinationApi';
import { engineInstance } from '../../engine/TwinCityEngine';
import { EmptyState } from '../ui/EmptyState';
import { CertaintyBadge } from '../ui/badges/CertaintyBadge';
import { field, fmtM, input, inputStyle, lbl, labelStyle, note } from './common';
import { USER_KEY, useSubsurfaceRecords } from './useSubsurfaceRecords';

const QL_NOTE: Record<string, string> = {
  'QL-A': 'ASCE 38 QL-A: exposed / potholed (horizontal and vertical measured)',
  'QL-B': 'ASCE 38 QL-B: surface geophysics (horizontal position)',
  'QL-C': 'ASCE 38 QL-C: surveyed surface features correlated with records',
  'QL-D': 'ASCE 38 QL-D: records or recollection',
};

const RecordRow: React.FC<{ r: SubsurfaceRecord; datasetName: string }> = ({ r, datasetName }) => {
  const ql = r.record_type === 'utility' ? (r.quality_level ?? 'UNKNOWN') : null;
  const fly = () => {
    const g = r.geometry;
    const v = engineInstance.getViewer();
    if (!g || !v) return;
    const pts = g.type === 'Point' ? [g.coordinates] : g.type === 'LineString' ? g.coordinates : g.coordinates[0];
    const lon = pts.reduce((s, p) => s + p[0], 0) / pts.length, lat = pts.reduce((s, p) => s + p[1], 0) / pts.length;
    import('cesium').then(({ Cartesian3 }) => v.camera.flyTo({ destination: Cartesian3.fromDegrees(lon, lat - 0.004, 450), orientation: { heading: 0, pitch: -0.6, roll: 0 } }));
  };
  return (
    <li>
      <button type="button" className="uos-row w-full text-left" onClick={fly} disabled={!r.geometry} title={r.geometry ? 'Fly to record' : r.location_note || 'Location UNKNOWN'}>
        <span className="min-w-0 flex-1">
          <span className="block text-body text-text-1 truncate">{r.record_type === 'borehole' ? 'Borehole' : (r.utility_type ?? 'Utility')} {r.external_id}</span>
          <span className="block text-meta text-text-2">
            {r.record_type === 'borehole'
              ? <>final depth {fmtM(r.final_depth_m)} · {r.strata.length} strata</>
              : <>depth {fmtM(r.depth_m)} · Ø {fmtM(r.diameter_m, 2)} · owner {r.owner || 'Unknown'}</>}
            {!r.geometry && ' · location UNKNOWN'}
          </span>
          <span className="block text-meta text-text-3 truncate">from {datasetName}</span>
        </span>
        <span className="flex flex-col items-end gap-1 shrink-0">
          {ql && <span className="text-meta font-semibold rounded px-1.5" style={{ border: '1px solid var(--border-strong)' }} title={QL_NOTE[ql] ?? 'Quality level not recorded: UNKNOWN'} data-testid="ug-record-ql">{ql === 'UNKNOWN' ? 'QL ?' : ql}</span>}
          <CertaintyBadge certainty={r.z_certainty} compact note="Depth certainty (from QL: only QL-A is measured)" />
        </span>
      </button>
    </li>
  );
};

export const SubsurfaceRecords: React.FC = () => {
  const { datasets, records, recordsState, recordsError, reload } = useSubsurfaceRecords();
  const [importing, setImporting] = useState(false);
  const dsName = (id: string) => datasets.find(d => d.id === id)?.name ?? id;
  return (
    <div className="flex flex-col gap-2" data-testid="ug-records">
      {recordsState === 'loading' && <p className="text-label text-text-2">Loading records…</p>}
      {recordsState === 'error' && <p className="text-label text-fail" role="alert">Could not load records: {recordsError}. <button type="button" className="uos-link" onClick={() => void reload()}>Retry</button></p>}
      {recordsState === 'loaded' && records.length === 0 && (
        <EmptyState icon={Database} title="No records imported · Unknown">
          No borehole or utility records are imported, so nothing is known about existing services or ground here. Absence of records is not absence of utilities.
        </EmptyState>
      )}
      {datasets.length > 0 && (
        <ul className="space-y-1" data-testid="ug-datasets">
          {datasets.map(d => (
            <li key={d.id} className="uos-card text-meta text-text-2">
              <div className="text-body text-text-1">{d.name} <span className="text-text-3">· {d.record_type} · {d.format.toUpperCase()} · {d.record_count} record{d.record_count === 1 ? '' : 's'}</span></div>
              <div>Publisher {d.publisher || 'Unknown'} · licence {d.licence || 'UNKNOWN'} · data date {d.data_date ?? 'Unknown'}</div>
              <div>Coverage: {d.coverage_label}</div>
              <div className="truncate" title={d.file_sha256 ?? ''}>Imported by {d.imported_by} · sha256 {d.file_sha256 ? d.file_sha256.replace(/^sha256:/, '').slice(0, 12) + '…' : 'n/a'}</div>
              {d.warnings.length > 0 && <div className="text-warn">{d.warnings.length} warning{d.warnings.length > 1 ? 's' : ''}: {d.warnings.slice(0, 2).join('; ')}</div>}
            </li>
          ))}
        </ul>
      )}
      {records.length > 0 && (
        <ul className="space-y-1 max-h-64 overflow-auto" data-testid="ug-record-list">
          {records.slice(0, 200).map(r => <RecordRow key={r.id} r={r} datasetName={dsName(r.dataset_id)} />)}
        </ul>
      )}
      {importing ? <ImportForm onDone={() => { setImporting(false); void reload(); }} onCancel={() => setImporting(false)} />
        : <button type="button" className="uos-btn self-start" onClick={() => setImporting(true)} data-testid="ug-import-open"><Upload size={14} aria-hidden /> Import records (AGS4 / CSV / JSON)</button>}
    </div>
  );
};

const formatFor = (name: string): 'ags4' | 'csv' | 'json' => (/\.ags4?$/i.test(name) ? 'ags4' : /\.json$/i.test(name) ? 'json' : 'csv');

const ImportForm: React.FC<{ onDone: () => void; onCancel: () => void }> = ({ onDone, onCancel }) => {
  const [recordType, setRecordType] = useState<'borehole' | 'utility'>('borehole');
  const [file, setFile] = useState<File | null>(null);
  const [name, setName] = useState('');
  const [publisher, setPublisher] = useState('');
  const [licence, setLicence] = useState('');
  const [dataDate, setDataDate] = useState('');
  const [bbox, setBbox] = useState('');
  const [user, setUser] = useState(() => localStorage.getItem(USER_KEY) ?? '');
  const [busy, setBusy] = useState(false);
  const [err, setErr] = useState<string | null>(null);
  const [warn, setWarn] = useState<string[]>([]);
  const bboxNums = bbox.trim() === '' ? null : bbox.split(',').map(s => Number(s.trim()));
  const bboxOk = bboxNums === null || (bboxNums.length === 4 && bboxNums.every(Number.isFinite));
  const submit = async () => {
    if (!file) return;
    setBusy(true); setErr(null);
    try {
      localStorage.setItem(USER_KEY, user.trim());
      const content = await file.text();
      const fmt = formatFor(file.name);
      const res = await coordinationApi.importSubsurface({
        record_type: recordType, format: fmt, content, name: name.trim() || file.name, file_name: file.name,
        ...(publisher.trim() ? { publisher: publisher.trim() } : {}), ...(licence.trim() ? { licence: licence.trim() } : {}),
        ...(dataDate ? { data_date: dataDate } : {}), ...(bboxNums ? { coverage_bbox: bboxNums as [number, number, number, number] } : {}),
        imported_by: user.trim(),
      });
      setWarn(res.warnings);
      (window as any).showToast?.(`Imported ${res.record_count} ${recordType} record(s) from ${file.name}${res.warnings.length ? ` with ${res.warnings.length} warning(s)` : ''}.`, 'success');
      onDone();
    } catch (e) {
      setErr((e as Error).message);
    } finally { setBusy(false); }
  };
  return (
    <form className="uos-card flex flex-col gap-2" data-testid="ug-import-form" onSubmit={e => { e.preventDefault(); void submit(); }}>
      <div className="grid grid-cols-2 gap-2">
        <div className={field}>
          <label className={lbl} style={labelStyle} htmlFor="ug-imp-type">Records</label>
          <select id="ug-imp-type" className={input} style={inputStyle} value={recordType} onChange={e => setRecordType(e.target.value as 'borehole' | 'utility')}>
            <option value="borehole">Boreholes</option><option value="utility">Utilities</option>
          </select>
        </div>
        <div className={field}>
          <label className={lbl} style={labelStyle} htmlFor="ug-imp-user">Your name</label>
          <input id="ug-imp-user" required className={input} style={inputStyle} value={user} onChange={e => setUser(e.target.value)} />
        </div>
      </div>
      <div className={field}>
        <label className={lbl} style={labelStyle} htmlFor="ug-imp-file">File (.ags AGS4 subset · .csv template · .json)</label>
        <input id="ug-imp-file" data-testid="ug-import-file" type="file" accept=".ags,.ags4,.csv,.json,text/csv,application/json" required className="text-label text-text-2" onChange={e => setFile(e.target.files?.[0] ?? null)} />
      </div>
      <div className="grid grid-cols-2 gap-2">
        <div className={field}><label className={lbl} style={labelStyle} htmlFor="ug-imp-name">Dataset name</label><input id="ug-imp-name" className={input} style={inputStyle} value={name} placeholder={file?.name ?? ''} onChange={e => setName(e.target.value)} /></div>
        <div className={field}><label className={lbl} style={labelStyle} htmlFor="ug-imp-pub">Publisher</label><input id="ug-imp-pub" className={input} style={inputStyle} value={publisher} placeholder="Unknown" onChange={e => setPublisher(e.target.value)} /></div>
        <div className={field}><label className={lbl} style={labelStyle} htmlFor="ug-imp-lic">Licence</label><input id="ug-imp-lic" className={input} style={inputStyle} value={licence} placeholder="UNKNOWN" onChange={e => setLicence(e.target.value)} /></div>
        <div className={field}><label className={lbl} style={labelStyle} htmlFor="ug-imp-date">Data date</label><input id="ug-imp-date" type="date" className={input} style={inputStyle} value={dataDate} onChange={e => setDataDate(e.target.value)} /></div>
      </div>
      <div className={field}>
        <label className={lbl} style={labelStyle} htmlFor="ug-imp-bbox">Stated coverage (W,S,E,N degrees)</label>
        <input id="ug-imp-bbox" className={input} style={inputStyle} value={bbox} placeholder="blank = coverage UNKNOWN" onChange={e => setBbox(e.target.value)} aria-invalid={!bboxOk} />
        <p className="text-[11px]" style={note}>Only a stated coverage lets a conflict check say "no record within available data"; without it utilities stay UNKNOWN.</p>
      </div>
      {err && <p className="text-label text-fail" role="alert">{err}</p>}
      {warn.length > 0 && <p className="text-label text-warn">{warn.join('; ')}</p>}
      <div className="flex gap-2">
        <button type="submit" className="uos-btn" disabled={busy || !file || !user.trim() || !bboxOk} data-testid="ug-import-submit">{busy ? 'Importing…' : 'Import'}</button>
        <button type="button" className="uos-btn" onClick={onCancel}>Cancel</button>
      </div>
    </form>
  );
};

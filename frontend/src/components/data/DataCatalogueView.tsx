import React, { useCallback, useEffect, useMemo, useState } from 'react';
import { CircleCheck, CircleDashed, CircleX, Database, Loader2, RefreshCw, Search, TriangleAlert, X } from 'lucide-react';
import { datasetsApi, type DataClass, type DsDataset, type FeatureReadiness, type QualityCheck } from '../../lib/datasetsApi';
import { Tabs, TabPanel } from '../ui/Tabs';
import { IconButton } from '../ui/IconButton';
import { Disclosure } from '../ui/Disclosure';
import { EmptyState } from '../ui/EmptyState';
import { DataStatus, TrustBadge } from '../ui/badges';
import { CERTAINTY_COLOR } from '../ui/badges/honesty';
import { useShellStore } from '../../shell/useShellStore';
import {
  CHECK_LABEL, CHECK_TONE, DATA_CLASS_HELP, DATA_CLASS_LABEL, DATA_CLASS_TONE, DEP_STATE_LABEL, FEATURE_STATUS_LABEL, UNKNOWN,
  CHECK_STATUS_LABEL, dataStatusValue, featureFailsValidation, featureNames, filterDatasets, footprint, groupDatasets, groupFeatures, provenanceRows, puneRect,
  pendingNote, qualityBadge, qualitySummary, reviewStatusLabel, themeLabel, workspaceLabel,
} from './dataCatalogueModel';
import { useDataCatalogue, type DataView } from './useDataCatalogue';

const TONE_COLOR = { good: 'var(--measured, #3FB950)', warn: 'var(--warn, #E8833A)', bad: 'var(--fail, #FF6B61)', unknown: 'var(--unknown, #9AA4B2)' };
const FEATURE_COLOR = { ready: TONE_COLOR.good, partial: TONE_COLOR.warn, blocked: TONE_COLOR.bad };
const ORIGIN_LABEL: Record<string, string> = { seed: 'from the built-in seed', manifest: 'from manifest.json', processing: 'from processing.json', catalogue_sync: 'from the source catalogue' };
const who = () => localStorage.getItem('td-user') ?? '';

/**
 * Data catalogue (desktop): every registered dataset with its provenance card, and every UrbanOS feature with the data it
 * needs and whether it is ready / partial / blocked. Mounted over the map stage; opened from Reports → Data catalogue.
 */
export const DataCatalogueOverlay: React.FC = () => {
  const open = useDataCatalogue(s => s.open);
  const workspace = useShellStore(s => s.workspace);
  const visible = open && workspace === 'reports';
  // the catalogue is a full view over the stage: it takes the inspector's column while open (shell one-overlay rule)
  useEffect(() => { if (visible) useShellStore.getState().setInspectorOpen(false); }, [visible]);
  if (!visible) return null;
  return <DataCatalogueView />;
};

const DataCatalogueView: React.FC = () => {
  const { view, setView, close, selected, select } = useDataCatalogue();
  const [list, setList] = useState<DsDataset[] | null>(null);
  const [features, setFeatures] = useState<FeatureReadiness[] | null>(null);
  const [error, setError] = useState<string | null>(null);
  const load = useCallback(() => {
    setError(null);
    datasetsApi.list().then(setList).catch((e: Error) => { setList([]); setError(e.message); });
    datasetsApi.features().then(r => setFeatures(r.features)).catch((e: Error) => { setFeatures([]); setError(e.message); });
  }, []);
  useEffect(load, [load]);
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => { if (e.key === 'Escape') close(); };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, [close]);

  const tabs: { id: DataView; label: string; 'data-testid': string }[] = [
    { id: 'datasets', label: `Datasets${list ? ` (${list.length})` : ''}`, 'data-testid': 'data-tab-datasets' },
    { id: 'features', label: `Features${features ? ` (${features.length})` : ''}`, 'data-testid': 'data-tab-features' },
  ];
  return (
    <section className="uos-data-overlay" aria-label="Data catalogue" data-testid="data-catalogue">
      <header className="uos-data-header">
        <Database size={16} aria-hidden className="text-text-2" />
        <h2 className="text-heading font-semibold text-text-1">Data catalogue</h2>
        <Tabs tabs={tabs} value={view} onChange={setView} label="Data catalogue views" idBase="uos-data" />
        <span className="flex-1" />
        <button type="button" className="uos-btn uos-btn-sm" onClick={load} aria-label="Reload catalogue"><RefreshCw size={13} aria-hidden />Reload</button>
        <IconButton icon={X} label="Close data catalogue" onClick={close} size="sm" tooltip="left" />
      </header>
      {error && <p className="text-label text-warn px-4 pt-2" role="status">Could not load everything ({error}).</p>}
      <TabPanel idBase="uos-data" id={view} className="uos-data-body">
        {view === 'datasets'
          ? <DatasetsPane list={list} features={features} selected={selected} onSelect={id => select(id)} onChanged={load} />
          : <FeaturesPane features={features} onDataset={id => select(id)} />}
      </TabPanel>
    </section>
  );
};

// ── Datasets ──────────────────────────────────────────────────────────────────────────────────────────────────────────
const DatasetsPane: React.FC<{ list: DsDataset[] | null; features: FeatureReadiness[] | null; selected: string | null; onSelect: (id: string) => void; onChanged: () => void }> = ({ list, features, selected, onSelect, onChanged }) => {
  const [query, setQuery] = useState('');
  const groups = useMemo(() => (list ? groupDatasets(filterDatasets(list, query, null)) : []), [list, query]);
  const current = selected ?? groups[0]?.items[0]?.id ?? null;
  if (list == null) return <p className="p-4 text-label text-text-2 flex items-center gap-2"><Loader2 size={14} className="animate-spin" aria-hidden />Loading…</p>;
  return (
    <div className="uos-data-split">
      <div className="uos-data-list" data-testid="data-list">
        <label className="uos-search w-full mb-2" style={{ flex: 'none' }}>
          <Search size={14} aria-hidden />
          <input value={query} onChange={e => setQuery(e.target.value)} placeholder="Filter datasets" aria-label="Filter datasets"
            className="bg-transparent outline-none flex-1 min-w-0 text-text-1" />
        </label>
        {groups.length === 0 && <p className="text-label text-text-2">No dataset matches.</p>}
        {groups.map(g => (
          <div key={g.status} className="mb-3">
            <h3 className="text-meta font-semibold text-text-2 uppercase tracking-wide mb-1">{g.label} · {g.items.length}</h3>
            <ul className="space-y-0.5">
              {g.items.map(d => {
                const q = qualitySummary(d.active_version?.quality_checks ?? []);
                return (
                  <li key={d.id}>
                    <button type="button" className={`uos-row w-full text-left ${current === d.id ? 'is-selected' : ''}`} onClick={() => onSelect(d.id)}
                      aria-current={current === d.id} data-testid={`data-row-${d.id}`}>
                      <span className="min-w-0 flex-1">
                        <span className="block text-label text-text-1 break-words">{d.title}</span>
                        <span className="block text-meta text-text-3 break-words">{themeLabel(d.theme)}{d.active_version?.data_class ? ` · ${DATA_CLASS_LABEL[d.active_version.data_class]}` : ''}{d.active_version && d.pending_version_ids.length > 0 ? ' · newer version pending review' : ''}</span>
                      </span>
                      {q.worst && <span className="text-meta tabular-nums shrink-0" style={{ color: TONE_COLOR[CHECK_TONE[q.worst]] }} title={`Quality checks: ${q.pass} pass · ${q.warn} warn · ${q.fail} fail · ${q.unknown} unknown`}>
                        {qualityBadge(q)}</span>}
                    </button>
                  </li>
                );
              })}
            </ul>
          </div>
        ))}
      </div>
      <div className="uos-data-detail">
        {current ? <ProvenanceCard id={current} features={features} onChanged={onChanged} /> : <EmptyState icon={Database} title="Select a dataset" />}
      </div>
    </div>
  );
};

const DataClassChip: React.FC<{ cls: DataClass | null }> = ({ cls }) => {
  if (!cls) return <span className="text-meta" style={{ color: TONE_COLOR.unknown }}>Class not recorded</span>;
  return (
    <span className="uos-data-chip" style={{ borderColor: CERTAINTY_COLOR[DATA_CLASS_TONE[cls]], color: CERTAINTY_COLOR[DATA_CLASS_TONE[cls]] }}
      title={DATA_CLASS_HELP[cls]} data-testid="data-class-chip">{DATA_CLASS_LABEL[cls]}</span>
  );
};

const ProvenanceCard: React.FC<{ id: string; features: FeatureReadiness[] | null; onChanged: () => void }> = ({ id, features, onChanged }) => {
  const [d, setD] = useState<DsDataset | null>(null);
  const [err, setErr] = useState<string | null>(null);
  const [busy, setBusy] = useState<string | null>(null);
  const reload = useCallback(() => { setErr(null); datasetsApi.get(id).then(setD).catch((e: Error) => setErr(e.message)); }, [id]);
  useEffect(() => { setD(null); reload(); }, [reload]);
  if (err) return <p className="text-label text-warn" role="status">Could not load {id}: {err}</p>;
  if (!d) return <p className="text-label text-text-2 flex items-center gap-2"><Loader2 size={14} className="animate-spin" aria-hidden />Loading…</p>;
  const v = d.active_version;
  const fp = footprint(v?.coverage_bbox ?? null);
  const pune = puneRect();
  const act = async (key: string, fn: () => Promise<unknown>, ok: string) => {
    setBusy(key);
    try { await fn(); (window as any).showToast?.(ok, 'success'); reload(); onChanged(); } catch (e) { (window as any).showToast?.((e as Error).message, 'error'); } finally { setBusy(null); }
  };
  return (
    <article className="space-y-3" data-testid="provenance-card" aria-label={`Provenance of ${d.title}`}>
      <header className="space-y-1">
        <div className="flex items-center gap-2 flex-wrap">
          <h3 className="text-heading font-semibold text-text-1">{d.title}</h3>
          <DataClassChip cls={v?.data_class ?? null} />
          {v?.suitability && <span className="uos-data-chip" title="Highest use the data is suitable for">for {v.suitability}</span>}
        </div>
        <DataStatus name={d.title} value={dataStatusValue(d)} />
        {d.description && <p className="text-label text-text-2">{d.description}</p>}
        {d.limitations && <p className="text-label" style={{ color: TONE_COLOR.warn }}>{d.limitations}</p>}
        {d.update_status?.result === 'update_available' && (
          <p className="text-label" style={{ color: TONE_COLOR.warn }} data-testid="update-available-note" title={d.update_status.detail}>
            Update available upstream (checked {d.update_status.checked_at?.slice(0, 16).replace('T', ' ') ?? UNKNOWN} UTC) — not downloaded; acquire, register and review it before use.
          </p>
        )}
        {d.pending_version_ids.length > 0 && (
          <p className="text-label" style={{ color: TONE_COLOR.warn }} data-testid="pending-note">
            {pendingNote(d)}
          </p>
        )}
      </header>

      <div className="uos-data-grid">
        <dl className="uos-data-facts" data-testid="provenance-facts">
          {provenanceRows(d).map(([k, val]) => (
            <div key={k}><dt>{k}</dt><dd className={val === UNKNOWN ? 'is-unknown' : ''} title={val}>{
              /^https?:\/\//.test(val) ? <a className="uos-link" href={val} target="_blank" rel="noreferrer">{val}</a> : val}</dd></div>
          ))}
        </dl>
        <figure className="uos-data-footprint" data-testid="coverage-footprint">
          <svg viewBox="0 0 200 160" width="200" height="160" role="img" aria-label={`Coverage: ${fp.kind === 'none' ? 'unknown' : `${fp.percentOfPune}% of the Pune study box`}`}>
            <rect x="0" y="0" width="200" height="160" fill="var(--surface-1)" stroke="var(--border)" />
            {fp.rect && <rect x={fp.rect.x} y={fp.rect.y} width={fp.rect.w} height={fp.rect.h} fill="color-mix(in srgb, var(--accent) 22%, transparent)" stroke="var(--accent)" />}
            <rect x={pune.x} y={pune.y} width={pune.w} height={pune.h} fill="none" stroke="var(--text-2)" strokeDasharray="4 3" />
            <text x={pune.x + 3} y={pune.y + 11} fontSize="9" fill="var(--text-2)">Pune study box</text>
            {fp.kind === 'none' && <text x="100" y="84" fontSize="11" textAnchor="middle" fill="var(--unknown, #9AA4B2)">coverage UNKNOWN</text>}
            {fp.kind === 'outside' && <text x="100" y="84" fontSize="11" textAnchor="middle" fill="var(--fail)">outside the study box</text>}
          </svg>
          <figcaption className="text-meta text-text-3">
            {fp.kind === 'none' ? 'No coverage stated — absence of features proves nothing.'
              : fp.kind === 'covers' ? `Stated coverage extends beyond this frame (${fp.percentOfPune}% of the study box).`
              : `${fp.percentOfPune}% of the Pune study box (bounding box; WGS84).`}
          </figcaption>
        </figure>
      </div>

      {v && <QualityList checks={v.quality_checks} />}
      {v && (
        <div className="flex flex-wrap gap-1.5">
          <button type="button" className="uos-btn uos-btn-sm" disabled={!!busy} data-testid="run-quality"
            onClick={() => void act('q', () => datasetsApi.runQuality(v.id), 'Quality checks re-run')}>
            {busy === 'q' ? <Loader2 size={13} className="animate-spin" aria-hidden /> : <RefreshCw size={13} aria-hidden />}Re-run quality checks</button>
          <button type="button" className="uos-btn uos-btn-sm" disabled={!!busy || !d.update_check?.url} title={d.update_check?.url ? `Probe ${d.update_check.url}` : 'No machine-checkable update endpoint'}
            onClick={() => void act('u', () => datasetsApi.updateCheck(d.id, who() || 'anonymous'), 'Update check recorded')}>
            {busy === 'u' ? <Loader2 size={13} className="animate-spin" aria-hidden /> : <RefreshCw size={13} aria-hidden />}Check for a newer version</button>
        </div>
      )}
      {!v && d.recommended_sources.length > 0 && (
        <div className="uos-card space-y-1">
          <h4 className="text-label font-semibold text-text-2">Recommended sources (metadata only, not acquired)</h4>
          <ul className="text-label text-text-2 space-y-1">{d.recommended_sources.map(r => (
            <li key={r.name}>{r.url ? <a className="uos-link" href={r.url} target="_blank" rel="noreferrer">{r.name}</a> : r.name} · {r.publisher || UNKNOWN} · licence {r.licence || UNKNOWN}{r.notes ? ` — ${r.notes}` : ''}</li>
          ))}</ul>
        </div>
      )}

      <Disclosure summary={`Versions (${d.versions?.length ?? 0}) and processing history`}>
        <ul className="space-y-2" data-testid="version-history">
          {(d.versions ?? []).slice().reverse().map(x => (
            <li key={x.id} className="uos-card space-y-1">
              <div className="flex items-center gap-2 flex-wrap">
                <span className="text-label text-text-1 font-medium">Version {x.version_label}</span>
                <span className="uos-data-chip" data-testid={`version-status-${x.version_label}`}>{reviewStatusLabel(x.review_status)}</span>
                <span className="text-meta text-text-3">{ORIGIN_LABEL[x.origin] ?? x.origin} · registered {x.created_at?.slice(0, 16).replace('T', ' ') ?? UNKNOWN} UTC</span>
                {x.review_status === 'pending_review' && (
                  <span className="flex gap-1 ml-auto">
                    <button type="button" className="uos-btn uos-btn-sm" disabled={!!busy || !who()} title={who() ? '' : 'Set your name (Traffic data / Projects) to review'}
                      onClick={() => void act(`a${x.id}`, () => datasetsApi.review(x.id, { decision: 'activate', reviewer: who() }), 'Version activated')}>Activate</button>
                    <button type="button" className="uos-btn uos-btn-sm" disabled={!!busy || !who()}
                      onClick={() => void act(`r${x.id}`, () => datasetsApi.review(x.id, { decision: 'reject', reviewer: who() }), 'Version rejected')}>Reject</button>
                  </span>
                )}
              </div>
              {x.notes && <p className="text-meta text-text-2 whitespace-pre-wrap">{x.notes}</p>}
              {x.reviewed_by && <p className="text-meta text-text-3">Reviewed by {x.reviewed_by}{x.review_note ? ` — ${x.review_note}` : ''}</p>}
              {(x.processing_runs ?? []).map(p => (
                <div key={p.id} className="text-meta text-text-2">
                  Pipeline <code>{p.pipeline}</code> @ {p.git_commit ?? 'commit UNKNOWN'} · inputs {p.inputs.length} · {p.finished_at ?? 'time UNKNOWN'}
                </div>
              ))}
              {(x.files ?? []).length > 0 && (
                <ul className="text-meta text-text-3">{(x.files ?? []).map(f => <li key={f.id} className="break-all" title={f.path}>{f.role}: {f.path} · sha256 {f.sha256 ? f.sha256.slice(0, 12) + '…' : UNKNOWN}</li>)}</ul>
              )}
            </li>
          ))}
        </ul>
      </Disclosure>
      {(d.update_checks ?? []).length > 0 && (
        <Disclosure summary={`Update checks (${d.update_checks!.length})`}>
          <ul className="text-meta text-text-2 space-y-0.5">{d.update_checks!.map(u => <li key={u.id}>{u.checked_at?.slice(0, 16).replace('T', ' ')} UTC · {u.result} · {u.detail}</li>)}</ul>
        </Disclosure>
      )}
      {(d.used_by_features ?? []).length > 0 && <p className="text-meta text-text-3" data-testid="used-by">Used by: {featureNames(d.used_by_features!, features).join(', ')}</p>}
    </article>
  );
};

const QualityList: React.FC<{ checks: QualityCheck[] }> = ({ checks }) => (
  <table className="uos-table" data-testid="quality-checks">
    <thead><tr><th>Quality check</th><th>Result</th><th>Detail</th></tr></thead>
    <tbody>
      {checks.map(c => {
        const tone = CHECK_TONE[c.status];
        const Icon = tone === 'good' ? CircleCheck : tone === 'bad' ? CircleX : tone === 'warn' ? TriangleAlert : CircleDashed;
        return (
          <tr key={c.check}>
            <td>{CHECK_LABEL[c.check] ?? c.check}</td>
            <td><span className="inline-flex items-center gap-1" style={{ color: TONE_COLOR[tone] }}><Icon size={12} aria-hidden />{CHECK_STATUS_LABEL[c.status] ?? c.status}</span></td>
            <td className="text-text-2" style={{ whiteSpace: 'normal' }}>{c.detail}</td>
          </tr>
        );
      })}
    </tbody>
  </table>
);

// ── Features ──────────────────────────────────────────────────────────────────────────────────────────────────────────
const FeaturesPane: React.FC<{ features: FeatureReadiness[] | null; onDataset: (id: string) => void }> = ({ features, onDataset }) => {
  if (features == null) return <p className="p-4 text-label text-text-2 flex items-center gap-2"><Loader2 size={14} className="animate-spin" aria-hidden />Loading…</p>;
  const groups = groupFeatures(features);
  return (
    <div className="uos-data-features" data-testid="features-view">
      <p className="text-label text-text-2 mb-3">Each UrbanOS feature, the data it needs and the quality it needs. Ready = every required input is acquired at the required quality. Synthetic data never counts.</p>
      {groups.map(g => (
        <section key={g.capability} className="mb-4">
          <h3 className="text-label font-semibold text-text-1 mb-1">{g.capability}
            <span className="text-meta text-text-3 font-normal ml-2">{g.counts.ready} ready · {g.counts.partial} partial · {g.counts.blocked} blocked</span></h3>
          <ul className="space-y-1.5">
            {g.features.map(f => (
              <li key={f.id} className="uos-card space-y-1" data-testid={`feature-${f.id}`} data-status={f.status}>
                <div className="flex items-center gap-2 flex-wrap">
                  <span className="uos-data-chip" style={{ borderColor: FEATURE_COLOR[f.status], color: FEATURE_COLOR[f.status] }}>{FEATURE_STATUS_LABEL[f.status]}</span>
                  <span className="text-label text-text-1 font-medium">{f.name}</span>
                  <span className="text-meta text-text-3">{workspaceLabel(f.workspace)}</span>
                  {featureFailsValidation(f) && <TrustBadge trust="fails_validation" testId={`feature-trust-${f.id}`} />}
                  {f.wired === false && <span className="uos-data-chip" style={{ borderColor: TONE_COLOR.warn, color: TONE_COLOR.warn }} title={f.wiring_note ?? ''}
                    data-testid={`feature-not-wired-${f.id}`}>Not wired into the feature yet</span>}
                </div>
                {f.wired === false && f.wiring_note && <p className="text-meta text-text-3">{f.wiring_note}</p>}
                {f.reasons.length > 0 && <ul className="text-meta text-text-2 list-disc pl-4">{f.reasons.map(r => <li key={r}>{r}</li>)}</ul>}
                <table className="uos-table">
                  <thead><tr><th>Needs</th><th>Quality</th><th>Dataset</th><th>State</th></tr></thead>
                  <tbody>{f.dependencies.map(dep => (
                    <tr key={dep.dependency_id}>
                      <td>{themeLabel(dep.theme)}{dep.required ? '' : ' (optional)'}</td>
                      <td>{dep.required_quality}</td>
                      <td>{dep.dataset_id ? <button type="button" className="uos-link text-left" onClick={() => onDataset(dep.dataset_id!)}>{dep.dataset_title ?? dep.dataset_id}</button> : <span style={{ color: TONE_COLOR.unknown }}>none registered</span>}</td>
                      <td style={{ color: dep.state === 'satisfied' ? TONE_COLOR.good : dep.state === 'insufficient_quality' ? TONE_COLOR.warn : TONE_COLOR.bad }}>{DEP_STATE_LABEL[dep.state]}</td>
                    </tr>
                  ))}</tbody>
                </table>
              </li>
            ))}
          </ul>
        </section>
      ))}
    </div>
  );
};

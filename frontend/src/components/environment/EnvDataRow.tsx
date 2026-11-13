/**
 * One row of the Environment data catalogue (GET /api/env-data/catalogue): status, source · date · licence (DataStatus),
 * data class and suitability, vintage note, map toggle where a renderer exists, variant (date / property) selector,
 * legend, what was drawn for which box, limitations and provenance (pipeline, commit, output sha256).
 */
import React from 'react';
import { Ban, CircleHelp, Eye, EyeOff, Loader2, OctagonX } from 'lucide-react';
import { DataStatus } from '../ui/badges/DataStatus';
import { Disclosure } from '../ui/Disclosure';
import type { EnvDataLayer, EnvLegend } from '../../lib/envDataApi';
import { classLine, envDataStatus, hasMapToggle, legendOf, rampCss, STATUS_LABEL } from './envDataModel';
import { setEnvDataVariant, setEnvDataVisible, useEnvDataOverlayStore } from './envDataOverlay';

const selCls = 'rounded-md bg-white/[0.05] border border-white/10 px-1.5 py-0.5 text-label text-text-1 focus:outline-none focus:border-cyan-400/60';

export const Legend: React.FC<{ legend: EnvLegend; testId?: string }> = ({ legend, testId }) => {
  if (legend.type === 'ramp') {
    const s = legend.stops;
    return (
      <div className="space-y-0.5" data-testid={testId}>
        <p className="text-meta text-text-2">{legend.label}</p>
        <div className="h-2.5 rounded-sm border border-white/10" style={{ background: rampCss(s) }} aria-hidden />
        <div className="flex justify-between text-meta text-text-3 tabular-nums"><span>≤ {s[0].value}</span><span>{legend.unit}</span><span>≥ {s[s.length - 1].value}</span></div>
      </div>
    );
  }
  return (
    <ul className="grid grid-cols-2 gap-x-3 gap-y-0.5" data-testid={testId}>
      {legend.items.map(i => (
        <li key={i.label} className="flex items-center gap-1.5 text-meta text-text-2">
          <span className={legend.type === 'line' ? 'inline-block h-0.5 w-3' : 'inline-block h-2.5 w-2.5 rounded-sm'} style={{ background: i.color }} aria-hidden />{i.label}
        </li>
      ))}
    </ul>
  );
};

const StatusLine: React.FC<{ l: EnvDataLayer; variant: string | null }> = ({ l, variant }) => {
  if (l.status === 'available') return <DataStatus name={l.name} value={envDataStatus(l, variant)} />;
  const Icon = l.status === 'rejected' ? OctagonX : l.status === 'blocked' ? Ban : CircleHelp;
  return (
    <p className="text-meta flex items-start gap-1" style={{ color: l.status === 'missing' ? 'var(--unknown, #9AA4B2)' : 'var(--warn, #E8B04A)' }}
      data-testid={`env-data-status-${l.id}`} data-status={l.status}>
      <Icon size={11} aria-hidden className="mt-0.5 shrink-0" /><span><span className="font-semibold">{STATUS_LABEL[l.status]}</span> · {l.status_reason}</span>
    </p>
  );
};

export const EnvDataRow: React.FC<{ l: EnvDataLayer }> = ({ l }) => {
  const st = useEnvDataOverlayStore(s => s.overlays[l.id]);
  const status = st?.status ?? 'off';
  const on = status === 'shown' || status === 'loading';
  const variant = st?.variant ?? (l.variants[0]?.id ?? null);
  const legend = legendOf(l, variant);
  const toggle = hasMapToggle(l);
  return (
    <li className="rounded-md border border-border px-2 py-1.5 space-y-1" data-testid={`env-data-${l.id}`} data-status={l.status} data-shown={on ? 'true' : 'false'}>
      <div className="flex items-start gap-2">
        <div className="min-w-0 flex-1 space-y-0.5">
          <p className="text-body text-text-1 leading-snug">{l.name}</p>
          <StatusLine l={l} variant={variant} />
          {l.status === 'available' && (
            <p className="text-meta text-text-3" data-testid={`env-data-class-${l.id}`}>{classLine(l)}{l.vintage_note ? ` · ${l.vintage_note}` : ''}</p>
          )}
        </div>
        {toggle && (
          <button type="button" className="uos-btn uos-btn-sm shrink-0" aria-pressed={on} aria-label={`${on ? 'Hide' : 'Show'} ${l.name} on the map`}
            data-testid={`env-data-toggle-${l.id}`} data-status={status} disabled={status === 'loading'} onClick={() => void setEnvDataVisible(l, !on)}>
            {status === 'loading' ? <Loader2 size={13} aria-hidden className="animate-spin" /> : on ? <Eye size={13} aria-hidden /> : <EyeOff size={13} aria-hidden />}
            {status === 'loading' ? 'Loading' : on ? 'Shown' : 'Show'}
          </button>
        )}
      </div>
      {l.status === 'available' && l.variants.length > 1 && (
        <label className="flex items-center gap-2 text-meta text-text-2">
          {l.id.startsWith('soil') ? 'Property' : 'Scene date'}
          <select className={selCls} value={variant ?? ''} data-testid={`env-data-variant-${l.id}`} aria-label={`${l.name}: variant`}
            onChange={e => void setEnvDataVariant(l, e.target.value)}>
            {l.variants.map(v => <option key={v.id} value={v.id} disabled={!v.available}>{v.label}{v.available ? '' : ' (not on disk)'}</option>)}
          </select>
        </label>
      )}
      {on && legend && <Legend legend={legend} testId={`env-data-legend-${l.id}`} />}
      {status === 'error' && <p className="text-meta text-warn" role="status" data-testid={`env-data-error-${l.id}`}>Could not draw: {st?.error}</p>}
      {status === 'shown' && st?.message && (
        <p className="text-meta text-text-2" data-testid={`env-data-info-${l.id}`}>{st.message} Absence on the map proves nothing.</p>
      )}
      {on && l.attribution && <p className="text-meta text-text-3">{l.attribution}</p>}
      <Disclosure summary={l.status === 'available' ? 'Limitations & provenance' : 'Details'}>
        <p className="text-meta text-text-2">{l.limitations}</p>
        <p className="text-meta text-text-3 mt-1">Source: {l.source} · {l.publisher}</p>
        <p className="text-meta text-text-3">Licence: {l.licence_url ? <a className="uos-link" href={l.licence_url} target="_blank" rel="noreferrer">{l.licence}</a> : l.licence}</p>
        {l.processing && (
          <p className="text-meta text-text-3 break-all" data-testid={`env-data-processing-${l.id}`}>
            Pipeline {l.processing.pipeline ?? 'UNKNOWN'} @ {(l.processing.git_commit ?? 'UNKNOWN').slice(0, 10)} · run {l.processing.run_at ?? 'UNKNOWN'}
            {l.processing.file ? ` · ${l.processing.file} sha256 ${(l.processing.sha256 ?? 'UNKNOWN').slice(0, 16)}…` : ''}
          </p>
        )}
      </Disclosure>
    </li>
  );
};

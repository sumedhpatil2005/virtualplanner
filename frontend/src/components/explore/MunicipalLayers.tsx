import React, { useEffect, useState } from 'react';
import { Eye, EyeOff, Loader2, X } from 'lucide-react';
import { infraApi, type InfraCatalogue, type InfraLayer } from '../../lib/infraApi';
import { inspectorRows, orderLayers, colorOf, featuresText } from './municipalModel';
import { setMuniLayerVisible, useMuniStore } from './municipalOverlay';

/**
 * Explore layer-tree groups "Municipal infrastructure (PMC via OpenCity)" and "Buildings (OSM + Microsoft + Google)",
 * plus the Census 2011 table listed as not mappable. Data: GET /api/infra/layers; features per view, capped.
 */
function useInfraCatalogue(): { cat: InfraCatalogue | null; error: string | null; retry: () => void } {
  const [cat, setCat] = useState<InfraCatalogue | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [n, setN] = useState(0);
  useEffect(() => {
    let live = true;
    setError(null);
    infraApi.catalogue().then(c => { if (live) setCat(c); }).catch(e => { if (live) setError(e instanceof Error ? e.message : String(e)); });
    return () => { live = false; };
  }, [n]);
  return { cat, error, retry: () => setN(x => x + 1) };
}

const LayerRow: React.FC<{ l: InfraLayer }> = ({ l }) => {
  const st = useMuniStore(s => s.layers[l.id]);
  const on = st?.status === 'shown' || st?.status === 'loading';
  const busy = st?.status === 'loading';
  return (
    <li>
      <button type="button" className="uos-row w-full text-left" aria-pressed={on} aria-label={`${on ? 'Hide' : 'Show'} ${l.title}`} data-testid={`explore-muni-${l.id}`}
        onClick={() => void setMuniLayerVisible(l, !on)} disabled={!l.available}>
        {busy ? <Loader2 size={14} aria-hidden className="animate-spin text-text-2" /> : on ? <Eye size={14} aria-hidden className="text-accent" /> : <EyeOff size={14} aria-hidden className="text-text-3" />}
        <span className="inline-block h-2.5 w-2.5 rounded-sm shrink-0" style={{ background: colorOf(l.id) }} aria-hidden />
        <span className={`flex-1 min-w-0 text-label break-words ${on ? 'text-text-1' : 'text-text-2'}`}>{l.title}</span>
        {!l.active && <span className="text-meta text-text-3">version</span>}
        <span className="text-meta text-text-3 tabular-nums shrink-0" title="Features in the whole layer">{featuresText(l.feature_count)}</span>
      </button>
      {st?.status === 'shown' && st.line && <p className="pl-7 text-meta text-text-3" data-testid={`explore-muni-${l.id}-status`}>{st.line}</p>}
      {st?.status === 'error' && <p className="pl-7 text-meta text-fail" role="status">{st.error}</p>}
    </li>
  );
};

export const MunicipalLayerGroups: React.FC = () => {
  const { cat, error, retry } = useInfraCatalogue();
  if (error) return (
    <p className="text-meta text-fail" role="status" data-testid="explore-muni-error">Municipal layers could not be loaded: {error}{' '}
      <button type="button" className="uos-link" onClick={retry}>Retry</button></p>
  );
  if (!cat) return <p className="text-meta text-text-3">Loading municipal layers…</p>;
  if (!cat.index.available) return <p className="text-meta text-text-3" data-testid="explore-muni-unavailable">Municipal infrastructure: not available ({cat.index.reason}).</p>;
  return (
    <>
      {cat.groups.map(g => (
        <section key={g.label} aria-label={g.label} data-testid="explore-muni-group">
          <h4 className="text-meta font-semibold uppercase tracking-wide text-text-3 mb-0.5">{g.label}</h4>
          {orderLayers(g.layers).map(sg => (
            <div key={sg.subgroup}>
              {g.layers.length > 1 && <p className="text-meta text-text-3 mt-1">{sg.subgroup}</p>}
              <ul>{sg.layers.map(l => <LayerRow key={l.id} l={l} />)}</ul>
            </div>
          ))}
          {g.label.startsWith('Municipal') && (
            <p className="text-meta text-text-3">Records as published by PMC (via OpenCity), at most {cat.feature_cap.toLocaleString()} features per layer per view. Licence statements conflict: treated as non-commercial, credit OpenCity + PMC. Absence of a record is not evidence.</p>
          )}
          {g.label.startsWith('Buildings') && (
            <p className="text-meta text-text-3">Colours: OSM (observed, volunteer-mapped) · Google · Microsoft (inferred, ML). Heights UNKNOWN unless OSM-tagged. Loads at street scale only.</p>
          )}
        </section>
      ))}
      <section aria-label="Population (historical)" data-testid="explore-population">
        <h4 className="text-meta font-semibold uppercase tracking-wide text-text-3 mb-0.5">Population (historical)</h4>
        {cat.population.available
          ? <>
              <p className="text-label text-text-2">{cat.population.title}: {cat.population.wards} census-ward rows, {cat.population.total_population?.toLocaleString()} people (2011). <span className="text-warn">Not mappable</span> — listed only:</p>
              <ul className="list-disc pl-5 text-meta text-text-3">{cat.population.not_mappable_reasons?.map((r, i) => <li key={i}>{r}</li>)}</ul>
            </>
          : <p className="text-meta text-text-3">{cat.population.reason}</p>}
      </section>
    </>
  );
};

/** Attribute inspector for a clicked municipal / building feature. */
export const MunicipalInspector: React.FC = () => {
  const sel = useMuniStore(s => s.inspected);
  const inspect = useMuniStore(s => s.inspect);
  if (!sel) return null;
  const { provenance, attributes } = inspectorRows(sel.layer, sel.props);
  const tone = (t?: string) => (t === 'unknown' ? 'text-text-3 italic' : t === 'warn' ? 'text-warn' : 'text-text-1');
  return (
    <div className="space-y-2" data-testid="explore-muni-inspector">
      <div className="flex items-start gap-2">
        <p className="flex-1 text-body text-text-1 font-medium">{sel.layer.title} · feature {String(sel.props._ext_id ?? sel.props._fid)}</p>
        <button type="button" aria-label="Close inspector" className="text-text-3 hover:text-text-1" onClick={() => inspect(null)}><X size={14} aria-hidden /></button>
      </div>
      <dl className="grid grid-cols-[auto_1fr] gap-x-3 gap-y-0.5 text-label">
        {provenance.map(r => <React.Fragment key={r.label}><dt className="text-text-2">{r.label}</dt><dd className={`${tone(r.tone)} break-words`}>{r.value}</dd></React.Fragment>)}
      </dl>
      {attributes.length > 0 && <p className="text-meta text-text-3">Attributes as published{sel.layer.id === 'sewer' ? ' (levels are DESIGN values, unverified)' : ''}; a unit is shown only where the schema states it.</p>}
      {attributes.length > 0 && (
        <dl className="grid grid-cols-[auto_1fr] gap-x-3 gap-y-0.5 text-label border-t border-border pt-1.5">
          {attributes.map(r => <React.Fragment key={r.label}><dt className="text-text-2">{r.label}</dt><dd className={`${tone(r.tone)} break-words tabular-nums`}>{r.value}</dd></React.Fragment>)}
        </dl>
      )}
    </div>
  );
};

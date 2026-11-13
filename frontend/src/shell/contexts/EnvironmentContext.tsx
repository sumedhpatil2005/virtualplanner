import React, { useEffect, useState } from 'react';
import { CircleCheck, CircleHelp, Loader2, RefreshCw } from 'lucide-react';
import { API_BASE } from '../../lib/api';
import { PanelSection } from '../../components/ui/Panel';
import { Disclosure } from '../../components/ui/Disclosure';
import { useShellStore } from '../useShellStore';

interface IndexStatus { available: boolean; capabilities?: string[]; categories?: string[]; source?: string | null; dataTimestamp?: string | null }
interface FeasibilityStatus { osmIndex: IndexStatus; layers: IndexStatus }

/**
 * Constraint layers the feasibility screening actually reads (backend/api/feasibility_router.py site_data):
 * buildings, metro, roads from the local OSM index; water, heritage, trees, railway from the feasibility layers.
 */
const CONSTRAINT_LAYERS: { key: string; label: string; from: 'osmIndex' | 'layers' }[] = [
  { key: 'water', label: 'Water bodies', from: 'layers' },
  { key: 'heritage', label: 'Heritage sites', from: 'layers' },
  { key: 'buildings', label: 'Buildings', from: 'osmIndex' },
  { key: 'metro', label: 'Metro', from: 'osmIndex' },
  { key: 'railway', label: 'Railway', from: 'layers' },
  { key: 'trees', label: 'Trees', from: 'layers' },
  { key: 'roads', label: 'Roads', from: 'osmIndex' },
];

/** Domains with no dataset in UrbanOS (UX_ARCHITECTURE §8): shown as unknown, never as "no risk". */
const NOT_IMPORTED = ['Flood extent / depth', 'Drainage network', 'Groundwater', 'Soil', 'Geology', 'Air quality', 'Noise', 'Urban heat', 'Green cover (beyond OSM trees)'];

export const EnvironmentContext: React.FC = () => {
  const [status, setStatus] = useState<FeasibilityStatus | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [loading, setLoading] = useState(false);
  const setWorkspace = useShellStore(s => s.setWorkspace);

  const load = () => {
    setLoading(true); setError(null);
    fetch(`${API_BASE}/api/feasibility/status`)
      .then(r => (r.ok ? r.json() : Promise.reject(new Error(`${r.status} ${r.statusText}`))))
      .then((j: FeasibilityStatus) => setStatus(j))
      .catch((e: Error) => setError(e.message || 'Backend unreachable'))
      .finally(() => setLoading(false));
  };
  useEffect(load, []);

  return (
    <div className="space-y-5">
      <PanelSection title="Constraint layers used by feasibility screening"
        aside={<button type="button" onClick={load} className="uos-link inline-flex items-center gap-1" aria-label="Recheck data status"><RefreshCw size={12} aria-hidden />Recheck</button>}>
        {loading && !status && <p className="text-label text-text-2 flex items-center gap-2"><Loader2 size={14} className="animate-spin" aria-hidden />Checking…</p>}
        {error && <p className="text-label text-warn" role="status">Data status unavailable ({error}). Every layer below is Unknown until the backend answers.</p>}
        <ul className="space-y-1" data-testid="environment-layers">
          {CONSTRAINT_LAYERS.map(l => {
            const src = status?.[l.from];
            const cats = l.from === 'osmIndex' ? src?.capabilities : src?.categories;
            const ok = !!src?.available && !!cats?.includes(l.key);
            return (
              <li key={l.key} className="uos-row" data-available={ok ? 'true' : 'false'}>
                {ok ? <CircleCheck size={16} aria-hidden className="text-measured shrink-0" /> : <CircleHelp size={16} aria-hidden className="text-unknown shrink-0" />}
                <span className="min-w-0 flex-1">
                  <span className="block text-body text-text-1">{l.label}</span>
                  <span className="block text-meta text-text-2">
                    {ok ? `Available · ${src?.source ?? 'source not recorded'}${src?.dataTimestamp ? ` · data ${src.dataTimestamp.slice(0, 10)}${/Z$|\+00:?00$/.test(src.dataTimestamp) ? ' UTC' : ''}` : ''} · ODbL` : 'Not imported · Unknown'}
                  </span>
                </span>
              </li>
            );
          })}
        </ul>
        <p className="text-meta text-text-3">Available means the dataset is built locally; whether it covers a given site is checked when a proposal is screened (Design → select a road or flyover → Feasibility).</p>
      </PanelSection>
      <PanelSection title="Emissions">
        <p className="text-label text-text-2">Fuel and emissions are estimated per study in Simulate (Details → Fuel and emissions). They are derived from the traffic model, which fails validation (TAG M3.1, docs/ENGINEERING_VALIDATION.md).</p>
        <button type="button" className="uos-btn uos-btn-sm" onClick={() => setWorkspace('simulate')}>Open Simulate</button>
      </PanelSection>
      <PanelSection title="Not imported">
        <ul className="space-y-1" data-testid="environment-unknown">
          {NOT_IMPORTED.map(d => (
            <li key={d} className="flex items-center gap-2 text-label text-text-2"><CircleHelp size={14} aria-hidden className="text-unknown shrink-0" />{d}: Not imported · Unknown</li>
          ))}
        </ul>
      </PanelSection>
      <Disclosure>
        <p className="text-label text-text-2">Status comes from GET /api/feasibility/status (local OSM index capabilities and feasibility layer categories). OpenStreetMap data is licensed ODbL (openstreetmap.org/copyright). No import path exists yet for the domains listed as not imported.</p>
      </Disclosure>
    </div>
  );
};

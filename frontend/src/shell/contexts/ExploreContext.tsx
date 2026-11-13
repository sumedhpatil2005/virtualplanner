import React, { useEffect, useMemo, useState } from 'react';
import { Eye, EyeOff, Loader2, Search, X } from 'lucide-react';
import { MetricTile } from '../../components/ui/MetricTile';
import { PanelSection } from '../../components/ui/Panel';
import { Disclosure } from '../../components/ui/Disclosure';
import { CertaintyBadge } from '../../components/ui/badges/CertaintyBadge';
import { useEngineObjects } from '../useEngineObjects';
import { useSelectedId } from '../../hooks/useAppMode';
import { engineInstance } from '../../engine/TwinCityEngine';
import type { Layer } from '../../engine/layers/LayerManager';
import { filterObjectsForScenario } from '../../engine/scenarios/scenarioFilter';
import { cityStats, groupLayers, osmIdOf, searchObjects, summarise, typeLabel } from '../../components/explore/exploreModel';
import { OVERLAY_STYLE, setOverlayVisible, useEnvOverlayStore } from '../../components/environment/constraintOverlay';
import type { OverlayKey } from '../../components/environment/envCatalogue';

function useLayers(): Layer[] {
  const [layers, setLayers] = useState<Layer[]>(() => engineInstance.layers.getAll());
  useEffect(() => {
    const unsub = engineInstance.layers.onChange(setLayers);
    setLayers(engineInstance.layers.getAll());
    return unsub;
  }, []);
  return layers;
}

const ToggleRow: React.FC<{ label: string; on: boolean; busy?: boolean; onToggle: () => void; testId: string; swatch?: string; note?: string }> = ({ label, on, busy, onToggle, testId, swatch, note }) => (
  <li>
    <button type="button" className="uos-row w-full text-left" aria-pressed={on} aria-label={`${on ? 'Hide' : 'Show'} ${label}`} data-testid={testId} onClick={onToggle} disabled={busy}>
      {busy ? <Loader2 size={14} aria-hidden className="animate-spin text-text-2" /> : on ? <Eye size={14} aria-hidden className="text-accent" /> : <EyeOff size={14} aria-hidden className="text-text-3" />}
      {swatch && <span className="inline-block h-2.5 w-2.5 rounded-sm" style={{ background: swatch }} aria-hidden />}
      <span className={`flex-1 text-label ${on ? 'text-text-1' : 'text-text-2'}`}>{label}</span>
      {note && <span className="text-meta text-text-3">{note}</span>}
    </button>
  </li>
);

const LayerTree: React.FC<{ proposals: number }> = ({ proposals }) => {
  const layers = useLayers();
  const overlays = useEnvOverlayStore(s => s.overlays);
  const groups = groupLayers(layers);
  return (
    <div className="space-y-3" data-testid="explore-layer-tree">
      {groups.map(g => (
        <section key={g.id} aria-label={g.label}>
          <h4 className="text-meta font-semibold uppercase tracking-wide text-text-3 mb-0.5">{g.label}</h4>
          <ul>
            {g.layers.map(l => (
              <ToggleRow key={l.id} label={l.name} on={l.visible} testId={`explore-layer-${l.id}`} onToggle={() => engineInstance.layers.setVisibility(l.id, !l.visible)}
                note={l.id === 'terrain' ? 'needs ion token' : undefined} />
            ))}
          </ul>
        </section>
      ))}
      <section aria-label="Environment">
        <h4 className="text-meta font-semibold uppercase tracking-wide text-text-3 mb-0.5">Environment</h4>
        <ul>
          {(Object.keys(OVERLAY_STYLE) as OverlayKey[]).map(k => {
            const st = overlays[k];
            const on = st.status === 'shown' || st.status === 'loading';
            return <ToggleRow key={k} label={OVERLAY_STYLE[k].label} swatch={OVERLAY_STYLE[k].css} on={on} busy={st.status === 'loading'} testId={`explore-overlay-${k}`}
              note={st.status === 'shown' ? `${st.count ?? 0}` : st.status === 'error' ? 'failed' : undefined} onToggle={() => void setOverlayVisible(k, !on)} />;
          })}
        </ul>
        <p className="text-meta text-text-3">Other environmental data: see Environment (most is not imported, UNKNOWN).</p>
      </section>
      <section aria-label="Proposals">
        <h4 className="text-meta font-semibold uppercase tracking-wide text-text-3 mb-0.5">Proposals</h4>
        <p className="text-label text-text-2" data-testid="explore-proposals">{proposals === 0 ? 'No proposed objects in this alternative.' : `${proposals.toLocaleString()} proposed or changed object${proposals === 1 ? '' : 's'} in this alternative (shown on their own layers above).`}</p>
      </section>
    </div>
  );
};

const ObjectSearch: React.FC<{ objects: ReturnType<typeof useEngineObjects> }> = ({ objects }) => {
  const [q, setQ] = useState('');
  const hits = useMemo(() => searchObjects(objects, q), [objects, q]);
  const go = (id: string) => {
    engineInstance.selection.selectSingle(id);
    engineInstance.flyToObject(id);
  };
  return (
    <div className="space-y-1.5">
      <label className="flex items-center gap-2 rounded-md border border-border bg-surface-2 px-2 h-9 focus-within:border-accent">
        <Search size={14} aria-hidden className="text-text-3" />
        <input type="search" value={q} onChange={e => setQ(e.target.value)} placeholder="Name or OSM id" aria-label="Search city objects by name or OSM id"
          data-testid="explore-search" className="flex-1 bg-transparent text-body text-text-1 outline-none placeholder:text-text-3 min-w-0" />
        {q && <button type="button" aria-label="Clear search" onClick={() => setQ('')} className="text-text-3 hover:text-text-1"><X size={14} aria-hidden /></button>}
      </label>
      {q.trim().length >= 2 && (
        hits.length === 0
          ? <p className="text-meta text-text-3" role="status">No loaded object matches. Only the imported area is searchable.</p>
          : <ul className="max-h-56 overflow-y-auto" data-testid="explore-search-results">
              {hits.map(o => {
                const osm = osmIdOf(o);
                return (
                  <li key={o.id}>
                    <button type="button" className="uos-row w-full text-left" onClick={() => go(o.id)} data-testid="explore-search-hit">
                      <span className="min-w-0 flex-1">
                        <span className="block text-label text-text-1 truncate">{o.name || '(unnamed)'}</span>
                        <span className="block text-meta text-text-3">{typeLabel(o.type)}{osm !== null ? ` · OSM ${osm}` : ''}</span>
                      </span>
                    </button>
                  </li>
                );
              })}
            </ul>
      )}
    </div>
  );
};

const SelectedSummary: React.FC = () => {
  const id = useSelectedId();
  useEngineObjects(); // re-render on object edits
  const o = id ? engineInstance.objects.getById(id) : undefined;
  if (!o) return <p className="text-label text-text-2">Click an object on the map, or search above.</p>;
  const s = summarise(o);
  return (
    <div className="space-y-1.5" data-testid="explore-selected">
      <p className="text-body text-text-1 font-medium truncate">{o.name || '(unnamed)'}</p>
      <p className="text-meta text-text-2">{s.type} · source: {s.source}</p>
      {s.rows.length > 0 && (
        <dl className="grid grid-cols-[1fr_auto] gap-x-3 gap-y-0.5 text-label tabular-nums">
          {s.rows.map(r => (
            <React.Fragment key={r.label}>
              <dt className="text-text-2">{r.label}</dt>
              <dd className="text-right text-text-1 flex items-center justify-end gap-1.5">{r.value}{r.certainty && <CertaintyBadge certainty={r.certainty} compact />}</dd>
            </React.Fragment>
          ))}
        </dl>
      )}
      <button type="button" className="uos-btn uos-btn-sm" onClick={() => engineInstance.flyToObject(o.id)}>Fly to</button>
    </div>
  );
};

/** Explore: grouped layer tree, object search, selected-object summary and stats of the loaded city. */
export const ExploreContext: React.FC = () => {
  const all = useEngineObjects();
  const alt = engineInstance.scenarios.getActiveScenario();
  // useEngineObjects re-renders on object / alternative changes; the filter and stats are O(n) and cheap
  const objects = filterObjectsForScenario(all, engineInstance.scenarios.getActiveScenarioId());
  const stats = cityStats(objects);
  return (
    <div className="space-y-5">
      <PanelSection title="Find">
        <ObjectSearch objects={objects} />
      </PanelSection>
      <PanelSection title="Selected">
        <SelectedSummary />
      </PanelSection>
      <PanelSection title="Loaded city" aside={alt?.name}>
        <div className="grid grid-cols-3 gap-2" data-testid="explore-counts">
          <MetricTile label="Road km" value={stats.roadKm.toLocaleString(undefined, { maximumFractionDigits: 1 })} />
          <MetricTile label="Buildings" value={stats.buildings.toLocaleString()} />
          <MetricTile label="Junctions" value={stats.junctions.toLocaleString()} />
        </div>
        <p className="text-meta text-text-3 flex flex-wrap items-center gap-1">Computed from the objects loaded in this alternative ({stats.roads.toLocaleString()} road pieces). Junctions: {stats.networkNodes.toLocaleString()} road-network nodes where 3+ arms meet <CertaintyBadge certainty="estimated" compact note="Derived from shared road vertices, not a junction inventory." /> plus {stats.placedJunctions.toLocaleString()} placed. Areas not imported are not counted.</p>
      </PanelSection>
      <PanelSection title="Layers">
        <LayerTree proposals={stats.proposals} />
      </PanelSection>
      <Disclosure>
        <p className="text-label text-text-2">Road km sums the great-circle length of every loaded road centreline (each carriageway drawn separately counts separately). Network nodes: vertices shared by two or more road pieces (matched at about 0.1 m) where at least three arms meet; flyovers crossing without a shared vertex are not counted. Search matches object names and OpenStreetMap ids of loaded objects only. Toggles change the existing layer registry; environment overlays draw GET /api/feasibility/site-data.</p>
      </Disclosure>
    </div>
  );
};

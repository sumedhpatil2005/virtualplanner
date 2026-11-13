import React, { useEffect, useState, useSyncExternalStore } from 'react';
import { CircleHelp, Eye, EyeOff, Loader2, RefreshCw, ScanSearch, Wind } from 'lucide-react';
import { PanelSection } from '../../components/ui/Panel';
import { Disclosure } from '../../components/ui/Disclosure';
import { EmptyState } from '../../components/ui/EmptyState';
import { DataStatus } from '../../components/ui/badges/DataStatus';
import { TrustBadge } from '../../components/ui/badges/TrustBadge';
import { FeasibilityPanel } from '../../components/FeasibilityPanel';
import { coordinationApi, type EnvironmentLayer } from '../../lib/coordinationApi';
import { dataStatusOf, MAP_TOGGLES } from '../../components/environment/envCatalogue';
import { envDataApi, type EnvDataLayer } from '../../lib/envDataApi';
import { mergeCatalogue } from '../../components/environment/envDataModel';
import { EnvDataRow } from '../../components/environment/EnvDataRow';
import { AirQualityPanel, LandcoverAreasPanel, RainfallPanel } from '../../components/environment/EnvDataPanels';
import { OVERLAY_STYLE, setOverlayVisible, useEnvOverlayStore } from '../../components/environment/constraintOverlay';
import { useSimulationMode } from '../../hooks/useSimulationMode';
import { useSelectedId } from '../../hooks/useAppMode';
import { SelectionDetailsButton } from '../SelectionDetailsButton';
import { engineInstance } from '../../engine/TwinCityEngine';
import { isProposalObject } from '../../engine/feasibility/proposal';
import { hourLabel } from '../../engine/simulation/timeOfDay';
import { useShellStore } from '../useShellStore';

const fmt = (v: number, d = 0) => v.toLocaleString(undefined, { maximumFractionDigits: d, minimumFractionDigits: d });

/** Engine layer visibility, re-rendering on change (LayerManager registry). */
function useEngineLayerVisible(id: string): boolean {
  return useSyncExternalStore(
    cb => engineInstance.layers.onChange(() => cb()),
    () => engineInstance.layers.getAll().find(l => l.id === id)?.visible ?? false,
  );
}

const EngineLayerToggle: React.FC<{ layerId: string; label: string }> = ({ layerId, label }) => {
  const visible = useEngineLayerVisible(layerId);
  return (
    <button type="button" className="uos-btn uos-btn-sm shrink-0" aria-pressed={visible} aria-label={`${visible ? 'Hide' : 'Show'} ${label} on the map`}
      data-testid={`env-toggle-${layerId}`} onClick={() => engineInstance.layers.setVisibility(layerId, !visible)}>
      {visible ? <Eye size={13} aria-hidden /> : <EyeOff size={13} aria-hidden />}{visible ? 'Shown' : 'Show'}
    </button>
  );
};

const OverlayToggle: React.FC<{ k: keyof typeof OVERLAY_STYLE }> = ({ k }) => {
  const st = useEnvOverlayStore(s => s.overlays[k]);
  const on = st.status === 'shown' || st.status === 'loading';
  return (
    <button type="button" className="uos-btn uos-btn-sm shrink-0" aria-pressed={on} aria-label={`${on ? 'Hide' : 'Show'} ${OVERLAY_STYLE[k].label} on the map`}
      data-testid={`env-toggle-${k}`} data-status={st.status} disabled={st.status === 'loading'} onClick={() => void setOverlayVisible(k, !on)}>
      {st.status === 'loading' ? <Loader2 size={13} aria-hidden className="animate-spin" /> : on ? <Eye size={13} aria-hidden /> : <EyeOff size={13} aria-hidden />}
      {st.status === 'loading' ? 'Loading' : on ? 'Shown' : 'Show'}
    </button>
  );
};

const OverlayNote: React.FC<{ k: keyof typeof OVERLAY_STYLE }> = ({ k }) => {
  const st = useEnvOverlayStore(s => s.overlays[k]);
  if (st.status === 'error') return <p className="text-meta text-warn" role="status" data-testid={`env-overlay-error-${k}`}>Could not draw: {st.error}</p>;
  if (st.status !== 'shown') return null;
  return (
    <p className="text-meta text-text-2 flex items-center gap-1.5" data-testid={`env-overlay-info-${k}`}>
      <span className="inline-block h-2.5 w-2.5 rounded-sm" style={{ background: OVERLAY_STYLE[k].css }} aria-hidden />
      {st.count?.toLocaleString()} features drawn for the {st.bboxFrom} box. Absence on the map proves nothing.
    </p>
  );
};

const LayerRow: React.FC<{ l: EnvironmentLayer }> = ({ l }) => {
  const t = MAP_TOGGLES[l.id];
  const available = l.status === 'available';
  return (
    <li className="rounded-md border border-border px-2 py-1.5 space-y-1" data-testid={`env-layer-${l.id}`} data-available={available ? 'true' : 'false'}>
      <div className="flex items-start gap-2">
        <div className="min-w-0 flex-1">
          <p className="text-body text-text-1 leading-snug">{l.name}</p>
          <DataStatus name={l.name} value={dataStatusOf(l)} />
          {available && l.feature_count != null && <p className="text-meta text-text-3">{l.feature_count.toLocaleString()} features in the local file</p>}
        </div>
        {available && t?.kind === 'overlay' && <OverlayToggle k={t.key} />}
        {available && t?.kind === 'engine' && <EngineLayerToggle layerId={t.layerId} label={l.name} />}
      </div>
      {available && t?.kind === 'overlay' && <OverlayNote k={t.key} />}
      {(l.limitations || (!available && l.recommended_sources.length > 0)) && (
        <Disclosure summary={available ? 'Limitations' : 'Recommended source'}>
          {l.limitations && <p className="text-meta text-text-2">{l.limitations}</p>}
          {!available && l.recommended_sources.map(r => (
            <div key={r.name} className="text-meta text-text-2 mt-1">
              <p className="text-text-1">{r.url ? <a className="uos-link" href={r.url} target="_blank" rel="noreferrer">{r.name}</a> : r.name}{r.publisher ? ` · ${r.publisher}` : ''}</p>
              <p>Licence: {r.licence || 'UNKNOWN'}{r.notes ? ` · ${r.notes}` : ''}</p>
            </div>
          ))}
          {!available && <p className="text-meta text-text-3 mt-1">No import path in UrbanOS yet for this dataset.</p>}
        </Disclosure>
      )}
    </li>
  );
};

/** Latest real emissions result in this session (the Simulate analysis); empty when none has run. */
const EmissionsSummary: React.FC = () => {
  const sim = useSimulationMode();
  const setWorkspace = useShellStore(s => s.setWorkspace);
  const r = sim.analysis.output?.result;
  const e = r?.emissions, a = r?.areaEmissions;
  if (!e && !a) {
    return (
      <EmptyState icon={Wind} title="No emissions result in this session"
        action={{ label: 'Open Simulate', onClick: () => setWorkspace('simulate'), 'data-testid': 'env-open-simulate' }}>
        Emissions are estimated from a traffic analysis of a selected road. None has run yet.
      </EmptyState>
    );
  }
  return (
    <div className="space-y-1.5" data-testid="env-emissions-summary">
      <TrustBadge trust="fails_validation" label="Traffic input fails validation (TAG M3.1)" testId="trust-env-emissions" />
      <p className="text-meta text-text-2">{sim.section?.name ?? 'Study road'}{sim.analysis.hour != null ? ` · ${hourLabel(sim.analysis.hour)}` : ''} · estimated</p>
      {e && (
        <dl className="grid grid-cols-2 gap-x-3 gap-y-0.5 text-label tabular-nums">
          <dt className="text-text-2">Fuel</dt><dd className="text-right text-text-1">{fmt(e.perHour.fuelL, 1)} L/h</dd>
          <dt className="text-text-2">CO₂</dt><dd className="text-right text-text-1">{fmt(e.perHour.co2G / 1000, 1)} kg/h</dd>
          <dt className="text-text-2">NOx</dt><dd className="text-right text-text-1">{fmt(e.perHour.noxG)} g/h</dd>
          <dt className="text-text-2">PM</dt><dd className="text-right text-text-1">{fmt(e.perHour.pmG, 1)} g/h</dd>
        </dl>
      )}
      {a && <p className="text-meta text-text-2 tabular-nums">Whole study area (ARAI cross-check): CO₂ {fmt(a.co2KgPerHour)} kg/h</p>}
      <p className="text-meta text-text-3">Neighbourhood of the studied road, per hour. Full breakdown: Simulate → drawer → Emissions.</p>
    </div>
  );
};

export const EnvironmentContext: React.FC = () => {
  const [layers, setLayers] = useState<EnvironmentLayer[] | null>(null);
  const [envData, setEnvData] = useState<EnvDataLayer[]>([]);
  const [envDataError, setEnvDataError] = useState<string | null>(null);
  const [note, setNote] = useState<string>('');
  const [error, setError] = useState<string | null>(null);
  const [loading, setLoading] = useState(false);
  const [screening, setScreening] = useState<string | null>(null);
  const selectedId = useSelectedId();
  const selected = selectedId ? engineInstance.objects.getById(selectedId) : undefined;
  const screenable = selected && isProposalObject(selected) ? selected : null;

  const load = () => {
    setLoading(true); setError(null);
    coordinationApi.environmentLayers()
      .then(j => { setLayers(j.layers); setNote(j.note); })
      .catch((e: Error) => setError(e.message || 'Backend unreachable'))
      .finally(() => setLoading(false));
    envDataApi.catalogue()
      .then(j => { setEnvData(j.layers); setEnvDataError(null); })
      .catch((e: Error) => setEnvDataError(e.message || 'Backend unreachable'));
  };
  useEffect(load, []);

  const screenObj = screening ? engineInstance.objects.getById(screening) : undefined;
  if (screenObj && isProposalObject(screenObj)) {
    return <div className="uos-embed-panel [&>div]:!w-full [&>div]:!rounded-none [&>div]:!border-0" data-testid="env-feasibility"><FeasibilityPanel obj={screenObj} onBack={() => setScreening(null)} /></div>;
  }

  const groups = layers ? mergeCatalogue(layers, envData) : [];
  const hasEnv = (id: string) => envData.some(l => l.id === id && l.status === 'available');
  return (
    <div className="space-y-5">
      <PanelSection title="Constraint screening">
        {screenable
          ? <div className="flex flex-wrap gap-2"><button type="button" className="uos-btn uos-btn-sm" data-testid="env-screen-proposal" onClick={() => setScreening(screenable.id)}><ScanSearch size={13} aria-hidden />Screen “{screenable.name || screenable.type}”</button><SelectionDetailsButton /></div>
          : <p className="text-label text-text-2" data-testid="env-screen-hint">Select a road, flyover or double-deck on the map to screen it against the constraint layers.</p>}
      </PanelSection>

      <PanelSection title="Emissions">
        <EmissionsSummary />
      </PanelSection>

      <PanelSection title="Environmental data"
        aside={<button type="button" onClick={load} className="uos-link inline-flex items-center gap-1" aria-label="Recheck data status"><RefreshCw size={12} aria-hidden />Recheck</button>}>
        {loading && !layers && <p className="text-label text-text-2 flex items-center gap-2"><Loader2 size={14} className="animate-spin" aria-hidden />Loading the catalogue…</p>}
        {error && <p className="text-label text-warn" role="status" data-testid="env-catalogue-error">Catalogue unavailable ({error}). Every environmental layer is UNKNOWN until the backend answers.</p>}
        {envDataError && <p className="text-label text-warn" role="status" data-testid="env-data-catalogue-error">Environment data catalogue unavailable ({envDataError}); real datasets are UNKNOWN until it answers.</p>}
        <div className="space-y-3" data-testid="environment-layers">
          {groups.map(g => (
            <section key={g.id} data-testid={`env-group-${g.id}`} aria-label={g.label}>
              <h4 className="text-meta font-semibold uppercase tracking-wide text-text-3 mb-1 flex justify-between">
                <span>{g.label}</span><span className="tabular-nums">{g.available}/{g.rows.length} available</span>
              </h4>
              {g.rows.length === 0
                ? <p className="text-meta text-text-3 flex items-center gap-1.5"><CircleHelp size={12} aria-hidden className="text-unknown" />No dataset catalogued · UNKNOWN</p>
                : <ul className="space-y-1.5">{g.rows.map(r => r.kind === 'coord' ? <LayerRow key={r.layer.id} l={r.layer} /> : <EnvDataRow key={r.layer.id} l={r.layer} />)}</ul>}
            </section>
          ))}
        </div>
      </PanelSection>

      {hasEnv('landcover_worldcover2021') && (
        <PanelSection title="Land cover areas">
          <LandcoverAreasPanel />
        </PanelSection>
      )}

      {(hasEnv('air_cpcb_caaqms') || hasEnv('rain_imd_025')) && (
        <PanelSection title="Stations & series">
          {hasEnv('air_cpcb_caaqms') && <Disclosure summary="Air quality — measured at stations" data-testid="env-air-disclosure"><AirQualityPanel /></Disclosure>}
          {hasEnv('rain_imd_025') && <Disclosure summary="Rainfall — IMD grid, CHIRPS, district" data-testid="env-rain-disclosure"><RainfallPanel /></Disclosure>}
        </PanelSection>
      )}

      <PanelSection title="Scene layers">
        <div className="flex items-center gap-2 text-label text-text-1"><span className="flex-1">Buildings (loaded city model)</span><EngineLayerToggle layerId="buildings" label="Buildings" /></div>
      </PanelSection>

      <Disclosure>
        <p className="text-label text-text-2">Catalogue: GET /api/coordination/environment-layers. Status of OSM-derived rows is computed on read from the local files; everything else is “Not imported — UNKNOWN” and is never treated as no risk. Water, heritage and railway are drawn from GET /api/feasibility/site-data (the features screening reads); metro and buildings toggle the existing engine layers. OpenStreetMap data © OpenStreetMap contributors, ODbL.
          Real datasets (land cover, Sentinel-2 indices, JRC surface water, DEM-derived streams/catchments, soil, tree census, air quality, rainfall): GET /api/env-data/catalogue; rasters are rendered by the backend for the camera view, vectors and trees come from capped bbox APIs (docs/urbanos/ENVIRONMENT_DATA.md). A covered “Not imported” row is replaced by the real dataset row.</p>
        {note && <p className="text-meta text-text-3 mt-1">{note}</p>}
      </Disclosure>
    </div>
  );
};

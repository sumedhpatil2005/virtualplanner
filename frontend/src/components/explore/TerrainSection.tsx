import React, { useEffect } from 'react';
import { Eye, EyeOff, Loader2 } from 'lucide-react';
import { engineInstance } from '../../engine/TwinCityEngine';
import { useSelectedId } from '../../hooks/useAppMode';
import { useEngineObjects } from '../../shell/useEngineObjects';
import { clearReadout, loadOverlayMeta, repPoint, sampleReadout, setCursorReadout, setTerrainOverlay, useTerrainOverlayStore, type Readout, type TerrainOverlayKey } from './terrainOverlay';

const LABEL: Record<TerrainOverlayKey, string> = { hillshade: 'Hillshade (DEM)', slope: 'Slope classes (DEM)' };
const WHY: Record<string, string> = { outside_coverage: 'outside DEM coverage', nodata: 'DEM nodata', error: 'terrain service unavailable' };
const fmt = (r: Readout | null, none: string) => !r ? none
  : r.status === 'loading' ? 'sampling…'
  : r.elevationM === null ? `UNKNOWN (${WHY[r.status] ?? r.status}) at ${r.lon.toFixed(5)}, ${r.lat.toFixed(5)}`
  : `${r.elevationM.toFixed(1)} m EGM2008 at ${r.lon.toFixed(5)}, ${r.lat.toFixed(5)}`;

/** Explore → Layers → Terrain: overlay toggles with legend + source/date, and elevation readout (cursor / selection). */
export const TerrainSection: React.FC = () => {
  const st = useTerrainOverlayStore();
  const selId = useSelectedId();
  useEffect(() => { void loadOverlayMeta(); }, []);
  useEngineObjects();   // re-render on object edits so a moved selection is re-sampled
  const selObj = selId ? engineInstance.objects.getById(selId) : undefined;
  const selPt = selObj ? repPoint(selObj as { coordinates?: unknown }) : null;
  const selKey = selPt ? `${selPt[0].toFixed(7)},${selPt[1].toFixed(7)}` : null;
  useEffect(() => {
    if (selKey) { const [lon, lat] = selKey.split(',').map(Number); void sampleReadout(lon, lat, 'selection'); }
    else clearReadout('selection');
  }, [selKey]);
  const m = st.meta;
  const slopeLegend = m && Array.isArray(m.overlays.slope.legend) ? m.overlays.slope.legend : [];
  return (
    <section aria-label="Terrain" data-testid="explore-terrain">
      <h4 className="text-meta font-semibold uppercase tracking-wide text-text-3 mb-0.5">Terrain (Copernicus DEM)</h4>
      <ul>
        {(['hillshade', 'slope'] as TerrainOverlayKey[]).map(k => {
          const s = st.shown[k], on = s === 'shown' || s === 'loading';
          return (
            <li key={k}>
              <button type="button" className="uos-row w-full text-left" aria-pressed={on} aria-label={`${on ? 'Hide' : 'Show'} ${LABEL[k]}`} data-testid={`explore-terrain-${k}`}
                onClick={() => void setTerrainOverlay(k, !on)} disabled={s === 'loading'}>
                {s === 'loading' ? <Loader2 size={14} aria-hidden className="animate-spin text-text-2" /> : on ? <Eye size={14} aria-hidden className="text-accent" /> : <EyeOff size={14} aria-hidden className="text-text-3" />}
                <span className={`flex-1 text-label ${on ? 'text-text-1' : 'text-text-2'}`}>{LABEL[k]}</span>
                {s === 'error' && <span className="text-meta text-text-3">failed</span>}
              </button>
            </li>
          );
        })}
        <li>
          <button type="button" className="uos-row w-full text-left" aria-pressed={st.readoutOn} data-testid="explore-terrain-readout" onClick={() => setCursorReadout(!st.readoutOn)}>
            {st.readoutOn ? <Eye size={14} aria-hidden className="text-accent" /> : <EyeOff size={14} aria-hidden className="text-text-3" />}
            <span className={`flex-1 text-label ${st.readoutOn ? 'text-text-1' : 'text-text-2'}`}>Elevation at cursor</span>
          </button>
        </li>
      </ul>
      {st.shown.slope === 'shown' && slopeLegend.length > 0 && (
        <div className="flex flex-wrap gap-x-2 gap-y-0.5 text-meta text-text-2 mt-1" data-testid="explore-terrain-legend">
          {slopeLegend.map(l => <span key={l.label} className="flex items-center gap-1"><span className="inline-block h-2.5 w-2.5 rounded-sm" style={{ background: `rgba(${l.rgba[0]},${l.rgba[1]},${l.rgba[2]},${(l.rgba[3] ?? 255) / 255})` }} aria-hidden />{l.label}</span>)}
        </div>
      )}
      {st.shown.hillshade === 'shown' && m && typeof m.overlays.hillshade.legend === 'string' && <p className="text-meta text-text-2 mt-1">{m.overlays.hillshade.legend}</p>}
      <dl className="grid grid-cols-[auto_1fr] gap-x-2 gap-y-0.5 text-meta mt-1 tabular-nums" data-testid="explore-terrain-values">
        <dt className="text-text-3">Selection</dt><dd className="text-text-1" data-testid="explore-terrain-selection">{selId ? fmt(st.selection, 'selected object has no plan position') : 'nothing selected'}</dd>
        <dt className="text-text-3">Cursor</dt><dd className="text-text-1" data-testid="explore-terrain-cursor">{st.readoutOn ? fmt(st.cursor, 'move the cursor over the map') : 'off'}</dd>
      </dl>
      <p className="text-meta text-text-3 mt-1" data-testid="explore-terrain-source">
        {m ? `${m.source}; ${m.version}${m.dataset_version_id ? ` (${m.dataset_version_id})` : ''}, processed ${m.processed_at}. ${m.warning}. Overlays: ${m.suitability}. Bilinear readout, EGM2008.`
          : st.metaError ? `Terrain service unavailable: ${st.metaError}. Elevation UNKNOWN.` : 'Loading terrain metadata…'}
        {st.error && m ? ` Last error: ${st.error}` : ''}
      </p>
    </section>
  );
};

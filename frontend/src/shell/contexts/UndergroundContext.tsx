import React from 'react';
import { Cable, CircleHelp, FlaskConical, TrainFrontTunnel } from 'lucide-react';
import { engineInstance } from '../../engine/TwinCityEngine';
import type { CityObject, UtilityObject } from '../../engine/objects/types';
import { PanelSection } from '../../components/ui/Panel';
import { EmptyState } from '../../components/ui/EmptyState';
import { Disclosure } from '../../components/ui/Disclosure';
import type { DrawerTab } from '../../components/ui/Drawer';
import { CertaintyBadge } from '../../components/ui/badges/CertaintyBadge';
import { useEngineObjects } from '../useEngineObjects';
import { useShellStore } from '../useShellStore';
import { lengthM } from './geo';
import { DEFAULT_DEPTH_M, UTILITY_LABEL, utilityCertainty } from './utilityCertainty';
import { ALIGNMENT_KIND_LABEL, alignmentProfile, worstCertainty } from '../../engine/underground/alignmentGeometry';
import { isAlignment } from '../../engine/underground/alignmentFactory';
import { undergroundView } from '../../engine/underground/UndergroundView';
import { undergroundRenderer } from '../../engine/underground/UndergroundRenderer';
import { useActiveAlignment } from '../../components/underground/common';
import { useUndergroundStore } from '../../components/underground/undergroundStore';
import { AlignmentEditor } from '../../components/underground/AlignmentForms';
import { ViewControls } from '../../components/underground/ViewControls';
import { ProfileView, CrossSectionView } from '../../components/underground/SectionViews';
import { SubsurfaceRecords } from '../../components/underground/SubsurfaceRecords';
import { ConflictCheck } from '../../components/underground/ConflictCheck';

const isUtility = (o: CityObject): o is UtilityObject => o.type === 'utility';

// ---- runtime: underground view while the workspace is open; alignments always drawn -----------------------------
let runtimeStarted = false;
/** Wires the globe view state to the workspace and keeps the 3D alignments in step with the model. Idempotent. */
export function startUndergroundRuntime() {
  if (runtimeStarted || typeof window === 'undefined') return;
  runtimeStarted = true;
  const viewer = () => engineInstance.getViewer?.() ?? null;
  const redraw = () => {
    const v = viewer();
    if (!v) return;
    undergroundRenderer.attach(v);
    const sel = engineInstance.selection.getSelection()[0] ?? null;
    undergroundRenderer.renderAlignments(engineInstance.objects.getAll().filter(isAlignment), sel);
  };
  const syncView = (ws: string) => { if (ws === 'underground') undergroundView.enter(viewer()); else undergroundView.leave(); };
  engineInstance.objects.onChange(redraw);
  engineInstance.scenarios.onChange(redraw);
  engineInstance.selection.onChange(redraw);
  useShellStore.subscribe((s, prev) => { if (s.workspace !== prev.workspace) syncView(s.workspace); });
  // The viewer is created after the shell module loads: catch up once it exists
  const wait = window.setInterval(() => {
    if (!viewer()) return;
    window.clearInterval(wait);
    redraw();
    syncView(useShellStore.getState().workspace);
  }, 250);
}

const CertaintyText: React.FC<{ level: 'hypothetical' | 'unknown'; why: string }> = ({ level, why }) => (
  <span className={`inline-flex items-center gap-1 text-meta font-medium ${level === 'unknown' ? 'text-unknown' : 'text-hypothetical'}`} title={why}>
    {level === 'unknown' ? <CircleHelp size={12} aria-hidden /> : <FlaskConical size={12} aria-hidden />}
    {level === 'unknown' ? 'Unknown' : 'Hypothetical'}
  </span>
);
export { CertaintyText };

const focus = (id: string) => { engineInstance.selection.selectSingle(id); engineInstance.flyToObject(id); };

/** The utility table for the bottom drawer (same data as the context list, with every column). */
export const UtilityTable: React.FC = () => {
  const utils = useEngineObjects(isUtility);
  if (utils.length === 0) return <p className="text-label text-text-2">No utilities in this alternative.</p>;
  return (
    <table className="uos-table" data-testid="utility-table">
      <thead><tr><th>Name</th><th>Type</th><th className="num">Depth (m)</th><th className="num">Length (m)</th><th className="num">Capacity</th><th>Certainty</th></tr></thead>
      <tbody>
        {utils.map(u => {
          const c = utilityCertainty(u);
          const len = lengthM(u.coordinates);
          return (
            <tr key={u.id} onClick={() => focus(u.id)} className="cursor-pointer">
              <td>{u.name || 'Utility'}</td>
              <td>{UTILITY_LABEL[u.utilityType] ?? u.utilityType}</td>
              <td className="num">{Number.isFinite(u.depth) ? u.depth.toFixed(1) : '—'}{u.depth === DEFAULT_DEPTH_M ? ' (default)' : ''}</td>
              <td className="num">{len == null ? '—' : Math.round(len).toLocaleString('en-IN')}</td>
              <td className="num" title="Capacity units as entered; no unit is defined in the model">{u.capacity}</td>
              <td><CertaintyText {...c} /></td>
            </tr>
          );
        })}
      </tbody>
    </table>
  );
};

/** Bottom-drawer tabs of the Underground workspace (registered in AppShell's DRAWER_TABS). */
export const UNDERGROUND_DRAWER_TABS: DrawerTab[] = [
  { id: 'profile', label: 'Profile', content: <ProfileView /> },
  { id: 'section', label: 'Cross-section', content: <CrossSectionView /> },
  { id: 'utilities', label: 'Utility table', content: <UtilityTable /> },
];

const AlignmentList: React.FC = () => {
  const { alignments, active } = useActiveAlignment();
  const setActive = useUndergroundStore(s => s.setActive);
  if (alignments.length === 0) {
    return (
      <EmptyState icon={TrainFrontTunnel} title="No underground alignment in this alternative"
        action={{ label: 'Draw an alignment', onClick: () => engineInstance.editing.setMode('draw_underground'), 'data-testid': 'underground-draw-alignment' }}>
        Tunnel, underground metro, cut-and-cover, utility trunk or storm drain: click plan points, double-click to finish, then set depths.
      </EmptyState>
    );
  }
  return (
    <ul className="space-y-1" data-testid="underground-alignments">
      {alignments.map(a => {
        const p = alignmentProfile(a);
        const cert = worstCertainty(p.vertices.map(v => v.certainty));
        return (
          <li key={a.id}>
            <button type="button" aria-pressed={active?.id === a.id} className="uos-row w-full text-left" data-testid={`ug-alignment-${a.id}`}
              style={active?.id === a.id ? { background: 'var(--surface-2)' } : undefined}
              onClick={() => { setActive(a.id); focus(a.id); useShellStore.getState().setDrawerOpen(true); }}>
              <TrainFrontTunnel size={16} aria-hidden className="text-text-2 shrink-0" />
              <span className="min-w-0 flex-1">
                <span className="block text-body text-text-1 truncate">{a.name}</span>
                <span className="block text-meta text-text-2">{ALIGNMENT_KIND_LABEL[a.alignmentKind]} · {Math.round(p.lengthM)} m · deepest {p.maxKnownDepthM === null ? 'Unknown' : `${p.maxKnownDepthM.toFixed(1)} m`}{p.unknownDepthCount ? ` · ${p.unknownDepthCount} depth ?` : ''}</span>
              </span>
              <CertaintyBadge certainty={cert} compact />
            </button>
          </li>
        );
      })}
    </ul>
  );
};

/**
 * Underground workspace (docs/urbanos/UNDERGROUND_WORKSPACE.md): view controls, underground alignments with their
 * vertical profile editor, subsurface records (import + list), conflict check, and the drawn utilities.
 */
export const UndergroundContext: React.FC = () => {
  const utils = useEngineObjects(isUtility);
  const { alignments, active } = useActiveAlignment();
  return (
    <div className="space-y-5">
      <PanelSection title="View">
        <ViewControls alignments={alignments} />
      </PanelSection>
      <PanelSection title="Underground alignments" aside={`${alignments.length}`}>
        <AlignmentList />
        {alignments.length > 0 && (
          <button type="button" className="uos-btn uos-btn-sm" onClick={() => engineInstance.editing.setMode('draw_underground')} data-testid="underground-draw-another">
            <TrainFrontTunnel size={14} aria-hidden /> Draw another
          </button>
        )}
      </PanelSection>
      {active && (
        <PanelSection title={`Profile editor · ${active.name}`}>
          <AlignmentEditor key={active.id} a={active} />
        </PanelSection>
      )}
      {active && (
        <PanelSection title="Conflict check">
          <ConflictCheck key={active.id} a={active} />
        </PanelSection>
      )}
      <PanelSection title="Subsurface records">
        <SubsurfaceRecords />
      </PanelSection>
      <PanelSection title="Utilities drawn in this alternative" aside={`${utils.length}`}>
        {utils.length === 0 ? (
          <EmptyState icon={Cable} title="No utilities drawn in this alternative"
            action={{ label: 'Draw a utility', onClick: () => engineInstance.editing.setMode('draw_utility'), 'data-testid': 'underground-draw-utility' }}>
            Hand-drawn utility objects. Imported utility records are listed above.
          </EmptyState>
        ) : (
          <ul className="space-y-1" data-testid="underground-utilities">
            {utils.map(u => {
              const c = utilityCertainty(u);
              return (
                <li key={u.id}>
                  <button type="button" onClick={() => focus(u.id)} className="uos-row w-full text-left">
                    <Cable size={16} aria-hidden className="text-text-2 shrink-0" />
                    <span className="min-w-0 flex-1">
                      <span className="block text-body text-text-1 truncate">{u.name || 'Utility'}</span>
                      <span className="block text-meta text-text-2">
                        {UTILITY_LABEL[u.utilityType] ?? u.utilityType} · depth <span className="tabular-nums">{Number.isFinite(u.depth) ? `${u.depth.toFixed(1)} m` : '—'}</span>
                        {u.depth === DEFAULT_DEPTH_M ? ' (drawing default)' : ''}
                      </span>
                    </span>
                    <CertaintyText {...c} />
                  </button>
                </li>
              );
            })}
          </ul>
        )}
      </PanelSection>
      <Disclosure>
        <p className="text-label text-text-2">Depths are metres below a flat ground datum: no terrain / DEM data is loaded, so real ground levels are UNKNOWN. Geology between boreholes, settlement, structural adequacy and engineering clearances are not modelled. Utility colours do not follow any national convention. Ground translucency uses Cesium globe translucency; X-ray also turns off the terrain depth test.</p>
      </Disclosure>
    </div>
  );
};

startUndergroundRuntime();

import React from 'react';
import { Cable, CircleHelp, FlaskConical } from 'lucide-react';
import { engineInstance } from '../../engine/TwinCityEngine';
import type { CityObject, UtilityObject } from '../../engine/objects/types';
import { PanelSection } from '../../components/ui/Panel';
import { EmptyState } from '../../components/ui/EmptyState';
import { Disclosure } from '../../components/ui/Disclosure';
import { useEngineObjects } from '../useEngineObjects';
import { lengthM } from './geo';
import { DEFAULT_DEPTH_M, UTILITY_LABEL, utilityCertainty } from './utilityCertainty';

const isUtility = (o: CityObject): o is UtilityObject => o.type === 'utility';

export const CertaintyText: React.FC<{ level: 'hypothetical' | 'unknown'; why: string }> = ({ level, why }) => (
  <span className={`inline-flex items-center gap-1 text-meta font-medium ${level === 'unknown' ? 'text-unknown' : 'text-hypothetical'}`} title={why}>
    {level === 'unknown' ? <CircleHelp size={12} aria-hidden /> : <FlaskConical size={12} aria-hidden />}
    {level === 'unknown' ? 'Unknown' : 'Hypothetical'}
  </span>
);

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

/**
 * Underground workspace (current capability, not a mock-up): the utility objects in the scene with their depth and
 * how certain that depth is. Drawing a utility uses the existing Utility tool (Build mode is on in this workspace).
 */
export const UndergroundContext: React.FC = () => {
  const utils = useEngineObjects(isUtility);
  return (
    <div className="space-y-5">
      <PanelSection title="Utilities in this alternative" aside={`${utils.length}`}>
        {utils.length === 0 ? (
          <EmptyState icon={Cable} title="No utilities in this alternative"
            action={{ label: 'Draw a utility', onClick: () => engineInstance.editing.setMode('draw_utility'), 'data-testid': 'underground-draw-utility' }}>
            No utility records or surveys are imported, so nothing is known about existing services here.
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
      <PanelSection title="Not available yet">
        <ul className="space-y-1 text-label text-text-2">
          <li className="flex items-center gap-2"><CircleHelp size={14} aria-hidden className="text-unknown shrink-0" />Utility records (ASCE 38 quality levels): not imported · Unknown</li>
          <li className="flex items-center gap-2"><CircleHelp size={14} aria-hidden className="text-unknown shrink-0" />Boreholes / geology: not imported · Unknown</li>
          <li className="flex items-center gap-2"><CircleHelp size={14} aria-hidden className="text-unknown shrink-0" />Tunnels and depth profiles: no tool yet</li>
        </ul>
      </PanelSection>
      <Disclosure>
        <p className="text-label text-text-2">Depth is metres below ground as stored on each utility object. New utilities get {DEFAULT_DEPTH_M} m until edited in the inspector. The table in the drawer lists length and capacity too. Ground transparency / X-ray view is not implemented.</p>
      </Disclosure>
    </div>
  );
};

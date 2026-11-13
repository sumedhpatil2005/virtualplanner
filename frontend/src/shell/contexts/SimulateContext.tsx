import React from 'react';
import { OctagonAlert, MousePointerClick } from 'lucide-react';
import { PanelSection } from '../../components/ui/Panel';
import { Disclosure } from '../../components/ui/Disclosure';
import { useSimulationMode } from '../../hooks/useSimulationMode';
import { useShellStore } from '../useShellStore';
import { TrafficCountsNotice } from '../../components/data/TrafficCountsNotice';

/**
 * Simulate context panel: the model list with each model's standing, and how to start. The study itself
 * (SimulationPanel, unchanged) is the inspector on the right.
 */
export const SimulateContext: React.FC = () => {
  const sim = useSimulationMode();
  const setInspectorOpen = useShellStore(s => s.setInspectorOpen);
  const inspectorOpen = useShellStore(s => s.inspectorOpen);
  return (
    <div className="space-y-5">
      <div className="uos-banner-fail" role="status" data-testid="simulate-validation-banner">
        <OctagonAlert size={16} aria-hidden className="shrink-0 mt-0.5" />
        <p>Traffic model fails validation (TAG M3.1): 0 of 15 count sites within GEH 5; river screen line −30.5%. Results are estimates for comparing options on the same inputs, not forecasts.</p>
      </div>
      <PanelSection title="Study">
        {sim.seedRoadIds.length === 0
          ? <p className="text-label text-text-2 flex items-center gap-2"><MousePointerClick size={14} aria-hidden />Click a road, bridge or flyover on the map.</p>
          : inspectorOpen ? <p className="text-label text-text-2">The study is in the panel on the right.</p>
          : <button type="button" className="uos-btn uos-btn-sm" onClick={() => setInspectorOpen(true)}>Show the study panel</button>}
      </PanelSection>
      <PanelSection title="Models">
        <ul className="space-y-1.5 text-label">
          <li className="uos-row"><span className="flex-1 text-text-1">Traffic micro-simulation (IDM)</span><span className="text-fail font-medium">Fails validation</span></li>
          <li className="uos-row"><span className="flex-1 text-text-1">Static assignment / ODME</span><span className="text-fail font-medium">Fails validation</span></li>
          <li className="uos-row"><span className="flex-1 text-text-1">Emissions (HBEFA 4)</span><span className="text-warn font-medium">Inherits traffic model</span></li>
          <li className="uos-row"><span className="flex-1 text-text-1">Feasibility screening</span><span className="text-text-2 font-medium">Screening only</span></li>
        </ul>
      </PanelSection>
      <PanelSection title="Data">
        <TrafficCountsNotice />
      </PanelSection>
      <Disclosure>
        <p className="text-label text-text-2">Figures from docs/ENGINEERING_VALIDATION.md §5 (counts GEH &lt; 5 at 0/15 sites; screen line 54,493 vs 78,357 veh/h; section speeds within 15% at 4/21). Criteria: UK DfT TAG unit M3.1, May 2026. Emissions are computed from simulated traffic, so they carry the same limitation. Feasibility screening never declares a proposal feasible.</p>
      </Disclosure>
    </div>
  );
};

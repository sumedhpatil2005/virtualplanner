import React from 'react';
import { MousePointerClick } from 'lucide-react';
import type { DrawerTab } from '../../components/ui/Drawer';
import { EmptyState } from '../../components/ui/EmptyState';
import { CalibrationPanel } from '../../components/CalibrationPanel';
import { CountChecks, TimesOfDay } from '../../components/RoadAnalysisPanel';
import { EmissionsCard, OdmeCard } from '../../components/OdmeAndEmissions';
import { TimeOfDayPanel } from '../../components/TimeOfDayPanel';
import { useSimulationMode } from '../../hooks/useSimulationMode';
import type { SimulationModeState } from '../../engine/simulation/SimulationMode';
import type { SimulateDrawerTabId } from './SimulateDrawerNav';

/** Each tab renders its existing card once; without a study area it shows how to get one. */
const WithStudy: React.FC<{ children: (sim: SimulationModeState) => React.ReactNode }> = ({ children }) => {
  const sim = useSimulationMode();
  if (!sim.area) {
    return (
      <EmptyState icon={MousePointerClick} title="No study area yet">
        Click a road, bridge or flyover on the map. These checks are computed for the area around it.
      </EmptyState>
    );
  }
  return <div className="max-w-3xl space-y-3 pt-1" data-testid="simulate-drawer-content">{children(sim)}</div>;
};

/** Simulate bottom-drawer tabs (UX_ARCHITECTURE §2), registered through AppShell's DRAWER_TABS map. */
export const SIMULATE_DRAWER_TABS: DrawerTab<SimulateDrawerTabId>[] = [
  { id: 'calibration', label: 'Calibration', content: <WithStudy>{sim => <CalibrationPanel sim={sim} />}</WithStudy> },
  { id: 'odme', label: 'ODME', content: <WithStudy>{sim => <OdmeCard sim={sim} />}</WithStudy> },
  { id: 'emissions', label: 'Emissions', content: <WithStudy>{sim => <EmissionsCard result={sim.analysis.output?.result} />}</WithStudy> },
  { id: 'counts', label: 'Count checks', content: <WithStudy>{sim => <CountChecks sim={sim} withOdme={false} />}</WithStudy> },
  {
    id: 'day', label: 'Through the day', content: <WithStudy>{sim => (
      <div className="space-y-4">
        <TimesOfDay sim={sim} />
        <div className="space-y-1"><h3 className="text-meta font-semibold uppercase tracking-wide text-text-3">Hourly demand profile</h3><TimeOfDayPanel tod={sim.timeOfDay} /></div>
      </div>
    )}</WithStudy>,
  },
];

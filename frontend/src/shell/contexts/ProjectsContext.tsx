import React from 'react';
import { PlanningPanel } from '../../components/PlanningPanel';
import { TrafficDataPanel } from '../../components/TrafficDataPanel';
import { Tabs, TabPanel } from '../../components/ui/Tabs';
import { useShellStore } from '../useShellStore';

/**
 * Projects workspace: planning projects (existing PlanningPanel) and, under "Data", the existing Traffic data manager.
 * The Data tab keeps the old pill's data-testid (open-traffic-data); the rail's Projects button keeps open-planning.
 */
export const ProjectsContext: React.FC = () => {
  const tab = useShellStore(s => s.projectsTab);
  const setTab = useShellStore(s => s.setProjectsTab);
  const openProjectId = useShellStore(s => s.openProjectId);
  const setContextOpen = useShellStore(s => s.setContextOpen);
  const close = () => setContextOpen(false);
  return (
    <div className="flex flex-col h-full min-h-0">
      <div className="px-3 pt-2 shrink-0">
        <Tabs idBase="uos-projects" label="Projects workspace" value={tab} onChange={setTab}
          tabs={[
            { id: 'projects', label: 'Projects', hint: 'Planning projects: scenarios, data, assessments, decisions, audit' },
            { id: 'data', label: 'Data', hint: 'Enter, import and manage traffic counts', 'data-testid': 'open-traffic-data' },
          ]} />
      </div>
      <TabPanel idBase="uos-projects" id={tab} className="uos-embed-panel flex-1 min-h-0">
        {tab === 'projects'
          ? <PlanningPanel key={openProjectId ?? 'list'} initialOpenId={openProjectId} onClose={close} />
          : <TrafficDataPanel onClose={close} />}
      </TabPanel>
    </div>
  );
};

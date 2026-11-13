import React, { useState } from 'react';
import { Loader2 } from 'lucide-react';
import { PanelHeader, PanelBody, Notice } from '../ui/kit';
import { Tabs, TabPanel } from '../ui/Tabs';
import { openActionableCount } from '../../lib/planningProjects';
import { StatusBadge } from './common';
import { useProjectBundle } from './projectData';
import { OverviewTab } from './OverviewTab';
import { AlternativesTab } from './AlternativesTab';
import { ConflictsTab } from './ConflictsTab';
import { AssessmentsTab, DatasetsTab, DecisionsTab, ActivityTab } from './RecordsTabs';

export type ProjectTab = 'overview' | 'alternatives' | 'assessments' | 'datasets' | 'conflicts' | 'decisions' | 'activity';

/** One planning project: Overview · Alternatives · Assessments · Datasets · Conflicts · Reviews & decisions · Activity. */
export const ProjectPage: React.FC<{ id: string; user: string; onBack: () => void; onClose: () => void; initialTab?: ProjectTab }> = ({ id, user, onBack, onClose, initialTab }) => {
  const { bundle: b, error, reload, setError } = useProjectBundle(id);
  const [tab, setTab] = useState<ProjectTab>(initialTab ?? 'overview');
  const act = async (f: () => Promise<unknown>) => { setError(null); try { await f(); } catch (e) { setError((e as Error).message); } await reload(); };
  if (!b) return (<><PanelHeader title="Planning project" onBack={onBack} backLabel="All projects" onClose={onClose} /><PanelBody>{error ? <Notice tone="bad">{error}</Notice> : <Notice icon={Loader2} spin>Loading…</Notice>}</PanelBody></>);
  const who = user.trim();
  const p = b.project;
  const open = openActionableCount(b.issues);
  const alts = (p.links ?? []).filter(l => l.entity_type === 'scenario').length;
  const staleN = b.stale ? [...b.stale.assessments, ...b.stale.runs].filter(v => v.stale === true).length : 0;
  return (
    <>
      <PanelHeader title={p.name} subtitle={<StatusBadge status={p.status} />} onBack={onBack} backLabel="All projects" onClose={onClose} />
      <div className="px-3 pt-1 shrink-0 [&_.uos-tabs]:flex-wrap [&_.uos-tab]:px-2.5" data-testid="project-tabs">
        <Tabs<ProjectTab> idBase="uos-project" label="Project sections" value={tab} onChange={setTab} tabs={[
          { id: 'overview', label: 'Overview' },
          { id: 'alternatives', label: `Alternatives${alts ? ` ${alts}` : ''}`, 'data-testid': 'ptab-alternatives' },
          { id: 'assessments', label: `Assessments${staleN ? ` ·${staleN} stale` : ''}`, 'data-testid': 'ptab-assessments' },
          { id: 'datasets', label: 'Datasets', 'data-testid': 'ptab-datasets' },
          { id: 'conflicts', label: `Conflicts${open ? ` ${open}` : ''}`, 'data-testid': 'ptab-conflicts' },
          { id: 'decisions', label: 'Reviews & decisions', 'data-testid': 'ptab-decisions' },
          { id: 'activity', label: 'Activity', 'data-testid': 'ptab-activity' },
        ]} />
      </div>
      <TabPanel idBase="uos-project" id={tab} className="flex-1 min-h-0 flex flex-col">
        <PanelBody>
          {error && <Notice tone="bad">{error}</Notice>}
          {b.partialErrors.length > 0 && <Notice tone="warn">Some parts could not be loaded: {b.partialErrors.join(' · ')}</Notice>}
          {!who && <Notice tone="warn">Enter your name on the project list; it is recorded with every change.</Notice>}
          {tab === 'overview' && <OverviewTab b={b} who={who} act={act} reload={() => void reload()} goTab={t => setTab(t as ProjectTab)} />}
          {tab === 'alternatives' && <AlternativesTab b={b} who={who} act={act} />}
          {tab === 'assessments' && <AssessmentsTab b={b} />}
          {tab === 'datasets' && <DatasetsTab b={b} />}
          {tab === 'conflicts' && <ConflictsTab b={b} who={who} act={act} />}
          {tab === 'decisions' && <DecisionsTab b={b} who={who} act={act} />}
          {tab === 'activity' && <ActivityTab events={b.events} />}
        </PanelBody>
      </TabPanel>
    </>
  );
};

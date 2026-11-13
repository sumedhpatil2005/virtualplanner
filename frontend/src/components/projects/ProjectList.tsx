import React, { useEffect, useState } from 'react';
import { planningApi, type Project } from '../../engine/planning/planningApi';
import { coordinationApi } from '../../lib/coordinationApi';
import { cardSummary, type CardSummary } from '../../lib/planningProjects';
import { StatusBadge } from './common';
import { when } from './projectData';

interface CardData { area: string | null; summary: CardSummary; detected: boolean }

/** Project cards: name, status, area, alternatives, open conflicts, stale assessments. Counts load per card. */
export const ProjectList: React.FC<{ projects: Project[]; onOpen: (id: string) => void }> = ({ projects, onOpen }) => (
  <ul className="space-y-1.5">
    {projects.map(p => <ProjectCard key={p.id} p={p} onOpen={() => onOpen(p.id)} />)}
  </ul>
);

const ProjectCard: React.FC<{ p: Project; onOpen: () => void }> = ({ p, onOpen }) => {
  const [d, setD] = useState<CardData | null>(null);
  const [failed, setFailed] = useState(false);
  useEffect(() => {
    let live = true;
    Promise.all([
      planningApi.project(p.id),
      coordinationApi.listElements(p.id).catch(() => []),
      coordinationApi.projectIssues(p.id).then(r => r.issues).catch(() => []),
      coordinationApi.projectStale(p.id).catch(() => null),
    ]).then(([full, els, issues, stale]) => {
      if (!live) return;
      setD({ area: full.area?.name ?? (full.bbox ? 'bounding box' : null), detected: !!stale?.coordination_runs.length,
        summary: cardSummary({ links: full.links, elements: els.length, issues, stale }) });
    }).catch(() => live && setFailed(true));
    return () => { live = false; };
  }, [p.id]);
  const s = d?.summary;
  return (
    <li>
      <button data-testid="open-project" data-project={p.id} onClick={onOpen} className="w-full text-left rounded-xl bg-white/[0.04] border border-white/5 hover:border-white/20 px-3 py-2 cursor-pointer transition">
        <div className="flex items-center justify-between gap-2"><span className="text-sm font-semibold text-white truncate">{p.name}</span><StatusBadge status={p.status} /></div>
        <div className="text-xs text-slate-400 mt-0.5 truncate">{d?.area ?? 'No study area'} · by {p.created_by} · {when(p.created_at)}</div>
        {s ? (
          <div className="flex flex-wrap gap-x-3 gap-y-0.5 mt-1 text-xs tabular-nums" data-testid="project-card-counts">
            <span className="text-slate-300">{s.alternatives} alternative{s.alternatives === 1 ? '' : 's'}</span>
            <span className="text-slate-300">{s.elements} element{s.elements === 1 ? '' : 's'}</span>
            <span className={s.openConflicts ? 'text-amber-300' : 'text-slate-300'} data-testid="card-open-conflicts">
              {d?.detected ? `${s.openConflicts} open conflict${s.openConflicts === 1 ? '' : 's'}` : 'conflicts: not checked'}
            </span>
            {s.staleAssessments > 0 && <span className="text-amber-300">{s.staleAssessments} stale</span>}
            {s.unknownStale > 0 && <span className="text-slate-400">{s.unknownStale} stale unknown</span>}
          </div>
        ) : failed ? <div className="text-xs text-rose-300 mt-1">Counts could not be loaded</div> : null}
      </button>
    </li>
  );
};

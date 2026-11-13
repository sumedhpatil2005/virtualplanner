import { useCallback, useEffect, useState } from 'react';
import { planningApi, type AuditEvent, type Linkable, type Project } from '../../engine/planning/planningApi';
import { coordinationApi, type ProjectIssue, type ProjectStale, type ProposalElement } from '../../lib/coordinationApi';
import { geometryBounds } from '../../lib/planningProjects';
import { engineInstance } from '../../engine/TwinCityEngine';

export const inputCls = 'w-full rounded-lg bg-white/[0.05] border border-white/10 px-2 py-1.5 text-sm text-white placeholder:text-slate-500 focus:outline-none focus:border-cyan-400/60';
export const labelCls = 'block text-xs text-slate-400 mb-1';
export const when = (iso: string | null | undefined) => (iso ? new Date(iso).toLocaleString(undefined, { dateStyle: 'medium', timeStyle: 'short' }) : '–');

export const ACTION_LABEL: Record<string, string> = { create: 'created', update: 'changed', delete: 'deleted', export: 'exported' };
export const ENTITY_LABEL: Record<string, string> = {
  project: 'Project', project_link: 'Attachment', decision: 'Decision', project_report: 'Report', scenario: 'Scenario', scenario_change: 'Scenario edit',
  scenario_version: 'Scenario version', run: 'Simulation run', dataset: 'Traffic dataset', count_record: 'Count record', assessment: 'Feasibility assessment',
  evidence: 'Evidence', review: 'Review', document: 'Investigation document', pcu_set: 'PCU set', vehicle_class: 'Vehicle class',
  proposal_element: 'Proposal element', coordination_run: 'Conflict detection', coordination_conflict: 'Conflict response',
  clearance_rule: 'Clearance rule', subsurface_dataset: 'Subsurface dataset', subsurface_record: 'Subsurface record',
};

export type Act = (f: () => Promise<unknown>) => Promise<void>;

/** Everything one project page shows, loaded together and reloaded after every write. */
export interface ProjectBundle {
  project: Project;
  events: AuditEvent[];
  linkable: Linkable | null;
  elements: ProposalElement[];
  issues: ProjectIssue[];
  stale: ProjectStale | null;
  projectNames: Record<string, string>;
  /** A part that failed to load (shown, never silently treated as empty). */
  partialErrors: string[];
}

export function useProjectBundle(id: string) {
  const [bundle, setBundle] = useState<ProjectBundle | null>(null);
  const [error, setError] = useState<string | null>(null);
  const reload = useCallback(async () => {
    try {
      const project = await planningApi.project(id);
      const partialErrors: string[] = [];
      const soft = <T,>(label: string, p: Promise<T>, fallback: T) => p.catch((e: Error) => { partialErrors.push(`${label}: ${e.message}`); return fallback; });
      const [events, linkable, elements, issues, stale, all] = await Promise.all([
        soft('audit', planningApi.audit(id), [] as AuditEvent[]),
        soft('linkable records', planningApi.linkable(), null),
        soft('proposal elements', coordinationApi.listElements(id), [] as ProposalElement[]),
        soft('conflicts', coordinationApi.projectIssues(id).then(r => r.issues), [] as ProjectIssue[]),
        soft('stale indicators', coordinationApi.projectStale(id), null),
        soft('projects', planningApi.projects(), [] as Project[]),
      ]);
      setBundle({ project, events, linkable, elements, issues, stale, partialErrors,
        projectNames: Object.fromEntries(all.map(p => [p.id, p.name])) });
      setError(null);
    } catch (e) { setError((e as Error).message); }
  }, [id]);
  useEffect(() => { void reload(); }, [reload]);
  return { bundle, error, reload, setError };
}

/** Fly the map to a GeoJSON geometry (no selection change, nothing edited). */
export function flyToGeometry(g: { type: string; coordinates: unknown } | null | undefined): boolean {
  const b = geometryBounds(g);
  if (!b) return false;
  const pad = 0.0015;
  engineInstance.simMode.flyToBounds({ minLng: b.minLng - pad, minLat: b.minLat - pad, maxLng: b.maxLng + pad, maxLat: b.maxLat + pad });
  return true;
}

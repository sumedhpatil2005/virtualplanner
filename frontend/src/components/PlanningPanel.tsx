import React, { useCallback, useEffect, useState } from 'react';
import { FolderPlus, Loader2, Plus } from 'lucide-react';
import { SidePanel, PanelHeader, PanelBody, Section, Button, Notice } from './ui/kit';
import { apiGet } from '../lib/api';
import { planningApi, type Project } from '../engine/planning/planningApi';
import { inputCls, labelCls } from './projects/projectData';
import { ProjectList } from './projects/ProjectList';
import { ProjectPage } from './projects/ProjectPage';

/**
 * Planning & Approval Workspace (docs/PLANNING_WORKSPACE.md) redesigned as the Projects & Coordination workspace
 * (docs/urbanos/PROJECTS_AND_COORDINATION_UI.md): project cards → a project page with tabs (components/projects/*):
 * Overview, Alternatives (+ proposal elements), Assessments (stale indicators), Datasets, Conflicts (cross-project
 * coordination), Reviews & decisions (append-only; never a statutory approval), Activity (audit).
 * All original data-testids and aria-labels are kept (some now live inside a tab).
 */

export const PlanningPanel: React.FC<{ onClose: () => void; /** Open this project directly (command palette). */ initialOpenId?: string | null }> = ({ onClose, initialOpenId }) => {
  const [projects, setProjects] = useState<Project[] | null>(null);
  const [openId, setOpenId] = useState<string | null>(initialOpenId ?? null);
  const [error, setError] = useState<string | null>(null);
  const [user, setUserState] = useState(() => localStorage.getItem('td-user') ?? '');
  const setUser = (v: string) => { setUserState(v); localStorage.setItem('td-user', v); };

  const reload = useCallback(async () => {
    try { setProjects(await planningApi.projects()); setError(null); } catch (e) { setError(String((e as Error).message ?? e)); }
  }, []);
  useEffect(() => { void reload(); }, [reload]);

  return (
    <SidePanel label="Planning projects" wide>
      {openId
        ? <ProjectPage id={openId} user={user} onBack={() => { setOpenId(null); void reload(); }} onClose={onClose} />
        : (
          <>
            <PanelHeader title="Planning projects" subtitle="One project per planning activity: alternatives, conflicts, assessments, decisions" onClose={onClose} />
            <PanelBody>
              {error && <Notice tone="bad">{error}</Notice>}
              <div>
                <label className={labelCls} htmlFor="pl-user">Your name (recorded in the audit log; not verified)</label>
                <input id="pl-user" data-testid="planning-user" className={inputCls} value={user} onChange={e => setUser(e.target.value)} placeholder="e.g. A. Planner" />
              </div>
              <NewProject user={user} onCreated={p => { void reload(); setOpenId(p.id); }} />
              <Section title="Projects" aside={projects ? `${projects.length}` : undefined}>
                {!projects ? <Notice icon={Loader2} spin>Loading…</Notice>
                  : projects.length === 0 ? <p className="text-sm text-slate-400">No planning project yet.</p>
                  : <ProjectList projects={projects} onOpen={setOpenId} />}
              </Section>
            </PanelBody>
          </>
        )}
    </SidePanel>
  );
};

const NewProject: React.FC<{ user: string; onCreated: (p: Project) => void }> = ({ user, onCreated }) => {
  const [open, setOpen] = useState(false);
  const [name, setName] = useState('');
  const [desc, setDesc] = useState('');
  const [areaId, setAreaId] = useState('');
  const [areas, setAreas] = useState<{ id: string; name: string }[]>([]);
  const [busy, setBusy] = useState(false);
  const [err, setErr] = useState<string | null>(null);
  useEffect(() => {
    if (open && !areas.length) apiGet<{ id: string; name: string }[]>('/api/areas').then(a => setAreas(a.map(x => ({ id: x.id, name: x.name })))).catch(() => {});
  }, [open, areas.length]);
  if (!open) return <Button icon={FolderPlus} variant="primary" data-testid="new-project" onClick={() => setOpen(true)}>New planning project</Button>;
  const create = async () => {
    setBusy(true); setErr(null);
    try { onCreated(await planningApi.create({ name, description: desc, area_id: areaId || null, created_by: user.trim() })); setOpen(false); setName(''); setDesc(''); }
    catch (e) { setErr((e as Error).message); } finally { setBusy(false); }
  };
  return (
    <Section title="New planning project">
      <div><label className={labelCls} htmlFor="pl-name">Name</label><input id="pl-name" data-testid="project-name" className={inputCls} value={name} onChange={e => setName(e.target.value)} /></div>
      <div><label className={labelCls} htmlFor="pl-desc">Purpose (planning question)</label><textarea id="pl-desc" data-testid="project-desc" rows={2} className={inputCls} value={desc} onChange={e => setDesc(e.target.value)} /></div>
      <div>
        <label className={labelCls} htmlFor="pl-area">Study area (optional)</label>
        <select id="pl-area" className={inputCls} value={areaId} onChange={e => setAreaId(e.target.value)}>
          <option value="">— none —</option>
          {areas.map(a => <option key={a.id} value={a.id}>{a.name}</option>)}
        </select>
      </div>
      <p className="text-xs text-slate-500">The project records the current baseline network's fingerprint, so a later baseline edit is flagged.</p>
      {err && <Notice tone="bad">{err}</Notice>}
      <div className="flex gap-2">
        <Button variant="primary" icon={busy ? Loader2 : Plus} spin={busy} disabled={busy || !name.trim() || !user.trim()} data-testid="create-project" onClick={create}>Create</Button>
        <Button variant="ghost" onClick={() => setOpen(false)}>Cancel</Button>
      </div>
      {!user.trim() && <p className="text-xs text-amber-300">Enter your name above first.</p>}
    </Section>
  );
};

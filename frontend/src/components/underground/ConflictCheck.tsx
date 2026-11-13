import React, { useEffect, useState } from 'react';
import { FolderKanban, ShieldQuestion } from 'lucide-react';
import { coordinationApi, type ConflictClass } from '../../lib/coordinationApi';
import { planningApi, type Project } from '../../engine/planning/planningApi';
import type { UndergroundAlignmentObject } from '../../engine/objects/types';
import { alignmentElementPayload } from '../../engine/underground/alignmentGeometry';
import { useShellStore } from '../../shell/useShellStore';
import { EmptyState } from '../ui/EmptyState';
import { CertaintyBadge } from '../ui/badges/CertaintyBadge';
import { field, input, inputStyle, lbl, labelStyle, note } from './common';
import { USER_KEY } from './useSubsurfaceRecords';
import { useUndergroundStore } from './undergroundStore';
import { CLASS_ORDER, CLASS_TEXT } from './conflictClasses';
import { sideBLabel, sideBRefShown } from '../../lib/planningProjects';


export const ClassBadge: React.FC<{ cls: ConflictClass; count?: number }> = ({ cls, count }) => (
  <span className="inline-flex items-center gap-1 rounded px-1.5 py-0.5 text-meta font-semibold" style={{ border: `1px solid ${CLASS_TEXT[cls].color}`, color: CLASS_TEXT[cls].color }}
    title={CLASS_TEXT[cls].hint} data-testid={`ug-class-${cls}`}>
    {CLASS_TEXT[cls].label}{count !== undefined ? ` · ${count}` : ''}
  </span>
);

/**
 * Registers the alignment as a proposal element of a planning project (POST /api/coordination/projects/{pid}/elements;
 * updated in place on later checks) and runs detection (POST …/detect). Shows the findings for this element by class.
 */
export const ConflictCheck: React.FC<{ a: UndergroundAlignmentObject }> = ({ a }) => {
  const [projects, setProjects] = useState<Project[] | null>(null);
  const [loadErr, setLoadErr] = useState<string | null>(null);
  const [pid, setPid] = useState('');
  const [user, setUser] = useState(() => localStorage.getItem(USER_KEY) ?? '');
  const [busy, setBusy] = useState(false);
  const [err, setErr] = useState<string | null>(null);
  const check = useUndergroundStore(s => s.checks[a.id]);
  const setCheck = useUndergroundStore(s => s.setCheck);

  useEffect(() => {
    planningApi.projects().then(ps => { setProjects(ps); setPid(p => p || check?.projectId || ps[0]?.id || ''); }).catch(e => setLoadErr((e as Error).message));
  }, [check?.projectId]);

  const run = async () => {
    setBusy(true); setErr(null);
    try {
      localStorage.setItem(USER_KEY, user.trim());
      const payload = alignmentElementPayload(a);
      const { scenario_id: _sid, element_ref: _ref, ...patch } = payload;
      const marker = `alignment ${a.id} `;
      // Same alignment registered here before, or from Projects → Alternatives (element_ref): update it, never duplicate.
      const existing = (await coordinationApi.listElements(pid)).find(e => e.provenance.includes(marker)
        || (e.element_ref === a.id && (e.scenario_id ?? null) === payload.scenario_id));
      const element = existing
        ? await coordinationApi.patchElement(existing.id, {
          ...patch, edited_by: user.trim(),
          clear_fields: [...(payload.width_m === null ? ['width_m' as const] : []), ...(payload.z_min_m === null ? ['z_min_m' as const] : []), ...(payload.z_max_m === null ? ['z_max_m' as const] : [])],
        })
        : await coordinationApi.createElement(pid, { ...payload, created_by: user.trim() });
      const result = await coordinationApi.detect(pid, user.trim());
      setCheck(a.id, { projectId: pid, element, run: result, at: new Date().toISOString() });
    } catch (e) {
      setErr((e as Error).message);
    } finally { setBusy(false); }
  };

  if (loadErr) return <p className="text-label text-fail" role="alert">Planning projects could not be loaded: {loadErr}</p>;
  if (projects && projects.length === 0) {
    return (
      <EmptyState icon={FolderKanban} title="No planning project to check against"
        action={{ label: 'Open Projects', onClick: () => useShellStore.getState().setWorkspace('projects'), 'data-testid': 'ug-open-projects' }}>
        A conflict check registers the alignment as a proposal element of a planning project. Create a project first.
      </EmptyState>
    );
  }
  const findings = (check?.run.conflicts ?? []).filter(f => f.element_a_id === check?.element.id);
  const counts = CLASS_ORDER.map(c => [c, findings.filter(f => f.class === c).length] as const).filter(([, n]) => n > 0);
  const fresh = check && check.element.updated_at && new Date(a.updatedAt).getTime() <= new Date(check.at).getTime();
  return (
    <div className="flex flex-col gap-2" data-testid="ug-conflict-check">
      <div className="grid grid-cols-2 gap-2">
        <div className={field}>
          <label className={lbl} style={labelStyle} htmlFor="ug-cc-project">Planning project</label>
          <select id="ug-cc-project" data-testid="ug-cc-project" className={input} style={inputStyle} value={pid} onChange={e => setPid(e.target.value)} disabled={!projects}>
            {(projects ?? []).map(p => <option key={p.id} value={p.id}>{p.name}</option>)}
          </select>
        </div>
        <div className={field}>
          <label className={lbl} style={labelStyle} htmlFor="ug-cc-user">Your name</label>
          <input id="ug-cc-user" data-testid="ug-cc-user" className={input} style={inputStyle} value={user} onChange={e => setUser(e.target.value)} />
        </div>
      </div>
      <button type="button" className="uos-btn self-start" onClick={() => void run()} disabled={busy || !pid || !user.trim()} data-testid="ug-check-conflicts">
        <ShieldQuestion size={14} aria-hidden /> {busy ? 'Checking…' : 'Check conflicts'}
      </button>
      <p className="text-[11px]" style={note}>Registers this alignment (plan line, width, crown/invert per vertex relative to ground) as a proposal element of the project, then checks it against other projects, existing roads, OSM metro and imported utility records. Screening only, not an engineering clearance.</p>
      {err && <p className="text-label text-fail" role="alert">{err}</p>}
      {check && (
        <div className="flex flex-col gap-2" data-testid="ug-conflict-results">
          <div className="text-meta text-text-2">
            Run {check.run.id.slice(0, 8)} · {new Date(check.run.created_at).toLocaleString()} · element certainty <CertaintyBadge certainty={check.element.certainty} compact />
            {!fresh && <span className="text-warn"> · alignment edited since this check — run it again</span>}
            {check.run.stale?.stale && <span className="text-warn"> · stale: {check.run.stale.reasons.join(', ')}</span>}
          </div>
          {counts.length === 0
            ? <p className="text-label text-text-2">The run returned no findings for this element (unexpected: every layer should report). Treat as UNKNOWN.</p>
            : <div className="flex flex-wrap gap-1" data-testid="ug-class-summary">{counts.map(([c, n]) => <ClassBadge key={c} cls={c} count={n} />)}</div>}
          <ul className="space-y-1 max-h-72 overflow-auto">
            {[...findings].sort((p, q) => CLASS_ORDER.indexOf(p.class) - CLASS_ORDER.indexOf(q.class)).slice(0, 100).map(f => (
              <li key={f.id} className="uos-card text-meta text-text-2" data-testid="ug-finding">
                <div className="flex flex-wrap items-center gap-2">
                  <ClassBadge cls={f.class} />
                  <span className="text-text-1" data-testid="ug-finding-side-b">{sideBLabel(f)}</span>
                  {sideBRefShown(f) && !/ record /.test(sideBLabel(f)) && <span className="truncate min-w-0" title={f.b_ref}>{f.b_ref}</span>}
                </div>
                <div className="tabular-nums">
                  plan distance {f.horizontal_distance_m === null ? 'Unknown' : `${f.horizontal_distance_m.toFixed(1)} m`} · vertical gap {f.vertical_gap_m === null ? 'Unknown' : `${f.vertical_gap_m.toFixed(1)} m`} · <CertaintyBadge certainty={f.certainty} compact />
                </div>
                {f.reasons.length > 0 && <div>{f.reasons.slice(0, 2).join(' · ')}</div>}
                {f.permission_triggers.map(t => <div key={t.rule_id} className="text-warn">{t.label}: {t.distance_m.toFixed(1)} m ≤ {t.threshold_m} m — permission trigger, not an engineering clearance</div>)}
              </li>
            ))}
          </ul>
          {findings.length > 100 && <p className="text-meta text-text-3">Showing the 100 most severe of {findings.length}.</p>}
        </div>
      )}
    </div>
  );
};

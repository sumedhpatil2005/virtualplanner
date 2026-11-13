import React, { useMemo, useState } from 'react';
import { Crosshair, Layers, Link2, Loader2, PencilRuler, Plus, Star, Trash2 } from 'lucide-react';
import { Section, Button, Notice } from '../ui/kit';
import { Disclosure } from '../ui/Disclosure';
import { EmptyState } from '../ui/EmptyState';
import { CertaintyBadge } from '../ui/badges';
import { planningApi, type ProjectLink } from '../../engine/planning/planningApi';
import { coordinationApi, type ProposalElement } from '../../lib/coordinationApi';
import { planningClient, type ScenarioVersionInfo } from '../../lib/planningClient';
import { draftsFromChangeSet, zRangeText, type ElementDraft, type SkippedObject } from '../../lib/planningProjects';
import { engineInstance } from '../../engine/TwinCityEngine';
import { useShellStore } from '../../shell/useShellStore';
import { inputCls, flyToGeometry, type Act, type ProjectBundle } from './projectData';

export const AlternativesTab: React.FC<{ b: ProjectBundle; who: string; act: Act }> = ({ b, who, act }) => {
  const p = b.project;
  const scenarios = (p.links ?? []).filter(l => l.entity_type === 'scenario');
  const versions = (p.links ?? []).filter(l => l.entity_type === 'scenario_version');
  const [pick, setPick] = useState('');
  const attached = new Set(scenarios.map(s => s.entity_id));
  const options = (b.linkable?.scenario ?? []).filter(s => !attached.has(s.id));
  return (
    <>
      <Section title="Alternatives" aside={`${scenarios.length}`}>
        {scenarios.length === 0
          ? <EmptyState icon={Layers} title="No alternative attached">Attach a proposal scenario below. Create proposals in Design.</EmptyState>
          : <ul className="space-y-2" data-testid="alternatives-list">
              {scenarios.map(s => <AlternativeCard key={s.id} link={s} b={b} who={who} act={act} />)}
            </ul>}
        <div className="flex gap-2">
          <select aria-label="Alternative to attach" data-testid="alt-attach-select" className={inputCls} value={pick} onChange={e => setPick(e.target.value)}>
            <option value="">{options.length ? '— choose a proposal —' : '— no other proposal —'}</option>
            {options.map(o => <option key={o.id} value={o.id}>{o.label}</option>)}
          </select>
          <Button size="sm" icon={Link2} data-testid="alt-attach" disabled={!pick || !who}
            onClick={() => act(async () => { await planningApi.link(p.id, 'scenario', pick, who); setPick(''); })}>Attach</Button>
        </div>
        {versions.length > 0 && (
          <div className="text-xs text-slate-400">Pinned versions: {versions.map(v => v.label).join(' · ')}</div>
        )}
      </Section>
      <ElementsList b={b} who={who} act={act} />
    </>
  );
};

const AlternativeCard: React.FC<{ link: ProjectLink; b: ProjectBundle; who: string; act: Act }> = ({ link, b, who, act }) => {
  const p = b.project;
  const preferred = p.preferred_scenario_id === link.entity_id;
  const setWorkspace = useShellStore(s => s.setWorkspace);
  const [reg, setReg] = useState(false);
  const count = b.elements.filter(e => e.scenario_id === link.entity_id).length;
  const openInDesign = () => {
    try { engineInstance.scenarios.setActiveScenario(link.entity_id); } catch (e) { (window as any).showToast?.(`Could not open: ${(e as Error).message}`, 'error'); return; }
    setWorkspace('design');
  };
  return (
    <li className="rounded-xl bg-white/[0.04] border border-white/5 px-3 py-2 space-y-2" data-testid="alternative-card" data-scenario={link.entity_id}>
      <div className="flex items-center gap-2">
        <button type="button" aria-label={preferred ? 'Preferred alternative (click to clear)' : 'Mark as preferred alternative'} aria-pressed={preferred}
          data-testid="alt-preferred" disabled={!who}
          title={preferred ? 'Preferred by the project team (a working flag, not a decision)' : 'Mark as preferred (a working flag, not a decision)'}
          onClick={() => act(() => planningApi.setPreferred(p.id, preferred ? '' : link.entity_id, who))}
          className={`p-1 rounded cursor-pointer disabled:opacity-40 ${preferred ? 'text-amber-300' : 'text-slate-500 hover:text-slate-200'}`}>
          <Star size={16} fill={preferred ? 'currentColor' : 'none'} />
        </button>
        <span className={`flex-1 min-w-0 truncate text-sm font-semibold ${link.exists ? 'text-white' : 'text-rose-300'}`} title={link.entity_id}>{link.label}</span>
        <span className="text-xs text-slate-400 whitespace-nowrap">{count} element{count === 1 ? '' : 's'}</span>
      </div>
      <div className="flex flex-wrap gap-1.5">
        <Button size="sm" icon={Plus} data-testid="alt-register" disabled={!who || !link.exists} onClick={() => setReg(r => !r)}>Add proposal elements</Button>
        <Button size="sm" variant="ghost" icon={PencilRuler} onClick={openInDesign} title="Make this the active alternative and open Design, where “Compare with base city” is">Open & compare in Design</Button>
      </div>
      {reg && <RegisterElements sid={link.entity_id} b={b} who={who} act={act} onDone={() => setReg(false)} />}
    </li>
  );
};

/** Registers an alternative's proposed objects as project_proposal_elements (POST /api/coordination/projects/{pid}/elements). */
const RegisterElements: React.FC<{ sid: string; b: ProjectBundle; who: string; act: Act; onDone: () => void }> = ({ sid, b, who, act, onDone }) => {
  const [versions, setVersions] = useState<ScenarioVersionInfo[] | null>(null);
  const [vid, setVid] = useState('');
  const [plan, setPlan] = useState<{ drafts: ElementDraft[]; skipped: SkippedObject[] } | null>(null);
  const [err, setErr] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const registered = useMemo(() => new Set(b.elements.filter(e => e.element_ref).map(e => `${e.scenario_id}:${e.element_ref}`)), [b.elements]);
  React.useEffect(() => {
    let live = true;
    planningClient.versions(sid).then(v => live && setVersions(v)).catch(() => live && setVersions([]));
    planningClient.changeSet(sid)
      .then(cs => live && setPlan(draftsFromChangeSet(cs.changes, sid, null, registered)))
      .catch((e: Error) => live && setErr(e.message));
    return () => { live = false; };
  }, [sid, registered]);
  // A version pins the geometry to that snapshot; the head is the alternative as it is now.
  const drafts = (plan?.drafts ?? []).map(d => ({ ...d, input: { ...d.input, scenario_version_id: vid || null } }));
  const register = async () => {
    setBusy(true);
    await act(async () => {
      const fails: string[] = [];
      for (const d of drafts) {
        try { await coordinationApi.createElement(b.project.id, { ...d.input, created_by: who }); }
        catch (e) { fails.push(`${d.name}: ${(e as Error).message}`); }
      }
      if (fails.length) throw new Error(`${drafts.length - fails.length} registered, ${fails.length} failed — ${fails.join('; ')}`);
      (window as any).showToast?.(`${drafts.length} proposal element${drafts.length === 1 ? '' : 's'} registered`, 'success');
      onDone();
    });
    setBusy(false);
  };
  if (err) return <Notice tone="bad">{err}</Notice>;
  if (!plan) return <Notice icon={Loader2} spin>Reading the alternative…</Notice>;
  return (
    <div className="space-y-2 border-t border-white/10 pt-2" data-testid="register-elements">
      {versions && versions.length > 0 && (
        <select aria-label="Geometry from" className={inputCls} value={vid} onChange={e => setVid(e.target.value)} data-testid="register-version">
          <option value="">Current head (as edited now)</option>
          {versions.map(v => <option key={v.id} value={v.id}>v{v.number} {v.label}</option>)}
        </select>
      )}
      {drafts.length === 0 ? <p className="text-sm text-slate-400">Nothing new to register.</p> : (
        <ul className="space-y-1">
          {drafts.map(d => (
            <li key={d.objectId} className="text-sm flex items-center gap-2" data-testid="register-draft">
              <span className="flex-1 min-w-0 truncate text-slate-100">{d.name}</span>
              <span className="text-xs text-slate-400 whitespace-nowrap">{d.input.kind.replace(/_/g, ' ')} · {zRangeText(d.input.z_min_m ?? null, d.input.z_max_m ?? null)}</span>
            </li>
          ))}
        </ul>
      )}
      {plan.skipped.length > 0 && <p className="text-xs text-slate-500">{plan.skipped.length} not registered ({[...new Set(plan.skipped.map(s => s.reason))].join('; ')}).</p>}
      <Disclosure>
        <ul className="text-xs text-slate-400 space-y-1">
          {drafts.map(d => <li key={d.objectId}><b className="text-slate-300">{d.name}</b>: {d.basis.join(' ')}</li>)}
          <li>Depth / height relative to ground, up positive. Empty = UNKNOWN (never 0). Values are design inputs (hypothetical), not surveys.</li>
        </ul>
      </Disclosure>
      <div className="flex gap-2">
        <Button size="sm" variant="primary" icon={busy ? Loader2 : Plus} spin={busy} data-testid="register-confirm" disabled={busy || drafts.length === 0 || !who} onClick={() => void register()}>
          Register {drafts.length}
        </Button>
        <Button size="sm" variant="ghost" onClick={onDone}>Cancel</Button>
      </div>
    </div>
  );
};

const ElementsList: React.FC<{ b: ProjectBundle; who: string; act: Act }> = ({ b, who, act }) => {
  const names = Object.fromEntries((b.project.links ?? []).filter(l => l.entity_type === 'scenario').map(l => [l.entity_id, l.label]));
  if (b.elements.length === 0) return null;
  return (
    <Section title="Proposal elements" aside={`${b.elements.length}`}>
      <ul className="space-y-1" data-testid="elements-list">
        {b.elements.map((e: ProposalElement) => (
          <li key={e.id} className="flex items-center gap-2 rounded-lg bg-white/[0.04] border border-white/5 px-2.5 py-1.5 text-sm" data-testid="element-row">
            <div className="flex-1 min-w-0">
              <div className="truncate text-slate-100">{e.name || e.kind}</div>
              <div className="text-xs text-slate-400 truncate">{e.kind.replace(/_/g, ' ')} · {zRangeText(e.z_min_m, e.z_max_m)}{e.width_m == null ? ' · width UNKNOWN' : ` · ${e.width_m} m wide`}{e.scenario_id ? ` · ${names[e.scenario_id] ?? e.scenario_id}` : ''}</div>
            </div>
            <CertaintyBadge certainty={e.certainty} compact />
            <button aria-label="Show element on map" title="Show on map" className="p-1 rounded text-slate-400 hover:text-white cursor-pointer" onClick={() => flyToGeometry(e.geometry)}><Crosshair size={14} /></button>
            <button aria-label="Remove element" title="Remove from this project (the alternative is not changed)" disabled={!who}
              className="p-1 rounded text-slate-400 hover:text-rose-300 cursor-pointer disabled:opacity-40" onClick={() => act(() => coordinationApi.deleteElement(e.id, who))}><Trash2 size={14} /></button>
          </li>
        ))}
      </ul>
    </Section>
  );
};

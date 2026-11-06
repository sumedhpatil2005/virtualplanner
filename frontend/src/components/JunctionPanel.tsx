import React, { useEffect, useMemo, useState, useSyncExternalStore } from 'react';
import { ArrowDownRight, ArrowUpRight, Ban, Check, Plus, RotateCcw, Trash2, Waypoints } from 'lucide-react';
import { engineInstance } from '../engine/TwinCityEngine';
import type { RoadObject } from '../engine/objects/types';
import type { LogicalJunction } from '../engine/simulation/junctionGroups';
import { cycleOf, armGreenS, validateEdit, type JunctionEditSpec } from '../engine/simulation/junctionControl';
import { startingDraft, startingNote, setControl, setGreen, setTiming, toggleArmInPhase, addPhase, removePhase, toggleMajor, toggleBan, toggleLane, resetLanes, defaultLanePairs, sameEdit } from '../engine/editing/junctionDraft';
import { SidePanel, PanelHeader, PanelBody, Section, Button, Segmented, Notice } from './ui/kit';
import { JUNCTION_HIGHLIGHT_STYLE } from '../engine/rendering/renderers/JunctionHighlight';

/**
 * Build: one imported junction as a whole (docs/OVERHAUL.md §23). Control,
 * signal plan, priority, banned turns and lane connections, applied to every
 * piece of the junction as one Undo step. The map shows every approach (green
 * arrows in), exit (orange arrows out) and internal piece (cyan) while the
 * panel is open; hovering an arm or picking a movement draws it in yellow.
 */

const subscribe = (cb: () => void) => {
  // Undo and redo change the edit through the object store
  const a = engineInstance.onJunctionChange(cb), b = engineInstance.objects.onChange(cb);
  return () => { a(); b(); };
};
const getOpen = () => engineInstance.getOpenImportedJunction();
const TURN_WORD: Record<string, string> = { left: 'left', right: 'right', straight: 'straight on', u_turn: 'U-turn' };

export const JunctionPanel: React.FC = () => {
  const open = useSyncExternalStore(subscribe, getOpen);
  if (!open) return null;
  return <JunctionEditor key={open.junction.id} j={open.junction} />;
};

const JunctionEditor: React.FC<{ j: LogicalJunction }> = ({ j }) => {
  const applied = useSyncExternalStore(subscribe, () => engineInstance.getImportedJunctionEdit(j.id));
  const start = useMemo(() => {
    // The last analysis's own network first (its link ids are the run's), else the roads compiled around the junction
    const st = engineInstance.simMode.getState(), result = st.analysis.output?.result;
    const fromRun = startingDraft(j, applied, result, st.area?.network);
    return fromRun.source === 'default' ? startingDraft(j, applied, result, engineInstance.getOpenImportedJunction()?.local.network) : fromRun;
  }, [j, applied]);
  const [draft, setDraft] = useState<JunctionEditSpec>(start.draft);
  const [move, setMove] = useState<string | null>(null);
  const [hoverArms, setHoverArms] = useState<string[]>([]);
  useEffect(() => { setDraft(start.draft); }, [start]);

  const net = engineInstance.getOpenImportedJunction()?.local.network;
  const edgeLanes = (edgeIds: string[]) => Math.max(1, ...edgeIds.map(id => net?.edges.get(id)?.lanes ?? 1));
  const arms = [...j.approaches, ...j.exits];
  const armById = new Map(arms.map(a => [a.id, a]));
  const moveObj = move ? j.movements.find(m => m.key === move) : null;

  // Map preview: the whole junction, with the hovered arm or the picked movement emphasised
  const focusKey = (hoverArms.length ? hoverArms : moveObj ? [moveObj.approachId, moveObj.exitId] : []).join('|');
  useEffect(() => { engineInstance.previewImportedJunction(focusKey ? focusKey.split('|') : []); }, [focusKey]);

  const problems = validateEdit(draft);
  const changed = !sameEdit(draft, start.draft) || (!applied && start.source !== 'edit');
  const unchangedFromApplied = applied ? sameEdit(draft, applied) : false;
  const plan = draft.signal;
  const cycle = plan ? cycleOf(plan) : 0;
  const pieces = j.internalEdgeIds.length;

  const apply = () => {
    engineInstance.applyImportedJunctionEdit(draft);
    (window as any).showToast?.(`Junction edited as a whole: ${j.approaches.length} approaches, ${pieces} internal pieces. Simulate re-runs the analysis. Ctrl+Z to undo.`, 'info');
  };

  return (
    <SidePanel label="Junction editor" wide>
      <PanelHeader
        title={j.label}
        subtitle={<span data-testid="junction-summary">Imported junction · {j.nodeIds.length} node{j.nodeIds.length === 1 ? '' : 's'} · {pieces} internal piece{pieces === 1 ? '' : 's'}{j.slipLaneRoadIds.length ? ` · ${j.slipLaneRoadIds.length} slip lane${j.slipLaneRoadIds.length === 1 ? '' : 's'}` : ''}</span>}
        onBack={() => engineInstance.closeImportedJunction()}
        accessory={<span data-testid="junction-state" className={`text-[11px] font-semibold px-2 py-0.5 rounded-full border ${applied ? 'border-amber-400/40 text-amber-200 bg-amber-500/10' : 'border-white/10 text-slate-400'}`}>{applied ? 'Edited' : 'As mapped'}</span>}
      />
      <PanelBody>
        <div data-testid="junction-editor" data-junction-id={j.id} />
        {start.stale && <Notice tone="warn">The roads at this junction changed since it was edited. Review the plan below, or reset it to the mapped junction.</Notice>}

        <Section title="Approaches and exits" aside={<span className="inline-flex items-center gap-2"><Swatch css={JUNCTION_HIGHLIGHT_STYLE.approach.css} /> in <Swatch css={JUNCTION_HIGHLIGHT_STYLE.exit.css} /> out <Swatch css={JUNCTION_HIGHLIGHT_STYLE.internal.css} /> inside</span>}>
          <ul className="rounded-xl bg-white/[0.04] border border-white/5 divide-y divide-white/5 text-sm" data-testid="junction-arms">
            {arms.map(a => (
              <li key={a.id} className="flex items-center gap-2 px-3 py-1.5" data-arm-id={a.id} data-kind={a.kind}
                onMouseEnter={() => setHoverArms([a.id])} onMouseLeave={() => setHoverArms([])}>
                {a.kind === 'in' ? <ArrowDownRight size={14} style={{ color: JUNCTION_HIGHLIGHT_STYLE.approach.css }} aria-label="approach" /> : <ArrowUpRight size={14} style={{ color: JUNCTION_HIGHLIGHT_STYLE.exit.css }} aria-label="exit" />}
                <span className="flex-1 text-slate-200 leading-tight">{a.label}</span>
                <span className="text-xs text-slate-500 tabular-nums">{edgeLanes(a.edgeIds)} lane{edgeLanes(a.edgeIds) === 1 ? '' : 's'}</span>
              </li>
            ))}
          </ul>
        </Section>

        <Section title="Control">
          <Segmented label="Junction control" value={draft.control} onChange={c => setDraft(setControl(draft, c))}
            options={[{ value: 'none', label: 'No control' }, { value: 'priority', label: 'Priority' }, { value: 'signal', label: 'Signal' }]} />
          <p className="text-xs text-slate-500" data-testid="junction-start-note">{applied ? startingNote(j, { source: 'edit', run: null }) : startingNote(j, start)}</p>
        </Section>

        {draft.control === 'signal' && plan && (
          <Section title="Signal plan" aside={<span data-testid="junction-cycle">Cycle {cycle} s</span>}>
            <div className="space-y-2" data-testid="junction-phases">
              {plan.phases.map((p, i) => (
                <div key={i} className="rounded-xl bg-white/[0.04] border border-white/5 p-2.5 space-y-2" data-phase={i}>
                  <div className="flex items-center gap-2">
                    <span className="text-xs font-semibold text-slate-300 w-14" title={p.arms.length ? undefined : 'No approach has green in this phase (in the last run it served only pieces inside the junction)'}>Phase {i + 1}{p.arms.length ? '' : '*'}</span>
                    <input type="range" min={5} max={120} value={p.greenS} aria-label={`Phase ${i + 1} green`} onChange={e => setDraft(setGreen(draft, i, Number(e.target.value)))} className="flex-1 accent-emerald-400" />
                    <input type="number" min={5} max={180} value={p.greenS} aria-label={`Phase ${i + 1} green (s)`} data-testid={`phase-green-${i}`} onChange={e => setDraft(setGreen(draft, i, Number(e.target.value)))}
                      className="w-14 bg-slate-900 border border-slate-700/50 rounded-md px-1.5 py-0.5 text-sm text-right tabular-nums" />
                    <span className="text-xs text-slate-500">s</span>
                    {plan.phases.length > 1 && <button className="p-1 text-slate-500 hover:text-rose-300" aria-label={`Remove phase ${i + 1}`} onClick={() => setDraft(removePhase(draft, i))}><Trash2 size={13} /></button>}
                  </div>
                  <div className="flex flex-wrap gap-1">
                    {j.approaches.map(a => {
                      const on = p.arms.includes(a.id);
                      return (
                        <button key={a.id} type="button" aria-pressed={on} data-testid={`phase-${i}-arm-${a.id}`} onClick={() => setDraft(toggleArmInPhase(draft, i, a.id))}
                          onMouseEnter={() => setHoverArms([a.id])} onMouseLeave={() => setHoverArms([])}
                          className={`text-[11px] rounded-md px-1.5 py-0.5 border ${on ? 'bg-emerald-500/20 border-emerald-400/40 text-emerald-100' : 'border-white/10 text-slate-500 hover:text-slate-300'}`}>
                          {a.label}
                        </button>
                      );
                    })}
                  </div>
                </div>
              ))}
            </div>
            <div className="flex items-center gap-3 text-xs text-slate-400">
              <label className="flex items-center gap-1">Amber <input type="number" min={0} max={10} value={plan.amberS} onChange={e => setDraft(setTiming(draft, 'amberS', Number(e.target.value)))} className="w-10 bg-slate-900 border border-slate-700/50 rounded px-1 text-right" /> s</label>
              <label className="flex items-center gap-1">All-red <input type="number" min={0} max={10} value={plan.allRedS} onChange={e => setDraft(setTiming(draft, 'allRedS', Number(e.target.value)))} className="w-10 bg-slate-900 border border-slate-700/50 rounded px-1 text-right" /> s</label>
              <Button size="sm" variant="ghost" icon={Plus} onClick={() => setDraft(addPhase(draft))}>Phase</Button>
            </div>
            <ul className="text-xs text-slate-400 space-y-0.5" data-testid="junction-green-per-approach">
              {j.approaches.map(a => <li key={a.id} className="flex justify-between"><span>{a.label}</span><span className="tabular-nums text-slate-300">{plan.phases.length > 1 && plan.phases.every(p => p.arms.includes(a.id)) ? 'always green' : `${armGreenS(plan, a.id)} s green of ${cycle} s`}</span></li>)}
            </ul>
          </Section>
        )}

        {draft.control === 'priority' && (
          <Section title="Major approaches" aside="Others give way">
            <div className="flex flex-col gap-1">
              {j.approaches.map(a => (
                <label key={a.id} className="flex items-center gap-2 text-sm text-slate-200" onMouseEnter={() => setHoverArms([a.id])} onMouseLeave={() => setHoverArms([])}>
                  <input type="checkbox" checked={(draft.majorArms ?? []).includes(a.id)} onChange={() => setDraft(toggleMajor(draft, a.id))} /> {a.label}
                </label>
              ))}
            </div>
          </Section>
        )}

        <Section title="Turning movements" aside="Click a movement for its lanes">
          <div className="space-y-2" data-testid="junction-movements">
            {j.approaches.map(a => (
              <div key={a.id}>
                <div className="text-xs text-slate-400 mb-1">{a.label}</div>
                <div className="flex flex-wrap gap-1">
                  {j.movements.filter(m => m.approachId === a.id).map(m => {
                    const banned = (draft.bannedMovements ?? []).includes(m.key);
                    const x = armById.get(m.exitId)!;
                    return (
                      <span key={m.key} className={`inline-flex items-center rounded-md border text-[11px] ${move === m.key ? 'border-yellow-300/60' : 'border-white/10'} ${banned ? 'bg-rose-500/10 text-rose-200 line-through' : 'text-slate-200'}`}>
                        <button type="button" className="px-1.5 py-0.5" data-testid={`move-${m.key}`} onClick={() => setMove(move === m.key ? null : m.key)} title={`${a.label} → ${x.label}`}>
                          {TURN_WORD[m.turn]} → {x.name ?? 'unnamed'}
                        </button>
                        <button type="button" className="px-1 py-0.5 border-l border-white/10 hover:text-rose-300" aria-pressed={banned} aria-label={`${banned ? 'Allow' : 'Ban'} ${TURN_WORD[m.turn]} from ${a.label} to ${x.label}`} data-testid={`ban-${m.key}`} onClick={() => setDraft(toggleBan(draft, m.key))}>
                          {banned ? <Check size={11} /> : <Ban size={11} />}
                        </button>
                      </span>
                    );
                  })}
                </div>
              </div>
            ))}
          </div>
        </Section>

        {moveObj && !(draft.bannedMovements ?? []).includes(moveObj.key) && (() => {
          const a = armById.get(moveObj.approachId)!, x = armById.get(moveObj.exitId)!;
          const m = edgeLanes(a.edgeIds), n = edgeLanes(x.edgeIds);
          const pairs = draft.laneConnections?.[moveObj.key] ?? defaultLanePairs(m, n);
          const custom = !!draft.laneConnections?.[moveObj.key];
          return (
            <Section title="Lane connections" aside={custom ? 'Edited' : 'Default: lanes in order'}>
              <p className="text-xs text-slate-400">{a.label} → {x.label}. Lane 1 is on the median side. A lane with no connection merges into the nearest connected lane before the line.</p>
              <table className="text-xs text-slate-300" data-testid="lane-grid">
                <thead><tr><th className="text-left font-normal text-slate-500 pr-2">entry \ exit</th>{Array.from({ length: n }, (_, o) => <th key={o} className="font-normal text-slate-500 px-1.5">{o + 1}</th>)}</tr></thead>
                <tbody>
                  {Array.from({ length: m }, (_, i) => (
                    <tr key={i}>
                      <td className="pr-2 text-slate-500">lane {i + 1}</td>
                      {Array.from({ length: n }, (_, o) => (
                        <td key={o} className="px-1.5 text-center">
                          <input type="checkbox" aria-label={`Entry lane ${i + 1} to exit lane ${o + 1}`} checked={pairs.some(([pi, po]) => pi === i && po === o)} onChange={() => setDraft(toggleLane(draft, moveObj.key, i, o, m, n))} />
                        </td>
                      ))}
                    </tr>
                  ))}
                </tbody>
              </table>
              {custom && <Button size="sm" variant="ghost" icon={RotateCcw} onClick={() => setDraft(resetLanes(draft, moveObj.key))}>Back to lanes in order</Button>}
            </Section>
          );
        })()}

        {problems.length > 0 && <Notice tone="warn"><ul data-testid="junction-problems">{problems.map(p => <li key={p}>{p}</li>)}</ul></Notice>}
        <div className="space-y-2 pt-1">
          <p className="text-xs text-slate-500">Applies to the whole junction ({j.approaches.length} approaches, {j.exits.length} exits, {pieces} internal pieces) as one Undo step. Road shapes are not changed. The network changes, so Simulate re-runs the analysis.</p>
          <div className="flex gap-2">
            <Button variant="primary" icon={Waypoints} data-testid="junction-apply" disabled={problems.length > 0 || unchangedFromApplied || !changed} onClick={apply}>Apply to junction</Button>
            {!sameEdit(draft, start.draft) && <Button variant="ghost" onClick={() => setDraft(start.draft)}>Discard changes</Button>}
          </div>
          {applied && <Button size="sm" variant="ghost" icon={RotateCcw} data-testid="junction-reset" onClick={() => engineInstance.resetImportedJunctionEdit(j.id)}>Back to the mapped junction</Button>}
        </div>
      </PanelBody>
    </SidePanel>
  );
};

const Swatch: React.FC<{ css: string }> = ({ css }) => <span className="inline-block h-1.5 w-3 rounded-full align-middle" style={{ background: css }} aria-hidden />;

/** In the road editor: "Select junction" for a piece inside an imported junction (or a short piece next to one). */
export const JunctionOffer: React.FC<{ road: RoadObject }> = ({ road }) => {
  const [j, setJ] = useState<LogicalJunction | null>(null);
  useEffect(() => {
    let live = true;
    setJ(null);
    void engineInstance.importedJunctionOfRoad(road.id).then(x => { if (live) setJ(x); });
    return () => { live = false; };
  }, [road.id]);
  if (!j) return null;
  return (
    <Notice icon={Waypoints} action={<Button size="sm" variant="primary" data-testid="select-junction" onClick={() => void engineInstance.openImportedJunctionAt(j.centre, false)}>Select junction</Button>}>
      <span data-testid="junction-offer">This piece is part of <b>{j.label}</b> ({j.internalEdgeIds.length} internal pieces, {j.approaches.length} approaches). Edit its signals, turns and lanes as one junction.</span>
    </Notice>
  );
};

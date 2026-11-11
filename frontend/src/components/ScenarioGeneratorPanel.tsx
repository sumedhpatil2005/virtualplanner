import React, { useMemo, useState, useSyncExternalStore } from 'react';
import { engineInstance } from '../engine/TwinCityEngine';
import { GeneratorSession } from '../engine/generator/session';
import { CAUSE_LABEL } from '../engine/generator/diagnosis';
import { CATEGORY_LABEL } from '../engine/generator/candidates';
import { METRICS, METRIC_BY_ID, paretoSet, weightedRanking, explainScenario, type MetricId, type ScenarioRow } from '../engine/generator/compare';

/**
 * Scenario generator and multi-objective comparison (docs/SCENARIO_GENERATOR.md).
 * Diagnose → candidates → isolated proposal scenarios → evaluation on the
 * baseline's frozen inputs → table with the Pareto set over the chosen
 * objectives and, beside it, an optional weighted ranking with its weights.
 */
let session: GeneratorSession | null = null;
export const generatorSession = () => {
  if (!session) { session = new GeneratorSession(engineInstance); (globalThis as { generatorSession?: GeneratorSession }).generatorSession = session; }
  return session;
};

const DEFAULT_OBJECTIVES: MetricId[] = ['meanTravelTime', 'throughput', 'costClass', 'landTake', 'disruption'];
const CONF_TONE: Record<string, string> = { high: 'text-emerald-300', medium: 'text-amber-200', low: 'text-slate-400' };

const fmtVal = (v: number | null | undefined) => (v === null || v === undefined ? null : Math.abs(v) >= 100 ? Math.round(v).toLocaleString() : String(Math.round(v * 10) / 10));

export const ScenarioGeneratorPanel: React.FC = () => {
  const s = generatorSession();
  const st = useSyncExternalStore(s.subscribe, s.getState);
  const [selected, setSelected] = useState<Set<string> | null>(null);
  const [objectives, setObjectives] = useState<Set<MetricId>>(new Set(DEFAULT_OBJECTIVES));
  const [weights, setWeights] = useState<Partial<Record<MetricId, number>>>({});
  const [open, setOpen] = useState<string | null>(null);
  const busy = st.status === 'creating' || st.status === 'evaluating';
  const chosen = selected ?? new Set(st.candidates.map(c => c.id));

  const pareto = useMemo(() => (st.rows.length ? paretoSet(st.rows, [...objectives]) : []), [st.rows, objectives]);
  const ranking = useMemo(() => (st.rows.length && Object.values(weights).some(w => (w ?? 0) > 0) ? weightedRanking(st.rows, weights) : null), [st.rows, weights]);
  const nameOf = (id: string) => st.rows.find(r => r.id === id)?.name ?? id;
  const baseRow = st.rows.find(r => r.isBaseline);

  return (
    <section className="space-y-3 rounded-lg border border-slate-700/60 bg-slate-900/40 p-3" data-testid="scenario-generator">
      <div className="flex items-baseline justify-between gap-2">
        <h3 className="text-xs font-semibold uppercase tracking-wide text-slate-400">Generate candidate scenarios</h3>
        <span className="text-[10px] text-amber-200/80" title="Causes, candidates and results are model output from the estimated demand, not measurements.">ESTIMATED · model output</span>
      </div>
      <p className="text-[11px] text-slate-400">Finds the causes of the worst places in this analysis, proposes interventions (traffic management first), creates each as its own proposal scenario (the baseline is never changed), runs each on the baseline's frozen demand, hour and seeds, and compares them.</p>
      <div className="flex flex-wrap gap-2">
        <button className="rounded bg-sky-700 px-2 py-1 text-xs text-white disabled:opacity-40" disabled={busy} data-testid="gen-diagnose" onClick={() => { setSelected(null); s.diagnose(); }}>Diagnose &amp; propose</button>
        {st.candidates.length > 0 && <button className="rounded bg-sky-700 px-2 py-1 text-xs text-white disabled:opacity-40" disabled={busy || !chosen.size} data-testid="gen-create" onClick={() => void s.createScenarios([...chosen])}>Create {chosen.size} proposal scenario{chosen.size === 1 ? '' : 's'}</button>}
        {st.created.length > 0 && <button className="rounded bg-emerald-700 px-2 py-1 text-xs text-white disabled:opacity-40" disabled={busy} data-testid="gen-evaluate" onClick={() => void s.evaluate()}>Evaluate on the frozen baseline</button>}
      </div>
      {st.progress && <p className="text-[11px] text-sky-200" data-testid="gen-progress">{st.status === 'creating' ? 'Creating scenarios' : 'Running'} {st.progress.done} of {st.progress.of}…</p>}
      {st.message && <p className={`text-[11px] ${st.status === 'error' ? 'text-rose-300' : 'text-slate-300'}`} data-testid="gen-message">{st.message}</p>}

      {st.diagnosis && (
        <div className="space-y-1" data-testid="gen-diagnosis">
          <h4 className="text-[11px] font-semibold text-slate-300">Diagnosis ({st.diagnosis.label})</h4>
          {st.diagnosis.locations.slice(0, 5).map(l => (
            <div key={l.evidence.id} className="text-[11px]" data-testid="gen-location">
              <div className="text-slate-200">{l.evidence.label} <span className="text-slate-500">({l.evidence.scope === 'corridor' ? 'micro-simulation' : 'assignment only'})</span></div>
              {l.causes.length ? <ul className="ml-3 list-disc text-slate-300">
                {l.causes.map(c => <li key={c.cause} title={`${c.text}\nThreshold basis: ${c.metric.thresholdBasis}`} data-testid="gen-cause" data-cause={c.cause}>
                  <span className="font-medium">{CAUSE_LABEL[c.cause]}</span> <span className={CONF_TONE[c.confidence]}>({c.confidence})</span>: {c.metric.name} = {c.metric.value}{c.metric.unit ? ` ${c.metric.unit}` : ''} vs {c.metric.threshold}
                </li>)}
              </ul> : <p className="ml-3 text-slate-500">No cause with enough evidence.</p>}
            </div>
          ))}
          {st.diagnosis.notes.map(n => <p key={n} className="text-[10px] text-slate-500">{n}</p>)}
        </div>
      )}

      {st.candidates.length > 0 && (
        <div className="space-y-1" data-testid="gen-candidates">
          <h4 className="text-[11px] font-semibold text-slate-300">Candidates</h4>
          {st.candidates.map(c => {
            const made = st.created.find(x => x.candidate.id === c.id);
            return (
              <div key={c.id} className="rounded border border-slate-700/50 p-2 text-[11px]" data-testid="gen-candidate" data-kind={c.kind}>
                <label className="flex items-start gap-2">
                  <input type="checkbox" checked={chosen.has(c.id)} disabled={busy || !!made} onChange={e => { const n = new Set(chosen); if (e.target.checked) n.add(c.id); else n.delete(c.id); setSelected(n); }} />
                  <span><span className="text-slate-500">{c.category} · {CATEGORY_LABEL[c.category]}</span><br /><span className="text-slate-100">{c.title}</span></span>
                </label>
                <p className="mt-1 text-slate-300">{c.rationale}</p>
                <p className="text-slate-400">Works cost class: {c.costClass.label} · disruption: {c.disruptionClass.label} · land take: {c.landTake.value} <span className="text-slate-500" title={`${c.costClass.basis}\n${c.landTake.basis}`}>(basis)</span></p>
                <details><summary className="cursor-pointer text-slate-400">Evidence, assumptions, limitations</summary>
                  <ul className="ml-3 list-disc text-slate-400">{c.evidence.map(x => <li key={x}>{x}</li>)}</ul>
                  <p className="text-slate-300">Assumptions</p><ul className="ml-3 list-disc text-slate-400">{c.assumptions.map(x => <li key={x}>{x}</li>)}</ul>
                  <p className="text-slate-300">Limitations</p><ul className="ml-3 list-disc text-slate-400">{c.limitations.map(x => <li key={x}>{x}</li>)}</ul>
                </details>
                {made && <div className="mt-1 text-slate-300" data-testid="gen-created">
                  {made.error ? <span className="text-rose-300">Not created: {made.error}</span> : <>Proposal <code className="text-slate-400">{made.scenarioId}</code>{made.versionId ? ' · version saved' : ''}
                    {made.topology && <span className={made.topology.ok ? 'text-emerald-300' : 'text-amber-200'} data-testid="gen-topology"> · topology {made.topology.ok ? 'connected' : `issues: ${made.topology.problems.join(' ')}`}</span>}
                    {made.feasibility && <div className="text-slate-400" data-testid="gen-feasibility">Feasibility screening: {made.feasibility.findings} findings, {made.feasibility.investigations} investigations required{made.feasibility.critical ? `, ${made.feasibility.critical} critical flag(s)` : ''}; outside existing right of way: {made.feasibility.outsideRoW} ({made.feasibility.certainty}).{made.feasibility.summary.length ? ` ${made.feasibility.summary.join(' ')}` : ''}</div>}
                    <button className="ml-1 text-sky-300 underline" onClick={() => engineInstance.scenarios.setActiveScenario(made.scenarioId)}>Open</button></>}
                </div>}
              </div>
            );
          })}
        </div>
      )}

      {st.rows.length > 0 && (
        <div className="space-y-2" data-testid="gen-comparison">
          <h4 className="text-[11px] font-semibold text-slate-300">Comparison (same frozen demand, hour and seeds)</h4>
          <div className="flex flex-wrap gap-x-3 gap-y-1 text-[11px] text-slate-300" data-testid="gen-objectives">
            <span className="text-slate-500">Priorities (objectives for the Pareto set):</span>
            {METRICS.map(m => <label key={m.id} className="flex items-center gap-1" title={m.definition}>
              <input type="checkbox" checked={objectives.has(m.id)} onChange={e => { const n = new Set(objectives); if (e.target.checked) n.add(m.id); else n.delete(m.id); setObjectives(n); }} />{m.label}
            </label>)}
          </div>
          <div className="overflow-x-auto">
            <table className="min-w-full text-[11px] tabular-nums" data-testid="gen-table">
              <thead><tr className="text-slate-400">
                <th className="px-1 text-left">Scenario</th><th className="px-1" title="Non-dominated over the selected objectives. An unknown value can neither dominate nor be dominated.">Pareto</th>
                {METRICS.map(m => <th key={m.id} className={`px-1 text-right ${objectives.has(m.id) ? 'text-slate-200' : ''}`} title={`${m.definition}\nSource: ${m.source}\nBetter: ${m.better}. Noise threshold ${Math.round(m.noise * 100)}%${m.kind === 'simulated' ? ', and every seed must agree' : ''}.`}>{m.label}<br /><span className="text-slate-500">{m.unit} {m.better === 'lower' ? '↓' : '↑'}</span></th>)}
                <th className="px-1">Inputs</th>
              </tr></thead>
              <tbody>{st.rows.map(r => {
                const p = pareto.find(x => x.id === r.id);
                return (
                  <tr key={r.id} className={`border-t border-slate-700/50 ${p?.inPareto ? 'bg-emerald-900/30' : ''}`} data-testid="gen-row" data-pareto={p?.inPareto ? 'yes' : 'no'}>
                    <td className="px-1 text-left text-slate-200"><button className="text-left underline decoration-dotted" onClick={() => setOpen(open === r.id ? null : r.id)}>{r.name}</button></td>
                    <td className="px-1 text-center" title={p && !p.inPareto ? p.dominatedBy.map(d => `Dominated by ${nameOf(d.id)} (better on ${d.betterOn.map(x => METRIC_BY_ID.get(x)!.label).join(', ')})`).join('\n') : p?.incomparable.length ? p.incomparable.map(x => `Not comparable with ${nameOf(x.id)}: ${x.unknown.map(u => METRIC_BY_ID.get(u)!.label).join(', ')} unknown`).join('\n') : ''}>{p?.inPareto ? '★' : '—'}</td>
                    {METRICS.map(m => { const v = r.values[m.id]; const t = fmtVal(v?.value); return <td key={m.id} className="px-1 text-right" title={v?.note ?? ''}>{t ?? <span className="text-slate-500">{v?.status === 'not_available' ? 'n/a' : 'unknown'}</span>}</td>; })}
                    <td className="px-1 text-center" title={r.inputs ? (r.inputs.matched ? 'Same frozen inputs as the baseline run' : r.inputs.differences.map(d => `${d.input}: ${d.before} vs ${d.after}`).join('\n')) : r.isBaseline ? 'Baseline run' : 'Inputs not recorded'}>{r.isBaseline ? 'base' : r.inputs?.matched ? '=' : <span className="text-rose-300">≠</span>}</td>
                  </tr>
                );
              })}</tbody>
            </table>
          </div>
          <p className="text-[10px] text-slate-500">★ = not beaten on every selected objective by another scenario (Pareto set). Differences within the noise threshold, or not shown by every seed, are ties. Ordinal classes are not money. n/a: no emissions model in this build.</p>
          {pareto.filter(p => !p.inPareto).map(p => <p key={p.id} className="text-[11px] text-slate-400" data-testid="gen-dominated">{nameOf(p.id)} is dominated by {p.dominatedBy.map(d => `${nameOf(d.id)} (better on ${d.betterOn.map(x => METRIC_BY_ID.get(x)!.label.toLowerCase()).join(', ')})`).join('; ')}.</p>)}

          <details className="text-[11px]" data-testid="gen-weights">
            <summary className="cursor-pointer text-slate-300">Optional weighted ranking (shown beside the Pareto set)</summary>
            <div className="flex flex-wrap gap-2">{[...objectives].map(id => <label key={id} className="flex items-center gap-1 text-slate-300">{METRIC_BY_ID.get(id)!.label}
              <input type="number" min={0} max={10} step={1} className="w-12 rounded bg-slate-800 px-1" value={weights[id] ?? 0} onChange={e => setWeights({ ...weights, [id]: Number(e.target.value) })} /></label>)}</div>
            {ranking && <div className="mt-1" data-testid="gen-ranking">
              <p className="text-slate-400">Weights: {Object.entries(ranking.weights).map(([k, w]) => `${METRIC_BY_ID.get(k as MetricId)!.label} ${w}`).join(', ')}. Normalisation: {ranking.normalisation}.</p>
              <ol className="ml-4 list-decimal text-slate-200">{ranking.ranked.map(x => <li key={x.id}>{nameOf(x.id)} — {x.score}</li>)}</ol>
              {ranking.notRanked.map(x => <p key={x.id} className="text-slate-500">Not ranked: {nameOf(x.id)} ({x.unknown.map(u => METRIC_BY_ID.get(u)!.label).join(', ')} unknown).</p>)}
              <p className="text-[10px] text-slate-500">{ranking.caveat}</p>
            </div>}
          </details>

          {open && baseRow && (() => {
            const r = st.rows.find(x => x.id === open)!;
            if (r.isBaseline) return null;
            const e = st.evaluated.find(x => x.scenarioId === open);
            const made = st.created.find(x => x.scenarioId === open);
            const x = explainScenario(r as ScenarioRow, baseRow, { assumptions: e?.candidate.assumptions, limitations: e?.candidate.limitations,
              investigations: made?.feasibility ? [`Feasibility screening lists ${made.feasibility.investigations} investigations before any design decision.`] : undefined, comparisonConfidence: e?.comparison?.confidence });
            return (
              <div className="rounded border border-slate-700/60 p-2 text-[11px]" data-testid="gen-explanation">
                <p className="font-semibold text-slate-200">{r.name}</p>
                <p className="text-emerald-300">Improved: {x.improved.join('; ') || 'nothing beyond noise'}</p>
                <p className="text-rose-300">Worse: {x.worse.join('; ') || 'nothing beyond noise'}</p>
                {e?.comparison && <p className="text-slate-300">Verdict of the comparison: {e.comparison.verdict.summary}</p>}
                <p className="text-slate-300">Confidence: {x.confidence.level} — {x.confidence.text}</p>
                <p className="text-slate-300">Assumptions:</p><ul className="ml-3 list-disc text-slate-400">{x.assumptions.map(a => <li key={a}>{a}</li>)}</ul>
                <p className="text-slate-300">Missing data:</p><ul className="ml-3 list-disc text-slate-400">{x.missing.map(a => <li key={a}>{a}</li>)}</ul>
                <p className="text-slate-300">Investigation needed:</p><ul className="ml-3 list-disc text-slate-400">{x.investigation.map(a => <li key={a}>{a}</li>)}</ul>
              </div>
            );
          })()}
        </div>
      )}
    </section>
  );
};

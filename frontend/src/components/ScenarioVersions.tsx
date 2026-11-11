import React, { useCallback, useEffect, useState } from 'react';
import { History, Save, RotateCcw } from 'lucide-react';
import { engineInstance } from '../engine/TwinCityEngine';
import type { ScenarioVersion, ScenarioVersionList } from '../engine/scenarios/versions';
import { assumptionDifferences } from '../engine/scenarios/versions';
import { ConfirmDialog } from './ui/ConfirmDialog';

/**
 * Versions of the active proposal (docs/SCENARIOS_AND_VERSIONING.md): save the change set as an immutable version
 * with the simulation assumptions in force, list versions, and restore one (which saves unsaved work first and
 * records the restore as a new version; no version is ever changed or removed).
 */
export const ScenarioVersions: React.FC<{ scenarioId: string }> = ({ scenarioId }) => {
  const [list, setList] = useState<ScenarioVersionList | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [label, setLabel] = useState('');
  const [busy, setBusy] = useState(false);
  const [confirm, setConfirm] = useState<ScenarioVersion | null>(null);
  const [open, setOpen] = useState<string | null>(null);

  const seq = React.useRef(0);
  const refresh = useCallback(async () => {
    const mine = ++seq.current;
    try {
      const next = await engineInstance.listScenarioVersions(scenarioId);
      // A slower, older request must not overwrite a newer answer
      if (mine !== seq.current) return;
      setList(next);
      setError(null);
    } catch (e: any) {
      setError(e?.message || 'Could not load versions.');
    }
  }, [scenarioId]);

  useEffect(() => {
    void refresh();
    // The head changes with every edit: re-read it (debounced) so "unsaved changes" stays true
    let t: ReturnType<typeof setTimeout> | null = null;
    const unsub = engineInstance.objects.onChange(() => {
      if (t) clearTimeout(t);
      t = setTimeout(() => void refresh(), 800);
    });
    return () => { unsub(); if (t) clearTimeout(t); };
  }, [refresh]);

  const save = async () => {
    setBusy(true);
    try {
      const v = await engineInstance.saveScenarioVersion(label.trim());
      (window as any).showToast?.(`Saved version ${v.number}${v.label ? ` "${v.label}"` : ''}.`, 'success');
      setLabel('');
      await refresh();
    } catch (e: any) {
      (window as any).showToast?.(e?.message || 'Could not save the version.', 'error');
    } finally {
      setBusy(false);
    }
  };

  const restore = async () => {
    const v = confirm;
    setConfirm(null);
    if (!v) return;
    setBusy(true);
    try {
      const r = await engineInstance.restoreScenarioVersion(v.id);
      (window as any).showToast?.(`Restored version ${v.number} as version ${r.version.number}${r.autoSaved ? ` (unsaved work kept as version ${r.autoSaved.number})` : ''}. Undo history of this proposal was cleared.`, 'success');
      await refresh();
    } catch (e: any) {
      (window as any).showToast?.(e?.message || 'Could not restore the version.', 'error');
    } finally {
      setBusy(false);
    }
  };

  const versions = list?.versions ?? [];
  const latest = versions[0];
  const unsaved = !!list && (!latest || latest.changeSetHash !== list.headChangeSetHash);
  const now = engineInstance.scenarioAssumptions();

  return (
    <div className="border-t border-white/5 pt-2.5 flex flex-col gap-1.5" data-testid="scenario-versions">
      <div className="text-xs font-semibold text-slate-300 flex items-center gap-1.5">
        <History size={13} className="text-indigo-400" /> Versions
        <span className={`ml-auto text-[11px] ${unsaved ? 'text-amber-300' : 'text-slate-500'}`} data-testid="versions-status">
          {list ? (unsaved ? 'Unsaved changes' : `At version ${latest?.number}`) : ''}
        </span>
      </div>
      <div className="flex gap-1.5">
        <input
          className="flex-1 min-w-0 bg-slate-900 border border-white/10 rounded-lg px-2 py-1 text-xs text-slate-100 focus:outline-none focus:border-indigo-400"
          placeholder="Version label (optional)" value={label} maxLength={120} onChange={e => setLabel(e.target.value)} aria-label="Version label"
          onKeyDown={e => { if (e.key === 'Enter') void save(); }}
        />
        <button className="px-2 py-1 rounded-lg bg-indigo-600 hover:bg-indigo-500 disabled:opacity-50 text-white text-xs flex items-center gap-1 cursor-pointer"
          onClick={() => void save()} disabled={busy} aria-label="Save version" data-testid="save-version">
          <Save size={12} /> Save
        </button>
      </div>
      {error && <p className="text-xs text-rose-300">{error}</p>}
      <ul className="flex flex-col gap-1 max-h-48 overflow-y-auto" data-testid="version-list">
        {versions.map(v => {
          const diffs = assumptionDifferences(v.assumptions ?? {}, now);
          const baselineChanged = !!list && v.baselineFingerprint !== list.baselineFingerprint;
          return (
            <li key={v.id} className="bg-slate-900/60 border border-white/5 rounded-lg px-2 py-1 text-xs text-slate-300" data-testid={`version-${v.number}`}>
              <div className="flex items-center gap-1.5">
                <button className="text-left flex-1 min-w-0 truncate cursor-pointer" onClick={() => setOpen(open === v.id ? null : v.id)} title="Show assumptions">
                  <span className="font-mono text-indigo-300">v{v.number}</span> {v.label}
                  <span className="text-slate-500"> · {v.changeCount} change{v.changeCount === 1 ? '' : 's'}</span>
                </button>
                <button className="p-1 rounded border border-white/5 hover:bg-slate-800 disabled:opacity-40 cursor-pointer" title={`Restore version ${v.number}`}
                  aria-label={`Restore version ${v.number}`} disabled={busy} onClick={() => setConfirm(v)} data-testid={`restore-${v.number}`}>
                  <RotateCcw size={11} />
                </button>
              </div>
              {open === v.id && (
                <div className="mt-1 text-[11px] text-slate-400 space-y-0.5">
                  <div>{v.createdAt ? new Date(v.createdAt).toLocaleString() : ''}{v.restoredFromVersionId ? ` · restored from ${versions.find(x => x.id === v.restoredFromVersionId)?.label ?? 'an earlier version'}` : ''}</div>
                  {baselineChanged && <div className="text-amber-300">The baseline has changed since this version was saved.</div>}
                  {diffs.length === 0
                    ? <div>Assumptions match the current simulation settings.</div>
                    : diffs.map(d => <div key={d.key}>{d.label}: saved {d.a} · now {d.b}</div>)}
                </div>
              )}
            </li>
          );
        })}
        {list && versions.length === 0 && <li className="text-xs text-slate-500">No versions saved yet.</li>}
      </ul>
      <ConfirmDialog
        isOpen={!!confirm}
        title="Restore version"
        message={`Make version ${confirm?.number} ("${confirm?.label}") the current state of this proposal? Unsaved changes are saved as a version first; no version is removed.`}
        confirmText="Restore"
        onConfirm={() => void restore()}
        onCancel={() => setConfirm(null)}
      />
    </div>
  );
};

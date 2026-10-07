import React, { useCallback, useEffect, useState } from 'react';
import { createPortal } from 'react-dom';
import { GitFork, ArrowLeftRight, Activity, Plus, Copy, Pencil, Trash2 } from 'lucide-react';
import { engineInstance } from '../engine/TwinCityEngine';
import type { Scenario } from '../engine/scenarios/ScenarioManager';
import { compareScenario } from '../engine/scenarios/scenarioComparison';
import { ConfirmDialog } from './ui/ConfirmDialog';

const signed = (n: number, digits = 0) => `${n > 0 ? '+' : n < 0 ? '−' : '±'}${Math.abs(n).toLocaleString(undefined, { maximumFractionDigits: digits })}`;

type FormMode = { kind: 'new' } | { kind: 'duplicate'; source: Scenario } | { kind: 'edit'; target: Scenario };

export const ScenarioSelector: React.FC = () => {
  const [scenarios, setScenarios] = useState<Scenario[]>(engineInstance.scenarios.getAll());
  const [activeId, setActiveId] = useState(engineInstance.scenarios.getActiveScenarioId());
  const [compareMode, setCompareMode] = useState(false);
  const [, setObjectsVersion] = useState(0);
  const [form, setForm] = useState<FormMode | null>(null);
  const [confirmDelete, setConfirmDelete] = useState<Scenario | null>(null);

  useEffect(() => {
    const unsubScen = engineInstance.scenarios.onChange((scens, active) => {
      setScenarios(scens);
      setActiveId(active);
    });
    // Recompute the comparison when objects change (only matters while it's shown)
    const unsubObj = engineInstance.objects.onChange(() => setObjectsVersion(v => v + 1));
    return () => {
      unsubScen();
      unsubObj();
    };
  }, []);

  const activeScenario = scenarios.find(s => s.id === activeId);
  const isProposal = !!activeScenario && !activeScenario.isBase;

  // Recomputed on every render; objectsVersion changes trigger a render when objects change
  const comparison = compareMode && isProposal ? compareScenario(engineInstance.objects.getAll(), activeId) : null;

  const handleDelete = useCallback(async () => {
    const target = confirmDelete;
    setConfirmDelete(null);
    if (!target) return;
    try {
      const removed = await engineInstance.deleteScenario(target.id);
      (window as any).showToast?.(`Deleted "${target.name}" and ${removed} object(s). Undo history was cleared.`, 'info');
    } catch (err: any) {
      (window as any).showToast?.(err.message || 'Failed to delete scenario.', 'error');
    }
  }, [confirmDelete]);

  const iconBtn = 'p-1.5 rounded-lg border border-white/5 text-slate-300 hover:text-white hover:bg-slate-800/60 cursor-pointer transition disabled:opacity-40 disabled:cursor-not-allowed';

  return (
    <div className="w-full rounded-2xl p-3 flex flex-col pointer-events-auto bg-slate-950/90 backdrop-blur-xl border border-white/10 shadow-2xl shadow-black/40 gap-2.5">
      {/* Selector + actions */}
      <div className="flex flex-col gap-1.5">
        <label htmlFor="scenario-select" className="text-xs font-semibold text-slate-400 flex items-center gap-1.5">
          <GitFork size={14} className="text-indigo-300" />
          Scenario
        </label>
        <div className="flex items-center gap-1.5">
          <select
            id="scenario-select"
            value={activeId}
            onChange={(e) => engineInstance.scenarios.setActiveScenario(e.target.value)}
            title={activeScenario?.description || undefined}
            className="flex-1 min-w-0 bg-slate-900 border border-white/10 rounded-xl px-2.5 py-2 text-sm text-slate-100 focus:outline-none focus:border-indigo-400 cursor-pointer"
          >
            {scenarios.map((scen) => (
              <option key={scen.id} value={scen.id}>
                {scen.name} ({scen.year})
              </option>
            ))}
          </select>
        </div>
        <div className="flex items-center gap-1.5">
          <button className={iconBtn} title="New proposal (starts from the base city)" aria-label="New proposal" onClick={() => setForm({ kind: 'new' })}>
            <Plus size={13} />
          </button>
          <button
            className={iconBtn}
            title={isProposal ? 'Duplicate this proposal' : 'Duplicate — base is shared by every proposal, so this creates an empty proposal'}
            aria-label="Duplicate scenario"
            onClick={() => activeScenario && setForm({ kind: 'duplicate', source: activeScenario })}
          >
            <Copy size={13} />
          </button>
          <button className={iconBtn} title="Rename / edit" aria-label="Edit scenario" disabled={!isProposal} onClick={() => activeScenario && setForm({ kind: 'edit', target: activeScenario })}>
            <Pencil size={13} />
          </button>
          <button className={`${iconBtn} hover:text-rose-300`} title="Delete proposal" aria-label="Delete scenario" disabled={!isProposal} onClick={() => activeScenario && setConfirmDelete(activeScenario)}>
            <Trash2 size={13} />
          </button>
          <span className="text-xs text-slate-500 ml-auto">
            {isProposal ? 'New work goes into this proposal' : 'The existing city'}
          </span>
        </div>
      </div>

      {/* Comparison Toggle */}
      {isProposal && (
        <div className="flex items-center justify-between border-t border-white/5 pt-2.5">
          <span className="text-xs font-semibold text-slate-300 flex items-center gap-1.5">
            <ArrowLeftRight size={13} className="text-indigo-400" />
            Compare with Base City
          </span>
          <label className="relative inline-flex items-center cursor-pointer">
            <input
              type="checkbox"
              checked={compareMode}
              onChange={(e) => setCompareMode(e.target.checked)}
              className="sr-only peer"
              aria-label="Compare with base city"
            />
            <div className="w-8 h-4 bg-slate-800 rounded-full peer peer-focus:ring-0 peer-checked:after:translate-x-full peer-checked:after:border-white after:content-[''] after:absolute after:top-0.5 after:left-[2px] after:bg-slate-400 after:border-slate-300 after:border after:rounded-full after:h-3 after:w-3 after:transition-all peer-checked:bg-indigo-600 peer-checked:after:bg-slate-100"></div>
          </label>
        </div>
      )}

      {/* Comparison Metrics Panel */}
      {comparison && (
        <div className="bg-indigo-950/20 border border-indigo-500/20 rounded-xl p-3 space-y-2 animate-fade-in">
          <div className="text-xs font-bold text-indigo-400 uppercase tracking-widest font-mono flex items-center gap-1 border-b border-indigo-500/10 pb-1.5">
            <Activity size={11} /> What this proposal adds
          </div>

          <div className="space-y-1.5 text-xs">
            <Row label="New road capacity" value={`${comparison.newRoadLaneKm.toFixed(2)} lane-km`} />
            <Row label="New flyover length" value={`${comparison.newFlyoverKm.toFixed(2)} km`} />
            <Row label="New metro track" value={`${comparison.newMetroKm.toFixed(2)} km`} />
            <Row label="New stations / buildings" value={`${comparison.newStations} / ${comparison.newBuildings}`} />
            <Row label="Population (modelled)" value={signed(comparison.popDelta)} />
            <Row label="Water demand" value={`${signed(comparison.waterDelta / 1000, 1)} m³/day`} />
            <Row label="Electricity demand" value={`${signed(comparison.elecDelta / 1000, 1)} MWh/day`} />
          </div>
          <p className="text-xs text-slate-500 leading-snug border-t border-white/5 pt-1.5">
            Lengths are measured from drawn geometry; demand figures sum each building's attributes.
            Traffic impact needs a simulation run and is not estimated here.
          </p>
        </div>
      )}

      {form && (
        <ScenarioForm
          mode={form}
          onClose={() => setForm(null)}
        />
      )}

      <ConfirmDialog
        isOpen={!!confirmDelete}
        title="Delete Scenario"
        message={`Delete "${confirmDelete?.name}" and every object drawn in it? This cannot be undone.`}
        confirmText="Delete scenario"
        onConfirm={handleDelete}
        onCancel={() => setConfirmDelete(null)}
      />
    </div>
  );
};

const Row: React.FC<{ label: string; value: string }> = ({ label, value }) => (
  <div className="flex items-center justify-between">
    <span className="text-slate-400">{label}</span>
    <span className="text-slate-100 font-semibold font-mono">{value}</span>
  </div>
);

const ScenarioForm: React.FC<{ mode: FormMode; onClose: () => void }> = ({ mode, onClose }) => {
  const initial =
    mode.kind === 'edit'
      ? mode.target
      : mode.kind === 'duplicate'
        ? { name: `${mode.source.name} (copy)`, description: mode.source.description, year: mode.source.year }
        : { name: '', description: '', year: new Date().getFullYear() + 2 };

  const [name, setName] = useState(initial.name);
  const [description, setDescription] = useState(initial.description);
  const [year, setYear] = useState(String(initial.year));
  const [saving, setSaving] = useState(false);

  const title = mode.kind === 'edit' ? 'Edit Scenario' : mode.kind === 'duplicate' ? 'Duplicate Scenario' : 'New Proposal';

  const submit = async () => {
    setSaving(true);
    try {
      const input = { name, description, year: Number(year) };
      if (mode.kind === 'edit') {
        await engineInstance.scenarios.updateScenario(mode.target.id, input);
        (window as any).showToast?.('Scenario updated.', 'success');
      } else {
        const sourceId = mode.kind === 'duplicate' ? mode.source.id : null;
        const created = await engineInstance.createScenarioFrom(sourceId, input);
        (window as any).showToast?.(`Created "${created.name}". New objects you draw now belong to it.`, 'success');
      }
      onClose();
    } catch (err: any) {
      (window as any).showToast?.(err.message || 'Failed to save scenario.', 'error');
    } finally {
      setSaving(false);
    }
  };

  const onKeyDown = (e: React.KeyboardEvent) => {
    if (e.key === 'Escape') onClose();
    else if (e.key === 'Enter' && (e.target as HTMLElement).tagName !== 'TEXTAREA') submit();
  };

  const input = 'bg-slate-950/80 border border-slate-700/60 rounded-xl px-3 py-2 text-slate-100 text-xs focus:outline-none focus:border-indigo-500';

  return createPortal(
    <div className="fixed inset-0 bg-slate-950/75 backdrop-blur-sm flex items-center justify-center z-[9999] p-4" role="dialog" aria-modal="true" aria-label={title} onClick={onClose}>
      <div className="glass-panel bg-slate-900/95 p-5 rounded-2xl flex flex-col gap-3 w-full max-w-sm border border-indigo-500/20 shadow-2xl animate-scale-in" onClick={e => e.stopPropagation()} onKeyDown={onKeyDown}>
        <h3 className="text-slate-100 font-semibold text-sm">{title}</h3>
        {mode.kind === 'duplicate' && (
          <p className="text-sm text-slate-400">
            {mode.source.isBase
              ? 'The base city is shared by every proposal, so this starts an empty proposal on top of it.'
              : `Copies every object drawn in "${mode.source.name}".`}
          </p>
        )}
        <label className="flex flex-col gap-1 text-xs text-slate-400 uppercase font-semibold">
          Name
          <input autoFocus className={input} value={name} onChange={e => setName(e.target.value)} placeholder="e.g. Hinjewadi Phase 1 flyover" maxLength={120} />
        </label>
        <label className="flex flex-col gap-1 text-xs text-slate-400 uppercase font-semibold">
          Description
          <textarea className={`${input} resize-none h-16`} value={description} onChange={e => setDescription(e.target.value)} maxLength={500} />
        </label>
        <label className="flex flex-col gap-1 text-xs text-slate-400 uppercase font-semibold">
          Target year
          <input type="number" className={input} value={year} onChange={e => setYear(e.target.value)} min={1900} max={2200} />
        </label>
        <div className="flex gap-2 text-xs font-semibold pt-1">
          <button onClick={submit} disabled={saving} className="flex-1 bg-indigo-600 hover:bg-indigo-500 disabled:opacity-60 text-white rounded-xl py-2 cursor-pointer">
            {saving ? 'Saving…' : 'Save'}
          </button>
          <button onClick={onClose} className="bg-slate-800 hover:bg-slate-700 text-slate-300 rounded-xl px-4 py-2 cursor-pointer">
            Cancel
          </button>
        </div>
      </div>
    </div>,
    document.body
  );
};

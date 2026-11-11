/**
 * Scenario versions as the backend returns them (backend/api/scenario_router.py, docs/SCENARIOS_AND_VERSIONING.md).
 * A version is an immutable snapshot of a proposal's change set and the assumptions it was saved with.
 */
export interface ScenarioVersion {
  id: string;
  scenarioId: string;
  number: number;
  label: string;
  note: string;
  parentVersionId: string | null;
  restoredFromVersionId: string | null;
  baselineId: string;
  /** sha256 of the baseline objects' content when the version was saved, with the object count. */
  baselineFingerprint: string;
  changeSetHash: string;
  changeCount: number;
  assumptions: Record<string, unknown>;
  createdAt: string | null;
}

export interface ScenarioVersionList {
  scenarioId: string;
  /** Hash of the proposal's current change set: equal to a version's when nothing changed since it. */
  headChangeSetHash: string;
  baselineFingerprint: string;
  versions: ScenarioVersion[];
}

/** Labels for assumption keys shown in the versions list and comparisons. */
export const ASSUMPTION_LABELS: Record<string, string> = {
  demandKey: 'Demand (content key)', demandVersion: 'Demand version', demandFrozen: 'Frozen baseline demand', trips: 'OD trips', plannedVph: 'Planned demand (veh/h)',
  hour: 'Clock hour', day: 'Day type', hourFactor: 'Hour factor', seeds: 'Seeds', warmupS: 'Warm-up (s)', measureS: 'Measured period (s)',
  signalTiming: 'Signal timing', signalSource: 'Signal locations', networkCorrections: 'Network corrections', demandLevel: 'Demand level',
  demandSettings: 'Demand settings', engineVersion: 'Engine version',
};

/** Assumptions that differ between two records, by key (values as JSON for display). */
export function assumptionDifferences(a: Record<string, unknown>, b: Record<string, unknown>): { key: string; label: string; a: string; b: string }[] {
  const show = (v: unknown) => (v === undefined ? '—' : typeof v === 'string' ? v : JSON.stringify(v));
  const keys = [...new Set([...Object.keys(a), ...Object.keys(b)])].sort();
  return keys.filter(k => JSON.stringify(a[k]) !== JSON.stringify(b[k])).map(k => ({ key: k, label: ASSUMPTION_LABELS[k] ?? k, a: show(a[k]), b: show(b[k]) }));
}

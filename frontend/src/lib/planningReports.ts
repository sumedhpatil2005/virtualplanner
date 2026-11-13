/** View-model helpers for the Reports workspace (pure; unit-tested). */
import type { AuditEvent } from '../engine/planning/planningApi';
import type { StaleVerdict } from './coordinationApi';

export interface ReportScopeInfo {
  alternatives: number; datasets: number; assessments: number; runs: number; decisions: number;
  /** Findings visible to the project; null = could not be read (not 0). */
  issues: number | null;
  lastDetection: (StaleVerdict & { id: string; created_at: string }) | null;
  lastPdf: string | null; lastDocx: string | null; lastCsv: string | null;
}

/** Time of the newest `export` audit event of the project with this label (e.g. "PDF report"), or null = never. */
export function lastExport(events: readonly Pick<AuditEvent, 'action' | 'label' | 'at' | 'entity_type'>[], label: string): string | null {
  let best: string | null = null;
  for (const e of events) {
    if (e.action !== 'export' || e.entity_type !== 'project_report' || e.label !== label) continue;
    if (best == null || e.at > best) best = e.at;
  }
  return best;
}

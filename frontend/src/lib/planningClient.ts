/**
 * Small read clients used by the Projects & Reports workspaces that are not in planningApi / coordinationApi:
 * an alternative's change set and versions (scenario_router), traffic dataset provenance (traffic_data_router),
 * and the conflict-summary CSV export (coordination_router, added for the Reports workspace).
 */
import { API_BASE, apiGet } from './api';
import type { ChangeSetEntry } from './planningProjects';

export interface ScenarioVersionInfo { id: string; scenarioId: string; number: number; label: string; changeCount: number; createdAt: string | null }
export interface TrafficDatasetInfo {
  id: string; name: string; provider: string; kind: string; method: string; collected_from: string | null; collected_to: string | null;
  location_desc: string; period_desc: string; role: string; entered_by: string; imported_file_name: string | null;
  imported_file_sha256: string | null; synthetic: boolean; record_count: number | null; created_at: string;
}

const e = encodeURIComponent;
export const planningClient = {
  changeSet: (sid: string) => apiGet<{ scenarioId: string; changeSetHash: string; changes: ChangeSetEntry[] }>(`/api/scenarios/${e(sid)}/change-set`),
  versions: (sid: string) => apiGet<{ headChangeSetHash: string; versions: ScenarioVersionInfo[] }>(`/api/scenarios/${e(sid)}/versions`).then(r => r.versions),
  trafficDataset: (id: string) => apiGet<TrafficDatasetInfo>(`/api/traffic-data/datasets/${e(id)}`),
  conflictCsvUrl: (pid: string, by: string) => `${API_BASE}/api/coordination/projects/${e(pid)}/conflicts/export?format=csv&requested_by=${e(by)}`,
};

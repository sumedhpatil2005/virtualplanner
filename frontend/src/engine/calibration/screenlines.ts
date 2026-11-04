import { apiGet } from '../../lib/api';
import type { RoadAnalysisResult } from '../simulation/RoadAnalysis';

/**
 * Mid-block counts on roads (river bridges), both directions together, from
 * backend/data/observed_screenlines. Used as an independent check of the
 * model's volumes: nothing is fitted to them.
 */
export interface ScreenlineStation {
  id: string; name: string; osmWays: number[]; peakHour: string; peakStartHour: number;
  peakVehicles: number; peakPcu: number; day12hVehicles: number; twoWheelerShare12h?: number; comparable: boolean; note?: string;
}
export interface ScreenlineFile { id: string; name: string; source: { title: string; tables: string; url: string; surveyYear: number; note: string }; stations: ScreenlineStation[] }

export const DEFAULT_SCREENLINES = 'pune_cmp2008_river';
export const fetchScreenlines = (id = DEFAULT_SCREENLINES) => apiGet<ScreenlineFile>(`/api/observed-screenlines/${encodeURIComponent(id)}`);

/** Road ids the importer gives an OSM way (whole, or pieces cut at a mapped area's edge). */
const wayOf = (roadId: string) => { const m = /^osm_(\d+)/.exec(roadId); return m ? Number(m[1]) : null; };

export interface ScreenlineCheck {
  station: ScreenlineStation;
  /** Model volume over both directions (veh/h) at the analysis hour: area assignment, and simulated where the road is in the corridor. */
  modelVph: number;
  simulatedVph: number | null;
  /** GEH of the model against the count (only meaningful at the count's hour). */
  geh: number;
  sameHour: boolean;
}

/**
 * The model's volume on every counted road in the area, from the analysis
 * result (the assignment's link volumes; the busiest piece of each direction).
 */
export function screenlineChecks(file: ScreenlineFile | null, r: RoadAnalysisResult | null | undefined, hour: number | null): ScreenlineCheck[] {
  if (!file || !r) return [];
  const out: ScreenlineCheck[] = [];
  for (const st of file.stations) {
    const ways = new Set(st.osmWays);
    let fwd = 0, bwd = 0, found = false;
    r.areaLinkVph.forEach((vph, linkId) => {
      const w = wayOf(linkId);
      if (w === null || !ways.has(w)) return;
      found = true;
      if (linkId.endsWith('_bwd')) bwd = Math.max(bwd, vph); else fwd = Math.max(fwd, vph);
    });
    if (!found) continue;
    // Separate one-way ways of one bridge (two carriageways) each count as one direction
    const modelVph = st.osmWays.length > 1 ? sumByWay(r.areaLinkVph, st.osmWays) : fwd + bwd;
    let simF = 0, simB = 0, simFound = false;
    r.linkVph.forEach((vph, linkId) => { const w = wayOf(linkId); if (w === null || !ways.has(w)) return; simFound = true; if (linkId.endsWith('_bwd')) simB = Math.max(simB, vph); else simF = Math.max(simF, vph); });
    const simulatedVph = simFound ? (st.osmWays.length > 1 ? sumByWay(r.linkVph, st.osmWays) : simF + simB) : null;
    const m = modelVph, c = st.peakVehicles;
    out.push({ station: st, modelVph: Math.round(m), simulatedVph: simulatedVph === null ? null : Math.round(simulatedVph), geh: Math.sqrt(2 * (m - c) ** 2 / Math.max(1, m + c)), sameHour: hour === st.peakStartHour || hour === st.peakStartHour + 1 });
  }
  return out;
}

function sumByWay(vph: ReadonlyMap<string, number>, ways: readonly number[]) {
  let total = 0;
  for (const w of ways) {
    let f = 0, b = 0;
    vph.forEach((v, id) => { if (wayOf(id) !== w) return; if (id.endsWith('_bwd')) b = Math.max(b, v); else f = Math.max(f, v); });
    total += f + b;
  }
  return total;
}

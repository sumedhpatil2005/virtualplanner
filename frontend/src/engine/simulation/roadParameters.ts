import type { DrivableObject } from './StudyAreaExplorer';
import { roadKeys } from './roadSection';

/**
 * Free-flow speeds and mid-block capacities for urban roads in Pune.
 *
 * Why this exists (docs/OVERHAUL.md §3): the importer gave every OSM road
 * without a maxspeed tag a class default of 100 km/h (trunk/motorway), 60
 * (primary/secondary) or 50 km/h. Shivaji Bridge (way 22841323, trunk, no
 * maxspeed) was therefore "free-flowing" at 100 km/h, simulated vehicles drove
 * it at 100 km/h, and an ordinary urban 27-44 km/h read as "congested" because
 * it was under half of 100. Inside a municipal area that speed is neither legal
 * nor realistic.
 *
 * Speeds, in order of preference:
 *  1. the way's own OSM maxspeed tag;
 *  2. a maxspeed tagged on a connected piece of the same road (same name or
 *     ref and the same OSM highway class) - OSM often tags only one piece;
 *  3. an urban default by OSM highway class (assumption, below), never above
 *     the legal ceiling for municipal areas in Maharashtra.
 * Roads drawn in Build keep the speed the user set.
 *
 * Sources:
 *  - MoRTH S.O. 1522(E), 6 April 2018: roads within municipal limits, M1 cars
 *    70 km/h, motorcycles 60 km/h (PIB release PRID=1539335).
 *  - Government of Maharashtra notification, October 2019, as reported by The
 *    Hindu (17 June 2021): municipal areas at most 60 km/h for cars, 50 km/h
 *    for motorcycles, 40 km/h for three-wheelers. Two-wheelers are about half
 *    of Pune's traffic (Gunjan Chowk counts; 64% on Shivaji Bridge in the PMC
 *    CMP 2008 screen-line count), so 50 km/h is used as the ceiling for the
 *    mixed stream.
 *  - BIGRS Pune road-safety brief (Johns Hopkins, 2025) recommends 50 km/h in
 *    urban areas and 30 km/h where traffic mixes with pedestrians.
 * The class defaults (50 / 40 / 30 / 20) follow these; they are assumptions,
 * not measured speeds.
 */
export const URBAN_SPEED_CEILING_KMH = 50;
export const URBAN_DEFAULT_SPEED_KMH: Record<string, number> = {
  motorway: 50, trunk: 50, primary: 50, secondary: 50, tertiary: 40,
  motorway_link: 40, trunk_link: 40, primary_link: 40, secondary_link: 40, tertiary_link: 30,
  unclassified: 30, residential: 30, living_street: 20, service: 20, road: 30,
};
const CLASS_DEFAULT_SPEED: Record<string, number> = { highway: 50, arterial: 50, collector: 40, local: 30 };

export type SpeedBasis = 'tagged' | 'inherited' | 'urban-default' | 'user';
export interface SpeedReport { tagged: number; inherited: number; urbanDefault: number; user: number; changed: number }

const parseMaxspeed = (v: string | undefined): number | null => {
  if (!v) return null;
  const m = /^\s*(\d+(?:\.\d+)?)\s*(mph)?/i.exec(v);
  if (!m) return null;
  const n = parseFloat(m[1]) * (m[2] ? 1.609 : 1);
  return n >= 5 && n <= 130 ? Math.round(n) : null;
};

const tagsOf = (r: DrivableObject): Record<string, string> | null => (r.type === 'road' ? r.osmProvenance?.originalTags ?? null : null);

/** Speed basis and value for every road (OSM-imported roads only change). */
export function urbanSpeeds(roads: readonly DrivableObject[]): { speeds: Map<string, { kmh: number; basis: SpeedBasis }>; report: SpeedReport } {
  const speeds = new Map<string, { kmh: number; basis: SpeedBasis }>();
  const report: SpeedReport = { tagged: 0, inherited: 0, urbanDefault: 0, user: 0, changed: 0 };
  // Pieces of the same road meeting end to end, for maxspeed inheritance
  const endKey = (c: readonly number[]) => `${c[0].toFixed(6)},${c[1].toFixed(6)}`;
  const byEnd = new Map<string, DrivableObject[]>();
  for (const r of roads) {
    if (!tagsOf(r) || r.coordinates.length < 2) continue;
    for (const c of [r.coordinates[0], r.coordinates[r.coordinates.length - 1]]) {
      const k = endKey(c);
      (byEnd.get(k) ?? byEnd.set(k, []).get(k)!).push(r);
    }
  }
  const tagged = new Map<string, number>();
  for (const r of roads) { const t = tagsOf(r); const v = parseMaxspeed(t?.maxspeed); if (v !== null) tagged.set(r.id, v); }
  const sameRoad = (a: DrivableObject, b: DrivableObject) => {
    const ta = tagsOf(a), tb = tagsOf(b);
    if (!ta || !tb || ta.highway !== tb.highway) return false;
    const ka = roadKeys(a), kb = roadKeys(b);
    return [...ka].some(k => kb.has(k));
  };
  /** Nearest tagged maxspeed along connected pieces of the same road (breadth first, at most 12 pieces away). */
  const inherited = (start: DrivableObject): number | null => {
    const seen = new Set([start.id]);
    let frontier = [start];
    for (let depth = 0; depth < 12 && frontier.length; depth++) {
      const next: DrivableObject[] = [];
      const found: number[] = [];
      for (const r of frontier) {
        for (const c of [r.coordinates[0], r.coordinates[r.coordinates.length - 1]]) {
          for (const n of byEnd.get(endKey(c)) ?? []) {
            if (seen.has(n.id) || !sameRoad(start, n)) continue;
            seen.add(n.id);
            const v = tagged.get(n.id);
            if (v !== undefined) found.push(v); else next.push(n);
          }
        }
      }
      if (found.length) return Math.min(...found);
      frontier = next;
    }
    return null;
  };
  for (const r of roads) {
    const tags = tagsOf(r);
    if (!tags) { speeds.set(r.id, { kmh: r.speedLimit || 40, basis: 'user' }); report.user++; continue; }
    const own = tagged.get(r.id);
    let kmh: number, basis: SpeedBasis;
    if (own !== undefined) { kmh = own; basis = 'tagged'; report.tagged++; }
    else {
      const inh = inherited(r);
      if (inh !== null) { kmh = inh; basis = 'inherited'; report.inherited++; }
      else {
        const hw = tags.highway ?? '';
        kmh = Math.min(URBAN_SPEED_CEILING_KMH, URBAN_DEFAULT_SPEED_KMH[hw] ?? CLASS_DEFAULT_SPEED[r.roadClass ?? 'local'] ?? 30);
        basis = 'urban-default'; report.urbanDefault++;
      }
    }
    if (kmh !== r.speedLimit) report.changed++;
    speeds.set(r.id, { kmh, basis });
  }
  return { speeds, report };
}

/** Copies of the roads with urban free-flow speeds (the stored roads are not changed). */
export function applyUrbanSpeeds<T extends DrivableObject>(roads: readonly T[]): { roads: T[]; report: SpeedReport } {
  const { speeds, report } = urbanSpeeds(roads);
  return { roads: roads.map(r => { const s = speeds.get(r.id)!; return s.kmh === r.speedLimit ? r : { ...r, speedLimit: s.kmh }; }), report };
}

// ── Mid-block capacity ───────────────────────────────────────────────────

/**
 * IRC:106-1990, Guidelines for Capacity of Urban Roads in Plain Areas,
 * Table 2 (recommended design service volumes, PCU/h, total of the
 * carriageway) and clause 8.1 (the design service volume is LOS C, about 0.70
 * of capacity). Checked against the scanned code:
 * https://archive.org/download/gov.in.irc.106.1990/irc.gov.in.106.1990_djvu.txt
 * Columns: arterial / sub-arterial / collector.
 */
export const IRC106_DSV: Record<string, [number, number, number]> = {
  '2-oneway': [2400, 1900, 1400],
  '2-twoway': [1500, 1200, 900],
  '3-oneway': [3600, 2900, 2200],
  '4-undivided': [3000, 2400, 1800],
  '4-divided': [3600, 2900, 1800],
  '6-undivided': [4800, 3800, 3800],
  '6-divided': [5400, 4300, 4300],
  '8-divided': [7200, 7200, 7200],
};
export const IRC106_DSV_TO_CAPACITY = 1 / 0.7;

/** IRC road category from the OSM class: trunk/primary arterial, secondary sub-arterial, the rest collector. */
export function ircCategory(road: DrivableObject | undefined): 0 | 1 | 2 {
  const hw = road?.type === 'road' ? road.osmProvenance?.originalTags?.highway ?? '' : '';
  if (/^(motorway|trunk|primary)/.test(hw)) return 0;
  if (/^secondary/.test(hw)) return 1;
  if (hw) return 2;
  const cls = road?.roadClass ?? 'local';
  return cls === 'highway' ? 0 : cls === 'arterial' ? 1 : 2;
}

/**
 * Mid-block capacity of one direction of travel (PCU/h), from IRC:106 Table 2.
 * `lanesThisWay` are the lanes in this direction; `twoWay` whether the same
 * carriageway carries the other direction (undivided); `divided` whether this
 * is one carriageway of a divided road (OSM maps those as two one-way ways).
 */
export function midblockCapacityPcu(road: DrivableObject | undefined, lanesThisWay: number, twoWay: boolean, divided: boolean): number {
  const cat = ircCategory(road);
  const n = Math.max(1, Math.round(lanesThisWay));
  let total: number, share: number;
  if (twoWay) {
    // Undivided two-way carriageway: the table gives the two-way total, split evenly
    const lanes = 2 * n;
    total = lanes <= 2 ? IRC106_DSV['2-twoway'][cat] : lanes <= 4 ? IRC106_DSV['4-undivided'][cat] : IRC106_DSV['6-undivided'][cat] * (lanes / 6);
    share = 0.5;
  } else if (divided) {
    const lanes = 2 * n;
    total = lanes <= 4 ? IRC106_DSV['4-divided'][cat] * (lanes / 4) : lanes <= 6 ? IRC106_DSV['6-divided'][cat] : IRC106_DSV['8-divided'][cat] * (lanes / 8);
    share = 0.5;
  } else {
    // One-way street
    total = n <= 1 ? IRC106_DSV['2-oneway'][cat] / 2 : n === 2 ? IRC106_DSV['2-oneway'][cat] : IRC106_DSV['3-oneway'][cat] * (n / 3);
    share = 1;
  }
  return total * share * IRC106_DSV_TO_CAPACITY;
}

// ── Level of service ─────────────────────────────────────────────────────

/**
 * Urban street level of service from the travel speed (including the delay at
 * the junction at its end) as a share of the free-flow speed: Indo-HCM 2017
 * (CSIR-CRRI), as tabulated in Ahmed et al. (2025), Sustainability 17(11) 5126,
 * Table 5 (A > 84%, B 76-84, C 59-76, D 41-59, E 22-41, F <= 22).
 * Cross-check: HCM 2010 Exhibit 16-4 uses 85/67/50/40/30 and F when v/c > 1.
 */
export const INDO_HCM_SPEED_LOS: [string, number][] = [['A', 0.84], ['B', 0.76], ['C', 0.59], ['D', 0.41], ['E', 0.22]];
export function speedLos(speedRatio: number | null, vc: number | null): string | null {
  if (speedRatio === null || !Number.isFinite(speedRatio)) return null;
  if (vc !== null && vc > 1) return 'F';
  for (const [los, min] of INDO_HCM_SPEED_LOS) if (speedRatio > min) return los;
  return 'F';
}

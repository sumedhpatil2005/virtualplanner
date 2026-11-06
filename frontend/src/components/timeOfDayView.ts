import type { TimelineRow } from '../engine/simulation/SimulationMode';
import type { DirectionFlow, RoadAnalysisResult, RoadStatus } from '../engine/simulation/RoadAnalysis';
import { hourLabel } from '../engine/simulation/timeOfDay';

/**
 * What the "Through the day" rows show, from the model's own figures
 * (docs/OVERHAUL.md §22): the hour and its demand factor, the demand the area
 * assignment routes onto the road, the traffic the simulation actually got
 * along it, the speed and level of service of the direction the status comes
 * from, what decided that level, and - when traffic is held - where the queue
 * was traced to. Pure: tested in TimeOfDayView.test.ts.
 */

const fmt = (n: number) => Math.round(n).toLocaleString('en-GB');
/** Below this share of its demand getting through, a period's road is reported as not serving its demand. */
export const SERVED_OK = 0.9;

export interface DayDirectionView {
  label: string;
  demandVph: number;
  throughputVph: number;
  vphBySeed: number[];
  speedKmh: number | null;
  speedBySeed: (number | null)[];
  freeSpeedKmh: number;
  los: string | null;
  losBySeed: (string | null)[];
  vc: number;
}

export interface DayRowView {
  period: string;
  label: string;
  hourText: string;
  factor: number | null;
  /** "×0.70 of the 19:00 peak" */
  factorText: string;
  /** Veh/h the area assignment routes along the road (both directions). */
  demandVph: number;
  /** Veh/h the simulation got along it (both directions, mean over seeds). */
  throughputVph: number;
  /** Demand that did not get along it in the counted window (queued or not released), when material. */
  unservedVph: number | null;
  /** Direction the status and speed are for. */
  direction: string | null;
  speedKmh: number | null;
  freeSpeedKmh: number | null;
  status: RoadStatus;
  los: string | null;
  /** What decided the level of service, in words. */
  metric: string;
  /** Queue traced downstream, when most runs agree on it. */
  heldBy: string | null;
  /** Why demand went unserved, from the run's own load check: entry blocked at the neighbourhood edge, gridlock removals. */
  unservedWhy: string | null;
  seeds: number;
  statusConsistent: boolean;
  statusBySeed: RoadStatus[];
  directions: DayDirectionView[];
}

const factorText = (row: TimelineRow) => {
  if (row.hourFactor === undefined) return '';
  const ref = row.referenceHour ?? row.hour;
  return ref === row.hour ? `×${row.hourFactor.toFixed(2)}, peak hour` : `×${row.hourFactor.toFixed(2)} of the ${hourLabel(ref)} peak`;
};

/** The direction the status is for: the one the headline explains, else the worst level of service. */
export function statusDirection(r: RoadAnalysisResult): DirectionFlow | null {
  return r.directions.find(d => d.label === r.explainedDirection) ?? r.directions[0] ?? null;
}

export function losMetric(d: DirectionFlow | null): string {
  if (!d || d.los === null) return 'no speed measured';
  if (d.losBasis === 'over-capacity') {
    const served = d.demandPcu > 0 ? Math.min(1, d.pcuph / d.demandPcu) : 1;
    return `LOS F: demand ${d.vc.toFixed(2)}× capacity, ${Math.round(100 * served)}% of it got through`;
  }
  const ratio = d.speedRatio ?? (d.meanSpeedKmh !== null && d.freeSpeedKmh > 0 ? d.meanSpeedKmh / d.freeSpeedKmh : null);
  return ratio === null ? `LOS ${d.los}` : `LOS ${d.los}: speed ${Math.round(100 * ratio)}% of free-flow`;
}

export function dayRowView(row: TimelineRow): DayRowView | null {
  const r = row.result;
  if (!r) return null;
  const d = statusDirection(r);
  const demandVph = r.directions.reduce((n, x) => n + x.demandVph, 0);
  const throughputVph = r.totalVph;
  const unserved = demandVph > 0 && throughputVph < SERVED_OK * demandVph ? demandVph - throughputVph : null;
  const chain = r.cause.kind === 'spillback' ? r.cause.chain : null;
  const n = r.seeds.length;
  const heldBy = chain?.root ? `${chain.root.label}${n > 1 ? ` (${chain.agreement}/${chain.seeds ?? n} runs)` : ''}` : null;
  const load = r.load, net = r.network;
  const why: string[] = [];
  if (load && load.servedShare < 0.85) why.push(`only ${Math.round(100 * load.servedShare)}% of the traffic routed into the simulated neighbourhood got onto its roads${net?.waitingToEnter ? ` (${fmt(net.waitingToEnter)} vehicles still waiting at its edge at the end)` : ''}`);
  if (net?.gridlockRemovals) why.push(`${fmt(net.gridlockRemovals)} vehicles removed after gridlock`);
  return {
    period: row.period, label: row.label, hourText: hourLabel(row.hour), factor: row.hourFactor ?? null, factorText: factorText(row),
    demandVph, throughputVph, unservedVph: unserved, direction: d?.label ?? null, speedKmh: d?.meanSpeedKmh ?? null, freeSpeedKmh: d?.freeSpeedKmh ?? null,
    status: r.status, los: d?.los ?? null, metric: losMetric(d), heldBy, unservedWhy: unserved !== null && why.length ? why.join('; ') : null, seeds: n, statusConsistent: r.statusConsistent, statusBySeed: r.statusBySeed,
    directions: r.directions.map(x => ({ label: x.label, demandVph: x.demandVph, throughputVph: x.vph, vphBySeed: x.vphBySeed, speedKmh: x.meanSpeedKmh, speedBySeed: x.speedBySeed,
      freeSpeedKmh: x.freeSpeedKmh, los: x.los, losBySeed: x.losBySeed, vc: x.vc })),
  };
}

const CONGESTED: RoadStatus[] = ['congested', 'severe'];

/**
 * One or two sentences on the day as a whole, from the rows only: whether the
 * road is congested in every period and why, and whether its traffic is
 * capped by something other than its own demand. Null when nothing stands out.
 */
export function daySummary(rows: TimelineRow[]): string[] {
  const done = rows.filter(r => r.result);
  if (done.length < 2) return [];
  const views = done.map(r => dayRowView(r)!);
  const out: string[] = [];
  const allCongested = views.every(v => CONGESTED.includes(v.status));
  // The quietest period: lowest hour factor (night)
  const quiet = [...done].sort((a, b) => (a.hourFactor ?? a.demandVph) - (b.hourFactor ?? b.demandVph))[0];
  const qv = dayRowView(quiet)!, qd = statusDirection(quiet.result!);
  if (allCongested) {
    const roots = views.map(v => v.heldBy?.replace(/ \(\d+\/\d+ runs\)$/, '') ?? null);
    const same = roots.every(x => x !== null && x === roots[0]);
    let s = `Congested in all ${views.length} periods.`;
    if (same) s += ` In every period the queue on it is traced to ${roots[0]}, downstream.`;
    else if (roots.some(Boolean)) s += ` The queue is traced to ${[...new Set(roots.filter(Boolean))].join(' / ')} in ${roots.filter(Boolean).length} of ${views.length} periods.`;
    else s += ' The delay is not traced to one junction in any period.';
    if (qd) {
      const served = qv.demandVph > 0 ? Math.min(1, qv.throughputVph / qv.demandVph) : 1;
      s += ` At ${qv.hourText} (${qv.factorText}) the demand on its ${qd.label} side is ${Math.round(100 * qd.vc)}% of its capacity (${fmt(qd.demandVph)} veh/h), yet it moves at ${qd.meanSpeedKmh === null ? 'no measured speed' : `${Math.round(qd.meanSpeedKmh)} km/h`}`;
      s += served >= SERVED_OK ? '; its demand gets through, slowly.' : `; ${Math.round(100 * served)}% of the road's demand gets through.`;
    }
    out.push(s);
  }
  // Traffic that barely changes while demand does: capped by something downstream, not by the road's own demand
  // (over the periods whose demand did not get through)
  const capped = views.filter(v => v.unservedVph !== null);
  const tp = capped.map(v => v.throughputVph), dm = capped.map(v => v.demandVph);
  const spread = (xs: number[]) => xs.length ? (Math.max(...xs) - Math.min(...xs)) / Math.max(1, Math.max(...xs)) : 0;
  if (capped.length >= 2 && spread(tp) < 0.15 && spread(dm) > 0.2) {
    const which = capped.length === views.length ? 'every period' : capped.map(v => v.label.toLowerCase()).join(', ');
    out.push(`Where demand is not served (${which}) the simulated traffic is about the same, ${fmt(Math.min(...tp))}–${fmt(Math.max(...tp))} veh/h, while the demand routed onto the road ranges ${fmt(Math.min(...dm))}–${fmt(Math.max(...dm))} veh/h: the road carries what gets past the hold-up, not what is routed, so its traffic does not follow the hour.`);
  }
  // Past capacity, more demand can move fewer vehicles (queues block the junctions they back through)
  const busiest = [...capped].sort((a, b) => b.demandVph - a.demandVph)[0];
  const moreThrough = busiest ? capped.filter(v => v.demandVph < busiest.demandVph && v.throughputVph > 1.05 * busiest.throughputVph).sort((a, b) => b.throughputVph - a.throughputVph)[0] : undefined;
  if (busiest && moreThrough) {
    const the = (v: DayRowView) => /peak/i.test(v.label) ? `the ${v.label.toLowerCase()}` : v.label.toLowerCase();
    out.push(`Less got through at ${the(busiest)} (${fmt(busiest.throughputVph)} of ${fmt(busiest.demandVph)} veh/h) than at ${the(moreThrough)} (${fmt(moreThrough.throughputVph)} of ${fmt(moreThrough.demandVph)}): past capacity, queues back through junctions and block them, so more demand moves fewer vehicles. Compare demand, not got through, between periods.`);
  }
  return out;
}

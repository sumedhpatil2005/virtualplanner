/**
 * "Through the day" (docs/OVERHAUL.md §22): each period runs on its own hour
 * factor, its own assignment and its own corridor runs, with the same plan
 * and seeds as the analysis; rows go outdated when the network or demand
 * changes; the rows say demand, what got through, and what set the level.
 */
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import * as fs from 'fs';
import { resolve } from 'path';
import type { RoadObject } from '../objects/types';
import type { DrivableObject } from '../simulation/StudyAreaExplorer';
import type { TimelineRow } from '../simulation/SimulationMode';

const PROFILE = JSON.parse(fs.readFileSync(resolve(__dirname, '../../../../backend/data/diurnal/pune_hourly_profile_v1.json'), 'utf8'));
const fetchProfile = vi.fn();
vi.mock('../simulation/timeOfDay', async orig => ({ ...(await orig<typeof import('../simulation/timeOfDay')>()), fetchDiurnalProfile: () => fetchProfile() }));
const { SimulationMode } = await import('../simulation/SimulationMode');
const { dayRowView, daySummary } = await import('../../components/timeOfDayView');

const LAT0 = 18.5, M_LAT = 1 / 111320, M_LNG = 1 / (111320 * Math.cos((LAT0 * Math.PI) / 180));
const pt = (x: number, y: number): [number, number, number] => [73.8 + x * M_LNG, LAT0 + y * M_LAT, 0];
const road = (id: string, a: number, b: number, lanes = 2): RoadObject => ({ id, type: 'road', name: id, layerId: 'roads', scenarioId: 'base', coordinates: [pt(a, 0), pt(b, 0)],
  roadClass: 'arterial', width: 10, laneCount: lanes, laneWidth: 3.5, hasDivider: false, dividerWidth: 0, hasFootpath: false, footpathWidth: 0,
  speedLimit: 50, isOneWay: false, trafficCapacity: 2000, connectedJunctions: [], createdAt: '', updatedAt: '' });
const corridor = (): DrivableObject[] => { const r: DrivableObject[] = [road('mid', 0, 600)]; for (let x = 0; x > -1000; x -= 250) r.push(road(`w${-x}`, x - 250, x)); for (let x = 600; x < 1600; x += 250) r.push(road(`e${x}`, x, x + 250)); return r; };
const share = (h: number) => PROFILE.weekday.hours[h].share;

describe('Through the day', () => {
  beforeEach(() => {
    vi.stubGlobal('requestAnimationFrame', () => 0);
    vi.stubGlobal('cancelAnimationFrame', () => {});
    fetchProfile.mockReset();
    fetchProfile.mockResolvedValue(PROFILE);
  });
  afterEach(() => vi.unstubAllGlobals());

  const setup = (roads = corridor()) => {
    const mode = new SimulationMode(() => roads);
    mode.analysisSeeds = [42, 7];
    mode.enter();
    mode.setRange(500);
    mode.selectRoad('mid', false);
    return { mode, roads };
  };

  it('runs each period on its own factor, assignment and seeds, with the plan the analysis uses (hypothetical scale included)', async () => {
    const { mode } = setup();
    await mode.runAnalysis();
    const am = mode.getState().analysis.output!.result;
    mode.setDemandSettings({ hypotheticalScale: 2 });
    await mode.runAnalysis();
    const am2 = mode.getState().analysis;
    expect(await mode.runTimeline()).toBe(true);
    const rows = mode.getState().timeline.rows;
    const expected: Record<string, number> = { am: 1, midday: share(14) / share(19), pm: 1, night: share(23) / share(19) };
    for (const row of rows) {
      expect(row.hourFactor, row.period).toBeCloseTo(expected[row.period], 9);
      expect(row.referenceHour).toBe(row.hour < 12 ? 9 : 19);
      expect(row.seeds).toEqual([42, 7]);
      expect(row.result!.seeds).toEqual([42, 7]);
      // The hypothetical scale reaches the time-of-day runs (before, they compiled the plan without it)
      expect(row.demandSource).toBe('hypothetical');
      expect(row.demandVph).toBeCloseTo(row.plannedVph! * row.hourFactor!, 6);
      // Its own assignment: the area assignment's demand is this period's, not another's scaled
      expect(row.result!.assignment.demandVph).toBeCloseTo(row.demandVph, 0);
    }
    // The 09:00 row is the analysis at 09:00 (same plan, factor, seeds): identical figures
    const amRow = rows.find(r => r.period === 'am')!.result!;
    expect(amRow.directions.map(d => [d.demandVph, d.vph, d.meanSpeedKmh])).toEqual(am2.output!.result.directions.map(d => [d.demandVph, d.vph, d.meanSpeedKmh]));
    expect(amRow.totalVph).not.toBe(am.totalVph);
    // Night demand on the road is the night share of the evening's
    const road = (p: string) => rows.find(r => r.period === p)!.result!.directions.reduce((n, d) => n + d.demandVph, 0);
    expect(road('night') / road('pm')).toBeCloseTo(expected.night, 1);
    mode.exit();
  }, 240000);

  it('rows go outdated when the network or the demand settings change, and current again when changed back', async () => {
    const { mode } = setup();
    await mode.runTimeline();
    expect(mode.getState().timeline.outdated).toBe(false);
    mode.setDemandSettings({ hypotheticalScale: 1.5 });
    expect(mode.getState().timeline.outdated).toBe(true);
    mode.setDemandSettings({ hypotheticalScale: null });
    expect(mode.getState().timeline.outdated).toBe(false);
    mode.exit();
  }, 240000);
});

describe('Through-the-day rows', () => {
  const dir = (o: Partial<Record<string, unknown>>) => ({ label: 'eastbound', demandVph: 1000, demandPcu: 1000, vph: 400, pcuph: 400, meanSpeedKmh: 3, freeSpeedKmh: 50, speedRatio: 0.06, los: 'F', losBasis: 'speed', losBySeed: ['F'], vphBySeed: [400], speedBySeed: [3], vc: 0.8, ...o });
  const row = (period: string, hour: number, factor: number, d: ReturnType<typeof dir>, held: string | null, status = 'severe'): TimelineRow => ({
    period: period as TimelineRow['period'], label: period, hour, demandVph: 0, hourFactor: factor, referenceHour: hour < 12 ? 9 : 19, seeds: [42],
    result: { directions: [d], totalVph: d.vph, status, statusConsistent: true, statusBySeed: [status], seeds: [42], explainedDirection: d.label,
      cause: held ? { kind: 'spillback', text: '', chain: { root: { label: held }, agreement: 1, seeds: 1 } } : { kind: 'none', text: '', chain: null } } as never });

  it('shows demand and what got through apart, the unserved part, what set the level and the traced queue', () => {
    const v = dayRowView(row('am', 9, 1, dir({}), 'A / B'))!;
    expect(v.factorText).toBe('×1.00, peak hour');
    expect([v.demandVph, v.throughputVph, v.unservedVph]).toEqual([1000, 400, 600]);
    expect(v.metric).toBe('LOS F: speed 6% of free-flow');
    expect(v.heldBy).toBe('A / B');
    const forced = dayRowView(row('pm', 19, 1, dir({ vc: 1.4, demandPcu: 1400, pcuph: 700, losBasis: 'over-capacity', speedRatio: 0.7 }), null))!;
    expect(forced.metric).toBe('LOS F: demand 1.40× capacity, 50% of it got through');
    expect(dayRowView(row('midday', 14, 0.6956, dir({}), null))!.factorText).toBe('×0.70 of the 19:00 peak');
  });

  it('a road congested in every period by the same downstream queue, with capped traffic, says so from the rows', () => {
    const rows = [
      row('am', 9, 1, dir({ demandVph: 2600, vph: 1110 }), 'X / Y'), row('midday', 14, 0.7, dir({ demandVph: 1800, vph: 1200 }), 'X / Y'),
      row('pm', 19, 1, dir({ demandVph: 2600, vph: 1140 }), 'X / Y'), row('night', 23, 0.18, dir({ demandVph: 470, vph: 460, vc: 0.2, meanSpeedKmh: 12, speedRatio: 0.24, los: 'E' }), 'X / Y', 'congested'),
    ];
    const s = daySummary(rows);
    expect(s[0]).toContain('Congested in all 4 periods. In every period the queue on it is traced to X / Y, downstream.');
    expect(s[0]).toContain('At 23:00 (×0.18 of the 19:00 peak) the demand on its eastbound side is 20% of its capacity (470 veh/h), yet it moves at 12 km/h; its demand gets through, slowly.');
    // Night is served, so only three periods are capped: still the same 1,110-1,150 against 1,800-2,600
    expect(s[1]).toContain('1,110–1,200 veh/h');
    // The midday-above-morning pattern is explained, not left to look like an error
    expect(s[2]).toBe('Less got through at am (1,110 of 2,600 veh/h) than at midday (1,200 of 1,800): past capacity, queues back through junctions and block them, so more demand moves fewer vehicles. Compare demand, not got through, between periods.');
  });
});

/**
 * The clock's demand needs the hour-of-day profile (docs/OVERHAUL.md §19).
 *
 * The profile was fetched only by the hour-of-day chart, which since the panel
 * redesign sits in the Details tab. Choosing "Midday" in the run bar without
 * ever opening Details set the clock to 14:00 with demand factor 1 (the
 * morning peak's demand): the user's 14:00 run showed morning-level loads.
 * Now the profile loads when Simulate opens and before every analysis; if it
 * cannot be loaded the state says so and the result is kept under its own key.
 */
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import * as fs from 'fs';
import { resolve } from 'path';
import type { RoadObject } from '../objects/types';
import type { DrivableObject } from '../simulation/StudyAreaExplorer';

const PROFILE = JSON.parse(fs.readFileSync(resolve(__dirname, '../../../../backend/data/diurnal/pune_hourly_profile_v1.json'), 'utf8'));
const fetchProfile = vi.fn();
vi.mock('../simulation/timeOfDay', async orig => ({ ...(await orig<typeof import('../simulation/timeOfDay')>()), fetchDiurnalProfile: () => fetchProfile() }));
const { SimulationMode } = await import('../simulation/SimulationMode');

const LAT0 = 18.5, M_LAT = 1 / 111320, M_LNG = 1 / (111320 * Math.cos((LAT0 * Math.PI) / 180));
const pt = (x: number, y: number): [number, number, number] => [73.8 + x * M_LNG, LAT0 + y * M_LAT, 0];
const road = (id: string, a: number, b: number): RoadObject => ({ id, type: 'road', name: id, layerId: 'roads', scenarioId: 'base', coordinates: [pt(a, 0), pt(b, 0)],
  roadClass: 'arterial', width: 10, laneCount: 2, laneWidth: 3.5, hasDivider: false, dividerWidth: 0, hasFootpath: false, footpathWidth: 0,
  speedLimit: 50, isOneWay: false, trafficCapacity: 2000, connectedJunctions: [], createdAt: '', updatedAt: '' });
const corridor = (): DrivableObject[] => { const r: DrivableObject[] = [road('mid', 0, 600)]; for (let x = 0; x > -2000; x -= 250) r.push(road(`w${-x}`, x - 250, x)); for (let x = 600; x < 2600; x += 250) r.push(road(`e${x}`, x, x + 250)); return r; };

describe('Hour-of-day profile and the analysis', () => {
  beforeEach(() => {
    vi.stubGlobal('requestAnimationFrame', () => 0);
    vi.stubGlobal('cancelAnimationFrame', () => {});
    fetchProfile.mockReset();
  });
  afterEach(() => vi.unstubAllGlobals());

  const setup = () => {
    const roads = corridor();
    const mode = new SimulationMode(() => roads);
    mode.analysisSeeds = [42];
    return mode;
  };

  it('Midday chosen in the run bar (profile never opened) analyses 14:00 at the midday factor, not at the peak', async () => {
    fetchProfile.mockResolvedValue(PROFILE);
    const mode = setup();
    mode.enter();
    mode.setRange(500);
    mode.selectRoad('mid', false);
    mode.setPeriod('midday');
    await mode.runAnalysis();
    const s = mode.getState();
    expect(s.timeOfDay.hour).toBe(14);
    expect(s.timeOfDay.status).toBe('ready');
    // share(14) / share(19), the area estimate's reference for an afternoon hour
    const expected = PROFILE.weekday.hours[14].share / PROFILE.weekday.hours[19].share;
    expect(s.timeOfDay.factor).toBeCloseTo(expected, 6);
    expect(s.timeOfDay.factor).toBeLessThan(0.8);
    expect(s.analysis.output?.result).toBeTruthy();
    expect(s.analysis.hourFactor).toBeCloseTo(expected, 6);
    mode.exit();
  }, 120000);

  it('when the profile cannot be loaded the analysis says so, and its result is not reused once the profile loads', async () => {
    fetchProfile.mockRejectedValue(new Error('backend down'));
    const mode = setup();
    mode.enter();
    mode.setRange(500);
    mode.selectRoad('mid', false);
    mode.setPeriod('midday');
    await mode.runAnalysis();
    const failed = mode.getState();
    expect(failed.timeOfDay.status).toBe('error');
    expect(failed.analysis.timeProfile).toBe('unavailable');
    expect(failed.analysis.hourFactor).toBe(1);
    const fallbackKey = failed.analysis.key;
    fetchProfile.mockResolvedValue(PROFILE);
    await mode.runAnalysis();
    const loaded = mode.getState();
    expect(loaded.analysis.timeProfile).toBe('loaded');
    expect(loaded.analysis.key).not.toBe(fallbackKey);
    expect(loaded.analysis.hourFactor).toBeLessThan(0.8);
    mode.exit();
  }, 120000);
});

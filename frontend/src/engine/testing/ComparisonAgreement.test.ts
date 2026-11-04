import { describe, it, expect } from 'vitest';
import { compareAnalyses } from '../simulation/ScenarioComparison';

/** The smallest analysis output compareAnalyses reads: one road, three seeds. */
function output(times: number[], speed: number, nb: { tripTimes?: number[]; delays?: number[]; completed?: number[] } = {}) {
  const perSeed = times.map((t, i) => ({ seed: [42, 7, 11][i], sectionVph: 1000, sectionTimeS: t, endDelayS: 10, servedShare: 0.95, completedTrips: nb.completed?.[i] ?? 1000, meanTravelTimeS: nb.tripTimes?.[i] ?? 200, meanDelayS: nb.delays?.[i] ?? 50, gridlockRemovals: 0 }));
  const avg = (xs: number[] | undefined, d: number) => (xs ? xs.reduce((a, b) => a + b, 0) / xs.length : d);
  return { result: {
    perSeed, totalVph: 1000,
    directions: [{ label: 'northbound', demandVph: 1000, vph: 1000, meanSpeedKmh: speed }],
    load: { servedShare: 0.95, overloaded: false },
    network: { completedTrips: avg(nb.completed, 1000), meanTravelTimeS: avg(nb.tripTimes, 200), meanDelayS: avg(nb.delays, 50), gridlockRemovals: 0 },
    assignment: { totalVehHours: 100, overCapacityLinks: 0, unroutedVph: 0 },
    areaLinkVph: new Map(), areaVc: new Map(), areaBottlenecks: [],
  } } as any;
}

describe('scenario comparison: a change counts only if every run shows it', () => {
  it('does not call a speed gain good when one of the three runs got slower', () => {
    // Two runs faster, one slower; the mean speed rises by 20%
    const c = compareAnalyses(output([100, 100, 100], 20), output([80, 80, 110], 24), { before: new Map(), after: new Map() }, { before: 1000, after: 1000 });
    const speed = c.section.find(d => d.label === 'Speed on it')!;
    expect(speed.agreement).toEqual({ same: 2, of: 3 });
    expect(speed.good).toBeNull();
    expect(c.verdict.overall).not.toBe('better');
  });
  it('calls it better when all three runs agree', () => {
    const c = compareAnalyses(output([100, 100, 100], 20), output([80, 80, 85], 24), { before: new Map(), after: new Map() }, { before: 1000, after: 1000 });
    expect(c.section.find(d => d.label === 'Speed on it')!.good).toBe(true);
    expect(c.verdict.overall).toBe('better');
  });
});

describe('scenario comparison: the overall verdict never hides a consistent loss', () => {
  const roads = { before: new Map(), after: new Map() }, dem = { before: 1000, after: 1000 };
  it('is a trade-off, not better, when the road speeds up but neighbourhood trips take 14% longer and delay rises 18% in every run', () => {
    const c = compareAnalyses(output([100, 100, 100], 20), output([80, 80, 85], 24, { tripTimes: [228, 227, 229], delays: [59, 59, 59] }), roads, dem);
    expect(c.verdict.section).toBe('better');
    expect(c.network.find(d => d.label === 'Mean trip time in the neighbourhood')!.good).toBe(false);
    expect(c.verdict.overall).toBe('mixed');
    expect(c.verdict.summary).toMatch(/trade-off/i);
    expect(c.verdict.summary).toMatch(/\+14%/);
  });
  it('is not better when the neighbourhood itself is mixed (more trips completed, but each takes longer)', () => {
    const c = compareAnalyses(output([100, 100, 100], 20), output([80, 80, 85], 24, { tripTimes: [228, 227, 229], completed: [1100, 1100, 1100] }), roads, dem);
    expect(c.verdict.network).toBe('mixed');
    expect(c.verdict.overall).toBe('mixed');
  });
  it('a neighbourhood loss that only some runs show does not block "better"', () => {
    const c = compareAnalyses(output([100, 100, 100], 20), output([80, 80, 85], 24, { tripTimes: [240, 240, 190] }), roads, dem);
    expect(c.verdict.overall).toBe('better');
  });
});

import { describe, it, expect } from 'vitest';
import { compareAnalyses, checkRunInputs, type RunInputs } from '../simulation/ScenarioComparison';

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

describe('scenario comparison: a measure missing on one side says why', () => {
  it('explains a junction delay the proposal did not record', () => {
    const before = output([100, 100, 100], 20), after = output([80, 80, 85], 24);
    after.result.perSeed.forEach((p: any) => { p.endDelayS = null; });
    const c = compareAnalyses(before, after, { before: new Map(), after: new Map() }, { before: 1000, after: 1000 });
    const d = c.section.find(x => x.label === 'Worst junction delay at its ends')!;
    expect(d.after).toBeNull();
    expect(d.note).toMatch(/Not measured in the proposal/);
  });
});

describe('scenario comparison: the two runs must use the same demand, hour and seeds', () => {
  const inputs: RunInputs = { demandKey: 'd1', trips: 500, plannedVph: 19800, hour: 9, hourFactor: 1, seeds: [42, 7, 11], measureS: 900 };
  const roads = { before: new Map(), after: new Map() }, dem = { before: 1000, after: 1000 };
  it('records matching inputs and keeps the like-with-like caveat', () => {
    const c = compareAnalyses(output([100, 100, 100], 20), output([80, 80, 85], 24), roads, dem, { before: inputs, after: { ...inputs, seeds: [42, 7, 11] } });
    expect(c.inputs).toMatchObject({ matched: true, mismatches: [] });
    expect(c.caveats.some(x => /Both analyses use the same demand/.test(x))).toBe(true);
    expect(c.verdict.overall).toBe('better');
  });
  it('flags a different demand, hour or seed list: low confidence, a first caveat, and no claim of the same inputs', () => {
    const after = { ...inputs, demandKey: 'd2', trips: 480, hour: 18, hourFactor: 0.9, seeds: [42, 7, 12] };
    const c = compareAnalyses(output([100, 100, 100], 20), output([80, 80, 85], 24), roads, dem, { before: inputs, after });
    expect(c.inputs!.matched).toBe(false);
    expect(c.inputs!.mismatches).toEqual(['demand', 'hour', 'seeds']);
    expect(c.confidence.level).toBe('low');
    expect(c.caveats[0]).toMatch(/Not like with like.*demand, hour, seeds/);
    expect(c.caveats.some(x => /Both analyses use the same demand/.test(x))).toBe(false);
  });
  it('a development scenario may change the demand but not the hour or seeds', () => {
    expect(checkRunInputs(inputs, { ...inputs, demandKey: 'd2', plannedVph: 21000 }, true)).toMatchObject({ matched: true });
    expect(checkRunInputs(inputs, { ...inputs, demandKey: 'd2' })).toMatchObject({ matched: false, mismatches: ['demand'] });
    expect(checkRunInputs(inputs, { ...inputs, measureS: 600 }, true).mismatches).toEqual(['duration']);
  });
});

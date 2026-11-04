import { describe, it, expect } from 'vitest';
import { compareAnalyses } from '../simulation/ScenarioComparison';

/** The smallest analysis output compareAnalyses reads: one road, three seeds. */
function output(times: number[], speed: number) {
  const perSeed = times.map((t, i) => ({ seed: [42, 7, 11][i], sectionVph: 1000, sectionTimeS: t, endDelayS: 10, servedShare: 0.95, completedTrips: 1000, meanTravelTimeS: 200, meanDelayS: 50, gridlockRemovals: 0 }));
  return { result: {
    perSeed, totalVph: 1000,
    directions: [{ label: 'northbound', demandVph: 1000, vph: 1000, meanSpeedKmh: speed }],
    load: { servedShare: 0.95, overloaded: false },
    network: { completedTrips: 1000, meanTravelTimeS: 200, meanDelayS: 50, gridlockRemovals: 0 },
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

import { describe, it, expect } from 'vitest';
import fs from 'fs';
import path from 'path';
import type { RoadObject } from '../objects/types';
import { ObjectManager } from '../objects/ObjectManager';
import type { DrivableObject } from '../simulation/StudyAreaExplorer';
import { SimulationMode } from '../simulation/SimulationMode';

/**
 * Simulate, Details: "Include traffic passing through the area" switched off (docs/OVERHAUL.md §27.7). Reported on the
 * Sangamwadi deck osm_208004768 with a 1 km area: the analysis went into an error state saying "no roads cross its
 * edge and it holds no buildings", while 35 roads cross the edge. The project holds no buildings there, so all of the
 * area's traffic is through traffic; switched off, the area's own trips are none. That is a result (every road
 * empty, with the note that through traffic is off), not an error. Real OSM roads (fixtures/sangamwadi.json).
 */
const fx = JSON.parse(fs.readFileSync(path.join(__dirname, 'fixtures/sangamwadi.json'), 'utf8')) as { roads: RoadObject[] };
const DECK = 'osm_208004768';

describe('through traffic switched off where the area has no buildings', () => {
  it('the analysis runs and shows no traffic with the reason; switched back on, the first result comes back', async () => {
    const om = new ObjectManager();
    om.addMultiple(structuredClone(fx.roads), true);
    const mode = new SimulationMode(() => om.getAll().filter(o => o.type === 'road') as DrivableObject[], null, null, () => ({ buildings: [] }),
      () => Promise.reject(new Error('no counts')), null, null);
    mode.analysisSeeds = [42];
    mode.enter();
    mode.setRange(1000);
    mode.selectRoad(DECK, false);
    await mode.runAnalysis();
    const on = mode.getState().analysis;
    expect(on.status).toBe('ready');
    expect(on.demandVph).toBeGreaterThan(0);
    expect(mode.studyPlan()!.provenance.components).toMatchObject({ internal: 0, outbound: 0, inbound: 0, throughIncluded: true });

    mode.setDemandSettings({ through: false });
    const plan = mode.studyPlan()!;
    expect(plan.trips).toEqual([]);
    expect(plan.provenance.components).toMatchObject({ through: 0, throughIncluded: false });
    expect(plan.provenance.label).toMatch(/through traffic switched off/);
    await mode.runAnalysis();
    const off = mode.getState().analysis;
    // Before the fix: status 'error', "No traffic can be estimated for this area: no roads cross its edge ..."
    expect(off.status).toBe('ready');
    expect(off.error).toBeNull();
    expect(off.demandVph).toBe(0);
    const r = off.output!.result;
    expect(r.status).toBe('no_traffic');
    expect(r.directions.every(d => d.vph === 0)).toBe(true);
    expect(JSON.stringify(r)).toMatch(/Through traffic is switched off/);

    mode.setDemandSettings({ through: true });
    await mode.runAnalysis();
    expect(mode.getState().analysis).toMatchObject({ status: 'ready', key: on.key });
    expect(mode.getState().analysis.demandVph).toBe(on.demandVph);
  }, 120000);
});

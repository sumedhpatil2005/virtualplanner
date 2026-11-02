/**
 * Real-network realism run (opt-in): the 1 km Wakad / Kasturi Chowk study area
 * dumped from the running app (roads, OSM signals, project context, count file).
 *
 *   WAKAD_DUMP=/path/to/wakad_dump.json WAKAD_OUT=/path/to/result.json npx vitest run WakadRealism
 *
 * Skipped when WAKAD_DUMP is not set, so the normal suite stays hermetic.
 * Reports peak-hour gridlock metrics and GEH per counted movement before and
 * after count-driven calibration, exactly as the calibration panel computes them.
 */
import { describe, it, expect } from 'vitest';
import * as fs from 'fs';
import { StudyAreaExplorer, type DrivableObject } from '../simulation/StudyAreaExplorer';
import { compileStudyDemand, type SimulationContext } from '../simulation/StudyDemand';
import { measureFlows, fitPlan, junctionsIn, zoneFor, compareRows, summarize, junctionChecks, buildSim, type SimSetup } from '../calibration/calibration';
import type { CountDataset } from '../calibration/observedCounts';
import { STEP_S } from '../simulation/TrafficMicroSim';

const DUMP = process.env.WAKAD_DUMP;
const OUT = process.env.WAKAD_OUT;
const MODE = process.env.WAKAD_MODE ?? 'full';

describe.skipIf(!DUMP)('Wakad real-network realism (opt-in)', () => {
  it('runs the counted area at peak and reports gridlock and GEH', async () => {
    const d = JSON.parse(fs.readFileSync(DUMP!, 'utf8'));
    const roads: DrivableObject[] = d.roads;
    const area = new StudyAreaExplorer().explore(roads, 1, { seedRoadIds: [d.seedRoad], rangeMeters: d.range, direction: 'both' });
    const ds: CountDataset = d.dataset;
    const context: SimulationContext = d.context;
    const padLat = 250 / 111320, padLng = padLat / Math.cos((area.bounds.minLat + area.bounds.maxLat) / 2 * Math.PI / 180);
    const bounds = { minLng: area.bounds.minLng - padLng, maxLng: area.bounds.maxLng + padLng, minLat: area.bounds.minLat - padLat, maxLat: area.bounds.maxLat + padLat };
    const plan = compileStudyDemand(context, bounds)!;
    const setup: SimSetup = { area, roads: new Map(roads.map(r => [r.id, r])), options: { demandLevel: 0.12, seed: 7, watchRoadIds: area.seedRoadIds, junctions: context.junctions, signalPoints: d.signalPoints } };
    const junctions = junctionsIn(ds, area.bounds);
    const zones = junctions.map(zoneFor);
    const out: Record<string, unknown> = { planVph: plan.provenance.vehiclesPerHour, pairs: plan.trips.length, junctions: junctions.map(j => j.id) };
    const t0 = Date.now();
    const before = await measureFlows(setup, plan, zones, { yieldEveryMs: 1e9 });
    out.before = { metrics: before.metrics, summary: summarize(compareRows(junctions, before.layouts, before.flows, null), 'gehBefore'), checks: junctionChecks(junctions, before.layouts), seconds: (Date.now() - t0) / 1000 };
    {
      const sim = buildSim(setup, plan);
      const layouts = sim.setCountZones(zones);
      const ids = [...sim.debugLanes().keys()];
      const roadOf = (id: string) => roads.find(r => id.startsWith(r.id + '_') || id.startsWith(r.id));
      out.layouts = layouts.map(l => ({ id: l.zone.id, problem: l.problem, err: l.maxCardinalErrorDeg, arms: l.arms.map(a => ({ c: a.cardinal,
        inbound: a.inbound.map(i => ({ id: ids[i], len: Math.round(sim.linkLength(ids[i]) ?? 0), lanes: sim.debugLanes().get(ids[i])?.length, sig: sim.signalStateOf(ids[i]), road: roadOf(ids[i])?.name, cls: roadOf(ids[i])?.roadClass })),
        outbound: a.outbound.map(i => ({ id: ids[i], len: Math.round(sim.linkLength(ids[i]) ?? 0), lanes: sim.debugLanes().get(ids[i])?.length, road: roadOf(ids[i])?.name })) })) }));
    }
    if (MODE === 'full') {
      const fit = fitPlan(setup, plan, junctions);
      const after = await measureFlows(setup, fit.plan, zones, { yieldEveryMs: 1e9 });
      const rows = compareRows(junctions, before.layouts, before.flows, after.flows);
      out.fit = { iterations: fit.ipf.iterations, converged: fit.ipf.converged, seeds: fit.seeds.length, planVph: fit.plan.provenance.vehiclesPerHour };
      out.after = { metrics: after.metrics, summary: summarize(rows, 'gehAfter') };
      out.rows = rows;
      // Junction behaviour on the calibrated plan: delay, queues, LOS, deadlock
      const sim = buildSim(setup, fit.plan);
      for (let i = 0; i < Math.round(1200 / STEP_S); i++) sim.step();
      out.junctionStats = (sim as unknown as { junctionStats?: () => unknown }).junctionStats?.() ?? null;
      out.deadlocks = (sim as unknown as { deadlockReport?: () => unknown }).deadlockReport?.() ?? null;
    } else {
      out.rows = compareRows(junctions, before.layouts, before.flows, null);
    }
    if (OUT) fs.writeFileSync(OUT, JSON.stringify(out, null, 1));
    expect(junctions.length).toBeGreaterThan(0);
  }, 1_800_000);
});

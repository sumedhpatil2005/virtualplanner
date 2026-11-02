/**
 * Before/after validation at one counted junction (opt-in; skipped unless
 * VAL_DUMP is set). Uses a dump of the running app (roads, OSM signals,
 * project context, count file, per-junction seed roads).
 *
 *   VAL_DUMP=dump6.json VAL_JUNCTION=kasturi_chowk VAL_CONFIG=after VAL_SEEDS=7,11,23 \
 *   VAL_OUT=out.json npx vitest run JunctionValidation
 *
 * Configs:
 *  - before: OSM roads as imported (no correction layer, no roundabout one-way
 *    implication), equal-split signals, no two-wheeler pairs, free-flow routes.
 *  - after: correction layer + OSM implications, Webster signals from the
 *    observed approach flows, two-wheelers abreast, and VAL_ASSIGN feedback
 *    iterations of congested link times into route choice (default 0).
 * Each seed: count-driven OD + bounded IPF (fitPlan), then a run of
 * WARMUP_S + MEASURE_S, reporting simulated flow per counted movement and the
 * junction's delay, queues, LOS, speeds and gridlock removals.
 */
import { describe, it, expect } from 'vitest';
import * as fs from 'fs';
import * as path from 'path';
import { StudyAreaExplorer, type DrivableObject } from '../simulation/StudyAreaExplorer';
import { compileStudyDemand, type SimulationContext, type DemandPlan } from '../simulation/StudyDemand';
import { fitPlan, junctionsIn, zoneFor, compareRows, buildSim, timeSignalsFromCounts, WARMUP_S, MEASURE_S, type SimSetup } from '../calibration/calibration';
import type { CountDataset } from '../calibration/observedCounts';
import { STEP_S, VEHICLE_TYPES } from '../simulation/TrafficMicroSim';
import { applyNetworkCorrections, validateCorrectionLayer } from '../simulation/networkCorrections';
import { assignWithFeedback } from '../simulation/assignment';
import { distanceM } from '../calibration/junctionMovements';

const DUMP = process.env.VAL_DUMP;

describe.skipIf(!DUMP)('junction before/after validation (opt-in)', () => {
  it('measures one junction under one configuration for several seeds', async () => {
    const d = JSON.parse(fs.readFileSync(DUMP!, 'utf8'));
    const jid = process.env.VAL_JUNCTION!;
    const config = process.env.VAL_CONFIG ?? 'after';
    const seeds = (process.env.VAL_SEEDS ?? '7,11,23').split(',').map(Number);
    const assignIters = Number(process.env.VAL_ASSIGN ?? '0');
    const per = d.per.find((p: { id: string }) => p.id === jid);
    if (!per || per.error) throw new Error(`no seed road for ${jid}`);
    const ds: CountDataset = d.dataset;
    const junction = ds.junctions.find(j => j.id === jid)!;
    const after = config !== 'before';
    const layerFile = path.resolve(__dirname, '../../../../backend/data/network_corrections/pune_west_v1.json');
    const layer = validateCorrectionLayer(JSON.parse(fs.readFileSync(layerFile, 'utf8')));
    const corrected = after ? applyNetworkCorrections(d.roads as DrivableObject[], layer, process.env.VAL_CORRECTIONS !== 'off') : null;
    const roads: DrivableObject[] = corrected ? corrected.roads : d.roads;
    const area = new StudyAreaExplorer().explore(roads, 1, { seedRoadIds: [per.seedRoad], rangeMeters: per.range, direction: 'both' });
    const context: SimulationContext = d.context;
    const padLat = 250 / 111320, padLng = padLat / Math.cos((area.bounds.minLat + area.bounds.maxLat) / 2 * Math.PI / 180);
    const bounds = { minLng: area.bounds.minLng - padLng, maxLng: area.bounds.maxLng + padLng, minLat: area.bounds.minLat - padLat, maxLat: area.bounds.maxLat + padLat };
    const empty: DemandPlan = { trips: [], provenance: { source: 'synthetic', label: 'no project demand in this area', period: 'AM_Peak', vehiclesPerHour: 0, pairCount: 0 } };
    const plan0 = compileStudyDemand(context, bounds) ?? empty;
    // Only the junction under test is fitted and reported
    const junctions = junctionsIn(ds, area.bounds).filter(j => j.id === jid);
    const zones = junctions.map(zoneFor);
    const results: unknown[] = [];
    for (const seed of seeds) {
      const t0 = Date.now();
      const setup: SimSetup = {
        area, roads: new Map(roads.map(r => [r.id, r])),
        options: { demandLevel: 0.12, seed, watchRoadIds: area.seedRoadIds, junctions: context.junctions, signalPoints: per.signalPoints,
          signalTiming: after && process.env.VAL_SIGNALS !== 'equal' ? 'webster' : 'equal', twoWheelersAbreast: after && process.env.VAL_ABREAST !== 'off' },
        signalDesignCounts: after && process.env.VAL_SIGNALS !== 'equal' ? junctions : undefined,
      };
      let assignment: unknown = null;
      if (after && assignIters > 0) {
        const a = await assignWithFeedback(setup, plan0, { iterations: assignIters, warmupS: WARMUP_S, measureS: MEASURE_S });
        setup.options = { ...setup.options, linkCostFactors: a.linkCostFactors };
        assignment = a.history;
      }
      const fit = fitPlan(setup, plan0, junctions);
      const sim = buildSim(setup, fit.plan);
      const layouts = sim.setCountZones(zones);
      if (setup.signalDesignCounts) timeSignalsFromCounts(sim, junctions, layouts);
      const total = Math.round((WARMUP_S + MEASURE_S) / STEP_S), warm = Math.round(WARMUP_S / STEP_S);
      // Optional diagnostics (VAL_DIAG=1): occupancy and speed of every link within
      // 400 m of the junction, sampled every 30 s of the measured window
      const diagOn = process.env.VAL_DIAG === '1';
      // debugLanes lists links in index order, as linkEnds does
      const le = diagOn ? sim.linkEnds() : [];
      const endsById = new Map(diagOn ? [...sim.debugLanes().keys()].map((id, k) => [id, le[k]] as const) : []);
      const near = (p: number[]) => distanceM(p[0], p[1], junction.location.lon, junction.location.lat);
      const diag = new Map<string, { len: number; lanes: number; dFrom: number; dTo: number; occ: number; spd: number; veh: number; n: number }>();
      const every = Math.round(30 / STEP_S);
      // Discharge at the stop line of each signalised approach to this junction:
      // vehicles leaving the link per second of green with a queue standing at the line
      const approaches = diagOn ? [...endsById].filter(([id, e]) => near(e.to as number[]) < 30 && near(e.from as number[]) > 30 && sim.signalStateOf(id) !== null).map(([id]) => id) : [];
      const dis = new Map(approaches.map(id => [id, { greenS: 0, queuedGreenS: 0, out: 0, outPcu: 0, outQueued: 0, outQueuedPcu: 0, outNotGreen: 0, prev: new Map<number, string>() }]));
      const pcuOf = new Map(VEHICLE_TYPES.map(t => [t.kind as string, t.pcu]));
      for (let i = 0; i < total; i++) {
        if (i === warm) { sim.startCounting(); if (diagOn) sim.traceGrants(); }
        let queued: Map<string, boolean> | null = null;
        if (diagOn && i >= warm) {
          const dl = sim.debugLanes();
          queued = new Map(approaches.map(id => {
            const front = dl.get(id)!.map(l => l[0]).filter(Boolean);
            return [id, front.some(v => v.stopLine - v.pos < 8 && v.v < 2)];
          }));
        }
        sim.step();
        if (queued) {
          const dl = sim.debugLanes();
          for (const id of approaches) {
            const r = dis.get(id)!;
            const now = new Map(dl.get(id)!.flat().map(v => [v.id, v.kind as string]));
            const st = sim.signalStateOf(id);
            const green = st === 'green';
            if (green) { r.greenS += STEP_S; if (queued.get(id)) r.queuedGreenS += STEP_S; }
            r.prev.forEach((kind, vid) => {
              if (now.has(vid)) return;
              const pc = pcuOf.get(kind) ?? 1;
              if (green) { r.out++; r.outPcu += pc; if (queued.get(id)) { r.outQueued++; r.outQueuedPcu += pc; } } else r.outNotGreen++;
            });
            r.prev = now;
          }
        }
        if (diagOn && i >= warm && (i - warm) % every === 0) {
          sim.debugLanes().forEach((lanes, id) => {
            const len = sim.linkLength(id) ?? 0;
            const e = endsById.get(id);
            if (!e) return;
            const dFrom = near(e.from as number[]), dTo = near(e.to as number[]);
            if (Math.min(dFrom, dTo) > 400) return;
            const vs = lanes.flat();
            const occ = vs.reduce((a, v) => a + v.length + 2, 0) / Math.max(1, len * lanes.length);
            const spd = vs.length ? vs.reduce((a, v) => a + v.v, 0) / vs.length : NaN;
            const r = diag.get(id) ?? { len, lanes: lanes.length, dFrom, dTo, occ: 0, spd: 0, veh: 0, n: 0 };
            r.occ += occ; r.spd += vs.length ? spd : 0; r.veh += vs.length; r.n++;
            diag.set(id, r);
          });
        }
      }
      const { counts, windowS } = sim.movementCounts();
      const flows = new Map([...counts].map(([k, n]) => [k, (n * 3600) / Math.max(windowS, STEP_S)]));
      const rows = compareRows(junctions, layouts, null, flows);
      const node = sim.junctionStats().map(s => ({ ...s, d: distanceM(s.lng, s.lat, junction.location.lon, junction.location.lat) }))
        .filter(s => s.d < 90).sort((a, b) => b.vehicles - a.vehicles)[0] ?? null;
      const plans = sim.signalPlans();
      results.push({
        seed, seconds: (Date.now() - t0) / 1000,
        layout: layouts.map(l => ({ problem: l.problem, arms: l.arms.map(a => ({ c: a.cardinal, bearing: Math.round(a.bearing), in: a.inbound.length, out: a.outbound.length })) })),
        fit: { iterations: fit.ipf.iterations, converged: fit.ipf.converged, seeds: fit.seeds.length, unreachable: fit.unreachable, planVph: fit.plan.provenance.vehiclesPerHour },
        rows, metrics: sim.getMetrics(), junction: node, deadlocks: sim.deadlockReport(),
        signal: node ? plans.find(p => p.nodeId === node.id) ?? null : null,
        assignment,
        diag: diagOn ? [...diag].map(([id, r]) => ({ id, len: Math.round(r.len), lanes: r.lanes, dFrom: Math.round(r.dFrom), dTo: Math.round(r.dTo),
          occ: +(r.occ / r.n).toFixed(2), speedMs: +(r.spd / r.n).toFixed(1), veh: +(r.veh / r.n).toFixed(1) })) : undefined,
        grants: diagOn ? approaches.map(id => ({ id, ...Object.fromEntries(sim.grantOutcomes().get(id) ?? []) })) : undefined,
        discharge: diagOn ? [...dis].map(([id, r]) => ({ id, lanes: sim.debugLanes().get(id)!.length, greenS: r.greenS, queuedGreenS: r.queuedGreenS, out: r.out, outNotGreen: r.outNotGreen,
          vphGreen: Math.round(r.out * 3600 / Math.max(1, r.greenS)), pcuphQueuedGreen: Math.round(r.outQueuedPcu * 3600 / Math.max(1, r.queuedGreenS)), vphQueuedGreen: Math.round(r.outQueued * 3600 / Math.max(1, r.queuedGreenS)) })) : undefined,
      });
    }
    const out = { junction: jid, config, assignIters, corrections: corrected?.report ?? null, results };
    if (process.env.VAL_OUT) fs.writeFileSync(process.env.VAL_OUT, JSON.stringify(out, null, 1));
    expect(results.length).toBe(seeds.length);
  }, 3_600_000);
});

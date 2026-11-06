import { describe, it } from 'vitest';
import fs from 'fs';
import path from 'path';
import type { RoadObject } from '../objects/types';
import { StudyAreaExplorer, type DrivableObject } from '../simulation/StudyAreaExplorer';
import { applyNetworkCorrections } from '../simulation/networkCorrections';
import { applyUrbanSpeeds } from '../simulation/roadParameters';
import { compileAreaDemand } from '../simulation/AreaDemand';
import { roadSection } from '../simulation/roadSection';
import { runAnalysisJob, CORRIDOR_RANGE_M } from '../simulation/analysisJob';
import { ObjectManager } from '../objects/ObjectManager';
import { laneEditPlan } from '../editing/roadEdits';
import { hourFactor, COUNT_HOURS, type DiurnalProfile } from '../simulation/timeOfDay';

/** Opt-in: DAY_INV=1. Prints the through-the-day figures on the Sangamwadi fixture (docs/OVERHAUL.md §22). */
const fx = JSON.parse(fs.readFileSync(path.join(__dirname, 'fixtures/sangamwadi.json'), 'utf8')) as { roads: RoadObject[]; signalPoints: [number, number][] };
const profile = JSON.parse(fs.readFileSync(path.join(__dirname, '../../../../backend/data/diurnal/pune_hourly_profile_v1.json'), 'utf8')) as DiurnalProfile;
const DECK = 'osm_208004768';
const PERIODS = [{ id: 'am', hour: 9 }, { id: 'midday', hour: 14 }, { id: 'pm', hour: 19 }, { id: 'night', hour: 23 }];

describe.skipIf(!process.env.DAY_INV)('through the day, Sangamwadi (opt-in)', () => {
  it('prints each period', async () => {
    const drop = new Set((process.env.DAY_DROP ?? '').split(',').filter(Boolean));
    const om = new ObjectManager();
    om.addMultiple(structuredClone(fx.roads), true);
    // DAY_LANES=roadId:lanesForward:1,... as a Build lane edit
    for (const spec of (process.env.DAY_LANES ?? '').split(',').filter(Boolean)) {
      const [id, field, v] = spec.split(':');
      const all = om.getAll().filter(o => o.type === 'road') as RoadObject[];
      for (const p of laneEditPlan(all, id, field as 'lanesForward' | 'lanesBackward', Number(v), r => om.synthesizeDefaultSections(r))) om.update(p.id, p.updates, true);
    }
    const roads = applyUrbanSpeeds(applyNetworkCorrections((om.getAll() as RoadObject[]).filter(o => o.type === 'road' && !drop.has(o.id)) as DrivableObject[], null).roads).roads;
    const map = new Map(roads.map(r => [r.id, r]));
    const ex = new StudyAreaExplorer();
    const range = Number(process.env.DAY_RANGE ?? 1000);
    const area = ex.explore(roads, 1, { seedRoadIds: [DECK], rangeMeters: range, direction: 'both' });
    const corridor = range <= CORRIDOR_RANGE_M ? area : ex.explore(roads, 1, { seedRoadIds: [DECK], rangeMeters: CORRIDOR_RANGE_M, direction: 'both' });
    const section = roadSection(area, map, [DECK]);
    const seeds = (process.env.DAY_SEEDS ?? '42').split(',').map(Number);
    const only = process.env.DAY_ONLY?.split(',');
    const out: unknown[] = [];
    for (const p of PERIODS) {
      if (only && !only.includes(p.id)) continue;
      const period = p.hour < 12 ? 'AM_Peak' : 'PM_Peak';
      const plan = compileAreaDemand({ buildings: [], period } as never, area, map)!;
      const ref = COUNT_HOURS[p.hour < 12 ? 'AM' : 'PM'];
      const f = (process.env.DAY_SCALE ? Number(process.env.DAY_SCALE) : 1) * hourFactor(profile, p.hour, ref);
      const o = await runAnalysisJob({ area, corridor, roads: map, options: { demandLevel: 0.12, signalTiming: 'webster' as const, signalPoints: fx.signalPoints }, plan, section, hourFactor: f, seeds, warmupS: 300, measureS: Number(process.env.DAY_MEASURE ?? 900) }, undefined, 1e9);
      const r = o.result;
      const row = { period: p.id, hour: p.hour, ref, factor: +f.toFixed(4), planVph: Math.round(plan.provenance.vehiclesPerHour), odTrips: plan.trips.length, areaDemandVph: Math.round(plan.provenance.vehiclesPerHour * f),
        corridorVph: Math.round(o.corridorPlan.provenance.vehiclesPerHour), status: r.status, totalVph: r.totalVph,
        dirs: r.directions.map(d => ({ label: d.label, demandVph: d.demandVph, vph: d.vph, vphBySeed: d.vphBySeed, speed: d.meanSpeedKmh && +d.meanSpeedKmh.toFixed(1), speedBySeed: d.speedBySeed, free: Math.round(d.freeSpeedKmh), vc: +d.vc.toFixed(2), los: d.los, losBySeed: d.losBySeed,
          delay: d.delay && Object.fromEntries(Object.entries(d.delay).map(([k, v]) => [k, Math.round(v)])), queuedNow: d.queuedNow })),
        load: r.loadBySeed ?? null, net: r.perSeed?.map(s => s) ?? null, cause: r.cause?.kind, causeText: r.cause?.text ?? null, chain: r.cause?.chain?.root ? { ...r.cause.chain.root, agreement: r.cause.chain.agreement } : null, junctions: r.junctions.slice(0, 4).map(j => ({ label: j.label, delayS: Math.round(j.delayS), q: Math.round(j.maxQueueM), atSection: j.atSection, veh: j.vehicles })) };
      console.log(JSON.stringify(row));
      out.push(row);
    }
    if (process.env.DAY_OUT) fs.writeFileSync(process.env.DAY_OUT, JSON.stringify(out, null, 1));
  }, 1_800_000);
});

import { describe, it } from 'vitest';
import fs from 'fs';
import http from 'http';
import { ObjectManager } from '../objects/ObjectManager';
import type { CityObject, RoadObject } from '../objects/types';
import { HistoryManager } from '../history/HistoryManager';
import { EditingEngine } from '../editing/EditingEngine';
import { LocalOsmIndex } from '../editing/LocalOsmIndex';
import { SimulationMode, type SimulationContext } from '../simulation/SimulationMode';
import { TrafficSignalSource } from '../simulation/trafficSignals';
import { filterObjectsForScenario } from '../scenarios/scenarioFilter';
import { isSampleObject } from '../objects/sampleObjects';
import { isDrivable, type DrivableObject } from '../simulation/StudyAreaExplorer';
import { screenlineChecks, type ScreenlineFile } from '../calibration/screenlines';
import { snapDemandPlan } from '../simulation/StudyDemand';
import { assignTraffic, PCU as ASSIGN_PCU } from '../simulation/staticAssignment';
import { cordonOf, EDGE_FLOW_PER_LANE_VPH } from '../simulation/AreaDemand';
import { VEHICLE_TYPES } from '../simulation/TrafficMicroSim';
import { hourFactor, COUNT_HOURS } from '../simulation/timeOfDay';
import type { TimePeriod } from '../objects/demandTypes';

/**
 * Opt-in harness for docs/OVERHAUL.md §24 (validation against observations): VAL24=1.
 *
 * Runs the app's own SimulationMode (the code behind the Simulate panel) headlessly on a copy of the
 * project database, with the backend serving the local OSM index (roads added around the study area,
 * signals), the hour-of-day profile, the count file, the correction layer and the screenlines, as the
 * browser does. Nothing here changes a model parameter.
 *
 *   VAL24_DB    JSON dump of the database's city_objects ({objects: [...]}, properties unpacked as the app does)
 *   VAL24_RUNS  JSON list of runs: {id, seedRoadIds, hour, range?, ways?: {obsId: [osm way ids]}, hours?: number[] (assignment-only sweep)}
 *   VAL24_OUT   output JSON-lines file (appended)
 *   VAL24_ONLY  comma-separated run ids
 *   VAL24_SEEDS seeds (default 42,7,11)
 *   VAL24_API   backend base URL every /api/ request is sent to
 *
 * HYPOTHETICAL prototypes of proposed calibrations (§24.6). Off unless set; they change only this harness's
 * copy of the inputs, never a default, and every output row records them under `hypothetical`:
 *   VAL24_HYPO_SCALE     the app's own hypothetical demand multiplier (Details -> demand settings), e.g. 1.8
 *   VAL24_HYPO_SPEEDCAP  cap every OSM-tagged maxspeed at this km/h (the urban ceiling now applies to untagged roads only)
 *   VAL24_HYPO_PCU       'trr2021': PCU per vehicle at the mid-points of the dynamic PCU ranges measured at Indian signals by
 *                        Patel & Dhamaniya, TRR 2675(11), 2021, doi:10.1177/03611981211018694 (two-wheeler 0.22, three-wheeler 0.62,
 *                        bus/truck 5.0, car 1.0), swapped into this process's assignment and simulator tables (all links, not signals only)
 *   VAL24_HYPO_EDGE      multiply the edge (cordon) flow per lane of every road class by this factor (AreaDemand EDGE_FLOW_PER_LANE_VPH)
 *
 * Runs with `hours` (assignment-only sweep) also report, per hour, the section's assigned speed and, with `ways`, the assigned
 * volume of each way group and its distance to the nearest cordon point (where edge demand enters), plus the plan's components.
 */
// The test setup replaces fetch with a 404 stub; this harness talks to its own backend (VAL24_API, e.g. http://127.0.0.1:8141)
if (process.env.VAL24 && process.env.VAL24_API) {
  const base = new URL(process.env.VAL24_API);
  globalThis.fetch = ((input: RequestInfo | URL, init?: RequestInit) => new Promise((resolve, reject) => {
    const u = new URL(String(input instanceof Request ? input.url : input));
    const req = http.request({ host: base.hostname, port: base.port, path: u.pathname + u.search, method: init?.method ?? 'GET', headers: { 'Content-Type': 'application/json' } }, res => {
      const chunks: Buffer[] = [];
      res.on('data', c => chunks.push(c));
      res.on('end', () => {
        const body = Buffer.concat(chunks).toString('utf8'), status = res.statusCode ?? 0;
        resolve({ ok: status >= 200 && status < 300, status, statusText: res.statusMessage ?? '', text: async () => body, json: async () => JSON.parse(body), headers: { get: (k: string) => (res.headers[k.toLowerCase()] as string) ?? null } } as unknown as Response);
      });
    });
    req.on('error', reject);
    if (init?.signal) init.signal.addEventListener('abort', () => req.destroy(new Error('aborted')));
    if (init?.body) req.write(init.body as string);
    req.end();
  })) as typeof fetch;
}
const wayOf = (id: string) => { const m = /^osm_(\d+)/.exec(id); return m ? Number(m[1]) : null; };

/** Both directions of a set of ways: per way, the busiest piece of each direction, summed over ways (as screenlines.ts). */
function wayVolume(vph: ReadonlyMap<string, number>, ways: readonly number[]) {
  let total = 0, found = false;
  for (const w of ways) {
    let f = 0, b = 0;
    vph.forEach((v, id) => { if (wayOf(id) !== w) return; found = true; if (id.endsWith('_bwd')) b = Math.max(b, v); else f = Math.max(f, v); });
    total += f + b;
  }
  return found ? Math.round(total) : null;
}

describe.skipIf(!process.env.VAL24)('network-wide validation against observations (opt-in, §24)', () => {
  it('runs every listed comparison', async () => {
    const db = JSON.parse(fs.readFileSync(process.env.VAL24_DB!, 'utf8')) as { objects: (CityObject & Record<string, unknown>)[] };
    const om = new ObjectManager();
    for (const obj of db.objects) {
      const o = { ...obj, createdAt: new Date().toISOString(), updatedAt: new Date().toISOString() } as unknown as CityObject;
      if (o.type === 'road') om.syncRoadProperties(o as RoadObject);
      (om as unknown as { objects: Map<string, CityObject> }).objects.set(o.id, o);
    }
    om.liftBridges();
    const hypo: Record<string, number> = {};
    const capTags = (objs: readonly CityObject[]) => {
      if (hypo.speedCapKmh === undefined) return;
      for (const o of objs) {
        const tags = (o as RoadObject).osmProvenance?.originalTags as Record<string, string> | undefined;
        const v = tags?.maxspeed ? parseFloat(tags.maxspeed) : NaN;
        if (tags && Number.isFinite(v) && v > hypo.speedCapKmh) tags.maxspeed = String(hypo.speedCapKmh);
      }
    };
    if (process.env.VAL24_HYPO_SPEEDCAP) hypo.speedCapKmh = Number(process.env.VAL24_HYPO_SPEEDCAP);
    if (process.env.VAL24_HYPO_PCU === 'trr2021') {
      const trr: Record<string, number> = { two_wheeler: 0.22, auto: 0.62, car: 1.0, bus: 5.0, truck: 5.0, bus_auto: 0.62 };
      for (const t of VEHICLE_TYPES) if (trr[t.kind] !== undefined) { t.pcu = trr[t.kind]; ASSIGN_PCU[t.kind] = trr[t.kind]; }
      hypo.pcuTrr2021 = 1;
    }
    if (process.env.VAL24_HYPO_EDGE) {
      hypo.edgeFlowFactor = Number(process.env.VAL24_HYPO_EDGE);
      for (const k of Object.keys(EDGE_FLOW_PER_LANE_VPH)) EDGE_FLOW_PER_LANE_VPH[k] *= hypo.edgeFlowFactor;
    }
    const history = new HistoryManager(om);
    const localOsm = new LocalOsmIndex();
    const editing = new EditingEngine(om, history, () => null, localOsm);
    const scenarioId = 'base';
    const ctx = (): SimulationContext => {
      const objects = filterObjectsForScenario(om.getAll(), scenarioId).filter(o => !isSampleObject(o)) as (CityObject & Record<string, any>)[];
      const flows = (values: Record<string, number>) => Object.fromEntries((['AM_Peak', 'PM_Peak', 'Midday', 'Night'] as TimePeriod[]).map(p => [p, Math.max(0, values?.[p] || 0)])) as Record<TimePeriod, number>;
      return {
        scenarioId,
        junctions: objects.filter(o => o.type === 'junction') as never,
        buildings: objects.filter(o => o.type === 'building') as never,
        zones: objects.filter(o => o.type === 'zone').map(z => ({ id: z.id, name: z.name, boundaryPolygon: z.coordinates, totalPopulation: z.totalPopulation || 0, totalEmployment: z.totalEmployment || 0,
          landUseMix: z.landUseMix, gateways: z.gateways || [], provenance: z.provenance || { source: 'estimated', confidence: 0, updatedAt: z.updatedAt } })) as never,
        gateways: objects.filter(o => o.type === 'gateway').map(g => ({ id: g.id, name: g.name, coordinates: g.coordinates[0], connectedNodeId: g.connectedNodeId,
          inboundFlows: flows(g.inboundFlows), outboundFlows: flows(g.outboundFlows), modeSplit: g.modeSplit,
          provenance: g.provenance || { source: 'estimated', confidence: 0, updatedAt: g.updatedAt } })) as never,
      };
    };
    const mode = new SimulationMode(
      () => { const rs = filterObjectsForScenario(om.getAll(), scenarioId).filter(isDrivable).filter(o => !isSampleObject(o)); capTags(rs); return rs as DrivableObject[]; },
      { load: (boxes, signal) => editing.loadOsmRoadsForStudyArea(boxes, signal) },
      new TrafficSignalSource(localOsm),
      ctx,
    );
    om.onChange((types: Set<string>) => { if (types.has('road') || types.size === 0 || types.has('junction')) mode.networkChanged(); });
    if (process.env.VAL24_SEEDS) mode.analysisSeeds = process.env.VAL24_SEEDS.split(',').map(Number);
    mode.enter();
    if (process.env.VAL24_HYPO_SCALE) { hypo.demandScale = Number(process.env.VAL24_HYPO_SCALE); mode.setDemandSettings({ hypotheticalScale: hypo.demandScale }); }
    const sleep = (ms: number) => new Promise(r => setTimeout(r, ms));
    const settle = async () => {
      for (let i = 0; i < 600; i++) {
        const s = mode.getState();
        if (s.osmRoads.status !== 'loading' && s.signals.status !== 'loading' && s.timeOfDay.status === 'ready' && s.area && s.section && s.screenlines) return true;
        await sleep(200);
      }
      return false;
    };
    const runs = JSON.parse(fs.readFileSync(process.env.VAL24_RUNS!, 'utf8')) as { id: string; seedRoadIds: string[]; hour: number; range?: number; ways?: Record<string, number[]>; hours?: number[]; skipSim?: boolean }[];
    const only = process.env.VAL24_ONLY ? process.env.VAL24_ONLY.split(',') : null;
    for (const run of runs) {
      if (only && !only.includes(run.id)) continue;
      const t0 = Date.now();
      mode.setRange(run.range ?? 2000);
      run.seedRoadIds.forEach((id, i) => mode.selectRoad(id, i > 0));
      mode.setHour(run.hour);
      const ok = await settle();
      await sleep(800);
      await settle();
      const st = mode.getState();
      const row: Record<string, unknown> = { id: run.id, hypothetical: Object.keys(hypo).length ? hypo : null, hour: run.hour, settled: ok, seeds: mode.analysisSeeds, osmRoads: st.osmRoads, signals: st.signals, areaSegments: st.area?.segments.length, sectionName: st.section?.name };
      const roadsMap = new Map((mode as unknown as { getRoads: () => DrivableObject[] }).getRoads().map(r => [r.id, r]));
      if (run.hours && st.area) {
        // Assignment-only sweep over hours: network-wide (area) speed from the user-equilibrium assignment
        const area = st.area, profile = st.timeOfDay.profile!;
        const segs = new Set(area.segments.map(s => s.key));
        const sweep = [];
        for (const h of run.hours) {
          const plan = mode.studyPlan(area, h < 12 ? 'AM_Peak' : 'PM_Peak')!;
          const f = hourFactor(profile, h, COUNT_HOURS[h < 12 ? 'AM' : 'PM'], st.timeOfDay.day);
          const trips = snapDemandPlan(plan, area.network, 250, segs).map(t => ({ ...t, vehiclesPerHour: t.vehiclesPerHour * f }));
          const a = assignTraffic(area, roadsMap, trips, { signalPoints: mode.mappedSignalPoints() ?? undefined });
          const byClass: Record<string, { vkm: number; vh: number; vh0: number; km: number }> = {};
          let vkm = 0, vh = 0, vh0 = 0;
          a.links.forEach((l, i) => {
            const v = a.volVeh[i]; const km = l.lengthM / 1000;
            const cls = String((roadsMap.get(l.roadId) as { roadClass?: string } | undefined)?.roadClass ?? 'other');
            const c = (byClass[cls] ??= { vkm: 0, vh: 0, vh0: 0, km: 0 });
            c.km += km; c.vkm += v * km; c.vh += v * a.timeS[i] / 3600; c.vh0 += v * l.t0 / 3600;
            vkm += v * km; vh += v * a.timeS[i] / 3600; vh0 += v * l.t0 / 3600;
          });
          // Section speed (both carriageways, length-weighted harmonic) and way-group volumes from this assignment
          const secKeys = new Set(st.section?.segmentKeys ?? []);
          const secDir: Record<string, { km: number; h: number; h0: number; vol: number }> = {};
          const linkVph = new Map<string, number>();
          a.links.forEach((l, i) => {
            linkVph.set(l.id, a.volVeh[i]);
            if (!secKeys.has(l.segmentKey)) return;
            const d = l.id.endsWith('_bwd') ? 'bwd' : 'fwd', km = l.lengthM / 1000;
            const c = (secDir[d] ??= { km: 0, h: 0, h0: 0, vol: 0 });
            c.km += km; c.h += km / Math.max(1e-6, km / (a.timeS[i] / 3600)); c.h0 += l.t0 / 3600; c.vol = Math.max(c.vol, a.volVeh[i]);
          });
          const waysOut = run.ways ? Object.fromEntries(Object.entries(run.ways).map(([k, ws]) => [k, wayVolume(linkVph, ws)])) : undefined;
          sweep.push({ hour: h, section: Object.fromEntries(Object.entries(secDir).map(([d, c]) => [d, { speed: c.h ? +(c.km / c.h).toFixed(2) : null, free: c.h0 ? +(c.km / c.h0).toFixed(2) : null, maxVph: Math.round(c.vol) }])),
            ways: waysOut, components: plan.provenance.components, planVph: Math.round(plan.provenance.vehiclesPerHour), factor: +f.toFixed(4), demandVph: Math.round(trips.reduce((n, t) => n + t.vehiclesPerHour, 0)), unroutedVph: Math.round(a.unroutedVeh), gap: +a.relativeGap.toFixed(4),
            speedKmh: vh ? +(vkm / vh).toFixed(2) : null, freeSpeedKmh: vh0 ? +(vkm / vh0).toFixed(2) : null, vkm: Math.round(vkm),
            byClass: Object.fromEntries(Object.entries(byClass).map(([k, c]) => [k, { km: +c.km.toFixed(1), vkm: Math.round(c.vkm), speed: c.vh ? +(c.vkm / c.vh).toFixed(2) : null, free: c.vh0 ? +(c.vkm / c.vh0).toFixed(2) : null }])) });
        }
        row.sweep = sweep;
        // Where the area's edge demand enters: cordon points, and each way group's distance to the nearest one
        const cordon = cordonOf(area, roadsMap);
        row.cordon = { points: cordon.length, inVph: Math.round(cordon.reduce((n, c) => n + c.inVph, 0)), outVph: Math.round(cordon.reduce((n, c) => n + c.outVph, 0)),
          bounds: area.bounds, byClass: cordon.reduce((m, c) => { m[c.roadClass] = (m[c.roadClass] ?? 0) + c.inVph; return m; }, {} as Record<string, number>) };
        if (run.ways) {
          const dist = (p: readonly number[], q: readonly number[]) => Math.hypot((p[0] - q[0]) * 111320 * Math.cos(p[1] * Math.PI / 180), (p[1] - q[1]) * 111320);
          row.wayCordonM = Object.fromEntries(Object.entries(run.ways).map(([k, ws]) => {
            let best = Infinity;
            for (const w of ws) { const r = roadsMap.get(`osm_${w}`) as { coordinates?: number[][] } | undefined; for (const p of r?.coordinates ?? []) for (const c of cordon) best = Math.min(best, dist(p, c.coordinates)); }
            return [k, Number.isFinite(best) ? Math.round(best) : null];
          }));
        }
      }
      if (!run.skipSim) {
        const out = await mode.runAnalysis();
        const s2 = mode.getState();
        if (out) {
          const r = out.result;
          const segLen = new Map((s2.area?.segments ?? []).map(s => [s.key, s.lengthM]));
          let vkm = 0;
          r.areaLinkVph.forEach((v, id) => { vkm += v * (segLen.get(id.replace(/_(fwd|bwd)$/, '')) ?? 0) / 1000; });
          Object.assign(row, {
            analysisHour: s2.analysis.hour, hourFactor: s2.analysis.hourFactor, timeProfile: s2.analysis.timeProfile, planVph: Math.round(mode.studyPlan()?.provenance.vehiclesPerHour ?? 0), demandVph: Math.round(s2.analysis.demandVph),
            routedVph: Math.round(out.routedVph), unroutedVph: Math.round(out.unroutedVph), corridorVph: Math.round(out.corridorPlan.provenance.vehiclesPerHour), elapsedMs: out.elapsedMs,
            status: r.status, statusBySeed: r.statusBySeed, section: { name: r.section.name, lengthM: Math.round(r.section.lengthM), endsAt: r.section.endsAt },
            dirs: r.directions.map(d => ({ label: d.label, demandVph: Math.round(d.demandVph), vph: Math.round(d.vph), vphRange: d.vphRange, speed: d.meanSpeedKmh == null ? null : +d.meanSpeedKmh.toFixed(1),
              speedBySeed: (d as unknown as { speedBySeed?: number[] }).speedBySeed, free: +d.freeSpeedKmh.toFixed(1), vc: +d.vc.toFixed(3), los: d.los, losBySeed: (d as unknown as { losBySeed?: string[] }).losBySeed,
              losBasis: (d as unknown as { losBasis?: unknown }).losBasis, lanes: d.lanes, midblockPcu: Math.round(d.midblockPcu), stopLinePcu: d.stopLinePcu && Math.round(d.stopLinePcu), roadIds: d.roadIds })),
            assignment: r.assignment, areaVkm: Math.round(vkm), areaSpeedKmh: r.assignment.totalVehHours ? +(vkm / r.assignment.totalVehHours).toFixed(2) : null,
            load: r.load, simNet: { meanSpeedKmh: r.network.meanSpeedKmh, delayIndex: r.network.delayIndex, completedTrips: r.network.completedTrips },
            perSeed: r.perSeed.map(p => ({ seed: p.seed, sectionVph: p.sectionVph, servedShare: p.servedShare, meanDelayS: p.meanDelayS, gridlock: p.gridlockRemovals })),
            junctions: r.junctions.slice(0, 4).map(j => ({ label: j.label, delayS: Math.round(j.delayS), atSection: j.atSection })),
            screenlines: screenlineChecks(s2.screenlines as ScreenlineFile | null, r, s2.analysis.hour).map(c => ({ id: c.station.id, count: c.station.peakVehicles, countHour: c.station.peakStartHour, modelVph: c.modelVph, simulatedVph: c.simulatedVph, geh: +c.geh.toFixed(2) })),
            counts: out.counts.map(c => ({ ...c })),
            ways: Object.fromEntries(Object.entries(run.ways ?? {}).map(([k, ws]) => [k, { assigned: wayVolume(r.areaLinkVph, ws), simulated: wayVolume(r.linkVph, ws) }])),
          });
        } else row.error = s2.analysis.error;
      }
      row.wallMs = Date.now() - t0;
      fs.appendFileSync(process.env.VAL24_OUT!, JSON.stringify(row) + '\n');
      console.log(JSON.stringify({ id: row.id, wallMs: row.wallMs, status: row.status, dirs: (row.dirs as unknown[] | undefined)?.length }));
    }
    mode.exit();
  }, 24 * 3600_000);
});

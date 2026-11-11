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
import { snapDemandPlan } from '../simulation/StudyDemand';
import { splitJunctionObjects } from '../simulation/junctionControl';
import { areaOdProblem, countsBeforeAfter } from '../demand/odmeAssignment';
import { estimateOd, matrixChangeStats, type OdmeCount } from '../demand/odme';
import type { TimePeriod } from '../objects/demandTypes';

/**
 * Opt-in real-area ODME run (docs/ODME_AND_EMISSIONS.md §4): ODME_REAL=1.
 *
 * The §24 observations (backend/data/observed_validation/pune_network_validation_v1.json: CMP 2008 screen-line
 * counts, both directions, veh/h at each site's own peak hour) inside one study area are split into a calibration
 * half and a validation half. ODME is fitted to the calibration half only; GEH before/after is reported on BOTH
 * halves. Nothing here changes a default. Same harness set-up as NetworkValidation.test.ts (VAL24).
 *
 *   ODME_DB     JSON dump {objects: [...]} of a COPY of the project database (properties unpacked as the app does)
 *   ODME_API    backend base URL (local OSM index + signals)
 *   ODME_OUT    output JSON file
 *   ODME_RUNS   JSON list: {id, seedRoadIds, range, hour, sites: string[] (observation ids)}
 *   ODME_MU     regularisation weight (default 0)
 */
if (process.env.ODME_REAL && process.env.ODME_API) {
  const base = new URL(process.env.ODME_API);
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

interface Obs { id: string; name: string; osmWays: number[]; hour: number; veh: number; grade: string }

describe.skipIf(!process.env.ODME_REAL)('ODME on a real area with §24 counts split into calibration / validation halves (opt-in)', () => {
  it('fits the calibration half and reports GEH on both halves', async () => {
    const db = JSON.parse(fs.readFileSync(process.env.ODME_DB!, 'utf8')) as { objects: (CityObject & Record<string, unknown>)[] };
    const om = new ObjectManager();
    for (const obj of db.objects) {
      const o = { ...obj, createdAt: new Date().toISOString(), updatedAt: new Date().toISOString() } as unknown as CityObject;
      if (o.type === 'road') om.syncRoadProperties(o as RoadObject);
      (om as unknown as { objects: Map<string, CityObject> }).objects.set(o.id, o);
    }
    om.liftBridges();
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
      () => filterObjectsForScenario(om.getAll(), scenarioId).filter(isDrivable).filter(o => !isSampleObject(o)) as DrivableObject[],
      { load: (boxes, signal) => editing.loadOsmRoadsForStudyArea(boxes, signal) },
      new TrafficSignalSource(localOsm),
      ctx,
    );
    om.onChange((types: Set<string>) => { if (types.has('road') || types.size === 0 || types.has('junction')) mode.networkChanged(); });
    mode.enter();
    const sleep = (ms: number) => new Promise(r => setTimeout(r, ms));
    const settle = async () => {
      for (let i = 0; i < 900; i++) {
        const s = mode.getState();
        if (s.osmRoads.status !== 'loading' && s.signals.status !== 'loading' && s.timeOfDay.status === 'ready' && s.area && s.section) return true;
        await sleep(200);
      }
      return false;
    };
    const obsFile = JSON.parse(fs.readFileSync('../backend/data/observed_validation/pune_network_validation_v1.json', 'utf8')) as { counts: Obs[] };
    const obs = new Map(obsFile.counts.map(c => [c.id, c]));
    const runs = JSON.parse(fs.readFileSync(process.env.ODME_RUNS!, 'utf8')) as { id: string; seedRoadIds: string[]; range: number; hour: number; sites: string[] }[];
    const mu = Number(process.env.ODME_MU ?? 0);
    const out: unknown[] = [];
    for (const run of runs) {
      const t0 = Date.now();
      mode.setRange(run.range);
      run.seedRoadIds.forEach((id, i) => mode.selectRoad(id, i > 0));
      mode.setHour(run.hour);
      await settle(); await sleep(1000); await settle();
      const st = mode.getState();
      const area = st.area!;
      const roads = new Map((mode as unknown as { getRoads: () => DrivableObject[] }).getRoads().map(r => [r.id, r]));
      const prior = mode.studyPlan(area, run.hour < 12 ? 'AM_Peak' : 'PM_Peak', true)!;
      const f = st.timeOfDay.factor;
      const segs = new Set(area.segments.map(s => s.key));
      const trips = snapDemandPlan(prior, area.network, 250, segs).map(t => ({ ...t, vehiclesPerHour: t.vehiclesPerHour * f }));
      const assignment = { signalPoints: mode.mappedSignalPoints() ?? undefined, junctionEdits: splitJunctionObjects(ctx().junctions).edits };
      const problem = areaOdProblem(area, roads, trips, assignment);
      // Each site: per way, the busiest fwd link and the busiest bwd link, summed (as the §24 harness's wayVolume)
      const toCount = (o: Obs, role: string): OdmeCount | null => {
        const groups: number[][] = [];
        for (const w of o.osmWays) for (const dir of ['fwd', 'bwd']) {
          const g = problem.linkIds.map((id, i) => [id, i] as const).filter(([id]) => new RegExp(`^osm_${w}(_[a-z0-9]+)*_seg_\\d+_${dir}$`).test(id)).map(([, i]) => i);
          if (g.length) groups.push(g);
        }
        return groups.length ? { id: o.id, groups, observed: o.veh, datasetId: role } : null;
      };
      // Split: sites in the order listed, alternately calibration / validation (fixed before any run)
      const present = run.sites.map(id => obs.get(id)!).map(o => ({ o, c: toCount(o, 'x') })).filter(x => x.c);
      const missing = run.sites.filter(id => !present.some(p => p.o.id === id));
      const cal = present.filter((_, i) => i % 2 === 0).map(p => ({ ...p.c!, datasetId: 'cmp2008-calibration-half' }));
      const val = present.filter((_, i) => i % 2 === 1).map(p => ({ ...p.c!, datasetId: 'cmp2008-validation-half' }));
      const est = estimateOd(problem, cal, { heldOutDatasetIds: ['cmp2008-validation-half'], priorWeight: mu });
      const change = matrixChangeStats(problem.prior, est.matrix, problem.cells);
      const valFit = countsBeforeAfter(val, est.priorLoad, est.load);
      const row = {
        id: run.id, hour: run.hour, range: run.range, seeds: run.seedRoadIds, hourFactor: f, signals: st.signals.status, osmRoads: st.osmRoads.status,
        priorVph: Math.round(prior.provenance.vehiclesPerHour * f), estimatedVph: Math.round(est.matrix.reduce((n, v) => n + v, 0)), cells: problem.prior.length,
        components: prior.provenance.components, assignments: problem.assignments(), iterations: est.iterations.map(i => ({ it: i.iteration, z: Math.round(i.objective), meanGeh: +i.meanAbsGeh.toFixed(2), halvings: i.halvings, accepted: i.accepted, gap: i.assignmentGap })),
        stopReason: est.stopReason, boundedCells: est.boundedCells, mu,
        calibration: est.fit.map(x => ({ ...x, hour: obs.get(x.id)!.hour, name: obs.get(x.id)!.name })), validation: valFit.map(x => ({ ...x, hour: obs.get(x.id)!.hour, name: obs.get(x.id)!.name })),
        missing, change, factorRange: [Math.min(...est.factors), Math.max(...est.factors)], wallMs: Date.now() - t0,
      };
      out.push(row);
      fs.writeFileSync(process.env.ODME_OUT!, JSON.stringify(out, null, 1));
      console.log(JSON.stringify({ id: run.id, wallMs: row.wallMs, cal: row.calibration.length, val: row.validation.length, missing }));
    }
    mode.exit();
  }, 6 * 3600_000);
});

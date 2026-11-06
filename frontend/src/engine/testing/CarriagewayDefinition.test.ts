import { describe, it, expect } from 'vitest';
import fs from 'fs';
import path from 'path';
import type { RoadObject } from '../objects/types';
import { ObjectManager } from '../objects/ObjectManager';
import { laneEditPlan, laneEditPreview } from '../editing/roadEdits';
import { StudyAreaExplorer, type DrivableObject } from '../simulation/StudyAreaExplorer';
import { applyNetworkCorrections } from '../simulation/networkCorrections';
import { applyUrbanSpeeds } from '../simulation/roadParameters';
import { compileAreaDemand } from '../simulation/AreaDemand';
import { roadSection } from '../simulation/roadSection';
import { sectionDirections, areaContext } from '../simulation/RoadAnalysis';
import { assignTraffic } from '../simulation/staticAssignment';
import { snapDemandPlan } from '../simulation/StudyDemand';

/**
 * One definition of a carriageway for the analysis and the lane edit scope
 * (docs/OVERHAUL.md §21), on the real OpenStreetMap roads round Sangamwadi
 * Bridge (fixtures/sangamwadi.json).
 *
 * Nyaymurti Ranade Path, west to east: an 11 m two-way stub osm_657054226
 * across the median of Shivaji Road (trunk, a divided road) -> Shivaji Road's
 * carriageway osm_342557171/osm_238836092 -> a one-way, 2-lane stretch running
 * west (osm_1359564185, osm_1524250062) -> two-way 1+1 osm_750335054 (drawn
 * westwards) -> two-way 1+1 osm_22841055 (drawn north-east). The stub is past
 * a major junction and past the one-way stretch: it is no part of the
 * north-east carriageway of osm_22841055, which ends where the road turns
 * one-way. The section took it in as "the other carriageway alongside",
 * because its midpoint lies 5 m from the section's end, so the north-east
 * capacity stayed at the stub's 643 PCU/h after "Entire carriageway" widened
 * every way the edit could reach.
 */
const fx = JSON.parse(fs.readFileSync(path.join(__dirname, 'fixtures/sangamwadi.json'), 'utf8')) as { roads: RoadObject[]; signalPoints: [number, number][] };
const SEED = 'osm_22841055', WEST_PIECE = 'osm_750335054', STUB = 'osm_657054226';
const ONE_WAY = ['osm_1359564185', 'osm_1524250062'];

function analyse(roads: DrivableObject[]) {
  const sim = applyUrbanSpeeds(applyNetworkCorrections(roads, null).roads).roads;
  const map = new Map(sim.map(r => [r.id, r]));
  const area = new StudyAreaExplorer().explore(sim, 1, { seedRoadIds: [SEED], rangeMeters: 700, direction: 'both' });
  const plan = compileAreaDemand({ buildings: [] }, area, map)!;
  const trips = snapDemandPlan(plan, area.network, 250, new Set(area.segments.map(s => s.key)));
  const res = assignTraffic(area, map, trips, { signalPoints: fx.signalPoints });
  const section = roadSection(area, map, [SEED]);
  const dirs = sectionDirections(area, section, map);
  const ctx = areaContext(res, area, map, section, dirs, plan.provenance.vehiclesPerHour);
  // North-east: the direction osm_22841055 is drawn in (its forward links)
  const ne = dirs.findIndex(d => d.linkIds.some(id => id.startsWith(SEED) && !id.endsWith('_bwd')));
  return { area, section, dirs, ctx, ne, sw: 1 - ne };
}

describe('Nyaymurti Ranade Path: the analysis and the edit scope agree on the carriageway', () => {
  const roads = () => structuredClone(fx.roads) as RoadObject[];

  it('the edit scope is the two two-way ways, stopping where the road turns one-way', () => {
    expect(new Set(laneEditPreview(roads(), SEED, 'lanesForward').roadIds)).toEqual(new Set([SEED, WEST_PIECE]));
    expect(new Set(laneEditPreview(roads(), SEED, 'lanesBackward').roadIds)).toEqual(new Set([SEED, WEST_PIECE]));
  });

  it('the stub beyond Shivaji Road is not in the section, and neither direction counts it', () => {
    const { section, ctx } = analyse(roads());
    expect(section.roadIds).not.toContain(STUB);
    for (const d of ctx.directions) expect(d.roadIds).not.toContain(STUB);
  });

  it('each direction is the carriageway the edit scope reaches in that direction', () => {
    const { ctx, ne, sw } = analyse(roads());
    expect(new Set(ctx.directions[ne].roadIds)).toEqual(new Set(laneEditPreview(roads(), SEED, 'lanesForward').roadIds));
    expect(new Set(ctx.directions[sw].roadIds)).toEqual(new Set(laneEditPreview(roads(), SEED, 'lanesBackward').roadIds));
    // The one-way stretch is another carriageway: it does not set the south-west capacity of the two-way road
    for (const id of ONE_WAY) expect(ctx.directions[sw].roadIds).not.toContain(id);
  });

  it('"Entire carriageway" +1 lane north-east raises the north-east capacity (it stayed at 643 PCU/h)', () => {
    const before = analyse(roads()).ctx;
    const ne0 = before.directions[analyse(roads()).ne];
    expect(ne0.midblockPcu).toBeCloseTo(643, -1);
    const om = new ObjectManager();
    om.addMultiple(roads(), true);
    const plan = laneEditPlan(om.getAll() as RoadObject[], SEED, 'lanesForward', 2, r => om.synthesizeDefaultSections(r));
    expect(new Set(plan.map(p => p.id))).toEqual(new Set([SEED, WEST_PIECE]));
    for (const p of plan) om.update(p.id, p.updates, true);
    const after = analyse(om.getAll().filter(o => o.type === 'road') as RoadObject[]);
    const ne1 = after.ctx.directions[after.ne];
    expect(ne1.lanes).toBe(2);
    expect(ne1.midblockPcu).toBeGreaterThan(ne0.midblockPcu * 1.5);
    expect(ne1.bindingSegments.every(b => b.roadId === SEED || b.roadId === WEST_PIECE)).toBe(true);
  });
});

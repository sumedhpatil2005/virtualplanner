import { describe, it, expect } from 'vitest';
import fs from 'fs';
import path from 'path';
import type { RoadObject } from '../objects/types';
import { ObjectManager } from '../objects/ObjectManager';
import { laneEditPlan, laneEditPreview } from '../editing/roadEdits';
import { StudyAreaExplorer, type DrivableObject } from '../simulation/StudyAreaExplorer';
import { applyNetworkCorrections, type NetworkCorrectionLayer } from '../simulation/networkCorrections';
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

function analyse(roads: DrivableObject[], layer: NetworkCorrectionLayer | null = null) {
  const sim = applyUrbanSpeeds(applyNetworkCorrections(roads, layer).roads).roads;
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

/**
 * The analysis builds its network from the roads with the network corrections
 * applied; a lane edit used to find its carriageway on the stored roads, so a
 * correction that reverses a way or makes it one-way or two-way could make
 * "Entire carriageway" and the direction's capacity stretch differ. Both now
 * read the same road view (SimulationMode.roadView, docs/OVERHAUL.md §21).
 * Hypothetical layers on the real ways: the shipped layer (pune_west_v1) does
 * reverse ways and change one-way status, elsewhere in the city.
 */
describe('network corrections: the edit scope and the analysis read the same roads', () => {
  const roads = () => structuredClone(fx.roads) as RoadObject[];
  const layer = (corrections: Partial<NetworkCorrectionLayer['corrections'][number]>[]): NetworkCorrectionLayer => ({
    schema: 'twincity.network_corrections/v1', id: 'test', version: '0', title: 'test', osm_snapshot: 'test',
    corrections: corrections.map((c, i) => ({ id: `c${i}`, junction_id: 'j', osm_way_id: 0, action: 'reverse', params: {}, evidence: ['test'], confidence: 'high', proposed_osm_edit: '', enabled: true, ...c })),
  });
  const viewOf = (l: NetworkCorrectionLayer) => (rs: readonly RoadObject[]) => applyNetworkCorrections(rs, l).roads as RoadObject[];

  it('a correction making a two-way way one-way: the edit stops where the analysis\' carriageway does', () => {
    // Hypothetical: Nyaymurti Ranade Path's two-way osm_750335054 one-way west (its drawn direction), as the stretch beyond it
    const l = layer([{ osm_way_id: Number(WEST_PIECE.slice(4)), action: 'set_oneway' }]);
    const { ctx, ne, sw } = analyse(roads(), l);
    for (const [field, d] of [['lanesForward', ne], ['lanesBackward', sw]] as const) {
      const scope = laneEditPreview(roads(), SEED, field, 'carriageway', viewOf(l)).roadIds;
      expect(scope).toEqual([SEED]);
      expect(new Set(ctx.directions[d].roadIds)).toEqual(new Set(scope));
    }
    // On the stored roads the edit took the way in, which in the analysis is the one-way stretch's first piece
    expect(new Set(laneEditPreview(roads(), SEED, 'lanesForward').roadIds)).toEqual(new Set([SEED, WEST_PIECE]));
    // Selected, the corrected way's westbound lanes reach on along the one-way stretch, edited in each stored way's direction
    const west = laneEditPlan(roads(), WEST_PIECE, 'lanesForward', 3, r => new ObjectManager().synthesizeDefaultSections(r), 'carriageway', viewOf(l));
    expect(new Set(west.map(p => p.id))).toEqual(new Set([WEST_PIECE, ...ONE_WAY]));
  });

  it('a correction making a stored one-way way two-way: the edit stops before it (its stored way has no lanes the other way)', () => {
    const l = layer(ONE_WAY.map(id => ({ osm_way_id: Number(id.slice(4)), action: 'set_two_way' as const, params: { lanes_forward: 1, lanes_backward: 1 } })));
    expect(new Set(laneEditPreview(roads(), SEED, 'lanesForward', 'carriageway', viewOf(l)).roadIds)).toEqual(new Set([SEED, WEST_PIECE]));
    // The analysis counts the corrected two-way ways in the north-east direction (docs/OVERHAUL.md §21, residual case)
    const { ctx, ne } = analyse(roads(), l);
    for (const id of ONE_WAY) expect(ctx.directions[ne].roadIds).toContain(id);
  });

  it('a correction reversing a way: the same pieces, each edited in the stored way\'s own direction', () => {
    const l = layer([{ osm_way_id: Number(WEST_PIECE.slice(4)), action: 'reverse' }]);
    const view = viewOf(l);
    expect(view(roads()).find(r => r.id === WEST_PIECE)!.coordinates[0]).toEqual(roads().find(r => r.id === WEST_PIECE)!.coordinates.at(-1));
    for (const field of ['lanesForward', 'lanesBackward'] as const) {
      const om = new ObjectManager();
      om.addMultiple(roads(), true);
      const synth = (r: RoadObject) => om.synthesizeDefaultSections(r);
      const plain = laneEditPlan(om.getAll() as RoadObject[], SEED, field, 2, synth);
      const viewed = laneEditPlan(om.getAll() as RoadObject[], SEED, field, 2, synth, 'carriageway', view);
      expect(viewed).toEqual(plain);
      const { ctx, ne, sw } = analyse(roads(), l);
      expect(new Set(ctx.directions[field === 'lanesForward' ? ne : sw].roadIds)).toEqual(new Set(viewed.map(p => p.id)));
    }
  });
});

/**
 * Infrastructure Feasibility Engine + investigation planner (docs/FEASIBILITY_ENGINE.md).
 * All site data here is SYNTHETIC: small hand-made OSM-shaped layers around a
 * point in central Pune, placed at known distances.
 */
import { describe, expect, it } from 'vitest';
import { assessFeasibility } from '../feasibility/siteAssessment';
import { evalAll, evalAny, planInvestigations, resolveThresholds, RULES } from '../feasibility/investigationPlanner';
import type { CityContextObject, OsmElement, ProposalInput, ProposalType, SiteData, SiteLayerKey } from '../feasibility/types';
import { CERTAINTY_LABEL } from '../feasibility/types';

const LAT0 = 18.52, LNG0 = 73.855;
const MY = 1 / 111195; // deg per metre (lat)
const MX = 1 / (111195 * Math.cos((LAT0 * Math.PI) / 180));
/** point at (east m, north m) from the origin */
const P = (e: number, n: number): [number, number] => [LNG0 + e * MX, LAT0 + n * MY];
const geom = (pts: [number, number][]) => pts.map(([lon, lat]) => ({ lon, lat }));
const square = (e: number, n: number, s = 10): OsmElement => ({
  type: 'way', id: Math.round(e * 1000 + n), tags: { building: 'yes' },
  geometry: geom([P(e, n), P(e + s, n), P(e + s, n + s), P(e, n + s), P(e, n)]),
});
const ALL: SiteLayerKey[] = ['buildings', 'metro', 'roads', 'water', 'heritage', 'trees', 'railway'];

function site(elements: Partial<Record<SiteLayerKey, OsmElement[]>>, unavailable: SiteLayerKey[] = []): SiteData {
  const layers = Object.fromEntries(ALL.map(k => [k, unavailable.includes(k) ? { available: false, reason: 'synthetic: not loaded' } : { available: true, source: 'synthetic' }])) as SiteData['layers'];
  return { bbox: [0, 0, 0, 0], layers, elements };
}

/** 400 m east-west alignment along the origin's latitude */
function proposal(type: ProposalType, level: ProposalInput['level'], widthM = 12): ProposalInput {
  return { name: `Synthetic ${type}`, scenarioId: 'base', objectIds: ['p1'], proposalType: type, level, line: [P(-200, 0), P(200, 0)], widthM, excavationDepthM: null };
}
const river = (n: number): OsmElement => ({ type: 'way', id: 900 + n, tags: { waterway: 'river', name: 'Synthetic river' }, geometry: geom([P(-800, n), P(800, n)]) });
const metro = (n: number): OsmElement => ({ type: 'way', id: 700 + n, tags: { railway: 'subway', name: 'Synthetic metro' }, geometry: geom([P(-800, n), P(800, n)]) });
const invIds = (a: ReturnType<typeof assessFeasibility>) => a.plan.investigations.map(i => i.id);
const rule = (a: ReturnType<typeof assessFeasibility>, id: string) => a.plan.ruleResults.find(r => r.id === id)!;

describe('tri-state evaluation (missing data never suppresses)', () => {
  it('all/any blocks follow the spec', () => {
    expect(evalAll([true, true])).toBe(true);
    expect(evalAll([true, 'unknown'])).toBe('unknown');
    expect(evalAll(['unknown', false])).toBe(false);
    expect(evalAny([false, 'unknown'])).toBe('unknown');
    expect(evalAny([false, true])).toBe(true);
    expect(evalAny([false, false])).toBe(false);
  });

  it('a rule on an unknown attribute fires its investigations and records a data gap', () => {
    const plan = planInvestigations('flyover', { withinBlueLine: { value: 'unknown', certainty: 'unknown', source: 'not imported' } });
    const r09 = plan.ruleResults.find(r => r.id === 'R09')!;
    expect(r09.result).toBe('unknown');
    expect(plan.dataGaps.some(g => g.ruleId === 'R09' && g.attrs.includes('withinBlueLine'))).toBe(true);
    expect(plan.investigations.map(i => i.id)).toContain('flood_line_verification');
    expect(plan.flags.find(f => f.ruleId === 'R09')!.onMissingData).toBe(true);
  });

  it('only hypothetical thresholds can be overridden', () => {
    const th = resolveThresholds({ influenceZoneM: 50, asiProhibitedM: 10 });
    expect(th.influenceZoneM.value).toBe(50);
    expect(th.asiProhibitedM.value).toBe(RULES.thresholds.asiProhibitedM.value);
  });
});

describe('known vs unknown constraints', () => {
  it('mapped buildings in the influence zone are verified; their absence is unknown, not zero', () => {
    const withB = assessFeasibility(proposal('tunnel', 'underground'), site({ buildings: [square(0, 10), square(50, -20), square(0, 500)] }), []);
    expect(withB.siteAttributes.buildingsInInfluenceZone).toMatchObject({ value: 2, certainty: 'verified_from_available_data' });
    expect(rule(withB, 'R04').result).toBe(true);
    const none = assessFeasibility(proposal('tunnel', 'underground'), site({ buildings: [square(0, 500)] }), []);
    expect(none.siteAttributes.buildingsInInfluenceZone.value).toBe('unknown');
    expect(rule(none, 'R04').result).toBe('unknown');
    expect(invIds(none)).toContain('building_condition_survey'); // still required
    const noLayer = assessFeasibility(proposal('tunnel', 'underground'), site({}, ['buildings']), []);
    expect(noLayer.siteAttributes.buildingsInInfluenceZone.certainty).toBe('unknown');
  });

  it('city-model buildings count too, without double-counting their OSM copy', () => {
    const b = square(0, 10);
    const city: CityContextObject[] = [{ id: 'b1', type: 'building', name: 'Synthetic block', osmId: b.id, coordinates: b.geometry!.map(g => [g.lon, g.lat, 0]) }];
    const a = assessFeasibility(proposal('flyover', 'elevated'), site({ buildings: [b] }), city);
    expect(a.siteAttributes.buildingsInInfluenceZone.value).toBe(1);
  });

  it('water: distance to a mapped river is verified; no water layer means unknown and the water rule still fires', () => {
    const far = assessFeasibility(proposal('flyover', 'elevated'), site({ water: [river(400)] }), []);
    expect(far.siteAttributes.distanceToWaterwayM.value).toBeCloseTo(400, -1);
    expect(far.siteAttributes.crossesWaterway).toMatchObject({ value: false, certainty: 'estimated' });
    expect(rule(far, 'R08').result).toBe(false);
    expect(rule(far, 'R08').evidence.find(e => e.attr === 'distanceToWaterwayM')!.certainty).toBe('verified_from_available_data');
    const crossing = assessFeasibility(proposal('bridge', 'elevated'), site({ water: [{ type: 'way', id: 1, tags: { waterway: 'river' }, geometry: geom([P(0, -300), P(0, 300)]) }] }), []);
    expect(crossing.siteAttributes.crossesWaterway.value).toBe(true);
    expect(rule(crossing, 'R08').result).toBe(true);
    const missing = assessFeasibility(proposal('flyover', 'elevated'), site({}, ['water']), []);
    expect(missing.siteAttributes.distanceToWaterwayM.value).toBe('unknown');
    expect(rule(missing, 'R08').result).toBe('unknown');
    expect(invIds(missing)).toContain('hydrology_hydraulics');
  });

  it('flood lines are never assumed: blue/red line rules fire as data gaps', () => {
    const a = assessFeasibility(proposal('road_widening', 'surface'), site({ water: [river(5000)] }), []);
    expect(a.siteAttributes.withinBlueLine.certainty).toBe('unknown');
    expect(a.plan.dataGaps.map(g => g.ruleId)).toEqual(expect.arrayContaining(['R09', 'R10']));
  });

  it('heritage: a nearby OSM historic feature restricts (estimated); a far one leaves listed status unknown', () => {
    const near = assessFeasibility(proposal('flyover', 'elevated'), site({ heritage: [{ type: 'node', id: 5, lon: P(0, 30)[0], lat: P(0, 30)[1], tags: { historic: 'castle', name: 'Synthetic wada' } }] }), []);
    expect(near.siteAttributes.distanceToListedHeritageM).toMatchObject({ certainty: 'estimated' });
    expect(rule(near, 'R13').result).toBe(true);
    expect(near.findings.some(f => f.topic === 'heritage' && f.statement.includes('Synthetic wada'))).toBe(true);
    const far = assessFeasibility(proposal('flyover', 'elevated'), site({ heritage: [{ type: 'node', id: 6, lon: P(0, 600)[0], lat: P(0, 600)[1], tags: { historic: 'memorial' } }] }), []);
    expect(far.siteAttributes.distanceToListedHeritageM.value).toBe('unknown');
    expect(rule(far, 'R13').result).toBe('unknown');
    expect(far.siteAttributes.distanceToAsiProtectedLimitM.value).toBe('unknown');
  });

  it('metro: within 20 m raises the critical NOC flag; 800 m excludes it with verified data', () => {
    const close = assessFeasibility(proposal('flyover', 'elevated'), site({ metro: [metro(15)] }), []);
    expect(rule(close, 'R06').result).toBe(true);
    expect(close.plan.flags.some(f => f.ruleId === 'R06' && f.severity === 'critical')).toBe(true);
    const far = assessFeasibility(proposal('flyover', 'elevated'), site({ metro: [metro(800)] }), []);
    expect(rule(far, 'R06').result).toBe(false);
    expect(rule(far, 'R07').result).toBe(false);
  });

  it('railway crossing is verified from the layer', () => {
    const a = assessFeasibility(proposal('new_road', 'surface'), site({ railway: [{ type: 'way', id: 3, tags: { railway: 'rail', name: 'Synthetic line' }, geometry: geom([P(0, -300), P(0, 300)]) }] }), []);
    expect(a.siteAttributes.crossesRailway).toMatchObject({ value: true, certainty: 'verified_from_available_data' });
    expect(invIds(a)).toContain('railway_interface');
  });

  it('road widening wider than the OSM width tag is flagged as beyond the existing road (estimated)', () => {
    const road: OsmElement = { type: 'way', id: 11, tags: { highway: 'primary', width: '12', name: 'Synthetic Road' }, geometry: geom([P(-300, 0), P(300, 0)]) };
    const a = assessFeasibility(proposal('road_widening', 'surface', 24), site({ roads: [road] }), []);
    expect(a.siteAttributes.outsideExistingRoW).toMatchObject({ value: true, certainty: 'estimated' });
    expect(rule(a, 'R17').result).toBe(true);
    const same = assessFeasibility(proposal('road_widening', 'surface', 10), site({ roads: [road] }), []);
    expect(same.siteAttributes.outsideExistingRoW.value).toBe('unknown'); // a width tag is not the legal RoW
  });
});

describe('missing evidence', () => {
  it('no geotechnical / groundwater / utility data ⇒ investigations required for every physical type', () => {
    for (const t of ['tunnel', 'flyover', 'road_widening', 'bridge', 'new_road'] as ProposalType[]) {
      const a = assessFeasibility(proposal(t, t === 'tunnel' ? 'underground' : t === 'flyover' || t === 'bridge' ? 'elevated' : 'surface'), site({}), []);
      expect(a.siteAttributes.geotechDataAvailable.value).toBe(false);
      expect(invIds(a)).toEqual(expect.arrayContaining(['geotechnical_investigation', 'utility_survey', 'tree_census', 'topographic_survey']));
      expect(a.verdict).toBe('screening_only');
    }
  });

  it('every finding has an allowed certainty label and a data source; no finding claims feasibility', () => {
    const a = assessFeasibility(proposal('tunnel', 'underground'), site({ buildings: [square(0, 10)], water: [river(300)], metro: [metro(100)] }), []);
    for (const f of a.findings) {
      expect(Object.keys(CERTAINTY_LABEL)).toContain(f.certainty);
      expect(f.source.length).toBeGreaterThan(0);
      expect(f.statement.toLowerCase()).not.toMatch(/\bfeasible\b|\bsafe to\b|approved|(?<!prove )land is available/);
    }
    expect(a.findings.some(f => f.topic === 'ground' && f.statement.includes('cannot state that the tunnel is safe'))).toBe(true);
  });
});

describe('proposal-specific investigation requirements', () => {
  const s = site({ buildings: [square(0, 10)] });
  const tunnel = assessFeasibility(proposal('tunnel', 'underground'), s, []);
  const flyover = assessFeasibility(proposal('flyover', 'elevated'), s, []);
  const widening = assessFeasibility(proposal('road_widening', 'surface'), s, []);

  it('tunnel: geology, groundwater, seismic and tunnel engineering, with the critical underground flag', () => {
    expect(invIds(tunnel)).toEqual(expect.arrayContaining(['geological_mapping', 'groundwater_investigation', 'seismic_assessment', 'tunnel_engineering_studies']));
    expect(tunnel.plan.flags[0]).toMatchObject({ ruleId: 'R03', severity: 'critical' });
    expect(invIds(tunnel)).not.toContain('structure_design_basis');
  });
  it('flyover: structure design basis and ramp geometry, no tunnel studies', () => {
    expect(invIds(flyover)).toEqual(expect.arrayContaining(['structure_design_basis', 'geometry_access_study']));
    expect(invIds(flyover)).not.toContain('tunnel_engineering_studies');
    expect(invIds(flyover)).not.toContain('geological_mapping');
  });
  it('widening: pavement/drainage and land acquisition, no structure or tunnel studies', () => {
    expect(invIds(widening)).toEqual(expect.arrayContaining(['pavement_drainage', 'land_acquisition_social']));
    expect(invIds(widening)).not.toContain('structure_design_basis');
    expect(invIds(widening)).not.toContain('tunnel_engineering_studies');
  });
  it('the three plans differ and de-duplicate investigations with all triggering rules', () => {
    const sets = [tunnel, flyover, widening].map(a => invIds(a).sort().join(','));
    expect(new Set(sets).size).toBe(3);
    for (const a of [tunnel, flyover, widening]) expect(new Set(invIds(a)).size).toBe(invIds(a).length);
    expect(tunnel.plan.investigations.find(i => i.id === 'geotechnical_investigation')!.triggeredBy).toEqual(expect.arrayContaining(['R03', 'R14']));
  });
});

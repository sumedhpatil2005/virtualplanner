import { describe, expect, it } from 'vitest';
import type { UndergroundAlignmentObject } from '../objects/types';
import { buildAlignment, withVertexDepth } from '../underground/alignmentFactory';
import { crownElevAt, elevationProfile, groundAt, groundSamples, layoutElevationProfile, mapUtmChainage } from '../underground/terrainProfile';
import type { ProfileSample, SewerCrossing } from '../../lib/terrainApi';

/**
 * DEM ground line for the Underground long-section (docs/urbanos/TERRAIN_AND_SUBSURFACE_DATA.md §4). SYNTHETIC geometry
 * and SYNTHETIC elevations (no server): nodata is never filled, depths stay relative to the DSM.
 */
const LAT0 = 18.53;
const kx = 111320 * Math.cos(LAT0 * Math.PI / 180), ky = 110574;
const pt = (x: number, y: number): [number, number, number] => [73.85 + x / kx, LAT0 + y / ky, 0];
const tunnel = (): UndergroundAlignmentObject => buildAlignment({
  id: 'ug1', scenarioId: 'P', points: [pt(0, 0), pt(100, 0), pt(200, 0)], kind: 'bored_tunnel', crownDepthM: 10, depthCertainty: 'estimated',
  section: { shape: 'circular', diameterM: 6 }, sectionCertainty: 'hypothetical', createdAt: 'synthetic',
});
/** samples every 25 m on both segments; ground = 560 − 0.05·chainage; optional nodata chainages */
const samples = (nodata: number[] = []): ProfileSample[] => {
  const out: ProfileSample[] = [];
  for (let seg = 0; seg < 2; seg++) for (let k = 0; k <= (seg === 1 ? 4 : 3); k++) {
    const ch = seg * 100 + k * 25;
    const bad = nodata.includes(ch);
    out.push({ chainage_m: ch, segment: seg, t: k / 4, lon: 0, lat: 0, elevation_m: bad ? null : 560 - 0.05 * ch, status: bad ? 'nodata' : 'ok' });
  }
  return out;
};

describe('terrain ground line', () => {
  it('maps server samples onto editor chainage by segment + fraction', () => {
    const g = groundSamples(tunnel(), { samples: samples() });
    expect(g.map(s => Math.round(s.chainageM))).toEqual([0, 25, 50, 75, 100, 125, 150, 175, 200]);
    expect(groundAt(g, 60)).toBeCloseTo(557, 6);
  });

  it('never interpolates the ground across nodata; crown = ground − depth at vertices', () => {
    const a = tunnel();
    const ep = elevationProfile(a, { samples: samples([125]) });
    expect(groundAt(ep.samples, 110)).toBeNull();
    expect(groundAt(ep.samples, 125)).toBeNull();
    expect(ep.groundRuns.length).toBe(2);
    expect(ep.unknownGround.map(g => g.map(Math.round))).toEqual([[125, 150]]);
    expect(ep.vertices.map(v => v.crownElevM)).toEqual([550, 545, 540]);
    expect(ep.vertices[1].invertElevM).toBe(539);   // 6 m section
    expect(ep.coverageFraction).toBeCloseTo(8 / 9, 6);
    // straight grade in elevation between vertices; least depth below DSM along the run
    expect(crownElevAt(ep.runs[0].vertices, 50)).toBeCloseTo(547.5, 6);
    expect(ep.runs[0].minCoverM).toBeCloseTo(10, 6);
  });

  it('UNKNOWN depth or UNKNOWN ground breaks the crown run and is marked', () => {
    const a = withVertexDepth(tunnel(), 1, { crownDepthM: null });
    const ep = elevationProfile(a, { samples: samples() });
    expect(ep.vertices[1].crownElevM).toBeNull();
    expect(ep.runs.length).toBe(0);
    const out = elevationProfile(tunnel(), { samples: samples([200]) });
    expect(out.vertices[2].groundM).toBeNull();
    const L = layoutElevationProfile(tunnel(), [], { samples: samples([200]) }, [], { width: 800, height: 200 });
    expect(L.unknownVertices.map(u => u.reason)).toEqual(['ground UNKNOWN (outside DEM coverage)']);
    expect(L.crownRuns.length).toBe(1);
  });

  it('outside coverage everywhere: no ground runs, coverage 0', () => {
    const s = samples().map(x => ({ ...x, elevation_m: null, status: 'outside_coverage' as const }));
    const ep = elevationProfile(tunnel(), { samples: s });
    expect(ep.groundRuns).toEqual([]);
    expect(ep.coverageFraction).toBe(0);
    expect(ep.vertices.every(v => v.crownElevM === null)).toBe(true);
  });

  it('places sewer inverts (QL-D) on the elevation axis; null invert stays unplaced', () => {
    const sw = (ch: number, inv: number | null) => ({ chainageM: ch, chainage_m_utm: ch, invert_at_crossing_m: inv, diameter_m: 0.3, label: 'S', pipeline_id: 'P' } as SewerCrossing & { chainageM: number });
    const L = layoutElevationProfile(tunnel(), [], { samples: samples() }, [sw(50, 552), sw(150, null)], { width: 800, height: 200 });
    expect(L.sewers[0].y).not.toBeNull();
    expect(L.sewers[1].y).toBeNull();
    expect(L.y.d0).toBeGreaterThan(560);          // axis covers the ground
    expect(L.y.d1).toBeLessThan(539);             // and the invert
  });

  it('maps UTM chainage onto editor chainage piecewise', () => {
    expect(mapUtmChainage(50, [0, 100.1, 200.2], [0, 100, 200])).toBeCloseTo(49.95, 2);
    expect(mapUtmChainage(150.15, [0, 100.1, 200.2], [0, 100, 200])).toBeCloseTo(150, 2);
    expect(mapUtmChainage(9, [0], [0])).toBe(9);
  });
});

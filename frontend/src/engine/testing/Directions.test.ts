import { describe, it, expect } from 'vitest';
import type { RoadObject } from '../objects/types';
import type { DrivableObject } from '../simulation/StudyAreaExplorer';
import { StudyAreaExplorer } from '../simulation/StudyAreaExplorer';
import { roadSection } from '../simulation/roadSection';
import { sectionDirections } from '../simulation/RoadAnalysis';
import {
  bearingBetween, boundLabel, compassWord, compassShort, directionTitle, labelBearings, landmarkPhrase, overallBearing, screenArrowDeg,
  downstreamLandmark, reliableRoadName,
} from '../simulation/directions';
import { SimulationMode } from '../simulation/SimulationMode';
import { arrowPieces, directionOfArrowId, arrowId } from '../rendering/renderers/DirectionArrows';

/**
 * Direction of travel on the selected road (docs/OVERHAUL.md §11): the
 * compass word from the geometry, the arrow glyph turned for the camera
 * heading, the landmark from the roads it leads into (never invented), and
 * the map arrows' placement.
 */

const LAT0 = 18.5;
const KX = 111320 * Math.cos(LAT0 * Math.PI / 180);
const pt = (x: number, y: number, z = 0): [number, number, number] => [73.8 + x / KX, LAT0 + y / 111320, z];
const osmTags = (highway: string, extra: Record<string, string> = {}) => ({ osmId: 1, originalTags: { highway, ...extra }, layer: 0, bridge: false, tunnel: false, roundabout: false });
const road = (id: string, a: [number, number], b: [number, number], extra: Partial<RoadObject> = {}): RoadObject => ({
  id, type: 'road', name: id, layerId: 'roads', scenarioId: 'base', coordinates: [pt(...a), pt(...b)], roadClass: 'arterial', width: 10, laneCount: 2, laneWidth: 3.5,
  hasDivider: false, dividerWidth: 0, hasFootpath: false, footpathWidth: 0, speedLimit: 50, isOneWay: false, trafficCapacity: 2000, connectedJunctions: [], createdAt: '', updatedAt: '', ...extra,
} as RoadObject);

describe('bearing to compass word', () => {
  it('measures bearings clockwise from north, with east distances scaled by latitude', () => {
    expect(bearingBetween(pt(0, 0), pt(0, 100))).toBeCloseTo(0, 6);
    expect(bearingBetween(pt(0, 0), pt(100, 0))).toBeCloseTo(90, 6);
    expect(bearingBetween(pt(0, 0), pt(0, -100))).toBeCloseTo(180, 6);
    expect(bearingBetween(pt(0, 0), pt(-100, 0))).toBeCloseTo(270, 6);
    // Equal metres east and north is 45 degrees, although the degree offsets differ at 18.5 N
    expect(bearingBetween(pt(0, 0), pt(100, 100))).toBeCloseTo(45, 6);
  });

  it('names the eight compass points, splitting at the half-way bearings', () => {
    expect([0, 45, 90, 135, 180, 225, 270, 315].map(compassWord)).toEqual(['north', 'north-east', 'east', 'south-east', 'south', 'south-west', 'west', 'north-west']);
    expect(compassWord(22)).toBe('north');
    expect(compassWord(23)).toBe('north-east');
    expect(compassWord(337)).toBe('north-west');
    expect(compassWord(338)).toBe('north');
    expect(compassWord(359.9)).toBe('north');
    expect(compassWord(-45)).toBe('north-west');
    expect(compassShort(157)).toBe('SE');
    expect(boundLabel(90)).toBe('eastbound');
    expect(boundLabel(226)).toBe('towards the south-west');
  });

  it('takes a direction\'s bearing over its whole length, not from its first piece', () => {
    // A short kink east, then a long run north: overall still north
    expect(compassWord(overallBearing([[pt(0, 0), pt(20, 5)], [pt(20, 5), pt(20, 300)]]))).toBe('north');
  });

  it('labels the two directions of one road as an opposite pair when rounding falls either side of a boundary', () => {
    // Bearings of 337.6 and 157 degrees (a road close to the N/NW boundary) round to north and south-east on their own
    expect([compassWord(337.6), compassWord(157)]).toEqual(['north', 'south-east']);
    const [a, b] = labelBearings([337.6, 157]);
    expect(compassWord(a)).toBe('north-west');
    expect(compassWord(b)).toBe('south-east');
    const [c, d] = labelBearings([339, 160]);
    expect([compassWord(c), compassWord(d)]).toEqual(['north', 'south']);
    expect(((a - b) % 360 + 360) % 360).toBeCloseTo(180, 9);
    // Not opposite (a junction's arms, or one direction): left alone
    expect(labelBearings([10, 100])).toEqual([10, 100]);
    expect(labelBearings([200])).toEqual([200]);
  });
});

describe('arrow glyph turned for the camera heading', () => {
  it('points the way the road runs on screen', () => {
    // North-up camera: the glyph is the bearing itself
    expect(screenArrowDeg(45, 0)).toBeCloseTo(45, 9);
    // Camera looking east: a north-east road runs up-left on screen
    expect(screenArrowDeg(45, Math.PI / 2)).toBeCloseTo(315, 9);
    // Looking along the road: straight up; looking back down it: straight down
    expect(screenArrowDeg(338, (338 * Math.PI) / 180)).toBeCloseTo(0, 9);
    expect(screenArrowDeg(158, (338 * Math.PI) / 180)).toBeCloseTo(180, 9);
    // Rotated 120 degrees: the north-west carriageway turns 120 degrees anticlockwise on screen
    expect(screenArrowDeg(338, (120 * Math.PI) / 180)).toBeCloseTo(218, 9);
    // Headings above a full turn or negative wrap round
    expect(screenArrowDeg(10, -Math.PI / 2)).toBeCloseTo(100, 9);
    expect(screenArrowDeg(10, 2 * Math.PI + Math.PI / 2)).toBeCloseTo(280, 9);
  });
});

describe('landmark labels from the network', () => {
  const explore = (roads: DrivableObject[], seed: string) => {
    const map = new Map(roads.map(r => [r.id, r]));
    const area = new StudyAreaExplorer().explore(roads, 1, { seedRoadIds: [seed], rangeMeters: 1500, direction: 'both' });
    const section = roadSection(area, map, [seed]);
    return { map, area, section, dirs: sectionDirections(area, section, map) };
  };

  it('names the road each direction carries straight on into', () => {
    const { dirs } = explore([
      road('osm_bridge', [0, 0], [0, 300], { name: 'River Bridge', osmProvenance: osmTags('trunk') }),
      road('osm_n', [0, 300], [0, 700], { name: 'Jangali Maharaj Road', osmProvenance: osmTags('primary') }),
      road('osm_s', [0, 0], [0, -400], { name: 'Shivaji Road', osmProvenance: osmTags('primary') }),
    ], 'osm_bridge');
    const north = dirs.find(d => d.compass === 'north')!, south = dirs.find(d => d.compass === 'south')!;
    expect(north.towards).toEqual({ name: 'Jangali Maharaj Road', kind: 'into' });
    expect(south.towards).toEqual({ name: 'Shivaji Road', kind: 'into' });
    expect(directionTitle(north.compass, north.towards)).toBe('North, towards Jangali Maharaj Road');
    // Geometry in travel order: the northbound path climbs, the southbound one falls
    expect(north.paths[0][0][1]).toBeLessThan(north.paths[0][north.paths[0].length - 1][1]);
    expect(south.paths[0][0][1]).toBeGreaterThan(south.paths[0][south.paths[0].length - 1][1]);
  });

  it('follows unnamed pieces and the road\'s own continuation, but not a placeholder name', () => {
    const { dirs } = explore([
      road('osm_a', [0, 0], [300, 0], { name: 'Kelkar Road', osmProvenance: osmTags('secondary') }),
      road('osm_link', [300, 0], [360, 0], { name: 'Secondary_link Road', osmProvenance: osmTags('secondary_link') }),
      road('osm_east', [360, 0], [800, 0], { name: 'Tilak Road', osmProvenance: osmTags('secondary') }),
      road('osm_west', [0, 0], [-400, 0], { name: 'Residential Road', roadClass: 'local', osmProvenance: osmTags('residential') }),
    ], 'osm_a');
    expect(dirs.find(d => d.compass === 'east')!.towards).toEqual({ name: 'Tilak Road', kind: 'into' });
    // Only a placeholder-named road lies ahead: compass only
    expect(dirs.find(d => d.compass === 'west')!.towards).toBeNull();
  });

  it('gives no road at a fork, then names the main road met at the end when there is one', () => {
    const { dirs } = explore([
      road('osm_a', [0, 0], [0, 300], { name: 'Bridge Road', osmProvenance: osmTags('secondary') }),
      // Two roads leaving almost straight on: no single road ahead
      road('osm_l', [0, 300], [-60, 700], { name: 'Left Fork Road', roadClass: 'local', osmProvenance: osmTags('residential') }),
      road('osm_r', [0, 300], [60, 700], { name: 'Right Fork Road', roadClass: 'local', osmProvenance: osmTags('residential') }),
      // A main road crossing at the end
      road('osm_x', [-400, 300], [0, 300], { name: 'Ring Road', roadClass: 'arterial', osmProvenance: osmTags('primary') }),
      road('osm_x2', [0, 300], [400, 300], { name: 'Ring Road', roadClass: 'arterial', osmProvenance: osmTags('primary') }),
    ], 'osm_a');
    const north = dirs.find(d => d.compass === 'north')!;
    expect(north.towards).toEqual({ name: 'Ring Road', kind: 'junction' });
    expect(landmarkPhrase(north.towards!)).toBe('to the junction with Ring Road');
  });

  it('uses a signed OSM destination on a one-way piece driven into', () => {
    const roads: DrivableObject[] = [
      road('osm_a', [0, 0], [0, 300], { name: 'Bridge Road', isOneWay: true, osmProvenance: osmTags('secondary', { oneway: 'yes' }) }),
      road('osm_ramp', [0, 300], [0, 400], { name: 'Primary_link Road', isOneWay: true, osmProvenance: osmTags('primary_link', { oneway: 'yes', destination: 'Deccan;Swargate' }) }),
    ];
    const { dirs } = explore(roads, 'osm_a');
    expect(dirs).toHaveLength(1);
    expect(dirs[0].towards).toEqual({ name: 'Deccan', kind: 'into' });
  });

  it('never invents a name: a road without anything named ahead keeps only the compass word', () => {
    const { dirs } = explore([road('osm_a', [0, 0], [300, 300], { name: 'Lone Road', osmProvenance: osmTags('secondary') })], 'osm_a');
    expect(dirs.map(d => [d.compass, d.towards])).toEqual([['north-east', null], ['south-west', null]]);
    expect(directionTitle('south-west', null)).toBe('South-west');
  });

  it('reads a real name only (English where the name is in another script)', () => {
    expect(reliableRoadName(road('a', [0, 0], [1, 0], { name: 'Tertiary Road' }))).toBeNull();
    expect(reliableRoadName(road('a', [0, 0], [1, 0], { name: 'शिवाजी रस्ता', osmProvenance: osmTags('primary', { 'name:en': 'Shivaji Road' }) }))).toBe('Shivaji Road');
    expect(reliableRoadName(undefined)).toBeNull();
  });

  it('returns null for an edge the network does not hold', () => {
    expect(downstreamLandmark({ nodes: new Map(), edges: new Map() }, new Map(), 'missing', new Set(), new Set())).toBeNull();
  });
});

describe('direction arrows on the map', () => {
  it('spaces short arrow pieces along the road, shifted to the left of travel', () => {
    const north = [pt(0, 0), pt(0, 450)];
    const pieces = arrowPieces(north, 4);
    expect(pieces.length).toBe(5);
    for (const p of pieces) {
      // Left of northbound travel is west, 4 m
      for (const q of p) expect((q[0] - north[0][0]) * KX).toBeCloseTo(-4, 3);
      // Each piece runs the way of travel
      expect(p[p.length - 1][1]).toBeGreaterThan(p[0][1]);
    }
    // The opposite direction on the same centre line sits 8 m away, on the east side
    const south = arrowPieces([pt(0, 450), pt(0, 0)], 4);
    expect((south[0][0][0] - north[0][0]) * KX).toBeCloseTo(4, 3);
  });

  it('follows the road\'s bends and skips degenerate paths', () => {
    const bend = arrowPieces([pt(0, 0), pt(0, 100), pt(100, 100)], 0);
    expect(bend.length).toBeGreaterThanOrEqual(2);
    expect(arrowPieces([pt(0, 0)])).toEqual([]);
    expect(arrowPieces([pt(0, 0), pt(0, 1)])).toEqual([]);
  });

  it('tells which direction a picked arrow belongs to', () => {
    expect(directionOfArrowId(arrowId(1, 3))).toBe(1);
    expect(directionOfArrowId('osm_123')).toBeNull();
    expect(directionOfArrowId(undefined)).toBeNull();
  });
});

describe('direction highlight state', () => {
  it('ignores a highlight index with no direction list behind it', () => {
    const mode = new SimulationMode(() => []);
    mode.pinDirection(0);
    mode.hoverDirection(1);
    expect(mode.getState().directionFocus).toEqual({ hover: null, pinned: null });
  });

  it('labels, numbers and turns the glyph from one bearing: the pair\'s shared axis', () => {
    const roads: DrivableObject[] = [road('osm_a', [0, 0], [-120, 290], { name: 'Bridge', osmProvenance: osmTags('secondary') })];
    const map = new Map(roads.map(r => [r.id, r]));
    const area = new StudyAreaExplorer().explore(roads, 1, { seedRoadIds: ['osm_a'], rangeMeters: 800, direction: 'both' });
    const dirs = sectionDirections(area, roadSection(area, map, ['osm_a']), map);
    for (const d of dirs) {
      expect(compassWord(d.labelBearing)).toBe(d.compass);
      expect(Math.min(Math.abs(d.labelBearing - d.bearing), 360 - Math.abs(d.labelBearing - d.bearing))).toBeLessThan(15);
    }
    expect(((dirs[0].labelBearing - dirs[1].labelBearing) % 360 + 360) % 360).toBeCloseTo(180, 6);
  });
});

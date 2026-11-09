/**
 * The local network-correction layer: each action, the shipped layer, the
 * roundabout one-way implication, and the effect at Kasturi Chowk's arms.
 */
import { describe, it, expect } from 'vitest';
import * as fs from 'fs';
import * as path from 'path';
import type { RoadObject } from '../objects/types';
import { applyNetworkCorrections, validateCorrectionLayer, impliesOneWay, osmRoadClass, type NetworkCorrectionLayer, type NetworkCorrection } from '../simulation/networkCorrections';
import { StudyAreaExplorer } from '../simulation/StudyAreaExplorer';
import { TrafficMicroSim } from '../simulation/TrafficMicroSim';

const LAYER_FILE = path.resolve(__dirname, '../../../../backend/data/network_corrections/pune_west_v1.json');
const LAT0 = 18.5, M_LAT = 1 / 111320, M_LNG = 1 / (111320 * Math.cos((LAT0 * Math.PI) / 180));
const pt = (x: number, y: number): [number, number, number] => [73.8 + x * M_LNG, LAT0 + y * M_LAT, 0];
const osmRoad = (id: number, pts: [number, number][], tags: Record<string, string>, oneWay: boolean, lanes = 2): RoadObject => ({
  id: `osm_${id}`, type: 'road', name: `way ${id}`, layerId: 'roads', scenarioId: 'base', coordinates: pts.map(p => pt(...p)),
  roadClass: 'arterial', width: 7, laneCount: lanes, laneWidth: 3.5, hasDivider: false, dividerWidth: 0, hasFootpath: false, footpathWidth: 0,
  speedLimit: 50, isOneWay: oneWay, trafficCapacity: lanes * 1000, connectedJunctions: [], createdAt: '', updatedAt: '',
  sections: [{ startNodeIndex: 0, endNodeIndex: pts.length - 1, totalRowWidth: 7, wideningPossible: true, hasMedian: false, medianWidth: 0,
    carriagewayA: { direction: oneWay ? 'forward' : 'both', lanes: oneWay ? lanes : lanes / 2, laneWidth: 3.5, leftRoadside: {} as never, rightRoadside: {} as never },
    carriagewayB: oneWay ? undefined : { direction: 'backward', lanes: lanes / 2, laneWidth: 3.5, leftRoadside: {} as never, rightRoadside: {} as never }, reservedSpaces: [] } as never],
  osmProvenance: { osmId: id, osmElementType: 'way', osmSourceId: `way/${id}`, originalTags: tags, layer: 0, bridge: false, tunnel: false, roundabout: tags.junction === 'roundabout' } as never,
});
const layerOf = (corrections: Partial<NetworkCorrection>[]): NetworkCorrectionLayer => ({
  schema: 'twincity.network_corrections/v1', id: 't', version: '1', title: 't', osm_snapshot: 't',
  corrections: corrections.map((c, i) => ({ id: `c${i}`, junction_id: 'j', params: {}, evidence: ['test evidence'], confidence: 'high', proposed_osm_edit: 'x', enabled: true, ...c } as NetworkCorrection)),
});

describe('network corrections', () => {
  it('reverses a one-way way, keeping it one-way, and reports what it changed', () => {
    const r = osmRoad(1, [[0, 0], [100, 0], [200, 5]], { oneway: 'yes' }, true);
    const { roads, report } = applyNetworkCorrections([r], layerOf([{ osm_way_id: 1, action: 'reverse' }]));
    const c = roads[0] as RoadObject;
    expect(c.coordinates).toEqual([...r.coordinates].reverse());
    expect(c.isOneWay).toBe(true);
    expect(report.applied).toEqual([{ id: 'c0', roadIds: ['osm_1'] }]);
    // The stored road is not modified
    expect(r.coordinates[0]).toEqual(pt(0, 0));
  });

  it('applies to every clipped piece of a way, and lists corrections whose way is absent', () => {
    const a = { ...osmRoad(2, [[0, 0], [100, 0]], { oneway: 'yes' }, true), id: 'osm_2_in_area_x_0' };
    const b = { ...osmRoad(2, [[100, 0], [200, 0]], { oneway: 'yes' }, true), id: 'osm_2_in_area_x_1' };
    const { report } = applyNetworkCorrections([a, b], layerOf([{ osm_way_id: 2, action: 'reverse' }, { osm_way_id: 99, action: 'reverse' }]));
    expect(report.applied[0].roadIds).toEqual(['osm_2_in_area_x_0', 'osm_2_in_area_x_1']);
    expect(report.notFound).toEqual(['c1']);
  });

  it('makes a way two-way with the given lanes, sets lanes, marks a roundabout, and can be switched off', () => {
    const r = osmRoad(3, [[0, 0], [100, 0]], { oneway: 'yes', lanes: '4' }, true, 4);
    const layer = layerOf([{ osm_way_id: 3, action: 'set_two_way', params: { lanes_forward: 2, lanes_backward: 2 } }]);
    const two = applyNetworkCorrections([r], layer).roads[0] as RoadObject;
    expect(two.isOneWay).toBe(false);
    expect(two.sections![0].carriagewayA!.lanes).toBe(2);
    expect(two.sections![0].carriagewayB!.lanes).toBe(2);
    const lanes = applyNetworkCorrections([r], layerOf([{ osm_way_id: 3, action: 'set_lanes', params: { lanes: 2 } }])).roads[0] as RoadObject;
    expect(lanes.laneCount).toBe(2);
    expect(lanes.sections![0].carriagewayA!.lanes).toBe(2);
    const ring = applyNetworkCorrections([r], layerOf([{ osm_way_id: 3, action: 'set_roundabout' }])).roads[0] as RoadObject;
    expect(ring.osmProvenance!.roundabout).toBe(true);
    // Off: the road comes back exactly as stored
    expect(applyNetworkCorrections([r], layer, false).roads[0]).toBe(r);
    const disabled = layerOf([{ osm_way_id: 3, action: 'set_two_way', params: { lanes_forward: 2, lanes_backward: 2 }, enabled: false }]);
    expect(applyNetworkCorrections([r], disabled).roads[0]).toBe(r);
  });

  it('a slip road or ramp (*_link) takes its parent road\'s class; trunk_link and secondary_link imported as local are corrected, a class set in Build is kept', () => {
    // Every *_link as its parent (the importer gave trunk_link and secondary_link local, unlike motorway_link, primary_link, tertiary_link)
    for (const [hw, cls] of [['motorway', 'highway'], ['trunk', 'highway'], ['primary', 'arterial'], ['secondary', 'arterial'], ['tertiary', 'collector'], ['residential', 'local'], ['service', 'local']] as const) {
      expect(osmRoadClass(hw), hw).toBe(cls);
      if (!['residential', 'service'].includes(hw)) expect(osmRoadClass(`${hw}_link`), `${hw}_link`).toBe(cls);
    }
    const imported = (id: number, hw: string, cls: RoadObject['roadClass']) => ({ ...osmRoad(id, [[0, 0], [30, 0]], { highway: hw }, true), roadClass: cls });
    const { roads, report } = applyNetworkCorrections([imported(11, 'trunk_link', 'local'), imported(12, 'secondary_link', 'local'), imported(13, 'secondary_link', 'collector'), imported(14, 'primary_link', 'arterial'), imported(15, 'residential', 'local')], null);
    expect(roads.map(r => (r as RoadObject).roadClass)).toEqual(['highway', 'arterial', 'collector', 'arterial', 'local']);
    expect(report.impliedClass).toEqual(['osm_11', 'osm_12']);
  });

  it('treats junction=roundabout as one-way unless the way says oneway=no (OSM wiki)', () => {
    expect(impliesOneWay({ junction: 'roundabout' })).toBe(true);
    expect(impliesOneWay({ junction: 'roundabout', oneway: 'no' })).toBe(false);
    expect(impliesOneWay({ highway: 'primary' })).toBe(false);
    const ring = osmRoad(4, [[0, 0], [10, 10], [0, 20]], { junction: 'roundabout' }, false);
    const { roads, report } = applyNetworkCorrections([ring], null);
    expect((roads[0] as RoadObject).isOneWay).toBe(true);
    expect((roads[0] as RoadObject).sections![0].carriagewayB).toBeUndefined();
    expect(report.impliedOneWay).toEqual(['osm_4']);
    // The whole carriageway carries the one direction: an untagged ring keeps the importer's
    // lane count (as an explicitly oneway=yes untagged way gets), not one direction's half of it
    expect((roads[0] as RoadObject).laneCount).toBe(2);
    expect((roads[0] as RoadObject).sections![0].carriagewayA!.lanes).toBe(2);
    // A lanes tag on a roundabout way counts the lanes in its (one) direction
    const tagged = applyNetworkCorrections([osmRoad(5, [[0, 0], [10, 10]], { junction: 'roundabout', lanes: '3' }, false, 4)], null).roads[0] as RoadObject;
    expect(tagged.laneCount).toBe(3);
    // set_oneway on an untagged two-way piece of a ring (infosys-ring-1) keeps its carriageway too
    const piece = osmRoad(6, [[0, 0], [10, 10]], { junction: 'roundabout', oneway: 'no' }, false);
    const fixed = applyNetworkCorrections([piece], layerOf([{ osm_way_id: 6, action: 'set_oneway', params: { reverse: true } }])).roads[0] as RoadObject;
    expect(fixed.isOneWay).toBe(true);
    expect(fixed.laneCount).toBe(2);
  });

  it('ships a valid, evidenced layer', () => {
    const layer = validateCorrectionLayer(JSON.parse(fs.readFileSync(LAYER_FILE, 'utf8')));
    expect(layer.corrections.length).toBeGreaterThan(0);
    for (const c of layer.corrections) expect(c.evidence.length).toBeGreaterThan(0);
    expect(() => validateCorrectionLayer({ ...layer, corrections: [{ ...layer.corrections[0], evidence: [] }] })).toThrow(/evidence/);
  });

  it('opens a way out of an arm whose carriageways OSM points the same way (Kasturi Chowk north-east arm, in miniature)', () => {
    // A dual-carriageway arm from the east: both carriageways drawn towards the junction (x = 0),
    // plus a two-way road on to the west. Without the correction nothing can leave eastwards.
    const north = osmRoad(10, [[600, 8], [0, 8]], { oneway: 'yes' }, true);
    const south = osmRoad(11, [[600, -8], [0, -8]], { oneway: 'yes' }, true);
    const west = osmRoad(12, [[0, 8], [-600, 0]], {}, false);
    const link = osmRoad(13, [[0, -8], [0, 8]], {}, false);
    const end = osmRoad(14, [[600, -8], [600, 8]], {}, false);
    // Can a vehicle get from the west end to the east end?
    const reachesEast = (roads: RoadObject[]) => {
      const area = new StudyAreaExplorer().explore(roads, 1, { seedRoadIds: ['osm_12'], rangeMeters: 2000, direction: 'both' });
      const sim = new TrafficMicroSim(area, new Map(roads.map(r => [r.id, r])), { demandLevel: 0, seed: 1 });
      const near = (x: number, y: number) => {
        const [lng, lat] = pt(x, y);
        let best = '', d = Infinity;
        area.network.nodes.forEach(n => { const e = Math.hypot(n.coordinates[0] - lng, n.coordinates[1] - lat); if (e < d) { d = e; best = n.id; } });
        return best;
      };
      return sim.spawnVehicle(near(-600, 0), near(600, 8), 'car');
    };
    const roads = [north, south, west, link, end];
    // Keep-left: the eastbound carriageway is the northern one, so way 10 is the one drawn backwards
    const fixed = applyNetworkCorrections(roads, layerOf([{ osm_way_id: 10, action: 'reverse' }])).roads as RoadObject[];
    const headingOf = (r: RoadObject) => Math.sign(r.coordinates[r.coordinates.length - 1][0] - r.coordinates[0][0]);
    expect(fixed.filter(r => r.id === 'osm_10' || r.id === 'osm_11').map(headingOf)).toEqual([1, -1]);
    expect(reachesEast(roads)).toBe(false);
    expect(reachesEast(fixed)).toBe(true);
  });
});

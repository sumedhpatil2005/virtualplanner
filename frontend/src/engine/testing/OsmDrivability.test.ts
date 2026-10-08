import { describe, it, expect, vi, afterEach } from 'vitest';
import type { RoadObject, FlyoverObject, CityObject } from '../objects/types';
import { ObjectManager } from '../objects/ObjectManager';
import { HistoryManager } from '../history/HistoryManager';
import { EditingEngine } from '../editing/EditingEngine';
import { classifyOsmWay, motorVehicleAccess, findNonDrivableOsmRoads } from '../editing/osmDrivability';

const included = (tags: Record<string, string>) => classifyOsmWay(tags).include;

describe('classifyOsmWay', () => {
  it('keeps roads for general motor traffic', () => {
    for (const highway of ['motorway', 'trunk_link', 'primary', 'primary_link', 'secondary', 'tertiary', 'unclassified', 'residential', 'living_street', 'service', 'road']) {
      expect(included({ highway }), highway).toBe(true);
    }
  });

  it('leaves out footways, paths and other ways vehicles cannot use', () => {
    for (const highway of ['footway', 'pedestrian', 'path', 'cycleway', 'bridleway', 'steps', 'corridor', 'platform', 'busway', 'bus_guideway', 'construction', 'proposed', 'raceway']) {
      const decision = classifyOsmWay({ highway });
      expect(decision.include, highway).toBe(false);
      if (!decision.include) expect(decision.reason).toBe(`highway=${highway} is not a vehicle road`);
    }
  });

  it('leaves out highway values it does not recognise', () => {
    expect(included({ highway: 'some_new_value' })).toBe(false);
    expect(included({ name: 'No highway tag' })).toBe(false);
  });

  it('keeps a track only when tagged open to motor vehicles', () => {
    expect(included({ highway: 'track' })).toBe(false);
    expect(included({ highway: 'track', tracktype: 'grade1' })).toBe(false);
    expect(included({ highway: 'track', motor_vehicle: 'yes' })).toBe(true);
    expect(included({ highway: 'track', motor_vehicle: 'designated' })).toBe(true);
    expect(included({ highway: 'track', vehicle: 'permissive' })).toBe(true);
    expect(included({ highway: 'track', access: 'destination' })).toBe(true);
    // Farm, forestry and private tracks are not open to general traffic
    expect(included({ highway: 'track', motor_vehicle: 'agricultural' })).toBe(false);
    expect(included({ highway: 'track', motor_vehicle: 'forestry' })).toBe(false);
    expect(included({ highway: 'track', access: 'private' })).toBe(false);
    expect(included({ highway: 'track', motor_vehicle: 'no' })).toBe(false);
  });

  it('uses the most specific access tag', () => {
    expect(included({ highway: 'track', access: 'no', motor_vehicle: 'yes' })).toBe(true);
    expect(included({ highway: 'track', access: 'yes', motor_vehicle: 'no' })).toBe(false);
    expect(included({ highway: 'residential', access: 'yes', vehicle: 'no' })).toBe(false);
    expect(motorVehicleAccess({ access: 'no', vehicle: 'destination' })).toBe('destination');
  });

  it('leaves out roads closed to motor vehicles but keeps private ones', () => {
    expect(included({ highway: 'residential', motor_vehicle: 'no' })).toBe(false);
    expect(included({ highway: 'service', access: 'no' })).toBe(false);
    expect(included({ highway: 'service', access: 'private' })).toBe(true); // gated compounds still carry traffic
    expect(included({ highway: 'residential', access: 'no', motor_vehicle: 'destination' })).toBe(true);
  });

  it('leaves out highways mapped as areas', () => {
    expect(included({ highway: 'service', area: 'yes' })).toBe(false);
  });

  it('tolerates case and multiple values', () => {
    expect(included({ highway: 'Residential' })).toBe(true);
    expect(included({ highway: 'track', motor_vehicle: 'Yes;agricultural' })).toBe(true);
    expect(included({ highway: 'track', motor_vehicle: 'agricultural;forestry' })).toBe(false);
  });
});

describe('OSM road import', () => {
  afterEach(() => vi.restoreAllMocks());
  const saveLocally = (om: ObjectManager) => vi.spyOn(om, 'addMultipleAndSave').mockImplementation(async objects => { om.addMultiple(objects, true); });
  const way = (id: number, tags: Record<string, string>) => ({
    type: 'way',
    id,
    tags,
    geometry: [{ lon: 73.8567, lat: 18.5204 }, { lon: 73.8577, lat: 18.5204 + id * 1e-5 }],
  });
  const area = {
    id: 'area1',
    name: 'Test Area',
    polygonCoordinates: [[73.856, 18.520, 0], [73.858, 18.520, 0], [73.858, 18.521, 0], [73.856, 18.521, 0]] as [number, number, number][],
    minLat: 18.520, maxLat: 18.521, minLon: 73.856, maxLon: 73.858,
    createdAt: '',
  };

  it('imports only vehicle roads and reports what it skipped', async () => {
    const om = new ObjectManager();
    const editing = new EditingEngine(om, {} as any);
    saveLocally(om);
    (editing as any).fetchAreaElements = async () => [
        way(1, { highway: 'residential' }),
        way(2, { highway: 'footway' }),
        way(3, { highway: 'footway' }),
        way(4, { highway: 'path' }),
        way(5, { highway: 'track' }),
        way(6, { highway: 'track', motor_vehicle: 'yes' }),
        way(7, { highway: 'service', access: 'private' }),
        way(8, { highway: 'pedestrian' }),
        way(9, { highway: 'primary', motor_vehicle: 'no' }),
      ];

    const count = await editing.importOSMRoadsInsideArea(area, 'base');

    expect(count).toBe(3);
    expect(om.getAll().map(o => o.id).sort()).toEqual(['osm_1', 'osm_6', 'osm_7']);
    expect((om.getById('osm_6') as RoadObject).osmProvenance?.originalTags.highway).toBe('track');
    expect(editing.lastRoadImportSkipped).toEqual({
      'highway=footway is not a vehicle road': 2,
      'highway=path is not a vehicle road': 1,
      'highway=pedestrian is not a vehicle road': 1,
      'track not tagged open to motor vehicles': 1,
      'highway=primary closed to motor vehicles': 1,
    });
  });

  it('leaves roads already in the project alone, including ones the filter would now skip', async () => {
    const om = new ObjectManager();
    const editing = new EditingEngine(om, {} as any);
    // A footway imported before this change
    const oldFootway: RoadObject = {
      id: 'osm_99', type: 'road', name: 'Footway Road', layerId: 'roads', scenarioId: 'base',
      coordinates: [[73.857, 18.5205, 0], [73.8575, 18.5206, 0]],
      roadClass: 'local', width: 10, laneCount: 2, laneWidth: 3.5, hasDivider: false, dividerWidth: 0,
      hasFootpath: true, footpathWidth: 1.5, speedLimit: 50, isOneWay: false, trafficCapacity: 2000,
      connectedJunctions: [], createdAt: '', updatedAt: '',
      osmProvenance: { osmId: 99, originalTags: { highway: 'footway' }, layer: 0, bridge: false, tunnel: false, roundabout: false },
    };
    om.add(oldFootway, true);
    const before = JSON.parse(JSON.stringify(om.getById('osm_99')));

    saveLocally(om);
    (editing as any).fetchAreaElements = async () => [way(11, { highway: 'residential' }), way(12, { highway: 'footway' })];
    await editing.importOSMRoadsInsideArea(area, 'base');

    expect(om.getAll().map(o => o.id).sort()).toEqual(['osm_11', 'osm_99']);
    expect(om.getById('osm_99')).toEqual(before);
  });
});

describe('removing existing non-drivable OSM roads', () => {
  afterEach(() => vi.unstubAllGlobals());

  let n = 0;
  const osmRoad = (tags: Record<string, string> | undefined, extra: Partial<RoadObject> = {}): RoadObject => {
    n++;
    return {
      id: `osm_${n}`, type: 'road', name: `Road ${n}`, layerId: 'roads', scenarioId: 'base',
      coordinates: [[73.8 + n * 1e-4, 18.5, 0], [73.8 + n * 1e-4, 18.501, 0]],
      roadClass: 'local', width: 10, laneCount: 2, laneWidth: 3.5, hasDivider: false, dividerWidth: 0,
      hasFootpath: true, footpathWidth: 1.5, speedLimit: 50, isOneWay: false, trafficCapacity: 2000,
      connectedJunctions: [], createdAt: '', updatedAt: '',
      ...(tags ? { osmProvenance: { osmId: n, originalTags: tags, layer: 0, bridge: false, tunnel: false, roundabout: false } } : {}),
      ...extra,
    };
  };

  const fixture = () => {
    const remove = [
      osmRoad({ highway: 'footway' }),
      osmRoad({ highway: 'path' }),
      osmRoad({ highway: 'steps' }),
      osmRoad({ highway: 'busway', bus: 'designated' }),
      osmRoad({ highway: 'residential', motor_vehicle: 'no' }),
      osmRoad({ highway: 'track' }),
      osmRoad({ highway: 'construction', construction: 'primary' }),
    ];
    const keep: CityObject[] = [
      osmRoad({ highway: 'residential' }),
      osmRoad({ highway: 'service', access: 'private' }), // private roads stay
      osmRoad({ highway: 'track', access: 'permissive' }), // open track stays
      osmRoad(undefined, { id: 'manual_path', name: 'Footway sketch' }), // hand-drawn: never judged
      osmRoad({} as Record<string, string>), // no recorded highway tag: never judged
      { ...osmRoad({ highway: 'footway' }), type: 'flyover', elevation: 7, pierSpacing: 30 } as unknown as FlyoverObject,
    ];
    return { remove, keep };
  };

  it('selects only OSM roads that fail the importer rules', () => {
    const { remove, keep } = fixture();
    const found = findNonDrivableOsmRoads([...keep, ...remove]);
    expect(found.map(f => f.road.id).sort()).toEqual(remove.map(r => r.id).sort());
    expect(found.find(f => f.road.id === remove[5].id)!.reason).toBe('track not tagged open to motor vehicles');
  });

  it('removes them as one undo step, leaving every other road exactly as it was', async () => {
    const fetchMock = vi.fn().mockImplementation(() => Promise.resolve(new Response('{}', { status: 200 })));
    vi.stubGlobal('fetch', fetchMock);
    const { remove, keep } = fixture();
    const om = new ObjectManager();
    const history = new HistoryManager(om);
    const editing = new EditingEngine(om, history);
    om.addMultiple([...keep, ...remove], true);
    const snapshot = (ids: string[]) => JSON.parse(JSON.stringify(ids.map(id => om.getById(id))));
    const keptBefore = snapshot(keep.map(k => k.id));
    const removedBefore = snapshot(remove.map(r => r.id));
    fetchMock.mockClear();

    const removed = editing.removeNonDrivableOsmRoads();

    expect(removed).toHaveLength(remove.length);
    expect(om.getAll().map(o => o.id).sort()).toEqual(keep.map(k => k.id).sort());
    expect(snapshot(keep.map(k => k.id))).toEqual(keptBefore);
    // One batch delete, to the backend's batch-delete route, with exactly these ids
    expect(fetchMock).toHaveBeenCalledTimes(1);
    const [url, init] = fetchMock.mock.calls[0];
    expect(String(url)).toMatch(/\/api\/objects\/batch\/delete$/);
    expect(JSON.parse((init as RequestInit).body as string).ids.sort()).toEqual(remove.map(r => r.id).sort());

    history.undo();
    // Re-adding refreshes updatedAt; everything else, geometry included, comes back as it was
    const withoutUpdatedAt = (list: any[]) => list.map(({ updatedAt: _u, ...rest }) => rest);
    expect(withoutUpdatedAt(snapshot(remove.map(r => r.id)))).toEqual(withoutUpdatedAt(removedBefore));
    expect(snapshot(keep.map(k => k.id))).toEqual(keptBefore);
    expect(history.canUndo()).toBe(false);
  });

  it('refuses while the network is locked for Simulation mode', () => {
    const { remove } = fixture();
    const om = new ObjectManager();
    const editing = new EditingEngine(om, new HistoryManager(om));
    om.addMultiple(remove, true);
    editing.setLocked(true);
    expect(() => editing.removeNonDrivableOsmRoads()).toThrow(/read-only/);
    expect(om.getAll()).toHaveLength(remove.length);
  });
});

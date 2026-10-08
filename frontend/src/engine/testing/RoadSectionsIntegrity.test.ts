import { describe, expect, it, vi } from 'vitest';
import { ObjectManager } from '../objects/ObjectManager';
import { bridgeGeometry, liftOsmBridges } from '../objects/bridgeElevation';
import { hasCompleteSectionCoverage, normalizeRoadSections, remapRoadSections, repairRoadSections } from '../objects/roadSections';
import type { RoadObject, RoadSectionProfile } from '../objects/types';

const point = (metres: number): [number, number, number] => [73.8 + metres / 111320, 0, 0];
const road = (coordinates = [point(0), point(120), point(360)]): RoadObject => ({
  id: 'road', type: 'road', name: 'Road', layerId: 'roads', scenarioId: 'base', createdAt: '', updatedAt: '', coordinates,
  roadClass: 'local', width: 7, laneCount: 2, laneWidth: 3.5, hasDivider: false, dividerWidth: 0,
  hasFootpath: false, footpathWidth: 0, speedLimit: 40, isOneWay: false, trafficCapacity: 2000, connectedJunctions: [],
});
const profiles = (r: RoadObject): RoadSectionProfile[] => {
  const defaultProfile = new ObjectManager().synthesizeDefaultSections(r)[0];
  return [
    { ...defaultProfile, startNodeIndex: 0, endNodeIndex: 1 },
    { ...defaultProfile, startNodeIndex: 1, endNodeIndex: r.coordinates.length - 1, totalRowWidth: 19,
      carriagewayA: { ...defaultProfile.carriagewayA, lanes: 3, laneWidth: 4 },
      reservedSpaces: [{ type: 'utility_corridor', width: 2, side: 'right', status: 'existing' }] },
  ];
};
const ranges = (sections: RoadSectionProfile[]) => sections.map(section => [section.startNodeIndex, section.endNodeIndex]);
const bridge = () => {
  const r = road();
  r.sections = profiles(r);
  r.osmProvenance = { osmId: 1, originalTags: { bridge: 'yes' }, layer: 1, bridge: true, tunnel: false, roundabout: false };
  return r;
};

describe('bridge geometry keeps road profile boundaries', () => {
  it('maps each profile to its original segment, covers every deck segment, and preserves the source', () => {
    const input = bridge();
    const before = structuredClone(input);
    const manager = new ObjectManager();
    manager.addMultiple([input], true);
    const result = manager.getById(input.id) as RoadObject;
    const boundary = result.coordinates.findIndex(p => p[0] === before.coordinates[1][0]);
    expect(result.coordinates.length).toBeGreaterThan(input.coordinates.length);
    expect(ranges(result.sections!)).toEqual([[0, boundary], [boundary, result.coordinates.length - 1]]);
    expect(hasCompleteSectionCoverage(result.sections!, result.coordinates.length)).toBe(true);
    expect(result.sections![1].carriagewayA).toEqual(before.sections![1].carriagewayA);
    expect(result.sections![1].reservedSpaces).toEqual(before.sections![1].reservedSpaces);
    expect(result.sections!.map(s => s.provenance)).toEqual(before.sections!.map(s => s.provenance));
    expect(result.sourceCoordinates).toEqual(before.coordinates);
    expect(input.coordinates).toEqual(before.coordinates);
    expect(input.sections).toEqual(before.sections);
    manager.liftBridges();
    expect(manager.getById(input.id)).toBe(result);
  });

  it('saves the densified geometry and matching profiles together', async () => {
    const manager = new ObjectManager();
    const save = vi.spyOn(manager, 'syncPostMultiple').mockResolvedValue(undefined);
    await manager.addMultipleAndSave([bridge()]);
    const saved = save.mock.calls[0][0][0] as RoadObject;
    expect(saved.coordinates.length).toBeGreaterThan(3);
    expect(hasCompleteSectionCoverage(saved.sections!, saved.coordinates.length)).toBe(true);
    save.mockRestore();
  });

  it('uses the current geometry in the regular batch save path too', () => {
    const manager = new ObjectManager();
    const save = vi.spyOn(manager, 'syncPostMultiple').mockResolvedValue(undefined);
    manager.addMultiple([bridge()]);
    const saved = save.mock.calls[0][0][0] as RoadObject;
    expect(saved).toBe(manager.getById(saved.id));
    expect(saved.coordinates.length).toBeGreaterThan(3);
    expect(hasCompleteSectionCoverage(saved.sections!, saved.coordinates.length)).toBe(true);
    save.mockRestore();
  });

  it('also keeps profiles whole when applying elevations outside ObjectManager', () => {
    const input = bridge();
    const original = structuredClone(input.coordinates);
    liftOsmBridges([input]);
    expect(hasCompleteSectionCoverage(input.sections!, input.coordinates.length)).toBe(true);
    expect(input.sourceCoordinates).toEqual(original);
    expect(liftOsmBridges([input])).toEqual([]);
    expect(bridgeGeometry([{ ...road(), coordinates: [] }])).toEqual(new Map());
  });
});

describe('legacy section coverage repair', () => {
  it('recovers different original profiles at proven densified source vertices on load', () => {
    const input = bridge();
    input.sourceCoordinates = structuredClone(input.coordinates);
    input.coordinates = bridgeGeometry([input]).get(input)!.coordinates;
    const manager = new ObjectManager();
    manager.addMultiple([input], true);
    const result = manager.getById(input.id) as RoadObject;
    const boundary = result.coordinates.findIndex(p => p[0] === input.sourceCoordinates![1][0]);
    expect(ranges(result.sections!)).toEqual([[0, boundary], [boundary, result.coordinates.length - 1]]);
    expect(result.coordinates).toEqual(input.coordinates);
    expect(result.sourceCoordinates).toEqual(input.sourceCoordinates);
    expect(repairRoadSections(result)).toBe(result.sections);
  });

  it('fills leading, middle and trailing gaps without losing distinct profiles or mutating input', () => {
    const input = road(Array.from({ length: 11 }, (_, index) => point(index * 10)));
    const sections = profiles(input);
    sections[0] = { ...sections[0], startNodeIndex: 2, endNodeIndex: 3 };
    sections[1] = { ...sections[1], startNodeIndex: 6, endNodeIndex: 8 };
    const original = structuredClone(sections);
    const fixed = normalizeRoadSections(sections, 11);
    expect(ranges(fixed)).toEqual([[0, 6], [6, 10]]);
    expect(fixed[1].carriagewayA).toBe(sections[1].carriagewayA);
    expect(sections).toEqual(original);
    expect(normalizeRoadSections(fixed, 11)).toBe(fixed);
  });

  it('clips overlaps and rejects non-finite ranges safely', () => {
    const input = road(Array.from({ length: 6 }, (_, index) => point(index)));
    const sections = profiles(input);
    sections[0].endNodeIndex = 4;
    sections[1].startNodeIndex = 2;
    expect(ranges(normalizeRoadSections(sections, 6))).toEqual([[0, 2], [2, 5]]);
    expect(normalizeRoadSections([{ ...sections[0], startNodeIndex: NaN }], 6)).toEqual([]);
  });

  it('keeps edited boundaries when original source indices no longer establish their meaning', () => {
    const input = bridge();
    input.sourceCoordinates = structuredClone(input.coordinates);
    input.coordinates = bridgeGeometry([input]).get(input)!.coordinates;
    input.sections = input.sections!.map(section => ({ ...section,
      provenance: { ...section.provenance, geometryModified: true } }));
    expect(ranges(repairRoadSections(input))).toEqual([[0, 1], [1, input.coordinates.length - 1]]);
  });
});

describe('coordinate edits preserve section profiles', () => {
  it('carries boundaries through inserted/deleted vertices and keeps the original geometry intact', () => {
    const input = road([point(0), point(10), point(20), point(30), point(40)]);
    input.sections = profiles(input).map((s, index) => ({ ...s, startNodeIndex: index === 0 ? 0 : 2, endNodeIndex: index === 0 ? 2 : 4 }));
    const manager = new ObjectManager();
    manager.add(input, true);
    manager.update(input.id, { coordinates: [point(0), point(5), ...input.coordinates.slice(1)] }, true);
    let result = manager.getById(input.id) as RoadObject;
    expect(ranges(result.sections!)).toEqual([[0, 3], [3, 5]]);
    expect(result.sections![1].carriagewayA.lanes).toBe(3);
    manager.update(input.id, { coordinates: input.coordinates }, true);
    result = manager.getById(input.id) as RoadObject;
    expect(ranges(result.sections!)).toEqual([[0, 2], [2, 4]]);
    expect(result.sourceCoordinates).toEqual(input.coordinates);
    expect(result.sourceCoordinates![0]).not.toBe(input.coordinates[0]);
  });

  it('keeps moved vertex indices and honours explicitly supplied sections for undo or profile edits', () => {
    const input = road();
    input.sections = profiles(input);
    const manager = new ObjectManager();
    manager.add(input, true);
    manager.update(input.id, { coordinates: [point(0), point(150), point(360)] }, true);
    expect(ranges((manager.getById(input.id) as RoadObject).sections!)).toEqual([[0, 1], [1, 2]]);
    const explicit = [{ ...input.sections[0], endNodeIndex: 3 }];
    manager.update(input.id, { coordinates: [point(0), point(60), point(120), point(360)], sections: explicit }, true);
    expect((manager.getById(input.id) as RoadObject).sections).toBe(explicit);
  });

  it('maps a deleted profile boundary to the remaining shared vertex without leaving gaps', () => {
    const coordinates = [point(0), point(10), point(20), point(30), point(40)];
    const sections = profiles(road(coordinates)).map((s, index) => ({ ...s, startNodeIndex: index === 0 ? 0 : 2, endNodeIndex: index === 0 ? 2 : 4 }));
    const fixed = remapRoadSections(sections, coordinates, [point(0), point(10), point(30), point(40)]);
    expect(ranges(fixed)).toEqual([[0, 2], [2, 3]]);
    expect(hasCompleteSectionCoverage(fixed, 4)).toBe(true);
    expect(fixed[1].carriagewayA.lanes).toBe(3);
  });
});

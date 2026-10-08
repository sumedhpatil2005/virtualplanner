import { describe, it, expect, vi, afterEach } from 'vitest';
import {
  rebalanceSplit,
  profileModeSplitToFractions,
  timeToPeriod,
  resolveBuildingTripEvents,
  MODE_SPLIT_KEYS,
} from '../simulation/modeSplit';
import { findNearestTrack, resolveStationHeading, bearingDegrees } from '../objects/stationAlignment';
import { resolveLayerId, utilityLayerId, LayerManager } from '../layers/LayerManager';
import { levelOfServiceForRatio } from '../simulation/SimulationManager';
import { compareScenario } from '../scenarios/scenarioComparison';
import { ScenarioManager } from '../scenarios/ScenarioManager';
import type { BuildingObject, MetroLineObject, MetroStationObject, CityObject } from '../objects/types';
import type { ModeSplit } from '../objects/demandTypes';

const DEFAULT_SPLIT: ModeSplit = { car: 0.25, twoWheeler: 0.35, bus: 0.2, metro: 0.1, walking: 0.08, other: 0.02 };

const building = (over: Partial<BuildingObject> = {}): BuildingObject => ({
  id: 'b', type: 'building', name: 'B', layerId: 'buildings', scenarioId: 'base',
  coordinates: [[73.7, 18.5, 0], [73.701, 18.5, 0], [73.701, 18.501, 0], [73.7, 18.5, 0]],
  usageType: 'residential', height: 30, floors: 10, population: 100, parkingSpaces: 10,
  waterDemand: 15000, electricityDemand: 600, constructionYear: 2020,
  createdAt: '', updatedAt: '', ...over,
} as BuildingObject);

describe('Mode split normalisation (item 23)', () => {
  it('keeps percentages summing to exactly 100 when one share changes', () => {
    const start = { car: 25, twoWheeler: 35, bus: 20, metro: 10, walking: 8, other: 2 };
    const next = rebalanceSplit(start, MODE_SPLIT_KEYS, 'car', 100);
    expect(Object.values(next).reduce((a, b) => a + b, 0)).toBe(100);
    expect(next.car).toBe(100);

    const mid = rebalanceSplit(start, MODE_SPLIT_KEYS, 'bus', 50);
    expect(Object.values(mid).reduce((a, b) => a + b, 0)).toBe(100);
    expect(mid.bus).toBe(50);
    // Others keep their relative order
    expect(mid.twoWheeler).toBeGreaterThan(mid.car);
  });

  it('works on fractions (gateway splits sum to 1)', () => {
    const next = rebalanceSplit(DEFAULT_SPLIT, MODE_SPLIT_KEYS, 'metro', 0.4, 1);
    expect(Object.values(next).reduce((a, b) => a + b, 0)).toBeCloseTo(1, 10);
    expect(next.metro).toBeCloseTo(0.4, 10);
  });

  it('can no longer produce 600% of trips', () => {
    let split: Record<string, number> = {};
    for (const k of MODE_SPLIT_KEYS) split = rebalanceSplit(split, MODE_SPLIT_KEYS, k, 100);
    expect(Object.values(split).reduce((a, b) => a + b, 0)).toBe(100);
  });
});

describe('Activity Profile feeds demand (item 22)', () => {
  it("maps the panel's 'walk' to the model's 'walking' instead of dropping it", () => {
    const f = profileModeSplitToFractions({ car: 50, walk: 50 })!;
    expect(f.walking).toBeCloseTo(0.5);
    expect(f.car).toBeCloseTo(0.5);
  });

  it('maps clock times to model periods', () => {
    expect(timeToPeriod('08:30')).toBe('AM_Peak');
    expect(timeToPeriod('13:00')).toBe('Midday');
    expect(timeToPeriod('18:15')).toBe('PM_Peak');
    expect(timeToPeriod('23:00')).toBe('Night');
    expect(timeToPeriod('')).toBeNull();
  });

  it('keeps the original behaviour when there is no profile', () => {
    const ev = resolveBuildingTripEvents(building({ residents: 100, employees: 0 }), DEFAULT_SPLIT);
    expect(ev).toEqual([
      { role: 'origin', period: 'AM_Peak', trips: 200 * 0.35, modeSplit: DEFAULT_SPLIT },
      { role: 'destination', period: 'PM_Peak', trips: 200 * 0.4, modeSplit: DEFAULT_SPLIT },
    ]);
  });

  it('uses peak windows, trip counts and mode split from the profile', () => {
    const b = building({
      residents: 0,
      employees: 500,
      activityProfile: {
        peakArrivalStart: '17:00', // an evening venue: people arrive in the PM peak
        peakDepartureStart: '22:00',
        tripGeneration: { pmPeakTrips: 1200, dailyTrips: 3000 },
        modeSplit: { metro: 100 },
      },
    });
    const ev = resolveBuildingTripEvents(b, DEFAULT_SPLIT);
    const arrivals = ev.find(e => e.role === 'destination')!;
    const departures = ev.find(e => e.role === 'origin')!;
    expect(arrivals.period).toBe('PM_Peak');
    expect(arrivals.trips).toBe(1200);
    expect(departures.period).toBe('Night');
    expect(departures.trips).toBeCloseTo(3000 * 0.1);
    expect(arrivals.modeSplit.metro).toBe(1);
  });
});

describe('Metro station orientation', () => {
  const track: MetroLineObject = {
    id: 'm1', type: 'metro_line', name: 'East-West Line', layerId: 'metro', scenarioId: 'base',
    coordinates: [[73.70, 18.5, 12], [73.72, 18.5, 12]],
    trackCount: 2, trackGauge: 1.435, deckWidth: 8, elevation: 12, pierSpacing: 30,
    createdAt: '', updatedAt: '',
  };
  const station = (over: Partial<MetroStationObject> = {}): MetroStationObject => ({
    id: 's1', type: 'metro_station', name: 'S', layerId: 'metro', scenarioId: 'base',
    coordinates: [73.71, 18.5003, 0], stationName: 'S', length: 140, width: 20, height: 8,
    elevation: 12, capacity: 5000, createdAt: '', updatedAt: '', ...over,
  });

  it('computes compass bearings', () => {
    expect(bearingDegrees([73.7, 18.5], [73.7, 18.6])).toBeCloseTo(0, 5);
    expect(bearingDegrees([73.7, 18.5], [73.8, 18.5])).toBeCloseTo(90, 5);
  });

  it('aligns to a nearby track by default', () => {
    const near = findNearestTrack([73.71, 18.5003], [track]);
    expect(near?.trackId).toBe('m1');
    const h = resolveStationHeading(station(), [track]);
    expect(h.source).toBe('track');
    expect(h.heading).toBeCloseTo(90, 3);
  });

  it('uses the manual heading when alignment is off or no track is near', () => {
    expect(resolveStationHeading(station({ alignToTrack: false, heading: 45 }), [track]).heading).toBe(45);
    const far = station({ coordinates: [73.9, 18.9, 0], heading: 400 });
    expect(resolveStationHeading(far, [track])).toEqual({ heading: 40, source: 'manual' });
  });
});

describe('Layer registry (items 19-20)', () => {
  it('maps utility layers to their own toggles', () => {
    expect(utilityLayerId('electricity')).toBe('electric_util');
    expect(resolveLayerId('electricity_util')).toBe('electric_util');
    // Fiber no longer hides behind "Electric Grid"
    expect(resolveLayerId('fiber_util')).toBe('fiber_util');
    const layers = new LayerManager();
    expect(layers.get('fiber_util')?.name).toBe('Fiber Network');
    expect(layers.get('electricity_util')?.id).toBe('electric_util');
  });

  it('ignores opacity changes on layers that cannot render transparency', () => {
    const layers = new LayerManager();
    layers.setOpacity('terrain', 0.2);
    expect(layers.getOpacity('terrain')).toBe(1);
    layers.setOpacity('roads', 0.3);
    expect(layers.getOpacity('roads')).toBe(0.3);
  });
});

describe('Honest metrics (items 21, cross-cutting)', () => {
  it('classifies level of service by HCM v/c thresholds', () => {
    expect(levelOfServiceForRatio(0.5)).toBe('A');
    expect(levelOfServiceForRatio(0.65)).toBe('B');
    expect(levelOfServiceForRatio(0.95)).toBe('E');
    expect(levelOfServiceForRatio(1.4)).toBe('F');
  });

  it('computes proposal figures from geometry, with no travel-time guess', () => {
    const road = {
      id: 'r', type: 'road', name: 'r', layerId: 'roads', scenarioId: 'p1', laneCount: 4,
      coordinates: [[73.70, 18.5, 0], [73.71, 18.5, 0]],
    } as unknown as CityObject;
    const c = compareScenario([road, building({ scenarioId: 'p1', population: 300 })], 'p1');
    // ~1.055 km × 4 lanes
    expect(c.newRoadLaneKm).toBeGreaterThan(4.1);
    expect(c.newRoadLaneKm).toBeLessThan(4.3);
    expect(c.popDelta).toBe(300);
    expect(c).not.toHaveProperty('travelTimeSaving');
  });
});

describe('User-managed scenarios (item 24)', () => {
  afterEach(() => vi.unstubAllGlobals());

  it('starts with only the base city — no invented proposals', () => {
    const sm = new ScenarioManager();
    expect(sm.getAll().map(s => s.id)).toEqual(['base']);
  });

  it('creates, renames and deletes a proposal through the API', async () => {
    const fetchMock = vi.fn().mockImplementation(() => Promise.resolve(new Response('{}', { status: 200 })));
    vi.stubGlobal('fetch', fetchMock);
    const sm = new ScenarioManager();

    const s = await sm.createScenario({ name: '  Flyover  ', year: 2030 });
    expect(s.name).toBe('Flyover');
    expect(sm.getAll()).toHaveLength(2);

    await sm.updateScenario(s.id, { name: 'Flyover v2' });
    expect(sm.get(s.id)?.name).toBe('Flyover v2');

    sm.setActiveScenario(s.id);
    await sm.deleteScenario(s.id);
    expect(sm.getActiveScenarioId()).toBe('base');
    expect(fetchMock.mock.calls.map(c => (c[1] as RequestInit).method)).toEqual(['POST', 'POST', 'DELETE']);
  });

  it('refuses to delete base or save an empty name', async () => {
    const sm = new ScenarioManager();
    await expect(sm.deleteScenario('base')).rejects.toThrow();
    await expect(sm.createScenario({ name: '   ', year: 2030 })).rejects.toThrow(/empty/);
  });
});

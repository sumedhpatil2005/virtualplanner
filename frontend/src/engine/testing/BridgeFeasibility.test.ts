import { describe, it, expect } from 'vitest';
import { BridgeFeasibilityEngine, bfe_pathLengthMeters } from '../simulation/BridgeFeasibilityEngine';
import type { RoadObject } from '../objects/types';

// ── Helpers ──────────────────────────────────────────────────────────────────

function makeRoad(
  id: string,
  name: string,
  coords: [number, number, number][],
  opts: Partial<RoadObject> = {}
): RoadObject {
  return {
    id, type: 'road', name,
    layerId: 'roads', scenarioId: 'base',
    coordinates: coords,
    roadClass: 'arterial', width: 19,
    laneCount: 4, laneWidth: 3.5,
    hasDivider: true, dividerWidth: 3.5,
    hasFootpath: true, footpathWidth: 1.5,
    speedLimit: 60, isOneWay: false,
    trafficCapacity: 2000,
    connectedJunctions: [],
    createdAt: '', updatedAt: '',
    ...opts,
  } as RoadObject;
}

function mToLatDeg(m: number): number { return m / 111000; }
function mToLonDeg(m: number, lat: number): number {
  return m / (111000 * Math.cos((lat * Math.PI) / 180));
}

// Shared coordinate layout:
// Flyover runs NORTH 400m from BASE_ORIGIN.
// Approach roads START at the flyover endpoints (closestDist = 0 < 60m).
// Underpassing road passes within 25m of the flyover mid-section lon.

const BASE_LON = 73.74;
const BASE_LAT = 18.585;
const FLY_START: [number, number, number] = [BASE_LON, BASE_LAT, 0];
const FLY_END: [number, number, number]   = [BASE_LON, BASE_LAT + mToLatDeg(400), 0];
const MID_LAT = BASE_LAT + mToLatDeg(200); // mid-section

// ── Tests ─────────────────────────────────────────────────────────────────────

describe('BridgeFeasibilityEngine', () => {
  const engine = new BridgeFeasibilityEngine();

  it('Test 1: PASS - flyover 400m with 500m approach roads (6m elevation)', () => {
    const roadAtStart = makeRoad('r1', 'Start Road', [
      FLY_START,
      [BASE_LON + mToLonDeg(500, BASE_LAT), BASE_LAT, 0],
    ]);
    const roadAtEnd = makeRoad('r2', 'End Road', [
      FLY_END,
      [BASE_LON + mToLonDeg(500, FLY_END[1]), FLY_END[1], 0],
    ]);

    const result = engine.run([FLY_START, FLY_END], 6.0, 4, [roadAtStart, roadAtEnd]);

    expect(result.rampLengthRequired).toBe(120);
    expect(result.totalFlyoverLength).toBeGreaterThanOrEqual(350);

    const deckCheck = result.checks.find(c => c.id === 'deck_length')!;
    expect(deckCheck.status).toBe('pass');

    const rampCheck = result.checks.find(c => c.id === 'ramp_grade')!;
    expect(rampCheck.status).toBe('pass');

    expect(result.feasible).toBe(true);
  });

  it('Test 2: FAIL - flyover only 80m, too short for 120m+120m+50m requirement', () => {
    const shortEnd: [number, number, number] = [BASE_LON, BASE_LAT + mToLatDeg(80), 0];
    const roadAtStart = makeRoad('r3', 'Short Start Road', [
      FLY_START,
      [BASE_LON + mToLonDeg(500, BASE_LAT), BASE_LAT, 0],
    ]);

    const result = engine.run([FLY_START, shortEnd], 6.0, 4, [roadAtStart]);

    const deckCheck = result.checks.find(c => c.id === 'deck_length')!;
    expect(deckCheck.status).toBe('fail');
    expect(result.feasible).toBe(false);
  });

  it('Test 3: WARN - underpassing road has 2.5m median (below 3.0m pier fit threshold)', () => {
    // Road runs E-W through flyover mid-section, coords within 25m of flyover path
    const underpassRoad = makeRoad('r4', 'Narrow Median Road', [
      [BASE_LON - mToLonDeg(25, MID_LAT), MID_LAT, 0],
      [BASE_LON + mToLonDeg(25, MID_LAT), MID_LAT, 0],
    ], { hasDivider: true, dividerWidth: 2.5 });

    const roadAtStart = makeRoad('r5', 'Start Road', [
      FLY_START,
      [BASE_LON + mToLonDeg(500, BASE_LAT), BASE_LAT, 0],
    ]);
    const roadAtEnd = makeRoad('r6', 'End Road', [
      FLY_END,
      [BASE_LON + mToLonDeg(500, FLY_END[1]), FLY_END[1], 0],
    ]);

    const result = engine.run([FLY_START, FLY_END], 6.0, 4, [underpassRoad, roadAtStart, roadAtEnd]);

    const pierCheck = result.checks.find(c => c.id === 'pier_fit')!;
    expect(pierCheck.status).toBe('warn');
    expect(pierCheck.message).toContain('Narrow Median Road');
    expect(result.feasible).toBe(true);
  });

  it('Test 4: WARN - 4-lane flyover connects to 2-lane road (lane mismatch)', () => {
    // 2-lane road at flyover START → triggers lane mismatch warn
    const twoLaneRoad = makeRoad('r7', 'Local Street', [
      FLY_START,
      [BASE_LON + mToLonDeg(300, BASE_LAT), BASE_LAT, 0],
    ], { laneCount: 2, trafficCapacity: 1000 });

    // 4-lane road at flyover END → satisfies ramp grade check (end approach = 400m > 120m required)
    const endRoad = makeRoad('r7b', 'End Road', [
      FLY_END,
      [BASE_LON + mToLonDeg(400, FLY_END[1]), FLY_END[1], 0],
    ], { laneCount: 4, trafficCapacity: 2000 });

    const result = engine.run([FLY_START, FLY_END], 6.0, 4, [twoLaneRoad, endRoad]);

    const laneCheck = result.checks.find(c => c.id === 'lane_match')!;
    expect(laneCheck.status).toBe('warn');
    expect(laneCheck.message).toContain('Local Street');
    // All ramp grade / deck length checks pass → overall feasible despite lane warn
    expect(result.feasible).toBe(true);
  });

  it('Test 5: PASS+IMPACT - surface road capacity reduced by 25% (MORTH weave zone)', () => {
    const artRoad = makeRoad('r8', 'Main Arterial', [
      FLY_START,
      [BASE_LON + mToLonDeg(500, BASE_LAT), BASE_LAT, 0],
    ], { trafficCapacity: 2000 });

    const result = engine.run([FLY_START, FLY_END], 6.0, 4, [artRoad]);

    expect(result.surfaceRoadImpacts.length).toBeGreaterThan(0);
    const impact = result.surfaceRoadImpacts[0];
    expect(impact.capacityReductionPercent).toBe(25);
    expect(impact.reducedCapacity).toBe(1500);
    expect(impact.originalCapacity).toBe(2000);
  });

  it('Test 6: bfe_pathLengthMeters - 0.009 deg lat should be ~999m', () => {
    const coords: [number, number, number][] = [
      [73.74, 18.590, 0],
      [73.74, 18.599, 0],
    ];
    const len = bfe_pathLengthMeters(coords);
    expect(len).toBeGreaterThan(900);
    expect(len).toBeLessThan(1100);
  });
});

/**
 * "Through the day" rows never stay on show as current for a case they were
 * not computed for (docs/OVERHAUL.md §25): every kind of change (road geometry:
 * lanes, deletion, reconnection; demand settings; junction edits; signal
 * timing) marks them outdated, a change made while the four periods are still
 * running marks the rows that land, and Undo back to a case that was run brings
 * its rows back as current.
 */
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import * as fs from 'fs';
import { resolve } from 'path';
import type { RoadObject } from '../objects/types';
import type { DrivableObject } from '../simulation/StudyAreaExplorer';

const PROFILE = JSON.parse(fs.readFileSync(resolve(__dirname, '../../../../backend/data/diurnal/pune_hourly_profile_v1.json'), 'utf8'));
const fetchProfile = vi.fn();
vi.mock('../simulation/timeOfDay', async orig => ({ ...(await orig<typeof import('../simulation/timeOfDay')>()), fetchDiurnalProfile: () => fetchProfile() }));
const { SimulationMode } = await import('../simulation/SimulationMode');

const LAT0 = 18.5, M_LAT = 1 / 111320, M_LNG = 1 / (111320 * Math.cos((LAT0 * Math.PI) / 180));
const pt = (x: number, y: number): [number, number, number] => [73.8 + x * M_LNG, LAT0 + y * M_LAT, 0];
const road = (id: string, a: [number, number], b: [number, number], lanes = 2): RoadObject => ({ id, type: 'road', name: id, layerId: 'roads', scenarioId: 'base', coordinates: [pt(...a), pt(...b)],
  roadClass: 'arterial', width: 10, laneCount: lanes, laneWidth: 3.5, hasDivider: false, dividerWidth: 0, hasFootpath: false, footpathWidth: 0,
  speedLimit: 50, isOneWay: false, trafficCapacity: 2000, connectedJunctions: [], createdAt: '', updatedAt: '' });
/** An arterial through the studied road 'mid', with a side road joining it at x = 600. */
const network = (): DrivableObject[] => {
  const r: DrivableObject[] = [road('mid', [0, 0], [600, 0])];
  for (let x = 0; x > -1000; x -= 250) r.push(road(`w${-x}`, [x - 250, 0], [x, 0]));
  for (let x = 600; x < 1600; x += 250) r.push(road(`e${x}`, [x, 0], [x + 250, 0]));
  r.push(road('side', [600, 0], [600, 400]));
  return r;
};
const sleep = (ms: number) => new Promise(r => setTimeout(r, ms));

describe('Through the day: no stale rows on show', () => {
  beforeEach(() => {
    vi.stubGlobal('requestAnimationFrame', () => 0);
    vi.stubGlobal('cancelAnimationFrame', () => {});
    fetchProfile.mockReset();
    fetchProfile.mockResolvedValue(PROFILE);
  });
  afterEach(() => vi.unstubAllGlobals());

  const setup = () => {
    let roads = network();
    let junctions: unknown[] = [];
    const mode = new SimulationMode(() => roads, null, null, () => ({ junctions } as never), undefined, null, null);
    mode.analysisSeeds = [42];
    mode.enter();
    mode.setRange(500);
    mode.selectRoad('mid', false);
    // A Build edit: the object list changes and the engine tells Simulate (TwinCityEngine objects.onChange)
    const edit = async (f: (r: DrivableObject[]) => DrivableObject[]) => { roads = f(roads); mode.networkChanged(); await sleep(400); };
    const setJunctions = async (j: unknown[]) => { junctions = j; mode.networkChanged(); await sleep(400); };
    return { mode, edit, setJunctions, get roads() { return roads; } };
  };
  const tl = (mode: InstanceType<typeof SimulationMode>) => mode.getState().timeline;

  it('every kind of change marks the rows outdated, and changing back makes them current again', async () => {
    const { mode, edit, setJunctions } = setup();
    expect(await mode.runTimeline()).toBe(true);
    const rows = tl(mode).rows;
    expect(tl(mode).outdated).toBe(false);
    const original = network();
    const changes: [string, () => Promise<void>, () => Promise<void>][] = [
      ['lane change', () => edit(r => r.map(o => o.id === 'mid' ? { ...o, laneCount: 1 } as DrivableObject : o)), () => edit(() => original)],
      ['deletion', () => edit(r => r.filter(o => o.id !== 'side')), () => edit(() => original)],
      ['reconnection', () => edit(r => [...r, road('link', [-250, 0], [600, 400])]), () => edit(() => original)],
      ['junction edit', () => setJunctions([{ id: 'jx_edit', type: 'junction', coordinates: [pt(600, 0)], importedJunction: true, control: 'signal' }]), () => setJunctions([])],
      ['through traffic off', async () => mode.setDemandSettings({ through: false }), async () => mode.setDemandSettings({ through: true })],
      ['hypothetical multiplier', async () => mode.setDemandSettings({ hypotheticalScale: 3 }), async () => mode.setDemandSettings({ hypotheticalScale: null })],
      ['signal timing', async () => { mode.setSignalTiming('equal'); await sleep(400); }, async () => { mode.setSignalTiming('webster'); await sleep(400); }],
      ['day type', async () => mode.setDayType('weekend'), async () => mode.setDayType('weekday')],
    ];
    for (const [what, change, back] of changes) {
      await change();
      expect(tl(mode).outdated, what).toBe(true);
      await back();
      expect(tl(mode).outdated, `${what} undone`).toBe(false);
      expect(tl(mode).rows, `${what} undone`).toBe(rows);
    }
    mode.exit();
  }, 240000);

  it('a different signal timing is a different analysis: the shown result goes outdated and re-runs', async () => {
    const { mode } = setup();
    await mode.runAnalysis();
    const before = mode.getState().analysis.key;
    mode.setSignalTiming('equal');
    await sleep(400);
    const a = mode.getState().analysis;
    expect(a.key === before && !a.outdated && a.status === 'ready', 'result for Webster timing still shown as current').toBe(false);
    mode.exit();
  }, 240000);

  it('a change made while the periods are running marks the rows that land', async () => {
    const { mode, edit } = setup();
    const run = mode.runTimeline();
    await sleep(50);
    expect(tl(mode).status).toBe('running');
    await edit(r => r.map(o => o.id === 'mid' ? { ...o, laneCount: 1 } as DrivableObject : o));
    expect(await run).toBe(true);
    expect(tl(mode).status).toBe('ready');
    expect(tl(mode).outdated).toBe(true);
    mode.exit();
  }, 240000);

  it('Undo back to a case that was run brings its rows back; Redo brings back the rows of the edit', async () => {
    const { mode, edit } = setup();
    await mode.runTimeline();
    const baseRows = tl(mode).rows;
    const original = network();
    await edit(r => r.map(o => o.id === 'mid' ? { ...o, laneCount: 1 } as DrivableObject : o));
    expect(tl(mode).outdated).toBe(true);
    await mode.runTimeline();
    const editRows = tl(mode).rows;
    expect(editRows).not.toBe(baseRows);
    expect(tl(mode).outdated).toBe(false);
    await edit(() => original);
    expect(tl(mode).outdated).toBe(false);
    expect(tl(mode).rows).toBe(baseRows);
    await edit(r => r.map(o => o.id === 'mid' ? { ...o, laneCount: 1 } as DrivableObject : o));
    expect(tl(mode).outdated).toBe(false);
    expect(tl(mode).rows).toBe(editRows);
    mode.exit();
  }, 240000);
});

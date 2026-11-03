import { describe, expect, it, vi, afterEach } from 'vitest';
import { createElement } from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import type { BuildingObject, RoadObject } from '../objects/types';
import type { Delta } from '../simulation/ScenarioComparison';
import type { SimulationContext } from '../simulation/StudyDemand';
import { SimulationMode } from '../simulation/SimulationMode';
import { DeltaRows, ProposalBadge } from '../../components/ScenarioDeltaTable';

afterEach(() => vi.restoreAllMocks());

const delta = (label: string, before: number, after: number, unit = 's'): Delta =>
  ({ label, before, after, unit, lowerIsBetter: true, change: (after - before) / before, good: after < before });

describe('scenario comparison table', () => {
  it('keeps existing and proposal values in separate padded cells with the change on its own line', () => {
    const html = renderToStaticMarkup(createElement(DeltaRows, { rows: [delta('Delay', 389, 376)] }));
    const doc = new DOMParser().parseFromString(`<body>${html}</body>`, 'text/html');
    const cells = [...doc.querySelectorAll('tbody td')];
    expect(cells).toHaveLength(2);
    expect(cells[0].textContent).toBe('389 s');
    // Padding on both sides of the gap between the two value columns
    expect(cells[0].className).toMatch(/\bpx-3\b/);
    expect(cells[1].className).toMatch(/\bpl-3\b/);
    const lines = [...cells[1].querySelectorAll('span.block')].map(x => x.textContent);
    expect(lines).toEqual(['376 s', '-3%']);
  });
  it('omits a negligible change', () => {
    const html = renderToStaticMarkup(createElement(DeltaRows, { rows: [delta('Speed', 1000, 1001, 'km/h')] }));
    expect(html).not.toContain('%');
  });
  it('labels the proposal badge', () => {
    expect(renderToStaticMarkup(createElement(ProposalBadge))).toContain('Proposal');
  });
});

const pt = (x: number, y = 0, z = 0): [number, number, number] => [73.8 + x / (111320 * Math.cos(18.5 * Math.PI / 180)), 18.5 + y / 111320, z];
const road = (id: string, x: number, end: number, laneCount = 2) => ({ id, type: 'road', coordinates: [pt(x), pt(end)], roadClass: 'arterial', laneCount, laneWidth: 3.5, speedLimit: 50, connectedJunctions: [], scenarioId: 'base' } as RoadObject);
const building = (id: string, x: number, residents = 0, employees = 0) => ({ id, type: 'building', coordinates: [pt(x - 1, -1), pt(x + 1, -1), pt(x + 1, 1), pt(x - 1, 1)], residents, employees } as BuildingObject);

describe('proposal flag on the road analysis', () => {
  it('is set only while the analysis on show ran on a network edited since the baseline', async () => {
    let roads = [road('outerW', -500, 0), road('west', 0, 300), road('mid', 300, 900), road('east', 900, 1200), road('outerE', 1200, 1700)];
    const context: SimulationContext = { buildings: [building('home', 300, 6000), building('work', 900, 0, 6000)], scenarioId: 'base' };
    const mode = new SimulationMode(() => roads, null, null, () => context);
    vi.spyOn(mode as any, 'startLoop').mockImplementation(() => {});
    mode.enter(); mode.selectRoad('mid', false);
    await mode.runAnalysis();
    expect(mode.getState().comparison.showingProposal).toBe(false);
    const baseline = await mode.captureBaseline(180);
    if (!baseline) throw new Error('baseline: ' + mode.getState().comparison.staleReason);
    expect(mode.getState().comparison.showingProposal).toBe(false);
    // An edit in Build: the analysis that follows is of the proposal
    roads = roads.map(r => (r.id === 'mid' ? road('mid', 300, 900, 3) : r));
    mode.networkChanged();
    await mode.runAnalysis();
    expect(mode.getState().comparison.showingProposal).toBe(true);
    // A comparison does not change what the analysis view shows
    await mode.runComparison();
    expect(mode.getState().comparison.showingProposal).toBe(true);
    // Undoing the edit brings back the existing city
    roads = roads.map(r => (r.id === 'mid' ? road('mid', 300, 900, 2) : r));
    mode.networkChanged();
    await mode.runAnalysis();
    expect(mode.getState().comparison.showingProposal).toBe(false);
    mode.clearBaseline();
    expect(mode.getState().comparison.showingProposal).toBe(false);
    mode.dispose();
  });
});

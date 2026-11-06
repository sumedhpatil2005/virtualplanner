import { describe, expect, it, vi, afterEach } from 'vitest';
import { createElement } from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import type { BuildingObject, RoadObject } from '../objects/types';
import type { Delta } from '../simulation/ScenarioComparison';
import type { SimulationContext } from '../simulation/StudyDemand';
import { SimulationMode } from '../simulation/SimulationMode';
import { DeltaKpi, DeltaRows, ProposalBadge } from '../../components/ScenarioDeltaTable';

afterEach(() => vi.restoreAllMocks());

const delta = (label: string, before: number, after: number, unit = 's'): Delta =>
  ({ label, before, after, unit, lowerIsBetter: true, change: (after - before) / before, good: after < before });

describe('scenario comparison table', () => {
  it('shows existing → proposal with the change as a coloured pill', () => {
    const html = renderToStaticMarkup(createElement(DeltaRows, { rows: [delta('Delay', 389, 376)] }));
    const doc = new DOMParser().parseFromString(`<body>${html}</body>`, 'text/html');
    expect(doc.querySelectorAll('[data-testid="delta-row"]')).toHaveLength(1);
    expect(doc.querySelector('[data-testid="delta-before"]')!.textContent).toBe('389 s');
    expect(doc.querySelector('[data-testid="delta-after"]')!.textContent).toBe('376 s');
    const pill = doc.querySelector('[data-testid="change-pill"]')!;
    expect(pill.textContent).toBe('-3.3%');
    expect(pill.getAttribute('data-good')).toBe('true');
  });
  it('shows run agreement as a chip, amber when not every run agrees', () => {
    const d = { ...delta('Delay', 100, 80), agreement: { same: 2, of: 3 }, good: null };
    const html = renderToStaticMarkup(createElement(DeltaRows, { rows: [d] }));
    expect(html).toContain('2/3 runs');
    expect(html).toContain('text-amber-200');
    expect(html).toContain('data-good="null"');
  });
  it('renders a before → after KPI card', () => {
    const html = renderToStaticMarkup(createElement(DeltaKpi, { d: delta('Time to drive it', 77, 60), label: 'Time to drive' }));
    expect(html).toContain('Time to drive');
    expect(html).toContain('77 s');
    expect(html).toContain('60 s');
    expect(html).toContain('-22%');
  });
  it('omits a negligible change', () => {
    const html = renderToStaticMarkup(createElement(DeltaRows, { rows: [delta('Speed', 1000, 1001, 'km/h')] }));
    const text = new DOMParser().parseFromString(`<body>${html}</body>`, 'text/html').body.textContent!;
    expect(text).not.toContain('%');
    expect(text).toContain('no change');
  });
  it('keeps one decimal under 10% so a change just under a noise threshold does not read as one above it', () => {
    const html = renderToStaticMarkup(createElement(DeltaRows, { rows: [{ ...delta('Mean delay per trip', 174.76, 166.72), good: null }] }));
    expect(new DOMParser().parseFromString(`<body>${html}</body>`, 'text/html').querySelector('[data-testid="change-pill"]')!.textContent).toBe('-4.6%');
  });
  it('says no data, not no change, when a measure has no value', () => {
    const d: Delta = { label: 'Worst junction delay at its ends', before: null, after: null, unit: 's', lowerIsBetter: true, change: null, good: null };
    const html = renderToStaticMarkup(createElement(DeltaKpi, { d, label: 'End junction delay' }));
    expect(html).toContain('no data');
    expect(html).not.toContain('no change');
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

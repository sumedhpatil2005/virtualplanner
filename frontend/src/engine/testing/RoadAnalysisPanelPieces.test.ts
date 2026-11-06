import { describe, expect, it, vi } from 'vitest';
import { createElement } from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import type { DirectionFlow, LoadCheck, RoadAnalysisResult } from '../simulation/RoadAnalysis';
import {
  StatusHeader, WorstKpis, DirectionsGrid, WhyCard, LoadCard, SourcesCard, BottlenecksCard, SuggestionCard, PerRunDetail, type AnalysisActions,
} from '../../components/RoadAnalysisPieces';
import { explainedDirection, causeLine } from '../../components/roadAnalysisView';
import { Disclosure } from '../../components/ui/viz';

/** A Sangamwadi-like result: two directions, some delay eastbound, overloaded neighbourhood. */
const dir = (over: Partial<DirectionFlow>): DirectionFlow => ({
  label: 'westbound', bearingDeg: 258, compass: 'west', labelBearingDeg: 258, towards: { kind: 'junction', name: 'Old Pune–Mumbai Highway' } as DirectionFlow['towards'], paths: [],
  vph: 579, vphRange: [560, 600], pcuph: 400, demandVph: 558, demandPcu: 590, lanes: 2, midblockPcu: 2571, stopLinePcu: null, capacityPcu: 2571, capacityBasis: 'midblock',
  vc: 0.23, servedVc: 0.2, meanSpeedKmh: 26, speedRange: [25, 27], freeSpeedKmh: 30, speedRatio: 0.86, travelTimeS: 77, freeTimeS: 66, los: 'A', losBySeed: ['A', 'A', 'A'],
  vphBySeed: [560, 577, 600], speedBySeed: [25, 26, 27], delay: { signal: 2, blocked: 1, giveWay: 1, conflict: 0, other: 7, total: 11 }, queuedNow: 0, ...over,
});
const load = (entered: number, overloaded: boolean, message: string | null): LoadCheck => ({ demandVph: 19314, enteredVph: entered, servedShare: entered / 19314, waitingToEnter: 4165, atVehicleLimit: 0, gridlockRemovalsVph: 0, overloaded, message });
const MSG = 'More traffic is routed here than the simulated junctions can pass: 6,620 of the 19,314 veh/h routed into the simulated neighbourhood (34%) got onto its roads. Volumes shown are what got through.';
const result = (over: Partial<RoadAnalysisResult> = {}): RoadAnalysisResult => ({
  windowS: 900, seeds: [42, 7, 1234],
  section: { name: 'Sangamwadi Bridge', lengthM: 500, carriageways: 1, endsAt: [], segmentKeys: [] },
  directions: [
    dir({ label: 'eastbound', bearingDeg: 78, compass: 'east', labelBearingDeg: 78, towards: null, vph: 900, demandVph: 950, meanSpeedKmh: 37, freeSpeedKmh: 50, speedRatio: 0.74, los: 'C', travelTimeS: 49, freeTimeS: 36, vc: 0.41, delay: { signal: 6, blocked: 3, giveWay: 1, conflict: 1, other: 4, total: 15 } }),
    dir({}),
  ],
  totalVph: 1479, status: 'moderate', statusConsistent: true, statusBySeed: ['moderate', 'moderate', 'moderate'],
  headline: 'Eastbound traffic moves with some delay: 37 km/h against a free-flow 50 km/h (level of service C).',
  reasons: ['Eastbound: 950 veh/h routed along it.', MSG],
  cause: { kind: 'mixed', text: 'The delay (15 s per vehicle) is spread over causes: signal 6 s, queue from further on 3 s, giving way 2 s, slow moving traffic 4 s.', chain: null },
  explainedDirection: 'eastbound',
  bottleneck: null,
  origins: [{ label: 'From beyond the area, east, via Airport Road', coordinates: [73.9, 18.5, 0], vph: 600, share: 0.6, edge: true }],
  destinations: [{ label: 'To streets about 300 m west, near Mangaldas Road', coordinates: [73.8, 18.5, 0], vph: 300, share: 0.3, edge: false }],
  composition: { throughShare: 0.93, localShare: 0.07 }, feeders: [], nearby: [], junctions: [],
  selectLinkVph: new Map(), areaVc: new Map(), linkVph: new Map(), areaLinkVph: new Map(),
  areaBottlenecks: [{ label: 'Airport Road at its signal, north-east of the road, 800 m', roadName: 'Airport Road', coordinates: [73.9, 18.55, 0], vc: 1.31, delayVehH: 40, segmentKeys: [], atJunction: true }],
  network: {} as RoadAnalysisResult['network'],
  load: { ...load(6620, true, MSG), servedShare: 0.34 },
  loadBySeed: [load(6620, true, MSG), load(6700, true, MSG), load(6540, true, MSG)],
  assignment: { iterations: 30, relativeGap: 0.001, demandVph: 50000, unroutedVph: 0, overCapacityLinks: 347, totalVehHours: 1000, elapsedMs: 1000 },
  corridor: { roads: 100, demandVph: 19314, rangeM: 700 },
  perSeed: [42, 7, 1234].map(seed => ({ seed, sectionVph: 1479, sectionTimeS: 63, completedTrips: 100, meanTravelTimeS: 200, meanDelayS: 50, servedShare: 0.34, gridlockRemovals: 0, endDelayS: 20 })),
  evidence: { demand: null, notes: [] },
  ...over,
});
const actions = (): AnalysisActions => ({ hoverDirection: vi.fn(), pinDirection: vi.fn(), flyTo: vi.fn(), setOverlay: vi.fn(), editInBuild: vi.fn() });
const doc = (html: string) => new DOMParser().parseFromString(`<body>${html}</body>`, 'text/html');

describe('road analysis panel pieces', () => {
  it('status header: severity chip, one short line, run agreement chip', () => {
    const d = doc(renderToStaticMarkup(createElement(StatusHeader, { r: result(), when: 'Evening peak · 6 pm' })));
    expect(d.querySelector('[data-testid="road-status"]')!.getAttribute('data-status')).toBe('moderate');
    expect(d.body.textContent).toContain('Some delay');
    expect(d.querySelector('[data-testid="status-line"]')!.textContent).toBe('East: 37 km/h vs 50 free-flow');
    expect(d.querySelector('[data-testid="status-consistency"]')!.textContent).toBe('3/3 runs agree');
  });
  it('KPI cards are the explained direction\'s computed figures', () => {
    const d = doc(renderToStaticMarkup(createElement(WorstKpis, { r: result() })));
    expect(d.querySelector('[data-testid="kpi-speed"]')!.textContent).toContain('37');
    expect(d.querySelector('[data-testid="kpi-delay"]')!.textContent).toContain('15');
    expect(d.querySelector('[data-testid="kpi-vc"]')!.textContent).toContain('41%');
    expect(d.querySelector('[data-testid="kpi-los"]')!.textContent).toContain('C');
  });
  it('picks the direction the analysis explains, not just the longest delay', () => {
    const r = result({ explainedDirection: 'westbound' });
    expect(explainedDirection(r)!.d.label).toBe('westbound');
    expect(explainedDirection(result({ explainedDirection: undefined }))!.d.label).toBe('eastbound');
  });
  it('direction cards keep swatch glyph, compass, degrees, landmark and the hover/pin wiring', () => {
    const d = doc(renderToStaticMarkup(createElement(DirectionsGrid, { r: result(), heading: Math.PI / 2, focus: { hover: 1, pinned: null }, actions: actions() })));
    const cards = [...d.querySelectorAll('[data-testid="direction-card"]')];
    expect(cards).toHaveLength(2);
    expect(cards[0].querySelector('[data-testid="direction-title"]')!.textContent).toBe('East · 78°');
    expect(cards[1].querySelector('[data-testid="direction-landmark"]')!.textContent).toBe('to the junction with Old Pune–Mumbai Highway');
    // Glyph rotation is bearing minus camera heading (90°): 78 - 90 = -12 → 348
    expect(cards[0].querySelector('[data-testid="direction-glyph"]')!.getAttribute('data-rotation')).toBe('348');
    expect(cards[1].getAttribute('data-active')).toBe('true');
    expect(cards[0].className).toContain('opacity-60');
  });
  it('why: one-line cause, stacked delay bar, prose collapsed and the load message not repeated', () => {
    const html = renderToStaticMarkup(createElement(WhyCard, { r: result(), overlay: 'none', actions: actions() }));
    const d = doc(html);
    expect(d.querySelector('[data-testid="cause-line"]')!.textContent).toBe('Spread over several causes');
    expect(d.querySelector('[data-testid="delay-breakdown"]')).not.toBeNull();
    const detail = d.querySelector('[data-testid="cause-detail"]')!;
    expect(detail.hasAttribute('open')).toBe(false);
    expect(detail.textContent).toContain('spread over causes');
    expect(html).not.toContain('6,620 of the 19,314');
  });
  it('names a queue cause with its run agreement', () => {
    const r = result({ cause: { kind: 'spillback', text: 'x', chain: { direction: 'eastbound', blockedShare: 0.6, root: { label: 'Bund Garden Road / Mangaldas Road', coordinates: [0, 0], cause: 'signal', delayS: 30 }, segmentKeys: [], agreement: 3, seeds: 3 } } });
    expect(causeLine(r)).toMatchObject({ text: 'Queue backing up from Bund Garden Road / Mangaldas Road (its signal)', agreement: '3/3 runs' });
  });
  it('says which kind of evidence is missing when no cause is named', () => {
    const slowMoving = result({ cause: { kind: 'insufficient', text: 'x', chain: null }, directions: [dir({ label: 'eastbound', delay: { signal: 0, blocked: 0, giveWay: 0, conflict: 0, other: 13, total: 13 } })] });
    expect(causeLine(slowMoving).text).toBe('Slow in moving traffic: no single junction stands out');
    const untraced = result({ cause: { kind: 'insufficient', text: 'x', chain: null }, directions: [dir({ label: 'eastbound', delay: { signal: 2, blocked: 8, giveWay: 0, conflict: 0, other: 2, total: 12 } })] });
    expect(causeLine(untraced).text).toBe('Queue from further on, not traced to one junction consistently');
  });
  it('demand vs throughput: one card with per-run bars and the explanation behind a toggle', () => {
    const html = renderToStaticMarkup(createElement(LoadCard, { r: result() }));
    const d = doc(html);
    expect(d.querySelectorAll('[data-testid="load-warning"]')).toHaveLength(1);
    expect(d.body.textContent).toContain('34%');
    expect(d.body.textContent).toContain('3/3 runs');
    expect(d.querySelectorAll('[data-testid="load-runs"] li')).toHaveLength(3);
    expect(d.body.textContent).toContain('4,165 queued at edge');
    // The explanation is closed by default
    expect(html).not.toContain('6,620 of the 19,314');
  });
  it('no load card when no run is overloaded', () => {
    const r = result({ load: load(19000, false, null), loadBySeed: [load(19000, false, null)] });
    expect(renderToStaticMarkup(createElement(LoadCard, { r }))).toBe('');
  });
  it('sources and bottlenecks render as bars with their shares', () => {
    const s = renderToStaticMarkup(createElement(SourcesCard, { r: result(), overlay: 'none', actions: actions() }));
    expect(s).toContain('93%');
    expect(s).toContain('60%');
    const b = renderToStaticMarkup(createElement(BottlenecksCard, { r: result(), overlay: 'none', actions: actions() }));
    expect(b).toContain('347 over capacity');
    expect(b).toContain('131%');
    expect(b).toContain('Show Airport Road on the map');
  });
  it('a bottleneck label with the forced-flow note fits: three lines, not cut at two (docs/OVERHAUL.md §16 merged-build check)', () => {
    const r = result();
    r.areaBottlenecks = [{ ...r.areaBottlenecks[0], label: 'Old Pune–Mumbai Highway, south-east of the road, 200 m (no other route in the model for 100% of its traffic)' }];
    const b = renderToStaticMarkup(createElement(BottlenecksCard, { r, overlay: 'none', actions: actions() }));
    const span = b.match(/<span[^>]*data-testid="bottleneck-label"[^>]*>/)![0];
    expect(span).toContain('line-clamp-3');
    expect(span).not.toContain('line-clamp-2');
  });
  it('a network gap behind a forced stretch has its own line, not the clamped label\'s last note (docs/OVERHAUL.md §19)', () => {
    const r = result();
    r.areaBottlenecks = [{ ...r.areaBottlenecks[0], roadName: 'COEP Road', vc: 6.7, demandOverCapacity: true, noAlternativeShare: 1,
      label: 'COEP Road, south-east of the road, 300 m (demand 6.7× its capacity: more than can pass, not a flow; no other route in the model for 100% of its traffic; network gap: Mokshagundam Vishweshvarayya Flyover ends without a connection 100 m away)',
      gap: { roadName: 'Mokshagundam Vishweshvarayya Flyover', title: 'Mokshagundam Vishweshvarayya Flyover ends without a connection', coordinates: [73.85, 18.53, 0], distanceM: 14 } }];
    const d = doc(renderToStaticMarkup(createElement(BottlenecksCard, { r, overlay: 'none', actions: actions() })));
    expect(d.querySelector('[data-testid="bottleneck-gap"]')?.textContent).toBe('Network gap: Mokshagundam Vishweshvarayya Flyover ends without a connection, 100 m away');
    const label = d.querySelector('[data-testid="bottleneck-label"]')!;
    expect(label.textContent).toBe('COEP Road, south-east of the road, 300 m (demand 6.7× its capacity: more than can pass, not a flow; no other route in the model for 100% of its traffic)');
    expect(label.getAttribute('title')).toContain('network gap: Mokshagundam');
  });
  it('suggestion card shows the headline figure and the CTAs', () => {
    const html = renderToStaticMarkup(createElement(SuggestionCard, { s: { kind: 'widen', title: 'Add a lane', evidence: 'e', why: 'w', figure: { value: '91%', label: 'of mid-block capacity' }, action: { label: 'Select the road in Build', roadIds: ['a'], at: null } }, onTest: () => {}, actions: actions() }));
    expect(html).toContain('91%');
    expect(html).toContain('Test it');
    expect(html).toContain('Select the road in Build');
  });
  it('disclosures are closed by default; per-run detail lists every seed', () => {
    expect(renderToStaticMarkup(createElement(Disclosure, { title: 'How this is calculated' }, 'x'))).not.toMatch(/<details[^>]*open/);
    const d = doc(renderToStaticMarkup(createElement(PerRunDetail, { r: result() })));
    expect(d.querySelector('details')!.hasAttribute('open')).toBe(false);
    expect(d.querySelectorAll('tbody tr')).toHaveLength(3);
    expect(d.body.textContent).toContain('560–600 veh/h');
  });
});

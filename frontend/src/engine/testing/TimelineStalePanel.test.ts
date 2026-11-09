/**
 * Outdated "Through the day" rows (docs/OVERHAUL.md §25): everything read from them, the rows, the day
 * summary and the per-run table, is dimmed together under the notice, also while a run is in progress.
 */
import { describe, it, expect, vi } from 'vitest';
import { createElement } from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import type { SimulationModeState, TimelineRow, TimelineState } from '../simulation/SimulationMode';

vi.mock('../TwinCityEngine', () => ({ engineInstance: { simMode: { analysisSeeds: [42], runTimeline: () => Promise.resolve(true), cancelTimeline: () => {} } } }));
const { TimesOfDay } = await import('../../components/RoadAnalysisPanel');

const dir = (o: Record<string, unknown>) => ({ label: 'eastbound', demandVph: 2600, demandPcu: 2600, vph: 1110, pcuph: 1110, meanSpeedKmh: 3, freeSpeedKmh: 50, speedRatio: 0.06, los: 'F', losBasis: 'speed', losBySeed: ['F'], vphBySeed: [1110], speedBySeed: [3], vc: 1.0, ...o });
const row = (period: string, hour: number, factor: number, d: ReturnType<typeof dir>, status = 'severe'): TimelineRow => ({
  period: period as TimelineRow['period'], label: period, hour, demandVph: 0, hourFactor: factor, referenceHour: hour < 12 ? 9 : 19, seeds: [42],
  result: { directions: [d], totalVph: d.vph, status, statusConsistent: true, statusBySeed: [status], seeds: [42], explainedDirection: d.label,
    cause: { kind: 'spillback', text: '', chain: { root: { label: 'X / Y' }, agreement: 1, seeds: 1 } } } as never });
const rows = [row('am', 9, 1, dir({})), row('midday', 14, 0.7, dir({ demandVph: 1800, vph: 1150 })), row('pm', 19, 1, dir({ vph: 1140 })),
  row('night', 23, 0.18, dir({ demandVph: 470, vph: 460, vc: 0.2, meanSpeedKmh: 12, speedRatio: 0.24, los: 'E' }), 'congested')];
const html = (t: Partial<TimelineState>) => renderToStaticMarkup(createElement(TimesOfDay, { sim: { timeline: { status: 'ready', progress: 1, rows, error: null, key: 'k', outdated: false, ...t } } as unknown as SimulationModeState }));
/** The markup inside the dimmed results block. */
const results = (h: string) => { const i = h.indexOf('data-testid="timeline-results"'); return { open: h.slice(h.lastIndexOf('<div', i), h.indexOf('>', i) + 1), inner: h.slice(i) }; };

describe('Through the day panel: outdated rows', () => {
  it('current rows are not dimmed and carry no notice', () => {
    const h = html({});
    expect(h).not.toContain('timeline-outdated');
    expect(results(h).open).toContain('data-outdated="false"');
    expect(results(h).open).not.toContain('opacity-60');
  });

  it('outdated: rows, summary and per-run table sit inside the dimmed block, under the notice', () => {
    const h = html({ outdated: true });
    expect(h).toContain('data-testid="timeline-outdated"');
    const r = results(h);
    expect(r.open).toContain('opacity-60');
    expect(r.open).toContain('data-outdated="true"');
    for (const id of ['timeline-rows', 'timeline-summary', 'timeline-detail']) expect(r.inner, id).toContain(`data-testid="${id}"`);
    expect(h.indexOf('timeline-outdated')).toBeLessThan(h.indexOf('timeline-results'));
  });

  it('a change during a run is announced while it is still running', () => {
    const h = html({ status: 'running', progress: 0.5, outdated: true });
    expect(h).toContain('changed after these runs started');
    expect(results(h).open).toContain('opacity-60');
  });
});

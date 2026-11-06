import { describe, expect, it, vi } from 'vitest';
import { createElement } from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import type { DirectionFlow, RoadAnalysisResult } from '../simulation/RoadAnalysis';
import type { LaneInsight } from '../simulation/ScenarioComparison';
import { CapacityStretchCard, LaneInsightCard } from '../../components/LaneBottleneckCard';

/** The bottleneck cards (docs/OVERHAUL.md §16) render from the structured fields alone. */
const approach = { roadId: 'osm_1151682763', name: 'Sangamwadi Bridge', lanes: 2, lengthM: 136, capacityPcu: 2571 };
const approachW = { roadId: 'osm_661187162', name: 'Sangamwadi Bridge', lanes: 2, lengthM: 60, capacityPcu: 2571 };
const deck = { roadId: 'osm_208004768', name: 'Sangamwadi Bridge', lanes: 3, lengthM: 368, capacityPcu: 3857 };
const dir = (over: Partial<DirectionFlow>) => ({ label: 'eastbound', midblockPcu: 2571, lanes: 2, lanesRange: [2, 2], binding: approach, bindingSegments: [approach, approachW], segments: [approachW, deck, approach], ...over }) as DirectionFlow;
const result = (ds: DirectionFlow[]) => ({ directions: ds }) as unknown as RoadAnalysisResult;

describe('capacity stretch card (What\'s wrong)', () => {
  it('names the 2-lane approach that sets eastbound capacity when only the deck has 3 lanes', () => {
    const html = renderToStaticMarkup(createElement(CapacityStretchCard, { r: result([dir({ lanesRange: [2, 3] }), dir({ label: 'westbound' })]), onShow: vi.fn() }));
    expect(html).toContain('data-binding-road="osm_1151682763"');
    expect(html).toContain('2-lane stretch');
    expect(html).toContain('osm_1151682763 (136 m)');
    expect(html).toContain('3-lane osm_208004768 (368 m)');
    expect(html).toContain('model output');
    expect(html).toContain('Show on map');
    expect(html).not.toContain('data-direction="westbound"');
  });
  it('shows nothing when every direction has the same lanes along it', () => {
    expect(renderToStaticMarkup(createElement(CapacityStretchCard, { r: result([dir({}), dir({ label: 'westbound' })]), onShow: vi.fn() }))).toBe('');
  });
});

describe('lane insight card (Improve & compare)', () => {
  it('warns that capacity did not change and why', () => {
    const ins = { direction: 'eastbound', editedRoadIds: [deck.roadId], edited: [deck], lanesBefore: [2, 2], lanesAfter: [2, 3], capacityBefore: 2571, capacityAfter: 2571, capacityChanged: false,
      binding: approach, bindingSegments: [approach, approachW], bindingEdited: false, bindingMoved: false, signalLimited: false, newBottlenecksNearby: [], kind: 'unchanged_elsewhere',
      text: 'Eastbound capacity is still 2,571 PCU/h: it is set by a 2-lane stretch of Sangamwadi Bridge (osm_1151682763, 136 m).' } as LaneInsight;
    const html = renderToStaticMarkup(createElement(LaneInsightCard, { insights: [ins], onShow: vi.fn() }));
    expect(html).toContain('data-kind="unchanged_elsewhere"');
    expect(html).toContain('2,571 → 2,571 PCU/h');
    expect(html).toContain('lanes 2 → 2–3');
    expect(html).toContain('Show on map');
  });
  it('shows nothing without insights', () => {
    expect(renderToStaticMarkup(createElement(LaneInsightCard, { insights: [], onShow: vi.fn() }))).toBe('');
  });
});

import { describe, it, expect } from 'vitest';
import { ROAD_HIGHLIGHT_STYLE } from '../rendering/renderers/RoadHighlight';
import { SEED_GLOW_WIDTH_PX, STUDY_ROLE_COLORS } from '../rendering/renderers/StudyAreaVisualizer';

describe('road highlight stands out on the Simulate map (docs/OVERHAUL.md §16, merged-build browser check)', () => {
  it('the binding highlight is wider than the selected road glow it sits on', () => {
    expect(ROAD_HIGHLIGHT_STYLE.binding.width).toBeGreaterThan(SEED_GLOW_WIDTH_PX);
  });
  it('a binding highlight in a study-area colour has an outline that sets it apart', () => {
    const b = ROAD_HIGHLIGHT_STYLE.binding;
    const shared = Object.values(STUDY_ROLE_COLORS).map(c => c.toLowerCase()).includes(b.css.toLowerCase());
    expect(!shared || (!!b.outline && b.outline.widthPx >= 3)).toBe(true);
  });
});

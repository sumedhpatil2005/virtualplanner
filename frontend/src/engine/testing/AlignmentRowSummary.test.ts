import { describe, expect, it } from 'vitest';
import { alignmentRowSummary } from '../underground/alignmentGeometry';

describe('alignment list row', () => {
  it('keeps each value with its unit (no-break space) and says unknown depths in words', () => {
    const s = alignmentRowSummary('Bored tunnel', { lengthM: 3314.6, maxKnownDepthM: 21, unknownDepthCount: 2 });
    expect(s).toBe('Bored tunnel · 3,315\u00a0m · deepest 21.0\u00a0m · 2\u00a0vertex depths unknown');
    expect(s).not.toContain('?');
  });
  it('says Unknown when no depth is known, singular for one', () => {
    expect(alignmentRowSummary('Cut and cover', { lengthM: 728, maxKnownDepthM: null, unknownDepthCount: 1 }))
      .toBe('Cut and cover · 728\u00a0m · deepest Unknown · 1\u00a0vertex depth unknown');
  });
});

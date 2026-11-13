import { describe, it, expect } from 'vitest';
import { createElement } from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import { CertaintyBadge, TrustBadge, DataStatus, ModelTrustPill, ValidationSummary, formatOrUnknown, certaintyOf, certaintyFromProvenance, TRAFFIC_VALIDATION, FAILS_VALIDATION_LABEL } from '../../components/ui/badges';

/** Honesty components (docs/urbanos/UX_ARCHITECTURE.md §4; docs/urbanos/DESIGN_TOOLS_AND_HONESTY.md). */
describe('certainty', () => {
  it('renders all four levels with their own label', () => {
    for (const [c, l] of [['measured', 'Measured'], ['estimated', 'Estimated'], ['hypothetical', 'Hypothetical'], ['unknown', 'Unknown']] as const) {
      const html = renderToStaticMarkup(createElement(CertaintyBadge, { certainty: c }));
      expect(html).toContain(`data-certainty="${c}"`);
      expect(html).toContain(l);
    }
  });
  it('never turns a missing value into 0 or a pass', () => {
    expect(formatOrUnknown(undefined)).toBe('Unknown');
    expect(formatOrUnknown(null)).toBe('Unknown');
    expect(formatOrUnknown(Number.NaN)).toBe('Unknown');
    expect(formatOrUnknown(0)).toBe('0');
    expect(certaintyOf(undefined, 'measured')).toBe('unknown');
    expect(certaintyOf(12, 'measured')).toBe('measured');
    expect(certaintyFromProvenance(undefined)).toBe('unknown');
    expect(certaintyFromProvenance('survey')).toBe('measured');
    expect(certaintyFromProvenance('hypothetical')).toBe('hypothetical');
  });
});

describe('trust', () => {
  it('labels the traffic model "Fails validation (TAG M3.1)" as a button that opens the results', () => {
    const html = renderToStaticMarkup(createElement(TrustBadge, { trust: 'fails_validation' }));
    expect(FAILS_VALIDATION_LABEL).toBe('Fails validation (TAG M3.1)');
    expect(html).toContain('Fails validation (TAG M3.1)');
    expect(html).toContain('<button');
    expect(html).toContain('data-trust="fails_validation"');
  });
  it('the other trust levels are plain labels', () => {
    expect(renderToStaticMarkup(createElement(TrustBadge, { trust: 'stale' }))).toContain('Stale');
    expect(renderToStaticMarkup(createElement(TrustBadge, { trust: 'not_validated' }))).not.toContain('<button');
  });
  it('the summary carries the recorded numbers and no row passes', () => {
    const html = renderToStaticMarkup(createElement(ValidationSummary));
    for (const s of ['0 / 15', '−30.5%', '4 / 21', '27 / 120', '2 / 9', 'TAG M3.1']) expect(html).toContain(s);
    expect(TRAFFIC_VALIDATION.rows.every(r => r.status === 'FAIL')).toBe(true);
    expect(html).not.toContain('PASS');
  });
  it('the top-bar pill says the model fails validation', () => {
    expect(renderToStaticMarkup(createElement(ModelTrustPill))).toContain('Traffic model fails validation');
  });
});

describe('data status', () => {
  it('not imported reads as UNKNOWN', () => {
    const html = renderToStaticMarkup(createElement(DataStatus, { name: 'Flood zones', value: { status: 'not_imported' } }));
    expect(html).toContain('Not imported');
    expect(html).toContain('UNKNOWN');
  });
  it('available shows source, date and licence; a blank one shows UNKNOWN', () => {
    const html = renderToStaticMarkup(createElement(DataStatus, { name: 'Roads', value: { status: 'available', source: 'OpenStreetMap', date: '2026-10-01', licence: '' } }));
    expect(html).toContain('OpenStreetMap');
    expect(html).toContain('2026-10-01');
    expect(html).toContain('licence UNKNOWN');
    const none = renderToStaticMarkup(createElement(DataStatus, { name: 'Roads', value: { status: 'available', source: '', date: '', licence: '' } }));
    expect(none).toContain('source UNKNOWN');
    expect(none).toContain('date UNKNOWN');
  });
});

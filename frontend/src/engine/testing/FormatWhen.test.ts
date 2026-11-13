/** Timestamps always carry a zone (QA 2026-11-14). */
import { describe, expect, it } from 'vitest';
import { formatWhen } from '../../lib/formatWhen';

describe('formatWhen', () => {
  it('server-formatted local times with zone are shown as sent, never re-parsed', () => {
    expect(formatWhen('Fri 2026-11-13 10:42 PM IST (UTC+05:30)')).toBe('Fri 2026-11-13 10:42 PM IST (UTC+05:30)');
  });
  it('ISO timestamps are formatted with a zone name', () => {
    const s = formatWhen('2026-11-13T17:12:09Z');
    expect(s).toMatch(/2026/);
    expect(s).toMatch(/UTC|GMT|[A-Z]{2,5}/);
  });
  it('a time without a zone says so instead of guessing one', () => {
    expect(formatWhen('2026-11-13 17:12:09.380523')).toBe('2026-11-13 17:12:09 (zone not stated)');
  });
  it('empty → the fallback', () => {
    expect(formatWhen(null)).toBe('–');
    expect(formatWhen('', 'never')).toBe('never');
  });
});

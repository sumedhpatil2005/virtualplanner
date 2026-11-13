/**
 * The project-level traffic-model verdict, copied from docs/ENGINEERING_VALIDATION.md §5.0
 * (results on commit c916854; criteria UK DfT TAG unit M3.1, May 2026,
 * https://assets.publishing.service.gov.uk/media/6a033d074fb0713aa63ea802/tag-m3-1-highway-assignment-modelling.pdf).
 * These are recorded results, not live values: update them only when that document is re-run.
 */
export interface ValidationRow {
  test: string;
  required: string;
  result: string;
  status: 'FAIL' | 'PASS' | 'NOT EVALUATED';
}

export const TRAFFIC_VALIDATION = {
  verdict: 'fails_validation' as const,
  standard: 'TAG M3.1',
  standardTitle: 'UK DfT TAG unit M3.1, Highway Assignment Modelling (May 2026)',
  standardUrl: 'https://assets.publishing.service.gov.uk/media/6a033d074fb0713aa63ea802/tag-m3-1-highway-assignment-modelling.pdf',
  source: 'docs/ENGINEERING_VALIDATION.md §5.0',
  codeRef: 'c916854',
  rows: [
    { test: 'Counts, GEH < 5 (assigned volume)', required: '> 85% of sites', result: '0 / 15 (mean GEH 32.3)', status: 'FAIL' },
    { test: 'Counts, flow criterion', required: '> 85% of sites', result: '0 / 15', status: 'FAIL' },
    { test: 'River screen line (9 crossings)', required: 'within 5%', result: '54,493 vs 78,357 (−30.5%)', status: 'FAIL' },
    { test: 'Section speeds within 15% (micro-sim)', required: '> 85% of 21', result: '4 / 21 (MAPE 38%, bias −18%)', status: 'FAIL' },
    { test: 'Corridor-hour speeds within 15%', required: '> 85% of 120', result: '27 / 120 (MAPE 54%, bias +40%)', status: 'FAIL' },
    { test: 'City speed by hour within 15%', required: '> 85% of 9', result: '2 / 9 (MAPE 32%, bias +32%)', status: 'FAIL' },
  ] as ValidationRow[],
  meaning: 'Numbers are estimated: use them to compare options on the same inputs, not as forecasts of Pune traffic.',
};

/** Short label used on every traffic / ODME / emissions output. */
export const FAILS_VALIDATION_LABEL = `Fails validation (${TRAFFIC_VALIDATION.standard})`;

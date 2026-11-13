/**
 * Honesty vocabulary (docs/urbanos/UX_ARCHITECTURE.md §4, PRODUCT_UX_RESEARCH.md §5.7).
 * Two independent axes, never merged:
 *  - Certainty of a VALUE: measured | estimated | hypothetical | unknown
 *  - Trust of a MODEL / output: fails_validation | not_validated | stale | validated
 * Plus the import status of a DATASET: available (source, date, licence) | not_imported (= UNKNOWN).
 */

export type Certainty = 'measured' | 'estimated' | 'hypothetical' | 'unknown';
export type Trust = 'fails_validation' | 'not_validated' | 'stale' | 'validated';

export const CERTAINTY_LABEL: Record<Certainty, string> = {
  measured: 'Measured',
  estimated: 'Estimated',
  hypothetical: 'Hypothetical',
  unknown: 'Unknown',
};

export const CERTAINTY_HELP: Record<Certainty, string> = {
  measured: 'Measured or surveyed and recorded with a source.',
  estimated: 'Estimated by a heuristic or model, not measured.',
  hypothetical: 'An assumed what-if value (a tool default or a user entry); neither measured nor forecast. Edit it.',
  unknown: 'No data. Unknown is never treated as zero or as a pass.',
};

/** CSS custom property (tokens.css, PUX §5.1) with the dark-theme fallback hex. */
export const CERTAINTY_COLOR: Record<Certainty, string> = {
  measured: 'var(--measured, #3FB950)',
  estimated: 'var(--estimated, #D29922)',
  hypothetical: 'var(--hypothetical, #B392F0)',
  unknown: 'var(--unknown, #9AA4B2)',
};

export const TRUST_LABEL: Record<Trust, string> = {
  fails_validation: 'Fails validation',
  not_validated: 'Not validated',
  stale: 'Stale',
  validated: 'Validated',
};

export const TRUST_HELP: Record<Trust, string> = {
  fails_validation: 'The model fails its acceptance criteria against observed data. Use outputs to compare options on the same inputs, not as forecasts.',
  not_validated: 'Not checked against independent observations.',
  stale: 'Inputs changed since this was computed. Re-run before relying on it.',
  validated: 'Meets its acceptance criteria against independent observations.',
};

export const TRUST_COLOR: Record<Trust, string> = {
  fails_validation: 'var(--fail, #FF6B61)',
  not_validated: 'var(--warn, #E8833A)',
  stale: 'var(--warn, #E8833A)',
  validated: 'var(--measured, #3FB950)',
};

/**
 * Formats a possibly-missing number. Missing / non-finite values become "Unknown",
 * never 0 (a missing value must not read as zero or as a pass).
 */
export function formatOrUnknown(value: number | null | undefined, format: (v: number) => string = v => String(v)): string {
  return typeof value === 'number' && Number.isFinite(value) ? format(value) : 'Unknown';
}

/** Certainty of a value that may be missing: a missing value is always 'unknown', whatever was claimed. */
export function certaintyOf(value: unknown, claimed: Certainty): Certainty {
  if (value === null || value === undefined) return 'unknown';
  if (typeof value === 'number' && !Number.isFinite(value)) return 'unknown';
  return claimed;
}

/** Maps project provenance strings onto the certainty axis. Missing → unknown (not estimated). */
export function certaintyFromProvenance(source: string | null | undefined): Certainty {
  switch (source) {
    case 'observed': case 'survey': case 'measured': return 'measured';
    case 'estimated': case 'synthetic': case 'calibrated': case 'simulated': case 'project-estimate': return 'estimated';
    case 'hypothetical': return 'hypothetical';
    default: return 'unknown';
  }
}

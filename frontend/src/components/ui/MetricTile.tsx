import React from 'react';

/**
 * One figure: label · value + unit · optional badge slot · optional delta.
 * A missing value (null / undefined / NaN) renders "—" with the word "Unknown" — never 0, never green
 * (UX_ARCHITECTURE §4, PRODUCT_UX_RESEARCH §5.7). Certainty/trust badges are passed in through `badge`
 * (they live in ui/badges/, owned by the design-tools work).
 */
export const MetricTile: React.FC<{
  label: string;
  value: number | string | null | undefined;
  unit?: string;
  /** Certainty / trust badge for this value. */
  badge?: React.ReactNode;
  /** Signed change against a reference; shown with sign AND arrow, not colour alone. */
  delta?: { value: number; unit?: string; reference: string } | null;
  digits?: number;
  hint?: string;
  'data-testid'?: string;
}> = ({ label, value, unit, badge, delta, digits = 0, hint, ...rest }) => {
  const missing = value == null || (typeof value === 'number' && !Number.isFinite(value));
  const shown = missing ? '—' : typeof value === 'number' ? value.toLocaleString('en-IN', { maximumFractionDigits: digits, minimumFractionDigits: digits }) : value;
  return (
    <div className="uos-metric" data-testid={rest['data-testid']} data-unknown={missing ? 'true' : undefined}>
      <div className="text-label text-text-2">{label}</div>
      <div className="flex items-baseline gap-1 mt-0.5">
        <span className="text-metric font-semibold tabular-nums text-text-1">{shown}</span>
        {!missing && unit && <span className="text-label text-text-2">{unit}</span>}
      </div>
      <div className="flex flex-wrap items-center gap-1.5 mt-1 min-h-4">
        {missing && <span className="text-meta text-unknown font-medium">Unknown</span>}
        {badge}
        {delta && Number.isFinite(delta.value) && (
          <span className="text-meta text-text-2 tabular-nums" title={`Change vs ${delta.reference}`}>
            {delta.value > 0 ? '▲ +' : delta.value < 0 ? '▼ −' : '■ '}
            {Math.abs(delta.value).toLocaleString('en-IN', { maximumFractionDigits: digits })}{delta.unit ? ` ${delta.unit}` : ''} vs {delta.reference}
          </span>
        )}
      </div>
      {hint && <div className="text-meta text-text-3 mt-0.5">{hint}</div>}
    </div>
  );
};

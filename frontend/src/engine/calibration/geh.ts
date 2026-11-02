/**
 * GEH statistic for comparing modelled and observed hourly flows.
 *
 *   GEH = sqrt( 2 (M - C)^2 / (M + C) )      M = modelled, C = counted, both veh/h
 *
 * Acceptance (UK DMRB TAG M3.1 / FHWA Traffic Analysis Toolbox Vol. III):
 * GEH < 5 for at least 85% of counted movements. GEH applies to hourly flows
 * only; a count over another period must be converted to veh/h first.
 */
export const GEH_PASS = 5;
export const GEH_TARGET_SHARE = 0.85;

export function geh(modelled: number, counted: number): number {
  if (!Number.isFinite(modelled) || !Number.isFinite(counted) || modelled < 0 || counted < 0) return NaN;
  const sum = modelled + counted;
  return sum === 0 ? 0 : Math.sqrt((2 * (modelled - counted) ** 2) / sum);
}

export interface GehSummary {
  /** Movements compared. */
  n: number;
  pass: number;
  /** Share with GEH below GEH_PASS (0-1), null when nothing was compared. */
  share: number | null;
  meetsTarget: boolean;
  meanGeh: number | null;
  maxGeh: number | null;
}

export function summarizeGeh(values: readonly number[]): GehSummary {
  const v = values.filter(Number.isFinite);
  const pass = v.filter(g => g < GEH_PASS).length;
  const share = v.length ? pass / v.length : null;
  return {
    n: v.length, pass, share,
    meetsTarget: share !== null && share >= GEH_TARGET_SHARE,
    meanGeh: v.length ? v.reduce((a, b) => a + b, 0) / v.length : null,
    maxGeh: v.length ? Math.max(...v) : null,
  };
}

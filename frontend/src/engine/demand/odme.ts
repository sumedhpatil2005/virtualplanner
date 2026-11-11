/**
 * OD matrix estimation from traffic counts (ODME): Spiess (1990) gradient method.
 *
 * Source: H. Spiess (1990), "A gradient approach for the O-D matrix adjustment problem",
 * CRT Publication 693, Centre de recherche sur les transports, Université de Montréal
 * (text: http://www.spiess.ch/emme2/demadj/demadj.html). Design decision and alternatives:
 * docs/RESEARCH_AND_TECHNICAL_DECISIONS.md A2; this module: docs/ODME_AND_EMISSIONS.md.
 *
 * Problem (bi-level): minimise Z(g) = ½ Σ_c w_c (m_c(g) − ĉ_c)²  [+ ½ μ Σ_i (g_i − ĝ_i)² / ĝ_i]
 * where m_c(g) is the modelled flow at count c when the matrix g is assigned by the
 * existing user-equilibrium assignment (staticAssignment.ts), ĉ_c the count, ĝ the prior.
 *
 * Spiess's steepest-descent step, with the assignment's path proportions held fixed within
 * an iteration:
 *   gradient     ∂Z/∂g_i = Σ_k p_ik Σ_{a∈k} r_a,  r_a = Σ_{c counted on a} w_c (m_c − ĉ_c)
 *   update       g_i ← g_i (1 − λ ∂Z/∂g_i)        (multiplicative: a cell that is 0 stays 0,
 *                                                  so no OD pair is invented)
 *   flow change  v'_a = −Σ_i g_i ∂Z/∂g_i Σ_k p_ik δ_ak
 *   step length  λ* = Σ_c w_c m'_c (ĉ_c − m_c) / Σ_c w_c m'_c²   (exact for the linearised problem)
 *   bound        λ ∂Z/∂g_i < 1 for every i (keeps every cell positive)
 * then the matrix is re-assigned (new equilibrium, new proportions) and the next iteration starts.
 *
 * Additions, each stated in the report and documented:
 *  - optional regularisation toward the prior (μ > 0; GLS-style, Cascetta 1984); μ = 0 is Spiess as published;
 *  - optional bounds on each cell's total factor g_i / ĝ_i (default 0.25–4, the bounds the app's IPF
 *    count seeding already uses, calibration/ipf.ts);
 *  - a step that raises Z after re-assignment (the bi-level problem is not convex) is halved, at most 4 times.
 *
 * Counts used here are CALIBRATION counts only. Validation (held-out) datasets are refused:
 * TAG M3.1 §3.3.8 requires fitted and independent counts to be reported separately.
 * The estimator never sees, and never reports, held-out counts.
 *
 * Plain arrays in and out; no UI, no I/O.
 */

/** Links of one counted place: each group is the set of links one of which carries the counted flow (the busiest is taken, as countValidation.ts does); groups add up (e.g. both directions). */
export interface OdmeCount {
  id: string;
  groups: number[][];
  observed: number;
  /** Relative weight w_c (default 1). */
  weight?: number;
  datasetId: string;
}

export interface OdmeLoad {
  /** Volume per link (same unit as the counts). */
  linkFlow: Float64Array;
  /** Per OD cell: its paths (link indices) and their shares of the cell (shares sum to 1; empty: not routable). */
  odPaths: { links: Int32Array; share: number }[][];
  /** Relative gap of the equilibrium reached (reported). */
  gap?: number;
}

export interface OdmeProblem {
  /** Prior matrix (cells in the counts' unit, e.g. veh/h at the modelled hour). */
  prior: Float64Array;
  /** Assigns a matrix (same cell order as the prior) by the model's own assignment. */
  assign(matrix: Float64Array): OdmeLoad;
}

export interface OdmeOptions {
  maxIterations?: number;
  /** Stop when Z falls by less than this share in an iteration. */
  tolerance?: number;
  /** Bounds on each cell's factor against the prior; null: no bound. */
  cellFactorBounds?: [number, number] | null;
  /** Regularisation weight μ toward the prior (0: Spiess 1990 as published). */
  priorWeight?: number;
  /** Datasets held out for validation: a count from one is refused. */
  heldOutDatasetIds?: readonly string[];
}

export interface OdmeIteration { iteration: number; objective: number; stepLength: number; halvings: number; meanAbsGeh: number; assignmentGap: number | null;
  /** False for a last step that raised the objective after re-assignment: it was discarded and the previous matrix kept. */
  accepted: boolean }

export interface OdmeFit { id: string; datasetId: string; observed: number; before: number; after: number; gehBefore: number; gehAfter: number }

export interface OdmeEstimate {
  matrix: Float64Array;
  /** Per cell: estimated / prior (1 where the prior is 0). */
  factors: Float64Array;
  fit: OdmeFit[];
  iterations: OdmeIteration[];
  converged: boolean;
  stopReason: string;
  /** Cells that hit a factor bound. */
  boundedCells: number;
  load: OdmeLoad;
  priorLoad: OdmeLoad;
  options: Required<Omit<OdmeOptions, 'heldOutDatasetIds' | 'cellFactorBounds'>> & { cellFactorBounds: [number, number] | null };
}

export const ODME_DEFAULTS = { maxIterations: 15, tolerance: 1e-3, cellFactorBounds: [0.25, 4] as [number, number], priorWeight: 0 };

export const gehOf = (m: number, c: number) => { const s = m + c; return s <= 0 ? 0 : Math.sqrt(2 * (m - c) ** 2 / s); };

/** Modelled flow at a count and, per group, the link that carries it (the busiest). */
export function modelledAt(count: OdmeCount, flow: Float64Array): { value: number; links: number[] } {
  let value = 0;
  const links: number[] = [];
  for (const g of count.groups) {
    let best = -1, bv = -Infinity;
    for (const li of g) if (flow[li] > bv) { bv = flow[li]; best = li; }
    if (best >= 0) { value += bv; links.push(best); }
  }
  return { value, links };
}

export class HeldOutCountError extends Error {}

export function estimateOd(problem: OdmeProblem, counts: readonly OdmeCount[], o: OdmeOptions = {}): OdmeEstimate {
  const held = new Set(o.heldOutDatasetIds ?? []);
  const leaked = counts.filter(c => held.has(c.datasetId));
  if (leaked.length) throw new HeldOutCountError(`Validation (held-out) counts cannot be used for estimation: ${[...new Set(leaked.map(c => c.datasetId))].join(', ')}`);
  if (!counts.length) throw new Error('No calibration counts to estimate from.');
  const opts = {
    maxIterations: o.maxIterations ?? ODME_DEFAULTS.maxIterations,
    tolerance: o.tolerance ?? ODME_DEFAULTS.tolerance,
    cellFactorBounds: o.cellFactorBounds === undefined ? ODME_DEFAULTS.cellFactorBounds : o.cellFactorBounds,
    priorWeight: o.priorWeight ?? ODME_DEFAULTS.priorWeight,
  };
  const prior = problem.prior, n = prior.length, mu = opts.priorWeight;
  const [lo, hi] = opts.cellFactorBounds ?? [0, Infinity];
  const w = counts.map(c => c.weight ?? 1);

  const objective = (g: Float64Array, load: OdmeLoad) => {
    let z = 0;
    counts.forEach((c, k) => { z += 0.5 * w[k] * (modelledAt(c, load.linkFlow).value - c.observed) ** 2; });
    if (mu > 0) for (let i = 0; i < n; i++) if (prior[i] > 0) z += 0.5 * mu * (g[i] - prior[i]) ** 2 / prior[i];
    return z;
  };
  const meanGeh = (load: OdmeLoad) => counts.reduce((s, c) => s + gehOf(modelledAt(c, load.linkFlow).value, c.observed), 0) / counts.length;

  let g: Float64Array = Float64Array.from(prior);
  const priorLoad = problem.assign(g);
  let load = priorLoad;
  let z = objective(g, load);
  const iterations: OdmeIteration[] = [{ iteration: 0, objective: z, stepLength: 0, halvings: 0, meanAbsGeh: meanGeh(load), assignmentGap: load.gap ?? null, accepted: true }];
  let converged = false, stopReason = `stopped after ${opts.maxIterations} iterations (limit)`;
  const L = load.linkFlow.length;

  for (let it = 1; it <= opts.maxIterations; it++) {
    // Residual per counted link (the busiest link of each group carries the count)
    const r = new Float64Array(L);
    const counted = counts.map(c => modelledAt(c, load.linkFlow));
    counts.forEach((c, k) => { const e = w[k] * (counted[k].value - c.observed); for (const li of counted[k].links) r[li] += e; });
    // Gradient per cell
    const grad = new Float64Array(n);
    for (let i = 0; i < n; i++) {
      if (g[i] <= 0) continue;
      let s = 0;
      for (const p of load.odPaths[i] ?? []) { let pr = 0; for (const li of p.links) pr += r[li]; s += p.share * pr; }
      if (mu > 0 && prior[i] > 0) s += mu * (g[i] - prior[i]) / prior[i];
      grad[i] = s;
    }
    // Direction d_i = −g_i ∂Z/∂g_i, zero where a bound blocks it
    const d = new Float64Array(n);
    for (let i = 0; i < n; i++) {
      if (g[i] <= 0 || grad[i] === 0) continue;
      const f = g[i] / prior[i];
      if (grad[i] < 0 && f >= hi - 1e-12) continue;
      if (grad[i] > 0 && f <= lo + 1e-12) continue;
      d[i] = -g[i] * grad[i];
    }
    // Derivative of each count's modelled flow along d (proportions fixed)
    const vp = new Float64Array(L);
    for (let i = 0; i < n; i++) {
      if (d[i] === 0) continue;
      for (const p of load.odPaths[i] ?? []) for (const li of p.links) vp[li] += d[i] * p.share;
    }
    let num = 0, den = 0;
    counts.forEach((c, k) => { let mp = 0; for (const li of counted[k].links) mp += vp[li]; num += w[k] * mp * (c.observed - counted[k].value); den += w[k] * mp * mp; });
    if (mu > 0) for (let i = 0; i < n; i++) if (d[i] !== 0 && prior[i] > 0) { num -= mu * d[i] * (g[i] - prior[i]) / prior[i]; den += mu * d[i] * d[i] / prior[i]; }
    if (!(den > 0) || !(num > 0)) { converged = true; stopReason = 'no descent direction left (gradient zero on every free cell)'; break; }
    let lambda = num / den;
    // Positivity: λ ∂Z/∂g_i < 1 on every moving cell (Spiess)
    let gmax = 0;
    for (let i = 0; i < n; i++) if (d[i] !== 0 && grad[i] > gmax) gmax = grad[i];
    if (gmax > 0) lambda = Math.min(lambda, 0.99 / gmax);
    let halvings = 0, next: Float64Array, nextLoad: OdmeLoad, nz: number;
    for (;;) {
      next = new Float64Array(n);
      for (let i = 0; i < n; i++) {
        if (g[i] <= 0) continue;
        let v = g[i] * (1 - lambda * grad[i] * (d[i] !== 0 ? 1 : 0));
        if (opts.cellFactorBounds) v = Math.min(hi * prior[i], Math.max(lo * prior[i], v));
        next[i] = v;
      }
      nextLoad = problem.assign(next);
      nz = objective(next, nextLoad);
      if (nz <= z || halvings >= 4) break;
      lambda /= 2; halvings++;
    }
    if (nz > z) { iterations.push({ iteration: it, objective: nz, stepLength: lambda, halvings, meanAbsGeh: meanGeh(nextLoad), assignmentGap: nextLoad.gap ?? null, accepted: false }); converged = true; stopReason = 'no step reduced the objective after re-assignment (kept the previous matrix)'; break; }
    const drop = z > 0 ? (z - nz) / z : 0;
    g = next; load = nextLoad; z = nz;
    iterations.push({ iteration: it, objective: z, stepLength: lambda, halvings, meanAbsGeh: meanGeh(load), assignmentGap: load.gap ?? null, accepted: true });
    if (drop < opts.tolerance) { converged = true; stopReason = `objective fell by less than ${opts.tolerance * 100}% in an iteration`; break; }
  }
  const factors = new Float64Array(n);
  let boundedCells = 0;
  for (let i = 0; i < n; i++) {
    factors[i] = prior[i] > 0 ? g[i] / prior[i] : 1;
    if (opts.cellFactorBounds && prior[i] > 0 && (factors[i] <= lo + 1e-9 || factors[i] >= hi - 1e-9)) boundedCells++;
  }
  const fit = counts.map(c => {
    const before = modelledAt(c, priorLoad.linkFlow).value, after = modelledAt(c, load.linkFlow).value;
    return { id: c.id, datasetId: c.datasetId, observed: c.observed, before, after, gehBefore: gehOf(before, c.observed), gehAfter: gehOf(after, c.observed) };
  });
  return { matrix: g, factors, fit, iterations, converged, stopReason, boundedCells, load, priorLoad, options: opts };
}

// ── TAG M3.1 Table 5: significance of matrix change ─────────────────────────

/** TAG M3.1 (DfT, May 2026) Table 5 limits; https://assets.publishing.service.gov.uk/media/6a033d074fb0713aa63ea802/tag-m3-1-highway-assignment-modelling.pdf (as recorded in docs/RESEARCH_AND_TECHNICAL_DECISIONS.md A2). */
export interface ChangeStat { name: string; value: number | null; limit: string; within: boolean | null; note?: string }

export interface OdCellInfo { origin: string; destination: string; originSector: string; destinationSector: string; lengthM: number }

export function regression(x: ArrayLike<number>, y: ArrayLike<number>) {
  const n = x.length;
  let sx = 0, sy = 0;
  for (let i = 0; i < n; i++) { sx += x[i]; sy += y[i]; }
  const mx = sx / n, my = sy / n;
  let sxx = 0, sxy = 0, syy = 0;
  for (let i = 0; i < n; i++) { const dx = x[i] - mx, dy = y[i] - my; sxx += dx * dx; sxy += dx * dy; syy += dy * dy; }
  const slope = sxx > 0 ? sxy / sxx : NaN;
  const intercept = my - slope * mx;
  const r2 = sxx > 0 && syy > 0 ? (sxy * sxy) / (sxx * syy) : (syy === 0 && sxx > 0 ? 1 : NaN);
  return { slope, intercept, r2, n };
}

const wstats = (vals: number[], wts: ArrayLike<number>) => {
  let sw = 0, s = 0;
  vals.forEach((v, i) => { sw += wts[i]; s += wts[i] * v; });
  const mean = sw > 0 ? s / sw : 0;
  let ss = 0;
  vals.forEach((v, i) => { ss += wts[i] * (v - mean) ** 2; });
  return { mean, sd: sw > 0 ? Math.sqrt(ss / sw) : 0 };
};

/**
 * TAG M3.1 Table 5 statistics of the estimated matrix against the prior: cell values and trip ends
 * (regression of estimated on prior: slope, intercept, R²), trip-length mean and standard deviation
 * (lengths per cell held at their prior-assignment value, so only the matrix change moves them),
 * and sector-to-sector totals. A breach is reported (within = false), never hidden. TAG gives no
 * numeric limit for the intercepts ("near zero"): reported with within = null.
 */
export function matrixChangeStats(prior: ArrayLike<number>, post: ArrayLike<number>, cells: readonly OdCellInfo[]): ChangeStat[] {
  const out: ChangeStat[] = [];
  const idx: number[] = [];
  for (let i = 0; i < prior.length; i++) if (prior[i] > 0 || post[i] > 0) idx.push(i);
  const cx = idx.map(i => prior[i]), cy = idx.map(i => post[i]);
  const cr = regression(cx, cy);
  out.push({ name: 'Cell values: slope (estimated on prior)', value: cr.slope, limit: '0.98 – 1.02', within: cr.slope >= 0.98 && cr.slope <= 1.02 });
  out.push({ name: 'Cell values: intercept', value: cr.intercept, limit: 'near zero (no numeric limit in TAG)', within: null });
  out.push({ name: 'Cell values: R²', value: cr.r2, limit: '> 0.95', within: cr.r2 > 0.95 });
  const ends = (pick: (c: OdCellInfo) => string) => {
    const m = new Map<string, [number, number]>();
    idx.forEach(i => { const k = pick(cells[i]); const e = m.get(k) ?? m.set(k, [0, 0]).get(k)!; e[0] += prior[i]; e[1] += post[i]; });
    return [...m.values()];
  };
  const te = [...ends(c => 'o:' + c.origin), ...ends(c => 'd:' + c.destination)];
  const tr = regression(te.map(e => e[0]), te.map(e => e[1]));
  out.push({ name: 'Trip ends: slope', value: tr.slope, limit: '0.99 – 1.01', within: tr.slope >= 0.99 && tr.slope <= 1.01 });
  out.push({ name: 'Trip ends: intercept', value: tr.intercept, limit: 'near zero (no numeric limit in TAG)', within: null });
  out.push({ name: 'Trip ends: R²', value: tr.r2, limit: '> 0.98', within: tr.r2 > 0.98 });
  const lens = idx.map(i => cells[i].lengthM);
  const a = wstats(lens, cx), b = wstats(lens, cy);
  const pct = (x: number, y: number) => (x > 0 ? 100 * (y - x) / x : 0);
  const dm = pct(a.mean, b.mean), ds = pct(a.sd, b.sd);
  out.push({ name: 'Trip length: change in mean', value: dm, limit: 'within ±5%', within: Math.abs(dm) <= 5, note: `${(a.mean / 1000).toFixed(2)} → ${(b.mean / 1000).toFixed(2)} km` });
  out.push({ name: 'Trip length: change in standard deviation', value: ds, limit: 'within ±5%', within: Math.abs(ds) <= 5, note: `${(a.sd / 1000).toFixed(2)} → ${(b.sd / 1000).toFixed(2)} km` });
  const sec = ends(c => `${c.originSector}>${c.destinationSector}`);
  const worst = sec.reduce((m, [x, y]) => Math.max(m, x > 0 ? Math.abs(pct(x, y)) : (y > 0 ? Infinity : 0)), 0);
  out.push({ name: 'Sector to sector: largest change', value: worst, limit: 'within ±5%', within: worst <= 5, note: `${sec.length} sector pairs` });
  return out;
}

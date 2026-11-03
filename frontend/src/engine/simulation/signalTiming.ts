/**
 * Fixed-time signal design: Webster's optimum cycle and green split, with
 * Indo-HCM width-based saturation flow and L = 2n + R lost times.
 *
 * Sources (all opened and checked, see docs/CALIBRATION.md):
 *  - Webster, F. V. (1958) Traffic Signal Settings, Road Research Technical
 *    Paper 39: optimum cycle C0 = (1.5 L + 5) / (1 - Y), effective green split
 *    in proportion to the critical flow ratios, g_i = (C0 - L) y_i / Y.
 *    Worked example used in the tests: APSEd, "Traffic Signal Design |
 *    Webster's Formula for Optimum Cycle Length" (q = 400, 250 veh/h,
 *    s = 1250, 1000 veh/h, L = 16 s -> C0 = 67.44 s),
 *    https://www.apsed.in/post/traffic-signal-design-webster-s-formula-for-optimum-cycle-length
 *  - Total lost time L = 2n + R (2 s per phase, R = all-red time per cycle),
 *    the form used in Indian Webster designs, e.g. Nikhil et al., IJERA 9(4)
 *    2019 pp. 23-28 (Gandimaisamma intersection, Hyderabad; opened and checked:
 *    pp. 25 and 27), https://www.ijera.com/papers/vol9no4/Series-2/D0904022328.pdf.
 *    Note: IRC:93-1985 itself (Appendix 3, p. 37 of the scanned copy at
 *    law.resource.org) does not state 2n + R; its worked example takes the
 *    lost time as the amber time per cycle plus a 4 s first-vehicle reaction
 *    time per phase. The 2 s per phase used here is therefore the IJERA /
 *    textbook value, not an IRC:93 figure (see docs/CALIBRATION.md).
 *  - Effective green g = G + amber - start-up lost time (T. V. Mathew, IIT
 *    Bombay, "Design Principles of Traffic Signal", NPTEL, eq. 4),
 *    https://www.civil.iitb.ac.in/tvm/nptel/571_TrSignal.pdf
 *  - Indo-HCM 2017 (CSIR-CRRI) unit base saturation flow, PCU/h per metre of
 *    approach width: 630 for w < 7 m, 1140 - 60 w for 7 <= w <= 10.5 m, 500
 *    for w > 10.5 m; saturation flow = w x USF0 (as quoted in Indo-HCM worked
 *    applications, e.g. IJAEM 2(1) 2020 pp. 271-278).
 *
 * The cap on the cycle and the minimum green are modelling choices, not taken
 * from a code: Webster's formula is not valid as Y approaches 1, so an
 * oversaturated junction gets MAX_CYCLE_S with greens still in proportion to
 * its flow ratios, and is reported as oversaturated.
 */

/** Start-up lost time per phase (s): L = 2n + R as in IJERA 9(4) 2019 (not an IRC:93 figure; see header). */
export const STARTUP_LOST_S = 2;
export const MAX_CYCLE_S = 150;
export const MIN_CYCLE_S = 40;
export const MIN_GREEN_S = 7;
/** Webster's formula is used up to this sum of critical flow ratios. */
export const MAX_FLOW_RATIO_SUM = 0.9;

/** Indo-HCM 2017 unit base saturation flow (PCU/h per metre of approach width). */
export function indoHcmUnitSaturationFlow(widthM: number): number {
  if (widthM < 7) return 630;
  if (widthM <= 10.5) return 1140 - 60 * widthM;
  return 500;
}

/** Base saturation flow of an approach of the given width (PCU/h). */
export const indoHcmSaturationFlow = (widthM: number) => widthM * indoHcmUnitSaturationFlow(widthM);

export interface PhaseDemand {
  /** Critical flow of the phase (PCU/h, or veh/h when saturation flow is in veh/h). */
  flow: number;
  /** Saturation flow of that critical stream, same unit. */
  saturationFlow: number;
}

export interface WebsterOptions {
  amberS: number;
  allRedS: number;
  /** Lost time per phase: 2 s start-up (L = 2n + R) plus the all-red. */
  startupLostS?: number;
  maxCycleS?: number;
  minCycleS?: number;
  minGreenS?: number;
}

export interface WebsterResult {
  /** Cycle actually used (s): Webster's C0 rounded to a whole second, within [minCycleS, maxCycleS]. */
  cycleS: number;
  /** Webster's C0 before bounds (Infinity when Y >= 1). */
  optimumCycleS: number;
  /** Total lost time per cycle, L = n (start-up lost time + all-red). */
  lostTimeS: number;
  /** Sum of critical flow ratios. */
  flowRatioSum: number;
  flowRatios: number[];
  /** Effective green per phase (s). */
  effectiveGreensS: number[];
  /** Displayed green per phase (s): effective green - amber + start-up lost time. */
  greensS: number[];
  /** Y above MAX_FLOW_RATIO_SUM: the cycle is capped and the junction cannot serve its demand. */
  oversaturated: boolean;
}

/** Webster's optimum cycle (Webster 1958): C0 = (1.5 L + 5) / (1 - Y). */
export function websterOptimumCycle(lostTimeS: number, flowRatioSum: number): number {
  return flowRatioSum >= 1 ? Infinity : (1.5 * lostTimeS + 5) / (1 - flowRatioSum);
}

/**
 * Cycle and greens for a fixed-time plan whose phases follow each other with
 * amber and all-red after each green. The displayed cycle equals the sum of
 * green + amber + all-red over the phases.
 */
export function websterTiming(phases: readonly PhaseDemand[], o: WebsterOptions): WebsterResult {
  const n = phases.length;
  const l = o.startupLostS ?? STARTUP_LOST_S;
  const maxC = o.maxCycleS ?? MAX_CYCLE_S, minC = o.minCycleS ?? MIN_CYCLE_S, minG = o.minGreenS ?? MIN_GREEN_S;
  const lostTimeS = n * (l + o.allRedS);
  const flowRatios = phases.map(p => (p.saturationFlow > 0 ? Math.max(0, p.flow) / p.saturationFlow : 0));
  const Y = flowRatios.reduce((a, b) => a + b, 0);
  const optimumCycleS = websterOptimumCycle(lostTimeS, Y);
  const oversaturated = Y > MAX_FLOW_RATIO_SUM;
  let cycleS = oversaturated ? maxC : Math.round(Math.min(maxC, Math.max(minC, optimumCycleS)));
  // Displayed greens from effective greens; G = g - amber + l
  const shares = Y > 0 ? flowRatios.map(y => y / Y) : flowRatios.map(() => 1 / n);
  const split = (c: number) => shares.map(s => (c - lostTimeS) * s);
  let effectiveGreensS = split(cycleS);
  let greensS = effectiveGreensS.map(g => g - o.amberS + l);
  // A phase below the minimum green gets the minimum; the cycle grows to fit
  if (greensS.some(g => g < minG)) {
    greensS = greensS.map(g => Math.max(minG, g));
    cycleS = Math.round(greensS.reduce((a, g) => a + g + o.amberS + o.allRedS, 0));
    effectiveGreensS = greensS.map(g => g + o.amberS - l);
  }
  // Rounding: the displayed cycle is exactly the sum of its phases
  const sum = greensS.reduce((a, g) => a + g + o.amberS + o.allRedS, 0);
  if (Math.abs(sum - cycleS) > 1e-9) greensS = greensS.map(g => g + (cycleS - sum) / n);
  return { cycleS, optimumCycleS, lostTimeS, flowRatioSum: Y, flowRatios, effectiveGreensS, greensS, oversaturated };
}

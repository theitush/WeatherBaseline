// confidence — turns a forecast row's own 9-quantile band (services/ci.ts: 7
// CQR-calibrated heads + q0.25/q0.75 interpolated) into the confidence figure for
// the top card's bottom line: the "~C% chance this day will be <predicate>"
// statement. The probability is a real CQR exceedance probability: given the
// historical rarity threshold a verdict tier is claiming (e.g. "under 10%
// hottest"), we ask how likely the settled value is to actually land on the
// correct side of it, using the row's own predictive distribution rather than
// just its point estimate.
import type { MetricBand, MetricKey } from '../types';
import type { UnitSystem } from './units';
import { convert } from './units';

/** A point on a predictive CDF: cumulative probability -> value. */
interface QuantilePoint {
  p: number;
  v: number;
}

// Below 1mm a day counts as 0mm — the SAME trace clamp the archive (tieredData)
// and the debias base (services/ci.ts) apply. Without it a forecast's sub-trace
// band tail (e.g. q95 = 0.12mm) reads as "measurable rain" and knocks a bone-dry
// day off "super average", even though the climatology it's compared against has
// every such value clamped to 0.
const PRECIP_TRACE_MM = 1;

/** The row's own 9-point predictive CDF, in display units, ascending by v
 *  (guaranteed monotonic by the debias generator's isotonic pinning, which runs
 *  over all nine trained heads). The two shoulder points sit where the density is
 *  highest, so they sharpen probInInterval's piecewise-linear integration through
 *  the bulk — and as of the q9 retrain they are trained, not interpolated.
 *  Precip quantiles are trace-clamped (<1mm -> 0) to match the archive/base scale. */
export function bandQuantilePoints(
  band: MetricBand,
  metric: MetricKey,
  system: UnitSystem
): QuantilePoint[] {
  const trace = metric === 'precipitation_sum';
  const cv = (x: number) =>
    convert(trace && x < PRECIP_TRACE_MM ? 0 : x, metric, system);
  return [
    { p: 0.01, v: cv(band.q01) },
    { p: 0.05, v: cv(band.lo) },
    { p: 0.1, v: cv(band.q10) },
    { p: 0.25, v: cv(band.q25) },
    { p: 0.5, v: cv(band.mid) },
    { p: 0.75, v: cv(band.q75) },
    { p: 0.9, v: cv(band.q90) },
    { p: 0.95, v: cv(band.hi) },
    { p: 0.99, v: cv(band.q99) },
  ];
}

const clamp01 = (x: number): number => Math.max(0, Math.min(1, x));

/**
 * Probability mass of the predictive distribution whose value falls in [lo, hi]
 * (lo/hi may be ±Infinity). This is the honest primitive for every confidence
 * question — it never divides by a zero-width climatology bracket and it handles
 * POINT MASSES correctly, which a naive `CDF(hi) - CDF(lo)` does not: a
 * dry-season forecast whose q0.01…q0.90 are all 0mm is a real ~90% spike at 0,
 * and integrating each inter-quantile segment's probability weight captures that
 * (a flat segment contributes its full weight iff its value is inside [lo,hi]).
 * The outer <p01 / >p99 tails are attributed to the end quantiles so a forecast
 * fully enclosed by [lo,hi] integrates to ~1.0 rather than 0.98.
 *
 * On a NON-degenerate band this returns exactly what `CDF(hi) - CDF(lo)` did, so
 * the one-sided tail tiers are numerically unchanged; it only rescues the cases
 * the old subtraction broke (dry/tight climatologies).
 */
export function probInInterval(
  points: QuantilePoint[],
  lo: number,
  hi: number
): number {
  const n = points.length;
  const first = points[0];
  const last = points[n - 1];
  let total = 0;
  if (lo <= first.v && first.v <= hi) total += first.p; // mass below p01
  if (lo <= last.v && last.v <= hi) total += 1 - last.p; // mass above p99
  for (let i = 0; i < n - 1; i++) {
    const a = points[i];
    const b = points[i + 1];
    const dp = b.p - a.p;
    if (b.v === a.v) {
      if (lo <= a.v && a.v <= hi) total += dp; // point mass at a.v
    } else {
      const loC = Math.min(Math.max(lo, a.v), b.v);
      const hiC = Math.min(Math.max(hi, a.v), b.v);
      total += dp * ((hiC - loC) / (b.v - a.v));
    }
  }
  return clamp01(total);
}

/** P(actual stays on the claimed side of a one-sided threshold). */
export function probabilityOneSided(
  points: QuantilePoint[],
  threshold: number,
  isHighSide: boolean
): number {
  return isHighSide
    ? probInInterval(points, threshold, Infinity)
    : probInInterval(points, -Infinity, threshold);
}

/** P(actual stays between two bounds — the "mild"/normal two-sided bracket). */
export function probabilityBetween(
  points: QuantilePoint[],
  lo: number,
  hi: number
): number {
  return probInInterval(points, lo, hi);
}

/**
 * The value at a tail-fraction boundary within a historical pool
 * (order-statistic; an approximation, not required to match rankValue()'s
 * exact tie-handling — this only sets where the CQR probability check gets
 * evaluated).
 */
export function valueAtTailFraction(
  values: number[],
  q: number,
  isHighSide: boolean
): number {
  const sorted = [...values].sort((a, b) => a - b);
  const n = sorted.length;
  const idx = isHighSide
    ? Math.max(0, Math.min(n - 1, Math.floor((1 - q) * n)))
    : Math.max(0, Math.min(n - 1, Math.ceil(q * n) - 1));
  return sorted[idx];
}

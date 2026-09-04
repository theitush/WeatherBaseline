// "Are these two periods actually different?" — a year-shuffle test for a split
// compare chart.
//
// The chart draws an early and a late half of the same cell's record. This
// answers whether the split it drew is unusual, by asking a question anyone can
// read: of all the ways to deal these years into two piles, how often does a
// random deal look this different?
//
// Three numbers come out, because "different" means two things:
//
//   signed gap      late − early, averaged over the weeks. "Is it warmer?"
//   absolute gap    |late − early|, averaged. "Did the year's shape change?" —
//                   a half-warmer/half-cooler year cancels to nothing in the
//                   signed number and shows up here.
//   percentile      where the late median falls in the early period's spread,
//                   averaged over weeks. 50 means nothing changed. Unit-free,
//                   so temperature, wind and precipitation all read alike.
//
// The resampling unit is a WHOLE YEAR, as in utils/permutationTest.ts: days
// within a year are nowhere near independent, so shuffling days would understate
// the spread and hand back optimistically small p-values.
//
// Note the test aggregates by CALENDAR WEEK rather than inheriting the chart's
// day-of-year smoothing. A week is about the length of a weather system, and —
// more importantly — the same aggregation is applied to the observation and to
// every shuffle, so the null is never smoother or rougher than what it is being
// compared against. It also keeps the p-value independent of a display control.
import type { MetricKey } from '../utils/config';
import type { WeatherDataPoint } from '../types';
import { mulberry32 } from '../utils/permutationTest.ts';
import { dayOfYear } from './compareStats.ts';

/** Calendar weeks in the year. The last one absorbs the leftover day or two. */
const WEEKS = 52;

const weekOfYear = (d: Date): number => Math.min(WEEKS - 1, Math.floor(dayOfYear(d) / 7));

/**
 * The per-week summary the two periods are compared on. Precipitation uses its
 * wet tail because its median is usually 0 and would report "no change" for two
 * periods with quite different rainfall — the same substitution
 * utils/permutationTest.ts makes for the histogram's significance test.
 */
export type PeriodStatistic = 'median' | 'p90';

export const statisticFor = (metric: MetricKey): PeriodStatistic =>
  metric === 'precipitation_sum' ? 'p90' : 'median';

/**
 * The observations a test runs on, flattened into parallel typed arrays: one
 * entry per archive day, already converted into the units the chart shows.
 *
 * This shape exists so the whole payload can be handed to a worker by transfer
 * rather than by structured-cloning seventeen thousand row objects.
 */
export interface PeriodSamples {
  /** Calendar year of each observation. */
  years: Int32Array;
  /** Week of the year, 0–51. */
  weeks: Uint8Array;
  /** Value in display units. */
  values: Float64Array;
}

/**
 * Flatten the archive rows a chart is drawing into `PeriodSamples`, keeping the
 * days inside [minYear, maxYear] that have a finite value for `metric`.
 */
export function extractSamples(
  rows: WeatherDataPoint[],
  metric: MetricKey,
  minYear: number,
  maxYear: number,
  toDisplay: (raw: number) => number
): PeriodSamples {
  const years: number[] = [];
  const weeks: number[] = [];
  const values: number[] = [];
  for (const d of rows) {
    const raw = d[metric];
    if (raw === undefined || !Number.isFinite(raw)) continue;
    const yr = d.date.getFullYear();
    if (yr < minYear || yr > maxYear) continue;
    years.push(yr);
    weeks.push(weekOfYear(d.date));
    values.push(toDisplay(raw));
  }
  return {
    years: Int32Array.from(years),
    weeks: Uint8Array.from(weeks),
    values: Float64Array.from(values),
  };
}

export interface PeriodTestOptions {
  /** Shuffles to run. Default 2000 — enough to resolve a p down to ~0.0005. */
  nPerm?: number;
  /** RNG seed, so a given chart always reports the same p. Default 42. */
  seed?: number;
}

export interface PeriodTest {
  statistic: PeriodStatistic;
  /** Weeks with data in BOTH periods — the ones the averages are over. */
  nWeeks: number;
  nEarlyYears: number;
  nLateYears: number;
  /** Mean of (late − early) over those weeks, in display units. */
  signedGap: number;
  /** Mean of |late − early| — the average width of the shaded ribbon. */
  absGap: number;
  /** Mean position of the late summary within the early spread, 0–100. */
  percentile: number;
  /** Two-sided: how often a random deal moved this far in EITHER direction. */
  pSigned: number;
  /** One-sided: how often a random deal differed by this much at all. */
  pAbs: number;
  /** Shuffles that moved at least as far as the observed signed gap. The
   *  p-values add one to these (and to nPerm) so a p is never exactly zero, but
   *  the raw counts are what reads plainly: "3 of 2000 random splits". */
  countSigned: number;
  /** Shuffles whose ribbon was at least as wide as the observed one. */
  countAbs: number;
  /** Mean |gap| across the shuffles — what "no change" actually looks like. */
  nullAbsGap: number;
  nPerm: number;
}

/** One week's values across every year, sorted, with each value's owning year. */
interface WeekBlock {
  /** Ascending values. */
  values: Float64Array;
  /** Index into the year list for each entry of `values`. */
  owner: Int32Array;
  /** How many values each year contributes to this week. */
  countByYear: Int32Array;
}

/**
 * Type-7 quantile (d3's convention, and utils/permutationTest.ts's) from the
 * two order statistics that straddle the target position.
 */
const interp = (lo: number, hi: number, frac: number) => lo + (hi - lo) * frac;

/**
 * Both groups' summary for one week, in a single pass over the week's sorted
 * values. Walking the pooled order statistics and skipping the entries whose
 * year is in the other group is what keeps 2000 shuffles cheap: no re-pooling
 * and no re-sorting per shuffle.
 *
 * Returns [earlyStat, lateStat], or NaN for a group with no values this week.
 */
function weekStats(
  block: WeekBlock,
  isEarly: Uint8Array,
  q: number
): [number, number] {
  let nEarly = 0;
  for (let y = 0; y < isEarly.length; y++) {
    if (isEarly[y]) nEarly += block.countByYear[y];
  }
  const nLate = block.values.length - nEarly;
  if (nEarly === 0 || nLate === 0) return [NaN, NaN];

  // Target positions on each group's own order statistics.
  const hE = (nEarly - 1) * q;
  const hL = (nLate - 1) * q;
  const kE = Math.floor(hE);
  const kL = Math.floor(hL);

  let seenE = 0;
  let seenL = 0;
  let eLo = NaN;
  let eHi = NaN;
  let lLo = NaN;
  let lHi = NaN;
  for (let i = 0; i < block.values.length; i++) {
    const v = block.values[i];
    if (isEarly[block.owner[i]]) {
      if (seenE === kE) eLo = v;
      if (seenE === kE + 1) eHi = v;
      seenE++;
    } else {
      if (seenL === kL) lLo = v;
      if (seenL === kL + 1) lHi = v;
      seenL++;
    }
    if (seenE > kE + 1 && seenL > kL + 1) break;
  }
  // The top order statistic has no successor; at q=1 (or n=1) lo IS the answer.
  return [
    interp(eLo, Number.isNaN(eHi) ? eLo : eHi, hE - kE),
    interp(lLo, Number.isNaN(lHi) ? lLo : lHi, hL - kL),
  ];
}

/** Where `value` sits in this week's early-group values, 0–100. Ties count half
 *  — the archive is quantised to 0.25 K before 2024, so ties are everywhere. */
function percentileOf(block: WeekBlock, isEarly: Uint8Array, value: number): number {
  let below = 0;
  let ties = 0;
  let n = 0;
  for (let i = 0; i < block.values.length; i++) {
    if (!isEarly[block.owner[i]]) continue;
    n++;
    const v = block.values[i];
    if (v < value) below++;
    else if (v === value) ties++;
  }
  if (n === 0) return NaN;
  return ((below + ties / 2) / n) * 100;
}

/**
 * Run the shuffle test for one split chart. `early` and `late` are inclusive
 * year bounds, and `samples` is already in display units, so the gaps come back
 * in the units the reader sees.
 *
 * Returns null when there is not enough to test: fewer than two years on either
 * side, or fewer than eight weeks covered by both.
 */
export function periodShuffleTest(
  samples: PeriodSamples,
  early: { startYear: number; endYear: number },
  late: { startYear: number; endYear: number },
  statistic: PeriodStatistic,
  options: PeriodTestOptions = {}
): PeriodTest | null {
  const nPerm = options.nPerm ?? 2000;
  const rng = mulberry32(options.seed ?? 42);
  const q = statistic === 'p90' ? 0.9 : 0.5;

  // ---- bucket every usable day into (week, year) --------------------------
  const yearIndex = new Map<number, number>();
  const years: number[] = [];
  const buckets: number[][][] = Array.from({ length: WEEKS }, () => []);
  let nEarlyYears = 0;

  for (let i = 0; i < samples.values.length; i++) {
    const yr = samples.years[i];
    const inEarly = yr >= early.startYear && yr <= early.endYear;
    const inLate = yr >= late.startYear && yr <= late.endYear;
    if (!inEarly && !inLate) continue;

    let yi = yearIndex.get(yr);
    if (yi === undefined) {
      yi = years.length;
      yearIndex.set(yr, yi);
      years.push(yr);
      for (const w of buckets) w.push([]);
      if (inEarly) nEarlyYears++;
    }
    buckets[samples.weeks[i]][yi].push(samples.values[i]);
  }

  const nYears = years.length;
  const nLateYears = nYears - nEarlyYears;
  if (nEarlyYears < 2 || nLateYears < 2) return null;

  // The real split: the years up to early.endYear are the early pile.
  const observedEarly = new Uint8Array(nYears);
  for (let i = 0; i < nYears; i++) {
    observedEarly[i] = years[i] <= early.endYear ? 1 : 0;
  }

  // ---- one sorted block per week, tagged with each value's year -----------
  const blocks: WeekBlock[] = [];
  for (let w = 0; w < WEEKS; w++) {
    const flat: { v: number; y: number }[] = [];
    const countByYear = new Int32Array(nYears);
    for (let y = 0; y < nYears; y++) {
      for (const v of buckets[w][y]) {
        flat.push({ v, y });
        countByYear[y]++;
      }
    }
    if (flat.length === 0) {
      blocks.push({
        values: new Float64Array(0),
        owner: new Int32Array(0),
        countByYear,
      });
      continue;
    }
    flat.sort((a, b) => a.v - b.v);
    const values = new Float64Array(flat.length);
    const owner = new Int32Array(flat.length);
    for (let i = 0; i < flat.length; i++) {
      values[i] = flat[i].v;
      owner[i] = flat[i].y;
    }
    blocks.push({ values, owner, countByYear });
  }

  // Only weeks covered by BOTH piles of the real split can be compared.
  const usable = blocks.filter((b) => {
    const [e, l] = weekStats(b, observedEarly, q);
    return Number.isFinite(e) && Number.isFinite(l);
  });
  if (usable.length < 8) return null;

  // ---- the observed split -------------------------------------------------
  const gaps = (isEarly: Uint8Array): { signed: number; abs: number } => {
    let sum = 0;
    let sumAbs = 0;
    let n = 0;
    for (const b of usable) {
      const [e, l] = weekStats(b, isEarly, q);
      if (!Number.isFinite(e) || !Number.isFinite(l)) continue;
      sum += l - e;
      sumAbs += Math.abs(l - e);
      n++;
    }
    return n === 0
      ? { signed: NaN, abs: NaN }
      : { signed: sum / n, abs: sumAbs / n };
  };

  const observed = gaps(observedEarly);
  if (!Number.isFinite(observed.signed)) return null;

  let pctSum = 0;
  let pctN = 0;
  for (const b of usable) {
    const [, l] = weekStats(b, observedEarly, q);
    const pct = percentileOf(b, observedEarly, l);
    if (Number.isFinite(pct)) {
      pctSum += pct;
      pctN++;
    }
  }

  // ---- the shuffles -------------------------------------------------------
  // Deal the years at random into piles the size of the real split, always
  // calling the early-sized pile "early" so every surrogate has the same shape
  // as the observation.
  const order = Array.from({ length: nYears }, (_, i) => i);
  const permEarly = new Uint8Array(nYears);
  let countSigned = 0;
  let countAbs = 0;
  let nullAbsSum = 0;

  for (let p = 0; p < nPerm; p++) {
    for (let i = nYears - 1; i > 0; i--) {
      const j = Math.floor(rng() * (i + 1));
      const tmp = order[i];
      order[i] = order[j];
      order[j] = tmp;
    }
    permEarly.fill(0);
    for (let i = 0; i < nEarlyYears; i++) permEarly[order[i]] = 1;

    const g = gaps(permEarly);
    if (!Number.isFinite(g.signed)) continue;
    nullAbsSum += g.abs;
    // Signed is two-sided — a shuffle that cooled as hard as this one warmed is
    // just as extreme. Absolute is one-sided by construction: |gap| is never
    // negative, so "more extreme" can only mean "wider".
    if (Math.abs(g.signed) >= Math.abs(observed.signed) - 1e-12) countSigned++;
    if (g.abs >= observed.abs - 1e-12) countAbs++;
  }

  return {
    statistic,
    nWeeks: usable.length,
    nEarlyYears,
    nLateYears,
    signedGap: observed.signed,
    absGap: observed.abs,
    percentile: pctN > 0 ? pctSum / pctN : NaN,
    pSigned: (countSigned + 1) / (nPerm + 1),
    pAbs: (countAbs + 1) / (nPerm + 1),
    countSigned,
    countAbs,
    nullAbsGap: nullAbsSum / nPerm,
    nPerm,
  };
}

// forecastReference — THE one place that decides, for a forecast target day, which
// verdict tier fires and which CLIMATOLOGY reference value the UI shows in place of
// the raw forecast median.
//
// On a forecast row the top card, the main-chart target marker, and the histogram
// line/brackets all stop showing the forecast's own median and instead show the
// historical value the verdict is pinned to — "the bar the forecast has to clear":
//   • tail tiers  -> the climatology threshold the one-sided test checks against
//                    (hot day p95/p90/p80, cold day p05/p10/p20, all-time top-10
//                    its own tiny cutoff).
//   • off-centre mild (p20–40 / p60–80) -> the MIDDLE of that band: p30 / p70.
//   • dead-centre mild (p40–60)         -> the historical MEDIAN (p50).
// The verdict PROSE and the CQR confidence stay computed from the forecast itself
// (its snapped median + own 9-quantile band) — only the displayed value becomes a
// climatology anchor, so the number the card headlines is the reference the words
// claim, not a point forecast we can't stand behind.
//
// The tier decision is rank-based and therefore UNIT-AGNOSTIC (a monotone °C→°F
// conversion can't change a rank), so this runs entirely on native-unit pools and
// every consumer converts the returned value for its own display. Keeping the
// ladder here — rather than inline in TemperatureContext — is what lets the card
// and the two charts never disagree about which tier fired.
import * as d3 from 'd3';
import type { WeatherDataPoint } from '../types';
import type { MetricKey } from './config';
import { comparablePool, getCurrentDateData, rankValue } from './dataProcessor.ts';
import { valueAtTailFraction } from './confidence.ts';

export type ForecastTier =
  | 'alltime' // top-10 across the WHOLE record
  | 'top5' // top-5 within the ±window, HISTORICAL rows only (rank-based ordinal)
  | 'extreme' // single-tail ≤ 5%
  | 'mid' // single-tail ≤ 10% (forecast/bucketed rows only)
  | 'notable' // single-tail ≤ 20%
  | 'mildOff' // middle 60% but off-centre (p20–40 / p60–80)
  | 'mildDead'; // dead-centre (p40–60)

export interface ForecastMarker {
  tier: ForecastTier;
  isHighSide: boolean;
  singleTail: number; // fraction of the window on today's tail (inclusive)
  rank: number; // 1-based rank on today's side within the ±window
  allTimeRank: number; // rank across the whole record; 0 = N/A
  /** Cutoff the CONFIDENCE test evaluates at (NOT always where `value` sits). */
  tierCutoff: number;
  tierTwoSided: boolean; // dead-centre integrates a two-sided band
  tierUsesAllTime: boolean; // confidence + threshold pool is the all-time record
  /** Native-unit climatology reference value the UI shows for this tier. */
  value: number;
}

/** Finite native-unit values for one metric over the comparable pool. */
export function metricPool(
  rows: WeatherDataPoint[],
  cutoffDate: string,
  metric: MetricKey
): number[] {
  return comparablePool(rows, cutoffDate)
    .map((d) => d[metric])
    .filter((v): v is number => typeof v === 'number' && Number.isFinite(v));
}

/**
 * Resolve the verdict tier + its climatology reference value for a value sitting
 * in a ±window pool. `bucketed` = a forecast band is present (unlocks the 10% mid
 * tier and forecast-style wording). Returns null on an empty pool.
 *
 * MUST stay in lock-step with TemperatureContext's prose ladder — the card reads
 * `tier` off this result to pick its sentence, so a divergence here would let the
 * words and the headline number claim different tiers.
 */
export function resolveForecastMarker(
  estValue: number,
  windowNative: number[],
  allTimeNative: number[],
  bucketed: boolean
): ForecastMarker | null {
  const n = windowNative.length;
  if (n === 0) return null;

  const wr = rankValue(estValue, windowNative, 'auto');
  const isHighSide = wr.isHighSide;
  const singleTail = wr.singleTail;
  const rank = isHighSide ? wr.rankHigh : wr.rankLow;

  let allTimeRank = 0;
  if (allTimeNative.length > 0) {
    const at = rankValue(estValue, allTimeNative, isHighSide ? 'high' : 'low');
    allTimeRank = isHighSide ? at.rankHigh : at.rankLow;
  }

  let tier: ForecastTier;
  let tierCutoff = 0.2;
  let tierTwoSided = false;
  let tierUsesAllTime = false;

  if (allTimeRank >= 1 && allTimeRank <= 10) {
    tier = 'alltime';
    tierCutoff = 10 / Math.max(1, allTimeNative.length);
    tierUsesAllTime = true;
  } else if (!bucketed && rank <= 5) {
    // Rank-based ordinal ("the 3rd hottest day") — HISTORICAL rows only. A forecast
    // is a point estimate, so an exact ordinal would overclaim; forecast rows skip
    // this and fall to the quantile tiers below (extreme = median past the 5%
    // cutoff, etc.). Cutoff is unused here (no confidence on historical rows).
    tier = 'top5';
    tierCutoff = Math.min(0.5, 5 / Math.max(1, n));
  } else if (singleTail <= 0.05) {
    tier = 'extreme';
    tierCutoff = 0.05;
  } else if (bucketed && singleTail <= 0.1) {
    tier = 'mid';
    tierCutoff = 0.1;
  } else if (singleTail <= 0.2) {
    tier = 'notable';
    tierCutoff = 0.2;
  } else {
    // Middle 60% (p20–80). rankLow/n is where today sits in the pack (0..1).
    // The confidence for BOTH mild sub-tiers is the forecast's chance of landing
    // in the normal middle — a two-sided [p20, p80] band — so they share one
    // cutoff. Only the displayed value + flavour wording differ (dead-centre pins
    // to the median, off-centre to p30/p70).
    const pctile = wr.rankLow / n;
    tier = pctile >= 0.4 && pctile <= 0.6 ? 'mildDead' : 'mildOff';
    tierCutoff = 0.2; // two-sided [p20, p80] — the middle 60%
    tierTwoSided = true;
  }

  // The displayed value. Tail tiers show the threshold their test checks against;
  // off-centre mild shows the MIDDLE of its band (p30/p70 — cutoff 0.30 on today's
  // side); dead-centre shows the historical median.
  const thresholdPool = tierUsesAllTime ? allTimeNative : windowNative;
  let value: number;
  if (tier === 'mildDead') {
    value = d3.median(windowNative) ?? estValue;
  } else if (tier === 'mildOff') {
    value = valueAtTailFraction(windowNative, 0.3, isHighSide);
  } else {
    value = valueAtTailFraction(thresholdPool, tierCutoff, isHighSide);
  }

  return {
    tier,
    isHighSide,
    singleTail,
    rank,
    allTimeRank,
    tierCutoff,
    tierTwoSided,
    tierUsesAllTime,
    value,
  };
}

/**
 * Native-unit reference value for the current target day, or null when it isn't a
 * forecast/model row (no band) — in which case consumers keep the raw value. A thin
 * wrapper over resolveForecastMarker for the chart components, which don't run the
 * prose ladder themselves.
 */
export function forecastRefValue(
  filteredData: WeatherDataPoint[],
  yearTimeline: WeatherDataPoint[],
  currentDate: string,
  metric: MetricKey
): number | null {
  const targetRow = getCurrentDateData(filteredData, currentDate)[0];
  const band = targetRow?.band?.[metric];
  if (!band) return null;
  const marker = resolveForecastMarker(
    band.mid,
    metricPool(filteredData, currentDate, metric),
    metricPool(yearTimeline, currentDate, metric),
    true
  );
  return marker?.value ?? null;
}

// verdictProse — THE prose ladder. One pure function turns "a value, its pool,
// and (on a forecast row) its predictive band" into the two sentences the page
// headlines: the big VERDICT and the RARITY line under it.
//
// Two sections ask the same question of different pools and therefore MUST share
// this ladder, or their wording drifts apart:
//   • the top card (components/TemperatureContext) — "is this unusual FOR THE
//     DATE?" — pool = every observed day within ±N days of the target, all years.
//   • the year dial (components/YearRadialChart's heading, in App) — "is this
//     unusual for the PLACE, full stop?" — pool = every observed day, all years.
// The caller supplies the pool and how to NAME it (PoolPhrasing); the tier
// decision itself stays in forecastReference.resolveForecastMarker, the same
// resolver the histogram brackets read, so the words and the marks can never
// claim different tiers.
//
// `style` picks the verdict register:
//   • 'surprise'    — the card's playful banks ("WTF.", "Boring.").
//   • 'descriptive' — one fixed phrase per tier. On a WHOLE-YEAR pool the card's
//     surprise words would fire all summer (~18 days a year are top-5% days), so
//     the dial states what the day is instead of reacting to it. An all-time
//     top-10 is rare on any pool, so that tier keeps the card's bank.
// The style also picks how a FORECAST row states itself: the card gives the
// probability ("~C% chance …"); the dial states where the day lands, as a range
// off the band's extreme ends while those stay in the tail ("In the top 3–5%
// hottest days since 1950") and as the median's own place in the pack once they
// don't ("Probably windier than about 70% of days since 1950").
//
// Ranking is unit-agnostic, so the pools come in NATIVE units; only the
// confidence cutoff VALUES are converted for display.
import type { MetricBand, MetricKey } from '../types';
import type { UnitSystem } from './units.ts';
import { convert } from './units.ts';
import { rankValue } from './dataProcessor.ts';
import { resolveForecastMarker, type ForecastTier } from './forecastReference.ts';
import {
  bandQuantilePoints,
  probabilityOneSided,
  probabilityBetween,
  traceClamp,
  valueAtTailFraction,
} from './confidence.ts';

// "st"/"nd"/"rd"/"th" for an ordinal — the historical top-5 rank line and the
// card's date labels all share it.
export const ordinalSuffix = (n: number): string =>
  n % 10 === 1 && n !== 11 ? 'st' :
  n % 10 === 2 && n !== 12 ? 'nd' :
  n % 10 === 3 && n !== 13 ? 'rd' : 'th';

// Direction words for the single-tailed "this hot/hotter" line, per metric.
// [adjective, comparative, superlative] for the high side and the low side.
const METRIC_DIRECTION: Record<
  MetricKey,
  { high: [string, string, string]; low: [string, string, string] }
> = {
  max_temperature: { high: ['hot', 'hotter', 'hottest'], low: ['cold', 'colder', 'coldest'] },
  min_temperature: { high: ['hot', 'hotter', 'hottest'], low: ['cold', 'colder', 'coldest'] },
  precipitation_sum: { high: ['wet', 'wetter', 'wettest'], low: ['dry', 'drier', 'driest'] },
  wind_speed_10m_max: { high: ['windy', 'windier', 'windiest'], low: ['calm', 'calmer', 'calmest'] },
};

// Comparative used in the mild "a bit ___ than most" line, per metric & side.
const METRIC_COMPARATIVE: Record<MetricKey, { high: string; low: string }> = {
  max_temperature: { high: 'warmer', low: 'colder' },
  min_temperature: { high: 'warmer', low: 'colder' },
  precipitation_sum: { high: 'wetter', low: 'drier' },
  wind_speed_10m_max: { high: 'windier', low: 'calmer' },
};

// Softeners for the mild "a ___ ___ than most" line.
const MILD_HEDGE = ['bit', 'tad', 'touch', 'smidge', 'hair'];

// Dead-center (40–60%) bottom line — no direction is meaningful, so just
// lampoon the averageness. The top verdict still draws from VERDICT_MILD.
const DEAD_CENTER_LINE = [
  'Uniquely unique',
  'Averagely average',
  'Remarkably unremarkable',
  'Distinctly indistinct',
  'Textbook nothing',
];

// Verdict banks answering "How extreme is this weather?" — random per render.
// #1-on-record gets the exclusive "Record-breaker!" (handled separately).
const VERDICT_TOP5 = ['Crazy!!!', 'Off the charts!', 'One for the history books!', 'Legend.'];
// Reserved for a top-1/2/3 value across the WHOLE record (not just its ±N-day
// window) — the rarest thing the page can show, so the lines go big.
const VERDICT_ALLTIME = ['Practically unheard of!', 'A page in the record books.', 'Legendary!']; //top/bottom 5 historical measurements
const VERDICT_VERY_EXTREME = ['WTF.', 'Unreal.', 'Insane.', 'Holy smokes.']; // top/bottom 5% + 80% confidence or top/bottom 3% for historical
const VERDICT_PROB_VERY_EXTREME = ['Uncommon.', 'Rare.', 'Remarkable.']; // top/bottom 5%
const VERDICT_EXTREME = ['Quite unusual.', 'Remarkable.', 'Pretty wild.', 'Pretty rare.']; //top/bottom 10%
const VERDICT_NOTABLE = ['Notable.', 'Almost exciting.', 'A bit unusual.', 'Mildly interesting.']; // top/bottom 20%
const VERDICT_MILD = ['Very average.', 'Totally normal.', 'Boring.', 'Meh.']; // mid 60%

// Deterministic pick — same (bank, seed) always yields the same phrase, so a
// verdict stays put across the several re-renders a metric/date switch triggers
// instead of re-rolling 2-3 times before settling. The seed is derived from the
// inputs that define the day (metric + value + rank), so it still varies between
// days and metrics.
const hashSeed = (s: string): number => {
  let h = 2166136261;
  for (let i = 0; i < s.length; i++) {
    h ^= s.charCodeAt(i);
    h = Math.imul(h, 16777619);
  }
  return h >>> 0;
};
const pick = (bank: string[], seed: string) => bank[hashSeed(seed) % bank.length];

const capitalize = (s: string) => s.charAt(0).toUpperCase() + s.slice(1);

/**
 * How the caller's pool is NAMED in a sentence. The card's pool is a seasonal
 * window, the dial's is the whole record:
 *   card:   { quantifier: '',     scope: ' within ±3 days of Aug 30th' }
 *             -> "…of days within ±3 days of Aug 30th were this hot!"
 *   radial: { quantifier: 'all ', scope: ' since 1950' }
 *             -> "…of all days since 1950 were this hot!"
 * The quantifier is deliberate on the whole-year pool: without it "2.4% of days
 * since 1950" reads as "of THESE days".
 */
export interface PoolPhrasing {
  /** Qualifier in front of the plural noun, e.g. '' or 'all '. */
  quantifier: string;
  /** Trailing scope clause, e.g. ' within ±3 days of Aug 30th' or ' since 1950'. */
  scope: string;
}

export type VerdictStyle = 'surprise' | 'descriptive';

export interface VerdictProse {
  /** The big line. */
  verdict: string;
  /** The sentence under it; null only when no tier resolved. */
  rarityLine: string | null;
  tier: ForecastTier;
  /** 1-based rank on the day's side within the pool; drives the card's confetti. */
  rank: number;
  /** Rank across the whole record; 0 = N/A. */
  allTimeRank: number;
  /** Forecast top-5% day we're ≥80% sure clears the cutoff. False on history. */
  isVeryExtremeForecast: boolean;
}

export interface VerdictProseInput {
  /** The value being described, in NATIVE units (band.mid on a forecast row). */
  displayValue: number;
  /**
   * The row's predictive band, or null on settled history. Its presence IS the
   * `bucketed` flag resolveForecastMarker takes — one source of truth, so a
   * caller can't hand in a band and a contradicting flag.
   */
  band: MetricBand | null;
  /** The pool the rarity claim is about, native units, model rows already out. */
  windowNative: number[];
  /** The whole record, native units — the all-time top-10 test runs on it. */
  allTimeNative: number[];
  metric: MetricKey;
  system: UnitSystem;
  pool: PoolPhrasing;
  style: VerdictStyle;
}

// Tail share as a percent, for the dial's band-spread line. Whole numbers at 1%
// and above; one decimal below it, so a near-record end reads "top 0.2%" instead
// of rounding away to "top 0%". Floored at 0.1 — the printed number is a bound,
// and no pool resolves finer than that.
const formatTailPercent = (fraction: number): string => {
  const pct = fraction * 100;
  return pct < 0.95 ? Math.max(0.1, Math.round(pct * 10) / 10).toFixed(1) : String(Math.round(pct));
};

/**
 * Share of the pool a value strictly beats on its own side, as a whole percent.
 * STRICTLY beyond, not at-or-beyond — the same > / < convention the histogram
 * brackets count on. Ties are the whole reason: on a dry record the 0mm days are
 * ~90% of the pool, and an inclusive count would have a 0mm day claim it is
 * "drier than about 100% of all days". The strict count says what is actually
 * true — it is drier than the 10% that are wetter. On continuous temperature the
 * two differ by one day. Settled mild days and forecast rows past the tail both
 * read their number off this, so the two word the pack identically.
 */
const packShare = (value: number, poolNative: number[], isHighSide: boolean): number => {
  const n = Math.max(1, poolNative.length);
  const ranks = rankValue(value, poolNative, isHighSide ? 'high' : 'low');
  const beyond = poolNative.length - (isHighSide ? ranks.rankHigh : ranks.rankLow);
  return Math.round((beyond / n) * 100);
};

interface BandTailInput {
  band: MetricBand;
  metric: MetricKey;
  /** The pool the sentence names, NATIVE units. */
  poolNative: number[];
  isHighSide: boolean;
  /** 'hottest' — the superlative for this metric and side. */
  sup: string;
  /** 'days since 1950' — the pool, unquantified, for the top-N% form. */
  tierDays: string;
}

/**
 * The DIAL's forecast claim while the band stays in the tail: where each extreme
 * end of the row's band — q05/q95, `lo`/`hi` — lands in the historical pool,
 * "In the top 3–5% hottest days since 1950". Same claim the card's "~C% chance"
 * line makes, said as a percentile RANGE instead of integrated into one
 * probability. q05/q95 is a 90% range, the same two ends the dial fills as a
 * shaded ring (see YearRadialChart), so the sentence and the ring can't describe
 * different forecasts.
 *
 * Returns null once the far end reaches past the median — "the top 47% hottest
 * days" is a laboured way to say "above average", and a band wide enough to span
 * "dry" to "soaking" has no tail left to name. The caller states the median's own
 * place in the pack instead ("Probably wetter than about 70% of days since
 * 1950"), which is also what every mild tier gets: with both lines then read off
 * the median, the verdict above can't claim a direction the sentence walks back.
 * The ring keeps showing the spread either way.
 */
function bandTailPredicate(input: BandTailInput): string | null {
  const { band, metric, poolNative, isHighSide, sup, tierDays } = input;
  const n = Math.max(1, poolNative.length);
  // The band's extreme ends (q05/q95), native units, trace-clamped so a sub-trace
  // precip tail isn't counted as rain the archive's climatology never records.
  const ends = [traceClamp(band.lo, metric), traceClamp(band.hi, metric)];
  // Share of the pool at-or-beyond each end, counted on the day's own side. The
  // more extreme end has the smaller share, whichever side that is.
  const tails = ends.map((v) => {
    const r = rankValue(v, poolNative, isHighSide ? 'high' : 'low');
    return (isHighSide ? r.rankHigh : r.rankLow) / n;
  });
  // An end past every day on record ranks 0; floor it at the rarest slot the
  // pool can actually resolve (1/n), so the bound never claims more than #1 is.
  const near = Math.max(Math.min(...tails), 1 / n);
  const far = Math.max(...tails);

  if (far > 0.5) return null;
  const a = formatTailPercent(near);
  const b = formatTailPercent(far);
  // Sentence-initial: the dial's forecast lines are fragments, not clauses.
  return a === b
    ? `In the top ${a}% ${sup} ${tierDays}`
    : `In the top ${a}–${b}% ${sup} ${tierDays}`;
}

/**
 * Resolve the verdict + rarity sentence for one value against one pool.
 * Returns null on an empty pool (no tier, so nothing to say).
 *
 * HISTORICAL rows tier by rank/rarity on the value's side:
 *   - all-time top-10: "One of the hottest days EVER recorded!!!" (scope, no %)
 *   - top-5 in-pool:   the exact ordinal → "The 3rd hottest day within ±3 …"
 *       (rank is real on settled data; #1 drops the ordinal + gets Record-breaker!)
 *   - extreme  (≤5%):  single-tailed %, named direction  → "Only 2.4% … this hot!"
 *   - notable  (≤20%): single-tailed %, cumulative       → "About 10% … this hot or hotter."
 *   - mild     (>20%): two-sided flavour line            → "A tad warmer than most …"
 *
 * FORECAST/recent-model rows (`band` present) NEVER show a rank/ordinal — a point
 * estimate can't stand behind one. They resolve on the quantile tiers only
 * (all-time, extreme=5%, a bucketed-only mid=10%, notable=20%, mild), and the whole
 * rarity line restates the tier as one plain-English sentence about the band:
 *   • 'surprise' (the card) — the CONFIDENCE: "There's a ~C% chance this day will
 *     be <predicate>", where C is a real CQR exceedance probability from the row's
 *     own 9-quantile band against the historical threshold VALUE the tier claims
 *     (see utils/confidence).
 *   • 'descriptive' (the dial) — WHERE it lands, as a fragment: "In the top 3–5%
 *     hottest days since 1950", read off the band's extreme q05/q95 ends
 *     (bandTailPredicate) — the same claim, stated as spread rather than as a
 *     probability, because the dial draws that spread as a ring. Once those ends
 *     reach past the median there is no tail to name, so the line states the
 *     median's own place in the pack instead: "Probably warmer than about 63% of
 *     days since 1950" — the settled mild wording, one "Probably" in front.
 * Either way: no verdict prefix, no (Pr>…) suffix.
 */
export function resolveVerdictProse(input: VerdictProseInput): VerdictProse | null {
  const { displayValue, band, windowNative, allTimeNative, metric, system, pool, style } = input;

  const bucketed = !!band;
  const marker = resolveForecastMarker(displayValue, windowNative, allTimeNative, bucketed);
  if (!marker) return null;

  const { tier, isHighSide, singleTail } = marker;
  const rank = marker.rank;
  const allTimeRank = marker.allTimeRank;
  const n = windowNative.length;

  // Min temp is always the overnight low, so describe the pool as nights.
  const noun = metric === 'min_temperature' ? 'night' : 'day';
  const nounP = noun + 's';
  // "days within ±3 days of Aug 30th" / "all days since 1950". The quantifier is
  // dropped in the singular ("The 3rd hottest day since 1950") and in the
  // top-N% predicates, which already quantify ("the top 5% hottest days …").
  const manyDays = `${pool.quantifier}${nounP}${pool.scope}`;
  const oneDay = `${noun}${pool.scope}`;
  const tierDays = `${nounP}${pool.scope}`;

  // Display-unit copies of those SAME pools — only the confidence cutoff VALUES
  // (valueAtTailFraction) below need display units; the tier decision above is
  // rank-based and unit-agnostic. tierPool tracks the tier's own pool.
  const values = windowNative.map((v) => convert(v, metric, system));
  const allVals = allTimeNative.map((v) => convert(v, metric, system));
  const tierPool = marker.tierUsesAllTime ? allVals : values;
  const tierCutoff = marker.tierCutoff;
  const tierTwoSided = marker.tierTwoSided;
  const dir = METRIC_DIRECTION[metric];
  const [adj, comp, sup] = isHighSide ? dir.high : dir.low;
  const cmp = METRIC_COMPARATIVE[metric];
  const mildWord = isHighSide ? cmp.high : cmp.low;
  // Stable per-day seed so the verdict phrase doesn't re-roll on re-render.
  const seed = `${metric}:${displayValue}:${rank}`;
  const descriptive = style === 'descriptive';

  let rarityLine: string | null = null;
  let verdict = '';

  // The predicate after "…this day will be ___" in the forecast bottom line
  // (e.g. "in the top 10% hottest days within ±3 days of Jul 12th"). Every
  // forecast tier sets it (all-time included); it stays null only on the
  // historical-only top-5 tier, whose ordinal line has no forecast form. The
  // TIER is resolveForecastMarker's call now (shared with the histogram); this
  // switch only picks the wording + verdict bank for whichever tier fired.
  let forecastPredicate: string | null = null;

  if (tier === 'alltime') {
    // Among the rarest the page shows: a top-10 value across the WHOLE record.
    // We deliberately DON'T name the exact slot — ERA5-Land on a 0.1° grid
    // can't credibly resolve #1 vs #2 vs … #10; those gaps sit inside the noise.
    // Historical rows keep this punchy scope line. Forecast rows swap it for the
    // shared "~C% chance … one of the hottest ever" line below — that number is a
    // forecast CONFIDENCE (chance the settled value clears the all-time top-10
    // cutoff), NOT a climatology share, so the old "different denominator / it's
    // just summer" objection to a % here doesn't apply. Both styles keep this
    // bank: a top-10 day is rare on ANY pool, so the big words still land.
    rarityLine = `One of the ${sup} ${nounP} EVER recorded!!!`;
    verdict = pick(VERDICT_ALLTIME, seed);
    forecastPredicate = `one of the ${sup} ${nounP} ever recorded`;
  } else if (tier === 'top5') {
    // Top-5 within its pool — HISTORICAL rows only (resolveForecastMarker gates
    // this tier on !bucketed). We name the exact ordinal because on settled data
    // the rank is real; a forecast is a point estimate that would overclaim an
    // ordinal, so forecast rows never reach here — they fall to the quantile
    // tiers (extreme = median past the 5% cutoff). #1 drops the clumsy "1st".
    // On a whole-record pool this tier is unreachable (rank ≤ 5 there is already
    // an all-time top-10), so only the card's bank ever shows.
    const ord = rank === 1 ? '' : `${rank}${ordinalSuffix(rank)} `;
    rarityLine = `The ${ord}${sup} ${oneDay}.`;
    // #1 gets the exclusive phrase; #2–#5 the party bank.
    verdict = descriptive
      ? `Among the ${sup} ${nounP}`
      : rank === 1 ? 'Record-breaker!' : pick(VERDICT_TOP5, seed);
  } else if (tier === 'extreme') {
    if (bucketed) {
      rarityLine = `Under 5% of ${manyDays} were this ${adj}!`;
    } else {
      // one decimal, floored so a record never prints "0.0%".
      const pct = singleTail * 100;
      const shown = pct < 0.1 ? '<0.1' : pct.toFixed(1);
      rarityLine = `Only ${shown}% of ${manyDays} were this ${adj}!`;
    }
    // Top-5% tier — the strongest tail short of a record. The verdict word is
    // graded by how SURE we are it's really that extreme. HISTORICAL rows (no
    // band, no confidence) grade on tail depth: top/bottom 3% earns the strong
    // bank, 3–5% the hedged one. FORECAST rows get re-graded in the confidence
    // block below once the CQR probability p is known (≥80% → strong, else
    // hedged). Note: 'extreme' no longer uses VERDICT_EXTREME — that bank moved
    // down to the 5–10% 'mid' tier.
    verdict = descriptive
      ? `Among the ${sup} ${nounP}`
      : singleTail <= 0.03
        ? pick(VERDICT_VERY_EXTREME, seed)
        : pick(VERDICT_PROB_VERY_EXTREME, seed);
    forecastPredicate = `in the top 5% ${sup} ${tierDays}`;
  } else if (tier === 'mid') {
    // Mid-tier, forecast/recent-model rows only — splits the old 5%→20% gap so
    // "under 10%" reads distinctly from "under 20%".
    rarityLine = `Under 10% of ${manyDays} were this ${adj}!`;
    verdict = descriptive ? `A ${adj} ${noun} by any standard` : pick(VERDICT_EXTREME, seed);
    forecastPredicate = `in the top 10% ${sup} ${tierDays}`;
  } else if (tier === 'notable') {
    // Notable — cumulative ("or hotter"). Drop the comparative when nothing
    // can be more extreme (a 0mm day can't be "drier").
    const atFloor = displayValue === 0 && !isHighSide;
    if (bucketed) {
      rarityLine = atFloor
        ? `About under 20% of ${manyDays} were this ${adj}.`
        : `About under 20% of ${manyDays} were this ${adj} or ${comp}.`;
    } else {
      const pct = singleTail * 100;
      rarityLine = atFloor
        ? `About ${pct.toFixed(0)}% of ${manyDays} were this ${adj}.`
        : `About ${pct.toFixed(0)}% of ${manyDays} were this ${adj} or ${comp}.`;
    }
    verdict = descriptive ? `${capitalize(comp)} than most` : pick(VERDICT_NOTABLE, seed);
    forecastPredicate = `in the top 20% ${sup} ${tierDays}`;
  } else {
    // Mild — the middle 60% (p20–p80). resolveForecastMarker split it into
    // 'mildDead' (dead-centre p40–60) vs 'mildOff' (off-centre); both are graded
    // against the same two-sided [p20,p80] band (marker.tierTwoSided), differing
    // only in flavour wording.
    if (descriptive) {
      // On a whole-year pool the playful lines say nothing useful — where in the
      // pack the day sits does. Counted on the day's own side (a warm day is
      // "warmer than X%", a cold one "colder than X%") and strictly beyond, see
      // packShare. A forecast row states the same number the same way, one
      // "Probably" in front of it.
      const share = packShare(displayValue, windowNative, isHighSide);
      rarityLine = `${capitalize(mildWord)} than about ${share}% of ${manyDays}.`;
      verdict = tier === 'mildDead'
        ? `A typical ${noun}`
        : `A shade ${mildWord} than the typical ${noun}`;
    } else if (tier === 'mildDead') {
      const deadPhrase = pick(DEAD_CENTER_LINE, seed);
      rarityLine = `${deadPhrase} for ${manyDays}.`;
      verdict = pick(VERDICT_MILD, seed);
    } else {
      const hedge = pick(MILD_HEDGE, seed);
      rarityLine = `A ${hedge} ${mildWord} than most ${manyDays}.`;
      verdict = pick(VERDICT_MILD, seed);
    }
    // Forecast form states the tier plainly against the same [p20, p80] band
    // the confidence is graded on and the histogram brackets: "…this day will
    // be within the middle 60% of days…". (The playful/percentile lines above
    // are the historical wording; the flavour split doesn't carry over.)
    forecastPredicate = `within the middle 60% of ${manyDays}`;
  }

  // Confidence qualifier — forecast/recent-model rows only (same `band`
  // gating the old ± readout used). A real CQR exceedance probability:
  // given the historical threshold VALUE this tier is claiming (e.g. the
  // value beyond which a day counts as "under 10%"), how likely is the
  // row's OWN predictive distribution to still land on the correct side
  // of it. Skipped on a too-small pool — not enough signal.
  let isVeryExtremeForecast = false;
  if (band && n >= 5) {
    const points = bandQuantilePoints(band, metric, system);
    // Two-sided (dead-center mild) integrates the forecast mass inside the
    // claimed band [p40,p60]; every other tier — the tails AND off-center
    // mild — integrates the mass on one side of a single cutoff. Same
    // primitive (probInInterval) so a degenerate/tight climatology can't
    // zero it out.
    const loT = valueAtTailFraction(tierPool, tierCutoff, false);
    const hiT = valueAtTailFraction(tierPool, tierCutoff, true);
    const oneT = valueAtTailFraction(tierPool, tierCutoff, isHighSide);
    const p = tierTwoSided
      ? probabilityBetween(points, loT, hiT)
      : probabilityOneSided(points, oneT, isHighSide);
    // Top-5% forecast: confidence-grade the verdict word. ≥80% sure the settled
    // value clears the 5% cutoff earns the strong "very-extreme" bank (and the
    // card's confetti burst); 50–80% (and the rare <50% floor) the hedged
    // "probably-very-extreme" bank. The descriptive style has one phrase per
    // tier, so it softens the same phrase instead of switching banks.
    if (tier === 'extreme') {
      isVeryExtremeForecast = p >= 0.8;
      if (descriptive) {
        verdict = isVeryExtremeForecast
          ? `Among the ${sup} ${nounP}`
          : `Probably among the ${sup} ${nounP}`;
      } else {
        verdict = isVeryExtremeForecast
          ? pick(VERDICT_VERY_EXTREME, seed)
          : pick(VERDICT_PROB_VERY_EXTREME, seed);
      }
    }
    // Degenerate middle band — p20 == p80 (a bone-dry precip window where nearly
    // every comparable day is 0mm). "…within the middle 60%…" is meaningless when
    // the band is a single point, so restate it against the majority the day
    // actually resembles: "…like 99% of days…". The share is COMPUTED (never
    // hardcoded) on the SAME pool the histogram's dry bracket counts — the
    // observed climatology days, model rows excluded — so the card number and
    // the bracket always agree.
    const degenerateBand = tierTwoSided && Math.abs(hiT - loT) < 1e-6;
    let degenerateShare = 0;
    if (degenerateBand) {
      const atValue = values.filter((v) => v <= loT + 1e-9).length;
      degenerateShare = Math.round((atValue / Math.max(1, values.length)) * 100);
      forecastPredicate = `like ${degenerateShare}% of ${manyDays}`;
    }
    // p drives the bottom line: on any tier with a predicate that whole line
    // becomes the plain-English statement of p — "~C% chance this day will be
    // <predicate>" — since p IS exactly the chance the forecast falls in the
    // region the predicate claims. Round to the nearest 5% (cap at 95, never
    // "~100%") — the "~" already says approximate, and a wide forecast band
    // can't support a to-the-point figure.
    if (forecastPredicate !== null) {
      if (descriptive) {
        // The dial says WHERE the forecast lands, not how sure we are it lands
        // there: the reader is looking at the band ring, so the sentence reads
        // it off (bandTailPredicate). The card (style 'surprise') keeps the
        // chance line below: its pool is one date's window, where a probability
        // is the sharper thing to say.
        if (degenerateBand) {
          // Climatology collapsed to a point (a bone-dry record): there is no
          // range to quote, so the line names the majority the day JOINS. Said
          // as its own short fragment — the card's predicate is written to hang
          // off "there's a ~C% chance that…", and asserting it flat ("this day
          // will be like 86% of all days") reads as a claim about the day
          // rather than about the climate. The verdict loses its direction to
          // match: with 86% of the record tied at 0mm, "a shade drier than the
          // typical day" claims a gap that isn't there — the day IS the typical
          // day, and the only thing worth saying is which kind.
          rarityLine = `Like ${degenerateShare}% of ${tierDays}.`;
          verdict = `A typical ${adj} ${noun}`;
        } else {
          // A mild tier has no tail to name; otherwise ask the band whether its
          // far end is still inside one. Either way the line is a fragment —
          // "This day will be …" in front of every one of them was words, not
          // meaning, and the section already says it is looking at a forecast.
          const mildTier = tier === 'mildDead' || tier === 'mildOff';
          const tail = mildTier
            ? null
            : bandTailPredicate({ band, metric, poolNative: windowNative, isHighSide, sup, tierDays });
          rarityLine = tail
            ? `${tail}.`
            : `Probably ${mildWord} than about ${packShare(displayValue, windowNative, isHighSide)}% of ${tierDays}.`;
        }
      } else {
        const chance = Math.min(95, Math.round(p * 20) * 5);
        rarityLine = `There's a ~${chance}% chance that this ${noun} will be ${forecastPredicate}.`;
      }
    }
  }

  return { verdict, rarityLine, tier, rank, allTimeRank, isVeryExtremeForecast };
}

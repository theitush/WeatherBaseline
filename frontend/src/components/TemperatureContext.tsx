import React, { useEffect } from 'react';
import type { TemperatureContext as TempContext, WeatherDataPoint, MetricKey, MetricBand } from '../types';
import { useUnits } from '../hooks/useUnits';
import { convert, unitLabel, unitLabelBare, valueDecimals } from '../utils/units';
import { comparablePool, findRecords } from '../utils/dataProcessor';
import { resolveForecastMarker } from '../utils/forecastReference';
import {
  bandQuantilePoints,
  probabilityOneSided,
  probabilityBetween,
  valueAtTailFraction,
} from '../utils/confidence';
import CONFIG from '../utils/config';
import './TemperatureContext.css';

interface TemperatureContextProps {
  context: TempContext | null;
  currentTemp: number | null;
  // Bias-corrected 90% band for the headline day/metric (forecast rows only;
  // null on settled history or when the local CI server is off).
  band?: MetricBand | null;
  filteredData: WeatherDataPoint[];
  // Full daily record (every day, all years) for the cell — used to test whether
  // today is a top-1/2/3 value across the ENTIRE record, not just its ±N-day window.
  yearTimeline: WeatherDataPoint[];
  currentMetric: MetricKey;
  currentDate: string;
  cityName: string;
}

const BIN_COUNT = 10;

// Metric phrase for the lead line — mirrors the metric buttons.
const METRIC_LEAD_LABEL: Record<MetricKey, string> = {
  max_temperature: 'max temperature',
  min_temperature: 'min temperature',
  precipitation_sum: 'precipitation',
  wind_speed_10m_max: 'wind speed',
};

// Gradient stops: record-low blue -> white -> record-high red (matches the bar exactly)
const GRADIENT_LOW_RGB = [47, 111, 184];    // #2f6fb8
const GRADIENT_MID_RGB = [255, 255, 255];   // #ffffff
const GRADIENT_HIGH_RGB = [192, 57, 43];    // #c0392b

const interpolateGradient = (t: number): string => {
  const clamped = Math.max(0, Math.min(1, t));
  const [a, b, local] = clamped <= 0.5
    ? [GRADIENT_LOW_RGB, GRADIENT_MID_RGB, clamped / 0.5]
    : [GRADIENT_MID_RGB, GRADIENT_HIGH_RGB, (clamped - 0.5) / 0.5];
  const r = Math.round(a[0] + (b[0] - a[0]) * local);
  const g = Math.round(a[1] + (b[1] - a[1]) * local);
  const bl = Math.round(a[2] + (b[2] - a[2]) * local);
  return `rgb(${r}, ${g}, ${bl})`;
};

const formatDate = (d: Date): string => {
  const months = ['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun',
    'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec'];
  return `${months[d.getMonth()]} ${d.getDate()}, ${d.getFullYear()}`;
};

// "st"/"nd"/"rd"/"th" for an ordinal — the historical top-5 rank line and the
// date labels all share it.
const ordinalSuffix = (n: number): string =>
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
const VERDICT_ALLTIME = ['Practically unheard of!', 'A page in the record books.', 'Legendary!'];
const VERDICT_EXTREME = ['Quite unusual.', 'Remarkable.', 'Pretty wild.', 'Pretty rare.'];
const VERDICT_NOTABLE = ['Notable.', 'Almost exciting.', 'A bit unusual.', 'Mildly interesting.'];
const VERDICT_MILD = ['Very average.', 'Totally normal.', 'Boring.', 'Meh.'];

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


// Lightweight confetti burst — no dependency. Fires once when called.
// `multiplier` scales the piece count: 1 for an in-window top-3, 5 for an
// all-time top-1/2/3 — the rarest event the page shows.
const fireConfetti = (multiplier = 1) => {
  if (typeof document === 'undefined') return;
  const colors = ['#c0392b', '#2f6fb8', '#e6b800', '#2e8b57', '#8e44ad'];
  const root = document.createElement('div');
  root.style.cssText =
    'position:fixed;inset:0;pointer-events:none;z-index:9999;overflow:hidden';
  document.body.appendChild(root);
  const N = 180 * multiplier;
  for (let i = 0; i < N; i++) {
    const p = document.createElement('div');
    const size = 6 + Math.random() * 6;
    const left = Math.random() * 100;
    const delay = Math.random() * 0.25;
    const dur = 1.8 + Math.random() * 1.4;
    const rot = Math.random() * 360;
    p.style.cssText = [
      'position:absolute',
      `left:${left}vw`,
      'top:-20px',
      `width:${size}px`,
      `height:${size * 0.6}px`,
      `background:${colors[i % colors.length]}`,
      `transform:rotate(${rot}deg)`,
      `animation:confetti-fall ${dur}s linear ${delay}s forwards`,
      'border-radius:1px',
    ].join(';');
    root.appendChild(p);
  }
  window.setTimeout(() => root.remove(), 3600);
};

const TemperatureContextDisplay: React.FC<TemperatureContextProps> = ({
  context,
  currentTemp,
  band,
  filteredData,
  yearTimeline,
  currentMetric,
  currentDate,
  cityName,
}) => {
  const { system } = useUnits();

  // currentTemp can legitimately be 0 (a dry day reads 0mm); only bail on true absence.
  if (!context || currentTemp === null || currentTemp === undefined) {
    return null;
  }

  const unit = unitLabelBare(currentMetric, system);
  // The headline value: on a forecast day with a model band we show the
  // bias-corrected best estimate (q0.50) so the band sits honestly around the
  // number; settled history has no band and is shown as-is.
  const displayTemp = band ? band.mid : currentTemp;
  // fmt takes a raw (metric) value, converts it for display, then formats.
  // Temperature degrees read "12.3°"; other metrics read "12.3 mm". Used for the
  // record-low/high end labels.
  const vdp = valueDecimals(currentMetric, system);
  const fmt = (v: number) => {
    const c = convert(v, currentMetric, system);
    return unit === '°' ? `${c.toFixed(vdp)}°` : `${c.toFixed(vdp)} ${unit}`;
  };
  // Bare number (no unit) for the big marker value — the unit is rendered once,
  // as its own element, after the uncertainty deltas.
  const fmtNum = (v: number) => convert(v, currentMetric, system).toFixed(vdp);
  // Full unit incl. C/F (e.g. "°C"/"°F", "mm", "km/h") for that single label.
  const fullUnit = unitLabel(currentMetric, system);

  // Canonical pool: drop forecasts past the target date, keep it/earlier (incl.
  // recent forecast rows). Shared with the histogram AND the chart's record star
  // via comparablePool so the prose rarity, the brackets, and the star all run
  // off the identical days.
  const valid = comparablePool(filteredData, currentDate).filter((d) => {
    const v = d[currentMetric];
    return typeof v === 'number' && Number.isFinite(v);
  });

  // Records via the shared findRecords() — the SAME call the chart star uses, so
  // "the record" is one definition site, not a loop duplicated per component.
  const { hiRow, loRow } = findRecords(valid, currentMetric);
  const recordLow = loRow ? (loRow[currentMetric] as number) : null;
  const recordHigh = hiRow ? (hiRow[currentMetric] as number) : null;
  const recordLowDate = loRow ? loRow.date : null;
  const recordHighDate = hiRow ? hiRow.date : null;

  let binnedPct: number | null = null;
  let markerColor = '#222';
  if (recordLow !== null && recordHigh !== null && recordHigh > recordLow) {
    const raw = (displayTemp - recordLow) / (recordHigh - recordLow);
    const clamped = Math.max(0, Math.min(1, raw));
    const bin = Math.round(clamped * BIN_COUNT);
    const binT = bin / BIN_COUNT;
    binnedPct = binT * 100;
    markerColor = interpolateGradient(binT);
  }

  const hasScale = binnedPct !== null && recordLow !== null && recordHigh !== null;

  // Verdict (bold line) + rarity line, both keyed off how far into the day's own
  // tail it sits. HISTORICAL rows tier by rank/rarity on the value's side:
  //   - all-time top-10: "One of the hottest days EVER recorded!!!" (scope, no %)
  //   - top-5 in-window: the exact ordinal → "The 3rd hottest day within ±3 …"
  //       (rank is real on settled data; #1 drops the ordinal + gets Record-breaker!)
  //   - extreme  (≤5%):  single-tailed %, named direction  → "Only 2.4% … this hot!"
  //   - notable  (≤20%): single-tailed %, cumulative       → "About 10% … this hot or hotter."
  //   - mild     (>20%): two-sided flavour line            → "A tad warmer than most …"
  //
  // FORECAST/recent-model rows (`band` present) NEVER show a rank/ordinal — a point
  // estimate can't stand behind one. They resolve on the quantile tiers only
  // (all-time, extreme=5%, a bucketed-only mid=10%, notable=20%, mild), and the whole
  // rarity line becomes one plain-English confidence statement — "There's a ~C%
  // chance this day will be <predicate>" — where C is a real CQR exceedance
  // probability from the row's own 9-quantile band against the historical threshold
  // VALUE the tier claims (see utils/confidence). No verdict prefix, no (Pr>…) suffix.
  let extremeLine: string | null = null;
  let verdict = context.description;
  let rank = 0; // 1-based rank on the day's side; 0 when undeterminable.
  let allTimeRank = 0; // rank across the ENTIRE record (every day, all years); 0 = N/A.
  {
    // Tier + rarity run off the SAME climatology pool the histogram brackets use:
    // comparablePool at/before the target with FORECAST ROWS EXCLUDED — the target's
    // own forecast row plus recent reanalysis-quality rows. Including them (as this
    // card used to) ranks the value against near-copies of itself and lands it a tier
    // MILDER than the histogram, which excludes them — the "card says top 20% / chart
    // says top 10%" bug. resolveForecastMarker is THE shared tier resolver
    // (utils/forecastReference) the histogram calls too, so the card headline and the
    // bracket can no longer disagree about which tier fired. Ranking is unit-agnostic,
    // so the marker runs on NATIVE pools; display-unit copies below feed only the
    // confidence cutoff VALUES.
    const isForecastRow = (d: WeatherDataPoint) => d.data_type === 'forecast';
    const windowNative = valid
      .filter((d) => !isForecastRow(d))
      .map((d) => d[currentMetric] as number);
    const allTimeNative = comparablePool(yearTimeline, currentDate)
      .filter((d) => !isForecastRow(d))
      .map((d) => d[currentMetric])
      .filter((v): v is number => typeof v === 'number' && Number.isFinite(v));
    const bucketed = !!band;
    const marker = resolveForecastMarker(displayTemp, windowNative, allTimeNative, bucketed);
    if (marker) {
      const { tier, isHighSide, singleTail } = marker;
      rank = marker.rank;
      allTimeRank = marker.allTimeRank;
      const n = windowNative.length;
      // Display-unit copies of those SAME pools — only the confidence cutoff VALUES
      // (valueAtTailFraction) below need display units; the tier decision above is
      // rank-based and unit-agnostic. tierPool tracks the tier's own pool.
      const values = windowNative.map((v) => convert(v, currentMetric, system));
      const allVals = allTimeNative.map((v) => convert(v, currentMetric, system));
      const tierPool = marker.tierUsesAllTime ? allVals : values;
      const tierCutoff = marker.tierCutoff;
      const tierTwoSided = marker.tierTwoSided;
      // Name the actual comparison pool: every day within a ±seasonalWindowDays
      // calendar window of the target date, across all years back to 1950. Spell
      // out the window and date ("within ±N days of June 6th") rather than the
      // vaguer "this time of year".
      const win = CONFIG.chart.seasonalWindowDays;
      const td = new Date(currentDate + 'T12:00:00');
      const shortMonths = ['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun',
        'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec'];
      const tDay = td.getDate();
      const since = ` within ±${win} days of ${shortMonths[td.getMonth()]} ${tDay}${ordinalSuffix(tDay)}`;
      const dir = METRIC_DIRECTION[currentMetric];
      const [adj, comp, sup] = isHighSide ? dir.high : dir.low;
      // Min temp is always the overnight low, so describe the pool as nights.
      const noun = currentMetric === 'min_temperature' ? 'night' : 'day';
      const nounP = noun + 's';
      // Stable per-day seed so the verdict phrase doesn't re-roll on re-render.
      const seed = `${currentMetric}:${displayTemp}:${rank}`;

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
        // just summer" objection to a % here doesn't apply.
        extremeLine = `One of the ${sup} ${nounP} EVER recorded!!!`;
        verdict = pick(VERDICT_ALLTIME, seed);
        forecastPredicate = `one of the ${sup} ${nounP} ever recorded`;
      } else if (tier === 'top5') {
        // Top-5 within its ±window — HISTORICAL rows only (resolveForecastMarker
        // gates this tier on !bucketed). We name the exact ordinal because on settled
        // data the rank is real; a forecast is a point estimate that would overclaim
        // an ordinal, so forecast rows never reach here — they fall to the quantile
        // tiers (extreme = median past the 5% cutoff). #1 drops the clumsy "1st".
        const ord = rank === 1 ? '' : `${rank}${ordinalSuffix(rank)} `;
        extremeLine = `The ${ord}${sup} ${noun}${since}.`;
        // #1 gets the exclusive phrase; #2–#5 the party bank.
        verdict = rank === 1 ? 'Record-breaker!' : pick(VERDICT_TOP5, seed);
      } else if (tier === 'extreme') {
        if (bucketed) {
          extremeLine = `Under 5% of ${nounP}${since} were this ${adj}!`;
        } else {
          // one decimal, floored so a record never prints "0.0%".
          const pct = singleTail * 100;
          const shown = pct < 0.1 ? '<0.1' : pct.toFixed(1);
          extremeLine = `Only ${shown}% of ${nounP}${since} were this ${adj}!`;
        }
        verdict = pick(VERDICT_EXTREME, seed);
        forecastPredicate = `in the top 5% ${sup} ${nounP}${since}`;
      } else if (tier === 'mid') {
        // Mid-tier, forecast/recent-model rows only — splits the old 5%→20% gap so
        // "under 10%" reads distinctly from "under 20%".
        extremeLine = `Under 10% of ${nounP}${since} were this ${adj}!`;
        verdict = pick(VERDICT_EXTREME, seed);
        forecastPredicate = `in the top 10% ${sup} ${nounP}${since}`;
      } else if (tier === 'notable') {
        // Notable — cumulative ("or hotter"). Drop the comparative when nothing
        // can be more extreme (a 0mm day can't be "drier").
        const atFloor = displayTemp === 0 && !isHighSide;
        if (bucketed) {
          extremeLine = atFloor
            ? `About under 20% of ${nounP}${since} were this ${adj}.`
            : `About under 20% of ${nounP}${since} were this ${adj} or ${comp}.`;
        } else {
          const pct = singleTail * 100;
          extremeLine = atFloor
            ? `About ${pct.toFixed(0)}% of ${nounP}${since} were this ${adj}.`
            : `About ${pct.toFixed(0)}% of ${nounP}${since} were this ${adj} or ${comp}.`;
        }
        verdict = pick(VERDICT_NOTABLE, seed);
        forecastPredicate = `in the top 20% ${sup} ${nounP}${since}`;
      } else {
        // Mild — the middle 60% (p20–p80). resolveForecastMarker split it into
        // 'mildDead' (dead-centre p40–60) vs 'mildOff' (off-centre); both are graded
        // against the same two-sided [p20,p80] band (marker.tierTwoSided), differing
        // only in flavour wording.
        if (tier === 'mildDead') {
          const deadPhrase = pick(DEAD_CENTER_LINE, seed);
          extremeLine = `${deadPhrase} for ${nounP}${since}.`;
        } else {
          const cmp = METRIC_COMPARATIVE[currentMetric];
          const word = isHighSide ? cmp.high : cmp.low;
          const hedge = pick(MILD_HEDGE, seed);
          extremeLine = `A ${hedge} ${word} than most ${nounP}${since}.`;
        }
        // Forecast form states the tier plainly against the same [p20, p80] band
        // the confidence is graded on and the histogram brackets: "…this day will
        // be within the middle 60% of days…". (The playful lines above are the
        // historical, non-forecast wording; the flavour split doesn't carry over.)
        forecastPredicate = `within the middle 60% of ${nounP}${since}`;
        verdict = pick(VERDICT_MILD, seed);
      }

      // Confidence qualifier — forecast/recent-model rows only (same `band`
      // gating the old ± readout used). A real CQR exceedance probability:
      // given the historical threshold VALUE this tier is claiming (e.g. the
      // value beyond which a day counts as "under 10%"), how likely is the
      // row's OWN predictive distribution to still land on the correct side
      // of it. Rendered as both a verdict-word prefix and a "(Pr>…%)" suffix on
      // the rarity line. Skipped on a too-small pool — not enough signal.
      if (band && n >= 5) {
        const points = bandQuantilePoints(band, currentMetric, system);
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
        // Degenerate middle band — p20 == p80 (a bone-dry precip window where nearly
        // every comparable day is 0mm). "…within the middle 60%…" is meaningless when
        // the band is a single point, so restate it against the majority the day
        // actually resembles: "…like 99% of days…". The share is COMPUTED (never
        // hardcoded) on the SAME pool the histogram's dry bracket counts — the
        // comparable climatology days with forecast rows excluded — so the card
        // number and the bracket always agree.
        if (tierTwoSided && Math.abs(hiT - loT) < 1e-6) {
          const climatology = valid.filter((d) => d.data_type !== 'forecast');
          const atValue = climatology.filter(
            (d) => convert(d[currentMetric] as number, currentMetric, system) <= loT + 1e-9
          ).length;
          const share = Math.round((atValue / Math.max(1, climatology.length)) * 100);
          forecastPredicate = `like ${share}% of ${nounP}${since}`;
        }
        // p drives the bottom line: on any ±window tier (forecastPredicate set)
        // that whole line becomes the plain-English statement of p — "~C% chance
        // this day will be <predicate>" — since p IS exactly the chance the
        // forecast falls in the region the predicate claims. Only all-time keeps
        // its own line + the coarse (Pr>…%) bucket. (The verdict itself carries no
        // confidence qualifier anymore — the bottom line says it plainly.)
        // forecastPredicate is set on every forecast tier now (all-time included),
        // so the rarity line becomes the plain-English statement of p. Round to the
        // nearest 5% (cap at 95, never "~100%") — the "~" already says approximate,
        // and a wide forecast band can't support a to-the-point figure.
        if (forecastPredicate !== null) {
          const chance = Math.min(95, Math.round(p * 20) * 5);
          extremeLine = `There's a ~${chance}% chance that this ${noun} will be ${forecastPredicate}.`;
        }
      }
    }
  }

  // Confetti for any top day. An in-window top-3 gets the normal burst; an
  // all-time top-10 (rarest on the page) gets a 5× burst. Re-fires when the
  // rank-bearing day changes (new date/metric/location landing near the top).
  const isTop3 = rank >= 1 && rank <= 3;
  const isAllTimeTop10 = allTimeRank >= 1 && allTimeRank <= 10;
  useEffect(() => {
    if (isAllTimeTop10) fireConfetti(5);
    else if (isTop3) fireConfetti(1);
  }, [isTop3, isAllTimeTop10, currentMetric, displayTemp]);

  // Lead line above the punchy verdict: "June 7th in Tel Aviv is".
  const leadDate = (() => {
    const d = new Date(currentDate + 'T12:00:00');
    const months = ['January', 'February', 'March', 'April', 'May', 'June',
      'July', 'August', 'September', 'October', 'November', 'December'];
    const day = d.getDate();
    return `${months[d.getMonth()]} ${day}${ordinalSuffix(day)}, ${d.getFullYear()}`;
  })();
  const city = cityName ? cityName.split(',')[0].trim() : '';
  const metricLabel = METRIC_LEAD_LABEL[currentMetric];
  const leadLine = city
    ? `${leadDate} ${metricLabel} in ${city} is`
    : `${leadDate} ${metricLabel} is`;

  return (
    <div className="temperature-context">
      <p className="context-explain context-lead">{leadLine}</p>
      <div className="context-verdict context-verdict-lead">{verdict}</div>

      {hasScale ? (
        <div className="record-scale" aria-label="Temperature vs records">
          <div className="record-scale-label record-scale-low">
            <span className="record-scale-temp">{fmt(recordLow!)}</span>
            <span className="record-scale-name">record low</span>
            {recordLowDate && (
              <span className="record-scale-date">{formatDate(recordLowDate)}</span>
            )}
          </div>
          <div className="record-scale-track">
            <div className="record-scale-gradient" />
            <div
              className="record-scale-marker"
              style={{ left: `${binnedPct}%` }}
            >
              <div className="record-scale-marker-readout">
                <span
                  className="record-scale-marker-value"
                  style={{ color: markerColor }}
                >
                  {fmtNum(displayTemp)}
                </span>
                <span className="record-scale-marker-ci-unit" style={{ color: markerColor }}>{fullUnit}</span>
              </div>
              <span
                className="record-scale-marker-tick"
                style={{ background: markerColor }}
              />
            </div>
          </div>
          <div className="record-scale-label record-scale-high">
            <span className="record-scale-temp">{fmt(recordHigh!)}</span>
            <span className="record-scale-name">record high</span>
            {recordHighDate && (
              <span className="record-scale-date">{formatDate(recordHighDate)}</span>
            )}
          </div>
        </div>
      ) : (
        <div className="temp-value">{fmt(currentTemp)}</div>
      )}

      <div className="context-answer">
        {extremeLine && <p className="context-explain">{extremeLine}</p>}
      </div>
    </div>
  );
};

export default TemperatureContextDisplay;

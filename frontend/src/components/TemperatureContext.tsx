import React, { useEffect } from 'react';
import type { TemperatureContext as TempContext, WeatherDataPoint, MetricKey } from '../types';
import { useUnits } from '../hooks/useUnits';
import { convert, unitLabelBare, valueDecimals } from '../utils/units';
import { comparablePool, findRecords, rankValue } from '../utils/dataProcessor';
import CONFIG from '../utils/config';
import './TemperatureContext.css';

interface TemperatureContextProps {
  context: TempContext | null;
  currentTemp: number | null;
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

// Dead-center (45–55%) bottom line — no direction is meaningful, so just
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
const VERDICT_TOP3 = ['Wow, crazy!', 'Off the charts!', 'One for the history books!'];
// Reserved for a top-1/2/3 value across the WHOLE record (not just its ±N-day
// window) — the rarest thing the page can show, so the lines go big.
const VERDICT_ALLTIME_1 = ['For the ages.', 'Nothing tops this.', 'The all-time benchmark.', 'History, made.'];
const VERDICT_ALLTIME_23 = ['Practically unheard of.', 'A page in the record books.', 'Almost legendary.', 'Rarefied air.'];
const VERDICT_EXTREME = ['Extreme!', 'Seriously extreme.', 'Pretty wild.'];
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

const ordinal = (n: number): string => {
  const j = n % 10;
  const k = n % 100;
  if (j === 1 && k !== 11) return `${n}st`;
  if (j === 2 && k !== 12) return `${n}nd`;
  if (j === 3 && k !== 13) return `${n}rd`;
  return `${n}th`;
};

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
  // fmt takes a raw (metric) value, converts it for display, then formats.
  // Temperature degrees read "12.3°"; other metrics read "12.3 mm".
  const vdp = valueDecimals(currentMetric, system);
  const fmt = (v: number) => {
    const c = convert(v, currentMetric, system);
    return unit === '°' ? `${c.toFixed(vdp)}°` : `${c.toFixed(vdp)} ${unit}`;
  };

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
    const raw = (currentTemp - recordLow) / (recordHigh - recordLow);
    const clamped = Math.max(0, Math.min(1, raw));
    const bin = Math.round(clamped * BIN_COUNT);
    const binT = bin / BIN_COUNT;
    binnedPct = binT * 100;
    markerColor = interpolateGradient(binT);
  }

  const hasScale = binnedPct !== null && recordLow !== null && recordHigh !== null;

  // Verdict (bold line) + rarity line, both keyed off how far into the day's
  // own tail it sits. Tier by SINGLE-tailed rarity (top/bottom X% on its side):
  //   - top-3 on record: rank line ("Hottest day on record!") + party verdict + confetti
  //   - extreme  (≤5%):  single-tailed %, named direction, "!"  → "Only 2.4% … this hot!"
  //   - notable  (≤20%): single-tailed %, cumulative           → "About 10% … this hot or hotter."
  //   - mild     (>20%): DOUBLE-tailed %, mocked "extreme"      → "About 70% … this "extreme"."
  // Mild flips to two-tailed because no direction is meaningful near the middle.
  let extremeLine: string | null = null;
  let verdict = context.description;
  let rank = 0; // 1-based rank on the day's side; 0 when undeterminable.
  let allTimeRank = 0; // rank across the ENTIRE record (every day, all years); 0 = N/A.
  {
    // Compare in CONVERTED (display-unit) space, exactly as the histogram does,
    // so the prose rarity and the histogram bracket agree to the decimal.
    const cur = convert(currentTemp, currentMetric, system);
    const values = valid.map((d) => convert(d[currentMetric] as number, currentMetric, system));
    const n = values.length;
    // Window rank via the shared rankValue() — INCLUSIVE tails + shared-worst
    // "competition" rank (ties share the LAST position of their group, so a 0mm
    // day tied with 300 others ranks ~300th, not 1st and never fires confetti).
    // 'auto' picks the rarer side. THE one ranking implementation; the histogram
    // brackets and chart star derive from the same pool/logic.
    const windowRank = rankValue(cur, values, 'auto');
    const isHighSide = windowRank.isHighSide;
    const singleTail = windowRank.singleTail;
    if (n > 0) {
      rank = isHighSide ? windowRank.rankHigh : windowRank.rankLow;
      // All-time rank: same logic, but against EVERY day of the whole record (not
      // just the ±N-day window). A top-1/2/3 here means the value is, e.g., the
      // hottest day this cell has ever seen on ANY date — far rarer than topping
      // its calendar neighbours, so it earns louder prose + 5× confetti. Force the
      // same side (isHighSide) so "hottest/coldest" agrees with the window verdict.
      {
        const allVals = comparablePool(yearTimeline, currentDate)
          .map((d) => d[currentMetric])
          .filter((v): v is number => typeof v === 'number' && Number.isFinite(v))
          .map((v) => convert(v, currentMetric, system));
        if (allVals.length > 0) {
          const allTime = rankValue(cur, allVals, isHighSide ? 'high' : 'low');
          allTimeRank = isHighSide ? allTime.rankHigh : allTime.rankLow;
        }
      }
      // Name the actual comparison pool: every day within a ±seasonalWindowDays
      // calendar window of the target date, across all years back to 1950. Spell
      // out the window and date ("within ±N days of June 6th") rather than the
      // vaguer "this time of year".
      const win = CONFIG.chart.seasonalWindowDays;
      const td = new Date(currentDate + 'T12:00:00');
      const shortMonths = ['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun',
        'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec'];
      const tDay = td.getDate();
      const tSuffix =
        tDay % 10 === 1 && tDay !== 11 ? 'st' :
        tDay % 10 === 2 && tDay !== 12 ? 'nd' :
        tDay % 10 === 3 && tDay !== 13 ? 'rd' : 'th';
      const since = ` within ±${win} days of ${shortMonths[td.getMonth()]} ${tDay}${tSuffix}`;
      const dir = METRIC_DIRECTION[currentMetric];
      const [adj, comp, sup] = isHighSide ? dir.high : dir.low;
      // Min temp is always the overnight low, so describe the pool as nights.
      const noun = currentMetric === 'min_temperature' ? 'night' : 'day';
      const nounP = noun + 's';
      // Stable per-day seed so the verdict phrase doesn't re-roll on re-render.
      const seed = `${currentMetric}:${currentTemp}:${rank}`;

      if (allTimeRank >= 1 && allTimeRank <= 3) {
        // Top-1/2/3 across the WHOLE record — the rarest thing the page shows.
        // Drop the ±window qualifier: this is the all-time extreme on ANY date,
        // not just nearby ones.
        extremeLine =
          allTimeRank === 1
            ? `The ${sup} ${noun} EVER recorded!`
            : `${ordinal(allTimeRank)}-${sup} ${noun} ever recorded!`;
        verdict =
          allTimeRank === 1 ? pick(VERDICT_ALLTIME_1, seed) : pick(VERDICT_ALLTIME_23, seed);
      } else if (rank <= 3) {
        // Top-3 in its ±window — name the rank, celebrate.
        extremeLine =
          rank === 1
            ? `${sup.charAt(0).toUpperCase() + sup.slice(1)} ${noun}${since} on record!`
            : `${ordinal(rank)} ${sup} ${noun}${since} on record!`;
        // #1 gets the exclusive phrase; #2/#3 draw from the party bank.
        verdict = rank === 1 ? 'Record-breaker!' : pick(VERDICT_TOP3, seed);
      } else if (singleTail <= 0.05) {
        // Extreme — one decimal, floored so a record never prints "0.0%".
        const pct = singleTail * 100;
        const shown = pct < 0.1 ? '<0.1' : pct.toFixed(1);
        extremeLine = `Only ${shown}% of ${nounP}${since} were this ${adj}!`;
        verdict = pick(VERDICT_EXTREME, seed);
      } else if (singleTail <= 0.2) {
        // Notable — whole percent, cumulative ("or hotter"). Drop the comparative
        // when nothing can be more extreme (a 0mm day can't be "drier").
        const pct = singleTail * 100;
        const atFloor = currentTemp === 0 && !isHighSide;
        extremeLine = atFloor
          ? `About ${pct.toFixed(0)}% of ${nounP}${since} were this ${adj}.`
          : `About ${pct.toFixed(0)}% of ${nounP}${since} were this ${adj} or ${comp}.`;
        verdict = pick(VERDICT_NOTABLE, seed);
      } else {
        // Mild — no rarity number here. A two-tailed % near the middle never
        // matched the histogram's single-tailed bracket and read as confusing.
        // Instead describe the position softly: dead-center days get a mocked
        // "perfectly average" verdict; off-center-but-mild days get a hedged
        // "a bit warmer than most", naming today's actual side.
        const pctile = windowRank.rankLow / n; // 0..1, where today sits in the pack
        const isDeadCenter = pctile >= 0.45 && pctile <= 0.55;
        if (isDeadCenter) {
          extremeLine = `${pick(DEAD_CENTER_LINE, seed)} for ${nounP}${since}.`;
        } else {
          const cmp = METRIC_COMPARATIVE[currentMetric];
          const word = isHighSide ? cmp.high : cmp.low;
          const hedge = pick(MILD_HEDGE, seed);
          extremeLine = `A ${hedge} ${word} than most ${nounP}${since}.`;
        }
        verdict = pick(VERDICT_MILD, seed);
      }
    }
  }

  // Confetti for any top-3 day. An in-window top-3 gets the normal burst; an
  // all-time top-1/2/3 (rarest on the page) gets a 5× burst. Re-fires when the
  // rank-bearing day changes (new date/metric/location landing in the top 3).
  const isTop3 = rank >= 1 && rank <= 3;
  const isAllTimeTop3 = allTimeRank >= 1 && allTimeRank <= 3;
  useEffect(() => {
    if (isAllTimeTop3) fireConfetti(5);
    else if (isTop3) fireConfetti(1);
  }, [isTop3, isAllTimeTop3, currentMetric, currentTemp]);

  // Lead line above the punchy verdict: "June 7th in Tel Aviv is".
  const leadDate = (() => {
    const d = new Date(currentDate + 'T12:00:00');
    const months = ['January', 'February', 'March', 'April', 'May', 'June',
      'July', 'August', 'September', 'October', 'November', 'December'];
    const day = d.getDate();
    const suffix =
      day % 10 === 1 && day !== 11 ? 'st' :
      day % 10 === 2 && day !== 12 ? 'nd' :
      day % 10 === 3 && day !== 13 ? 'rd' : 'th';
    return `${months[d.getMonth()]} ${day}${suffix}, ${d.getFullYear()}`;
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
              <span
                className="record-scale-marker-value"
                style={{ color: markerColor }}
              >
                {fmt(currentTemp)}
              </span>
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

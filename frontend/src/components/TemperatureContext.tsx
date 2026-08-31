import React, { useEffect } from 'react';
import type { TemperatureContext as TempContext, WeatherDataPoint, MetricKey, MetricBand } from '../types';
import { useUnits } from '../hooks/useUnits';
import { convert, unitLabel, unitLabelBare, valueDecimals } from '../utils/units';
import { comparablePool, findRecords, observedPool } from '../utils/dataProcessor';
import { recordScaleFraction } from '../utils/recordScale';
import { ordinalSuffix, resolveVerdictProse } from '../utils/verdictProse';
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

// Metric phrase for the lead line — mirrors the metric buttons.
const METRIC_LEAD_LABEL: Record<MetricKey, string> = {
  max_temperature: 'max temperature',
  min_temperature: 'min temperature',
  precipitation_sum: 'precipitation',
  wind_speed_10m_max: 'wind speed',
  dew_point_2m_mean: 'dew point',
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
  // "the record" is one definition site, not a loop duplicated per component. It
  // drops model rows itself, so the rail ends are measured ERA days even when the
  // window contains a hotter forecast.
  const { hiRow, loRow } = findRecords(valid, currentMetric);
  const recordLow = loRow ? (loRow[currentMetric] as number) : null;
  const recordHigh = hiRow ? (hiRow[currentMetric] as number) : null;
  const recordLowDate = loRow ? loRow.date : null;
  const recordHighDate = hiRow ? hiRow.date : null;

  // A window with NO spread at all: every comparable day carries the identical
  // value, so record low === record high. In practice this is a bone-dry precip
  // window (every day within ±N days of the date, across all years, is 0mm). It
  // used to blank the bar out entirely: the position is a (v - lo) / (hi - lo)
  // normalisation, i.e. 0/0 here, so the old strict `hi > lo` guard left
  // binnedPct null and the card fell back to a bare number with no scale at all.
  // We still draw the bar now (recordScaleFraction centres the marker); it just
  // stops claiming a range it doesn't have — flat rail, and the two identical end
  // labels collapse into one caption. See the render below.
  const flatScale = recordLow !== null && recordHigh !== null && recordHigh === recordLow;

  let binnedPct: number | null = null;
  let markerColor = '#222';
  if (recordLow !== null && recordHigh !== null) {
    const binT = recordScaleFraction(displayTemp, recordLow, recordHigh);
    binnedPct = binT * 100;
    markerColor = interpolateGradient(binT);
  }

  const hasScale = binnedPct !== null && recordLow !== null && recordHigh !== null;

  // Name the actual comparison pool: every day within a ±seasonalWindowDays
  // calendar window of the target date, across all years back to 1950. Spell out
  // the window and date ("within ±N days of June 6th") rather than the vaguer
  // "this time of year". Hoisted above the verdict block because the flat-scale
  // caption in the render names the very same pool.
  const win = CONFIG.chart.seasonalWindowDays;
  const td = new Date(currentDate + 'T12:00:00');
  const shortMonths = ['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun',
    'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec'];
  const tDay = td.getDate();
  const since = ` within ±${win} days of ${shortMonths[td.getMonth()]} ${tDay}${ordinalSuffix(tDay)}`;
  // Min temp is always the overnight low, so describe the pool as nights (the
  // ladder applies the same rule to its own sentences).
  const noun = currentMetric === 'min_temperature' ? 'night' : 'day';

  // Verdict (bold line) + rarity line, from THE shared prose ladder
  // (utils/verdictProse) — the same function the year dial's heading runs on a
  // whole-record pool, so the two sections can never word the same tier
  // differently. The ladder itself documents the tiers; what's decided HERE is
  // only which pool the claim is about and how to name it.
  //
  // Tier + rarity run off the SAME observed-only climatology pool the histogram
  // brackets and the record star use — MODEL ROWS EXCLUDED, i.e. the target's own
  // forecast row and any recent-tier precip/wind. Including them (as this card
  // used to) ranks the value against near-copies of itself and lands it a tier
  // MILDER than the histogram, which excludes them — the "card says top 20% / chart
  // says top 10%" bug; and it let a model row be ranked #1 while the star sat on a
  // real one. Ranking is unit-agnostic, so the pools go in NATIVE units.
  const windowNative = observedPool(valid, currentMetric)
    .map((d) => d[currentMetric] as number);
  const allTimeNative = observedPool(yearTimeline, currentMetric)
    .map((d) => d[currentMetric])
    .filter((v): v is number => typeof v === 'number' && Number.isFinite(v));
  const prose = resolveVerdictProse({
    displayValue: displayTemp,
    band: band ?? null,
    windowNative,
    allTimeNative,
    metric: currentMetric,
    system,
    // "…of days within ±3 days of Aug 30th…" — no quantifier: the scope clause
    // already says which days, and the dial's "all" would read as a contrast.
    pool: { quantifier: '', scope: since },
    style: 'surprise',
  });
  const verdict = prose ? prose.verdict : context.description;
  const extremeLine = prose?.rarityLine ?? null;
  const rank = prose?.rank ?? 0; // 1-based rank on the day's side; 0 when undeterminable.
  const allTimeRank = prose?.allTimeRank ?? 0; // rank across the ENTIRE record; 0 = N/A.
  // Forecast top-5% day we're >=80% sure clears the 5% cutoff — drives the
  // confetti burst below. Stays false on historical rows.
  const isVeryExtremeForecast = prose?.isVeryExtremeForecast ?? false;

  // Confetti for a standout day. HISTORICAL rows fire on an in-window top-3 — a
  // real, settled rank. FORECAST rows are point estimates, so a rank-1 median isn't
  // a record; they fire ONLY on the confidence-gated very-extreme tier (≥80% sure
  // they clear the 5% cutoff). An all-time top-10 (rarest on the page) still gets
  // the 5× burst either way. Re-fires when the standout day changes.
  const isTop3 = rank >= 1 && rank <= 3;
  const isAllTimeTop10 = allTimeRank >= 1 && allTimeRank <= 10;
  const wantsBurst = band ? isVeryExtremeForecast : isTop3;
  useEffect(() => {
    if (isAllTimeTop10) fireConfetti(5);
    else if (wantsBurst) fireConfetti(1);
  }, [wantsBurst, isAllTimeTop10, currentMetric, displayTemp]);

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
        <div
          className="record-scale"
          aria-label={
            flatScale
              ? 'Value against a record with no variation'
              : 'Temperature vs records'
          }
        >
          {/* Zero-spread window: the two end labels would be the same number under
              two contradictory names ("record low" / "record high"), each dated to
              whichever row happened to be scanned first — meaningless. Drop them and
              state the single value once, under the rail. */}
          {!flatScale && (
            <div className="record-scale-label record-scale-low">
              <span className="record-scale-temp">{fmt(recordLow!)}</span>
              <span className="record-scale-name">record low</span>
              {recordLowDate && (
                <span className="record-scale-date">{formatDate(recordLowDate)}</span>
              )}
            </div>
          )}
          <div className="record-scale-track">
            {/* Flat window: the blue→white→red gradient would be advertising a
                spread that isn't there, so the rail goes neutral. */}
            <div
              className={
                flatScale
                  ? 'record-scale-gradient record-scale-gradient-flat'
                  : 'record-scale-gradient'
              }
            />
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
            {flatScale && (
              <span className="record-scale-flat-note">
                every {noun}{since}: {fmt(recordLow!)}
              </span>
            )}
          </div>
          {!flatScale && (
            <div className="record-scale-label record-scale-high">
              <span className="record-scale-temp">{fmt(recordHigh!)}</span>
              <span className="record-scale-name">record high</span>
              {recordHighDate && (
                <span className="record-scale-date">{formatDate(recordHighDate)}</span>
              )}
            </div>
          )}
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

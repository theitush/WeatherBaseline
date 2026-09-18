import CONFIG, { type MetricKey } from './config';
import type { WeatherDataPoint } from '../types';
import { comparablePool } from './dataProcessor';

/** The year continuous global satellite coverage begins in the reanalysis —
 *  the same boundary MainChart draws its "Satellites!" line at. */
export const SATELLITE_YEAR = 1979;

/** Fill alpha every era's histogram shares; the eras are told apart by shade
 *  or outline, never by transparency. */
export const ERA_FILL_ALPHA = 0.45;

/**
 * How the eras are told apart. Both styles ink from the SAME ordinal ramp
 * (ERA_RAMPS) — one hue per metric, lightness carrying the order — and differ
 * only in which mark wears it:
 *   shade   — the ramp is each era's fill AND its thin outline.
 *   contour — one shared fill (the metric base at ERA_FILL_ALPHA) and the ramp
 *             is the outline alone.
 *
 * In contour style the histogram's bars carry NO stroke: `stroke` inks a single
 * step path along the tops of that era's bars — the silhouette of the shape —
 * rather than a box around every bin. On the main chart it is also what tints
 * that era's stretch of the percentile band and dashes its boundary line.
 *
 * `stroke` is always a real colour, in both styles and for every era.
 */
export type EraStyle = 'shade' | 'contour';

export interface Era {
  /** First year, inclusive. */
  from: number;
  /** Last year, inclusive. */
  to: number;
  /** "1950–1978", "1979–2002" … the legend / tooltip label. */
  label: string;
}

/**
 * The three eras the histogram is split into: everything before the satellites,
 * then the satellite era cut evenly-ish in two. `firstYear`/`lastYear` bound the
 * pool actually on screen so the labels read the real record, and the midpoint
 * moves with the record: 1979–2026 → 1979–2002 | 2003–2026.
 */
export function eraSplit(firstYear: number, lastYear: number): Era[] {
  const satSpan = lastYear - SATELLITE_YEAR + 1;
  const mid = SATELLITE_YEAR + Math.ceil(satSpan / 2);
  const fmt = (a: number, b: number) => `${a}–${b}`;
  return [
    { from: firstYear, to: SATELLITE_YEAR - 1, label: fmt(firstYear, SATELLITE_YEAR - 1) },
    { from: SATELLITE_YEAR, to: mid - 1, label: fmt(SATELLITE_YEAR, mid - 1) },
    { from: mid, to: lastYear, label: fmt(mid, lastYear) },
  ];
}

/**
 * The eras for what the charts draw: the comparable pool (forecast rows past
 * the target dropped) restricted to rows carrying the metric — the SAME rows
 * the histogram bins, so the legend's year ranges match the bars exactly.
 * MainChart, HistogramChart and App all derive their eras through this one
 * call so no two of them can disagree on where the cuts fall.
 */
export function erasForPool(
  data: WeatherDataPoint[],
  metric: MetricKey,
  currentDate: string
): Era[] | undefined {
  const years = comparablePool(data, currentDate)
    .filter((d) => d[metric] !== undefined)
    .map((d) => d.year);
  if (years.length === 0) return undefined;
  return eraSplit(Math.min(...years), Math.max(...years));
}

/** Which era (index into eraSplit's array) a year belongs to. */
export function eraIndex(year: number, eras: Era[]): number {
  for (let i = eras.length - 1; i >= 0; i--) if (year >= eras[i].from) return i;
  return 0;
}

export type ThemeMode = 'light' | 'dark';

/**
 * The ordinal era ramps: ONE hue per metric, three monotone lightness steps,
 * and a SEPARATE set per theme.
 *
 * The eras are ordinal — three time buckets in order — so order has to be
 * carried by lightness along a single hue, never by three unrelated categorical
 * hues. Light mode runs pale → dark oldest → newest; dark mode runs dark →
 * bright, because against #16171d it is brightness that has to rise with
 * recency. The same hexes cannot serve both, which is why there are two rows.
 *
 * GENERATED, NOT HAND-PICKED. Each ramp holds its metric's OKLCH hue with
 * chroma capped at 0.16 and lightness pinned at L 0.75 / 0.665 / 0.58 (light)
 * and 0.47 / 0.67 / 0.75 (dark), gamut-clipped by reducing chroma; every ramp
 * passes the dataviz skill's `validate_palette.js --ordinal` in its own mode,
 * checked 2026-09-18, with the pale end at ≥2.2:1 on #fff and ≥2.4:1 on
 * #16171d. The dark steps were regenerated that day after Ita read the chart in
 * dark mode: the pre/post-satellite pair sat too close together and the newest
 * era too bright, so era 0 drops and era 2 dims — the gap between 0 and 1 is now
 * 0.20 L against 0.08 between 1 and 2, which is the order of the split itself
 * (the satellite cut is the big one). They replace d3 brighter()/darker() steps
 * off the base colour, which drifted orange's hue 43° (so it was not one hue at
 * all) and left the oldest era at 1.3:1 — invisible on white — and were reused
 * unchecked in dark mode. The light steps were lifted the same evening (from
 * 0.74 / 0.61 / 0.48) after Ita read them on white: at L 0.48 orange is brown
 * and blue is grey-navy, so the newest era now sits at 0.58 — a burnt orange /
 * a real blue — and the three steps close up to 0.085 L apart, still clear of
 * the validator's 0.06 floor.
 *
 * DO NOT hand-edit a value here, and do not add a metric by eye: regenerate and
 * re-run the validator, or the guarantees above quietly stop being true.
 */
const ERA_RAMPS: Record<
  MetricKey,
  { light: [string, string, string]; dark: [string, string, string] }
> = {
  max_temperature: {
    light: ['#fc8c44', '#df7124', '#be5901'],
    dark: ['#8f4203', '#e07326', '#fc8c44'],
  },
  min_temperature: {
    light: ['#71b1fe', '#5096e8', '#357ccc'],
    dark: ['#0c5aa8', '#5198ea', '#71b1fe'],
  },
  precipitation_sum: {
    light: ['#b69afe', '#9d7cea', '#8462cd'],
    dark: ['#6540a8', '#9f7deb', '#b69afe'],
  },
  wind_speed_10m_max: {
    light: ['#a9aeb7', '#8f949d', '#767a83'],
    dark: ['#565b63', '#90959e', '#a9aeb7'],
  },
};

/**
 * The era's step on its metric's ordinal ramp, in the theme being painted. The
 * index is clamped, so an era array longer than the ramp keeps the newest step
 * rather than running off the end; an unknown metric falls back to wind's
 * neutral grey ramp rather than a colour it has no claim to.
 */
export function eraColor(metric: MetricKey, era: number, theme: ThemeMode): string {
  const ramp = (ERA_RAMPS[metric] ?? ERA_RAMPS.wind_speed_10m_max)[theme];
  return ramp[Math.min(Math.max(era, 0), ramp.length - 1)];
}

export interface EraInk {
  fill: string;
  fillOpacity: number;
  stroke: string;
  strokeWidth: number;
}

/** What to draw an era's marks (bars, silhouette, band, boundary) in, per style. */
export function eraInk(
  metric: MetricKey,
  era: number,
  style: EraStyle,
  theme: ThemeMode
): EraInk {
  if (style === 'contour') {
    // Every era outlines, in its own step of the SAME ordinal ramp the shades
    // fill with — one hue, 0.13 L apart, so the three read as ordered rather
    // than as three unrelated colours. That is also why they are not tellable
    // apart by colour alone, and the legend labels each era by its years.
    //
    // What contour style changes is only WHICH MARK wears the ramp: the outline
    // rather than the fill, which stays one shared metric-base wash under all
    // three. The oldest era is outlined too — it cannot just be the background
    // (Ita, 2026-09-18).
    return {
      fill: CONFIG.metricColors[metric]?.base ?? '#888888',
      fillOpacity: ERA_FILL_ALPHA,
      stroke: eraColor(metric, era, theme),
      // 2px is the mark spec for a line carrying identity. Callers drawing on
      // something too small for it say so themselves rather than this returning
      // a second width.
      strokeWidth: 2,
    };
  }
  const shade = eraColor(metric, era, theme);
  return { fill: shade, fillOpacity: ERA_FILL_ALPHA, stroke: shade, strokeWidth: 1 };
}

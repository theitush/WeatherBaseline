// Shared types for the multi-radial comparison page (compare.html).
//
// A "series" is one configured dial input: a location (snapped cell), a year
// range, a metric, a color, and an optional set of highlighted calendar dates.
// The page loads each series' archive-only timeline from R2 and either overlays
// every series on one dial or lays each out on its own dial.
//
// A series can also be SPLIT INTO ERAS — the very eras the main page splits its
// histogram into (utils/eras: before the satellites, 1979–1999, and 2000 on) —
// drawn on top of each other, so the same cell and metric can be compared
// against its own past. The cuts come from eraSplit and nowhere else, so a ring
// here and a bar there are always talking about the same years.
import type { MetricKey } from '../utils/config';
import type { WeatherDataPoint } from '../types';
import { eraColor, eraSplit, type ThemeMode } from '../utils/eras.ts';

/** A specific calendar date the user wants called out on a series' dial. */
export interface DateMarker {
  /** Stable id so React keys and removal are unambiguous. */
  id: string;
  /** YYYY-MM-DD — the exact archive day whose value gets a dashed ring. */
  date: string;
  /** Swatch / ring color, independent of the series color. */
  color: string;
}

/** One configured comparison series. */
export interface Series {
  id: string;
  /** Snapped grid cell. lat/lon are on the 0.1° ERA5-Land grid. */
  lat: number;
  lon: number;
  name: string;
  metric: MetricKey;
  /** Inclusive year bounds applied to the archive timeline. */
  startYear: number;
  endYear: number;
  /** Line/cloud color when the series is NOT split, and its identity color
   *  either way — the card's edge and the dial's title. */
  color: string;
  /** Highlighted calendar dates (dashed value rings + legend). */
  markers: DateMarker[];
  /**
   * Draw this series as the main page's eras laid over each other rather than as
   * one ring over the whole range. Same cell, same metric, same axis — the
   * period is the only difference.
   */
  split: boolean;
  /**
   * Color overrides for the split periods, keyed by ERA INDEX (0 = oldest).
   * An era with no entry here is drawn in the color the main page paints those
   * years, which is what its swatch shows — so a fresh split already matches the
   * main page and every one of its rings is still the user's to change.
   */
  eraColors: Partial<Record<number, string>>;
  /**
   * Fill the gap between ADJACENT periods' median rings with the color of
   * whichever of the two is HIGHER at that day of the year. Split only.
   */
  diffShade: boolean;
  /**
   * Half-window, in days, of the circular smoothing applied to every
   * day-of-year curve this series draws — the median ring and the percentile
   * bands alike (0 = raw daily quantiles). A single calendar day holds one
   * value per year, so raw curves are spiky and the difference shading flickers
   * between its colors; a split series therefore defaults to ±7 days, the
   * window a day-of-year climatology normally uses.
   */
  smoothDays: number;
}

/** Archive timeline loaded for a series, keyed by series id. */
export interface SeriesData {
  /** Settled archive rows only (data_type === 'historical'). */
  rows: WeatherDataPoint[];
  loading: boolean;
  /** True once loaded and the cell had no archive (forecast-only cell). */
  noArchive: boolean;
  error?: string;
  /** Cell coords this data was loaded for — used to detect a location change. */
  _lat?: number;
  _lon?: number;
}

export type LayoutMode = 'overlay' | 'separate';

/**
 * Which layers a dial draws on top of the day cloud. Every one is an
 * independent tick box — there is no mode switch, because every day is always
 * drawn and the envelopes are simply laid over it.
 */
export type BandKey = 'p10_90' | 'p25_75' | 'median';

/**
 * The percentile envelopes, widest first — which is also the draw order, so the
 * palest band sits underneath the tighter ones.
 */
export const BAND_SPECS = [
  { key: 'p10_90' as const, lo: 0.1, hi: 0.9, opacity: 0.18, label: '10–90 percentile' },
  { key: 'p25_75' as const, lo: 0.25, hi: 0.75, opacity: 0.32, label: '25–75 percentile' },
];

export const BAND_LABEL: Record<BandKey, string> = {
  p10_90: '10–90 percentile',
  p25_75: '25–75 percentile',
  median: 'median (50th)',
};

/** Every toggle the Layers group offers, in the order it lists them. */
export const BAND_TOGGLES: BandKey[] = ['p10_90', 'p25_75', 'median'];

export const DEFAULT_BANDS: BandKey[] = ['p10_90', 'p25_75', 'median'];

/** Smoothing choices for the median ring, as (label, half-window in days). */
export const SMOOTH_OPTIONS: { days: number; label: string }[] = [
  { days: 0, label: 'raw daily' },
  { days: 3, label: '±3 days' },
  { days: 7, label: '±7 days' },
  { days: 15, label: '±15 days' },
];

/** Half-window a series takes when its split is first switched on. */
export const SPLIT_DEFAULT_SMOOTH = 7;

/** One drawable period of a series, before its color is resolved. The shuffle
 *  test and every label read only this much, and none of it depends on theme. */
export interface PeriodRange {
  startYear: number;
  endYear: number;
  /** "1979–1999" — the legend, the editor's rows and the verdict all read it. */
  label: string;
  /**
   * Which era this is, indexed the way utils/eras indexes them (0 = oldest),
   * which is also what picks its default color. -1 when the period is not one
   * era but a span of them: the whole range of an unsplit series, or the
   * "everything before the latest era" pile the shuffle test builds.
   */
  era: number;
}

/** A period with its color resolved — what the dial and the legend draw. */
export interface Period extends PeriodRange {
  color: string;
}

const rangeLabel = (from: number, to: number): string => `${from}–${to}`;

/**
 * A series' year range cut into eras: eraSplit's cuts — 1979 and 2000, the ones
 * the main page uses — intersected with the range, empty eras dropped.
 *
 * The intersection is not a second opinion about where the cuts fall; it is
 * what the compare page needs and the main page does not. Every cell there runs
 * 1950→now, so all three eras are always populated, while here the user picks
 * the range: a 1990–2020 series has no pre-satellite era at all, and its
 * satellite-era ring covers 1990–1999, not the 1979–1999 the raw split would
 * label it. The era INDEX survives the clamp, so that ring is still painted in
 * era 1's color and still means the same stretch of the record.
 */
function eraPeriods(s: Pick<Series, 'startYear' | 'endYear'>): PeriodRange[] {
  return eraSplit(s.startYear, s.endYear)
    .map((era, i) => ({
      startYear: Math.max(era.from, s.startYear),
      endYear: Math.min(era.to, s.endYear),
      era: i,
    }))
    .filter((p) => p.startYear <= p.endYear)
    .map((p) => ({ ...p, label: rangeLabel(p.startYear, p.endYear) }));
}

/** A range has to reach across a cut to have more than one era to split into. */
export const canSplit = (s: Pick<Series, 'startYear' | 'endYear'>): boolean =>
  eraPeriods(s).length > 1;

/** The year windows a series draws: its eras when split, else the whole range. */
export function seriesPeriodRanges(
  s: Pick<Series, 'startYear' | 'endYear' | 'split'>
): PeriodRange[] {
  if (!s.split || !canSplit(s)) {
    return [
      {
        startYear: s.startYear,
        endYear: s.endYear,
        label: rangeLabel(s.startYear, s.endYear),
        era: -1,
      },
    ];
  }
  return eraPeriods(s);
}

/**
 * A period's color: the user's override for that era when there is one, else
 * the era's step on the metric's ordinal ramp — the exact color the main page's
 * histogram paints those years in this theme.
 *
 * eraColor and not eraInk(...).fill, for the reason PeriodHistogramChart gives:
 * in CONTOUR style every era's `fill` is one shared metric base, which works
 * there because the eras are overlaid and told apart by their outlines. A
 * dial's rings, bands and cloud have no such outline, so a shared fill would
 * make all three periods identical. The ramp step is the era's color under
 * either style — which is also why this page has no reason to read the eraStyle
 * setting at all.
 */
export function periodColor(s: Series, era: number, theme: ThemeMode): string {
  if (era < 0) return s.color;
  return s.eraColors[era] ?? eraColor(s.metric, era, theme);
}

/** The periods a series draws, colors resolved for the theme being painted. */
export function seriesPeriods(s: Series, theme: ThemeMode): Period[] {
  return seriesPeriodRanges(s).map((p) => ({
    ...p,
    color: periodColor(s, p.era, theme),
  }));
}

/**
 * The two piles the shuffle test compares: the LATEST era against everything
 * before it.
 *
 * Three rings pose three pairwise questions and the panel under the dial has
 * room for one sentence, so it asks the one the dial exists to answer — has the
 * present moved away from the past. Pooling the older eras also keeps that
 * pile's sample size up, which is where a short record is thinnest. The gap
 * SHADING still works pair by pair; the two are answering different questions
 * and are drawn differently.
 *
 * Null when there is only one period, which is nothing to compare.
 */
export function periodTestWindows(
  periods: PeriodRange[]
): { early: PeriodRange; late: PeriodRange } | null {
  if (periods.length < 2) return null;
  const late = periods[periods.length - 1];
  const rest = periods.slice(0, -1);
  const startYear = rest[0].startYear;
  const endYear = rest[rest.length - 1].endYear;
  return {
    early: {
      startYear,
      endYear,
      label: rangeLabel(startYear, endYear),
      // One era pooled with nothing else is still that era; two or more is a
      // span, which has no era color of its own.
      era: rest.length === 1 ? rest[0].era : -1,
    },
    late,
  };
}

/** A palette of distinct, theme-agnostic series colors to cycle through. */
export const SERIES_PALETTE = [
  '#FF8C42', // orange
  '#4A90E2', // blue
  '#7E5BC6', // purple
  '#3FB68B', // green
  '#E0556E', // rose
  '#D9A441', // amber
  '#5BC0C6', // teal
  '#9A8C98', // mauve-gray
];

/** A palette for date markers — kept visually distinct from series lines. */
export const MARKER_PALETTE = [
  '#111827',
  '#DC2626',
  '#2563EB',
  '#059669',
  '#D97706',
  '#7C3AED',
];

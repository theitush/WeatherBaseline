// Shared types for the multi-radial comparison page (compare.html).
//
// A "series" is one configured dial input: a location (snapped cell), a year
// range, a metric, a color, and an optional set of highlighted calendar dates.
// The page loads each series' archive-only timeline from R2 and either overlays
// every series on one dial or lays each out on its own dial.
//
// A series can also be SPLIT at the midpoint of its own year range into two
// periods drawn on top of each other — 1980–2026 becomes 1980–2003 and
// 2004–2026 — so the same cell and metric can be compared against its own past.
import type { MetricKey } from '../utils/config';
import type { WeatherDataPoint } from '../types';

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
  /** Line/cloud color for this series — the EARLY half's color when split. */
  color: string;
  /** Highlighted calendar dates (dashed value rings + legend). */
  markers: DateMarker[];
  /**
   * Split the year range at its midpoint and draw both halves on one dial.
   * Same cell, same metric, same axis — the period is the only difference.
   */
  split: boolean;
  /** Line/cloud color for the LATE half when split. */
  lateColor: string;
  /**
   * Fill the gap between the two halves' median rings with the color of
   * whichever half is HIGHER at that day of the year. Split only.
   */
  diffShade: boolean;
  /**
   * Half-window, in days, of the circular smoothing applied to every
   * day-of-year curve this series draws — the median ring and the percentile
   * bands alike (0 = raw daily quantiles). A single calendar day holds one
   * value per year, so raw curves are spiky and the difference shading flickers
   * between its two colors; a split series therefore defaults to ±7 days, the
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

/** Which percentile layers a dial draws. Every one is independently togglable. */
export type BandKey = 'p1_99' | 'p5_95' | 'p25_75' | 'median' | 'outliers';

/**
 * The percentile envelopes, widest first — which is also the draw order, so the
 * palest band sits underneath the tighter ones.
 */
export const BAND_SPECS = [
  { key: 'p1_99' as const, lo: 0.01, hi: 0.99, opacity: 0.08, label: '1–99 percentile' },
  { key: 'p5_95' as const, lo: 0.05, hi: 0.95, opacity: 0.15, label: '5–95 percentile' },
  { key: 'p25_75' as const, lo: 0.25, hi: 0.75, opacity: 0.32, label: '25–75 percentile' },
];

export const BAND_LABEL: Record<BandKey, string> = {
  p1_99: '1–99 percentile',
  p5_95: '5–95 percentile',
  p25_75: '25–75 percentile',
  median: 'median (50th)',
  outliers: 'outliers (<1 / >99)',
};

/** Toggles offered in each point mode. 'all' already draws every day, so only
 *  the median ring is a choice there. */
export const BANDS_FOR_MODE: Record<'all' | 'percentile', BandKey[]> = {
  all: ['median'],
  percentile: ['p1_99', 'p5_95', 'p25_75', 'median', 'outliers'],
};

export const DEFAULT_BANDS: BandKey[] = ['p1_99', 'p5_95', 'p25_75', 'median', 'outliers'];

/** Smoothing choices for the median ring, as (label, half-window in days). */
export const SMOOTH_OPTIONS: { days: number; label: string }[] = [
  { days: 0, label: 'raw daily' },
  { days: 3, label: '±3 days' },
  { days: 7, label: '±7 days' },
  { days: 15, label: '±15 days' },
];

/** Half-window a series takes when its split is first switched on. */
export const SPLIT_DEFAULT_SMOOTH = 7;

/** One drawable period of a series: a year window with its own color. */
export interface Period {
  startYear: number;
  endYear: number;
  color: string;
  /** "1980–2003" — used for legends and the editor's split rows. */
  label: string;
  /** 'early' / 'late' when split, 'whole' otherwise. */
  half: 'whole' | 'early' | 'late';
}

/**
 * The year the split falls on: the last year of the EARLY half. The halves are
 * disjoint — 1980–2026 splits into 1980–2003 and 2004–2026 — because a year
 * counted in both periods would be compared against itself.
 */
export const splitYear = (s: Pick<Series, 'startYear' | 'endYear'>): number =>
  Math.floor((s.startYear + s.endYear) / 2);

/** A range needs at least two years to have two halves. */
export const canSplit = (s: Pick<Series, 'startYear' | 'endYear'>): boolean =>
  s.endYear > s.startYear;

/** The periods a series draws: two when split (and splittable), else one. */
export function seriesPeriods(s: Series): Period[] {
  if (!s.split || !canSplit(s)) {
    return [
      {
        startYear: s.startYear,
        endYear: s.endYear,
        color: s.color,
        label: `${s.startYear}–${s.endYear}`,
        half: 'whole',
      },
    ];
  }
  const mid = splitYear(s);
  return [
    {
      startYear: s.startYear,
      endYear: mid,
      color: s.color,
      label: `${s.startYear}–${mid}`,
      half: 'early',
    },
    {
      startYear: mid + 1,
      endYear: s.endYear,
      color: s.lateColor,
      label: `${mid + 1}–${s.endYear}`,
      half: 'late',
    },
  ];
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

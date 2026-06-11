// Shared types for the multi-radial comparison page (compare.html).
//
// A "series" is one configured dial input: a location (snapped cell), a year
// range, a metric, a color, and an optional set of highlighted calendar dates.
// The page loads each series' archive-only timeline from R2 and either overlays
// every series on one dial or lays each out on its own dial.
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
  /** Line/cloud color for this series. */
  color: string;
  /** Highlighted calendar dates (dashed value rings + legend). */
  markers: DateMarker[];
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

import * as d3 from 'd3';
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
 * How the eras are told apart:
 *   shade   — three shades of the metric hue, each era's fill AND outline.
 *   contour — one fill (the metric hue, same alpha for all) and only the
 *             outline colour changes per era.
 *
 * In contour style the histogram's bars carry NO stroke: `stroke` inks a single
 * step path along the tops of that era's bars — the silhouette of the shape —
 * rather than a box around every bin, and on the main chart it rings that era's
 * daily dots and dashes its boundary line. The OLDEST era has no contour ink at
 * all (see CONTOUR_INKS), so in this style `stroke` can be `'none'`: test it
 * with hasOutline() before drawing anything with it.
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

/**
 * The era's shade: three lightnesses of the metric hue, lighter for the older
 * eras and the full base colour for the most recent one, so "darker = more
 * recent" reads the same way across every metric (including wind's grey).
 */
export function eraColor(metric: MetricKey, era: number): string {
  const base = d3.color(CONFIG.metricColors[metric]?.base ?? '#888888')!;
  if (era === 0) return base.brighter(1.3).formatHex();
  if (era === 1) return base.brighter(0.55).formatHex();
  return base.darker(0.35).formatHex();
}

/**
 * Contour-mode outline inks, one per era — hues off the metric palette so the
 * outline, not the fill, is what says which era a mark belongs to.
 *
 * `null` means NO outline. The oldest era gets one: its former ink (#5B6470)
 * read as black on the page (Ita, 2026-09-18), and the pre-satellite record is
 * perfectly legible as the plain fill underneath the two contours that remain.
 */
const CONTOUR_INKS: (string | null)[] = [null, '#1F7A8C', '#B3236B'];

export interface EraInk {
  fill: string;
  fillOpacity: number;
  stroke: string;
  strokeWidth: number;
}

/**
 * Does this ink draw an outline at all? Contour style leaves the oldest era
 * fill-only, so every reader of `stroke` has to cope with there being none —
 * this is the one place that test is spelled out.
 */
export function hasOutline(ink: EraInk): boolean {
  return ink.strokeWidth > 0 && ink.stroke !== 'none';
}

/** What to draw an era's marks (bars, silhouette, dots, boundary) in, per style. */
export function eraInk(metric: MetricKey, era: number, style: EraStyle): EraInk {
  if (style === 'contour') {
    const outline =
      era < CONTOUR_INKS.length ? CONTOUR_INKS[era] : CONTOUR_INKS[CONTOUR_INKS.length - 1];
    return {
      fill: CONFIG.metricColors[metric]?.base ?? '#888888',
      fillOpacity: ERA_FILL_ALPHA,
      stroke: outline ?? 'none',
      strokeWidth: outline ? 1.5 : 0,
    };
  }
  const shade = eraColor(metric, era);
  return { fill: shade, fillOpacity: ERA_FILL_ALPHA, stroke: shade, strokeWidth: 1 };
}

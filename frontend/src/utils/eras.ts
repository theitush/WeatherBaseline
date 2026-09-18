import * as d3 from 'd3';
import CONFIG, { type MetricKey } from './config';

/** The year continuous global satellite coverage begins in the reanalysis —
 *  the same boundary MainChart draws its "Satellites!" line at. */
export const SATELLITE_YEAR = 1979;

/** Fill alpha every era's histogram shares; the eras are told apart by shade
 *  and outline, never by transparency. */
export const ERA_FILL_ALPHA = 0.45;

export interface Era {
  /** First year, inclusive. */
  from: number;
  /** Last year, inclusive. */
  to: number;
  /** "1950–78", "1979–2002" … the legend / tooltip label. */
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

/** Which era (index into eraSplit's array) a year belongs to. */
export function eraIndex(year: number, eras: Era[]): number {
  for (let i = eras.length - 1; i >= 0; i--) if (year >= eras[i].from) return i;
  return 0;
}

/**
 * The era's ink: three shades of the metric hue, lighter for the older eras and
 * the full base colour for the most recent one, so "darker = more recent" reads
 * the same way across every metric (including wind's grey).
 */
export function eraColor(metric: MetricKey, era: number): string {
  const base = d3.color(CONFIG.metricColors[metric]?.base ?? '#888888')!;
  if (era === 0) return base.brighter(1.3).formatHex();
  if (era === 1) return base.brighter(0.55).formatHex();
  return base.darker(0.35).formatHex();
}

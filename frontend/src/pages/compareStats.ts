// Day-of-year statistics for the comparison dials.
//
// One implementation, used twice: CompareRadialChart draws from these tracks,
// and ComparePage measures them to pick the dial's shared radius domain. Both
// must agree about what is on the dial — the domain is derived from what is
// actually DRAWN, so turning a layer off zooms the dial in on what is left.
import * as d3 from 'd3';
import type { MetricKey } from '../utils/config';
import type { WeatherDataPoint } from '../types';
import type { BandKey, Period, Series } from './compareTypes.ts';
import { BAND_SPECS, seriesPeriods } from './compareTypes.ts';

/** Day-of-year buckets. Leap day collapses onto ~Mar 1, so 365 of them. */
export const DOY_COUNT = 365;

/** Day-of-year [0,1) for the angular position (leap day collapses onto ~Mar 1). */
export const dayFraction = (d: Date): number => {
  const start = Date.UTC(d.getFullYear(), 0, 1);
  const here = Date.UTC(d.getFullYear(), d.getMonth(), d.getDate());
  const len = Date.UTC(d.getFullYear() + 1, 0, 1) - start;
  return (here - start) / len;
};

export const dayOfYear = (d: Date): number => Math.floor(dayFraction(d) * DOY_COUNT);

/** One archive day, in display units, ready to plot. */
export interface Pt {
  date: Date;
  doy: number;
  val: number;
  color: string;
}

/** A closed radial envelope: one lo/hi pair per day of the year. */
export interface BandPath {
  key: BandKey;
  opacity: number;
  points: { frac: number; lo: number; hi: number }[];
}

/**
 * One drawable line of a dial: a whole series, or one half of a split one.
 * Everything the chart draws hangs off a track, so a split series behaves
 * exactly like two series that happen to share a cell and a metric.
 */
export interface DialTrack {
  seriesId: string;
  half: Period['half'];
  color: string;
  label: string;
  /** Every day in the period. Drawn as the cloud in 'all' mode. */
  pts: Pt[];
  /** Enabled envelopes, widest first — which is also the draw order. */
  bands: BandPath[];
  /** Smoothed per-day median. Always computed: the difference shading needs
   *  it even when the median LINE is switched off. Null when too sparse. */
  median: { frac: number; val: number }[] | null;
  /** Same medians keyed by day, for the difference shading. */
  medianByDoy: Map<number, number>;
  /** Days beyond the 1–99 envelope. Empty unless the outlier layer is on. */
  outliers: Pt[];
}

/**
 * Circular moving average over day-of-year keys: the value at day d becomes the
 * mean of every day within `halfWindow` of it, wrapping Dec→Jan.
 *
 * A single day's quantile over 20-odd years is a small sample, so raw per-day
 * envelopes come out spiky and the median wanders enough that the difference
 * shading flickers colour every few days. Smoothing every curve with the same
 * window — the way a day-of-year climatology normally is — settles that, and
 * because the shading is built from these same arrays it always agrees with the
 * rings that bound it.
 */
export function smoothCircular(
  byDoy: Map<number, number>,
  halfWindow: number
): Map<number, number> {
  if (halfWindow <= 0) return byDoy;
  const out = new Map<number, number>();
  for (const doy of byDoy.keys()) {
    let sum = 0;
    let n = 0;
    for (let k = -halfWindow; k <= halfWindow; k++) {
      const v = byDoy.get((((doy + k) % DOY_COUNT) + DOY_COUNT) % DOY_COUNT);
      if (v === undefined) continue;
      sum += v;
      n++;
    }
    if (n > 0) out.set(doy, sum / n);
  }
  return out;
}

const toPath = (m: Map<number, number>) =>
  Array.from(m, ([doy, val]) => ({ frac: doy / DOY_COUNT, val })).sort(
    (a, b) => a.frac - b.frac
  );

/** A dial input: a configured series and the archive rows loaded for its cell. */
export interface TrackInput {
  series: Series;
  rows: WeatherDataPoint[];
}

/** Fewer distinct days than this and a curve is too sparse to draw. */
const MIN_DOYS = 8;

/**
 * Build one track per period across every series on a dial. `toDisplay` applies
 * the unit conversion (the caller owns the unit system).
 */
export function buildDialTracks(
  inputs: TrackInput[],
  toDisplay: (raw: number, metric: MetricKey) => number,
  pointMode: 'all' | 'percentile',
  bands: BandKey[]
): DialTrack[] {
  const tracks: DialTrack[] = [];
  for (const { series: s, rows } of inputs) {
    for (const period of seriesPeriods(s)) {
      const pts: Pt[] = [];
      for (const d of rows) {
        const raw = d[s.metric as MetricKey];
        if (raw === undefined) continue;
        const yr = d.date.getFullYear();
        if (yr < period.startYear || yr > period.endYear) continue;
        pts.push({
          date: d.date,
          doy: dayOfYear(d.date),
          val: toDisplay(raw, s.metric),
          color: period.color,
        });
      }

      const track: DialTrack = {
        seriesId: s.id,
        half: period.half,
        color: period.color,
        label: period.label,
        pts,
        bands: [],
        median: null,
        medianByDoy: new Map(),
        outliers: [],
      };
      tracks.push(track);
      if (pts.length === 0) continue;

      // Sort each day's values once; every quantile below reads from these.
      const sortedByDoy = new Map<number, number[]>();
      for (const p of pts) {
        const arr = sortedByDoy.get(p.doy);
        if (arr) arr.push(p.val);
        else sortedByDoy.set(p.doy, [p.val]);
      }
      for (const arr of sortedByDoy.values()) arr.sort(d3.ascending);
      if (sortedByDoy.size <= MIN_DOYS) continue;

      const quantileByDoy = (q: number) => {
        const m = new Map<number, number>();
        for (const [doy, vals] of sortedByDoy) {
          m.set(doy, d3.quantileSorted(vals, q) as number);
        }
        return smoothCircular(m, s.smoothDays);
      };

      const median = quantileByDoy(0.5);
      track.medianByDoy = median;
      track.median = toPath(median);

      if (pointMode !== 'percentile') continue;

      for (const spec of BAND_SPECS) {
        if (!bands.includes(spec.key)) continue;
        const lo = quantileByDoy(spec.lo);
        const hi = quantileByDoy(spec.hi);
        const points: BandPath['points'] = [];
        for (const [doy, l] of lo) {
          const h = hi.get(doy);
          if (h === undefined) continue;
          points.push({ frac: doy / DOY_COUNT, lo: l, hi: h });
        }
        points.sort((a, b) => a.frac - b.frac);
        track.bands.push({ key: spec.key, opacity: spec.opacity, points });
      }

      // Outliers are tested against the SAME smoothed 1–99 envelope the band
      // draws, so a dot never sits inside a band it is supposed to be outside.
      if (bands.includes('outliers')) {
        const p1 = quantileByDoy(0.01);
        const p99 = quantileByDoy(0.99);
        for (const p of pts) {
          const lo = p1.get(p.doy);
          const hi = p99.get(p.doy);
          if (lo === undefined || hi === undefined) continue;
          if (p.val < lo || p.val > hi) track.outliers.push(p);
        }
      }
    }
  }
  return tracks;
}

/**
 * The value extent of everything these tracks will actually draw. This is what
 * sets the dial's radius domain, so switching a layer off tightens the scale
 * onto what remains — which is how a half-degree difference between two periods
 * becomes visible on a dial whose daily cloud spans fifty.
 */
export function drawnExtent(
  tracks: DialTrack[],
  pointMode: 'all' | 'percentile'
): [number, number] | null {
  let min = Infinity;
  let max = -Infinity;
  const see = (v: number) => {
    if (v < min) min = v;
    if (v > max) max = v;
  };
  for (const t of tracks) {
    if (pointMode === 'all') for (const p of t.pts) see(p.val);
    else {
      for (const band of t.bands) {
        for (const pt of band.points) {
          see(pt.lo);
          see(pt.hi);
        }
      }
      for (const p of t.outliers) see(p.val);
    }
    if (t.median) for (const pt of t.median) see(pt.val);
  }
  return min <= max ? [min, max] : null;
}

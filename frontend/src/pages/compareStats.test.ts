// Standalone unit tests for the compare page's day-of-year statistics.
//
// Same setup as comparePeriodTest.test.ts — no test runner is installed, so this
// runs directly under Node's stripped-TS support:
//
//   node --experimental-strip-types src/pages/compareStats.test.ts
//
// Each assertion throws on failure; a clean exit (code 0) means all passed.

import { buildDialTracks, drawnExtent } from './compareStats.ts';
import { canSplit, seriesPeriodRanges } from './compareTypes.ts';
import type { Series } from './compareTypes.ts';
import { eraColor } from '../utils/eras.ts';
import type { WeatherDataPoint } from '../types/index.ts';

let passed = 0;
function assert(cond: boolean, msg: string): void {
  if (!cond) throw new Error(`FAIL: ${msg}`);
  passed++;
  console.log(`  ok - ${msg}`);
}

const series = (over: Partial<Series> = {}): Series => ({
  id: 's1',
  lat: 51.5,
  lon: -0.1,
  name: 'London',
  metric: 'max_temperature',
  startYear: 1981,
  endYear: 2026,
  color: '#FF8C42',
  markers: [],
  split: false,
  eraColors: {},
  diffShade: true,
  smoothDays: 0,
  ...over,
});

const isLeap = (y: number) => (y % 4 === 0 && y % 100 !== 0) || y % 400 === 0;

/** Every calendar day of one year, Jan 1 through Dec 31. */
function yearDays(year: number): Date[] {
  const out: Date[] = [];
  for (const d = new Date(year, 0, 1); d.getFullYear() === year; d.setDate(d.getDate() + 1)) {
    out.push(new Date(d));
  }
  return out;
}

// Leap years are left out so that Jan 1 — the day every quantile below is read
// off — holds exactly ONE value per year: in a leap year the extra day shifts
// the mapping and Jan 2 lands in Jan 1's bucket as well.
const YEARS = Array.from({ length: 46 }, (_, i) => 1981 + i).filter((y) => !isLeap(y));

// Every year contributes the same value to every one of its days, and the years
// form a ladder 0, 1, 2 … 34. Each day of the year therefore sees that whole
// ladder, whose quantiles are known exactly — so the band edges can be checked
// against arithmetic rather than eyeballed.
const ladderRows: WeatherDataPoint[] = YEARS.flatMap((year, rank) =>
  yearDays(year).map(
    (date) =>
      ({ date, max_temperature: rank, data_type: 'historical' }) as WeatherDataPoint
  )
);

// A second ladder over the FULL ERA5-Land record, so the era cases have days on
// both sides of 1979 and of 2000. Leap years are dropped for the same reason as
// above, though nothing below reads a single day's quantile.
const ERA_YEARS = Array.from({ length: 77 }, (_, i) => 1950 + i).filter((y) => !isLeap(y));
const eraRows: WeatherDataPoint[] = ERA_YEARS.flatMap((year, rank) =>
  yearDays(year).map(
    (date) =>
      ({ date, max_temperature: rank, data_type: 'historical' }) as WeatherDataPoint
  )
);

const asIs = (v: number) => v;
const N = YEARS.length; // 35 rungs, values 0…34
const TOP = N - 1;

// The theme only picks which row of the era ramp the colors come off; every
// case below that is not about color pins it to light so nothing moves.
const LIGHT = 'light' as const;

// --- Case 1: the two bands exist, widest first -------------------------------
{
  console.log('Case 1: 10–90 and 25–75, in draw order');
  const [track] = buildDialTracks(
    [{ series: series(), rows: ladderRows }],
    asIs,
    ['p10_90', 'p25_75', 'median'],
    LIGHT
  );
  assert(
    track.bands.map((b) => b.key).join(',') === 'p10_90,p25_75',
    'both envelopes are built, the wider one first so it sits underneath'
  );
  assert(
    track.bands[0].opacity < track.bands[1].opacity,
    'and the wider one is the paler of the two'
  );
  assert(
    track.bands[0].points.length === track.median!.length &&
      track.bands[0].points.length > 340,
    'each band closes over the same ring of days as the median'
  );
}

// --- Case 2: the quantiles are the ones the labels promise -------------------
{
  console.log('Case 2: the edges land on the right values');
  const [track] = buildDialTracks(
    [{ series: series(), rows: ladderRows }],
    asIs,
    ['p10_90', 'p25_75'],
    LIGHT
  );
  // Jan 1, the first point of each ring: the whole 0…34 ladder, one rung per
  // year. d3.quantileSorted interpolates at q * (n - 1) = q * 34.
  const wide = track.bands[0].points[0];
  const tight = track.bands[1].points[0];
  assert(wide.lo === 0.1 * TOP, `the 10th percentile of 0…${TOP} is ${0.1 * TOP}`);
  assert(wide.hi === 0.9 * TOP, `the 90th is ${0.9 * TOP}`);
  assert(tight.lo === 0.25 * TOP, `the 25th is ${0.25 * TOP}`);
  assert(tight.hi === 0.75 * TOP, `the 75th is ${0.75 * TOP}`);
  assert(
    wide.lo < tight.lo && wide.hi > tight.hi,
    '10–90 encloses 25–75, so the tighter band draws on top of it'
  );
  assert(track.median![0].val === 0.5 * TOP, 'and the median ring sits on the middle rung');
}

// --- Case 3: an unticked band is simply not built ----------------------------
{
  console.log('Case 3: the tick boxes are the only thing that selects a band');
  const [only] = buildDialTracks(
    [{ series: series(), rows: ladderRows }],
    asIs,
    ['p25_75'],
    LIGHT
  );
  assert(only.bands.length === 1 && only.bands[0].key === 'p25_75', 'one box, one band');
  const [none] = buildDialTracks([{ series: series(), rows: ladderRows }], asIs, [], LIGHT);
  assert(none.bands.length === 0, 'no boxes, no bands');
  assert(none.median !== null, 'the median is still computed — the diff shading needs it');
  assert(none.pts.length === ladderRows.length, 'and every day is still on the dial');
}

// --- Case 4: the domain comes from the full cloud ----------------------------
{
  console.log('Case 4: the extent is the cloud, whatever is ticked');
  const all = drawnExtent(
    buildDialTracks(
      [{ series: series(), rows: ladderRows }],
      asIs,
      ['p10_90', 'p25_75', 'median'],
      LIGHT
    )
  );
  const bare = drawnExtent(
    buildDialTracks([{ series: series(), rows: ladderRows }], asIs, [], LIGHT)
  );
  assert(all !== null && all[0] === 0 && all[1] === TOP, 'it spans the coldest and hottest day');
  assert(
    JSON.stringify(all) === JSON.stringify(bare),
    'and does not move when the bands are switched off, so nothing is ever clipped'
  );
  assert(drawnExtent([]) === null, 'nothing drawn, no domain');
}

// --- Case 5: the day window applies to the bands too -------------------------
{
  console.log('Case 5: smoothing reaches the envelopes, not just the median');
  // A saw-tooth in the day of the year: every even day sits at 0, every odd one
  // at 10, with a small per-year rung on top so each day still has a spread to
  // take quantiles of. Raw, the band edges alternate between the two teeth; with
  // a ±7-day window they have to settle near the middle — which they only can if
  // the smoothing is applied to the envelope and not just to the median.
  const sawRows: WeatherDataPoint[] = YEARS.flatMap((year, rank) =>
    yearDays(year).map((date, doy) => ({
      date,
      max_temperature: (doy % 2) * 10 + rank * 0.1,
      data_type: 'historical',
    }) as WeatherDataPoint)
  );
  const band = (smoothDays: number) =>
    buildDialTracks(
      [{ series: series({ smoothDays }), rows: sawRows }],
      asIs,
      ['p10_90'],
      LIGHT
    )[0].bands[0].points;

  const raw = band(0);
  const smooth = band(7);
  const onATooth = raw.filter((p) => Math.min(Math.abs(p.lo), Math.abs(p.lo - 10)) < 2).length;
  const settled = smooth.filter((p) => Math.abs(p.lo - 5) < 2).length;
  assert(onATooth > raw.length * 0.9, 'raw, the band edge sits on one tooth or the other');
  assert(settled > smooth.length * 0.9, 'smoothed, it settles between them — the window reached it');
  assert(raw.length === smooth.length, 'and smoothing never changes how many days are on the ring');
}

// --- Case 6: a split series is cut into the MAIN PAGE's eras -----------------
{
  console.log('Case 6: a range straddling 1979 and 2000 draws three era rings');
  const split = series({ startYear: 1950, endYear: 2026, split: true });
  const tracks = buildDialTracks([{ series: split, rows: eraRows }], asIs, ['median'], LIGHT);

  assert(tracks.length === 3, 'a 1950–2026 range carries all three eras, so it draws three rings');
  assert(
    tracks.map((t) => t.label).join(' | ') === '1950–1978 | 1979–1999 | 2000–2026',
    'and the cuts are eraSplit’s fixed years, not a midpoint of the range'
  );
  assert(
    tracks.map((t) => t.era).join(',') === '0,1,2',
    'each track carries its era index, oldest first — which is the order the gap shading walks'
  );
  const bounds = [
    [1950, 1978],
    [1979, 1999],
    [2000, 2026],
  ];
  assert(
    tracks.every((t, i) =>
      t.pts.every(
        (p) =>
          p.date.getFullYear() >= bounds[i][0] && p.date.getFullYear() <= bounds[i][1]
      )
    ),
    'and each ring holds only the days of its own era'
  );
  // Disjoint: the three clouds partition the range, no year counted twice.
  const whole = buildDialTracks(
    [{ series: series({ startYear: 1950, endYear: 2026 }), rows: eraRows }],
    asIs,
    ['median'],
    LIGHT
  );
  assert(
    tracks.reduce((n, t) => n + t.pts.length, 0) === whole[0].pts.length,
    'the eras partition the range — every day is on exactly one ring'
  );
}

// --- Case 7: the default colours are the main page's era colours -------------
{
  console.log('Case 7: era colours by default, overridable per era');
  const split = series({ startYear: 1950, endYear: 2026, split: true });
  const light = buildDialTracks([{ series: split, rows: eraRows }], asIs, [], LIGHT);
  assert(
    light.every((t) => t.color === eraColor('max_temperature', t.era, 'light')),
    'each ring opens in the colour the main page paints that era of this metric'
  );

  const dark = buildDialTracks([{ series: split, rows: eraRows }], asIs, [], 'dark');
  assert(
    dark.every((t) => t.color === eraColor('max_temperature', t.era, 'dark')),
    'and follows the theme, because the ramp has a row per theme'
  );
  assert(
    light[0].color !== dark[0].color,
    'the two themes really are different colours, so that check means something'
  );

  const wind = buildDialTracks(
    [{ series: series({ startYear: 1950, endYear: 2026, split: true, metric: 'wind_speed_10m_max' }), rows: eraRows }],
    asIs,
    [],
    LIGHT
  );
  assert(
    wind.every((t) => t.color === eraColor('wind_speed_10m_max', t.era, 'light')),
    'a different metric gets its own hue, same as the histogram'
  );

  const overridden = buildDialTracks(
    [{ series: series({ startYear: 1950, endYear: 2026, split: true, eraColors: { 1: '#123456' } }), rows: eraRows }],
    asIs,
    [],
    LIGHT
  );
  assert(overridden[1].color === '#123456', 'a user override wins for the era it names');
  assert(
    overridden[0].color === eraColor('max_temperature', 0, 'light') &&
      overridden[2].color === eraColor('max_temperature', 2, 'light'),
    'and leaves the other eras on their defaults'
  );
}

// --- Case 8: a range that does not reach both cuts ---------------------------
{
  console.log('Case 8: fewer eras when the range does not reach the cuts');
  const narrow = series({ startYear: 1990, endYear: 2020, split: true });
  const tracks = buildDialTracks([{ series: narrow, rows: eraRows }], asIs, [], LIGHT);
  assert(tracks.length === 2, '1990–2020 has no pre-satellite era, so it draws two rings');
  assert(
    tracks.map((t) => `${t.era}:${t.label}`).join(' | ') === '1:1990–1999 | 2:2000–2020',
    'the labels are clamped to the range while the era indices — and so the colours — are not'
  );
  assert(
    tracks[0].color === eraColor('max_temperature', 1, 'light'),
    'so 1990–1999 is painted in era 1, not era 0'
  );

  const inside = { startYear: 1985, endYear: 1995, split: true };
  assert(!canSplit(inside), 'a range inside one era has nothing to split into');
  const one = buildDialTracks(
    [{ series: series(inside), rows: eraRows }],
    asIs,
    [],
    LIGHT
  );
  assert(one.length === 1 && one[0].era === -1, 'it draws one whole-range ring instead');
  assert(one[0].color === '#FF8C42', 'in the series colour, since no era owns it');
  assert(
    seriesPeriodRanges(inside).map((p) => p.label).join('') === '1985–1995',
    'and the one period is labelled with the range the user asked for'
  );
}

console.log(`\nAll ${passed} assertions passed.`);

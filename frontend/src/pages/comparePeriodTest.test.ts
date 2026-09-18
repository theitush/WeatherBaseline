// Standalone unit tests for the compare page's year-shuffle period test.
//
// Same setup as permutationTest.test.ts — no test runner is installed, so this
// runs directly under Node's stripped-TS support:
//
//   node --experimental-strip-types src/pages/comparePeriodTest.test.ts
//
// Each assertion throws on failure; a clean exit (code 0) means all passed.

import { extractSamples, periodShuffleTest, statisticFor } from './comparePeriodTest.ts';
import { periodTestWindows, seriesPeriodRanges } from './compareTypes.ts';
import type { WeatherDataPoint } from '../types/index.ts';

let passed = 0;
function assert(cond: boolean, msg: string): void {
  if (!cond) throw new Error(`FAIL: ${msg}`);
  passed++;
  console.log(`  ok - ${msg}`);
}

// A deterministic generator so the tests never flake: a seasonal cycle plus
// reproducible pseudo-random daily noise, with a per-day offset the caller
// controls. `shift(doy, year)` is what each case uses to inject a signal.
function makeRows(
  startYear: number,
  endYear: number,
  shift: (doy: number, year: number) => number,
  seed = 7
): WeatherDataPoint[] {
  let a = seed >>> 0;
  const rand = () => {
    a = (a + 0x6d2b79f5) | 0;
    let t = Math.imul(a ^ (a >>> 15), 1 | a);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
  const rows: WeatherDataPoint[] = [];
  for (let year = startYear; year <= endYear; year++) {
    for (let doy = 0; doy < 365; doy++) {
      const seasonal = 15 - 10 * Math.cos((2 * Math.PI * doy) / 365);
      // Two draws averaged — a blunt way to get a non-uniform daily spread.
      const noise = (rand() + rand() - 1) * 6;
      const date = new Date(year, 0, 1);
      date.setDate(date.getDate() + doy);
      rows.push({
        date,
        max_temperature: seasonal + noise + shift(doy, year),
        data_type: 'historical',
      } as WeatherDataPoint);
    }
  }
  return rows;
}

const EARLY = { startYear: 1980, endYear: 2003 };
const LATE = { startYear: 2004, endYear: 2026 };
const asIs = (v: number) => v;
const samples = (rows: WeatherDataPoint[], minYear = 1980, maxYear = 2026) =>
  extractSamples(rows, 'max_temperature', minYear, maxYear, asIs);
const run = (rows: WeatherDataPoint[], nPerm = 400) =>
  periodShuffleTest(samples(rows), EARLY, LATE, 'median', { nPerm, seed: 11 });

// --- Case 1: nothing changed -------------------------------------------------
{
  console.log('Case 1: both halves drawn from the same climate');
  const res = run(makeRows(1980, 2026, () => 0));
  if (!res) throw new Error('FAIL: expected a result');
  assert(res.nEarlyYears === 24 && res.nLateYears === 23, 'the piles are 24 and 23 years');
  assert(res.nWeeks === 52, 'all 52 weeks are covered by both halves');
  assert(Math.abs(res.signedGap) < 0.5, 'the signed gap is near zero');
  assert(res.pSigned > 0.1, 'a quiet split is not called significant');
  assert(res.pAbs > 0.1, 'nor is its ribbon width');
  assert(res.nullAbsGap > 0, 'random splits still produce a ribbon — the noise floor');
  assert(
    Math.abs(res.absGap - res.nullAbsGap) < res.nullAbsGap,
    'the observed ribbon is the same order as the noise floor'
  );
  assert(Math.abs(res.percentile - 50) < 8, 'a typical late day sits near the 50th percentile');
}

// --- Case 2: the late half is uniformly warmer -------------------------------
{
  console.log('Case 2: +2C on every day of the late half');
  const res = run(makeRows(1980, 2026, (_doy, year) => (year >= 2004 ? 2 : 0)));
  if (!res) throw new Error('FAIL: expected a result');
  assert(Math.abs(res.signedGap - 2) < 0.6, 'the signed gap recovers the +2C shift');
  assert(res.pSigned <= 1 / 401 + 1e-12, 'a real shift gets the smallest p the run can resolve');
  assert(res.pAbs <= 1 / 401 + 1e-12, 'and so does the ribbon width');
  assert(res.percentile > 55, 'a typical late day now sits high in the early spread');
  assert(res.absGap > res.nullAbsGap, 'the ribbon is wider than a random split makes');
}

// --- Case 3: THE one a signed average misses --------------------------------
{
  console.log('Case 3: late half warmer for half the year, cooler for the other half');
  // +3C over the first half of the calendar, -3C over the second: the signed
  // average cancels to nothing while the year's shape has changed a lot.
  const res = run(
    makeRows(1980, 2026, (doy, year) => (year >= 2004 ? (doy < 182 ? 3 : -3) : 0))
  );
  if (!res) throw new Error('FAIL: expected a result');
  assert(Math.abs(res.signedGap) < 0.6, 'the signed gap cancels to about zero');
  assert(res.pSigned > 0.1, 'so the signed test correctly reports no net warming');
  assert(res.absGap > 2.4, 'the absolute gap sees the change the signed one missed');
  assert(res.pAbs <= 1 / 401 + 1e-12, 'and calls it significant');
  assert(Math.abs(res.percentile - 50) < 10, 'the percentile, being signed too, stays near 50');
}

// --- Case 4: direction is kept ----------------------------------------------
{
  console.log('Case 4: the late half is colder');
  const res = run(makeRows(1980, 2026, (_doy, year) => (year >= 2004 ? -2 : 0)));
  if (!res) throw new Error('FAIL: expected a result');
  assert(res.signedGap < -1.4, 'the signed gap is negative for a cooling');
  assert(res.pSigned <= 1 / 401 + 1e-12, 'two-sided: a cooling is as extreme as a warming');
  assert(res.percentile < 45, 'a typical late day now sits low in the early spread');
}

// --- Case 5: p-values are probabilities, and reproducible --------------------
{
  console.log('Case 5: p-value conventions');
  const rows = makeRows(1980, 2026, () => 0);
  const a = run(rows);
  const b = run(rows);
  if (!a || !b) throw new Error('FAIL: expected results');
  assert(a.pSigned === b.pSigned && a.pAbs === b.pAbs, 'the seeded run is reproducible');
  assert(a.pSigned > 0 && a.pSigned <= 1, 'p is in (0, 1] — never exactly zero');
  assert(a.pAbs > 0 && a.pAbs <= 1, 'the same holds for the ribbon p');
}

// --- Case 6: too little to test ---------------------------------------------
{
  console.log('Case 6: not enough years to shuffle');
  const rows = makeRows(2002, 2005, () => 0);
  const res = periodShuffleTest(
    samples(rows, 2002, 2005),
    { startYear: 2002, endYear: 2003 },
    { startYear: 2004, endYear: 2005 },
    'median',
    { nPerm: 100 }
  );
  assert(res !== null, 'two years a side is the minimum, and it is allowed');
  const tooFew = periodShuffleTest(
    samples(makeRows(2003, 2004, () => 0), 2003, 2004),
    { startYear: 2003, endYear: 2003 },
    { startYear: 2004, endYear: 2004 },
    'median',
    { nPerm: 100 }
  );
  assert(tooFew === null, 'one year a side cannot be shuffled, so it returns null');
  assert(periodShuffleTest(samples([]), EARLY, LATE, 'median') === null, 'no rows, no test');
}

// --- Case 7: precipitation compares its wet tail ----------------------------
{
  console.log('Case 7: the statistic follows the metric');
  assert(statisticFor('max_temperature') === 'median', 'temperature is compared on the median');
  assert(statisticFor('wind_speed_10m_max') === 'median', 'so is wind');
  assert(
    statisticFor('precipitation_sum') === 'p90',
    "precip uses its wet tail — its median is 0 and would report 'no change'"
  );
}

// --- Case 8: three eras, one question ---------------------------------------
{
  console.log('Case 8: the windows a three-era split hands the test');
  // A range straddling BOTH cuts, which is the ordinary case for an ERA5-Land
  // cell: 1950 to now carries all three eras.
  const ranges = seriesPeriodRanges({ startYear: 1950, endYear: 2026, split: true });
  assert(
    ranges.map((p) => p.label).join(' | ') === '1950–1978 | 1979–1999 | 2000–2026',
    'the split is the main page’s three eras'
  );

  const windows = periodTestWindows(ranges);
  if (!windows) throw new Error('FAIL: expected two windows');
  assert(windows.late.label === '2000–2026', 'the LATEST era is one pile');
  assert(
    windows.early.startYear === 1950 && windows.early.endYear === 1999,
    'and everything before it, pooled into one contiguous window, is the other'
  );
  assert(windows.early.label === '1950–1999', 'which is what the sentence names it');
  assert(windows.early.era === -1, 'a pooled span is no single era, so it has no era colour');

  // The pooled split still recovers a shift applied from 2000 on.
  const rows = makeRows(1950, 2026, (_doy, year) => (year >= 2000 ? 2 : 0));
  const res = periodShuffleTest(
    samples(rows, 1950, 2026),
    windows.early,
    windows.late,
    'median',
    { nPerm: 400, seed: 11 }
  );
  if (!res) throw new Error('FAIL: expected a result');
  assert(res.nEarlyYears === 50 && res.nLateYears === 27, 'the piles are 50 and 27 years');
  assert(Math.abs(res.signedGap - 2) < 0.6, 'and the signed gap recovers the +2C shift');
  assert(res.pSigned <= 1 / 401 + 1e-12, 'which a random deal of these years does not reach');

  // Two eras when the range reaches only one cut, and nothing to test inside one.
  const narrow = periodTestWindows(
    seriesPeriodRanges({ startYear: 1990, endYear: 2020, split: true })
  );
  if (!narrow) throw new Error('FAIL: expected two windows');
  assert(
    narrow.early.label === '1990–1999' && narrow.late.label === '2000–2020',
    'with two eras the older pile is just the older era, clamped to the range'
  );
  assert(narrow.early.era === 1, 'and it keeps that era’s identity, since it is only the one');
  assert(
    periodTestWindows(seriesPeriodRanges({ startYear: 1985, endYear: 1995, split: true })) ===
      null,
    'a range inside a single era has nothing to compare, so there is no test'
  );
}

console.log(`\nAll ${passed} assertions passed.`);

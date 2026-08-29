// Standalone unit tests for the record/climatology pools.
//
// Same setup as permutationTest.test.ts and recordScale.test.ts — no test runner
// is installed, so this runs directly under Node's stripped-TS support:
//
//   node --experimental-strip-types src/utils/dataProcessor.test.ts
//
// Each assertion throws on failure; a clean exit (code 0) means all passed.

import { comparablePool, findRecords, isModelRow, observedPool } from './dataProcessor.ts';
import type { WeatherDataPoint } from '../types/index.ts';

let passed = 0;
function assert(cond: boolean, msg: string): void {
  if (!cond) throw new Error(`FAIL: ${msg}`);
  passed++;
  console.log(`  ok - ${msg}`);
}

// A day in the ±window. `value` lands on whichever metric the case is testing.
function day(
  dateString: string,
  dataType: WeatherDataPoint['data_type'],
  metric: 'max_temperature' | 'precipitation_sum',
  value: number
): WeatherDataPoint {
  const date = new Date(dateString + 'T00:00:00');
  return { date, year: date.getFullYear(), data_type: dataType, [metric]: value };
}

// --- Case 1: a forecast day is never the record ------------------------------
{
  console.log('Case 1: the star ignores forecast rows');
  // Target 2026-07-12, inside the forecast horizon: the hottest number in the
  // window belongs to a forecast day dated BEFORE the target, so comparablePool
  // keeps it and only findRecords can throw it out.
  const rows = [
    day('1998-07-11', 'historical', 'max_temperature', 38),
    day('2011-07-13', 'historical', 'max_temperature', 21),
    day('2026-07-10', 'forecast', 'max_temperature', 44), // hotter, but a guess
    day('2026-07-11', 'forecast', 'max_temperature', 12), // colder, but a guess
  ];
  const pool = comparablePool(rows, '2026-07-12');
  assert(pool.length === 4, 'comparablePool keeps forecast rows at/before the target');

  const { hiRow, loRow } = findRecords(pool, 'max_temperature');
  assert(hiRow?.max_temperature === 38, 'record high is the archive day, not the hotter forecast');
  assert(loRow?.max_temperature === 21, 'record low is the archive day, not the colder forecast');
}

// --- Case 2: recent-tier precip/wind are model rows too ----------------------
{
  console.log('Case 2: recent-tier precip is IFS output, not era5_land');
  const rows = [
    day('2003-09-02', 'historical', 'precipitation_sum', 40),
    day('2019-09-03', 'historical', 'precipitation_sum', 0),
    day('2026-09-01', 'recent', 'precipitation_sum', 90), // wetter, but modelled
  ];
  const { hiRow } = findRecords(rows, 'precipitation_sum');
  assert(hiRow?.precipitation_sum === 40, 'the wettest recent-tier day cannot take the star');
  assert(
    observedPool(rows, 'precipitation_sum').length === 2,
    'observedPool drops the recent-tier precip row'
  );
}

// --- Case 3: recent-tier TEMPERATURE is settled era5_land --------------------
{
  console.log('Case 3: recent-tier temperature still counts');
  const rows = [
    day('2003-09-02', 'historical', 'max_temperature', 30),
    day('2026-09-01', 'recent', 'max_temperature', 35),
  ];
  const { hiRow } = findRecords(rows, 'max_temperature');
  assert(hiRow?.max_temperature === 35, 'a recent-tier temperature CAN be the record');
  assert(observedPool(rows, 'max_temperature').length === 2, 'observedPool keeps both rows');
}

// --- Case 4: isModelRow is the one rule, and it is metric-dependent ----------
{
  console.log('Case 4: isModelRow');
  const recent = day('2026-09-01', 'recent', 'max_temperature', 20);
  const forecast = day('2026-09-05', 'forecast', 'max_temperature', 20);
  const archive = day('1975-09-01', 'historical', 'max_temperature', 20);
  assert(isModelRow(forecast, 'max_temperature'), 'forecast rows are model rows for every metric');
  assert(isModelRow(recent, 'precipitation_sum'), 'recent precip is a model row');
  assert(isModelRow(recent, 'wind_speed_10m_max'), 'recent wind is a model row');
  assert(!isModelRow(recent, 'max_temperature'), 'recent temperature is not a model row');
  assert(!isModelRow(recent, 'min_temperature'), 'recent min temperature is not a model row');
  assert(!isModelRow(archive, 'precipitation_sum'), 'archive rows are never model rows');
}

// --- Case 5: the star and the rank read the same days ------------------------
{
  console.log('Case 5: the record pool and the rarity pool agree');
  const rows = [
    day('1998-07-11', 'historical', 'max_temperature', 38),
    day('2011-07-13', 'historical', 'max_temperature', 21),
    day('2026-07-10', 'forecast', 'max_temperature', 44),
  ];
  const { hiRow } = findRecords(comparablePool(rows, '2026-07-12'), 'max_temperature');
  const rarity = observedPool(rows, 'max_temperature').map((d) => d.max_temperature as number);
  // Nothing in the pool the prose ranks against beats the day wearing the star,
  // so "the Nth hottest" can never contradict the record marker.
  assert(
    Math.max(...rarity) === (hiRow?.max_temperature as number),
    'the rarity pool has no day hotter than the record star'
  );
}

// --- Case 6: an empty pool is not a record -----------------------------------
{
  console.log('Case 6: nothing to rank');
  const onlyModel = [day('2026-07-10', 'forecast', 'max_temperature', 44)];
  const { hiRow, loRow } = findRecords(onlyModel, 'max_temperature');
  assert(hiRow === null && loRow === null, 'an all-forecast pool yields no record rows');
}

console.log(`\n${passed} assertions passed.`);

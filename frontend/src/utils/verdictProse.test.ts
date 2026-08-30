// Standalone unit tests for the shared prose ladder.
//
// Same setup as the other tests in this folder — no test runner is installed, so
// this runs directly under Node's stripped-TS support:
//
//   node --experimental-strip-types src/utils/verdictProse.test.ts
//
// Each assertion throws on failure; a clean exit (code 0) means all passed.
//
// What's pinned: the two POOLS (the card's ±3-day window vs the dial's whole
// record) and the two STYLES (the card's surprise banks vs the dial's descriptive
// phrases) must produce their exact sentences off one function — that shared
// ladder is the whole point, so a wording drift has to fail here.

import { resolveVerdictProse, type PoolPhrasing } from './verdictProse.ts';
import type { MetricBand } from '../types/index.ts';

let passed = 0;
function assert(cond: boolean, msg: string): void {
  if (!cond) throw new Error(`FAIL: ${msg}`);
  passed++;
  console.log(`  ok - ${msg}`);
}
function assertEq(actual: unknown, expected: unknown, msg: string): void {
  if (actual !== expected) {
    throw new Error(`FAIL: ${msg}\n    expected: ${JSON.stringify(expected)}\n    actual:   ${JSON.stringify(actual)}`);
  }
  passed++;
  console.log(`  ok - ${msg}`);
}

// The card names a seasonal window; the dial names the whole record.
const CARD_POOL: PoolPhrasing = { quantifier: '', scope: ' within ±3 days of Aug 30th' };
const YEAR_POOL: PoolPhrasing = { quantifier: 'all ', scope: ' since 1950' };

// Evenly spaced pools so every rank/percentile is exact arithmetic.
const ramp = (n: number) => Array.from({ length: n }, (_, i) => i);
const WINDOW_100 = ramp(100);
const RECORD_1000 = ramp(1000);
// The dial passes the SAME array as both pools — the whole record IS the pool.
const RECORD_400 = ramp(400);

// A symmetric band of the given half-width around `mid`.
const bandAround = (mid: number, w: number): MetricBand => ({
  q01: mid - 2.5 * w, lo: mid - 1.8 * w, q10: mid - 1.3 * w, q25: mid - 0.7 * w,
  mid, q75: mid + 0.7 * w, q90: mid + 1.3 * w, hi: mid + 1.8 * w, q99: mid + 2.5 * w,
});

const VERDICT_NOTABLE = ['Notable.', 'Almost exciting.', 'A bit unusual.', 'Mildly interesting.'];
const VERDICT_MILD = ['Very average.', 'Totally normal.', 'Boring.', 'Meh.'];

// --- Case 1: the same day, the two pools, the two styles ---------------------
{
  console.log('Case 1: notable high side — card pool vs whole-year pool');
  // 85 in 0..99: 15 days at-or-above -> a 15% single tail -> the notable tier.
  const card = resolveVerdictProse({
    displayValue: 85, band: null, windowNative: WINDOW_100, allTimeNative: RECORD_1000,
    metric: 'max_temperature', system: 'metric', pool: CARD_POOL, style: 'surprise',
  })!;
  assertEq(card.tier, 'notable', 'card lands on the notable tier');
  assertEq(
    card.rarityLine,
    'About 15% of days within ±3 days of Aug 30th were this hot or hotter.',
    'card rarity names the ±3-day window'
  );
  assert(VERDICT_NOTABLE.includes(card.verdict), 'card verdict comes from the surprise notable bank');

  const dial = resolveVerdictProse({
    displayValue: 85, band: null, windowNative: WINDOW_100, allTimeNative: RECORD_1000,
    metric: 'max_temperature', system: 'metric', pool: YEAR_POOL, style: 'descriptive',
  })!;
  assertEq(
    dial.rarityLine,
    'About 15% of all days since 1950 were this hot or hotter.',
    'dial rarity says "all days since 1950"'
  );
  assertEq(dial.verdict, 'Hotter than most.', 'dial verdict is the fixed notable phrase');
}

// --- Case 2: the mild tiers — percentile, not a punchline --------------------
{
  console.log('Case 2: mild tiers on the whole-year pool');
  // 50 in 0..99 sits dead centre; 51 days are at or below it.
  const dead = resolveVerdictProse({
    displayValue: 50, band: null, windowNative: WINDOW_100, allTimeNative: RECORD_1000,
    metric: 'max_temperature', system: 'metric', pool: YEAR_POOL, style: 'descriptive',
  })!;
  assertEq(dead.tier, 'mildDead', 'dead-centre value lands on mildDead');
  assertEq(dead.verdict, 'A typical day here.', 'mildDead verdict');
  assertEq(dead.rarityLine, 'Warmer than about 50% of all days since 1950.', 'mildDead percentile line');

  // 30 in 0..99 is on the cold side: 70 days are warmer.
  const off = resolveVerdictProse({
    displayValue: 30, band: null, windowNative: WINDOW_100, allTimeNative: RECORD_1000,
    metric: 'max_temperature', system: 'metric', pool: YEAR_POOL, style: 'descriptive',
  })!;
  assertEq(off.tier, 'mildOff', 'off-centre value lands on mildOff');
  assertEq(off.verdict, 'A shade colder than the typical day here.', 'mildOff verdict takes the low-side word');
  assertEq(off.rarityLine, 'Colder than about 69% of all days since 1950.', 'mildOff percentile counts the strictly warmer days');

  // The card keeps its playful wording on the very same day.
  const card = resolveVerdictProse({
    displayValue: 50, band: null, windowNative: WINDOW_100, allTimeNative: RECORD_1000,
    metric: 'max_temperature', system: 'metric', pool: CARD_POOL, style: 'surprise',
  })!;
  assert(VERDICT_MILD.includes(card.verdict), 'card verdict comes from the surprise mild bank');
  assert(
    card.rarityLine!.endsWith(' for days within ±3 days of Aug 30th.'),
    'card keeps the dead-centre flavour line'
  );

  // Min temperature describes the pool as nights, in both styles.
  const night = resolveVerdictProse({
    displayValue: 50, band: null, windowNative: WINDOW_100, allTimeNative: RECORD_1000,
    metric: 'min_temperature', system: 'metric', pool: YEAR_POOL, style: 'descriptive',
  })!;
  assertEq(night.verdict, 'A typical night here.', 'min temperature says "night"');
  assertEq(night.rarityLine, 'Warmer than about 50% of all nights since 1950.', 'min temperature says "nights"');
}

// --- Case 3: the dial's pool is its own all-time pool ------------------------
{
  console.log('Case 3: whole-year pool passed as BOTH pools');
  // The top 10 of the record are absorbed by the all-time tier, so 'extreme' on
  // this pool starts at rank 11. 385 in 0..399 is 15th from the top -> 3.75%.
  const extreme = resolveVerdictProse({
    displayValue: 385, band: null, windowNative: RECORD_400, allTimeNative: RECORD_400,
    metric: 'max_temperature', system: 'metric', pool: YEAR_POOL, style: 'descriptive',
  })!;
  assertEq(extreme.tier, 'extreme', 'rank 15 of 400 is the extreme tier, not all-time');
  assertEq(extreme.verdict, 'Among the hottest days of the year.', 'extreme verdict');
  assertEq(extreme.rarityLine, 'Only 3.8% of all days since 1950 were this hot!', 'extreme rarity line');

  // Top-10 of the record: the one tier that keeps the card's bank on both styles.
  const allTime = resolveVerdictProse({
    displayValue: 399, band: null, windowNative: RECORD_400, allTimeNative: RECORD_400,
    metric: 'max_temperature', system: 'metric', pool: YEAR_POOL, style: 'descriptive',
  })!;
  assertEq(allTime.tier, 'alltime', 'the record high is the all-time tier');
  assertEq(allTime.rarityLine, 'One of the hottest days EVER recorded!!!', 'all-time line is scope, not a %');
  assertEq(allTime.allTimeRank, 1, 'all-time rank is reported for the confetti');

  // The low side swaps every direction word.
  const cold = resolveVerdictProse({
    displayValue: 14, band: null, windowNative: RECORD_400, allTimeNative: RECORD_400,
    metric: 'max_temperature', system: 'metric', pool: YEAR_POOL, style: 'descriptive',
  })!;
  assertEq(cold.verdict, 'Among the coldest days of the year.', 'low side reads coldest');
  assertEq(cold.rarityLine, 'Only 3.8% of all days since 1950 were this cold!', 'low side rarity line');
}

// --- Case 4: a forecast row states the confidence, in both pools -------------
{
  console.log('Case 4: forecast row — the ~C% chance line');
  const tight = resolveVerdictProse({
    displayValue: 385, band: bandAround(385, 1), windowNative: RECORD_400, allTimeNative: RECORD_400,
    metric: 'max_temperature', system: 'metric', pool: YEAR_POOL, style: 'descriptive',
  })!;
  assertEq(tight.tier, 'extreme', 'a forecast median in the top 5% is the extreme tier');
  assert(tight.isVeryExtremeForecast, 'a tight band clears the 80% confidence bar');
  assertEq(tight.verdict, 'Among the hottest days of the year.', 'confident forecast keeps the plain phrase');
  assertEq(
    tight.rarityLine,
    "There's a ~95% chance that this day will be in the top 5% hottest days since 1950.",
    'forecast rarity is the plain-English confidence statement'
  );

  // A band wide enough to straddle the cutoff softens the same phrase.
  const loose = resolveVerdictProse({
    displayValue: 385, band: bandAround(385, 20), windowNative: RECORD_400, allTimeNative: RECORD_400,
    metric: 'max_temperature', system: 'metric', pool: YEAR_POOL, style: 'descriptive',
  })!;
  assert(!loose.isVeryExtremeForecast, 'a wide band misses the 80% bar');
  assertEq(loose.verdict, 'Probably among the hottest days of the year.', 'hedged forecast verdict');

  // Same forecast, the card's pool: identical shape, its own scope clause.
  const card = resolveVerdictProse({
    displayValue: 385, band: bandAround(385, 1), windowNative: RECORD_400, allTimeNative: RECORD_400,
    metric: 'max_temperature', system: 'metric', pool: CARD_POOL, style: 'surprise',
  })!;
  assertEq(
    card.rarityLine,
    "There's a ~95% chance that this day will be in the top 5% hottest days within ±3 days of Aug 30th.",
    'the card names its own window in the same sentence'
  );
}

// --- Case 5: the bone-dry degenerate band ------------------------------------
{
  console.log('Case 5: a dry precipitation pool where p20 == p80');
  // 90 dry days, 10 wet ones: the middle 60% collapses to a single point (0mm),
  // so "within the middle 60%" is meaningless and the line restates the majority.
  const dryPool = [...Array(90).fill(0), 1, 2, 3, 4, 5, 6, 7, 8, 9, 10];
  const dryBand: MetricBand = {
    q01: 0, lo: 0, q10: 0, q25: 0, mid: 0, q75: 0, q90: 0, hi: 0, q99: 0,
  };
  const dial = resolveVerdictProse({
    displayValue: 0, band: dryBand, windowNative: dryPool, allTimeNative: dryPool,
    metric: 'precipitation_sum', system: 'metric', pool: YEAR_POOL, style: 'descriptive',
  })!;
  assertEq(dial.tier, 'mildOff', 'a dry day sits in the middle 60% of a dry record');
  assertEq(
    dial.rarityLine,
    "There's a ~95% chance that this day will be like 90% of all days since 1950.",
    'the degenerate band restates the majority, with a computed share'
  );
  assertEq(dial.verdict, 'A shade drier than the typical day here.', 'dry-side mild verdict');

  const card = resolveVerdictProse({
    displayValue: 0, band: dryBand, windowNative: dryPool, allTimeNative: dryPool,
    metric: 'precipitation_sum', system: 'metric', pool: CARD_POOL, style: 'surprise',
  })!;
  assertEq(
    card.rarityLine,
    "There's a ~95% chance that this day will be like 90% of days within ±3 days of Aug 30th.",
    'the card gets the same share against its own window'
  );

  // Settled dry history: no band, so no confidence line — just the tier's words.
  const settled = resolveVerdictProse({
    displayValue: 0, band: null, windowNative: dryPool, allTimeNative: dryPool,
    metric: 'precipitation_sum', system: 'metric', pool: YEAR_POOL, style: 'descriptive',
  })!;
  // Ties matter here: 90 of the 100 days are also 0mm, so the honest claim is
  // that this day is drier than the 10 that are wetter — not than "100%".
  assertEq(settled.rarityLine, 'Drier than about 10% of all days since 1950.', 'a tied dry day never claims 100%');
}

// --- Case 6: an empty pool has nothing to say --------------------------------
{
  console.log('Case 6: empty pool');
  const none = resolveVerdictProse({
    displayValue: 20, band: null, windowNative: [], allTimeNative: [],
    metric: 'max_temperature', system: 'metric', pool: YEAR_POOL, style: 'descriptive',
  });
  assert(none === null, 'no pool, no verdict — the caller keeps its own fallback');
}

console.log(`\nAll ${passed} assertions passed.`);

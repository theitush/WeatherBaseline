// Standalone unit tests for the top card's record-rail position.
//
// Same setup as permutationTest.test.ts — no test runner is installed, so this
// runs directly under Node's stripped-TS support:
//
//   node --experimental-strip-types src/utils/recordScale.test.ts
//
// Each assertion throws on failure; a clean exit (code 0) means all passed.

import { recordScaleFraction, BIN_COUNT } from './recordScale.ts';

let passed = 0;
function assert(cond: boolean, msg: string): void {
  if (!cond) throw new Error(`FAIL: ${msg}`);
  passed++;
  console.log(`  ok - ${msg}`);
}

// --- Case 1: ordinary window -------------------------------------------------
{
  console.log('Case 1: a normal record range');
  assert(recordScaleFraction(0, 0, 40) === 0, 'record low sits at the low end');
  assert(recordScaleFraction(40, 0, 40) === 1, 'record high sits at the high end');
  assert(recordScaleFraction(20, 0, 40) === 0.5, 'midpoint sits dead centre');
  // Binning snaps to BIN_COUNT + 1 positions: 0.51 of the way up rounds to 0.5.
  assert(recordScaleFraction(20.4, 0, 40) === 0.5, 'position is binned, not raw');
  assert(
    Number.isInteger(recordScaleFraction(23.7, 0, 40) * BIN_COUNT),
    'every position lands on a bin boundary'
  );
}

// --- Case 2: outside the records (forecast q0.50 can) ------------------------
{
  console.log('Case 2: values beyond the records clamp to the ends');
  assert(recordScaleFraction(-5, 0, 40) === 0, 'below the record low clamps to 0');
  assert(recordScaleFraction(99, 0, 40) === 1, 'above the record high clamps to 1');
}

// --- Case 3: THE degenerate one — a flat window (dry-season precip) ----------
{
  console.log('Case 3: zero-span window (every comparable day is 0mm)');
  const flat = recordScaleFraction(0, 0, 0);
  assert(Number.isFinite(flat), 'zero span yields a finite position, not NaN');
  assert(flat === 0.5, 'a day matching the only value on record sits dead centre');
  // A forecast headline is the bias-corrected q0.50, so it need not equal its
  // own raw row: it can sit off a flat climatology in either direction.
  assert(recordScaleFraction(2.5, 0, 0) === 1, 'wetter than a flat-dry window pins high');
  assert(recordScaleFraction(-1, 0, 0) === 0, 'below a flat window pins low');
  // Same shape away from the axis floor (a hypothetical flat temperature window).
  assert(recordScaleFraction(21, 21, 21) === 0.5, 'flat non-zero window also centres');

  for (const [v, lo, hi] of [[0, 0, 0], [3, 0, 0], [21, 21, 21]] as const) {
    const t = recordScaleFraction(v, lo, hi);
    // The rail renders this as `left: ${t * 100}%` and feeds it to the gradient
    // interpolator — a NaN here is exactly the "no bar is drawn" bug.
    assert(t >= 0 && t <= 1, `position stays in [0, 1] for (${v}, ${lo}, ${hi})`);
  }
}

console.log(`\nAll record-scale assertions passed (${passed} checks).`);

// Standalone unit tests for the year-block permutation test.
//
// No test runner is installed in this project, so these run directly under
// Node's stripped-TS support:
//
//   node --experimental-strip-types src/utils/permutationTest.test.ts
//
// Each assertion throws on failure; a clean exit (code 0) means all passed.

import {
  yearBlockPermutationTest,
  type PermRecord,
} from './permutationTest.ts';

let passed = 0;
function assert(cond: boolean, msg: string): void {
  if (!cond) throw new Error(`FAIL: ${msg}`);
  passed++;
  console.log(`  ok - ${msg}`);
}

// Build records: one group, `years` years, `perYear` values per year, each
// value = base + small deterministic jitter so blocks aren't all identical.
function makeGroup(group: string, years: number[], perYear: number, base: number): PermRecord[] {
  const out: PermRecord[] = [];
  for (const year of years) {
    for (let i = 0; i < perYear; i++) {
      // Jitter spread symmetrically around `base`, stable across runs.
      const jitter = ((i % perYear) - (perYear - 1) / 2) * 0.1;
      out.push({ year, group, value: base + jitter });
    }
  }
  return out;
}

// --- Case 1: identical groups → p ≈ 1 ----------------------------------------
{
  console.log('Case 1: identical distributions → large p-value');
  const oldYears = Array.from({ length: 15 }, (_, i) => 1981 + i);
  const newYears = Array.from({ length: 15 }, (_, i) => 2011 + i);
  const records = [
    ...makeGroup('old', oldYears, 30, 20),
    ...makeGroup('new', newYears, 30, 20), // same base ⇒ same distribution
  ];
  const res = yearBlockPermutationTest(records, 'old', 'new');
  if (!res) throw new Error('expected a result, got null');
  console.log(`  observedDiff=${res.observedDiff.toFixed(4)}  p=${res.pValue.toFixed(4)}`);
  assert(Math.abs(res.observedDiff) < 1e-9, 'observed diff is ~0 for identical groups');
  assert(res.pValue > 0.9, `p-value is large (>0.9), got ${res.pValue.toFixed(4)}`);
  assert(res.nBlocksA === 15 && res.nBlocksB === 15, 'block counts equal year counts');
}

// --- Case 2: cleanly separated groups → small p ------------------------------
{
  console.log('Case 2: cleanly separated distributions → small p-value');
  const oldYears = Array.from({ length: 15 }, (_, i) => 1981 + i);
  const newYears = Array.from({ length: 15 }, (_, i) => 2011 + i);
  const records = [
    ...makeGroup('old', oldYears, 30, 10), // all old values ≈ 10
    ...makeGroup('new', newYears, 30, 30), // all new values ≈ 30, no overlap
  ];
  const res = yearBlockPermutationTest(records, 'old', 'new');
  if (!res) throw new Error('expected a result, got null');
  console.log(`  observedDiff=${res.observedDiff.toFixed(4)}  p=${res.pValue.toFixed(4)}`);
  assert(res.observedDiff > 15, 'newer group median is much higher');
  // With 15 vs 15 fully-separated blocks the observed split is the single most
  // extreme arrangement, so p hits the floor 1/(nPerm+1).
  assert(res.pValue < 0.01, `p-value is small (<0.01), got ${res.pValue.toFixed(4)}`);
}

// --- Case 3: reproducibility (same seed ⇒ identical p) -----------------------
{
  console.log('Case 3: seeded reproducibility');
  const years = Array.from({ length: 10 }, (_, i) => 2000 + i);
  const records = [
    ...makeGroup('a', years, 20, 12),
    ...makeGroup('b', years.map((y) => y + 50), 20, 13.5), // slight shift
  ];
  const r1 = yearBlockPermutationTest(records, 'a', 'b', { seed: 42 });
  const r2 = yearBlockPermutationTest(records, 'a', 'b', { seed: 42 });
  if (!r1 || !r2) throw new Error('expected results');
  assert(r1.pValue === r2.pValue, `same seed ⇒ same p (${r1.pValue} === ${r2.pValue})`);
  const r3 = yearBlockPermutationTest(records, 'a', 'b', { seed: 7 });
  if (!r3) throw new Error('expected result');
  // Different seed *may* coincide, but typically differs; just assert it ran.
  assert(r3.pValue > 0 && r3.pValue <= 1, 'different seed yields a valid p-value');
}

// --- Case 4: p-value bounds & null handling ----------------------------------
{
  console.log('Case 4: bounds and degenerate input');
  const empty = yearBlockPermutationTest([], 'old', 'new');
  assert(empty === null, 'empty input returns null');

  const oneSide = yearBlockPermutationTest(
    [{ year: 1990, group: 'old', value: 5 }],
    'old',
    'new'
  );
  assert(oneSide === null, 'missing one group returns null');

  // Non-finite values are dropped, not counted as blocks.
  const withNaN: PermRecord[] = [
    { year: 1990, group: 'old', value: NaN },
    { year: 1990, group: 'old', value: 5 },
    { year: 2020, group: 'new', value: 6 },
  ];
  const res = yearBlockPermutationTest(withNaN, 'old', 'new', { nPerm: 100 });
  if (!res) throw new Error('expected result');
  assert(res.pValue > 0 && res.pValue <= 1, 'p-value within (0, 1]');
  assert(res.pValue >= 1 / (res.nPerm + 1) - 1e-12, 'p-value respects (count+1)/(nPerm+1) floor');
}

console.log(`\nAll permutation-test assertions passed (${passed} checks).`);

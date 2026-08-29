// Where a day sits on the top card's record-low → record-high rail.
//
// One tiny pure function, kept out of the component so it can be exercised
// directly by recordScale.test.ts — the zero-span case below shipped broken
// once (the bar simply vanished on dry-season precip) and is worth a guard.

// The rail snaps the marker to BIN_COUNT + 1 tidy positions instead of letting
// it jitter by a pixel between neighbouring days.
export const BIN_COUNT = 10;

/**
 * Binned position of `value` on the [recordLow, recordHigh] rail, as a fraction
 * in [0, 1] (0 = record low end, 1 = record high end). Values outside the record
 * range clamp to their end — a forecast headline is the bias-corrected q0.50, so
 * it can legitimately sit past both records.
 *
 * DEGENERATE (zero-span) CASE: when every comparable day carries the identical
 * value — in practice a bone-dry precip window where all of them are 0mm — the
 * records coincide and the normalisation is 0/0 = NaN. Guarding with a strict
 * `recordHigh > recordLow` (what this code used to do) is not enough: it just
 * moves the failure to "no bar at all". There is no position to compute in a
 * flat window, only a side, so: the day either IS the one value on record (dead
 * centre — it matches the entire climatology) or it sits outside it, and then it
 * belongs hard against the end it exceeds.
 */
export function recordScaleFraction(
  value: number,
  recordLow: number,
  recordHigh: number,
  binCount: number = BIN_COUNT
): number {
  const span = recordHigh - recordLow;
  const raw =
    span > 0
      ? (value - recordLow) / span
      : value > recordHigh
        ? 1
        : value < recordLow
          ? 0
          : 0.5;
  const clamped = Math.max(0, Math.min(1, raw));
  return Math.round(clamped * binCount) / binCount;
}

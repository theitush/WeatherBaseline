// The sentence under a split dial: did the two periods actually differ?
//
// Two lines, because "different" is two questions, and each carries its own
// p-value:
//
//   1. direction — is it warmer / wetter / windier, and by how much
//   2. shape     — how far apart the rings run at all, against how far apart a
//                  random split of the same years runs
//
// The second line is the one that makes the first honest: |gap| is never
// negative, so even two random halves of an unchanging climate produce a ribbon
// of some width. Printing that noise floor next to the observed width is what
// lets a reader judge the number without knowing what a p-value is.
import React from 'react';
import type { MetricKey } from '../utils/config';
import { unitLabel } from '../utils/units';
import type { UnitSystem } from '../utils/units';
import type { PeriodTest } from './comparePeriodTest';
import type { Period } from './compareTypes';

/** Direction words per metric — "0.8 °C warmer" reads better than "higher". */
const DIRECTION: Record<MetricKey, [up: string, down: string]> = {
  max_temperature: ['warmer', 'cooler'],
  min_temperature: ['warmer', 'cooler'],
  precipitation_sum: ['wetter', 'drier'],
  wind_speed_10m_max: ['windier', 'calmer'],
};

/** Anything below the resolution 2000 shuffles can give is reported as such. */
const formatP = (p: number): string => (p < 0.001 ? 'p < 0.001' : `p = ${p.toFixed(3)}`);

/** Gaps are differences, not readings, so they get a fixed two decimals. */
const gap = (v: number, metric: MetricKey, system: UnitSystem): string =>
  `${Math.abs(v).toFixed(2)} ${unitLabel(metric, system).trim()}`;

interface PeriodVerdictProps {
  test: PeriodTest | null;
  pending: boolean;
  periods: Period[];
  metric: MetricKey;
  system: UnitSystem;
}

const PeriodVerdict: React.FC<PeriodVerdictProps> = ({
  test,
  pending,
  periods,
  metric,
  system,
}) => {
  if (pending) {
    return (
      <p className="cmp-verdict cmp-verdict-pending">
        Testing whether the two periods differ…
      </p>
    );
  }
  if (!test || periods.length !== 2) return null;

  const [early, late] = periods;
  const [up, down] = DIRECTION[metric];
  const word = test.signedGap >= 0 ? up : down;
  // Precip is compared on a different summary, so the block says which.
  const note =
    test.statistic === 'p90'
      ? ' Precipitation is compared on its wet tail (the 90th percentile), since its median is usually zero.'
      : '';

  // Line 1 — direction. When a random split moves this far just as often, say
  // so rather than reporting a shift the data does not support.
  const shifted = test.pSigned <= 0.05;
  const headline = shifted
    ? `${late.label} runs ${gap(test.signedGap, metric, system)} ${word} than ${early.label} on the average week (${formatP(test.pSigned)}) — a typical day now sits at the ${Math.round(test.percentile)}th percentile of ${early.label}.`
    : `${late.label} runs ${gap(test.signedGap, metric, system)} ${word} than ${early.label} on the average week, but ${test.countSigned} of ${test.nPerm} random splits of these years moved at least as far (${formatP(test.pSigned)}).`;

  // Line 2 — shape, and the noise floor that gives it scale. "Ignoring
  // direction" is what keeps this from reading as a contradiction of line 1: a
  // shift can be consistent enough to detect while its size still sits inside
  // what chance produces, which is exactly what a short record looks like.
  const wider = test.pAbs <= 0.05;
  const evidence = wider
    ? `Ignoring direction, the rings sit ${gap(test.absGap, metric, system)} apart on the average week against ${gap(test.nullAbsGap, metric, system)} for a random split — ${test.countAbs} of ${test.nPerm} shuffles came out this wide (${formatP(test.pAbs)}).${note}`
    : `Ignoring direction, the rings sit ${gap(test.absGap, metric, system)} apart on the average week — about what a random split of these years already gives (${gap(test.nullAbsGap, metric, system)}, ${formatP(test.pAbs)}).${note}`;

  return (
    <div
      className="cmp-verdict"
      title={`Each of the ${test.nEarlyYears + test.nLateYears} years is dealt at random into two piles the size of the real split (${test.nEarlyYears} and ${test.nLateYears}), ${test.nPerm} times over. Whole years move together, since days within a year are not independent. p is how often a random deal came out at least this different.`}
    >
      <p className={shifted ? 'cmp-verdict-head strong' : 'cmp-verdict-head'}>{headline}</p>
      <p className="cmp-verdict-sub">{evidence}</p>
    </div>
  );
};

export default PeriodVerdict;

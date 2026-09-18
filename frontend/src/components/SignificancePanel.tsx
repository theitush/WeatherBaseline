import React from 'react';
import type { MetricKey } from '../utils/config';
import { METRIC_DIRECTION_UP, METRIC_DIRECTION_DOWN, type Period } from './PeriodHistogramChart';
import type { PermutationResult } from '../utils/permutationTest';
import { useUnits } from '../hooks/useUnits';
import { convertDelta, unitLabel, valueDecimals } from '../utils/units';
import './SignificancePanel.css';

interface SignificancePanelProps {
  // Result of the POST-SATELLITE PAIR's permutation test — the first satellite
  // era against the newest — computed in App by usePermutationTest. The other
  // two comparisons that hook runs are drawn as brackets on the histogram and
  // deliberately have no sentence here: the section states one change, the
  // recent one, and the chart shows the rest.
  result: PermutationResult | null;
  loading: boolean;
  currentMetric: MetricKey;
  /** The three eras, from the same builder the chart draws. The sentence names
   *  the two the result actually compares: periods[1] and periods[2]. */
  periods: Period[];
}

function fmtP(p: number): string {
  if (p < 0.001) return '< 0.001';
  return p.toFixed(3);
}

const SignificancePanel: React.FC<SignificancePanelProps> = ({
  result,
  loading,
  currentMetric,
  periods,
}) => {
  const { system } = useUnits();
  // The pair the test actually ran on: the two satellite eras. NOT periods[0],
  // which is the pre-satellite record and is only compared on the chart.
  const reference = periods[1];
  const newest = periods[2];

  const unit = unitLabel(currentMetric, system);
  // Label the compared statistic to match what the test actually used.
  const statLabel = 'Median';

  return (
    <div className="significance-panel">
      {loading ? (
        <div className="sig-loading">
          <span className="sig-spinner" /> Running 10,000 permutations…
        </div>
      ) : !result || !reference || !newest ? (
        <div className="sig-empty">Not enough data in these periods to test.</div>
      ) : (
        (() => {
          const diff = convertDelta(result.observedDiff, currentMetric, system);
          const dir = diff >= 0 ? METRIC_DIRECTION_UP[currentMetric] : METRIC_DIRECTION_DOWN[currentMetric];
          return (
            <div className="sig-body">
              <p className="sig-explain">
                {statLabel} of {newest.label} is {Math.abs(diff).toFixed(valueDecimals(currentMetric, system))} {unit} {dir} than {statLabel.toLowerCase()} of {reference.label}
                {result.pValue >= 0.05
                  ? <>, but the result is not significant (p&nbsp;=&nbsp;{fmtP(result.pValue)}).</>
                  : <>{' '}(p&nbsp;=&nbsp;{fmtP(result.pValue)}).</>
                }
              </p>
            </div>
          );
        })()
      )}
    </div>
  );
};

export default SignificancePanel;

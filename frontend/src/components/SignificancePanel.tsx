import React, { useMemo } from 'react';
import type { MetricKey } from '../utils/config';
import { buildPeriods } from './PeriodHistogramChart';
import type { PermutationResult } from '../utils/permutationTest';
import { useUnits } from '../hooks/useUnits';
import { convertDelta, unitLabel } from '../utils/units';
import './SignificancePanel.css';

interface SignificancePanelProps {
  // Result of the oldest-vs-newest permutation test, computed once in App and
  // shared with the histogram's significance bracket.
  result: PermutationResult | null;
  loading: boolean;
  currentMetric: MetricKey;
}

const METRIC_NOUN: Record<MetricKey, string> = {
  max_temperature: 'warmer',
  min_temperature: 'warmer',
  precipitation_sum: 'wetter',
  wind_speed_10m_max: 'windier',
};
const METRIC_NOUN_NEG: Record<MetricKey, string> = {
  max_temperature: 'cooler',
  min_temperature: 'cooler',
  precipitation_sum: 'drier',
  wind_speed_10m_max: 'calmer',
};

function fmtP(p: number): string {
  if (p < 0.001) return '< 0.001';
  return p.toFixed(3);
}

const SignificancePanel: React.FC<SignificancePanelProps> = ({ result, loading, currentMetric }) => {
  const { system } = useUnits();
  const periods = useMemo(() => buildPeriods(), []);
  const oldest = periods[0];
  const newest = periods[periods.length - 1];

  const unit = unitLabel(currentMetric, system);
  // Label the compared statistic to match what the test actually used.
  const statLabel = 'Median';

  return (
    <div className="significance-panel">
      {loading ? (
        <div className="sig-loading">
          <span className="sig-spinner" /> Running 10,000 permutations…
        </div>
      ) : !result ? (
        <div className="sig-empty">Not enough data in these periods to test.</div>
      ) : (
        (() => {
          const diff = convertDelta(result.observedDiff, currentMetric, system);
          const dir = diff >= 0 ? METRIC_NOUN[currentMetric] : METRIC_NOUN_NEG[currentMetric];
          return (
            <div className="sig-body">
              <p className="sig-explain">
                {statLabel} of {newest.label} is {Math.abs(diff).toFixed(1)} {unit} {dir} than {statLabel.toLowerCase()} of {oldest.label}
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

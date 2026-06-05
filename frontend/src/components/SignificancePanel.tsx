import React, { useMemo } from 'react';
import type { MetricKey } from '../utils/config';
import { buildPeriods } from './PeriodHistogramChart';
import type { PermutationResult } from '../utils/permutationTest';
import './SignificancePanel.css';

interface SignificancePanelProps {
  // Result of the oldest-vs-newest permutation test, computed once in App and
  // shared with the histogram's significance bracket.
  result: PermutationResult | null;
  loading: boolean;
  currentMetric: MetricKey;
}

const UNITS: Record<MetricKey, string> = {
  max_temperature: '°C',
  min_temperature: '°C',
  precipitation_sum: 'mm',
  wind_speed_10m_max: 'm/s',
};

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

// Plain-language verdict from the p-value. The thresholds are deliberately
// loose — this is a vibe check on top of the histogram, not a paper.
function verdict(p: number): string {
  if (p < 0.001) return 'Wah! Super Likely!';     // *** level
  if (p < 0.01) return 'Very Likely!';  // ** level
  if (p < 0.05) return 'Pretty likely.';
  if (p < 0.15) return 'Maybe..?';
  return 'Not really..';
}

function fmtP(p: number): string {
  if (p < 0.001) return '< 0.001';
  return p.toFixed(3);
}

const SignificancePanel: React.FC<SignificancePanelProps> = ({ result, loading, currentMetric }) => {
  const periods = useMemo(() => buildPeriods(), []);
  const oldest = periods[0];
  const newest = periods[periods.length - 1];

  const unit = UNITS[currentMetric];
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
          const line = verdict(result.pValue);
          const diff = result.observedDiff;
          const dir = diff >= 0 ? METRIC_NOUN[currentMetric] : METRIC_NOUN_NEG[currentMetric];
          return (
            <div className="sig-body">
              <div className="sig-verdict">{line}</div>
              <p className="sig-explain">
                {statLabel} of {newest.label} is {Math.abs(diff).toFixed(1)} {unit} {dir} than {statLabel.toLowerCase()} of {oldest.label}
                {' '}(p&nbsp;=&nbsp;{fmtP(result.pValue)}).
              </p>
            </div>
          );
        })()
      )}
    </div>
  );
};

export default SignificancePanel;

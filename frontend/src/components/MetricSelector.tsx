import React from 'react';
import CONFIG from '../utils/config';
import type { MetricKey } from '../utils/config';
import './MetricSelector.css';

interface MetricSelectorProps {
  currentMetric: MetricKey;
  onChange: (metric: MetricKey) => void;
}

const MetricSelector: React.FC<MetricSelectorProps> = ({ currentMetric, onChange }) => {
  const activeMetrics = CONFIG.getActiveMetrics();

  // Only show selector if there are multiple active metrics
  if (activeMetrics.length <= 1) {
    return null;
  }

  const metricLabels: Record<MetricKey, string> = {
    max_temperature: 'Max Temperature',
    min_temperature: 'Min Temperature',
    precipitation_sum: 'Precipitation',
    wind_speed_10m_max: 'Wind Speed',
  };

  return (
    <div className="metric-selector">
      <label>Metric:</label>
      <div className="metric-buttons">
        {activeMetrics.map((metric) => (
          <button
            key={metric}
            className={`metric-button ${currentMetric === metric ? 'active' : ''}`}
            onClick={() => onChange(metric)}
          >
            {metricLabels[metric]}
          </button>
        ))}
      </div>
    </div>
  );
};

export default MetricSelector;

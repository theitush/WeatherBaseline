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

  // Compact labels shown on narrow screens (CSS swaps which span is visible).
  const metricLabelsShort: Record<MetricKey, string> = {
    max_temperature: 'Max Temp',
    min_temperature: 'Min Temp',
    precipitation_sum: 'Precipitation',
    wind_speed_10m_max: 'Wind',
  };

  return (
    <div className="metric-selector">
      <div className="metric-buttons">
        {activeMetrics.map((metric) => {
          const isActive = currentMetric === metric;
          const color = CONFIG.metricColors[metric].base;
          return (
            <button
              key={metric}
              className={`metric-button ${isActive ? 'active' : ''}`}
              onClick={() => onChange(metric)}
              style={{
                backgroundColor: color,
                borderColor: isActive ? '#111' : color,
                color: 'white',
              }}
            >
              <span className="metric-label-full">{metricLabels[metric]}</span>
              <span className="metric-label-short">{metricLabelsShort[metric]}</span>
            </button>
          );
        })}
      </div>
    </div>
  );
};

export default MetricSelector;

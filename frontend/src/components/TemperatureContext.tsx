import React from 'react';
import type { TemperatureContext as TempContext, WeatherDataPoint, MetricKey } from '../types';
import './TemperatureContext.css';

interface TemperatureContextProps {
  context: TempContext | null;
  currentTemp: number | null;
  filteredData: WeatherDataPoint[];
  currentMetric: MetricKey;
}

const BIN_COUNT = 10;

// Gradient stops: record-low blue -> white -> record-high red (matches the bar exactly)
const GRADIENT_LOW_RGB = [47, 111, 184];    // #2f6fb8
const GRADIENT_MID_RGB = [255, 255, 255];   // #ffffff
const GRADIENT_HIGH_RGB = [192, 57, 43];    // #c0392b

const interpolateGradient = (t: number): string => {
  const clamped = Math.max(0, Math.min(1, t));
  const [a, b, local] = clamped <= 0.5
    ? [GRADIENT_LOW_RGB, GRADIENT_MID_RGB, clamped / 0.5]
    : [GRADIENT_MID_RGB, GRADIENT_HIGH_RGB, (clamped - 0.5) / 0.5];
  const r = Math.round(a[0] + (b[0] - a[0]) * local);
  const g = Math.round(a[1] + (b[1] - a[1]) * local);
  const bl = Math.round(a[2] + (b[2] - a[2]) * local);
  return `rgb(${r}, ${g}, ${bl})`;
};

const formatDate = (d: Date): string => {
  const months = ['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun',
    'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec'];
  return `${months[d.getMonth()]} ${d.getDate()}, ${d.getFullYear()}`;
};

// Unit suffix appended to record-scale values, per metric.
const METRIC_UNITS: Record<MetricKey, string> = {
  max_temperature: '°',
  min_temperature: '°',
  precipitation_sum: 'mm',
  wind_speed_10m_max: 'm/s',
};

const TemperatureContextDisplay: React.FC<TemperatureContextProps> = ({
  context,
  currentTemp,
  filteredData,
  currentMetric,
}) => {
  // currentTemp can legitimately be 0 (a dry day reads 0mm); only bail on true absence.
  if (!context || currentTemp === null || currentTemp === undefined) {
    return null;
  }

  const unit = METRIC_UNITS[currentMetric];
  // Temperature degrees read "12.3°"; other metrics read "12.3 mm".
  const fmt = (v: number) => (unit === '°' ? `${v.toFixed(1)}°` : `${v.toFixed(1)} ${unit}`);

  const valid = filteredData.filter((d) => {
    const v = d[currentMetric];
    return typeof v === 'number' && Number.isFinite(v);
  });

  let recordLow: number | null = null;
  let recordHigh: number | null = null;
  let recordLowDate: Date | null = null;
  let recordHighDate: Date | null = null;

  for (const d of valid) {
    const v = d[currentMetric] as number;
    if (recordLow === null || v < recordLow) {
      recordLow = v;
      recordLowDate = d.date;
    }
    if (recordHigh === null || v > recordHigh) {
      recordHigh = v;
      recordHighDate = d.date;
    }
  }

  let binnedPct: number | null = null;
  let markerColor = '#222';
  if (recordLow !== null && recordHigh !== null && recordHigh > recordLow) {
    const raw = (currentTemp - recordLow) / (recordHigh - recordLow);
    const clamped = Math.max(0, Math.min(1, raw));
    const bin = Math.round(clamped * BIN_COUNT);
    const binT = bin / BIN_COUNT;
    binnedPct = binT * 100;
    markerColor = interpolateGradient(binT);
  }

  return (
    <div className="temperature-context">
      <h3 className="context-description">{context.description}</h3>
      <div className="context-content">
        {context.ranking && <div className="context-ranking">{context.ranking}</div>}
        {binnedPct !== null && recordLow !== null && recordHigh !== null ? (
          <div className="record-scale" aria-label="Temperature vs records">
            <div className="record-scale-label record-scale-low">
              <span className="record-scale-temp">{fmt(recordLow)}</span>
              <span className="record-scale-name">record low</span>
              {recordLowDate && (
                <span className="record-scale-date">{formatDate(recordLowDate)}</span>
              )}
            </div>
            <div className="record-scale-track">
              <div className="record-scale-gradient" />
              <div
                className="record-scale-marker"
                style={{ left: `${binnedPct}%` }}
              >
                <span
                  className="record-scale-marker-value"
                  style={{ color: markerColor }}
                >
                  {fmt(currentTemp)}
                </span>
                <span
                  className="record-scale-marker-tick"
                  style={{ background: markerColor }}
                />
              </div>
            </div>
            <div className="record-scale-label record-scale-high">
              <span className="record-scale-temp">{fmt(recordHigh)}</span>
              <span className="record-scale-name">record high</span>
              {recordHighDate && (
                <span className="record-scale-date">{formatDate(recordHighDate)}</span>
              )}
            </div>
          </div>
        ) : (
          <div className="temp-value">{fmt(currentTemp)}</div>
        )}
      </div>
    </div>
  );
};

export default TemperatureContextDisplay;

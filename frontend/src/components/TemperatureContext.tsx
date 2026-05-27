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

// Gradient stops: record-low blue -> white -> record-high red (matches chart markers)
const GRADIENT_LOW = [
  { t: 0, rgb: [47, 111, 184] },    // #2f6fb8 record-low blue
  { t: 1, rgb: [195, 215, 235] },   // very faint blue at midpoint
];
const GRADIENT_HIGH = [
  { t: 0, rgb: [240, 210, 205] },   // very faint red at midpoint
  { t: 1, rgb: [192, 57, 43] },     // #c0392b record-high red
];

const interpolateGradient = (t: number): string => {
  const clamped = Math.max(0, Math.min(1, t));
  const [a, b, local] = clamped <= 0.5
    ? [GRADIENT_LOW[0], GRADIENT_LOW[1], clamped / 0.5]
    : [GRADIENT_HIGH[0], GRADIENT_HIGH[1], (clamped - 0.5) / 0.5];
  const r = Math.round(a.rgb[0] + (b.rgb[0] - a.rgb[0]) * local);
  const g = Math.round(a.rgb[1] + (b.rgb[1] - a.rgb[1]) * local);
  const bl = Math.round(a.rgb[2] + (b.rgb[2] - a.rgb[2]) * local);
  return `rgb(${r}, ${g}, ${bl})`;
};

const formatDate = (d: Date): string => {
  const months = ['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun',
    'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec'];
  return `${months[d.getMonth()]} ${d.getDate()}, ${d.getFullYear()}`;
};

const TemperatureContextDisplay: React.FC<TemperatureContextProps> = ({
  context,
  currentTemp,
  filteredData,
  currentMetric,
}) => {
  if (!context || currentTemp === null) {
    return null;
  }

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
              <span className="record-scale-temp">{recordLow.toFixed(1)}°</span>
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
                  {currentTemp.toFixed(1)}°
                </span>
                <span
                  className="record-scale-marker-tick"
                  style={{ background: markerColor }}
                />
              </div>
            </div>
            <div className="record-scale-label record-scale-high">
              <span className="record-scale-temp">{recordHigh.toFixed(1)}°</span>
              <span className="record-scale-name">record high</span>
              {recordHighDate && (
                <span className="record-scale-date">{formatDate(recordHighDate)}</span>
              )}
            </div>
          </div>
        ) : (
          <div className="temp-value">{currentTemp.toFixed(1)}°C</div>
        )}
      </div>
    </div>
  );
};

export default TemperatureContextDisplay;

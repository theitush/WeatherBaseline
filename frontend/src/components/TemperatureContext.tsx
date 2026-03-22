import React from 'react';
import type { TemperatureContext as TempContext } from '../types';
import './TemperatureContext.css';

interface TemperatureContextProps {
  context: TempContext | null;
  currentTemp: number | null;
}

const TemperatureContextDisplay: React.FC<TemperatureContextProps> = ({
  context,
  currentTemp,
}) => {
  if (!context || currentTemp === null) {
    return null;
  }

  return (
    <div className="temperature-context">
      <h3>Current Temperature Context</h3>
      <div className="context-content">
        <div className="temp-value">{currentTemp.toFixed(1)}°C</div>
        <div className="context-description">{context.description}</div>
        <div className="context-percentile">{context.percentile}</div>
        {context.ranking && <div className="context-ranking">{context.ranking}</div>}
      </div>
    </div>
  );
};

export default TemperatureContextDisplay;

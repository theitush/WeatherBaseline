import React, { useEffect, useState } from 'react';
import CONFIG from './utils/config';
import { AppProvider, useApp } from './context/AppContext';
import LocationSelector from './components/LocationSelector';
import DateSelector from './components/DateSelector';
import MetricSelector from './components/MetricSelector';
import TemperatureContextDisplay from './components/TemperatureContext';
import LoadingOverlay from './components/LoadingOverlay';
import MainChart from './components/MainChart';
import HistogramChart from './components/HistogramChart';
import PeriodHistogramChart from './components/PeriodHistogramChart';
import SignificancePanel from './components/SignificancePanel';
import { Legend } from './components/Legend';
import type { MetricKey } from './utils/config';
import './App.css';

// Metric phrases for the recent-memory question — matches the metric buttons.
const metricQuestionLabel: Record<MetricKey, string> = {
  max_temperature: 'max temperature',
  min_temperature: 'min temperature',
  precipitation_sum: 'precipitation',
  wind_speed_10m_max: 'wind speed',
};

const AppContent: React.FC = () => {
  const {
    location,
    setLocation,
    currentDate,
    setCurrentDate,
    currentMetric,
    setCurrentMetric,
    filteredData,
    fullData,
    yearlyAggregates,
    temperatureContext,
    maxAvailableDate,
    loading,
    error,
  } = useApp();

  const handleLocationChange = (name: string, lat: number, lon: number) => {
    setLocation({ lat, lon, name });
  };

  const handleDateChange = (date: string) => {
    setCurrentDate(date);
  };

  const handleMetricChange = (metric: any) => {
    setCurrentMetric(metric);
  };

  const [isMobile, setIsMobile] = useState(
    typeof window !== 'undefined' ? window.innerWidth < 768 : false
  );
  useEffect(() => {
    const onResize = () => setIsMobile(window.innerWidth < 768);
    window.addEventListener('resize', onResize);
    return () => window.removeEventListener('resize', onResize);
  }, []);

  const [mobileWidth, setMobileWidth] = useState(
    typeof window !== 'undefined' ? Math.min(window.innerWidth - 60, 420) : 360
  );
  useEffect(() => {
    const onResize = () => setMobileWidth(Math.min(window.innerWidth - 60, 420));
    window.addEventListener('resize', onResize);
    return () => window.removeEventListener('resize', onResize);
  }, []);

  const formatChartTitle = (dateStr: string) => {
    const d = new Date(dateStr + 'T12:00:00');
    const months = ['January', 'February', 'March', 'April', 'May', 'June',
      'July', 'August', 'September', 'October', 'November', 'December'];
    const day = d.getDate();
    const suffix =
      day % 10 === 1 && day !== 11 ? 'st' :
      day % 10 === 2 && day !== 12 ? 'nd' :
      day % 10 === 3 && day !== 13 ? 'rd' : 'th';
    return `${months[d.getMonth()]} ${day}${suffix} ± ${CONFIG.chart.seasonalWindowDays} days`;
  };

  // Get current date data for temperature context
  const getCurrentTemp = () => {
    const currentDateData = filteredData.filter(
      (d) => d.date.toDateString() === new Date(currentDate).toDateString()
    );
    if (currentDateData.length > 0) {
      return currentDateData[0][currentMetric] ?? null;
    }
    return null;
  };

  return (
    <div className="app">
      <LoadingOverlay show={loading} />

      <div className="app-container">
        <div className="sticky-bar">
          <header className="app-header">
            <h1>Weather Rank</h1>
          </header>

          <div className="controls-panel">
            <div className="controls-row">
              <LocationSelector
                cityName={location.name || ''}
                latitude={location.lat}
                longitude={location.lon}
                onChange={handleLocationChange}
              />

              <DateSelector
                currentDate={currentDate}
                onChange={handleDateChange}
                maxDate={maxAvailableDate}
              />
            </div>
            {!loading && !error && filteredData.length > 0 && (
              <MetricSelector currentMetric={currentMetric} onChange={handleMetricChange} />
            )}
          </div>
        </div>

        {error && (
          <div className="error-message">
            <strong>Error:</strong> {error}
          </div>
        )}

        {!loading && !error && filteredData.length > 0 && (
          <div className="data-panel">
            {/* Section 1 — the answer at a glance */}
            <section className="page-section">
              <TemperatureContextDisplay
                context={temperatureContext}
                currentTemp={getCurrentTemp()}
                filteredData={filteredData}
                currentMetric={currentMetric}
              />
            </section>

            {/* Section 2 — the full record */}
            <section className="page-section">
              <header className="section-header">
                <h2 className="section-title">The Data</h2>
              </header>
              <div className="charts-section">
                <div className="chart-title">{formatChartTitle(currentDate)}</div>
                <Legend metric={currentMetric} />
                <div className={`charts-container ${isMobile ? 'mobile' : ''}`}>
                  {isMobile ? (
                    <>
                      <HistogramChart
                        filteredData={filteredData}
                        currentMetric={currentMetric}
                        currentDate={currentDate}
                        fullData={fullData}
                        orientation="vertical"
                        width={mobileWidth}
                        height={115}
                      />
                      <MainChart
                        filteredData={filteredData}
                        yearlyAggregates={yearlyAggregates}
                        currentMetric={currentMetric}
                        currentDate={currentDate}
                        fullData={fullData}
                        orientation="vertical"
                        width={mobileWidth}
                        height={460}
                      />
                    </>
                  ) : (
                    <>
                      <MainChart
                        filteredData={filteredData}
                        yearlyAggregates={yearlyAggregates}
                        currentMetric={currentMetric}
                        currentDate={currentDate}
                        fullData={fullData}
                      />
                      <HistogramChart
                        filteredData={filteredData}
                        currentMetric={currentMetric}
                        currentDate={currentDate}
                        fullData={fullData}
                      />
                    </>
                  )}
                </div>
              </div>
            </section>

            {/* Section 3 — recent-memory trend */}
            <section className="page-section">
              <header className="section-header">
                <h2 className="section-title">The Broader Stats</h2>
                <p className="section-subtitle">
                  Did {metricQuestionLabel[currentMetric]} at this time of
                  year change in recent memory?
                </p>
              </header>
              <div className="chart-title">{formatChartTitle(currentDate)}</div>
              <div className={`period-histogram-row ${isMobile ? 'mobile' : ''}`}>
                <PeriodHistogramChart
                  filteredData={filteredData}
                  currentMetric={currentMetric}
                  width={isMobile ? mobileWidth : 990}
                  panelHeight={isMobile ? 64 : 72}
                />
              </div>
              <SignificancePanel
                filteredData={filteredData}
                currentMetric={currentMetric}
              />
            </section>

            {/* Section 4 — FAQ */}
            <section className="page-section">
              <header className="section-header">
                <h2 className="section-title">FAQ for Mega Nerds</h2>
              </header>
              <div className="faq-list">
                <details className="faq-item">
                  <summary>What's this data?</summary>
                  <div className="faq-body">
                    <p>
                      TODO: describe the dataset — ERA5-Land reanalysis on a 0.1°
                      grid, the metrics shown, and how a city snaps to its nearest cell.
                    </p>
                  </div>
                </details>
                <details className="faq-item">
                  <summary>Satellites?</summary>
                  <div className="faq-body">
                    <p>
                      TODO: explain the pre-1979 satellite era — why the early years
                      are shaded and how confidence differs before/after the boundary.
                    </p>
                  </div>
                </details>
                <details className="faq-item">
                  <summary>Who are you?</summary>
                  <div className="faq-body">
                    <p>TODO: about the project and who built it.</p>
                  </div>
                </details>
              </div>
            </section>
          </div>
        )}
      </div>
    </div>
  );
};

const App: React.FC = () => {
  return (
    <AppProvider>
      <AppContent />
    </AppProvider>
  );
};

export default App;

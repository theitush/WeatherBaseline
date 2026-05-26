import React, { useEffect, useState } from 'react';
import { AppProvider, useApp } from './context/AppContext';
import LocationSelector from './components/LocationSelector';
import DateSelector from './components/DateSelector';
import MetricSelector from './components/MetricSelector';
import TemperatureContextDisplay from './components/TemperatureContext';
import LoadingOverlay from './components/LoadingOverlay';
import MainChart from './components/MainChart';
import HistogramChart from './components/HistogramChart';
import { Legend } from './components/Legend';
import './App.css';

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
    return `${months[d.getMonth()]} ${day}${suffix} ± 7 days`;
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
        <header className="app-header">
          <h1>How Hot Was It?</h1>
          <p className="subtitle">Explore historical weather patterns</p>
        </header>

        <div className="controls-panel">
          <div className="controls-row">
            <LocationSelector
              cityName={location.name || ''}
              latitude={location.lat}
              longitude={location.lon}
              onChange={handleLocationChange}
            />

            <DateSelector currentDate={currentDate} onChange={handleDateChange} />
          </div>
        </div>

        {error && (
          <div className="error-message">
            <strong>Error:</strong> {error}
          </div>
        )}

        {!loading && !error && filteredData.length > 0 && (
          <div className="data-panel">
            <TemperatureContextDisplay
              context={temperatureContext}
              currentTemp={getCurrentTemp()}
              filteredData={filteredData}
              currentMetric={currentMetric}
            />

            <div className="charts-section">
              <div className="charts-controls">
                <MetricSelector currentMetric={currentMetric} onChange={handleMetricChange} />
              </div>
              <div className="chart-title">{formatChartTitle(currentDate)}</div>
              {isMobile && <Legend metric={currentMetric} />}
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
                      height={180}
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

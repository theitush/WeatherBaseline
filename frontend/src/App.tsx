import React from 'react';
import { AppProvider, useApp } from './context/AppContext';
import LocationSelector from './components/LocationSelector';
import DateSelector from './components/DateSelector';
import MetricSelector from './components/MetricSelector';
import TemperatureContextDisplay from './components/TemperatureContext';
import LoadingOverlay from './components/LoadingOverlay';
import MainChart from './components/MainChart';
import HistogramChart from './components/HistogramChart';
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
    fetchData,
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

  const handleFetch = () => {
    fetchData();
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
          <h1>HowHotWasIt</h1>
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

            <button className="fetch-button" onClick={handleFetch} disabled={loading}>
              {loading ? 'Loading...' : 'Fetch Data'}
            </button>
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
            />

            <div className="charts-section">
              <div className="charts-controls">
                <MetricSelector currentMetric={currentMetric} onChange={handleMetricChange} />
              </div>
              <div className="charts-container">
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

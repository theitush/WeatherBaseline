import React, { createContext, useContext, useState, useCallback, useEffect } from 'react';
import CONFIG from '../utils/config';
import type { MetricKey } from '../utils/config';
import type { WeatherDataPoint, YearlyAggregate, Location, TemperatureContext } from '../types';
import { getTemperatureHistory } from '../services/api';
import {
  calculateYearlyAggregates,
  filterDataByYearRange,
  filterAggregatesByYearRange,
  getCurrentDateData,
  generateTemperatureContext,
  getAvailableYears,
} from '../utils/dataProcessor';

interface AppState {
  // Location
  location: Location;
  setLocation: (location: Location) => void;

  // Date
  currentDate: string;
  setCurrentDate: (date: string) => void;

  // Metric
  currentMetric: MetricKey;
  setCurrentMetric: (metric: MetricKey) => void;

  // Data
  fullData: WeatherDataPoint[];
  filteredData: WeatherDataPoint[];
  fullYearlyAggregates: YearlyAggregate[];
  yearlyAggregates: YearlyAggregate[];
  availableYears: number[];

  // Year range filter
  startYear: number;
  endYear: number;
  setYearRange: (start: number, end: number) => void;

  // Current temperature context
  temperatureContext: TemperatureContext | null;

  // Loading & Error states
  loading: boolean;
  error: string | null;

  // Actions
  fetchData: () => Promise<void>;
  refreshData: () => Promise<void>;
}

const AppContext = createContext<AppState | undefined>(undefined);

export const useApp = () => {
  const context = useContext(AppContext);
  if (!context) {
    throw new Error('useApp must be used within AppProvider');
  }
  return context;
};

interface AppProviderProps {
  children: React.ReactNode;
}

export const AppProvider: React.FC<AppProviderProps> = ({ children }) => {
  // Default location: Tel Aviv, Israel
  const [location, setLocation] = useState<Location>({
    lat: 32.0853,
    lon: 34.7818,
    name: 'Tel Aviv, Israel',
  });

  // Default to today's date
  const [currentDate, setCurrentDate] = useState<string>(() => {
    const today = new Date();
    return today.toISOString().split('T')[0];
  });

  // Default to first active metric
  const [currentMetric, setCurrentMetric] = useState<MetricKey>(() => {
    const activeMetrics = CONFIG.getActiveMetrics();
    return activeMetrics[0] || 'max_temperature';
  });

  // Data state
  const [fullData, setFullData] = useState<WeatherDataPoint[]>([]);
  const [filteredData, setFilteredData] = useState<WeatherDataPoint[]>([]);
  const [fullYearlyAggregates, setFullYearlyAggregates] = useState<YearlyAggregate[]>([]);
  const [yearlyAggregates, setYearlyAggregates] = useState<YearlyAggregate[]>([]);
  const [availableYears, setAvailableYears] = useState<number[]>([]);

  // Year range filter (default to all available years)
  const [startYear, setStartYear] = useState<number>(1940);
  const [endYear, setEndYear] = useState<number>(new Date().getFullYear());

  // Temperature context
  const [temperatureContext, setTemperatureContext] = useState<TemperatureContext | null>(null);

  // Loading & Error
  const [loading, setLoading] = useState<boolean>(false);
  const [error, setError] = useState<string | null>(null);

  // Fetch weather data
  const fetchData = useCallback(async () => {
    setLoading(true);
    setError(null);

    try {
      console.log('Fetching data for:', location, currentDate);

      const data = await getTemperatureHistory(
        location.lat,
        location.lon,
        currentDate,
        1940,
        7
      );

      if (!data || data.length === 0) {
        throw new Error('No weather data received from the API. The location or date range might not be available.');
      }

      console.log(`Loaded ${data.length} records`);

      // Update full data
      setFullData(data);

      // Get available years
      const years = getAvailableYears(data);
      setAvailableYears(years);

      // Calculate full aggregates
      const aggregates = calculateYearlyAggregates(data, currentMetric, currentDate);
      setFullYearlyAggregates(aggregates);

      // Set default year range if not set
      if (years.length > 0) {
        const minYear = Math.min(...years);
        const maxYear = Math.max(...years);
        setStartYear(minYear);
        setEndYear(maxYear);

        // Filter data with full range
        const filtered = filterDataByYearRange(data, minYear, maxYear);
        setFilteredData(filtered);

        // Filter aggregates
        const filteredAggs = filterAggregatesByYearRange(aggregates, minYear, maxYear);
        setYearlyAggregates(filteredAggs);

        // Calculate temperature context for current date
        const currentDateData = getCurrentDateData(filtered, currentDate);
        if (currentDateData.length > 0) {
          const currentTemp = currentDateData[0][currentMetric];
          const context = generateTemperatureContext(currentTemp, filtered, currentMetric);
          setTemperatureContext(context);
        }
      }

    } catch (err) {
      console.error('Error fetching data:', err);
      setError(err instanceof Error ? err.message : 'Failed to fetch data');
    } finally {
      setLoading(false);
    }
  }, [location, currentDate, currentMetric]);

  // Update year range filter
  const setYearRange = useCallback(
    (start: number, end: number) => {
      setStartYear(start);
      setEndYear(end);

      // Filter data
      const filtered = filterDataByYearRange(fullData, start, end);
      setFilteredData(filtered);

      // Filter aggregates
      const filteredAggs = filterAggregatesByYearRange(fullYearlyAggregates, start, end);
      setYearlyAggregates(filteredAggs);

      // Recalculate temperature context
      const currentDateData = getCurrentDateData(filtered, currentDate);
      if (currentDateData.length > 0) {
        const currentTemp = currentDateData[0][currentMetric];
        const context = generateTemperatureContext(currentTemp, filtered, currentMetric);
        setTemperatureContext(context);
      }
    },
    [fullData, fullYearlyAggregates, currentDate, currentMetric]
  );

  // Refresh data (re-fetch)
  const refreshData = useCallback(async () => {
    await fetchData();
  }, [fetchData]);

  // Recalculate aggregates when metric changes
  useEffect(() => {
    if (fullData.length > 0) {
      const aggregates = calculateYearlyAggregates(fullData, currentMetric, currentDate);
      setFullYearlyAggregates(aggregates);

      const filteredAggs = filterAggregatesByYearRange(aggregates, startYear, endYear);
      setYearlyAggregates(filteredAggs);

      // Recalculate temperature context
      const currentDateData = getCurrentDateData(filteredData, currentDate);
      if (currentDateData.length > 0) {
        const currentTemp = currentDateData[0][currentMetric];
        const context = generateTemperatureContext(currentTemp, filteredData, currentMetric);
        setTemperatureContext(context);
      }
    }
  }, [currentMetric, fullData, currentDate, filteredData, startYear, endYear]);

  // Auto-fetch on mount and whenever location or target date changes.
  useEffect(() => {
    fetchData();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [location, currentDate]);

  const value: AppState = {
    location,
    setLocation,
    currentDate,
    setCurrentDate,
    currentMetric,
    setCurrentMetric,
    fullData,
    filteredData,
    fullYearlyAggregates,
    yearlyAggregates,
    availableYears,
    startYear,
    endYear,
    setYearRange,
    temperatureContext,
    loading,
    error,
    fetchData,
    refreshData,
  };

  return <AppContext.Provider value={value}>{children}</AppContext.Provider>;
};

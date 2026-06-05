import React, { createContext, useContext, useState, useCallback, useEffect } from 'react';
import CONFIG from '../utils/config';
import type { MetricKey } from '../utils/config';
import type { WeatherDataPoint, YearlyAggregate, Location, TemperatureContext } from '../types';
import { getTemperatureHistory, geolocateByIp } from '../services/api';
import { getCellMaxDate } from '../services/tieredData';
import { loadCells, snapToNearestCell } from '../services/cellIndex';
import { parsePath, buildPath, buildSlug } from '../services/urlState';
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

  // Last available date (YYYY-MM-DD) for the loaded cell — the date picker
  // caps its horizon to this so it never offers a day the data lacks.
  maxAvailableDate: string | null;

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
  // A shareable URL (/slug@lat,lon/date/metric) is the source of truth on load:
  // if the path parses, it seeds location/date/metric so a link reconstructs the
  // exact view with no geocoding. Bare root leaves the defaults below (then the
  // IP lookup in App may override the location).
  const initial =
    typeof window !== 'undefined'
      ? parsePath(window.location.pathname, window.location.search)
      : null;

  // Default location: Tel Aviv, Israel (unless the URL specified one).
  const [location, setLocation] = useState<Location>(
    initial
      ? { lat: initial.lat, lon: initial.lon, name: initial.name, distanceKm: initial.distanceKm }
      : { lat: 32.0853, lon: 34.7818, name: 'Tel Aviv, Israel' }
  );

  // Default to today's date (unless the URL specified one).
  const [currentDate, setCurrentDate] = useState<string>(() => {
    if (initial) return initial.date;
    const today = new Date();
    return today.toISOString().split('T')[0];
  });

  // Default to first active metric (unless the URL specified one).
  const [currentMetric, setCurrentMetric] = useState<MetricKey>(() => {
    if (initial) return initial.metric;
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

  // Last available date for the loaded cell (drives the picker's max).
  const [maxAvailableDate, setMaxAvailableDate] = useState<string | null>(null);

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
        CONFIG.chart.seasonalWindowDays
      );

      if (!data || data.length === 0) {
        throw new Error('No weather data received from the API. The location or date range might not be available.');
      }

      console.log(`Loaded ${data.length} records`);

      // Update full data
      setFullData(data);

      // Record the cell's last available date for the picker's horizon cap.
      // Populated by loadCellTimeline (run inside getTemperatureHistory above).
      setMaxAvailableDate(getCellMaxDate(location.lat, location.lon));

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

  // Bare-root visit (no shareable URL): guess the visitor's location from their
  // IP, snap it to a servable cell, and adopt it. Setting location then triggers
  // the fetch + URL-sync effects, so the address bar becomes shareable too. Runs
  // once, only when the URL didn't already pin a location.
  useEffect(() => {
    if (initial) return; // URL already decided the location
    let cancelled = false;
    (async () => {
      const [ip, cells] = await Promise.all([geolocateByIp(), loadCells()]);
      if (cancelled || !ip) return; // failure -> keep the default city
      const snapped = snapToNearestCell(ip.lat, ip.lon, cells);
      if (!snapped) return;
      setLocation({
        lat: snapped.cell.lat,
        lon: snapped.cell.lon,
        name: ip.name,
        distanceKm: snapped.distanceKm,
        slugParts: ip.slugParts,
      });
    })();
    return () => {
      cancelled = true;
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  // Keep the address bar in sync with state so the current view is always
  // shareable. replaceState (not push) so tweaking date/metric doesn't bury the
  // back button under one history entry per change. The slug prefers the
  // structured parts from a search; otherwise it's derived from the name (URL- or
  // IP-loaded locations), with the coords after '@' remaining canonical either way.
  useEffect(() => {
    if (typeof window === 'undefined') return;
    const slug = buildSlug(location.slugParts ?? (location.name ? location.name.split(',') : []));
    const path = buildPath({
      slug,
      lat: location.lat,
      lon: location.lon,
      date: currentDate,
      metric: currentMetric,
      distanceKm: location.distanceKm,
    });
    if (path !== window.location.pathname + window.location.search) {
      window.history.replaceState(null, '', path);
    }
  }, [location, currentDate, currentMetric]);

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
    maxAvailableDate,
    temperatureContext,
    loading,
    error,
    fetchData,
    refreshData,
  };

  return <AppContext.Provider value={value}>{children}</AppContext.Provider>;
};

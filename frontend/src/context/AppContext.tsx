import React, { createContext, useContext, useState, useCallback, useEffect } from 'react';
import CONFIG from '../utils/config';
import type { MetricKey } from '../utils/config';
import type { WeatherDataPoint, YearlyAggregate, Location, TemperatureContext } from '../types';
import { getTemperatureHistory, getCellYearTimeline, geolocateByIp } from '../services/api';
import { getCellHasArchive } from '../services/tieredData';
import { loadCells, snapToNearestCell, lookupCellName } from '../services/cellIndex';
import { parsePath, buildPath } from '../services/urlState';
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
  // The entire location record, NOT seasonally windowed (fullData is the ±N-day
  // slice). Feeds the radial year-context chart's whole-year cloud.
  yearTimeline: WeatherDataPoint[];
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

  // True when the chosen cell is valid/servable but its ERA5-Land archive hasn't
  // been backfilled yet — the UI shows a "coming soon" notice rather than an
  // error, since every clickable location WILL have data once the download
  // finishes.
  archivePending: boolean;

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
  // A shareable URL (/lat,lon/date/metric) is the source of truth on load:
  // if the path parses, it seeds location/date/metric so a link reconstructs the
  // exact view with no geocoding. Bare root leaves the defaults below (then the
  // IP lookup in App may override the location).
  const initial = typeof window !== 'undefined' ? parsePath(window.location.pathname) : null;

  // Default location: Tel Aviv, Israel (unless the URL specified one). A URL
  // carries coords only — the name is resolved from the cell list below.
  const [location, setLocation] = useState<Location>(
    initial
      ? { lat: initial.lat, lon: initial.lon, name: '' }
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
  const [yearTimeline, setYearTimeline] = useState<WeatherDataPoint[]>([]);
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
  const [archivePending, setArchivePending] = useState<boolean>(false);

  // Fetch weather data
  const fetchData = useCallback(async () => {
    setLoading(true);
    setError(null);
    setArchivePending(false);

    try {
      console.log('Fetching data for:', location, currentDate);

      // The seasonal slice (for the charts) and the full year timeline (for the
      // radial chart) share the same cached archive, so this is one download.
      const [data, timeline] = await Promise.all([
        getTemperatureHistory(
          location.lat,
          location.lon,
          currentDate,
          1940,
          CONFIG.chart.seasonalWindowDays
        ),
        getCellYearTimeline(location.lat, location.lon),
      ]);

      // A servable cell whose archive we haven't backfilled yet: it may have a
      // few forecast rows but no settled history, so there's nothing meaningful
      // to chart. Show the friendly "coming soon" notice instead of an error —
      // every clickable location gets data once the download catches up. Checked
      // before the empty-data guard so forecast-only cells take this path too.
      if (getCellHasArchive(location.lat, location.lon) === false) {
        setArchivePending(true);
        setFullData([]);
        setYearTimeline([]);
        setFilteredData([]);
        return;
      }

      if (!data || data.length === 0) {
        throw new Error('No weather data received from the API. The location or date range might not be available.');
      }

      console.log(`Loaded ${data.length} records`);

      // Update full data
      setFullData(data);
      setYearTimeline(timeline);

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
      // Adopt the snapped cell's own name (the only label we show), not the IP
      // service's, so it matches what a search or a shared link would display.
      setLocation({
        lat: snapped.cell.lat,
        lon: snapped.cell.lon,
        name: snapped.cell.name,
      });
    })();
    return () => {
      cancelled = true;
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  // A coords-only URL has no name; resolve it from the cell list so the search
  // box shows where the data is from. Runs once on a URL-seeded load — the local
  // lookup is instant, so the label appears without any blocking geocode.
  useEffect(() => {
    if (!initial) return; // a default/IP/search load already has a name
    let cancelled = false;
    lookupCellName(initial.lat, initial.lon).then((name) => {
      if (!cancelled && name) {
        setLocation((prev) => ({ ...prev, name }));
      }
    });
    return () => {
      cancelled = true;
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  // Keep the address bar in sync with state so the current view is always
  // shareable. replaceState (not push) so tweaking date/metric doesn't bury the
  // back button under one history entry per change. Coords are the only location
  // identity in the URL — the name is derived from them, never stored.
  useEffect(() => {
    if (typeof window === 'undefined') return;
    const path = buildPath({
      lat: location.lat,
      lon: location.lon,
      date: currentDate,
      metric: currentMetric,
    });
    if (path !== window.location.pathname) {
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
    yearTimeline,
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
    archivePending,
    fetchData,
    refreshData,
  };

  return <AppContext.Provider value={value}>{children}</AppContext.Provider>;
};

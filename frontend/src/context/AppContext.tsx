import React, { createContext, useContext, useState, useCallback, useEffect, useRef } from 'react';
import CONFIG from '../utils/config';
import type { MetricKey } from '../utils/config';
import type { WeatherDataPoint, YearlyAggregate, Location, TemperatureContext } from '../types';
import { geolocateByIp, parseDate, addDays } from '../services/api';
import { loadCellTimeline, getCellHasArchive, logMetricView } from '../services/tieredData';
import { fetchBands } from '../services/ci';
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

  // True when the last ensure-fresh call to the Worker failed — recent/forecast
  // data may be stale. The banner lets the user dismiss or retry.
  forecastUnavailable: boolean;
  dismissForecastWarning: () => void;

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

  // Default location: Reykjavík, Iceland (unless the URL specified one). A URL
  // carries coords only — the name is resolved from the cell list below.
  const [location, setLocation] = useState<Location>(
    initial
      ? { lat: initial.lat, lon: initial.lon, name: '' }
      : { lat: 64.1, lon: -21.9, name: 'Reykjavík, Iceland' }
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

  // Gate the first fetch on a bare-root visit until the IP lookup has resolved,
  // so we load the visitor's city directly instead of fetching the default city
  // first and then re-fetching after geolocation. A URL-seeded load already
  // knows its location, so it's resolved from the start.
  const [geoResolved, setGeoResolved] = useState<boolean>(initial !== null);

  // Loading & Error
  const [loading, setLoading] = useState<boolean>(false);
  const [error, setError] = useState<string | null>(null);
  const [archivePending, setArchivePending] = useState<boolean>(false);
  const [forecastUnavailable, setForecastUnavailable] = useState<boolean>(false);
  const [forecastWarningDismissed, setForecastWarningDismissed] = useState<boolean>(false);

  // Fetch weather data
  const fetchData = useCallback(async () => {
    setLoading(true);
    setError(null);
    setArchivePending(false);
    setForecastWarningDismissed(false);

    try {
      // The app's real page URL — built by the same function that fills the
      // address bar — so the analytics arrival hit logs the exact link (metric
      // and all) reliably, not a stale window.location read mid-navigation.
      const viewUrl = buildPath({
        lat: location.lat,
        lon: location.lon,
        date: currentDate,
        metric: currentMetric,
      });
      // One loadCellTimeline call: archive cached, ensure-fresh runs once,
      // forecastFresh tells us whether the Worker was reachable.
      const { data: timeline, forecastFresh } = await loadCellTimeline(
        location.lat,
        location.lon,
        viewUrl
      );
      setForecastUnavailable(!forecastFresh);

      // Attach local CatBoost confidence-interval bands to model-output rows
      // (dev-only; a no-op without the CI server). Mutates the timeline rows in
      // place so the filtered slices below share the same objects and carry the
      // band through to the card. Best-effort: fetchBands never throws.
      //
      // Forecast rows are model output for every metric. `recent` rows are model
      // output ONLY for precip/wind — the recent seam pulls those two from the
      // IFS historical-forecast API (era5_land lags), while recent temperature
      // is settled reanalysis. So recent rows keep precip/wind bands only; their
      // (settled) temperature stays band-free and is shown as the real value.
      const RECENT_MODEL_METRICS: MetricKey[] = ['precipitation_sum', 'wind_speed_10m_max'];
      const bandRows = timeline.filter(
        (d) => d.data_type === 'forecast' || d.data_type === 'recent'
      );
      if (bandRows.length > 0) {
        // Local calendar day (rows were parsed as local midnight) — matches the
        // CSV date and the model's day-of-year features.
        const isoLocal = (dt: Date) =>
          `${dt.getFullYear()}-${String(dt.getMonth() + 1).padStart(2, '0')}-${String(
            dt.getDate()
          ).padStart(2, '0')}`;
        const bands = await fetchBands(
          location.lat,
          location.lon,
          bandRows.map((d) => ({
            date: isoLocal(d.date),
            max_temperature: d.max_temperature,
            min_temperature: d.min_temperature,
            precipitation_sum: d.precipitation_sum,
            wind_speed_10m_max: d.wind_speed_10m_max,
          }))
        );
        for (const d of bandRows) {
          const b = bands[isoLocal(d.date)];
          if (!b) continue;
          if (d.data_type === 'recent') {
            // Drop the temperature bands the model also returns: recent temp is
            // settled era5_land, not a guess, so it gets no uncertainty band.
            const pw: NonNullable<WeatherDataPoint['band']> = {};
            for (const m of RECENT_MODEL_METRICS) if (b[m]) pw[m] = b[m];
            if (Object.keys(pw).length > 0) d.band = pw;
          } else {
            d.band = b;
          }
        }
      }

      // Seasonal slice for charts: filter the full timeline to ±seasonalWindowDays.
      const targetDt = parseDate(currentDate);
      const daysRange = CONFIG.chart.seasonalWindowDays;
      const data = timeline.filter((d) => {
        const year = d.date.getFullYear();
        const targetThisYear = new Date(year, targetDt.getMonth(), targetDt.getDate());
        const start = addDays(targetThisYear, -daysRange);
        const end = addDays(targetThisYear, daysRange);
        return d.date >= start && d.date <= end;
      });

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

      // Update full data
      setFullData(data);
      setYearTimeline(timeline); // full unfiltered timeline for radial chart

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

  const dismissForecastWarning = useCallback(() => {
    setForecastWarningDismissed(true);
  }, []);

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

  // Auto-fetch whenever location or target date changes — but on a bare-root
  // visit, wait for the IP lookup below to resolve first (geoResolved) so we
  // don't fetch the default city only to immediately re-fetch the visitor's.
  useEffect(() => {
    if (!geoResolved) return;
    fetchData();
    // Key off the coordinates, not the whole `location` object: a shared/coords
    // link mounts with name:'' and a separate effect fills the name in via
    // setLocation, minting a new object reference. Depending on `location` here
    // would re-fire this fetch on that cosmetic change — a double ensure-fresh
    // (and a duplicate `view` analytics hit) on every shared-link load. The name
    // never affects what we fetch, so lat/lon are the real fetch identity.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [location.lat, location.lon, currentDate, geoResolved]);

  // Bare-root visit (no shareable URL): guess the visitor's location from their
  // IP, snap it to a servable cell, and adopt it. Setting location then triggers
  // the fetch + URL-sync effects, so the address bar becomes shareable too. Runs
  // once, only when the URL didn't already pin a location. Either way it flips
  // geoResolved so the gated fetch above runs exactly once with the final
  // location (the snapped city on success, the default city on any failure).
  useEffect(() => {
    if (initial) return; // URL already decided the location (geoResolved=true)
    let cancelled = false;
    (async () => {
      try {
        const [ip, cells] = await Promise.all([geolocateByIp(), loadCells()]);
        if (cancelled) return;
        const snapped = ip ? snapToNearestCell(ip.lat, ip.lon, cells) : null;
        // Adopt the snapped cell's own name (the only label we show), not the IP
        // service's, so it matches what a search or a shared link would display.
        if (snapped) {
          setLocation({
            lat: snapped.cell.lat,
            lon: snapped.cell.lon,
            name: snapped.cell.name,
          });
        }
      } finally {
        // Release the fetch gate on every path — success or failure (which keeps
        // the default city) — so the bare-root visit always loads something.
        if (!cancelled) setGeoResolved(true);
      }
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

  // Analytics: tell the backend when the user switches metric in-app — the one
  // interaction the server can't otherwise see. Skips the initial mount (a fresh
  // load / shared link is already logged by ensure-fresh's arrival hit) and only
  // fires on a metric change, sending the app's canonical URL for the new metric.
  const metricPinged = useRef(false);
  useEffect(() => {
    if (!metricPinged.current) {
      metricPinged.current = true;
      return;
    }
    logMetricView(
      buildPath({
        lat: location.lat,
        lon: location.lon,
        date: currentDate,
        metric: currentMetric,
      })
    );
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [currentMetric]);

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
    forecastUnavailable: forecastUnavailable && !forecastWarningDismissed,
    dismissForecastWarning,
    fetchData,
    refreshData,
  };

  return <AppContext.Provider value={value}>{children}</AppContext.Provider>;
};

// Type definitions for the application

export type { MetricKey } from '../utils/config';
import type { MetricKey } from '../utils/config';

/**
 * A bias-corrected 9-quantile CDF for one metric on one day, in native units
 * (°C / mm / m·s⁻¹): q0.01, q0.05 (`lo`), q0.10, q0.25, q0.50 (`mid` — the
 * bias-corrected best estimate), q0.75, q0.90, q0.95 (`hi`), q0.99. All nine are
 * TRAINED heads read straight off the cell's static R2 debias table.
 * Present on forecast/recent rows; absent on settled history.
 */
export interface MetricBand {
  q01: number;
  lo: number;
  q10: number;
  q25: number;
  mid: number;
  q75: number;
  q90: number;
  hi: number;
  q99: number;
}

export interface WeatherDataPoint {
  date: Date;
  year: number;
  // 'historical' = settled archive (ERA5-Land reanalysis). 'recent' = days near the
  // present frontier where temperature IS settled ERA5-Land, but precip & wind are
  // STILL IFS-HRES forecast (ERA5-Land lags) — so recent precip/wind carry forecast
  // bias and get debiased just like a forecast, while recent temperature does not
  // (see AppContext / services/ci.ts). 'forecast' = future IFS-HRES output (all
  // metrics), fully bias-corrected for display.
  data_type: 'historical' | 'recent' | 'forecast';
  max_temperature?: number;
  min_temperature?: number;
  precipitation_sum?: number;
  wind_speed_10m_max?: number;
  // Forecast-uncertainty band per metric (forecast rows only).
  band?: Partial<Record<MetricKey, MetricBand>>;
}

export interface YearlyAggregate {
  year: number;
  date: Date;
  p10: number | undefined;
  p25: number | undefined;
  p50: number | undefined;
  p75: number | undefined;
  p90: number | undefined;
  movingMedian: number | null;
  moving10: number | null;
  moving25: number | null;
  moving75: number | null;
  moving90: number | null;
}

export interface TemperatureContext {
  percentile: string;
  description: string;
}

export interface Location {
  lat: number;
  lon: number;
  /** The label shown in the search box — always the served cell's own name. */
  name?: string;
  display_name?: string;
}

export interface DataExtents {
  dateExtent: [Date, Date];
  tempExtent: [number, number];
}

export interface ApiArchiveResponse {
  daily: {
    time: string[];
    apparent_temperature_max?: number[];
    apparent_temperature_min?: number[];
    precipitation_sum?: number[];
    wind_speed_10m_max?: number[];
  };
}

export interface ApiForecastResponse {
  daily: {
    time: string[];
    apparent_temperature_max?: number[];
    apparent_temperature_min?: number[];
    precipitation_sum?: number[];
    wind_speed_10m_max?: number[];
  };
}

/**
 * A geocoder hit, normalized to the shape LocationSelector consumes. We geocode
 * via Photon (komoot), whose GeoJSON we flatten into this in searchCities.
 * `display_name` is "Primary, detail, Country"; `type` is Photon's osm_value
 * (city/town/village/...) so the existing place-type filter still works.
 */
export interface GeocodeResult {
  display_name: string;
  lat: string;
  lon: string;
  type: string;
}

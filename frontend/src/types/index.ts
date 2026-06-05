// Type definitions for the application

export type { MetricKey } from '../utils/config';

export interface WeatherDataPoint {
  date: Date;
  year: number;
  data_type: 'historical' | 'forecast';
  max_temperature?: number;
  min_temperature?: number;
  precipitation_sum?: number;
  wind_speed_10m_max?: number;
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
  ranking?: string;
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

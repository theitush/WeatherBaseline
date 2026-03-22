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

export interface NominatimResult {
  display_name: string;
  lat: string;
  lon: string;
  name?: string;
  type: string;
  importance: number;
}

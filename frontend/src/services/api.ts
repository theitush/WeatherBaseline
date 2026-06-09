// API service. Weather data now comes from the v2 tiered cell files (see
// tieredData.ts); only city search still hits a live API here.
import { loadCellTimeline, apiUrl } from './tieredData';
import type { WeatherDataPoint, GeocodeResult } from '../types';

/**
 * Format date to YYYY-MM-DD string
 */
export function formatDate(date: Date): string {
  return date.toISOString().split('T')[0];
}

/**
 * Parse date from YYYY-MM-DD string
 */
export function parseDate(dateString: string): Date {
  return new Date(dateString + 'T00:00:00');
}

/**
 * Add days to a date
 */
export function addDays(date: Date, days: number): Date {
  const result = new Date(date);
  result.setDate(result.getDate() + days);
  return result;
}

/**
 * Days-of-year window: keep only dates within ±daysRange of the target's
 * month/day, across every year. This is the seasonal slice the chart plots —
 * the cell files hold the whole 1950→+3d timeline, so we filter client-side.
 */
function withinSeasonalWindow(d: Date, targetDt: Date, daysRange: number): boolean {
  const year = d.getFullYear();
  const targetThisYear = new Date(year, targetDt.getMonth(), targetDt.getDate());
  const start = addDays(targetThisYear, -daysRange);
  const end = addDays(targetThisYear, daysRange);
  return d >= start && d <= end;
}

/**
 * Get temperature history for a date (±daysRange) across all available years.
 * v2: reads the merged tiered cell timeline (archive+recent+forecast) instead
 * of the retired /api/archive + /api/forecast proxy. Signature unchanged so
 * callers don't move; startYear is implicit in the archive's coverage.
 */
export async function getTemperatureHistory(
  latitude: number,
  longitude: number,
  targetDate: string,
  _startYear: number = 1940,
  daysRange: number = 7
): Promise<WeatherDataPoint[]> {
  console.log(`Getting ${targetDate} ±${daysRange} days data for ${latitude}, ${longitude}`);

  const targetDt = parseDate(targetDate);

  // No horizon guard here: the date picker already caps selection to the cell's
  // real last available date (which varies by timezone), so anything that
  // reaches this point is in-range. Dates with no data just filter to empty.
  const { data: timeline } = await loadCellTimeline(latitude, longitude);
  return timeline.filter((d) => withinSeasonalWindow(d.date, targetDt, daysRange));
}

/**
 * Full unfiltered daily timeline for a cell (every day, every year) — the
 * whole-year cloud the radial chart plots. Unlike getTemperatureHistory this
 * applies no seasonal window. The archive tier is cached (see tieredData), so
 * when called alongside getTemperatureHistory for the same cell it's free.
 */
export async function getCellYearTimeline(
  latitude: number,
  longitude: number
): Promise<WeatherDataPoint[]> {
  const { data } = await loadCellTimeline(latitude, longitude);
  return data;
}

/** A coarse location guessed from the visitor's IP, for a bare-root visit. */
export interface IpLocation {
  lat: number;
  lon: number;
  name: string;
}

/**
 * Ask the backend to guess the visitor's location from their IP. Best-effort:
 * resolves to null on any failure so the caller falls back to a default city.
 */
export async function geolocateByIp(): Promise<IpLocation | null> {
  try {
    const res = await fetch(apiUrl('/api/geo'));
    if (!res.ok) return null;
    const data = await res.json();
    if (typeof data.lat !== 'number' || typeof data.lon !== 'number') return null;
    return {
      lat: data.lat,
      lon: data.lon,
      name: data.name ?? '',
    };
  } catch {
    return null;
  }
}

/** Photon GeoJSON feature — only the fields we actually read. */
interface PhotonFeature {
  geometry: { coordinates: [number, number] }; // [lon, lat]
  properties: {
    name?: string;
    city?: string;
    state?: string;
    county?: string;
    country?: string;
    countrycode?: string;
    osm_key?: string;
    osm_value?: string;
  };
}

/**
 * Build "Primary, detail, Country" from Photon's structured fields. Photon
 * gives us clean components instead of Nominatim's verbose display_name, so we
 * assemble a tidy label and de-dupe parts that repeat (e.g. name === city).
 */
function photonDisplayName(p: PhotonFeature['properties']): string {
  const parts = [p.name, p.city, p.county, p.state, p.country]
    .filter((v): v is string => Boolean(v))
    .filter((v, i, arr) => arr.indexOf(v) === i); // drop dupes, keep order
  return parts.join(', ');
}

/**
 * Search for places using Photon (komoot) — an autocomplete-oriented geocoder.
 * Returns results normalized to GeocodeResult. Pass an AbortSignal so the caller
 * can cancel a stale in-flight request when the query changes; an abort resolves
 * to [] rather than throwing.
 */
export async function searchCities(
  query: string,
  signal?: AbortSignal
): Promise<GeocodeResult[]> {
  if (!query || query.trim().length < 2) {
    return [];
  }

  const params = new URLSearchParams({
    q: query,
    limit: '10', // we filter by place type client-side, so over-fetch a bit
  });

  const url = `https://photon.komoot.io/api?${params}`;

  try {
    const response = await fetch(url, { signal });

    if (!response.ok) {
      throw new Error(`Geocoding failed: ${response.status}`);
    }

    const data: { features?: PhotonFeature[] } = await response.json();
    return (data.features ?? []).map((f) => ({
      display_name: photonDisplayName(f.properties),
      lat: String(f.geometry.coordinates[1]),
      lon: String(f.geometry.coordinates[0]),
      type: f.properties.osm_value ?? '',
    }));
  } catch (error) {
    // A cancelled request is expected churn, not a failure — stay quiet.
    if (error instanceof DOMException && error.name === 'AbortError') {
      return [];
    }
    console.error('Error searching cities:', error);
    return [];
  }
}

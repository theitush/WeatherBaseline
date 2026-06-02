// API service. Weather data now comes from the v2 tiered cell files (see
// tieredData.ts); only city search still hits a live API here.
import { loadCellTimeline } from './tieredData';
import type { WeatherDataPoint, NominatimResult } from '../types';

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
  const currentDate = new Date();
  currentDate.setHours(0, 0, 0, 0);

  // Forecast tier reaches +3 days; anything beyond that isn't available.
  if (targetDt > addDays(currentDate, 3)) {
    throw new Error(`${targetDate} should be within 3 days of today!`);
  }

  const timeline = await loadCellTimeline(latitude, longitude);
  return timeline.filter((d) => withinSeasonalWindow(d.date, targetDt, daysRange));
}

/**
 * Search for cities using Nominatim geocoding API
 */
export async function searchCities(query: string): Promise<NominatimResult[]> {
  if (!query || query.trim().length < 2) {
    return [];
  }

  const params = new URLSearchParams({
    q: query,
    format: 'json',
    limit: '6',
    addressdetails: '1',
  });

  const url = `https://nominatim.openstreetmap.org/search?${params}`;

  try {
    const response = await fetch(url, {
      headers: {
        'User-Agent': 'HowHotWasIt Weather App',
      },
    });

    if (!response.ok) {
      throw new Error(`Geocoding failed: ${response.status}`);
    }

    const results: NominatimResult[] = await response.json();
    return results;
  } catch (error) {
    console.error('Error searching cities:', error);
    return [];
  }
}

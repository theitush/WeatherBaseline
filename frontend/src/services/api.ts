// API service for Open-Meteo weather data
import CONFIG from '../utils/config';
import type { WeatherDataPoint, ApiArchiveResponse, ApiForecastResponse, NominatimResult } from '../types';

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
 * Fetch historical weather data from archive API
 */
async function fetchHistoricalData(
  latitude: number,
  longitude: number,
  startDate: string,
  endDate: string,
  targetDt: Date,
  daysRange: number
): Promise<Partial<WeatherDataPoint>[]> {
  // Dynamic API request based on active metrics in CONFIG
  const activeMetricsString = CONFIG.getActiveMetricsApiString();
  console.log(`🔧 Active metrics for API: ${activeMetricsString}`);

  const params = new URLSearchParams({
    latitude: latitude.toString(),
    longitude: longitude.toString(),
    start_date: startDate,
    end_date: endDate,
    daily: activeMetricsString,
    timezone: 'auto',
  });

  const url = `/api/archive?${params}`;

  const response = await fetch(url, {
    method: 'GET',
    headers: {
      Accept: 'application/json',
    },
  });

  if (!response.ok) {
    // Try to get detailed error from server
    let errorMessage = `HTTP error! status: ${response.status} (${response.statusText})`;

    try {
      const errorData = await response.json();
      if (errorData.message) {
        errorMessage = errorData.message;
      }
      if (errorData.suggestion) {
        errorMessage += ` ${errorData.suggestion}`;
      }
    } catch (e) {
      // If we can't parse error JSON, use default message
    }

    throw new Error(errorMessage);
  }

  const data: ApiArchiveResponse & { _cacheStatus?: string; _cachedRecords?: number; _newRecords?: number } =
    await response.json();

  // Log cache status information if available
  if (data._cacheStatus) {
    if (data._cacheStatus === 'HIT') {
      console.log(`Cache hit: served ${data._cachedRecords} records from cache`);
    } else if (data._cacheStatus === 'MISS_EMPTY') {
      console.log(`Cache miss: fetching all data from API`);
    } else if (data._cacheStatus === 'MISS_PARTIAL') {
      console.log(`Cache partial: adding ${data._newRecords} new records to existing cache`);
    }
  }

  const dataRows: Partial<WeatherDataPoint>[] = [];

  if (data.daily && data.daily.time) {
    const dates = data.daily.time;

    // Dynamically extract data based on active metrics
    const maxTemps = CONFIG.isMetricActive('max_temperature')
      ? data.daily.apparent_temperature_max
      : [];
    const minTemps = CONFIG.isMetricActive('min_temperature')
      ? data.daily.apparent_temperature_min
      : [];
    const precipitation = CONFIG.isMetricActive('precipitation_sum')
      ? data.daily.precipitation_sum || []
      : [];
    const windSpeed = CONFIG.isMetricActive('wind_speed_10m_max')
      ? data.daily.wind_speed_10m_max || []
      : [];

    // Create a row for each date
    for (let i = 0; i < dates.length; i++) {
      // Only require active temperature metrics to be non-null
      const hasRequiredData =
        (!CONFIG.isMetricActive('max_temperature') ||
          (maxTemps[i] !== null && maxTemps[i] !== undefined)) &&
        (!CONFIG.isMetricActive('min_temperature') ||
          (minTemps[i] !== null && minTemps[i] !== undefined));

      if (hasRequiredData) {
        const dateDt = parseDate(dates[i]);
        const year = dateDt.getFullYear();

        // Check if this date is within the target range for this year
        const targetDateThisYear = new Date(year, targetDt.getMonth(), targetDt.getDate());
        const startRange = addDays(targetDateThisYear, -daysRange);
        const endRange = addDays(targetDateThisYear, daysRange);

        if (dateDt >= startRange && dateDt <= endRange) {
          const row: Partial<WeatherDataPoint> = {
            date: dates[i] as any, // Will be converted to Date later
            data_type: 'historical',
          };

          // Only include active metrics in the data row
          if (CONFIG.isMetricActive('min_temperature')) {
            row.min_temperature = minTemps[i];
          }
          if (CONFIG.isMetricActive('max_temperature')) {
            row.max_temperature = maxTemps[i];
          }
          if (CONFIG.isMetricActive('precipitation_sum')) {
            row.precipitation_sum =
              precipitation.length > i && precipitation[i] !== null ? precipitation[i] : 0;
          }
          if (CONFIG.isMetricActive('wind_speed_10m_max')) {
            row.wind_speed_10m_max =
              windSpeed.length > i && windSpeed[i] !== null ? windSpeed[i] : 0;
          }

          dataRows.push(row);
        }
      }
    }
  }

  return dataRows;
}

/**
 * Fetch forecast weather data from forecast API
 */
async function fetchForecastData(
  latitude: number,
  longitude: number,
  startDate: string,
  endDate: string
): Promise<Partial<WeatherDataPoint>[]> {
  // Dynamic API request based on active metrics in CONFIG
  const activeMetricsString = CONFIG.getActiveMetricsApiString();

  const params = new URLSearchParams({
    latitude: latitude.toString(),
    longitude: longitude.toString(),
    start_date: startDate,
    end_date: endDate,
    daily: activeMetricsString,
    timezone: 'auto',
  });

  const url = `/api/forecast?${params}`;

  const response = await fetch(url, {
    method: 'GET',
    headers: {
      Accept: 'application/json',
    },
  });

  if (!response.ok) {
    // Try to get detailed error from server
    let errorMessage = `HTTP error! status: ${response.status} (${response.statusText})`;

    try {
      const errorData = await response.json();
      if (errorData.message) {
        errorMessage = errorData.message;
      }
      if (errorData.suggestion) {
        errorMessage += ` ${errorData.suggestion}`;
      }
    } catch (e) {
      // If we can't parse error JSON, use default message
    }

    throw new Error(errorMessage);
  }

  const data: ApiForecastResponse = await response.json();
  console.log(`Forecast: ${data.daily?.time?.length || 0} records (not cached)`);

  const dataRows: Partial<WeatherDataPoint>[] = [];

  if (data.daily && data.daily.time) {
    const dates = data.daily.time;

    // Dynamically extract data based on active metrics
    const maxTemps = CONFIG.isMetricActive('max_temperature')
      ? data.daily.apparent_temperature_max
      : [];
    const minTemps = CONFIG.isMetricActive('min_temperature')
      ? data.daily.apparent_temperature_min
      : [];
    const precipitation = CONFIG.isMetricActive('precipitation_sum')
      ? data.daily.precipitation_sum
      : [];
    const windSpeed = CONFIG.isMetricActive('wind_speed_10m_max')
      ? data.daily.wind_speed_10m_max
      : [];

    // Create a row for each date
    for (let i = 0; i < dates.length; i++) {
      // Only require active temperature metrics to be non-null
      const hasRequiredData =
        (!CONFIG.isMetricActive('max_temperature') ||
          (maxTemps[i] !== null && maxTemps[i] !== undefined)) &&
        (!CONFIG.isMetricActive('min_temperature') ||
          (minTemps[i] !== null && minTemps[i] !== undefined));

      if (hasRequiredData) {
        const row: Partial<WeatherDataPoint> = {
          date: dates[i] as any, // Will be converted to Date later
          data_type: 'forecast',
        };

        // Only include active metrics in the data row
        if (CONFIG.isMetricActive('min_temperature')) {
          row.min_temperature = minTemps[i];
        }
        if (CONFIG.isMetricActive('max_temperature')) {
          row.max_temperature = maxTemps[i];
        }
        if (CONFIG.isMetricActive('precipitation_sum')) {
          row.precipitation_sum = precipitation[i] || 0;
        }
        if (CONFIG.isMetricActive('wind_speed_10m_max')) {
          row.wind_speed_10m_max = windSpeed[i] || 0;
        }

        dataRows.push(row);
      }
    }
  }

  console.log(`📊 [API DATA] Forecast API processed ${dataRows.length} matching records`);
  return dataRows;
}

/**
 * Process data rows and add computed fields
 */
function processDataRows(dataRows: Partial<WeatherDataPoint>[]): WeatherDataPoint[] {
  return dataRows.map((row) => ({
    ...row,
    date: parseDate(row.date as any as string),
    year: parseDate(row.date as any as string).getFullYear(),
  })) as WeatherDataPoint[];
}

/**
 * Get temperature history for a specific date range across all available years
 */
export async function getTemperatureHistory(
  latitude: number,
  longitude: number,
  targetDate: string,
  startYear: number = 1940,
  daysRange: number = 7
): Promise<WeatherDataPoint[]> {
  console.log(`Getting ${targetDate} ±${daysRange} days data for ${latitude}, ${longitude}`);

  // Parse the target date
  const targetDt = parseDate(targetDate);
  const currentDate = new Date();
  currentDate.setHours(0, 0, 0, 0); // Reset time for comparison

  // Validate target date
  const maxDate = addDays(currentDate, 3);
  if (targetDt > maxDate) {
    throw new Error(`${targetDate} should be within 3 days of today!`);
  }

  // Calculate end date based on target date + days range in current year
  const currentYear = currentDate.getFullYear();
  const targetDateCurrentYear = new Date(currentYear, targetDt.getMonth(), targetDt.getDate());
  const endDate = addDays(targetDateCurrentYear, daysRange);

  const overallStartStr = '1940-01-01';
  const endDateStr = formatDate(endDate);

  const dataRows: Partial<WeatherDataPoint>[] = [];

  // Make historical API request
  const historicalData = await fetchHistoricalData(
    latitude,
    longitude,
    overallStartStr,
    endDateStr,
    targetDt,
    daysRange
  );
  dataRows.push(...historicalData);

  // Get forecast data if target date is beyond actual historical data
  if (historicalData.length > 0) {
    // Find the actual last date in historical data
    const historicalDates = historicalData.map((row) => parseDate(row.date as any as string));
    const lastHistoricalDate = new Date(Math.max(...historicalDates.map((d) => d.getTime())));

    // Only fetch forecast if target date is beyond last historical date
    if (targetDt > lastHistoricalDate) {
      // Forecast should start from day after last historical date
      const forecastStartDate = addDays(lastHistoricalDate, 1);
      const forecastStartStr = formatDate(forecastStartDate);

      console.log(`📡 Fetching forecast from ${forecastStartStr} to ${targetDate}`);
      const forecastData = await fetchForecastData(
        latitude,
        longitude,
        forecastStartStr,
        targetDate
      );
      dataRows.push(...forecastData);
    }
  } else {
    // No historical data, check if we need forecast from current date
    if (targetDt >= currentDate) {
      const todayStr = formatDate(currentDate);
      console.log(`📡 No historical data, fetching forecast from ${todayStr} to ${targetDate}`);
      const forecastData = await fetchForecastData(latitude, longitude, todayStr, targetDate);
      dataRows.push(...forecastData);
    }
  }

  // Process and return data
  return processDataRows(dataRows);
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

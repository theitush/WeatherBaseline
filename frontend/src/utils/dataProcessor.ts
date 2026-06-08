// Data processing utilities
import * as d3 from 'd3';
import CONFIG from './config';
import type { MetricKey } from './config';
import type { WeatherDataPoint, YearlyAggregate, TemperatureContext, DataExtents } from '../types';

// Parse a YYYY-MM-DD target date as LOCAL midnight. A bare `new Date("YYYY-MM-DD")`
// is parsed as UTC, while the data rows (tieredData) and the seasonal window
// (api.parseDate) use local midnight — so mixing them shifts the matched day by
// one in any timezone west of UTC (e.g. Mexico), desyncing the spectrum card and
// stats from the chart. Always go through this so every path agrees on the day.
function parseLocalDate(dateString: string): Date {
  return new Date(dateString + 'T00:00:00');
}

/**
 * Canonical comparison pool for rarity/percentile claims. Drops only FUTURE
 * forecasts (model guesses for days that haven't happened); forecast rows dated
 * today or earlier are kept, since those are recent reanalysis-quality figures
 * and more accurate than excluding them. Both the prose verdict
 * (TemperatureContext) and the histogram brackets (HistogramChart) MUST run off
 * this same pool, and compare strictly (> / <), so their percentages agree.
 */
export function comparablePool(data: WeatherDataPoint[]): WeatherDataPoint[] {
  const today = new Date();
  today.setHours(0, 0, 0, 0);
  return data.filter(
    (d) => !(d.data_type === 'forecast' && d.date.getTime() > today.getTime())
  );
}

/**
 * Calculate yearly aggregates with percentiles and rolling medians
 */
export function calculateYearlyAggregates(
  data: WeatherDataPoint[],
  currentMetric: MetricKey,
  currentDate: string
): YearlyAggregate[] {
  if (!data || data.length === 0) {
    console.log('No data provided to calculateYearlyAggregates');
    return [];
  }

  // Only calculate aggregates if the current metric is active
  if (!CONFIG.isMetricActive(currentMetric)) {
    console.log(`Metric ${currentMetric} is not active, skipping aggregates calculation`);
    return [];
  }

  const yearGroups = d3.group(data, (d) => d.year);
  console.log('Year groups:', yearGroups.size);
  const aggregates: YearlyAggregate[] = [];

  yearGroups.forEach((values, year) => {
    // Filter out null/undefined values for the current metric
    const metricValues = values
      .map((d) => d[currentMetric])
      .filter((v): v is number => v !== null && v !== undefined);

    if (metricValues.length === 0) return; // Skip if no valid data

    const temps = metricValues.sort(d3.ascending);
    const cd = parseLocalDate(currentDate);
    const targetDate = new Date(year, cd.getMonth(), cd.getDate());

    aggregates.push({
      year: year,
      date: targetDate,
      p10: d3.quantile(temps, 0.1),
      p25: d3.quantile(temps, 0.25),
      p50: d3.quantile(temps, 0.5),
      p75: d3.quantile(temps, 0.75),
      p90: d3.quantile(temps, 0.9),
      movingMedian: null,
      moving10: null,
      moving25: null,
      moving75: null,
      moving90: null,
    });
  });

  // Calculate moving averages (±2 years window, 5 total) - only show after having 2 years before and after
  aggregates.sort((a, b) => a.year - b.year);
  const windowRadius = 2; // ±2 years around current year

  aggregates.forEach((d, i) => {
    // Only calculate rolling median if we have at least 2 years before and 2 years after (so 5 years total)
    if (i >= windowRadius && i < aggregates.length - windowRadius) {
      // Take ±2 years around current year (5 years total)
      const start = i - windowRadius;
      const end = i + windowRadius + 1;
      const window = aggregates.slice(start, end);

      d.movingMedian = d3.median(window, (d) => d.p50) ?? null;
      d.moving10 = d3.median(window, (d) => d.p10) ?? null;
      d.moving25 = d3.median(window, (d) => d.p25) ?? null;
      d.moving75 = d3.median(window, (d) => d.p75) ?? null;
      d.moving90 = d3.median(window, (d) => d.p90) ?? null;
    } else {
      // Set to null for years that don't have enough surrounding data
      d.movingMedian = null;
      d.moving10 = null;
      d.moving25 = null;
      d.moving75 = null;
      d.moving90 = null;
    }
  });

  return aggregates;
}

/**
 * Filter data based on year range
 */
export function filterDataByYearRange(
  data: WeatherDataPoint[],
  startYear: number,
  endYear: number
): WeatherDataPoint[] {
  const filtered = data.filter((d) => d.year >= startYear && d.year <= endYear);
  console.log(`Filtered data: ${filtered.length} rows for years ${startYear}-${endYear}`);
  return filtered;
}

/**
 * Filter yearly aggregates by year range
 */
export function filterAggregatesByYearRange(
  aggregates: YearlyAggregate[],
  startYear: number,
  endYear: number
): YearlyAggregate[] {
  const filtered = aggregates.filter((d) => d.year >= startYear && d.year <= endYear);
  console.log(`Yearly aggregates: ${filtered.length} items`);
  return filtered;
}

/**
 * Get data for the current/target date
 */
export function getCurrentDateData(
  data: WeatherDataPoint[],
  currentDate: string
): WeatherDataPoint[] {
  return data.filter(
    (d) => d.date.toDateString() === parseLocalDate(currentDate).toDateString()
  );
}

/**
 * Calculate temperature percentile
 */
export function calculateTemperaturePercentile(
  currentTemp: number,
  data: WeatherDataPoint[],
  currentMetric: MetricKey
): number {
  const validData = data.filter((d) => d[currentMetric] !== null && d[currentMetric] !== undefined);
  const higherCount = validData.filter((d) => (d[currentMetric] ?? 0) > currentTemp).length;
  const totalCount = validData.length;
  return (higherCount / totalCount) * 100;
}

/**
 * Get ordinal suffix for numbers (1st, 2nd, 3rd, etc.)
 */
function getOrdinalSuffix(num: number): string {
  const j = num % 10;
  const k = num % 100;
  if (j === 1 && k !== 11) return 'st';
  if (j === 2 && k !== 12) return 'nd';
  if (j === 3 && k !== 13) return 'rd';
  return 'th';
}

/**
 * Phrase vocabulary per metric. Each metric reads as a low↔high spectrum at
 * three intensities (mild / strong / extreme) plus a shared "normal" bank:
 *   - temperature: cold ↔ hot
 *   - precipitation: dry ↔ wet
 *   - wind: calm ↔ gusty
 * `rankLow`/`rankHigh` name the ends for the "Nth Xest in dataset!" line.
 * The percentile branching that picks a bank is identical across metrics.
 */
interface MetricPhrases {
  normal: string[];
  mildLow: string[];
  mildHigh: string[];
  strongLow: string[];
  strongHigh: string[];
  extremeLow: string[];
  extremeHigh: string[];
  rankLow: string;
  rankHigh: string;
}

const TEMP_PHRASES: MetricPhrases = {
  normal: [
    'Pretty typical', 'Normal range', 'Average temp', 'Nothing unusual',
    'Right on track', 'Nothing special', 'Just average', 'Not exciting',
  ],
  mildLow: [
    'A bit cool', 'Slightly chilly', 'Cooler side', 'Touch below normal',
    'Mildly cold', 'A bit brisk', 'Slightly frosty', 'A bit nippy',
    'Somewhat chilly', 'A bit fresh', 'A bit crisp', 'Sorta cool',
  ],
  mildHigh: [
    'A bit warm', 'Slightly toasty', 'Warmer side', 'Touch above normal',
    'Mildly hot', 'A bit balmy', 'Slightly sultry', 'A bit steamy',
    'Somewhat warm', 'Sorta hot',
  ],
  strongLow: [
    'Unusually cold', 'Quite chilly', 'Pretty frigid', 'Really cool',
    'Very cold', 'Bitterly cold', 'Chill af', 'Nippy!',
  ],
  strongHigh: [
    'Unusually hot', 'Quite toasty', 'Pretty scorching', 'Really warm',
    'Very hot', 'Hot af', 'Sweltering', 'Scorching',
  ],
  extremeLow: [
    'Exceptionally frigid!', 'Bone-chilling!', 'Historic freeze!',
    'Brutal cold!', 'Arctic blast!',
  ],
  extremeHigh: [
    'Scorching rare heat!', 'Blazing anomaly!', 'Infernal heat!',
    'Blistering hot!', 'Record heat!',
  ],
  rankLow: 'coldest',
  rankHigh: 'hottest',
};

const PRECIP_PHRASES: MetricPhrases = {
  normal: [
    'Pretty typical', 'Normal range', 'Average rainfall', 'Nothing unusual',
    'Right on track', 'Nothing special', 'Just average', 'Not exciting',
  ],
  mildLow: [
    'A bit dry', 'Slightly dry', 'Drier side', 'Touch below normal',
    'Mildly dry', 'A bit parched', 'Somewhat dry', 'Sorta dry',
  ],
  mildHigh: [
    'A bit wet', 'Slightly damp', 'Wetter side', 'Touch above normal',
    'Mildly wet', 'A bit drizzly', 'Somewhat wet', 'Sorta soggy',
  ],
  strongLow: [
    'Unusually dry', 'Quite dry', 'Pretty parched', 'Really dry',
    'Very dry', 'Bone dry', 'Arid af', 'Drought-ish',
  ],
  strongHigh: [
    'Unusually wet', 'Quite soggy', 'Pretty soaking', 'Really wet',
    'Very wet', 'Wet af', 'Drenching', 'Soaking',
  ],
  extremeLow: [
    'Exceptionally dry!', 'Bone-dry record!', 'Historic drought!',
    'Brutally arid!', 'Dust-bowl dry!',
  ],
  extremeHigh: [
    'Torrential rare rain!', 'Drenching anomaly!', 'Deluge!',
    'Flooding rain!', 'Record downpour!',
  ],
  rankLow: 'driest',
  rankHigh: 'wettest',
};

const WIND_PHRASES: MetricPhrases = {
  normal: [
    'Pretty typical', 'Normal range', 'Average wind', 'Nothing unusual',
    'Right on track', 'Nothing special', 'Just average', 'Not exciting',
  ],
  mildLow: [
    'A bit calm', 'Slightly still', 'Calmer side', 'Touch below normal',
    'Mildly calm', 'A bit settled', 'Somewhat still', 'Sorta calm',
  ],
  mildHigh: [
    'A bit breezy', 'Slightly gusty', 'Breezier side', 'Touch above normal',
    'Mildly windy', 'A bit blustery', 'Somewhat breezy', 'Sorta gusty',
  ],
  strongLow: [
    'Unusually calm', 'Quite still', 'Pretty dead-calm', 'Really calm',
    'Very still', 'Dead calm', 'Calm af', 'Eerily still',
  ],
  strongHigh: [
    'Unusually windy', 'Quite gusty', 'Pretty blustery', 'Really windy',
    'Very gusty', 'Windy af', 'Howling', 'Blustery',
  ],
  extremeLow: [
    'Exceptionally calm!', 'Dead-still record!', 'Historic lull!',
    'Glassy calm!', 'Not a breath!',
  ],
  extremeHigh: [
    'Ferocious rare wind!', 'Howling anomaly!', 'Gale-force!',
    'Blasting gusts!', 'Record winds!',
  ],
  rankLow: 'calmest',
  rankHigh: 'windiest',
};

const METRIC_PHRASES: Record<MetricKey, MetricPhrases> = {
  max_temperature: TEMP_PHRASES,
  min_temperature: TEMP_PHRASES,
  precipitation_sum: PRECIP_PHRASES,
  wind_speed_10m_max: WIND_PHRASES,
};

/**
 * Generate context message with percentile ranking, phrased for the metric.
 */
export function generateTemperatureContext(
  currentTemp: number | null | undefined,
  data: WeatherDataPoint[],
  currentMetric: MetricKey
): TemperatureContext | null {
  // Note: currentTemp can legitimately be 0 (e.g. a bone-dry day, 0mm precip),
  // so guard on null/undefined/NaN rather than falsiness.
  if (currentTemp === null || currentTemp === undefined || !Number.isFinite(currentTemp)
      || !data || data.length === 0) return null;

  const percentile = calculateTemperaturePercentile(currentTemp, data, currentMetric);
  const percentileFromBottom = 100 - percentile;

  // Sort all values to get rankings (ascending, so index 0 is the lowest).
  const allTemps = data
    .map((d) => d[currentMetric])
    .filter((t): t is number => t !== null && t !== undefined)
    .sort((a, b) => a - b);
  const totalCount = allTemps.length;

  // Find exact ranking from each end of the sorted values.
  const rankingFromLow = allTemps.findIndex((temp) => temp >= currentTemp) + 1;
  const rankingFromHigh = totalCount - allTemps.lastIndexOf(currentTemp);

  const phrases = METRIC_PHRASES[currentMetric];

  // Get random phrase; append seasonal context to non-normal banks.
  const getRandomPhrase = (arr: string[]): string => {
    const phrase = arr[Math.floor(Math.random() * arr.length)];
    if (arr === phrases.extremeLow || arr === phrases.extremeHigh) {
      return phrase + ' (for the season)';
    } else if (arr !== phrases.normal) {
      return phrase + ' for the season';
    }
    return phrase;
  };

  const context: TemperatureContext = {
    percentile: '',
    description: '',
  };

  // A bone-dry day (0mm) can't get any drier — say so plainly.
  if (currentMetric === 'precipitation_sum' && currentTemp === 0) {
    context.percentile = `${percentileFromBottom.toFixed(0)}th percentile`;
    context.description = 'As dry as it gets!';
    return context;
  }

  if (percentileFromBottom <= 5) {
    // Bottom 5% - extreme low
    context.percentile = `${percentileFromBottom.toFixed(0)}th percentile`;
    context.description = getRandomPhrase(phrases.extremeLow);
    context.ranking = `${rankingFromLow}${getOrdinalSuffix(rankingFromLow)} ${phrases.rankLow} in dataset!`;
  } else if (percentile <= 5) {
    // Top 5% - extreme high
    context.percentile = `${percentile.toFixed(0)}th percentile`;
    context.description = getRandomPhrase(phrases.extremeHigh);
    context.ranking = `${rankingFromHigh}${getOrdinalSuffix(rankingFromHigh)} ${phrases.rankHigh} in dataset!`;
  } else if (percentileFromBottom <= 10) {
    // Bottom 10% - strong low
    context.percentile = `${percentileFromBottom.toFixed(0)}th percentile`;
    context.description = getRandomPhrase(phrases.strongLow);
  } else if (percentile <= 10) {
    // Top 10% - strong high
    context.percentile = `${percentile.toFixed(0)}th percentile`;
    context.description = getRandomPhrase(phrases.strongHigh);
  } else if (percentileFromBottom <= 20) {
    // 10-20th percentile - mild low
    context.percentile = `${percentileFromBottom.toFixed(0)}th percentile`;
    context.description = getRandomPhrase(phrases.mildLow);
  } else if (percentile <= 20) {
    // 80-90th percentile - mild high
    context.percentile = `${percentile.toFixed(0)}th percentile`;
    context.description = getRandomPhrase(phrases.mildHigh);
  } else {
    // 20-80th percentile - normal
    context.percentile = `${Math.min(percentile, percentileFromBottom).toFixed(0)}th percentile`;
    context.description = getRandomPhrase(phrases.normal);
  }

  return context;
}

/**
 * Get data extents (min/max for date and temperature)
 */
export function getDataExtents(
  data: WeatherDataPoint[],
  currentMetric: MetricKey
): DataExtents | null {
  if (data.length === 0) return null;

  const validTemps = data
    .map((d) => d[currentMetric])
    .filter((t): t is number => t !== null && t !== undefined);

  if (validTemps.length === 0) return null;

  const dateExtent = d3.extent(data, (d) => d.date) as [Date, Date];
  const tempExtent = d3.extent(validTemps) as [number, number];

  return {
    dateExtent,
    tempExtent,
  };
}

/**
 * Get available years from data
 */
export function getAvailableYears(data: WeatherDataPoint[]): number[] {
  return [...new Set(data.map((d) => d.year))].sort();
}

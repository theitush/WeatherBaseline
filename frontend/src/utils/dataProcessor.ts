// Data processing utilities
import * as d3 from 'd3';
import CONFIG from './config';
import type { MetricKey } from './config';
import type { WeatherDataPoint, YearlyAggregate, TemperatureContext, DataExtents } from '../types';

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
    const targetDate = new Date(
      year,
      new Date(currentDate).getMonth(),
      new Date(currentDate).getDate()
    );

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
    (d) => d.date.toDateString() === new Date(currentDate).toDateString()
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
 * Generate temperature context message with percentile ranking
 */
export function generateTemperatureContext(
  currentTemp: number | null | undefined,
  data: WeatherDataPoint[],
  currentMetric: MetricKey
): TemperatureContext | null {
  if (!currentTemp || !data || data.length === 0) return null;

  const percentile = calculateTemperaturePercentile(currentTemp, data, currentMetric);
  const percentileFromBottom = 100 - percentile;

  // Sort all temperatures to get rankings
  const allTemps = data
    .map((d) => d[currentMetric])
    .filter((t): t is number => t !== null && t !== undefined)
    .sort((a, b) => a - b);
  const totalCount = allTemps.length;

  // Find exact ranking
  const rankingFromColdest = allTemps.findIndex((temp) => temp >= currentTemp) + 1;
  const rankingFromHottest = totalCount - allTemps.lastIndexOf(currentTemp);

  // Random phrase arrays
  const normalPhrases = [
    'Pretty typical',
    'Normal range',
    'Average temp',
    'Nothing unusual',
    'Right on track',
    'Nothing special',
    'Just average',
    'Not exciting',
  ];
  const coolPhrases = [
    'A bit cool',
    'Slightly chilly',
    'Cooler side',
    'Touch below normal',
    'Mildly cold',
    'A bit brisk',
    'Slightly frosty',
    'A bit nippy',
    'Somewhat chilly',
    'A bit fresh',
    'A bit crisp',
    'Sorta cool',
  ];
  const warmPhrases = [
    'A bit warm',
    'Slightly toasty',
    'Warmer side',
    'Touch above normal',
    'Mildly hot',
    'A bit balmy',
    'Slightly sultry',
    'A bit steamy',
    'Somewhat warm',
    'Sorta hot',
  ];
  const coldPhrases = [
    'Unusually cold',
    'Quite chilly',
    'Pretty frigid',
    'Really cool',
    'Very cold',
    'Bitterly cold',
    'Chill af',
    'Nippy!',
  ];
  const hotPhrases = [
    'Unusually hot',
    'Quite toasty',
    'Pretty scorching',
    'Really warm',
    'Very hot',
    'Hot af',
    'Sweltering',
    'Scorching',
  ];
  const extremeColdPhrases = [
    'Exceptionally frigid!',
    'Bone-chilling!',
    'Historic freeze!',
    'Brutal cold!',
    'Arctic blast!',
  ];
  const extremeHotPhrases = [
    'Scorching rare heat!',
    'Blazing anomaly!',
    'Infernal heat!',
    'Blistering hot!',
    'Record heat!',
  ];

  // Get random phrase
  const getRandomPhrase = (arr: string[]): string => {
    const phrase = arr[Math.floor(Math.random() * arr.length)];
    // Add seasonal context to non-normal phrases
    if (arr === extremeColdPhrases || arr === extremeHotPhrases) {
      return phrase + ' (for the season)';
    } else if (arr !== normalPhrases) {
      return phrase + ' for the season';
    }
    return phrase;
  };

  const context: TemperatureContext = {
    percentile: '',
    description: '',
  };

  if (percentileFromBottom <= 5) {
    // Bottom 5% - very extreme cold
    context.percentile = `${percentileFromBottom.toFixed(0)}th percentile`;
    context.description = getRandomPhrase(extremeColdPhrases);
    context.ranking = `${rankingFromColdest}${getOrdinalSuffix(rankingFromColdest)} coldest in dataset!`;
  } else if (percentile <= 5) {
    // Top 5% - very extreme hot
    context.percentile = `${percentile.toFixed(0)}th percentile`;
    context.description = getRandomPhrase(extremeHotPhrases);
    context.ranking = `${rankingFromHottest}${getOrdinalSuffix(rankingFromHottest)} hottest in dataset!`;
  } else if (percentileFromBottom <= 10) {
    // Bottom 10% - extreme cold
    context.percentile = `${percentileFromBottom.toFixed(0)}th percentile`;
    context.description = getRandomPhrase(coldPhrases);
  } else if (percentile <= 10) {
    // Top 10% - extreme hot
    context.percentile = `${percentile.toFixed(0)}th percentile`;
    context.description = getRandomPhrase(hotPhrases);
  } else if (percentileFromBottom <= 20) {
    // 10-20th percentile - a bit cool
    context.percentile = `${percentileFromBottom.toFixed(0)}th percentile`;
    context.description = getRandomPhrase(coolPhrases);
  } else if (percentile <= 20) {
    // 80-90th percentile - a bit warm
    context.percentile = `${percentile.toFixed(0)}th percentile`;
    context.description = getRandomPhrase(warmPhrases);
  } else {
    // 20-80th percentile - normal
    context.percentile = `${Math.min(percentile, percentileFromBottom).toFixed(0)}th percentile`;
    context.description = getRandomPhrase(normalPhrases);
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

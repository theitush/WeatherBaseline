// Unit system: metric (the stored/canonical units) or imperial. All raw data is
// stored in metric (°C, m/s, mm; distances in km), so "imperial" is purely a
// display-time transform applied at every boundary where a number is shown.
//
// This module is the single source of truth for that transform: value
// conversion, delta conversion (for differences, where temperature has no +32
// offset), unit labels, axis labels, histogram bin widths, distance, and the
// auto-detected default. Charts convert values as they read them so d3 builds
// scales/bins/ticks in display space and produces clean round ticks for free.

import type { MetricKey } from './config';

export type UnitSystem = 'metric' | 'imperial';

const isTemp = (m: MetricKey) =>
  m === 'max_temperature' || m === 'min_temperature';

// ---- value conversion (absolute readings) ---------------------------------

/** Convert a stored metric value to the chosen system for display. */
export function convert(value: number, metric: MetricKey, system: UnitSystem): number {
  if (system === 'metric') return value;
  if (isTemp(metric)) return value * 9 / 5 + 32;        // °C → °F
  if (metric === 'wind_speed_10m_max') return value * 2.2369362921; // m/s → mph
  if (metric === 'precipitation_sum') return value / 25.4;          // mm → in
  return value;
}

/**
 * Convert a *difference* of two values (e.g. a median delta). Same as convert()
 * except temperature drops the +32 offset — a 1°C gap is 1.8°F, not 33.8°F.
 */
export function convertDelta(value: number, metric: MetricKey, system: UnitSystem): number {
  if (system === 'metric') return value;
  if (isTemp(metric)) return value * 9 / 5;             // Δ°C → Δ°F
  if (metric === 'wind_speed_10m_max') return value * 2.2369362921;
  if (metric === 'precipitation_sum') return value / 25.4;
  return value;
}

// ---- labels ---------------------------------------------------------------

/** Unit suffix for tooltips/stats, e.g. "°C"/"°F", "m/s"/"mph", "mm"/"in". */
export function unitLabel(metric: MetricKey, system: UnitSystem): string {
  if (isTemp(metric)) return system === 'imperial' ? '°F' : '°C';
  if (metric === 'wind_speed_10m_max') return system === 'imperial' ? 'mph' : 'm/s';
  if (metric === 'precipitation_sum') return system === 'imperial' ? 'in' : 'mm';
  return '';
}

/**
 * Bare unit for the record-scale card, which renders temperatures as "12.3°"
 * (degree sign, no C/F) and other metrics as "12.3 <unit>".
 */
export function unitLabelBare(metric: MetricKey, system: UnitSystem): string {
  if (isTemp(metric)) return '°';
  return unitLabel(metric, system);
}

/** Full axis label, e.g. "Daily Max Temp (°F)". */
export function axisLabel(metric: MetricKey, system: UnitSystem): string {
  const u = unitLabel(metric, system);
  switch (metric) {
    case 'max_temperature': return `Daily Max Temp (${u})`;
    case 'min_temperature': return `Daily Min Temp (${u})`;
    case 'precipitation_sum': return `Daily Precipitation (${u})`;
    case 'wind_speed_10m_max': return `Daily Max Wind Speed (${u})`;
  }
}

// ---- histogram bins -------------------------------------------------------

// Aim for at most this many bins across the data's span. The temperature width
// is chosen from a small "nice number" ladder: the finest width whose bin count
// stays ≤ MAX_BINS, so a wide-range place (e.g. Moscow) doesn't explode to ~50
// bars while a narrow-range one (e.g. tropical tmin) keeps the finest grid. The
// ladder floor (0.5 °C / 1 °F) caps how fine narrow ranges can get. Targeting
// the ~50 ceiling lands most places in the 30–50 band.
const MAX_BINS = 50;

/**
 * Bin width (in display units) for the histograms.
 *
 * Temperature is *adaptive*: given the data `span` (max−min in display units),
 * pick the finest "nice" width whose bin count stays ≤ MAX_BINS —
 *   metric:   0.5 / 1 / 2 / 5 °C
 *   imperial: 1 / 2 / 5 / 10 °F
 * Pass span = 0 (or omit) to get the finest width.
 *
 * Precipitation is also adaptive — the ladder ensures narrow ranges (a dry
 * climate with 0–5 mm) get fine 0.25/0.5 mm bins while wet climates stay tidy:
 *   metric:   0.25 / 0.5 / 1 / 2 / 5 / 10 mm
 *   imperial: 0.05 / 0.1 / 0.25 / 0.5 / 1 in
 *
 * Wind keeps a fixed width:
 *   0.5 m/s / 1 mph
 */
export function binWidth(metric: MetricKey, system: UnitSystem, span = 0): number {
  if (isTemp(metric)) {
    const ladder = system === 'imperial' ? [1, 2, 5, 10] : [0.5, 1, 2, 5];
    for (const w of ladder) {
      if (span <= 0 || span / w <= MAX_BINS) return w;
    }
    return ladder[ladder.length - 1];
  }
  if (metric === 'precipitation_sum') {
    const ladder = system === 'imperial'
      ? [0.01, 0.02, 0.05, 0.1, 0.25, 0.5, 1]
      : [0.1, 0.2, 0.5, 1, 5, 10];
    for (const w of ladder) {
      if (span <= 0 || span / w <= MAX_BINS) return w;
    }
    return ladder[ladder.length - 1];
  }
  if (metric === 'wind_speed_10m_max') return system === 'imperial' ? 1.0 : 0.5;
  return 0.5;
}

/**
 * Axis padding (in display units) to add above the max (and below the min for
 * signed metrics). For temperature the traditional ±2° looks right; for
 * precipitation/wind we use ~15 % of the data span so a narrow range (0–3 mm)
 * doesn't end up with a fixed 2-unit cliff on each side.
 *
 * The minimum pad is one bin-width so there's always breathing room above the
 * tallest bar, scaled to the unit system (0.25 mm / 0.05 in for precip).
 */
export function axisPad(metric: MetricKey, system: UnitSystem, dataSpan: number): number {
  if (isTemp(metric)) return 2;
  const minPad = binWidth(metric, system); // finest bin width = natural minimum step
  const pct = Math.ceil(dataSpan * 0.15 / minPad) * minPad;
  return Math.max(minPad, pct);
}

// ---- distance (location search) -------------------------------------------

const KM_PER_MILE = 1.609344;

/** Format a great-circle distance: "<1 km"/"<1 mi", else whole units. */
export function formatDistance(km: number, system: UnitSystem): string {
  if (system === 'imperial') {
    const mi = km / KM_PER_MILE;
    if (mi < 1) return '<1 mi';
    return `${Math.round(mi)} mi`;
  }
  if (km < 1) return '<1 km';
  return `${Math.round(km)} km`;
}

// ---- default detection ----------------------------------------------------

// The only places that conventionally use imperial measurement are the US (plus
// Liberia and Myanmar, which don't have distinct IANA zones worth listing). We
// detect by IANA timezone rather than navigator.language — language is often an
// install default (en-US everywhere) whereas the timezone reflects the machine's
// actual locale. Canada (America/Toronto…) and Latin America (America/Mexico_City,
// America/Sao_Paulo…) are deliberately absent → they default to metric.
const US_TIMEZONES = new Set([
  'America/New_York',
  'America/Detroit',
  'America/Kentucky/Louisville',
  'America/Kentucky/Monticello',
  'America/Indiana/Indianapolis',
  'America/Indiana/Vincennes',
  'America/Indiana/Winamac',
  'America/Indiana/Marengo',
  'America/Indiana/Petersburg',
  'America/Indiana/Vevay',
  'America/Indiana/Tell_City',
  'America/Indiana/Knox',
  'America/Chicago',
  'America/Menominee',
  'America/North_Dakota/Center',
  'America/North_Dakota/New_Salem',
  'America/North_Dakota/Beulah',
  'America/Denver',
  'America/Boise',
  'America/Phoenix',
  'America/Los_Angeles',
  'America/Anchorage',
  'America/Juneau',
  'America/Sitka',
  'America/Metlakatla',
  'America/Yakutat',
  'America/Nome',
  'America/Adak',
  'Pacific/Honolulu',
  'America/Puerto_Rico',
]);

/** Auto-detect the default system from the browser timezone (US → imperial). */
export function detectDefaultSystem(): UnitSystem {
  try {
    const tz = Intl.DateTimeFormat().resolvedOptions().timeZone;
    if (tz && US_TIMEZONES.has(tz)) return 'imperial';
  } catch {
    /* ignore */
  }
  return 'metric';
}

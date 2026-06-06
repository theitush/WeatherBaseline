// urlState — the shareable URL is the app's source of truth for location, date,
// and metric. A link fully reconstructs the view with NO geocoding on load:
//
//   /<lat>,<lon>/<date>/<metric>
//   /39.80,-89.64/2025-07-15/tmax
//
// The coords are canonical: they ARE a real cell centre, so the same link always
// shows the exact same data — no name in the URL means nothing can drift. The
// displayed place name is looked up locally from the cell list (see cellIndex)
// once the path is parsed. Date is YYYY-MM-DD; metric is a short key.
import type { MetricKey } from '../utils/config';

export interface UrlState {
  lat: number;
  lon: number;
  date: string; // YYYY-MM-DD
  metric: MetricKey;
}

// Short URL token <-> internal MetricKey. tmax/tmin (not min/max) per the data's
// daily-extreme naming; precip/wind are the obvious abbreviations.
const METRIC_TO_TOKEN: Record<MetricKey, string> = {
  max_temperature: 'tmax',
  min_temperature: 'tmin',
  precipitation_sum: 'precip',
  wind_speed_10m_max: 'wind',
};
const TOKEN_TO_METRIC: Record<string, MetricKey> = Object.fromEntries(
  Object.entries(METRIC_TO_TOKEN).map(([k, v]) => [v, k as MetricKey])
) as Record<string, MetricKey>;

const DATE_RE = /^\d{4}-\d{2}-\d{2}$/;

/** Round coords to the URL: 2dp comfortably resolves a 0.1° (~11 km) grid. */
function fmtCoord(n: number): string {
  return n.toFixed(2);
}

/**
 * Build the canonical path for a state. Coords are the only location identity;
 * the name is derived from them on load. Always leads with '/', no trailing slash.
 */
export function buildPath(state: {
  lat: number;
  lon: number;
  date: string;
  metric: MetricKey;
}): string {
  const loc = `${fmtCoord(state.lat)},${fmtCoord(state.lon)}`;
  return `/${loc}/${state.date}/${METRIC_TO_TOKEN[state.metric]}`;
}

/**
 * Parse the current path into a UrlState, or null if it isn't a valid shareable
 * path (bare root, garbage, partial). Tolerant of a missing/extra trailing slash.
 * The name is NOT in the URL — the caller resolves it from the cell list.
 */
export function parsePath(pathname: string): UrlState | null {
  const segments = pathname.split('/').filter(Boolean);
  if (segments.length < 3) return null;
  const [locSeg, dateSeg, metricSeg] = segments;

  const coords = locSeg.split(',');
  if (coords.length !== 2) return null;
  const lat = Number(coords[0]);
  const lon = Number(coords[1]);
  if (!Number.isFinite(lat) || !Number.isFinite(lon)) return null;
  if (lat < -90 || lat > 90 || lon < -180 || lon > 180) return null;

  if (!DATE_RE.test(dateSeg)) return null;

  const metric = TOKEN_TO_METRIC[metricSeg];
  if (!metric) return null;

  return { lat, lon, date: dateSeg, metric };
}

export { METRIC_TO_TOKEN, TOKEN_TO_METRIC };

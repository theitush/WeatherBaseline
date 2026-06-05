// urlState — the shareable URL is the app's source of truth for location, date,
// and metric. A link fully reconstructs the view with NO geocoding on load:
//
//   /<city-slug>@<lat>,<lon>/<date>/<metric>
//   /springfield-illinois-us@39.80,-89.64/2025-07-15/tmax
//
// The coords after '@' are canonical (they snap to a real cell, deterministically
// — see cellIndex). The slug before '@' is purely a human label so a recipient
// knows *which* Springfield they're looking at before anything loads. Date is
// YYYY-MM-DD; metric is a short key (tmax/tmin/precip/wind).
import type { MetricKey } from '../utils/config';

export interface UrlState {
  /** Display label reconstructed from the slug, e.g. "Springfield, Illinois, Us". */
  name: string;
  lat: number;
  lon: number;
  date: string; // YYYY-MM-DD
  metric: MetricKey;
  /** Snapped-cell distance (km) at share time, if the link carried ?d=. The URL
   *  coords are the cell, so this is the only way a link can recover how far the
   *  shared place was from its data point. */
  distanceKm?: number;
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

/**
 * Build the slug from a place's parts. We keep up to three components
 * (name, region, country) so the URL itself disambiguates same-named cities,
 * lowercased with non-alphanumerics collapsed to single dashes.
 */
export function buildSlug(parts: Array<string | undefined>): string {
  const slug = parts
    .filter((p): p is string => Boolean(p && p.trim()))
    .map(slugifyPart)
    .filter(Boolean)
    .join('-');
  return slug || 'location';
}

function slugifyPart(s: string): string {
  return s
    .toLowerCase()
    .normalize('NFD')
    .replace(/\p{Diacritic}/gu, '') // strip accents: München -> munchen
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-+|-+$/g, '');
}

/** Title-case a dashed slug back into a readable label: "san-francisco" -> "San Francisco". */
function deslugify(slug: string): string {
  return slug
    .split('-')
    .filter(Boolean)
    .map((w) => w.charAt(0).toUpperCase() + w.slice(1))
    .join(' ');
}

/** Round coords to the URL: 2dp comfortably resolves a 0.1° (~11 km) grid. */
function fmtCoord(n: number): string {
  return n.toFixed(2);
}

/**
 * Build the canonical path for a state. The slug carries the label; coords are
 * truth. Always leads with '/', no trailing slash.
 */
export function buildPath(state: {
  slug: string;
  lat: number;
  lon: number;
  date: string;
  metric: MetricKey;
  distanceKm?: number;
}): string {
  const loc = `${state.slug}@${fmtCoord(state.lat)},${fmtCoord(state.lon)}`;
  const path = `/${loc}/${state.date}/${METRIC_TO_TOKEN[state.metric]}`;
  // Carry the snap distance so a recipient's badge matches what the sharer saw;
  // the cell coords alone can't reconstruct it.
  return state.distanceKm != null ? `${path}?d=${Math.round(state.distanceKm)}` : path;
}

/**
 * Parse the current path into a UrlState, or null if it isn't a valid shareable
 * path (bare root, garbage, partial). Tolerant of a missing/extra trailing
 * slash. The name is reconstructed from the slug — the slug's first component is
 * the city, the rest are region/country shown as ", ..." detail.
 */
export function parsePath(pathname: string, search = ''): UrlState | null {
  const segments = pathname.split('/').filter(Boolean);
  if (segments.length < 3) return null;
  const [locSeg, dateSeg, metricSeg] = segments;

  const at = locSeg.lastIndexOf('@');
  if (at < 0) return null;
  const slug = locSeg.slice(0, at);
  const coords = locSeg.slice(at + 1).split(',');
  if (coords.length !== 2) return null;
  const lat = Number(coords[0]);
  const lon = Number(coords[1]);
  if (!Number.isFinite(lat) || !Number.isFinite(lon)) return null;
  if (lat < -90 || lat > 90 || lon < -180 || lon > 180) return null;

  if (!DATE_RE.test(dateSeg)) return null;

  const metric = TOKEN_TO_METRIC[metricSeg];
  if (!metric) return null;

  const dRaw = new URLSearchParams(search).get('d');
  const d = dRaw != null ? Number(dRaw) : NaN;
  const distanceKm = Number.isFinite(d) && d >= 0 ? d : undefined;

  return { name: deslugify(slug), lat, lon, date: dateSeg, metric, distanceKm };
}

export { METRIC_TO_TOKEN, TOKEN_TO_METRIC };

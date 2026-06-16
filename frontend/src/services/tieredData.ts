// tieredData — v2 client: snap to grid, ensure-fresh, fetch the three cell
// files, merge by date (last-wins). See ARCHITECTURE.md.
//
// archive (era5_land, immutable) ─┐
// recent  (era5_land, ~daily)     ─┼─► recent overrides forecast on overlap;
// forecast (model, ~12h)          ─┘   forecast only fills dates the others miss.
import type { WeatherDataPoint } from '../types';

// Base URL for the cell files — the R2/CDN origin. Set in BOTH dev and prod via
// VITE_DATA_BASE (committed in frontend/.env): local dev reads the tier files
// straight from R2, the same objects the local Worker writes. The empty-string
// fallback is only for a misconfigured env (no VITE_DATA_BASE) and routes to a
// relative /data path, which nothing serves anymore.
const DATA_BASE = import.meta.env.VITE_DATA_BASE ?? '';

// Base origin for the Worker's /api/* control-plane routes (ensure-fresh, geo).
// Empty in dev: the Vite proxy forwards /api → the local Worker
// (`wrangler dev --remote` on :8787). In prod set VITE_API_BASE to the deployed
// Worker's origin (e.g. its workers.dev URL) so these calls reach the Worker
// cross-origin. The Worker already sends permissive CORS for /api/*. Shared with
// api.ts via apiUrl().
export const API_BASE = import.meta.env.VITE_API_BASE ?? '';

/** Build a control-plane URL: prefixes the path with API_BASE in prod. */
export function apiUrl(path: string): string {
  return `${API_BASE}${path}`;
}

type Tier = 'archive' | 'recent' | 'forecast';

// Whether a loaded cell had any settled (archive/recent) ERA5-Land rows. A cell
// can be searchable yet have no built archive yet (we're still backfilling the
// grid) — in that case only the forecast tier exists, so the long-run history
// and statistics can't be shown. The UI reads this to show a "coming soon"
// message instead of a generic error. Keyed "lat,lon".
const cellHasArchive = new Map<string, boolean>();

const cellKey = (lat: number, lon: number) =>
  `${snap(lat).toFixed(1)},${snap(lon).toFixed(1)}`;

/**
 * Whether the loaded cell has settled archive history (vs. forecast-only).
 * null means the cell hasn't been loaded yet.
 */
export function getCellHasArchive(lat: number, lon: number): boolean | null {
  return cellHasArchive.get(cellKey(lat, lon)) ?? null;
}

/** Snap a coordinate to the 0.1° ERA5-Land grid: round(coord*10)/10. */
export function snap(coord: number): number {
  return Math.round(coord * 10) / 10;
}

function fileUrl(tier: Tier, lat: number, lon: number): string {
  const name = `${tier}_${snap(lat).toFixed(1)}_${snap(lon).toFixed(1)}.csv.gz`;
  // The object key `{tier}/{name}` IS the path under the R2 origin (dev and
  // prod alike), e.g. https://…r2.dev/archive/archive_..csv.gz — matching the
  // Worker's cellStore keys and the upload scripts. The /data fallback only
  // applies if DATA_BASE is empty (misconfigured env), and nothing serves it.
  const prefix = DATA_BASE ? '' : '/data';
  return `${DATA_BASE}${prefix}/${tier}/${name}`;
}

/**
 * Below this, a day's precipitation counts as 0 everywhere in the app. ERA5-Land
 * reports sub-millimetre trace amounts (drizzle, numerical residue) that read as
 * "rain" in stats but not in lived experience; the clamp happens here, at the
 * single ingestion point, so no downstream consumer ever sees a trace value.
 * The axis/bin floors in units.ts (1 mm / 0.05 in) assume this.
 */
const PRECIP_TRACE_MM = 1;

/** One parsed CSV row from a cell file (raw string cells). */
interface RawRow {
  date: string;
  tmax_C: string;
  tmin_C: string;
  precip_mm: string;
  wind_max_ms: string;
}

/**
 * Fetch and parse one tier's CSV. Returns [] for a 404 (a tier that doesn't
 * exist for this cell yet — e.g. archive not built, or forecast not refreshed).
 * The browser auto-gunzips via Content-Encoding: gzip.
 */
// Cache parsed ARCHIVE rows per snapped cell. The archive is the bulk of a
// cell's payload (~75 years) and is immutable within a session, so re-reading it
// when the user just changes the date or metric is pure waste; this also lets
// the radial chart pull the full unfiltered timeline without a second download.
// Only the archive is cached — `recent`/`forecast` are topped up daily and must
// stay fresh, so they always re-fetch.
const archiveCache = new Map<string, Promise<RawRow[]>>();

async function fetchTier(tier: Tier, lat: number, lon: number): Promise<RawRow[]> {
  const key = `${lat},${lon}`;
  if (tier === 'archive') {
    const cached = archiveCache.get(key);
    if (cached) return cached;
  }

  const p = (async () => {
    let res: Response;
    try {
      res = await fetch(fileUrl(tier, lat, lon), { headers: { Accept: 'text/csv' } });
    } catch {
      return []; // network error on an optional tier — degrade gracefully
    }
    if (!res.ok) return [];
    return parseCsv(await res.text());
  })();

  if (tier === 'archive') {
    archiveCache.set(key, p);
    // Don't let a transient empty result stick — drop it so a later load retries.
    p.then((rows) => { if (rows.length === 0) archiveCache.delete(key); });
  }
  return p;
}

function parseCsv(text: string): RawRow[] {
  const lines = text.trim().split('\n');
  if (lines.length <= 1) return [];
  const header = lines[0].split(',');
  return lines.slice(1).map((line) => {
    const cells = line.split(',');
    const row: Record<string, string> = {};
    header.forEach((col, i) => (row[col] = cells[i]));
    return row as unknown as RawRow;
  });
}

/**
 * Ask the backend to top up the volatile tiers before we read them.
 * Returns true if the call succeeded, false if it failed (network error or
 * non-2xx). A false result means recent/forecast data may be stale.
 */
async function ensureFresh(lat: number, lon: number, viewUrl?: string): Promise<boolean> {
  try {
    const params = new URLSearchParams({ lat: String(lat), lon: String(lon) });
    // Pass the app's real page URL (/lat,lon/date/metric) so the Worker logs the
    // exact link viewed — metric included — for analytics. ensure-fresh is a
    // functional call, so this arrival hit can't be stripped by adblockers.
    // Fall back to the current location when no explicit URL is given (e.g. the
    // compare page / year chart) so EVERY app call is attributable: a bare
    // ensure-fresh with no `u` therefore means "not from our UI" — a clean bot
    // signal the analytics relies on (see worker/src/analytics.js).
    const u =
      viewUrl ??
      (typeof location !== 'undefined' ? location.pathname + location.search : undefined);
    if (u) params.set('u', u);
    const res = await fetch(apiUrl(`/api/ensure-fresh?${params}`));
    return res.ok;
  } catch {
    // Network error — still read whatever files exist in R2.
    return false;
  }
}

/**
 * Fire-and-forget ping when the user switches metric in-app — the one signal the
 * Worker can't otherwise see (flipping the metric is pure client state, with no
 * other request). Sends the app's current page URL so the metric they switched
 * to is recorded. Best-effort: never awaited, never throws, keepalive so it
 * survives navigation. Logging never affects the UI.
 */
export function logMetricView(viewUrl: string): void {
  try {
    void fetch(apiUrl(`/api/view?u=${encodeURIComponent(viewUrl)}`), {
      keepalive: true,
    }).catch(() => {});
  } catch {
    /* swallow — analytics must never break the page */
  }
}

const numOrNull = (s: string | undefined): number | null =>
  s === undefined || s === '' ? null : Number(s);

export interface CellTimeline {
  data: WeatherDataPoint[];
  /** False when the ensure-fresh call to the Worker failed — recent/forecast data may be stale. */
  forecastFresh: boolean;
}

/**
 * Load the full merged daily timeline for a snapped cell.
 *
 * Merge precedence per date (last-wins): forecast < archive < recent, so recent
 * supersedes the forecast guess on overlap and archive/recent (the real
 * ERA5-Land data) always beat the model. data_type marks forecast rows so the
 * chart can style them; once a day ages past the publish frontier the next
 * recent refresh replaces its forecast row with the settled value.
 */
export async function loadCellTimeline(
  rawLat: number,
  rawLon: number,
  viewUrl?: string
): Promise<CellTimeline> {
  const lat = snap(rawLat);
  const lon = snap(rawLon);

  const forecastFresh = await ensureFresh(lat, lon, viewUrl);

  const [archive, recent, forecast] = await Promise.all([
    fetchTier('archive', lat, lon),
    fetchTier('recent', lat, lon),
    fetchTier('forecast', lat, lon),
  ]);

  // Merge by date, last-wins. Apply lowest precedence first.
  const byDate = new Map<string, WeatherDataPoint>();
  const apply = (rows: RawRow[], type: WeatherDataPoint['data_type']) => {
    for (const r of rows) {
      if (!r.date) continue;
      const d = new Date(r.date + 'T00:00:00');
      const precip = numOrNull(r.precip_mm);
      byDate.set(r.date, {
        date: d,
        year: d.getFullYear(),
        data_type: type,
        max_temperature: numOrNull(r.tmax_C) ?? undefined,
        min_temperature: numOrNull(r.tmin_C) ?? undefined,
        // Trace precipitation (< 1 mm) is a dry day for our purposes: clamp it
        // to 0 at ingestion so every calculation and display downstream
        // (percentiles, histograms, dials, prose verdict) agrees.
        precipitation_sum:
          precip === null ? undefined : precip < PRECIP_TRACE_MM ? 0 : precip,
        wind_speed_10m_max: numOrNull(r.wind_max_ms) ?? undefined,
      });
    }
  };

  apply(forecast, 'forecast'); // lowest precedence
  apply(archive, 'historical');
  apply(recent, 'recent'); // highest precedence — real, but not settled archive

  // Record whether this cell has the settled long-run history the charts/stats
  // need. Only the archive counts: the `recent` tier is topped up daily from the
  // live model for EVERY servable cell (even ones we haven't backfilled), so a
  // few recent rows don't mean the cell is built. Requiring archive specifically
  // means an unbuilt cell shows "coming soon" instead of charting a stub of
  // recent/forecast points.
  cellHasArchive.set(cellKey(lat, lon), archive.length > 0);

  return {
    data: [...byDate.values()].sort((a, b) => a.date.getTime() - b.date.getTime()),
    forecastFresh,
  };
}

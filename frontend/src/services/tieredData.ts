// tieredData — v2 client: snap to grid, ensure-fresh, fetch the three cell
// files, merge by date (last-wins). See ARCHITECTURE.md.
//
// archive (era5_land, immutable) ─┐
// recent  (era5_land, ~daily)     ─┼─► recent overrides forecast on overlap;
// forecast (model, ~12h)          ─┘   forecast only fills dates the others miss.
import type { WeatherDataPoint } from '../types';

// Base URL for the cell files. Empty in dev (proxied to the Node backend);
// set VITE_DATA_BASE to the R2/CDN origin in prod.
const DATA_BASE = import.meta.env.VITE_DATA_BASE ?? '';

// Base origin for the Worker's /api/* control-plane routes (ensure-fresh, geo).
// Empty in dev (the Vite proxy forwards /api → the Node backend); in prod set
// VITE_API_BASE to the deployed Worker's origin (e.g. its workers.dev URL) so
// these calls reach the Worker cross-origin. The Worker already sends
// permissive CORS for /api/*. Shared with api.ts via apiUrl().
export const API_BASE = import.meta.env.VITE_API_BASE ?? '';

/** Build a control-plane URL: prefixes the path with API_BASE in prod. */
export function apiUrl(path: string): string {
  return `${API_BASE}${path}`;
}

type Tier = 'archive' | 'recent' | 'forecast';

// Last available date (YYYY-MM-DD) per snapped cell, set when its timeline
// loads. The date picker reads this to cap its max selectable day to what the
// data actually contains — the forecast horizon varies by cell timezone (a
// cell west of UTC can be a calendar day "behind"), so a fixed today+N would
// offer days that aren't in the data. Keyed "lat,lon".
const cellMaxDate = new Map<string, string>();

// Whether a loaded cell had any settled (archive/recent) ERA5-Land rows. A cell
// can be searchable yet have no built archive yet (we're still backfilling the
// grid) — in that case only the forecast tier exists, so the long-run history
// and statistics can't be shown. The UI reads this to show a "coming soon"
// message instead of a generic error. Keyed "lat,lon".
const cellHasArchive = new Map<string, boolean>();

const cellKey = (lat: number, lon: number) =>
  `${snap(lat).toFixed(1)},${snap(lon).toFixed(1)}`;

/** Last available date for a loaded cell, or null if it hasn't loaded yet. */
export function getCellMaxDate(lat: number, lon: number): string | null {
  return cellMaxDate.get(cellKey(lat, lon)) ?? null;
}

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
  // Two serving shapes share the SAME object key `{tier}/{name}`:
  //   - dev (DATA_BASE=''): the Node backend's Express static route is mounted
  //     at /data, so prefix it → /data/archive/archive_..csv.gz.
  //   - prod (DATA_BASE=R2 origin): files sit at the bucket root under their
  //     tier, so the key IS the path → https://…r2.dev/archive/archive_..csv.gz.
  // Keeping the R2 keys un-prefixed matches the Worker's cellStore + the upload
  // scripts; only the dev proxy needs the /data mount point.
  const prefix = DATA_BASE ? '' : '/data';
  return `${DATA_BASE}${prefix}/${tier}/${name}`;
}

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

/** Ask the backend to top up the volatile tiers before we read them. */
async function ensureFresh(lat: number, lon: number): Promise<void> {
  try {
    const params = new URLSearchParams({ lat: String(lat), lon: String(lon) });
    await fetch(apiUrl(`/api/ensure-fresh?${params}`));
  } catch {
    // If the refresh gate fails we still try to read whatever files exist —
    // stale-but-present beats failing the whole load.
  }
}

const numOrNull = (s: string | undefined): number | null =>
  s === undefined || s === '' ? null : Number(s);

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
  rawLon: number
): Promise<WeatherDataPoint[]> {
  const lat = snap(rawLat);
  const lon = snap(rawLon);

  await ensureFresh(lat, lon);

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
      byDate.set(r.date, {
        date: d,
        year: d.getFullYear(),
        data_type: type,
        max_temperature: numOrNull(r.tmax_C) ?? undefined,
        min_temperature: numOrNull(r.tmin_C) ?? undefined,
        precipitation_sum: numOrNull(r.precip_mm) ?? undefined,
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

  // Record the last available date for this cell (max of the raw YYYY-MM-DD
  // keys — lexical max works since they're zero-padded ISO dates). The picker
  // caps its horizon to this so it never offers a day the data lacks.
  if (byDate.size > 0) {
    const maxIso = [...byDate.keys()].reduce((a, b) => (a > b ? a : b));
    cellMaxDate.set(cellKey(lat, lon), maxIso);
  }

  return [...byDate.values()].sort((a, b) => a.date.getTime() - b.date.getTime());
}

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

type Tier = 'archive' | 'recent' | 'forecast';

// Last available date (YYYY-MM-DD) per snapped cell, set when its timeline
// loads. The date picker reads this to cap its max selectable day to what the
// data actually contains — the forecast horizon varies by cell timezone (a
// cell west of UTC can be a calendar day "behind"), so a fixed today+N would
// offer days that aren't in the data. Keyed "lat,lon".
const cellMaxDate = new Map<string, string>();

const cellKey = (lat: number, lon: number) =>
  `${snap(lat).toFixed(1)},${snap(lon).toFixed(1)}`;

/** Last available date for a loaded cell, or null if it hasn't loaded yet. */
export function getCellMaxDate(lat: number, lon: number): string | null {
  return cellMaxDate.get(cellKey(lat, lon)) ?? null;
}

/** Snap a coordinate to the 0.1° ERA5-Land grid: round(coord*10)/10. */
export function snap(coord: number): number {
  return Math.round(coord * 10) / 10;
}

function fileUrl(tier: Tier, lat: number, lon: number): string {
  const name = `${tier}_${snap(lat).toFixed(1)}_${snap(lon).toFixed(1)}.csv.gz`;
  return `${DATA_BASE}/data/${tier}/${name}`;
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
async function fetchTier(tier: Tier, lat: number, lon: number): Promise<RawRow[]> {
  let res: Response;
  try {
    res = await fetch(fileUrl(tier, lat, lon), { headers: { Accept: 'text/csv' } });
  } catch {
    return []; // network error on an optional tier — degrade gracefully
  }
  if (!res.ok) return [];
  return parseCsv(await res.text());
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
    await fetch(`/api/ensure-fresh?${params}`);
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
  apply(recent, 'historical'); // highest precedence

  // Record the last available date for this cell (max of the raw YYYY-MM-DD
  // keys — lexical max works since they're zero-padded ISO dates). The picker
  // caps its horizon to this so it never offers a day the data lacks.
  if (byDate.size > 0) {
    const maxIso = [...byDate.keys()].reduce((a, b) => (a > b ? a : b));
    cellMaxDate.set(cellKey(lat, lon), maxIso);
  }

  return [...byDate.values()].sort((a, b) => a.date.getTime() - b.date.getTime());
}

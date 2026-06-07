// ensureFresh (Worker port) — the thin tail-only refresh from ARCHITECTURE.md.
//
// Logic is the same as backend/ensureFresh.js (see that file's header for the
// full grid/source rationale). Worker-runtime differences only:
//   - global fetch (no node-fetch import);
//   - the R2 bucket + TTLs are passed in (env.BUCKET, env.*_TTL_MS) instead of
//     module-level fs + process.env;
//   - cellStore calls take the bucket as their first arg.
//
// Recap of the source split (unchanged, intentional per the 2026-06-03 grid
// decision): recent temp comes from models=era5_land (exact 0.1° archive grid),
// recent precip/wind from the historical-forecast API (IFS family — era5_land
// returns null for p/w), forecast from ecmwf_ifs. cell_selection=nearest pins
// each model to its nearest cell to the same canonical 0.1° point.
import * as store from './cellStore.js';

// past_days wider than the ~6-day ERA5-Land lag so forecast overlaps recent.
const FORECAST_PAST_DAYS = 9;
// =6 guarantees today+4 is present in every timezone (Open-Meteo anchors
// forecast_days to UTC "today", so it lands as UTC-today+5 = local-today+4 even
// west of UTC); the trailing-null filter trims unpublished days. The picker caps
// at local today+4 (DateSelector MAX_AHEAD_DAYS). Forecast is re-fetched whole
// every refresh (values change), not just its tail.
const FORECAST_DAYS = 6;
// recent fills the archive→frontier seam, but fetches only the dates it's
// MISSING, anchored to the earliest gap within [archive_end+1 .. today] (see
// firstMissingRecentDate). This heals an internal hole AND extends the tail
// without re-pulling settled data every run. The old fixed 14-day trailing
// window left a permanent hole right after the archive and froze cells
// mid-window.

const FORECAST_MODEL = 'ecmwf_ifs'; // IFS HRES 9km, O1280 (not ifs025/aifs).
const CELL_SELECTION = 'nearest';

const TEMP_FIELDS = 'temperature_2m_max,temperature_2m_min';
const PRECIP_WIND_FIELDS = 'precipitation_sum,wind_speed_10m_max';
const DAILY_FIELDS = `${TEMP_FIELDS},${PRECIP_WIND_FIELDS}`;

function fmtDate(d) {
  return d.toISOString().split('T')[0];
}

function numOrEmpty(v) {
  return v === null || v === undefined ? '' : v;
}

/** Convert an Open-Meteo daily block to our SCHEMA rows (one per date). */
function dailyToRows(daily) {
  const rows = [];
  const t = daily?.time || [];
  for (let i = 0; i < t.length; i++) {
    rows.push({
      date: t[i],
      tmax_C: numOrEmpty(daily.temperature_2m_max?.[i]),
      tmin_C: numOrEmpty(daily.temperature_2m_min?.[i]),
      precip_mm: numOrEmpty(daily.precipitation_sum?.[i]),
      wind_max_ms: numOrEmpty(daily.wind_speed_10m_max?.[i]),
    });
  }
  return rows;
}

async function callOpenMeteo(base, params) {
  // cell_selection pinned on every call so grid-cell choice is deterministic.
  const url = `${base}?${new URLSearchParams({ cell_selection: CELL_SELECTION, ...params })}`;
  const res = await fetch(url, {
    headers: { Accept: 'application/json', 'User-Agent': 'HowHotWasIt/2.0' },
  });
  if (!res.ok) {
    throw new Error(`Open-Meteo ${base} returned ${res.status} ${res.statusText}`);
  }
  return res.json();
}

/** Index a daily block by date for joining the two recent calls. */
function indexByDate(daily) {
  const map = new Map();
  const t = daily?.time || [];
  for (let i = 0; i < t.length; i++) map.set(t[i], i);
  return { daily, map };
}

/**
 * Earliest date in [archiveEnd+1 .. today] the recent tier is missing, as
 * YYYY-MM-DD, or null if recent already covers the whole span. Lets the refresh
 * fetch only the gap (heals an internal hole AND extends the tail) instead of
 * the whole seam. era5-land's publish frontier sits a few days behind today, so
 * the trailing unpublished days read as "missing" too — harmless: the API
 * returns nulls and the settled-filter drops them, so the request just ends a
 * little short of today. All math in UTC for stable date strings.
 */
async function firstMissingRecentDate(bucket, lat, lon, archiveEnd) {
  const have = new Set((await store.readRows(bucket, 'recent', lat, lon)).map((r) => r.date));
  const day = new Date(`${archiveEnd}T00:00:00Z`);
  day.setUTCDate(day.getUTCDate() + 1); // archive_end + 1
  const today = fmtDate(new Date());
  while (fmtDate(day) <= today) {
    const iso = fmtDate(day);
    if (!have.has(iso)) return iso;
    day.setUTCDate(day.getUTCDate() + 1);
  }
  return null;
}

/**
 * Refresh the forecast tier for a cell if its object is older than the TTL.
 * IFS HRES over the −9 to +4 day window in one call. Returns whether it ran.
 */
async function refreshForecast(bucket, lat, lon, ttlMs) {
  if ((await store.ageMs(bucket, 'forecast', lat, lon)) < ttlMs) return false;

  const data = await callOpenMeteo('https://api.open-meteo.com/v1/forecast', {
    latitude: lat,
    longitude: lon,
    daily: DAILY_FIELDS,
    wind_speed_unit: 'ms',
    models: FORECAST_MODEL,
    past_days: FORECAST_PAST_DAYS,
    forecast_days: FORECAST_DAYS,
    timezone: 'auto',
  });
  // forecast is rewritten wholesale (most volatile tier).
  await store.writeRows(bucket, 'forecast', lat, lon, dailyToRows(data.daily));
  return true;
}

/**
 * Refresh the recent tier for a cell if its object is older than the TTL.
 *
 * Recent is SETTLED era5-land history, so we fetch only the dates we're missing
 * — never the whole seam. The complete set is archive_end+1 .. today; subtract
 * what recent already has and request from the EARLIEST missing date through
 * today. Anchoring to the earliest gap (not recent's last date) HEALS an
 * internal hole as well as extending the tail; if nothing's missing we make no
 * API call.
 *
 * Two calls over that span (temp via era5_land, precip/wind via historical-
 * forecast), joined by date, appended last-wins. Returns whether it ran.
 */
async function refreshRecent(bucket, lat, lon, ttlMs) {
  if ((await store.ageMs(bucket, 'recent', lat, lon)) < ttlMs) return false;

  // No archive ⇒ forecast-only cell, no seam to fill: skip (the forecast tier
  // already carries its own past_days for display).
  const archiveEnd = await store.lastDate(bucket, 'archive', lat, lon);
  if (!archiveEnd) return false;

  // Earliest date recent is missing within [archive_end+1 .. today]. null ⇒
  // recent is already complete up to today, so there's nothing to fetch.
  const startIso = await firstMissingRecentDate(bucket, lat, lon, archiveEnd);
  if (!startIso) return false;
  const dateRange = { start_date: startIso, end_date: fmtDate(new Date()) };

  const [tempData, pwData] = await Promise.all([
    // temperature — ERA5-Land, exact archive grid match.
    callOpenMeteo('https://archive-api.open-meteo.com/v1/archive', {
      latitude: lat,
      longitude: lon,
      ...dateRange,
      daily: TEMP_FIELDS,
      models: 'era5_land',
      timezone: 'auto',
    }),
    // precip/wind — IFS HRES family at the same canonical point.
    callOpenMeteo('https://historical-forecast-api.open-meteo.com/v1/forecast', {
      latitude: lat,
      longitude: lon,
      ...dateRange,
      daily: PRECIP_WIND_FIELDS,
      wind_speed_unit: 'ms',
      timezone: 'auto',
    }),
  ]);

  // Join the two daily blocks by date; temp drives the row set (grid-matched).
  const pw = indexByDate(pwData.daily);
  const rows = dailyToRows(tempData.daily).map((row) => {
    const j = pw.map.get(row.date);
    if (j !== undefined) {
      row.precip_mm = numOrEmpty(pwData.daily.precipitation_sum?.[j]);
      row.wind_max_ms = numOrEmpty(pwData.daily.wind_speed_10m_max?.[j]);
    }
    return row;
  });
  // Drop trailing rows the temp source returns as all-null (not yet published).
  const settled = rows.filter((r) => r.tmax_C !== '' || r.tmin_C !== '');
  await store.mergeRows(bucket, 'recent', lat, lon, settled);
  return true;
}

/**
 * Top up the volatile tiers for a snapped cell and report what's ready.
 * Refreshes run in parallel — different objects, different APIs.
 */
async function ensureFresh(bucket, lat, lon, ttls) {
  const slat = store.snap(lat);
  const slon = store.snap(lon);
  const [forecastRefreshed, recentRefreshed] = await Promise.all([
    refreshForecast(bucket, slat, slon, ttls.forecast),
    refreshRecent(bucket, slat, slon, ttls.recent),
  ]);
  return { ready: true, lat: slat, lon: slon, forecastRefreshed, recentRefreshed };
}

export { ensureFresh, refreshForecast, refreshRecent };

// ensureFresh — the thin tail-only refresh from ARCHITECTURE.md (Option A).
//
// Given a snapped cell, top up only the two volatile tiers from Open-Meteo:
//
//   forecast: if forecast_*.csv.gz is older than 12h → ONE Forecast API call,
//             models=ecmwf_ifs (IFS HRES 9km), past_days=9&forecast_days=6,
//             rewrite the file wholesale (forecast values change, so the whole
//             window is re-fetched every refresh — not just the tail).
//   recent:   if recent_*.csv.gz is older than 24h → TWO Historical API calls
//             (see below), merged by date, append-by-date (last-wins).
//
// Why recent needs two calls: Open-Meteo's models=era5_land serves ONLY
// temperature — precipitation_sum and wind_speed_10m_max come back null (CDS's
// daily-stats product also refuses accumulated precip). So:
//   - temp  → models=era5_land (exact 0.1° grid match to the archive: the
//             archive↔recent seam is invisible, and temp is all the UI shows).
//   - p/w   → historical-forecast API (IFS HRES family, ~0.0625° grid — finer
//             than ERA5-Land's 0.1°, far better than ERA5 0.25°). Same single-
//             source, same 24h TTL as recent temp — just a different model
//             because era5_land returns null for p/w. This is the SHIPPING
//             design (grid decision resolved 2026-06-03), not provisional.
//             It carries a model bias at the archive↔recent seam vs ERA5-Land;
//             quantifying/correcting that is a DEFERRED task (see ARCHITECTURE.md
//             "✅ GRID DECISION"), not a blocker.
//
// Grid alignment: the three sources sit on three physically different grids
// (era5_land 0.1°, historical-forecast 0.0625°, IFS HRES O1280) — no API param
// makes them identical. We snap our request to our canonical 0.1° grid first
// (store.snap) and pin cell_selection=nearest on every call so each model
// deterministically returns its nearest cell to the SAME canonical point — the
// smallest, stable offset. The residual difference IS the model bias.
//
// The archive tier is never read or written here — it's immutable and served
// straight from the CDN. The Open-Meteo call budget is the binding constraint;
// each tier short-circuits when still fresh. Budget: forecast 2/day +
// recent 2 calls × 1/day = 4 calls/cell/day for cells that are actually viewed.
const fetch = require('node-fetch');
const store = require('./cellStore');

// Freshness thresholds (kept here, server-side, so a later move to Option B is
// a frontend-only change). Override via env for testing.
const FORECAST_TTL_MS = Number(process.env.FORECAST_TTL_MS ?? 12 * 60 * 60 * 1000);
const RECENT_TTL_MS = Number(process.env.RECENT_TTL_MS ?? 24 * 60 * 60 * 1000);

// past_days is deliberately wider than the measured ~6-day ERA5-Land publish lag
// so forecast overlaps recent by ~3 days — no gap at the seam if the lag slips.
const FORECAST_PAST_DAYS = 9;
// The frontend picker allows today + 4 (DateSelector MAX_AHEAD_DAYS). Open-Meteo
// anchors forecast_days to *UTC* "today", so the local trailing day shifts by
// timezone: a given count reaches one more day east of UTC than west. =6
// guarantees today+4 is present in every timezone (it lands as UTC-today+5,
// which is local-today+4 even in the westmost zones); the trailing-null filter
// trims any genuinely-unpublished day. Kept tight on purpose: ecmwf_ifs would
// serve 16 days, but API call-weight scales with the day count and days past
// +4 aren't selectable anyway.
const FORECAST_DAYS = 6;

// recent fills the archive→frontier seam, but fetches only the dates it's
// MISSING, anchored to the earliest gap within [archive_end+1 .. today] (see
// firstMissingRecentDate). This heals an internal hole AND extends the tail
// without re-pulling settled data every run. The old fixed 14-day trailing
// window left a permanent hole right after the archive (archive_end+1 ..
// today-14 was never requested) and froze older cells mid-window.

// IFS HRES (9km, O1280 grid) — the high-resolution deterministic forecast model.
// NOT ecmwf_ifs025 (0.25°) or ecmwf_aifs (AI, 0.25°). Matches ERA5-Land's ~0.1°.
const FORECAST_MODEL = 'ecmwf_ifs';

// Deterministic cell pick on every call (no elevation-DEM heuristic that could
// drift to a different cell as the DEM/model updates). See header.
const CELL_SELECTION = 'nearest';

// Temp comes from era5_land (grid-matched); precip/wind from a finer IFS-family
// model that actually serves them. Split so each goes to the right source.
const TEMP_FIELDS = 'temperature_2m_max,temperature_2m_min';
const PRECIP_WIND_FIELDS = 'precipitation_sum,wind_speed_10m_max';
const DAILY_FIELDS = `${TEMP_FIELDS},${PRECIP_WIND_FIELDS}`;

function fmtDate(d) {
  return d.toISOString().split('T')[0];
}

/**
 * Convert an Open-Meteo daily block to our SCHEMA rows (one per date).
 * wind_speed_10m_max is requested in m/s (see callOpenMeteo). Missing values
 * pass through as empty strings so the CSV stays aligned.
 */
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

function numOrEmpty(v) {
  return v === null || v === undefined ? '' : v;
}

async function callOpenMeteo(base, params) {
  // cell_selection pinned on every call so grid-cell choice is deterministic.
  const url = `${base}?${new URLSearchParams({ cell_selection: CELL_SELECTION, ...params })}`;
  const res = await fetch(url, {
    headers: { Accept: 'application/json', 'User-Agent': 'HowHotWasIt/2.0' },
    timeout: 60000,
  });
  if (!res.ok) {
    throw new Error(`Open-Meteo ${base} returned ${res.status} ${res.statusText}`);
  }
  return res.json();
}

/**
 * Earliest date in [archiveEnd+1 .. today] that the recent tier is missing, as
 * YYYY-MM-DD, or null if recent already covers the whole span. Used to fetch
 * only the gap (heals an internal hole AND extends the tail) instead of the
 * whole seam. era5-land's publish frontier sits a few days behind today, so the
 * trailing unpublished days are "missing" here too — harmless: the API returns
 * nulls for them and the settled-filter drops them, so the request just ends a
 * little short of today in practice. All math in UTC for stable date strings.
 */
async function firstMissingRecentDate(lat, lon, archiveEnd) {
  const have = new Set((await store.readRows('recent', lat, lon)).map((r) => r.date));
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

/** Index a daily block by date for joining the two recent calls. */
function indexByDate(daily) {
  const map = new Map();
  const t = daily?.time || [];
  for (let i = 0; i < t.length; i++) map.set(t[i], i);
  return { daily, map };
}

/**
 * Refresh the forecast tier for a cell if its file is older than the TTL.
 * IFS HRES (ecmwf_ifs) over the −9 to +3 day window in one call. Returns true
 * if a refresh happened, false if it was still fresh.
 */
async function refreshForecast(lat, lon) {
  if ((await store.ageMs('forecast', lat, lon)) < FORECAST_TTL_MS) return false;

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
  await store.writeRows('forecast', lat, lon, dailyToRows(data.daily));
  return true;
}

/**
 * Refresh the recent tier for a cell if its file is older than the TTL.
 *
 * Recent is SETTLED era5-land history (it doesn't change once published), so we
 * fetch only the dates we're actually missing — never the whole seam. The
 * complete set recent should hold is archive_end+1 .. today; subtract the dates
 * recent already has, and request from the EARLIEST missing date through today.
 * Anchoring to the earliest gap (not recent's last date) is what HEALS an
 * internal hole — e.g. archive ends May 1 but recent starts May 19, leaving
 * May 2..18 missing: we re-request from May 2, not May 20. If nothing's missing
 * we make no API call at all.
 *
 * Two calls over that span, merged by date:
 *   - temp via models=era5_land (exact 0.1° archive grid — invisible seam),
 *   - precip/wind via the historical-forecast API (IFS HRES family, finer grid;
 *     era5_land doesn't serve these).
 * Appends by date (last-wins), so overlapping re-runs are idempotent.
 */
async function refreshRecent(lat, lon) {
  if ((await store.ageMs('recent', lat, lon)) < RECENT_TTL_MS) return false;

  // No archive ⇒ forecast-only cell, no seam to fill: skip (the forecast tier
  // already carries its own past_days for display).
  const archiveEnd = await store.lastDate('archive', lat, lon);
  if (!archiveEnd) return false;

  // Earliest date recent is missing within [archive_end+1 .. today]. null ⇒
  // recent is already complete up to today, so there's nothing to fetch.
  const startIso = await firstMissingRecentDate(lat, lon, archiveEnd);
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

  // Join the two daily blocks by date into our 4-column schema. Temp drives the
  // row set (it's the grid-matched source); precip/wind fill in where present.
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
  await store.mergeRows('recent', lat, lon, settled);
  return true;
}

/**
 * Top up the volatile tiers for a snapped cell and report what's ready.
 * Refreshes run in parallel — they touch different files and different APIs.
 */
async function ensureFresh(lat, lon) {
  const slat = store.snap(lat);
  const slon = store.snap(lon);
  const [forecastRefreshed, recentRefreshed] = await Promise.all([
    refreshForecast(slat, slon),
    refreshRecent(slat, slon),
  ]);
  return {
    ready: true,
    lat: slat,
    lon: slon,
    forecastRefreshed,
    recentRefreshed,
  };
}

module.exports = { ensureFresh, refreshForecast, refreshRecent };

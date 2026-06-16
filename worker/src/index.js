// HowHotWasIt v2 — Cloudflare Worker entrypoint (control plane).
//
// Three routes:
//   GET /api/ensure-fresh?lat=&lon=  → top up recent/forecast in R2 from Open-Meteo
//   GET /api/geo                     → starting location for a bare visit
//   GET /api/health                  → liveness
//
// Everything else (the .csv.gz tier files, the static frontend) is served by
// R2's public URL and Cloudflare Pages respectively — NOT by this Worker — so
// file reads never touch the Worker request budget. This Worker only does the
// live tail work.
import { ensureFresh } from './ensureFresh.js';
import { handleAnalyticsData, handleDashboard } from './analytics.js';

// CORS: the frontend is served from a different origin (Pages / R2) than this
// Worker, so allow cross-origin XHR. Reads of the data files are plain public
// GETs and don't need this; it's only for the /api/* fetches.
const CORS = {
  'Access-Control-Allow-Origin': '*',
  'Access-Control-Allow-Methods': 'GET, OPTIONS',
  'Access-Control-Allow-Headers': 'Content-Type',
};

const json = (obj, status = 200) =>
  new Response(JSON.stringify(obj), {
    status,
    headers: { 'Content-Type': 'application/json', ...CORS },
  });

export default {
  async fetch(request, env, ctx) {
    const url = new URL(request.url);

    if (request.method === 'OPTIONS') {
      return new Response(null, { status: 204, headers: CORS });
    }

    if (url.pathname === '/api/health') {
      return json({ status: 'ok', timestamp: new Date().toISOString() });
    }

    if (url.pathname === '/api/ensure-fresh') {
      return handleEnsureFresh(request, url, env, ctx);
    }

    if (url.pathname === '/api/geo') {
      return handleGeo(request, env, ctx);
    }

    // Metric-toggle ping: log-only, returns 204 fast. The app sends its real URL
    // in `u`, so the metric falls out of the path. This is the in-app
    // exploration signal the user opted into capturing.
    if (url.pathname === '/api/view') {
      ctx.waitUntil(logHit(request, env, { kind: 'toggle', page: url.searchParams.get('u') }));
      return new Response(null, { status: 204, headers: CORS });
    }

    // Private analytics dashboard. The page is a static shell (reveals nothing);
    // the data route is password-gated by env.DASHBOARD_TOKEN. See analytics.js.
    if (url.pathname === '/dashboard') {
      return handleDashboard(request, env);
    }
    if (url.pathname === '/api/analytics') {
      return handleAnalyticsData(request, url, env);
    }

    return json({ error: 'not found' }, 404);
  },
};

async function handleEnsureFresh(request, url, env, ctx) {
  const lat = parseFloat(url.searchParams.get('lat') ?? url.searchParams.get('latitude'));
  const lon = parseFloat(url.searchParams.get('lon') ?? url.searchParams.get('longitude'));
  if (!Number.isFinite(lat) || !Number.isFinite(lon)) {
    return json({ error: 'lat and lon query params are required' }, 400);
  }
  // Unique-visitor logging. ensure-fresh fires once per city-view and is a
  // functional call (the app needs it), so adblockers can't strip it. The app
  // passes its real URL in `u` (/lat,lon/date/metric), so we store the actual
  // shareable link — metric included — instead of rebuilding a partial one.
  // Falls back to the coords if an older client omits `u`.
  const latS = url.searchParams.get('lat') ?? url.searchParams.get('latitude');
  const lonS = url.searchParams.get('lon') ?? url.searchParams.get('longitude');
  const page = url.searchParams.get('u') || `/${latS},${lonS}`;
  ctx.waitUntil(logHit(request, env, { kind: 'view', page }));
  const ttls = {
    forecast: Number(env.FORECAST_TTL_MS ?? 12 * 60 * 60 * 1000),
    recent: Number(env.RECENT_TTL_MS ?? 24 * 60 * 60 * 1000),
  };
  try {
    const result = await ensureFresh(env.BUCKET, lat, lon, ttls);
    return json(result);
  } catch (error) {
    console.error('ensure-fresh error:', error);
    return json({ error: 'Failed to refresh recent/forecast data', message: error.message }, 502);
  }
}

// IP geolocation for a bare visit. On Cloudflare we don't need ip-api.com: the
// edge attaches request.cf with the visitor's geolocation already resolved
// (free, no external call, no rate limit) — a strict upgrade over the Node
// server's X-Forwarded-For → ip-api.com path. The frontend snaps the returned
// lat/lon to a servable cell and shows that cell's own name; the name here is
// just a fallback label. Best-effort: if cf is absent (some local dev), 502 and
// the frontend keeps its default city.
function handleGeo(request, env, ctx) {
  const cf = request.cf;
  const lat = cf && Number(cf.latitude);
  const lon = cf && Number(cf.longitude);
  if (!cf || !Number.isFinite(lat) || !Number.isFinite(lon)) {
    return json({ error: 'geolocation unavailable' }, 502);
  }
  // Bare-root landing: log it so homepage visitors who never pick a specific
  // city still count toward unique users.
  ctx.waitUntil(logHit(request, env, { kind: 'geo', page: null }));
  return json({
    lat,
    lon,
    name: [cf.city, cf.region, cf.country].filter(Boolean).join(', '),
  });
}

// ---------------------------------------------------------------------------
// Unique-visitor logging — adblock-proof because it runs server-side here, not
// in a client beacon. One row per hit in D1 (env.DB). The visitor id is a
// STABLE pseudonymous hash of IP+UA+salt: the same person hashes the same from
// day to day, so COUNT(DISTINCT visitor) counts unique people AND returning
// users can be detected across days. It never stores the raw IP and sets no
// cookie. We record WHICH location was viewed and the network/geo for
// bot-filtering — and deliberately nothing about how anyone interacts (no
// metric, no click trail). Best-effort: any failure (incl. no D1 binding in
// local dev) is swallowed so logging never affects the response. Read it back
// on the private /dashboard page (served by analytics.js).
// ---------------------------------------------------------------------------
async function sha256Hex(s) {
  const buf = await crypto.subtle.digest('SHA-256', new TextEncoder().encode(s));
  return [...new Uint8Array(buf)].map((b) => b.toString(16).padStart(2, '0')).join('');
}

async function logHit(request, env, meta) {
  try {
    const db = env.DB;
    if (!db) return; // no D1 binding (e.g. local dev) — silently skip
    const cf = request.cf || {};
    const ip = request.headers.get('CF-Connecting-IP') || '';
    const ua = (request.headers.get('User-Agent') || '').slice(0, 256);
    let refHost = null;
    const ref = request.headers.get('Referer');
    if (ref) { try { refHost = new URL(ref).host; } catch { /* malformed */ } }
    // Stable id (no per-day rotation) so a returning person hashes the same on a
    // later day. Pseudonymous: no raw IP is stored and no cookie is set.
    const salt = env.VISITOR_SALT || 'hhwi';
    const visitor = (await sha256Hex(`${ip}|${ua}|${salt}`)).slice(0, 16);
    await db
      .prepare(
        `INSERT INTO hits (ts, visitor, kind, page, country, city, referer, asn_org, ua)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`
      )
      .bind(
        Date.now(),
        visitor,
        meta.kind,
        meta.page,
        cf.country || null,
        cf.city || null,
        refHost,
        cf.asOrganization || null,
        ua || null
      )
      .run();
  } catch (e) {
    console.error('logHit failed:', e);
  }
}

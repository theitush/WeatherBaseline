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
  async fetch(request, env) {
    const url = new URL(request.url);

    if (request.method === 'OPTIONS') {
      return new Response(null, { status: 204, headers: CORS });
    }

    if (url.pathname === '/api/health') {
      return json({ status: 'ok', timestamp: new Date().toISOString() });
    }

    if (url.pathname === '/api/ensure-fresh') {
      return handleEnsureFresh(url, env);
    }

    if (url.pathname === '/api/geo') {
      return handleGeo(request);
    }

    return json({ error: 'not found' }, 404);
  },
};

async function handleEnsureFresh(url, env) {
  const lat = parseFloat(url.searchParams.get('lat') ?? url.searchParams.get('latitude'));
  const lon = parseFloat(url.searchParams.get('lon') ?? url.searchParams.get('longitude'));
  if (!Number.isFinite(lat) || !Number.isFinite(lon)) {
    return json({ error: 'lat and lon query params are required' }, 400);
  }
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
function handleGeo(request) {
  const cf = request.cf;
  const lat = cf && Number(cf.latitude);
  const lon = cf && Number(cf.longitude);
  if (!cf || !Number.isFinite(lat) || !Number.isFinite(lon)) {
    return json({ error: 'geolocation unavailable' }, 502);
  }
  return json({
    lat,
    lon,
    name: [cf.city, cf.region, cf.country].filter(Boolean).join(', '),
  });
}

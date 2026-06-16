// Private analytics dashboard — server side.
//
// Two routes, both wired in index.js:
//   GET /dashboard       → the self-contained HTML page (DASHBOARD_HTML)
//   GET /api/analytics   → the D1 `hits` table as JSON, for that page
//
// BOTH are behind HTTP Basic Auth (password = env.DASHBOARD_TOKEN). An
// unauthenticated request — including the very HTML of /dashboard — gets a bare
// "This area is private." 401 and the browser's native sign-in dialog, so the
// dashboard is never exposed, not even its chrome. Once the browser has the
// credentials it sends them on every same-origin request, so /api/analytics is
// authorised automatically with no token plumbing in the page.
//
// Bot/human classification mirrors scripts/analytics/query.py so the dashboard's
// "real people" matches the CLI report. We serve the raw rows and let the page
// do the charting/filtering, so the chart and the table share a single fetch.
import { DASHBOARD_HTML } from './dashboardHtml.js';

const CORS = { 'Access-Control-Allow-Origin': '*' };

// --- HTTP Basic Auth gate ---------------------------------------------------
// Reads the password from env.DASHBOARD_TOKEN (a Worker secret in prod, or
// worker/.dev.vars locally). The username is ignored — any username works, only
// the password is checked. Without the secret configured, NOBODY gets in.
function authed(request, env) {
  if (!env.DASHBOARD_TOKEN) return false;
  const h = request.headers.get('Authorization') || '';
  const m = h.match(/^Basic\s+(.+)$/i);
  if (!m) return false;
  let decoded;
  try {
    decoded = atob(m[1]);
  } catch {
    return false;
  }
  const pass = decoded.slice(decoded.indexOf(':') + 1); // strip "username:"
  return pass === env.DASHBOARD_TOKEN;
}

function privatePage() {
  return new Response(
    '<!doctype html><meta charset="utf-8"><title>Private</title>' +
      '<body style="font:16px system-ui;display:grid;place-items:center;height:90vh;margin:0;color:#444">' +
      'This area is private.</body>',
    {
      status: 401,
      headers: {
        'WWW-Authenticate': 'Basic realm="HowHotWasIt analytics", charset="UTF-8"',
        'Content-Type': 'text/html; charset=utf-8',
      },
    }
  );
}

// Datacenter operators → almost always bots/scanners, not humans. Lowercased
// substring match against cf.asOrganization. Keep in sync with query.py.
const BOT_ORGS = [
  'amazon', 'google', 'microsoft', 'azure', 'ovh', 'hetzner', 'digitalocean',
  'linode', 'akamai', 'fastly', 'cloudflare', 'oracle', 'alibaba', 'tencent',
  'leaseweb', 'datacamp', 'm247', 'scaleway', 'censys', 'palo alto',
  'vultr', 'contabo', 'choopa', 'godaddy', 'hostinger',
];
// User-agents that self-identify as automation.
const BOT_UAS = ['bot', 'spider', 'crawl', 'python', 'curl', 'wget', 'http', 'scan', 'go-http'];

export function isHuman(asnOrg, ua) {
  const org = (asnOrg || '').toLowerCase();
  for (const o of BOT_ORGS) if (org.includes(o)) return false;
  const u = (ua || '').toLowerCase();
  for (const b of BOT_UAS) if (u.includes(b)) return false;
  return true;
}

// The metric is the last path segment of page (/lat,lon/date/metric).
function deriveMetric(page) {
  if (!page) return null;
  const m = String(page).match(/\/(tmax|tmin|precip|wind)(?:[/?#]|$)/);
  return m ? m[1] : null;
}

// --- decode the looked-at /lat,lon → place name -----------------------------
// The page stores the location as coordinates; the app's place names live in the
// curated cells.csv (data/cells.csv, served at weatherbaseline.com/cells.csv —
// same file the frontend snaps against in cellIndex.ts). We fetch it once per
// isolate (cached in module scope, plus Cloudflare's edge cache) and decode each
// distinct page to "City, …". Exact 0.1° grid lookup with a nearest-cell
// fallback, mirroring query.py. Best-effort: if the fetch fails, place stays
// null and the dashboard still works.
const CELLS_URL = 'https://weatherbaseline.com/cells.csv';
const PAGE_RE = /^\/(-?\d+(?:\.\d+)?),(-?\d+(?:\.\d+)?)/;
let cellsPromise = null;

function parseCsvLine(line) {
  const out = [];
  let field = '';
  let q = false;
  for (let i = 0; i < line.length; i++) {
    const ch = line[i];
    if (q) {
      if (ch === '"') {
        if (line[i + 1] === '"') { field += '"'; i++; } else q = false;
      } else field += ch;
    } else if (ch === '"') q = true;
    else if (ch === ',') { out.push(field); field = ''; }
    else field += ch;
  }
  out.push(field);
  return out;
}

function getCells() {
  if (!cellsPromise) {
    cellsPromise = fetch(CELLS_URL, { cf: { cacheEverything: true, cacheTtl: 86400 } })
      .then((r) => {
        if (!r.ok) throw new Error('cells.csv ' + r.status);
        return r.text();
      })
      .then((text) => {
        const lines = text.trim().split(/\r?\n/);
        const head = parseCsvLine(lines[0]);
        const li = head.indexOf('lat');
        const oi = head.indexOf('lon');
        const ni = head.indexOf('name');
        const exact = new Map();
        const arr = [];
        for (let i = 1; i < lines.length; i++) {
          const c = parseCsvLine(lines[i]);
          const lat = Number(c[li]);
          const lon = Number(c[oi]);
          if (!Number.isFinite(lat) || !Number.isFinite(lon)) continue;
          const name = ni >= 0 ? (c[ni] || '').trim() : '';
          exact.set(lat.toFixed(1) + ',' + lon.toFixed(1), name);
          arr.push({ lat, lon, name });
        }
        return { exact, arr };
      })
      .catch((e) => {
        cellsPromise = null; // let a later request retry rather than cache failure
        throw e;
      });
  }
  return cellsPromise;
}

function decodePlace(page, idx) {
  if (!page || !idx) return null;
  const m = String(page).match(PAGE_RE);
  if (!m) return null;
  const lat = parseFloat(m[1]);
  const lon = parseFloat(m[2]);
  const hit = idx.exact.get(lat.toFixed(1) + ',' + lon.toFixed(1));
  if (hit !== undefined) return hit;
  let best = null;
  let bd = Infinity;
  for (const c of idx.arr) {
    const dd = (c.lat - lat) ** 2 + (c.lon - lon) ** 2;
    if (dd < bd) { bd = dd; best = c.name; }
  }
  return best;
}

const MAX_ROWS = 50000;

function json(obj, status = 200) {
  return new Response(JSON.stringify(obj), {
    status,
    headers: { 'Content-Type': 'application/json', ...CORS },
  });
}

export async function handleAnalyticsData(request, url, env) {
  if (!authed(request, env)) return privatePage();
  if (!env.DB) {
    return json({ error: 'no D1 binding (DB) on the Worker' }, 503);
  }
  let limit = parseInt(url.searchParams.get('limit') || '', 10);
  if (!Number.isFinite(limit) || limit <= 0 || limit > MAX_ROWS) limit = MAX_ROWS;

  const { results } = await env.DB
    .prepare(
      'SELECT rowid AS id, ts, visitor, kind, page, country, city, referer, asn_org, ua ' +
        'FROM hits ORDER BY ts DESC LIMIT ?'
    )
    .bind(limit)
    .all();

  // Decode the looked-at location once per distinct page (best-effort).
  let idx = null;
  try {
    idx = await getCells();
  } catch {
    idx = null;
  }
  const placeCache = new Map();
  const placeFor = (page) => {
    if (!page) return null;
    if (placeCache.has(page)) return placeCache.get(page);
    const p = decodePlace(page, idx);
    placeCache.set(page, p);
    return p;
  };

  const rows = (results || []).map((r) => ({
    ...r,
    human: isHuman(r.asn_org, r.ua) ? 1 : 0,
    metric: deriveMetric(r.page),
    place: placeFor(r.page), // human label for the location they viewed
  }));
  return json({ rows, count: rows.length, limit, generatedAt: Date.now() });
}

export function handleDashboard(request, env) {
  if (!authed(request, env)) return privatePage();
  return new Response(DASHBOARD_HTML, {
    status: 200,
    headers: { 'Content-Type': 'text/html; charset=utf-8' },
  });
}

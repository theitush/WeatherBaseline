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
// Bot/human classification lives here — it's what the dashboard's "real people"
// count is built from. We serve the raw rows and let the page do the
// charting/filtering, so the chart and the table share a single fetch.
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

// Bot/human classification — the single source of truth for the dashboard.
//
// Lowercased substring match against cf.asOrganization, split into two tiers
// because a raw datacenter and an egress relay are NOT the same thing:
//   • DATACENTER_ORGS — pure hosting / scanners / residential-proxy operators.
//     Real users never originate here, so a match is a bot (rescuable only by
//     the drill-down behaviour below).
//   • RELAY_ORGS — egress relays that BOTH bots and real people sit behind:
//     iCloud Private Relay (egresses via Cloudflare/Akamai/Fastly) and consumer
//     VPNs ("vpn" in the org, incl. "VPN by Google"). A match is a bot ONLY when
//     the UA isn't a real browser — a genuine browser through a relay is a real
//     person (e.g. an iPhone on Private Relay), not a scanner.
const DATACENTER_ORGS = [
  'amazon', 'microsoft', 'azure', 'google cloud', 'ovh', 'hetzner',
  'digitalocean', 'linode', 'oracle', 'alibaba', 'tencent', 'leaseweb',
  'datacamp', 'm247', 'scaleway', 'censys', 'palo alto', 'vultr', 'contabo',
  'choopa', 'godaddy', 'hostinger',
  // Residential-proxy operators: sell scraping exits on real consumer IPs, so
  // they look like home users and slip past the datacenter names above.
  'code200', 'oxylabs', 'tesonet', 'bright data', 'luminati', 'smartproxy',
  'iproyal', 'packetstream', 'webshare',
];
const RELAY_ORGS = ['cloudflare', 'akamai', 'fastly', 'vpn'];
// User-agents that self-identify as automation — a hard signal, never rescued.
const BOT_UAS = [
  'bot', 'spider', 'crawl', 'python', 'curl', 'wget', 'go-http', 'scan',
  'okhttp', 'java/', 'headless', 'node-fetch', 'axios', 'libwww',
];
// A genuine consumer browser: Mozilla token + a real engine token.
const BROWSER_RE = /mozilla\/.*(safari|chrome|crios|firefox|fxios|edg|opr|samsungbrowser|version\/)/i;
// A bare "/lat,lon" page (no date/metric) — see U_REQUIRED_SINCE.
const BARE_COORD_RE = /^\/-?\d+(?:\.\d+)?,-?\d+(?:\.\d+)?$/;
// The app always sends its real URL as `?u=` on /api/ensure-fresh, so a bare
// "/lat,lon" page means the call did NOT come from our UI (a direct API hit =
// bot). Only trusted from this instant on, after EVERY frontend path began
// sending `u` (the compare page / year chart used to omit it). Bump this to
// your actual frontend deploy time.
const U_REQUIRED_SINCE = Date.parse('2026-06-17T00:00:00Z');
// A browsing session ends after a gap this long; HUMAN_MIN_PAGES distinct
// content pages within one session marks a real person.
const SESSION_GAP_MS = 30 * 60 * 1000;
const HUMAN_MIN_PAGES = 3;

const hasAny = (hay, needles) => needles.some((n) => hay.includes(n));

// Hard automation signal — no behaviour can rescue it.
export function automationUA(ua) {
  return hasAny((ua || '').toLowerCase(), BOT_UAS);
}

// Per-row "looks like a bot by network / route" — rescuable by drill-down.
export function signatureBot(asnOrg, ua, page, ts) {
  const org = (asnOrg || '').toLowerCase();
  if (hasAny(org, DATACENTER_ORGS)) return true; // raw hosting / proxy
  if (hasAny(org, RELAY_ORGS) && !BROWSER_RE.test(ua || '')) return true; // relay w/o browser
  if (page && BARE_COORD_RE.test(page) && Number(ts) >= U_REQUIRED_SINCE) return true; // direct API hit
  return false;
}

// A real content URL the app emits (/lat,lon/date/metric, /compare/…) — i.e.
// >=3 path segments. A bare "/lat,lon" or the home "/" doesn't count.
function isContentPage(page) {
  return /^\/[^/]+\/[^/]+\/[^/]+/.test(String(page || ''));
}

// Behavioural rescue: visitors who opened >=HUMAN_MIN_PAGES distinct content
// pages within a single browsing session (consecutive hits < SESSION_GAP_MS
// apart) are clicking around like a person — across ANY cities/dates/metrics,
// not tied to one location. Strong enough to override a datacenter-org /
// bare-coord flag (but never an automation UA). `geo` events are deliberately
// NOT counted: a rendering scanner (e.g. Palo Alto's URL filter) fires them too.
export function behaviouralHumans(rows) {
  const byVisitor = new Map(); // visitor -> [{ ts, page }]
  for (const r of rows) {
    if (!isContentPage(r.page)) continue;
    let evs = byVisitor.get(r.visitor);
    if (!evs) byVisitor.set(r.visitor, (evs = []));
    evs.push({ ts: Number(r.ts) || 0, page: r.page });
  }
  const human = new Set();
  for (const [visitor, evs] of byVisitor) {
    evs.sort((a, b) => a.ts - b.ts);
    let start = 0;
    for (let i = 1; i <= evs.length; i++) {
      const sessionEnd = i === evs.length || evs[i].ts - evs[i - 1].ts > SESSION_GAP_MS;
      if (!sessionEnd) continue;
      const pages = new Set();
      for (let j = start; j < i; j++) pages.add(evs[j].page);
      if (pages.size >= HUMAN_MIN_PAGES) { human.add(visitor); break; }
      start = i;
    }
  }
  return human;
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
// fallback. Best-effort: if the fetch fails, place stays null and the dashboard
// still works.
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
      'SELECT rowid AS id, ts, visitor, kind, page, country, city, referer, asn_org, ua, ' +
        'query, matched, served, dist_km FROM hits ORDER BY ts DESC LIMIT ?'
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

  // Behavioural rescue needs the whole result set (per-visitor), so compute the
  // set of behaviourally-human visitors once, then label each row.
  const rescued = behaviouralHumans(results || []);
  const rows = (results || []).map((r) => ({
    ...r,
    human:
      !automationUA(r.ua) &&
      (!signatureBot(r.asn_org, r.ua, r.page, r.ts) || rescued.has(r.visitor))
        ? 1
        : 0,
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

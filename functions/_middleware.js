// Cloudflare Pages Function — middleware for social link previews.
//
// Social crawlers (Slack, Twitter/X, Facebook, Discord, etc.) don't run JS, so
// they only see the static index.html — which carries ONE generic preview card
// for every path. This middleware fixes that for deep links: when (and only
// when) a known crawler requests a /<lat,lon>/<date>/<metric> URL, it rewrites
// the og/twitter description in the served HTML to "<Date> · <City>", and
// retargets canonical/og:url at the share URL (Facebook/WhatsApp otherwise
// follow them to the root and use ITS metadata). The title is always the fixed
// question (set in index.html); only the description varies.
//
// Real visitors are never touched: non-crawler requests, and any path that
// isn't a valid share link (e.g. the bare root), pass straight through to the
// untouched static HTML + SPA, which keeps the generic card from index.html.
//
// Path grammar mirrors frontend/src/services/urlState.ts:
//   /<lat>,<lon>/<date>/<metric>   e.g. /39.80,-89.64/2025-07-15/tmax
// The coords ARE a real cell centre, so the city name is an exact lat/lon
// lookup in /cells.csv (no nearest-neighbour search needed).

// Valid metric tokens (match urlState.ts) — used only to validate a share path,
// since the description no longer depends on the metric.
const METRIC_TOKENS = new Set(['tmax', 'tmin', 'precip', 'wind']);

const DATE_RE = /^\d{4}-\d{2}-\d{2}$/;
const MONTHS = ['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun',
                'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec'];

// Substrings that identify social-preview crawlers (lowercased UA match).
const CRAWLER_UA = [
  'slackbot', 'twitterbot', 'facebookexternalhit', 'facebot',
  'discordbot', 'whatsapp', 'telegrambot', 'linkedinbot', 'pinterest',
  'redditbot', 'embedly', 'iframely', 'skypeuripreview', 'vkshare',
  'googlebot', 'bingbot', 'applebot', 'developers.google.com/+/web/snippet',
];

function isCrawler(ua) {
  if (!ua) return false;
  const lc = ua.toLowerCase();
  return CRAWLER_UA.some((sig) => lc.includes(sig));
}

// Parse a share path into { lat, lon, date } or null. Tolerant of trailing
// slashes; same validation as urlState.parsePath. The metric is validated but
// not returned — the preview text no longer depends on it.
function parseShare(pathname) {
  const segs = pathname.split('/').filter(Boolean);
  if (segs.length < 3) return null;
  const [locSeg, dateSeg, metricSeg] = segs;

  const coords = locSeg.split(',');
  if (coords.length !== 2) return null;
  const lat = Number(coords[0]);
  const lon = Number(coords[1]);
  if (!Number.isFinite(lat) || !Number.isFinite(lon)) return null;
  if (lat < -90 || lat > 90 || lon < -180 || lon > 180) return null;

  if (!DATE_RE.test(dateSeg)) return null;
  if (!METRIC_TOKENS.has(metricSeg)) return null;

  return { lat, lon, date: dateSeg };
}

// "2025-07-15" -> "Jul 15, 2025". Parsed as plain parts (no Date/tz games).
function formatDate(iso) {
  const [y, m, d] = iso.split('-').map(Number);
  return `${MONTHS[m - 1]} ${d}, ${y}`;
}

// Look up the cell name by exact lat/lon. cells.csv coords are stored at 0.1°;
// the URL carries 2dp, so compare on rounded values to be robust. Cached per
// isolate after first fetch. Returns the name string, or '' if not found.
let cellNamePromise = null;
function loadCellNames(origin) {
  if (!cellNamePromise) {
    cellNamePromise = fetch(`${origin}/cells.csv`)
      .then((res) => (res.ok ? res.text() : ''))
      .then((text) => {
        const map = new Map();
        if (!text) return map;
        const lines = text.split('\n');
        // splitCsv strips a trailing \r; cells.csv ships with CRLF endings, so a
        // plain split here would leave the last header as "name\r" (idx -1).
        const header = splitCsv(lines[0]);
        const latIdx = header.indexOf('lat');
        const lonIdx = header.indexOf('lon');
        const nameIdx = header.indexOf('name');
        for (let i = 1; i < lines.length; i++) {
          const line = lines[i];
          if (!line) continue;
          const cols = splitCsv(line);
          const lat = Number(cols[latIdx]);
          const lon = Number(cols[lonIdx]);
          if (!Number.isFinite(lat) || !Number.isFinite(lon)) continue;
          map.set(coordKey(lat, lon), (cols[nameIdx] ?? '').trim());
        }
        return map;
      })
      .catch(() => new Map());
  }
  return cellNamePromise;
}

function coordKey(lat, lon) {
  // 2dp matches the URL's coordinate precision (fmtCoord in urlState.ts).
  return `${lat.toFixed(2)},${lon.toFixed(2)}`;
}

// Minimal CSV line split honouring double-quoted fields (the name column).
function splitCsv(line) {
  const out = [];
  let cur = '';
  let inQ = false;
  for (let i = 0; i < line.length; i++) {
    const ch = line[i];
    if (inQ) {
      if (ch === '"') inQ = false;
      else cur += ch;
    } else if (ch === '"') {
      inQ = true;
    } else if (ch === ',') {
      out.push(cur);
      cur = '';
    } else {
      cur += ch;
    }
  }
  out.push(cur);
  return out.map((s) => s.trim().replace(/\r$/, ''));
}

function escapeAttr(s) {
  return s
    .replace(/&/g, '&amp;')
    .replace(/"/g, '&quot;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;');
}

// HTMLRewriter handler that overwrites one attribute on matched elements.
class SetAttr {
  constructor(attr, value) {
    this.attr = attr;
    this.value = value;
  }
  element(el) {
    el.setAttribute(this.attr, this.value);
  }
}

export async function onRequest(context) {
  const { request, next } = context;

  // Always let Pages serve the asset; we only post-process HTML for crawlers.
  const response = await next();

  if (!isCrawler(request.headers.get('user-agent'))) return response;

  const ct = response.headers.get('content-type') || '';
  if (!ct.includes('text/html')) return response;

  const url = new URL(request.url);
  const share = parseShare(url.pathname);
  if (!share) return response; // bare root / non-share path -> generic card

  const names = await loadCellNames(url.origin);
  const city = names.get(coordKey(share.lat, share.lon));
  // No name match: leave the generic card rather than show raw coords.
  if (!city) return response;

  // Title is the fixed question (already in index.html) — only the description
  // changes per link: "<Date> · <City>".
  const desc = escapeAttr(`${formatDate(share.date)} · ${city}`);

  // The static HTML's canonical/og:url point at the bare root. Facebook's
  // crawler (WhatsApp previews) follows them and swaps in the ROOT's metadata,
  // discarding the per-link description — so retarget both at this share URL,
  // always on the canonical www host.
  const shareUrl = `https://www.weatherbaseline.com${url.pathname.replace(/\/+$/, '')}`;

  return new HTMLRewriter()
    .on('meta[property="og:description"]', new SetAttr('content', desc))
    .on('meta[name="twitter:description"]', new SetAttr('content', desc))
    .on('meta[name="description"]', new SetAttr('content', desc))
    .on('meta[property="og:url"]', new SetAttr('content', shareUrl))
    .on('link[rel="canonical"]', new SetAttr('href', shareUrl))
    .transform(response);
}

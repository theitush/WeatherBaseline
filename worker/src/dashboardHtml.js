// The /dashboard page — one self-contained HTML document (no build step, no
// framework). It fetches the whole `hits` table from /api/analytics and renders:
//   • a top card: stacked time-series chart — x = date/time, y = views by real
//     people, one colour (hue) per country
//   • a bottom card: the entire table, with a filter box under every column
// All charting + filtering happens client-side from a single fetch, so the API
// just hands back raw rows. Kept deliberately plain to match the site's
// scientific-print register (Spectral / Geist / Geist Mono).
export const DASHBOARD_HTML = `<!doctype html>
<html lang="en">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<meta name="robots" content="noindex,nofollow">
<title>HowHotWasIt — analytics</title>
<link rel="preconnect" href="https://fonts.googleapis.com">
<link rel="preconnect" href="https://fonts.gstatic.com" crossorigin>
<link href="https://fonts.googleapis.com/css2?family=Geist:wght@400;500;600&family=Geist+Mono:wght@400;500&family=Spectral:wght@500;600&display=swap" rel="stylesheet">
<style>
  :root {
    --ink: #1a1a1a; --muted: #6b6b6b; --line: #e4e4e4; --line2: #f0f0f0;
    --bg: #fbfbfa; --card: #ffffff; --accent: #b3471f;
    --mono: 'Geist Mono', ui-monospace, monospace;
    --sans: 'Geist', system-ui, sans-serif;
    --serif: 'Spectral', Georgia, serif;
  }
  * { box-sizing: border-box; }
  body {
    margin: 0; background: var(--bg); color: var(--ink); font-family: var(--sans);
    font-size: 14px; line-height: 1.45; -webkit-font-smoothing: antialiased;
  }
  .wrap { max-width: 1240px; margin: 0 auto; padding: 28px 20px 80px; }
  header.top { display: flex; align-items: baseline; justify-content: space-between; gap: 16px; flex-wrap: wrap; margin-bottom: 22px; }
  h1 { font-family: var(--serif); font-weight: 600; font-size: 24px; margin: 0; letter-spacing: -0.01em; }
  h1 .sub { font-family: var(--sans); font-weight: 400; color: var(--muted); font-size: 13px; margin-left: 10px; }
  .card { background: var(--card); border: 1px solid var(--line); border-radius: 6px; padding: 18px 20px; margin-bottom: 22px; }
  .card h2 { font-family: var(--serif); font-weight: 600; font-size: 15px; margin: 0 0 2px; }
  .card .note { color: var(--muted); font-size: 12px; margin: 0 0 14px; }
  .controls { display: flex; gap: 8px; align-items: center; flex-wrap: wrap; }
  button, select, input { font-family: var(--sans); font-size: 13px; color: var(--ink); }
  button, select {
    background: #fff; border: 1px solid var(--line); border-radius: 5px; padding: 5px 11px; cursor: pointer;
  }
  button:hover, select:hover { border-color: #c8c8c8; }
  button.primary { background: var(--ink); color: #fff; border-color: var(--ink); }
  .seg { display: inline-flex; border: 1px solid var(--line); border-radius: 5px; overflow: hidden; }
  .seg button { border: 0; border-radius: 0; padding: 5px 12px; background: #fff; }
  .seg button.on { background: var(--ink); color: #fff; }
  .seg button + button { border-left: 1px solid var(--line); }

  .chips { display: flex; gap: 26px; flex-wrap: wrap; margin: 2px 0 16px; }
  .chip .v { font-family: var(--mono); font-size: 21px; font-weight: 500; display: block; line-height: 1.1; }
  .chip .k { color: var(--muted); font-size: 11px; text-transform: uppercase; letter-spacing: 0.06em; }

  .chartrow { display: flex; gap: 18px; align-items: flex-start; flex-wrap: wrap; }
  .chartbox { flex: 1 1 640px; min-width: 0; position: relative; }
  svg.chart { width: 100%; height: auto; display: block; }
  svg.chart text { font-family: var(--mono); fill: var(--muted); font-size: 11px; }
  svg.chart .axis { stroke: var(--line); stroke-width: 1; }
  svg.chart .grid { stroke: var(--line2); stroke-width: 1; }
  svg.chart rect.bar:hover { opacity: 0.78; }
  .legend { flex: 0 0 190px; font-size: 12.5px; }
  .legend .lg { display: flex; align-items: center; gap: 8px; padding: 2px 0; }
  .legend .sw { width: 11px; height: 11px; border-radius: 2px; flex: 0 0 auto; }
  .legend .ct { flex: 1 1 auto; overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
  .legend .n { font-family: var(--mono); color: var(--muted); }
  .tip {
    position: fixed; pointer-events: none; background: var(--ink); color: #fff; font-size: 12px;
    padding: 5px 9px; border-radius: 5px; opacity: 0; transition: opacity .08s; z-index: 30; font-family: var(--mono);
    white-space: nowrap;
  }
  .tip b { font-family: var(--sans); }

  .tablewrap { overflow-x: auto; border: 1px solid var(--line); border-radius: 6px; }
  table { border-collapse: collapse; width: 100%; font-size: 12.5px; }
  thead th { position: sticky; top: 0; background: #faf9f8; text-align: left; padding: 8px 10px 4px; border-bottom: 1px solid var(--line); white-space: nowrap; }
  thead th .hd { display: flex; align-items: center; gap: 5px; cursor: pointer; user-select: none; font-weight: 600; }
  thead th .hd .ar { color: var(--accent); font-size: 10px; }
  thead th input { width: 100%; margin-top: 5px; border: 1px solid var(--line); border-radius: 4px; padding: 3px 6px; font-family: var(--mono); font-size: 11px; }
  tbody td { padding: 5px 10px; border-bottom: 1px solid var(--line2); white-space: nowrap; vertical-align: top; }
  tbody tr:hover { background: #fcfbf7; }
  td.mono, .num { font-family: var(--mono); }
  td.page, td.ref { max-width: 320px; overflow: hidden; text-overflow: ellipsis; }
  /* user-agents are long — let them wrap so the whole string is readable */
  td.ua { white-space: normal; overflow-wrap: anywhere; word-break: break-word; min-width: 240px; max-width: 440px; }
  td.place { max-width: 220px; overflow: hidden; text-overflow: ellipsis; font-weight: 500; }
  .muted { color: #c4c4c4; }
  .pill { font-family: var(--mono); font-size: 11px; padding: 1px 7px; border-radius: 999px; border: 1px solid var(--line); }
  .pill.human { color: #1d7a46; border-color: #bfe3cd; background: #f1faf4; }
  .pill.bot { color: #9a6b00; border-color: #ecdcb0; background: #fdf8ec; }
  .tablebar { display: flex; justify-content: space-between; align-items: center; gap: 12px; flex-wrap: wrap; margin: 0 0 10px; }
  .count { color: var(--muted); font-size: 12px; font-family: var(--mono); }
  .empty { padding: 40px; text-align: center; color: var(--muted); }
  a.link { color: var(--accent); text-decoration: none; }
  a.link:hover { text-decoration: underline; }
  .err { color: #b00020; }
</style>
</head>
<body>
<div class="wrap">
  <header class="top">
    <h1>HowHotWasIt <span class="sub">first-party analytics · D1 <code>hits</code></span></h1>
    <div class="controls">
      <label class="count" for="range">Range</label>
      <select id="range" title="Time window counted back from now">
        <option value="3h">Last 3 hours</option>
        <option value="24h">Last 24 hours</option>
        <option value="week">Last week</option>
        <option value="month">Last month</option>
        <option value="all" selected>All time</option>
      </select>
      <span id="gen" class="count"></span>
      <button id="refresh">Refresh</button>
    </div>
  </header>

  <section class="card" id="topcard">
    <h2>Hits over time</h2>
    <p class="note">Mirrors the filtered table below — exactly the rows shown there, bucketed by time, hue = country (top 8 + Other). By default the <code>who</code> filter is set to <code>human</code>, so bot/datacenter traffic is excluded; clear or edit it to change the chart.</p>
    <div class="chips" id="chips"></div>
    <div class="controls" style="margin-bottom:14px">
      <span class="count">Bucket</span>
      <span class="seg" id="bucketseg">
        <button data-b="10m">10 min</button>
        <button data-b="hour" class="on">Hour</button>
        <button data-b="day">Day</button>
      </span>
    </div>
    <div class="chartrow">
      <div class="chartbox"><div id="chart"></div></div>
      <div class="legend" id="legend"></div>
    </div>
  </section>

  <section class="card">
    <h2>Every hit</h2>
    <p class="note">The raw <code>hits</code> table, newest first. Filter any column (substring, case-insensitive): comma-separate to match more (<code>tmax, tmin</code>), prefix <code>~</code> to exclude (<code>~bot</code>, or <code>~bot, ~python</code>). Click a header to sort. The chart above tracks whatever's shown here.</p>
    <div class="tablebar">
      <span class="count" id="rowcount"></span>
      <div class="controls">
        <button id="clearf">Clear filters</button>
        <button id="csv">Download CSV</button>
      </div>
    </div>
    <div class="tablewrap">
      <table>
        <thead id="thead"></thead>
        <tbody id="tbody"></tbody>
      </table>
    </div>
  </section>
</div>
<div class="tip" id="tip"></div>

<script>
(function () {
  var COLS = [
    { k: 'time',    label: 'time',           cls: 'mono' },
    { k: 'visitor', label: 'visitor id',     cls: 'mono' },
    { k: 'kind',    label: 'kind',           cls: 'mono' },
    { k: 'human',   label: 'who',            cls: '' },
    { k: 'city',    label: 'from · city',    cls: '' },
    { k: 'country', label: 'from · country', cls: 'mono' },
    { k: 'place',   label: 'looking at',     cls: 'place' },
    { k: 'metric',  label: 'metric',         cls: 'mono' },
    { k: 'page',    label: 'page (raw url)', cls: 'mono page' },
    { k: 'referer', label: 'referer',        cls: 'mono ref' },
    { k: 'asn_org', label: 'asn / org',      cls: '' },
    { k: 'ua',      label: 'user-agent',     cls: 'mono ua' }
  ];
  var PALETTE = ['#b3471f', '#2f6f9f', '#3a8a5f', '#c79a1e', '#7a5aa6', '#1f9a9a', '#c2557a', '#6b8e23'];
  var OTHER_COLOR = '#9aa0a6';
  // The public site — page values are stored as paths (/lat,lon/date/metric),
  // so prepend this to make the 'page' cells real, clickable links.
  var SITE = 'https://www.weatherbaseline.com';
  // The owner's own pseudonymous visitor id → shown as a friendly label so it's
  // trivial to filter in/out (excluded by default via the 'visitor' filter).
  var ME = '62a0f4068c1762bb', ME_LABEL = 'ita';

  var ALL = [];        // raw rows + derived 'time' string
  var bucket = 'hour';
  var range = 'all';   // time window counted back from now ('all' = no cap)
  // col -> raw filter text. Defaults: only humans (the 'who' column reads
  // 'human'/'bot') and the owner's own traffic excluded (~ita). Both defaults
  // are real filter text, so they appear in the column boxes and can be edited
  // or cleared. Syntax: comma-separated terms; a leading '~' excludes.
  var filters = { human: 'human', visitor: '~' + ME_LABEL };
  var sortCol = 'time', sortDir = -1;  // default newest first (ts desc)
  var colorMap = {};

  var $ = function (id) { return document.getElementById(id); };
  function esc(s) { return String(s == null ? '' : s).replace(/[&<>"]/g, function (c) { return { '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' }[c]; }); }
  function pad(n) { return n < 10 ? '0' + n : '' + n; }

  function locked(msg) {
    $('chips').innerHTML = '';
    $('chart').innerHTML = '<div class="empty">' + esc(msg) + '</div>';
    $('legend').innerHTML = '';
    $('thead').innerHTML = '';
    $('tbody').innerHTML = '<tr><td class="empty">Locked.</td></tr>';
    $('rowcount').textContent = '';
  }

  function fmtTime(ts) {
    var d = new Date(ts);
    return d.getFullYear() + '-' + pad(d.getMonth() + 1) + '-' + pad(d.getDate()) +
      ' ' + pad(d.getHours()) + ':' + pad(d.getMinutes()) + ':' + pad(d.getSeconds());
  }

  function load() {
    // Auth is HTTP Basic, handled by the browser — the same credentials that
    // unlocked this page ride along on this same-origin fetch automatically.
    // Resolve against location.origin (never carries credentials) so the fetch
    // works even if the page URL was opened with user:pass@ embedded.
    $('gen').textContent = 'loading…';
    fetch(new URL('/api/analytics?limit=50000', location.origin))
      .then(function (r) {
        if (r.status === 401) { $('gen').textContent = ''; locked('Session expired — reload to sign in.'); throw new Error('auth'); }
        if (!r.ok) { return r.json().then(function (j) { throw new Error(j.error || ('HTTP ' + r.status)); }); }
        return r.json();
      })
      .then(function (j) {
        ALL = (j.rows || []).map(function (r) { r.time = fmtTime(r.ts); return r; });
        $('gen').textContent = j.count + ' rows · ' + new Date(j.generatedAt).toLocaleTimeString();
        renderAll();
      })
      .catch(function (e) {
        if (e.message === 'auth') return;
        $('gen').innerHTML = '<span class="err">' + esc(e.message) + '</span>';
      });
  }

  // ---- chart -------------------------------------------------------------
  function bucketKey(ts) {
    var d = new Date(ts);
    var base = d.getFullYear() + '-' + pad(d.getMonth() + 1) + '-' + pad(d.getDate());
    if (bucket === 'day') return base;
    var hh = pad(d.getHours());
    if (bucket === 'hour') return base + ' ' + hh + ':00';
    return base + ' ' + hh + ':' + pad(Math.floor(d.getMinutes() / 10) * 10); // 10m
  }
  function nextKey(key) {
    // advance one bucket, for gap-filling a continuous x axis
    var d;
    if (bucket === 'day') { d = new Date(key + 'T00:00:00'); d.setDate(d.getDate() + 1); return bucketKey(d.getTime()); }
    d = new Date(key.replace(' ', 'T') + ':00');
    if (bucket === 'hour') d.setHours(d.getHours() + 1); else d.setMinutes(d.getMinutes() + 10);
    return bucketKey(d.getTime());
  }

  function niceTicks(max) {
    if (max <= 5) { var a = []; for (var i = 0; i <= Math.max(max, 1); i++) a.push(i); return a; }
    var raw = max / 5, mag = Math.pow(10, Math.floor(Math.log10(raw))), n = raw / mag;
    var step = (n >= 5 ? 5 : n >= 2 ? 2 : 1) * mag;
    var top = Math.ceil(max / step) * step, out = [];
    for (var v = 0; v <= top + 1e-9; v += step) out.push(Math.round(v));
    return out;
  }

  function buildChart(srcRows) {
    // The chart shows exactly what the table shows — the same filtered/sorted
    // set — so they can never disagree.
    var views = srcRows;
    // country totals → top 8 + Other (null country shown as '??')
    var tot = {};
    views.forEach(function (r) { var c = r.country || '??'; tot[c] = (tot[c] || 0) + 1; });
    var ranked = Object.keys(tot).sort(function (a, b) { return tot[b] - tot[a]; });
    var top = ranked.slice(0, 8);
    var topSet = {}; top.forEach(function (c) { topSet[c] = 1; });
    var order = top.slice();
    if (ranked.length > 8) order.push('Other');
    colorMap = {};
    top.forEach(function (c, i) { colorMap[c] = PALETTE[i % PALETTE.length]; });
    colorMap['Other'] = OTHER_COLOR;

    // bucket → country → count (countries outside the top 8 collapse to 'Other')
    var buckets = {};
    views.forEach(function (r) {
      var k = bucketKey(r.ts);
      var c = r.country || '??';
      var key = topSet[c] ? c : 'Other';
      if (!buckets[k]) buckets[k] = {};
      buckets[k][key] = (buckets[k][key] || 0) + 1;
    });

    var keys = Object.keys(buckets).sort();
    var list = [];
    if (keys.length) {
      var cur = keys[0], last = keys[keys.length - 1], guard = 0;
      while (guard++ < 2000) {
        list.push(cur);
        if (cur === last) break;
        cur = nextKey(cur);
      }
      // if gap-fill blew past (granularity mismatch), fall back to present keys
      if (list.indexOf(last) === -1) list = keys;
    }

    var rows = list.map(function (k) {
      var seg = buckets[k] || {}, total = 0;
      order.forEach(function (c) { total += seg[c] || 0; });
      return { key: k, seg: seg, total: total };
    });
    drawSvg(rows, order);
    drawLegend(order, tot, topSet);
  }

  function drawSvg(rows, order) {
    var W = 1000, H = 420, mL = 48, mR = 14, mT = 14, mB = 78;
    var plotW = W - mL - mR, plotH = H - mT - mB;
    var maxV = 0; rows.forEach(function (b) { if (b.total > maxV) maxV = b.total; });
    var ticks = niceTicks(maxV), topV = ticks[ticks.length - 1] || 1;
    var y = function (v) { return mT + plotH - (v / topV) * plotH; };
    var n = rows.length, step = plotW / Math.max(n, 1), bw = Math.min(46, step * 0.72);

    var s = '<svg class="chart" viewBox="0 0 ' + W + ' ' + H + '" preserveAspectRatio="xMidYMid meet" role="img">';
    // y grid + labels
    ticks.forEach(function (t) {
      var yy = y(t);
      s += '<line class="grid" x1="' + mL + '" y1="' + yy + '" x2="' + (W - mR) + '" y2="' + yy + '"/>';
      s += '<text x="' + (mL - 7) + '" y="' + (yy + 3.5) + '" text-anchor="end">' + t + '</text>';
    });
    // bars
    var everyX = Math.ceil(n / 18);
    rows.forEach(function (b, i) {
      var x = mL + step * i + (step - bw) / 2, acc = 0;
      order.forEach(function (c) {
        var v = b.seg[c] || 0;
        if (v > 0) {
          var y0 = y(acc), y1 = y(acc + v);
          s += '<rect class="bar" x="' + x.toFixed(1) + '" y="' + y1.toFixed(1) + '" width="' + bw.toFixed(1) +
            '" height="' + Math.max(0, y0 - y1).toFixed(1) + '" fill="' + colorMap[c] +
            '" data-c="' + esc(c) + '" data-v="' + v + '" data-b="' + esc(b.key) + '"/>';
          acc += v;
        }
      });
      if (i % everyX === 0) {
        var lab = bucket === 'hour' ? b.key.slice(5) : b.key.slice(5);
        s += '<text x="' + (x + bw / 2) + '" y="' + (mT + plotH + 14) + '" text-anchor="end" transform="rotate(-40 ' +
          (x + bw / 2) + ' ' + (mT + plotH + 14) + ')">' + esc(lab) + '</text>';
      }
    });
    // axes
    s += '<line class="axis" x1="' + mL + '" y1="' + (mT + plotH) + '" x2="' + (W - mR) + '" y2="' + (mT + plotH) + '"/>';
    s += '<line class="axis" x1="' + mL + '" y1="' + mT + '" x2="' + mL + '" y2="' + (mT + plotH) + '"/>';
    s += '</svg>';
    var box = $('chart');
    box.innerHTML = rows.length ? s : '<div class="empty">No rows match the current filters.</div>';
    wireTips(box);
  }

  function wireTips(box) {
    var tip = $('tip');
    box.querySelectorAll('rect.bar').forEach(function (el) {
      el.addEventListener('mousemove', function (e) {
        tip.innerHTML = '<b>' + esc(el.getAttribute('data-c')) + '</b> · ' + el.getAttribute('data-v') +
          ' views<br>' + esc(el.getAttribute('data-b'));
        tip.style.left = (e.clientX + 12) + 'px';
        tip.style.top = (e.clientY + 12) + 'px';
        tip.style.opacity = '1';
      });
      el.addEventListener('mouseleave', function () { tip.style.opacity = '0'; });
    });
  }

  function drawLegend(order, tot, topSet) {
    var otherTotal = 0;
    Object.keys(tot).forEach(function (c) { if (!topSet[c]) otherTotal += tot[c]; });
    var html = '';
    order.forEach(function (c) {
      var n = c === 'Other' ? otherTotal : (tot[c] || 0);
      html += '<div class="lg"><span class="sw" style="background:' + colorMap[c] + '"></span>' +
        '<span class="ct">' + esc(c) + '</span><span class="n">' + n + '</span></div>';
    });
    $('legend').innerHTML = html;
  }

  // ---- summary chips -----------------------------------------------------
  // Describe the DISPLAYED rows (the same set the chart draws), with total rows
  // as context, so the numbers always agree with what's on screen.
  function renderChips(rows) {
    var uniq = {}; rows.forEach(function (r) { uniq[r.visitor] = 1; });
    var span = '—';
    if (rows.length) {
      var lo = Infinity, hi = -Infinity;
      rows.forEach(function (r) { if (r.ts < lo) lo = r.ts; if (r.ts > hi) hi = r.ts; });
      var a = fmtTime(lo).slice(0, 10), b = fmtTime(hi).slice(0, 10);
      span = a === b ? a : a + ' → ' + b;
    }
    var chips = [
      ['shown', rows.length],
      ['unique people', Object.keys(uniq).length],
      ['total rows', ALL.length],
      ['date range', span]
    ];
    $('chips').innerHTML = chips.map(function (c) {
      return '<div class="chip"><span class="v">' + esc(c[1]) + '</span><span class="k">' + c[0] + '</span></div>';
    }).join('');
  }

  // ---- table -------------------------------------------------------------
  function coordsOf(page) {
    if (!page) return '';
    var m = String(page).match(/^\\/(-?\\d+(?:\\.\\d+)?),(-?\\d+(?:\\.\\d+)?)/);
    return m ? m[1] + ', ' + m[2] : '';
  }
  function cellText(r, k) {
    if (k === 'human') return r.human ? 'human' : 'bot';
    if (k === 'place') return r.place || '';
    if (k === 'visitor') return r.visitor === ME ? ME_LABEL : r.visitor;
    return r[k];
  }
  function cellHtml(r, k) {
    if (k === 'human') return '<span class="pill ' + (r.human ? 'human' : 'bot') + '">' + (r.human ? 'human' : 'bot') + '</span>';
    if (k === 'place') {
      if (r.place) return esc(r.place);
      if (!r.page) return '<span class="muted">(home)</span>';
      var co = coordsOf(r.page);
      return co ? '<span class="muted">' + esc(co) + '</span>' : '<span class="muted">·</span>';
    }
    // The raw page path → a clickable link to the live site (new tab).
    if (k === 'page') {
      if (!r.page) return '<span class="muted">·</span>';
      return '<a class="link" href="' + esc(SITE + r.page) + '" target="_blank" rel="noopener">' + esc(r.page) + '</a>';
    }
    var v = cellText(r, k);
    if (v == null || v === '') return '<span class="muted">·</span>';
    return esc(v);
  }

  // Parse a filter box into include/exclude terms. Comma-separates the terms;
  // a leading '~' marks an exclude. Case-insensitive, substring.
  //   "tmax, tmin"   → include tmax OR tmin
  //   "~bot"         → exclude anything containing bot
  //   "~bot, ~python"→ exclude both
  function parseFilter(raw) {
    var inc = [], exc = [];
    String(raw || '').split(',').forEach(function (t) {
      t = t.trim().toLowerCase();
      if (!t) return;
      if (t.charAt(0) === '~') { var e = t.slice(1).trim(); if (e) exc.push(e); }
      else inc.push(t);
    });
    return { inc: inc, exc: exc };
  }
  // A cell passes when it contains NONE of the excludes and (if any includes are
  // given) at least ONE include.
  function matchCell(val, pf) {
    var s = String(val == null ? '' : val).toLowerCase();
    for (var i = 0; i < pf.exc.length; i++) if (s.indexOf(pf.exc[i]) !== -1) return false;
    if (pf.inc.length) {
      for (var j = 0; j < pf.inc.length; j++) if (s.indexOf(pf.inc[j]) !== -1) return true;
      return false;
    }
    return true;
  }

  // The range dropdown → a millisecond window counted back from NOW, so it always
  // means "the last 3h/24h/week/month up to this instant". 'all' = no cap.
  var RANGE_MS = { '3h': 3 * 3600e3, '24h': 24 * 3600e3, week: 7 * 864e5, month: 30 * 864e5 };

  function applyFilterSort() {
    var active = [];
    Object.keys(filters).forEach(function (k) {
      var pf = parseFilter(filters[k]);
      if (pf.inc.length || pf.exc.length) active.push([k, pf]);
    });
    var cutoff = RANGE_MS[range] ? Date.now() - RANGE_MS[range] : 0;
    var out = ALL.filter(function (r) {
      if (r.ts < cutoff) return false;
      for (var i = 0; i < active.length; i++) {
        if (!matchCell(cellText(r, active[i][0]), active[i][1])) return false;
      }
      return true;
    });
    out.sort(function (a, b) {
      var av, bv;
      if (sortCol === 'time') { av = a.ts; bv = b.ts; }
      else { av = cellText(a, sortCol); bv = cellText(b, sortCol);
        av = av == null ? '' : av; bv = bv == null ? '' : bv; }
      if (av < bv) return -1 * sortDir;
      if (av > bv) return 1 * sortDir;
      return 0;
    });
    return out;
  }

  function renderHead() {
    var h = '<tr>';
    COLS.forEach(function (c) {
      var ar = sortCol === c.k ? (sortDir === 1 ? '▲' : '▼') : '';
      h += '<th><div class="hd" data-sort="' + c.k + '">' + esc(c.label) + ' <span class="ar">' + ar + '</span></div>' +
        '<input data-f="' + c.k + '" placeholder="filter" value="' + esc(filters[c.k] || '') + '"></th>';
    });
    h += '</tr>';
    $('thead').innerHTML = h;
    $('thead').querySelectorAll('.hd').forEach(function (el) {
      el.addEventListener('click', function () {
        var k = el.getAttribute('data-sort');
        if (sortCol === k) sortDir = -sortDir; else { sortCol = k; sortDir = 1; }
        renderHead(); refresh();
      });
    });
    $('thead').querySelectorAll('input[data-f]').forEach(function (el) {
      el.addEventListener('input', function () {
        // Store the raw text (parseFilter handles trimming/case); refresh both
        // the chart and the table so the chart always mirrors what's shown.
        filters[el.getAttribute('data-f')] = el.value;
        refresh();
      });
    });
  }

  function renderBody(rows) {
    var MAXR = 3000, shown = rows.slice(0, MAXR);
    var body = shown.map(function (r) {
      return '<tr>' + COLS.map(function (c) {
        return '<td class="' + c.cls + '" title="' + esc(cellText(r, c.k) == null ? '' : cellText(r, c.k)) + '">' + cellHtml(r, c.k) + '</td>';
      }).join('') + '</tr>';
    }).join('');
    $('tbody').innerHTML = rows.length ? body : '<tr><td colspan="' + COLS.length + '" class="empty">No rows match the filters.</td></tr>';
    var extra = rows.length > MAXR ? ' (showing first ' + MAXR + ')' : '';
    $('rowcount').textContent = rows.length + ' of ' + ALL.length + ' rows' + extra;
    window._exportRows = rows;
  }

  function downloadCsv() {
    var rows = window._exportRows || ALL;
    var head = COLS.map(function (c) { return c.k; }).join(',');
    var lines = rows.map(function (r) {
      return COLS.map(function (c) {
        var v = cellText(r, c.k); v = v == null ? '' : String(v);
        return '"' + v.replace(/"/g, '""') + '"';
      }).join(',');
    });
    var blob = new Blob([head + '\\n' + lines.join('\\n')], { type: 'text/csv' });
    var a = document.createElement('a');
    a.href = URL.createObjectURL(blob);
    a.download = 'hhwi-hits.csv';
    a.click();
  }

  // One filtered/sorted set drives the chart, the chips and the table together.
  function refresh() {
    var rows = applyFilterSort();
    buildChart(rows);
    renderChips(rows);
    renderBody(rows);
  }

  function renderAll() {
    renderHead();
    refresh();
  }

  // ---- wiring ------------------------------------------------------------
  $('refresh').addEventListener('click', load);
  $('range').addEventListener('change', function () { range = this.value; refresh(); });
  $('clearf').addEventListener('click', function () { filters = {}; renderHead(); refresh(); });
  $('csv').addEventListener('click', downloadCsv);
  $('bucketseg').querySelectorAll('button').forEach(function (el) {
    el.addEventListener('click', function () {
      bucket = el.getAttribute('data-b');
      $('bucketseg').querySelectorAll('button').forEach(function (b) { b.classList.toggle('on', b === el); });
      refresh();
    });
  });

  load();
})();
</script>
</body>
</html>`;

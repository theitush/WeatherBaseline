// HowHotWasIt v2 server — thin tail-only "ensure-fresh" + static file serving.
//
// The heavy 99% of the timeline (the immutable archive) is served as static
// gzip files straight from disk/CDN — no server compute. The server's only job
// is ensure-fresh: top up the volatile recent/forecast tiers from Open-Meteo on
// demand. The old fetch-everything /api/archive + cacheManager model is retired.
const express = require('express');
const cors = require('cors');
const path = require('path');
const fs = require('fs');

const store = require('./cellStore');
const { ensureFresh } = require('./ensureFresh');

const app = express();
const PORT = process.env.PORT || 3000;

app.use(cors());
app.use(express.json());

// --- Tiered cell files: served static, gunzipped by the browser ------------
// The files are stored gzipped (archive_*.csv.gz). Express's static middleware
// would serve them with Content-Type application/gzip, which the browser would
// NOT auto-decompress. Set Content-Encoding: gzip + Content-Type text/csv so
// fetch() transparently gunzips. This path mirrors how R2/CDN will serve them.
app.use(
  '/data',
  express.static(store.DATA_ROOT, {
    setHeaders(res, filePath) {
      if (filePath.endsWith('.csv.gz')) {
        res.setHeader('Content-Type', 'text/csv; charset=utf-8');
        res.setHeader('Content-Encoding', 'gzip');
      }
    },
  })
);

// --- ensure-fresh: top up the volatile tiers for a cell --------------------
// The frontend calls this before reading the three files. Thresholds (12h/24h)
// live here so a later move to Option B is frontend-only.
app.get('/api/ensure-fresh', async (req, res) => {
  const lat = parseFloat(req.query.lat ?? req.query.latitude);
  const lon = parseFloat(req.query.lon ?? req.query.longitude);
  if (!Number.isFinite(lat) || !Number.isFinite(lon)) {
    return res.status(400).json({ error: 'lat and lon query params are required' });
  }
  try {
    const result = await ensureFresh(lat, lon);
    res.json(result);
  } catch (error) {
    console.error('ensure-fresh error:', error);
    res.status(502).json({
      error: 'Failed to refresh recent/forecast data',
      message: error.message,
    });
  }
});

// Health check.
app.get('/api/health', (_req, res) => {
  res.json({ status: 'ok', timestamp: new Date().toISOString() });
});

// --- Static frontend (React build / vanilla) -------------------------------
app.use(express.static(path.join(__dirname, '..')));
app.use(express.static(path.join(__dirname, '..', 'dist')));

app.get('/', (_req, res) => {
  const vanillaHtml = path.join(__dirname, '..', 'interactive_temperature.html');
  const reactHtml = path.join(__dirname, '..', 'dist', 'index.html');
  if (fs.existsSync(vanillaHtml)) {
    res.sendFile(vanillaHtml);
  } else if (fs.existsSync(reactHtml)) {
    res.sendFile(reactHtml);
  } else {
    res.status(404).send('No frontend found. Build the React app or add interactive_temperature.html.');
  }
});

// Catch-all for client-side routing.
app.get('*', (_req, res) => {
  const reactHtml = path.join(__dirname, '..', 'dist', 'index.html');
  if (fs.existsSync(reactHtml)) {
    res.sendFile(reactHtml);
  } else {
    res.status(404).send('React build not found. Run npm run build first.');
  }
});

app.listen(PORT, () => {
  console.log(`🌡️  HowHotWasIt v2 server on http://localhost:${PORT}`);
  console.log(`📂 Cell files: /data/{archive,recent,forecast}/*.csv.gz`);
  console.log(`🔄 Refresh endpoint: GET /api/ensure-fresh?lat=&lon=`);
});

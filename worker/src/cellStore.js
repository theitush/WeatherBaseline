// cellStore (Worker/R2 port) — v2 tiered storage, backed by an R2 binding.
//
// This is the R2 analogue of backend/cellStore.js. Same on-the-wire layout —
// keys are `{tier}/{tier}_{lat}_{lon}.csv.gz` so they match what the frontend
// fetches and what the producer / upload scripts write. The only differences
// from the Node version:
//
//   - reads/writes go through the R2 binding (env.BUCKET) instead of fs;
//   - freshness is the object's `uploaded` timestamp (R2's equivalent of mtime
//     / Last-Modified) instead of a stat() mtime;
//   - no atomic-rename dance: R2 put() is already atomic (a reader sees the
//     whole old or whole new object, never a partial one), so the temp-file +
//     rename trick the FS version needed is unnecessary here.
//
// Objects are stored gzip-compressed with the right Content-Type/Encoding so the
// public R2 URL serves them exactly like the local Express static route did:
// the browser auto-gunzips via Content-Encoding: gzip.

const TIERS = ['archive', 'recent', 'forecast'];

const SCHEMA = ['date', 'tmax_C', 'tmin_C', 'precip_mm', 'wind_max_ms'];

/** Snap a coordinate to the fixed 0.1° ERA5-Land grid: round(coord*10)/10. */
function snap(coord) {
  return Math.round(coord * 10) / 10;
}

/** Object key for a tier + snapped cell, e.g. archive/archive_32.8_35.1.csv.gz. */
function objectKey(tier, lat, lon) {
  const name = `${tier}_${snap(lat).toFixed(1)}_${snap(lon).toFixed(1)}.csv.gz`;
  return `${tier}/${name}`;
}

/**
 * Age in milliseconds of a tier object's last write, or Infinity if absent.
 * ensure-fresh compares this against its TTLs. We use R2's `uploaded` timestamp
 * (the analogue of the FS mtime the Node version used). head() is a Class B op
 * (cheap, 10M/mo free) and doesn't transfer the body.
 */
async function ageMs(bucket, tier, lat, lon) {
  const obj = await bucket.head(objectKey(tier, lat, lon));
  if (!obj) return Infinity;
  return Date.now() - obj.uploaded.getTime();
}

/**
 * Read a tier object into an array of row objects keyed by SCHEMA, or [] if the
 * object doesn't exist yet. The stored body is gzip; we decompress with the
 * runtime's DecompressionStream (no Node zlib in the Workers runtime).
 */
async function readRows(bucket, tier, lat, lon) {
  const obj = await bucket.get(objectKey(tier, lat, lon));
  if (!obj) return [];
  const text = await gunzipToText(obj.body);
  return parseCsv(text);
}

/**
 * Write rows to a tier object as gzip CSV. Rows are sorted by date and
 * serialized in SCHEMA column order. R2 put() is atomic, so no temp/rename.
 * Sets Content-Type/Encoding so the public URL serves a browser-gunzippable
 * file (mirrors the Express static setHeaders in backend/server.js).
 */
async function writeRows(bucket, tier, lat, lon, rows) {
  const sorted = [...rows].sort((a, b) => a.date.localeCompare(b.date));
  const gz = await gzipText(serializeCsv(sorted));
  await bucket.put(objectKey(tier, lat, lon), gz, {
    httpMetadata: {
      contentType: 'text/csv; charset=utf-8',
      contentEncoding: 'gzip',
    },
  });
}

/**
 * Merge new rows into an existing tier object by date, last-wins, then write.
 * Used by the recent tier's append-only refresh: an overlapping re-run is
 * idempotent and a skipped run self-heals on the next call.
 */
async function mergeRows(bucket, tier, lat, lon, newRows) {
  const existing = await readRows(bucket, tier, lat, lon);
  const byDate = new Map();
  for (const r of existing) byDate.set(r.date, r);
  for (const r of newRows) byDate.set(r.date, r); // last-wins
  await writeRows(bucket, tier, lat, lon, [...byDate.values()]);
}

// --- gzip helpers (Workers runtime: Compression/DecompressionStream) --------

async function gzipText(text) {
  const cs = new CompressionStream('gzip');
  const stream = new Response(text).body.pipeThrough(cs);
  return new Uint8Array(await new Response(stream).arrayBuffer());
}

async function gunzipToText(body) {
  const ds = new DecompressionStream('gzip');
  const stream = body.pipeThrough(ds);
  return new Response(stream).text();
}

// --- CSV helpers (no quoting needed: all fields are dates/numbers) ----------
// Verbatim from backend/cellStore.js so the two stores stay format-identical.

function parseCsv(text) {
  const lines = text.trim().split('\n');
  if (lines.length <= 1) return [];
  const header = lines[0].split(',');
  return lines.slice(1).map((line) => {
    const cells = line.split(',');
    const row = {};
    header.forEach((col, i) => {
      row[col] = cells[i];
    });
    return row;
  });
}

function serializeCsv(rows) {
  const out = [SCHEMA.join(',')];
  for (const r of rows) {
    out.push(SCHEMA.map((col) => (r[col] ?? '')).join(','));
  }
  return out.join('\n') + '\n';
}

export {
  TIERS,
  SCHEMA,
  snap,
  objectKey,
  ageMs,
  readRows,
  writeRows,
  mergeRows,
};

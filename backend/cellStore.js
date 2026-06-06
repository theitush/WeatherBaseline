// cellStore — v2 tiered storage for per-cell weather files.
//
// Each location maps to one 0.1° ERA5-Land grid cell, snapped via
// round(coord*10)/10 (matching the weather_hist_{lat}_{lon} convention).
// Per cell, three gzip CSVs live under DATA_ROOT:
//
//   archive/  archive_{lat}_{lon}.csv.gz   immutable; built by the pipeline
//   recent/   recent_{lat}_{lon}.csv.gz    append-only; refreshed ~daily
//   forecast/ forecast_{lat}_{lon}.csv.gz  rewritten; refreshed ~12h
//
// Schema (all tiers): date,tmax_C,tmin_C,precip_mm,wind_max_ms
//
// This module is the single place that knows the on-disk layout, so the write
// target can later swap to R2 by replacing the read/write/stat helpers without
// touching the ensure-fresh logic. The directory tree intentionally mirrors the
// three-files-per-cell R2 keying in ARCHITECTURE.md.
const fs = require('fs').promises;
const path = require('path');
const zlib = require('zlib');
const { promisify } = require('util');

const gzip = promisify(zlib.gzip);
const gunzip = promisify(zlib.gunzip);

// Root of the tiered file tree. Mirrors the producer's output dir.
const DATA_ROOT = path.join(__dirname, '..', 'data', 'era5-land');

const TIERS = ['archive', 'recent', 'forecast'];

const SCHEMA = ['date', 'tmax_C', 'tmin_C', 'precip_mm', 'wind_max_ms'];

/**
 * Snap a coordinate to the fixed 0.1° ERA5-Land grid: round(coord*10)/10.
 * Returns a number with at most one decimal (e.g. 32.84 -> 32.8).
 */
function snap(coord) {
  return Math.round(coord * 10) / 10;
}

/**
 * Filename for a tier + snapped cell, e.g. archive_32.8_35.1.csv.gz.
 * Coordinates are formatted to exactly one decimal so they match the snapped
 * grid and the producer's archive_name().
 */
function fileName(tier, lat, lon) {
  return `${tier}_${snap(lat).toFixed(1)}_${snap(lon).toFixed(1)}.csv.gz`;
}

function filePath(tier, lat, lon) {
  return path.join(DATA_ROOT, tier, fileName(tier, lat, lon));
}

/**
 * Age in milliseconds of a tier file's last write, or Infinity if absent.
 * This is the freshness signal ensure-fresh compares against its TTLs — locally
 * it's the file mtime; against R2 it would be the Last-Modified header.
 */
async function ageMs(tier, lat, lon) {
  try {
    const st = await fs.stat(filePath(tier, lat, lon));
    return Date.now() - st.mtimeMs;
  } catch (err) {
    if (err.code === 'ENOENT') return Infinity;
    throw err;
  }
}

/**
 * Read a tier file into an array of row objects keyed by SCHEMA, or [] if the
 * file doesn't exist yet. Gunzips transparently.
 */
async function readRows(tier, lat, lon) {
  let buf;
  try {
    buf = await fs.readFile(filePath(tier, lat, lon));
  } catch (err) {
    if (err.code === 'ENOENT') return [];
    throw err;
  }
  const text = (await gunzip(buf)).toString('utf8');
  return parseCsv(text);
}

/**
 * Write rows to a tier file as gzip CSV (creating the tier dir if needed).
 * Rows are sorted by date and serialized in SCHEMA column order.
 *
 * Written atomically: a refresh rewrites the file while the static server may
 * be serving it to a client that just called ensure-fresh. fs.writeFile to the
 * live path is non-atomic, so a concurrent reader could see a truncated file or
 * the pre-write version mid-rewrite (observed as the recent/forecast seam
 * briefly rendering the forecast guess where settled recent data already
 * exists). We write a temp file in the same dir, then rename() onto the target
 * — rename is atomic on POSIX, so readers always see the whole old or whole new
 * file, never a partial one.
 */
async function writeRows(tier, lat, lon, rows) {
  const dir = path.join(DATA_ROOT, tier);
  await fs.mkdir(dir, { recursive: true });
  const sorted = [...rows].sort((a, b) => a.date.localeCompare(b.date));
  const gz = await gzip(serializeCsv(sorted));
  const target = filePath(tier, lat, lon);
  // Unique temp name in the same dir (same filesystem ⇒ rename is atomic).
  const tmp = `${target}.tmp-${process.pid}-${Date.now()}`;
  try {
    await fs.writeFile(tmp, gz);
    await fs.rename(tmp, target);
  } catch (err) {
    // Don't leave a stray temp file behind if the write/rename failed.
    await fs.unlink(tmp).catch(() => {});
    throw err;
  }
}

/**
 * Merge new rows into an existing tier file by date, last-wins, then write.
 * Used by the recent tier's append-only refresh: a re-run for an overlapping
 * date range is idempotent, and a skipped run self-heals on the next call.
 */
async function mergeRows(tier, lat, lon, newRows) {
  const existing = await readRows(tier, lat, lon);
  const byDate = new Map();
  for (const r of existing) byDate.set(r.date, r);
  for (const r of newRows) byDate.set(r.date, r); // last-wins
  await writeRows(tier, lat, lon, [...byDate.values()]);
}

// --- CSV helpers (no quoting needed: all fields are dates/numbers) ----------

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
  const lines = [SCHEMA.join(',')];
  for (const r of rows) {
    lines.push(SCHEMA.map((col) => (r[col] ?? '')).join(','));
  }
  return lines.join('\n') + '\n';
}

module.exports = {
  DATA_ROOT,
  TIERS,
  SCHEMA,
  snap,
  fileName,
  filePath,
  ageMs,
  readRows,
  writeRows,
  mergeRows,
};

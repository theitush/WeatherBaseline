// ci — client-side bias correction from static per-cell R2 tables.
//
// Replaces the old dev-only POST to `scripts/bias_study/ci_server.py`. The site
// serves raw HRES-derived values for forecast/recent days while the archive (and
// all percentile math) is on the ERA5-Land scale; the M3_base fits correct that
// mismatch. Those fits are ~1 GB — never Worker-runnable — so we bake them into
// static per-cell tables on R2 (`{DEBIAS_PREFIX}/debias_{lat}_{lon}.csv.gz`, one
// gzip of `var,doy,hres,d01,dlo,d10,d25,dmid,d75,d90,dhi,d99` deltas on a
// doy×hres grid — a full per-level one-sided CQR-calibrated 9-quantile CDF, at
// levels .01/.05/.10/.25/.50/.75/.90/.95/.99). Here we fetch that table and
// bilinearly interpolate the delta for each (date, forecast value), returning a
// corrected quantile set per (date, metric). All nine heads are TRAINED — the
// .25/.75 shoulders used to be interpolated client-side by a probit split-normal
// rule; they got real heads in the q9 retrain. A table predating it (7 columns,
// no d25/d75) still parses: buildTable falls back to that probit rule, so one
// bundle serves both table generations.
//
// A missing table, a 404, or a var absent from the table (gated at generation
// time because the correction demonstrably hurt that cell) yields no band and the
// raw value flows through unchanged — exactly the old no-op behaviour. Works the
// same in dev and prod: both read live R2 via VITE_DATA_BASE (house rule).
// (The retired dev-only Python CI server this replaced is preserved in git
// history; the comments below cite its math for lineage.)
//
// TIER-AGNOSTIC: this module returns a band for every (date, value) it is handed,
// for whatever metrics are present — it does NOT know forecast vs recent. That
// split matters: in the `recent` tier, precip AND wind are STILL IFS-HRES forecast
// (ERA5-Land lags the frontier) so they carry forecast bias and MUST be corrected,
// while recent TEMPERATURE is settled ERA5-Land and must NOT be. The caller
// (AppContext, via RECENT_MODEL_METRICS) enforces that recent-temperature exception.
import type { MetricKey, MetricBand } from '../types';
import { DATA_BASE, snap, parseCsv } from './tieredData';

/** One forecast day's values, in native units, keyed as the metric fields. */
export interface BandRequestRow {
  date: string; // YYYY-MM-DD (local calendar day)
  max_temperature?: number;
  min_temperature?: number;
  precipitation_sum?: number;
  wind_speed_10m_max?: number;
}

export type BandsByDate = Record<string, Partial<Record<MetricKey, MetricBand>>>;

// front-end metric key -> (table var name, non-negative metric). Mirrors
// ci_server.py METRICS and make_debias_tables.py var names.
const METRICS: { key: MetricKey; var: string; nonneg: boolean }[] = [
  { key: 'max_temperature', var: 'tmax', nonneg: false },
  { key: 'min_temperature', var: 'tmin', nonneg: false },
  { key: 'precipitation_sum', var: 'precip', nonneg: true },
  { key: 'wind_speed_10m_max', var: 'wind', nonneg: true },
];

// Below this, a day's precipitation counts as 0 — the same trace clamp applied at
// training time and at ingestion (tieredData.ts). The delta is looked up, and the
// corrected value computed, at the clamped value (matches ci_server.predict_bands).
const PRECIP_TRACE_MM = 1;

// Probit (split-normal) interior weight z(.75)/z(.90) — the 7-level-table
// fallback for q25/q75 (see buildTable). Kept alongside the trained-head path
// so one bundle serves both table generations.
const PROBIT_Q25_Q75_W = 0.526307;

/** Positive modulo (JS `%` keeps the sign of the dividend; Python's does not). */
const mod = (n: number, m: number): number => ((n % m) + m) % m;

/** One grid delta 9-tuple for a (doy, hres) anchor — the full CQR-calibrated
 *  quantile set at levels .01/.05/.10/.25/.50/.75/.90/.95/.99. */
interface Delta {
  d01: number;
  dlo: number;
  d10: number;
  d25: number;
  dmid: number;
  d75: number;
  d90: number;
  dhi: number;
  d99: number;
}

/** One variable's baked surface: sorted anchor axes + a point lookup. */
interface VarGrid {
  doyAnchors: number[]; // sorted weekly anchors (1, 8, …, 365); client wraps circularly
  hresAnchors: number[]; // sorted forecast-value anchors spanning the cell's training range
  points: Map<string, Delta>; // `${doy}|${hres}` -> delta
}

/** A cell's full table: var name -> its grid (absent var = gated -> serve raw). */
type CellTable = Map<string, VarGrid>;

const pointKey = (doy: number, hres: number): string => `${doy}|${hres}`;

/** Day-of-year (1..366) for a `YYYY-MM-DD` local date, matching pandas dayofyear. */
function dayOfYear(dateStr: string): number {
  const [y, m, d] = dateStr.split('-').map(Number);
  return Math.round((Date.UTC(y, m - 1, d) - Date.UTC(y, 0, 1)) / 86400000) + 1;
}

// R2 key prefix holding the tables — THE production pointer. The prefix is
// versioned: a regenerated table set (retrain, IFS cycle cutover, cells.csv
// change) is uploaded under a NEW `debias-vN/` prefix (r2_upload.DEBIAS_TIERS)
// and promoted by changing this one default, so shipping and rolling back are
// both a frontend redeploy — the live set on R2 is never rewritten, no edge
// purge, no mixed-schema window (the retired 7-level set stays at `debias/`).
// The env override exists ONLY to exercise a not-yet-promoted prefix against
// live R2 from a local dev server; leave it unset for every real build.
//   debias     7-level qn8727_s0 (2026-07-05 → 2026-08-28)
//   debias-v9  9-level qn8620_s0_q9 (2026-08-26 bake)
const DEBIAS_PREFIX = import.meta.env.VITE_DEBIAS_PREFIX ?? 'debias-v9';

/** URL of a cell's debias table, mirroring tieredData.fileUrl conventions. */
function debiasUrl(lat: number, lon: number): string {
  const name = `debias_${snap(lat).toFixed(1)}_${snap(lon).toFixed(1)}.csv.gz`;
  const prefix = DATA_BASE ? '' : '/data';
  return `${DATA_BASE}${prefix}/${DEBIAS_PREFIX}/${name}`;
}

/** Parse the flat CSV rows into per-var grids. Returns null for an empty table. */
function buildTable(rows: Record<string, string>[]): CellTable | null {
  if (rows.length === 0) return null;
  const table: CellTable = new Map();
  const doySets = new Map<string, Set<number>>();
  const hresSets = new Map<string, Set<number>>();
  for (const row of rows) {
    const v = row.var;
    if (!v) continue;
    let grid = table.get(v);
    if (!grid) {
      grid = { doyAnchors: [], hresAnchors: [], points: new Map() };
      table.set(v, grid);
      doySets.set(v, new Set());
      hresSets.set(v, new Set());
    }
    const doy = parseInt(row.doy, 10);
    const hres = parseFloat(row.hres);
    doySets.get(v)!.add(doy);
    hresSets.get(v)!.add(hres);
    const d10 = parseFloat(row.d10);
    const dmid = parseFloat(row.dmid);
    const d90 = parseFloat(row.d90);
    grid.points.set(pointKey(doy, hres), {
      d01: parseFloat(row.d01),
      dlo: parseFloat(row.dlo),
      d10,
      // Tables from before the 9-level retrain (the retired `debias/` set)
      // have no d25/d75. Fall back to the probit shoulder rule the 7-level
      // bundle always used: interior weight z(.75)/z(.90) =
      // 0.526307 places q25/q75 on the Φ⁻¹(τ)-linear CDF the .10/.50/.90
      // anchors define (validated ≤1.7pp, q25_q75_interp_check.ipynb). The
      // hres base cancels, so the same relation holds on deltas. Parsing the
      // missing columns unguarded turned every band NaN (prod 2026-08-25).
      d25: row.d25 !== undefined ? parseFloat(row.d25)
        : dmid - PROBIT_Q25_Q75_W * (dmid - d10),
      dmid,
      d75: row.d75 !== undefined ? parseFloat(row.d75)
        : dmid + PROBIT_Q25_Q75_W * (d90 - dmid),
      d90,
      dhi: parseFloat(row.dhi),
      d99: parseFloat(row.d99),
    });
  }
  for (const [v, grid] of table) {
    grid.doyAnchors = [...doySets.get(v)!].sort((a, b) => a - b);
    grid.hresAnchors = [...hresSets.get(v)!].sort((a, b) => a - b);
  }
  return table;
}

/**
 * Bilinear lookup mirroring make_debias_tables.circular_interp: circular-linear
 * across the two straddling doy anchors × linear across the two straddling hres
 * anchors, clamping the hres query into the grid range.
 */
function interp(grid: VarGrid, doy: number, hres: number, field: keyof Delta): number {
  const { doyAnchors, hresAnchors, points } = grid;

  // straddling hres anchors (clamp into range: trees are constant beyond splits)
  const last = hresAnchors.length - 1;
  const clamped = Math.min(Math.max(hres, hresAnchors[0]), hresAnchors[last]);
  let hi = hresAnchors.findIndex((a) => a >= clamped); // searchsorted 'left'
  if (hi < 0) hi = last;
  const lo = Math.max(hi - 1, 0);
  const h0 = hresAnchors[lo];
  const h1 = hresAnchors[hi];
  const tw = h1 === h0 ? 0 : (clamped - h0) / (h1 - h0);

  // straddling doy anchors on the 1..365 circle
  let below = -Infinity;
  let above = Infinity;
  for (const d of doyAnchors) {
    if (d <= doy && d > below) below = d;
    if (d >= doy && d < above) above = d;
  }
  const d0 = Number.isFinite(below) ? below : doyAnchors[doyAnchors.length - 1];
  const d1 = Number.isFinite(above) ? above : doyAnchors[0];
  const span = mod(d1 - d0, 365) || 1;
  const dw = mod(doy - d0, 365) / span;

  const at = (d: number, h: number) => points.get(pointKey(d, h))![field];
  const c00 = at(d0, h0);
  const c01 = at(d0, h1);
  const c10 = at(d1, h0);
  const c11 = at(d1, h1);
  return (1 - dw) * ((1 - tw) * c00 + tw * c01) + dw * ((1 - tw) * c10 + tw * c11);
}

// Cache the parsed table per snapped cell for the session (like the archive
// cache): a cell's debias surface is immutable within a session, so re-parsing it
// on every date/metric change is waste. A miss (404 / network / empty) is dropped
// so a later load retries.
const tableCache = new Map<string, Promise<CellTable | null>>();

async function loadTable(lat: number, lon: number): Promise<CellTable | null> {
  const key = `${snap(lat).toFixed(1)},${snap(lon).toFixed(1)}`;
  const cached = tableCache.get(key);
  if (cached) return cached;

  const p = (async () => {
    try {
      const res = await fetch(debiasUrl(lat, lon), { headers: { Accept: 'text/csv' } });
      if (!res.ok) return null; // 404 (gated/absent cell) or error -> raw values
      return buildTable(parseCsv(await res.text()));
    } catch {
      return null; // network error -> degrade to raw, no band
    }
  })();

  tableCache.set(key, p);
  p.then((t) => {
    if (!t) tableCache.delete(key);
  });
  return p;
}

const round3 = (x: number): number => Math.round(x * 1000) / 1000;

/**
 * Fetch bias-corrected bands for a cell's forecast rows. Returns {} when the cell
 * has no debias table (or on any error) — callers treat an empty map as "no
 * bands" and render exactly as before. A var missing from the table (gated) is
 * simply skipped, leaving that metric's raw value untouched.
 */
export async function fetchBands(
  lat: number,
  lon: number,
  rows: BandRequestRow[]
): Promise<BandsByDate> {
  if (rows.length === 0) return {};
  const table = await loadTable(lat, lon);
  if (!table) return {};

  const out: BandsByDate = {};
  for (const row of rows) {
    const doy = dayOfYear(row.date);
    const perMetric: Partial<Record<MetricKey, MetricBand>> = {};
    for (const { key, var: varName, nonneg } of METRICS) {
      const raw = row[key];
      if (raw == null || !Number.isFinite(raw)) continue;
      const grid = table.get(varName);
      if (!grid) continue; // gated/absent var -> no band, raw value flows through

      // Look up the delta at (and add it to) the trace-clamped value, exactly as
      // ci_server.predict_bands / the training pipeline do for precip.
      const base = varName === 'precip' && raw < PRECIP_TRACE_MM ? 0 : raw;
      let q01 = base + interp(grid, doy, base, 'd01');
      let lo = base + interp(grid, doy, base, 'dlo');
      let q10 = base + interp(grid, doy, base, 'd10');
      let q25 = base + interp(grid, doy, base, 'd25');
      let mid = base + interp(grid, doy, base, 'dmid');
      let q75 = base + interp(grid, doy, base, 'd75');
      let q90 = base + interp(grid, doy, base, 'd90');
      let hi = base + interp(grid, doy, base, 'dhi');
      let q99 = base + interp(grid, doy, base, 'd99');
      if (nonneg) {
        q01 = Math.max(0, q01);
        lo = Math.max(0, lo);
        q10 = Math.max(0, q10);
        q25 = Math.max(0, q25);
        mid = Math.max(0, mid);
        q75 = Math.max(0, q75);
        q90 = Math.max(0, q90);
        hi = Math.max(0, hi);
        q99 = Math.max(0, q99);
      }
      perMetric[key] = {
        q01: round3(q01),
        lo: round3(lo),
        q10: round3(q10),
        q25: round3(q25),
        mid: round3(mid),
        q75: round3(q75),
        q90: round3(q90),
        hi: round3(hi),
        q99: round3(q99),
      };
    }
    if (Object.keys(perMetric).length > 0) out[row.date] = perMetric;
  }
  return out;
}

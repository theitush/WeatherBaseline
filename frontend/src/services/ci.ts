// ci — dev-only client for the local CatBoost confidence-interval server
// (`scripts/bias_study/ci_server.py`). Given a cell's forecast rows (values we
// already fetched from R2), it returns a bias-corrected 90% band per (date,
// metric). Disabled in production builds and a graceful no-op when the local
// server isn't running, so it never affects the page.
import type { MetricKey, MetricBand } from '../types';

// In dev, talk to the local Python server on :8800 with zero config (no .env
// change, so Vite needn't restart). VITE_CI_BASE overrides; prod builds get ''
// (disabled). Run the server with: python scripts/bias_study/ci_server.py
const CI_BASE: string =
  (import.meta.env.VITE_CI_BASE as string | undefined) ??
  (import.meta.env.DEV ? 'http://localhost:8800' : '');

/** One forecast day's values, in native units, keyed as the metric fields. */
export interface BandRequestRow {
  date: string; // YYYY-MM-DD (local calendar day)
  max_temperature?: number;
  min_temperature?: number;
  precipitation_sum?: number;
  wind_speed_10m_max?: number;
}

export type BandsByDate = Record<string, Partial<Record<MetricKey, MetricBand>>>;

/**
 * Fetch bias-corrected bands for a cell's forecast rows. Returns {} when the CI
 * server is disabled, unreachable, or slow — callers should treat an empty map
 * as "no bands" and render exactly as before.
 */
export async function fetchBands(
  lat: number,
  lon: number,
  rows: BandRequestRow[]
): Promise<BandsByDate> {
  if (!CI_BASE || rows.length === 0) return {};
  const ctrl = new AbortController();
  const timer = setTimeout(() => ctrl.abort(), 4000);
  try {
    const res = await fetch(`${CI_BASE}/ci`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ lat, lon, rows }),
      signal: ctrl.signal,
    });
    if (!res.ok) return {};
    const json = (await res.json()) as { bands?: BandsByDate };
    return json.bands ?? {};
  } catch {
    return {}; // server down / aborted / network — silently skip the band
  } finally {
    clearTimeout(timer);
  }
}

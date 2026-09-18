// The `.ts` specifiers are load-bearing, not a style: eras.ts (which imports
// this) is loaded by the compare page's tests through
// `node --experimental-strip-types`, which resolves ESM specifiers literally.
import type { MetricKey } from './config.ts';
import type { ThemeMode } from './eras.ts';

/**
 * A LOCAL tuning store for the era ramps (#73), not a product setting.
 *
 * Ita picks the three era shades per metric per theme by eye in the browser —
 * 4 metrics × 3 eras × 2 themes = 24 colours — and `eraColor` consults this
 * before its built-in ramps, so every consumer (main chart washes and boundary
 * lines, histogram overlays, period histograms, legend, the compare dials'
 * defaults) follows without being touched. When he likes what he sees the
 * picker's "copy as code" hands back the literal `eras.ts` holds, that gets
 * pasted in as the new default, and the store is reset — the overrides are the
 * scaffolding, the committed ramp is the building.
 *
 * Flat `metric:theme:era` keys rather than a nested object: it is what
 * localStorage round-trips, what merges partially without a deep merge, and
 * what a malformed entry can be dropped from one at a time.
 */
const STORAGE_KEY = 'eraColorOverrides';

/** `#rrggbb`, the only thing `<input type="color">` ever produces. Anything
 *  else in storage (hand-edited, or from a future shape) is dropped rather
 *  than handed to d3 as a colour. */
const HEX = /^#[0-9a-fA-F]{6}$/;

export type EraColorOverrides = Readonly<Record<string, string>>;

export function eraColorKey(metric: MetricKey, theme: ThemeMode, era: number): string {
  return `${metric}:${theme}:${era}`;
}

/** The current overrides. Replaced wholesale on every change, never mutated, so
 *  it is a valid `useSyncExternalStore` snapshot: identity changes exactly when
 *  the contents do. */
let snapshot: EraColorOverrides | null = null;

const listeners = new Set<() => void>();

function readStorage(): Record<string, string> {
  const out: Record<string, string> = {};
  try {
    if (typeof localStorage === 'undefined') return out;
    const raw = localStorage.getItem(STORAGE_KEY);
    if (!raw) return out;
    const parsed: unknown = JSON.parse(raw);
    if (!parsed || typeof parsed !== 'object') return out;
    for (const [k, v] of Object.entries(parsed as Record<string, unknown>)) {
      if (typeof v === 'string' && HEX.test(v)) out[k] = v.toLowerCase();
    }
  } catch {
    /* private mode, blocked storage, garbage JSON — no overrides, not a crash */
  }
  return out;
}

function writeStorage(next: EraColorOverrides): void {
  try {
    if (typeof localStorage === 'undefined') return;
    if (Object.keys(next).length === 0) localStorage.removeItem(STORAGE_KEY);
    else localStorage.setItem(STORAGE_KEY, JSON.stringify(next));
  } catch {
    /* ignore — the in-memory store still drives this session's charts */
  }
}

function commit(next: EraColorOverrides): void {
  snapshot = next;
  writeStorage(next);
  for (const fn of listeners) fn();
}

/** The whole store, as a stable object. */
export function eraColorOverrides(): EraColorOverrides {
  if (snapshot === null) snapshot = readStorage();
  return snapshot;
}

/** One override, or undefined when that swatch is still the built-in ramp's. */
export function eraColorOverride(
  metric: MetricKey,
  theme: ThemeMode,
  era: number
): string | undefined {
  return eraColorOverrides()[eraColorKey(metric, theme, era)];
}

/** Set one swatch; `null` puts it back on the built-in ramp. */
export function setEraColorOverride(
  metric: MetricKey,
  theme: ThemeMode,
  era: number,
  color: string | null
): void {
  const key = eraColorKey(metric, theme, era);
  const current = eraColorOverrides();
  if (color === null) {
    if (!(key in current)) return;
    const next = { ...current };
    delete next[key];
    commit(next);
    return;
  }
  if (!HEX.test(color)) return;
  const value = color.toLowerCase();
  if (current[key] === value) return;
  commit({ ...current, [key]: value });
}

/** Back to the ramps `eras.ts` ships with — all 24 at once. */
export function clearEraColorOverrides(): void {
  if (Object.keys(eraColorOverrides()).length === 0) return;
  commit({});
}

export function subscribeEraColorOverrides(onChange: () => void): () => void {
  listeners.add(onChange);
  return () => {
    listeners.delete(onChange);
  };
}

/**
 * Re-read localStorage and tell every subscriber. The picker never needs this —
 * it writes through the setters — but setting the key from the devtools console
 * (or a headless screenshot script) is how the store gets driven when poking a
 * native colour input is awkward, and this is how that reaches the charts
 * without a reload.
 */
export function reloadEraColorOverrides(): void {
  commit(readStorage());
}

declare global {
  interface Window {
    /** Exposed for console/headless tuning; see reloadEraColorOverrides. */
    __eraColors?: {
      set: (metric: MetricKey, theme: ThemeMode, era: number, color: string | null) => void;
      clear: () => void;
      reload: () => void;
      all: () => EraColorOverrides;
    };
  }
}

if (typeof window !== 'undefined') {
  window.__eraColors = {
    set: setEraColorOverride,
    clear: clearEraColorOverrides,
    reload: reloadEraColorOverrides,
    all: eraColorOverrides,
  };
}

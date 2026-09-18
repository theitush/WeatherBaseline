import React, { useMemo, useRef, useState } from 'react';
import {
  DEFAULT_ERA_RAMPS,
  ERA_RAMP_METRICS,
  eraColor,
  eraRampsSource,
  eraSplit,
  MIDPOINT_YEAR,
  SATELLITE_YEAR,
  type Era,
  type ThemeMode,
} from '../utils/eras';
import {
  clearEraColorOverrides,
  eraColorKey,
  setEraColorOverride,
} from '../utils/eraColorOverrides';
import { useEraColorOverrides } from '../hooks/useEraColors';
import type { MetricKey } from '../utils/config';
import './EraColorPicker.css';

const METRIC_LABELS: Record<MetricKey, string> = {
  max_temperature: 'Max temp',
  min_temperature: 'Min temp',
  precipitation_sum: 'Precipitation',
  wind_speed_10m_max: 'Wind',
};

/**
 * The era-colour tuning panel (#73) — a local tool, not shipped UI.
 *
 * 4 metrics × 3 eras × 2 themes = 24 native colour inputs. Every edit goes
 * straight into the override store, which `eraColor` reads, so the chart behind
 * the panel repaints as the picker is dragged; "Copy as code" hands back the
 * `ERA_RAMPS` literal `eras.ts` holds so a liked palette becomes the default in
 * one paste.
 *
 * It edits the RAMP, which is what both era styles ink from — shade fills and
 * outlines with it, contour outlines with it over a shared metric-base wash —
 * so there is nothing per-style to pick: one set of 24 covers both.
 */
const EraColorPicker: React.FC<{
  /** The eras on screen, for honest year-range headers; a generic 1950–now
   *  split stands in before any data has loaded. */
  eras?: Era[];
  /** The theme being painted — which column the panel opens on. */
  theme: ThemeMode;
  onClose: () => void;
}> = ({ eras, theme, onClose }) => {
  const overrides = useEraColorOverrides();
  const [tab, setTab] = useState<ThemeMode>(theme);
  const [copied, setCopied] = useState(false);
  const snippetRef = useRef<HTMLTextAreaElement>(null);

  const labels = useMemo(() => {
    const src =
      eras && eras.length === 3
        ? eras
        : eraSplit(1950, Math.max(MIDPOINT_YEAR, new Date().getFullYear()));
    return src.map((e) => e.label);
  }, [eras]);

  // Recomputed every render, which is every store change: the snippet always
  // shows what the swatches show.
  const snippet = eraRampsSource();
  const overrideCount = Object.keys(overrides).length;

  const copy = () => {
    const done = () => {
      setCopied(true);
      window.setTimeout(() => setCopied(false), 1600);
    };
    navigator.clipboard?.writeText(snippet).then(done, () => {
      // Clipboard blocked (insecure origin, permissions): select the textarea so
      // it is one ⌘C away instead of leaving the button dead.
      snippetRef.current?.select();
    });
  };

  return (
    <div className="era-picker" role="dialog" aria-label="Era colours">
      <div className="era-picker-head">
        <span className="era-picker-title">Era colours</span>
        <div className="era-picker-tabs" role="tablist" aria-label="Theme">
          {(['light', 'dark'] as ThemeMode[]).map((t) => (
            <button
              key={t}
              type="button"
              role="tab"
              aria-selected={tab === t}
              className={`era-picker-tab${tab === t ? ' is-on' : ''}`}
              onClick={() => setTab(t)}
            >
              {t === 'light' ? 'Light' : 'Dark'}
              {t === theme ? ' •' : ''}
            </button>
          ))}
        </div>
        <button
          type="button"
          className="era-picker-close"
          onClick={onClose}
          aria-label="Close era colours"
        >
          ×
        </button>
      </div>

      <div className="era-picker-grid">
        <div className="era-picker-row era-picker-header">
          <span className="era-picker-metric" />
          {labels.map((l) => (
            <span key={l} className="era-picker-era">
              {l}
            </span>
          ))}
        </div>
        {ERA_RAMP_METRICS.map((metric) => (
          <div className="era-picker-row" key={metric}>
            <span className="era-picker-metric">{METRIC_LABELS[metric]}</span>
            {[0, 1, 2].map((era) => {
              const value = eraColor(metric, era, tab);
              const isOverride = eraColorKey(metric, tab, era) in overrides;
              return (
                <span className="era-picker-cell" key={era}>
                  <input
                    type="color"
                    value={value}
                    aria-label={`${METRIC_LABELS[metric]}, ${labels[era]}, ${tab} mode`}
                    title={`${METRIC_LABELS[metric]} · ${labels[era]} · ${tab}`}
                    onChange={(e) =>
                      setEraColorOverride(metric, tab, era, e.target.value)
                    }
                  />
                  <code className={isOverride ? 'is-override' : undefined}>{value}</code>
                  {isOverride && (
                    <button
                      type="button"
                      className="era-picker-revert"
                      title={`Back to ${DEFAULT_ERA_RAMPS[metric][tab][era]}`}
                      aria-label={`Revert ${METRIC_LABELS[metric]} ${labels[era]} ${tab}`}
                      onClick={() => setEraColorOverride(metric, tab, era, null)}
                    >
                      ↺
                    </button>
                  )}
                </span>
              );
            })}
          </div>
        ))}
      </div>

      <p className="era-picker-note">
        {overrideCount === 0
          ? 'Showing the committed ramps. Both era styles (shade and contour) ink from these.'
          : `${overrideCount} of 24 swatches overridden — held in this browser until reset.`}
      </p>

      <div className="era-picker-actions">
        <button
          type="button"
          className="era-picker-btn"
          onClick={clearEraColorOverrides}
          disabled={overrideCount === 0}
        >
          Reset to defaults
        </button>
        <button type="button" className="era-picker-btn is-primary" onClick={copy}>
          {copied ? 'Copied ✓' : 'Copy as code'}
        </button>
      </div>

      <textarea
        ref={snippetRef}
        className="era-picker-snippet"
        readOnly
        value={snippet}
        spellCheck={false}
        aria-label="ERA_RAMPS source to paste into eras.ts"
        onFocus={(e) => e.currentTarget.select()}
      />
      <p className="era-picker-note">
        Paste that over the <code>ERA_RAMPS</code> block in{' '}
        <code>utils/eras.ts</code> — the eras cut at {SATELLITE_YEAR} and{' '}
        {MIDPOINT_YEAR}, so those are the three columns above.
      </p>
    </div>
  );
};

export default EraColorPicker;

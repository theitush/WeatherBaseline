import React from 'react';
import LocationSelector from '../components/LocationSelector';
import type { MetricKey } from '../utils/config';
import type { Series, SeriesData, DateMarker } from './compareTypes';
import {
  MARKER_PALETTE,
  SERIES_PALETTE,
  SMOOTH_OPTIONS,
  SPLIT_DEFAULT_SMOOTH,
  canSplit,
  seriesPeriods,
} from './compareTypes';

const METRIC_LABELS: Record<MetricKey, string> = {
  max_temperature: 'Max Temp',
  min_temperature: 'Min Temp',
  precipitation_sum: 'Precip',
  wind_speed_10m_max: 'Wind',
};
const METRICS = Object.keys(METRIC_LABELS) as MetricKey[];

const MIN_YEAR = 1950;
const MAX_YEAR = new Date().getFullYear();

let markerSeq = 0;
const nextMarkerId = () => `m${Date.now()}_${markerSeq++}`;

interface SeriesEditorProps {
  series: Series;
  data: SeriesData | undefined;
  index: number;
  canRemove: boolean;
  onChange: (s: Series) => void;
  onRemove: () => void;
}

/** Color input + palette swatches, used for the series color and each half. */
const ColorPicker: React.FC<{
  value: string;
  label: string;
  onChange: (c: string) => void;
}> = ({ value, label, onChange }) => (
  <div className="cmp-series-color">
    <input
      type="color"
      value={value}
      onChange={(e) => onChange(e.target.value)}
      aria-label={label}
      title={label}
    />
    <div className="cmp-swatch-row">
      {SERIES_PALETTE.map((c) => (
        <button
          key={c}
          type="button"
          className="cmp-swatch"
          style={{ background: c }}
          aria-label={`${label}: use ${c}`}
          onClick={() => onChange(c)}
        />
      ))}
    </div>
  </div>
);

const SeriesEditor: React.FC<SeriesEditorProps> = ({
  series,
  data,
  index,
  canRemove,
  onChange,
  onRemove,
}) => {
  const set = (patch: Partial<Series>) => onChange({ ...series, ...patch });

  const addMarker = () => {
    const color = MARKER_PALETTE[series.markers.length % MARKER_PALETTE.length];
    // Default to a mid-record summer date so the dashed ring lands somewhere real.
    const def = `${Math.min(series.endYear, MAX_YEAR - 1)}-07-15`;
    const marker: DateMarker = { id: nextMarkerId(), date: def, color };
    set({ markers: [...series.markers, marker] });
  };

  const updateMarker = (id: string, patch: Partial<DateMarker>) =>
    set({
      markers: series.markers.map((m) => (m.id === id ? { ...m, ...patch } : m)),
    });

  const removeMarker = (id: string) =>
    set({ markers: series.markers.filter((m) => m.id !== id) });

  const splittable = canSplit(series);
  const periods = seriesPeriods(series);
  const splitOn = series.split && splittable;

  // Turning the split on brings smoothing with it: the two halves' medians
  // bound the difference shading, and raw daily medians make it flicker.
  const toggleSplit = (on: boolean) =>
    set({
      split: on,
      smoothDays: on && series.smoothDays === 0 ? SPLIT_DEFAULT_SMOOTH : series.smoothDays,
    });

  return (
    <div className="cmp-series-card" style={{ borderLeftColor: series.color }}>
      <div className="cmp-series-head">
        <span className="cmp-series-index">Chart {index + 1}</span>
        <ColorPicker
          value={series.color}
          label={splitOn ? 'Early period color' : 'Series color'}
          onChange={(color) => set({ color })}
        />
        {canRemove && (
          <button
            type="button"
            className="cmp-series-remove"
            aria-label="Remove chart"
            onClick={onRemove}
          >
            ×
          </button>
        )}
      </div>

      <div className="cmp-field">
        <LocationSelector
          cityName={series.name}
          latitude={series.lat}
          longitude={series.lon}
          onChange={(info) => set({ name: info.name, lat: info.lat, lon: info.lon })}
        />
        {data?.loading && <span className="cmp-hint">Loading…</span>}
        {data && !data.loading && data.noArchive && (
          <span className="cmp-hint cmp-warn">No archive for this cell</span>
        )}
        {data?.error && <span className="cmp-hint cmp-warn">Failed to load</span>}
      </div>

      <div className="cmp-field cmp-metric-row">
        {METRICS.map((m) => (
          <button
            key={m}
            type="button"
            className={`cmp-metric-btn ${series.metric === m ? 'active' : ''}`}
            onClick={() => set({ metric: m })}
          >
            {METRIC_LABELS[m]}
          </button>
        ))}
      </div>

      <div className="cmp-field cmp-year-row">
        <label>
          From
          <select
            value={series.startYear}
            onChange={(e) => {
              const y = Number(e.target.value);
              set({ startYear: y, endYear: Math.max(y, series.endYear) });
            }}
          >
            {years().map((y) => (
              <option key={y} value={y}>
                {y}
              </option>
            ))}
          </select>
        </label>
        <label>
          To
          <select
            value={series.endYear}
            onChange={(e) => {
              const y = Number(e.target.value);
              set({ endYear: y, startYear: Math.min(y, series.startYear) });
            }}
          >
            {years().map((y) => (
              <option key={y} value={y}>
                {y}
              </option>
            ))}
          </select>
        </label>
      </div>

      {/* ---- split the range in half and lay the two periods on top ------- */}
      <div className="cmp-field cmp-split">
        <label className="cmp-check">
          <input
            type="checkbox"
            checked={series.split}
            disabled={!splittable}
            onChange={(e) => toggleSplit(e.target.checked)}
          />
          <span>Split at the halfway year</span>
        </label>
        {!splittable && (
          <span className="cmp-hint">Needs a range of at least two years.</span>
        )}

        {splitOn && (
          <>
            {periods.map((p) => (
              <div className="cmp-split-row" key={p.half}>
                <span className="cmp-split-label">
                  {p.half === 'early' ? 'Early' : 'Late'} · {p.label}
                </span>
                <ColorPicker
                  value={p.color}
                  label={`${p.half === 'early' ? 'Early' : 'Late'} period color`}
                  onChange={(color) =>
                    p.half === 'early' ? set({ color }) : set({ lateColor: color })
                  }
                />
              </div>
            ))}
            <label className="cmp-check">
              <input
                type="checkbox"
                checked={series.diffShade}
                onChange={(e) => set({ diffShade: e.target.checked })}
              />
              <span>Shade the gap in the higher half's color</span>
            </label>
          </>
        )}
      </div>

      <div className="cmp-field cmp-year-row cmp-smooth-row">
        <label>
          Day-of-year smoothing
          <select
            value={series.smoothDays}
            onChange={(e) => set({ smoothDays: Number(e.target.value) })}
          >
            {SMOOTH_OPTIONS.map((o) => (
              <option key={o.days} value={o.days}>
                {o.label}
              </option>
            ))}
          </select>
        </label>
      </div>

      <div className="cmp-field cmp-markers">
        <div className="cmp-markers-head">
          <span>Highlighted dates</span>
          <button type="button" className="cmp-add-marker" onClick={addMarker}>
            + date
          </button>
        </div>
        {series.markers.map((mk) => (
          <div key={mk.id} className="cmp-marker-row">
            <input
              type="color"
              value={mk.color}
              onChange={(e) => updateMarker(mk.id, { color: e.target.value })}
              aria-label="Marker color"
            />
            <input
              type="date"
              value={mk.date}
              min={`${MIN_YEAR}-01-01`}
              max={`${MAX_YEAR}-12-31`}
              onChange={(e) => updateMarker(mk.id, { date: e.target.value })}
            />
            <button
              type="button"
              className="cmp-marker-remove"
              aria-label="Remove date"
              onClick={() => removeMarker(mk.id)}
            >
              ×
            </button>
          </div>
        ))}
      </div>
    </div>
  );
};

function years(): number[] {
  const out: number[] = [];
  for (let y = MAX_YEAR; y >= MIN_YEAR; y--) out.push(y);
  return out;
}

export default SeriesEditor;

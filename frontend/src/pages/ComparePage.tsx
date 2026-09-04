import React, { useMemo, useState } from 'react';
import CompareRadialChart, { type ResolvedSeries } from './CompareRadialChart';
import SeriesEditor from './SeriesEditor';
import { useArchiveTimelines } from './useArchiveTimelines';
import { useUnits } from '../hooks/useUnits';
import { useTheme } from '../hooks/useTheme';
import { convert, unitLabel } from '../utils/units';
import type { MetricKey } from '../utils/config';
import type { BandKey, LayoutMode, Series } from './compareTypes';
import {
  BANDS_FOR_MODE,
  BAND_LABEL,
  BAND_SPECS,
  DEFAULT_BANDS,
  SERIES_PALETTE,
  seriesPeriods,
} from './compareTypes';
import { buildDialTracks, drawnExtent } from './compareStats';
import type { TrackInput } from './compareStats';
import { useComparePeriodTests } from './useComparePeriodTests';
import PeriodVerdict from './PeriodVerdict';
import './ComparePage.css';

const MAX_YEAR = new Date().getFullYear();

let seriesSeq = 0;
const nextSeriesId = () => `s${Date.now()}_${seriesSeq++}`;

const METRIC_NAME: Record<MetricKey, string> = {
  max_temperature: 'max temp',
  min_temperature: 'min temp',
  precipitation_sum: 'precip',
  wind_speed_10m_max: 'wind',
};

// Metrics that share a UNIT belong on the same dial. Min and max temperature are
// both °C/°F, so they pool together; precip (mm/in) and wind (km/h/mph) stand
// alone. Grouping/domain key on this family rather than the exact metric.
type UnitFamily = 'temp' | 'precip' | 'wind';
const unitFamily = (m: MetricKey): UnitFamily =>
  m === 'max_temperature' || m === 'min_temperature'
    ? 'temp'
    : m === 'precipitation_sum'
      ? 'precip'
      : 'wind';

const FAMILY_NAME: Record<UnitFamily, string> = {
  temp: 'temperature',
  precip: 'precip',
  wind: 'wind',
};

function makeSeries(index: number): Series {
  return {
    id: nextSeriesId(),
    // London-ish default cell; the user searches to change it.
    lat: 51.5,
    lon: -0.1,
    name: 'London',
    metric: 'max_temperature',
    startYear: 1950,
    endYear: MAX_YEAR,
    color: SERIES_PALETTE[index % SERIES_PALETTE.length],
    markers: [],
    split: false,
    // A contrasting neighbour in the palette, so a fresh split reads as two
    // periods without the user having to pick anything first.
    lateColor: SERIES_PALETTE[(index + 1) % SERIES_PALETTE.length],
    diffShade: true,
    smoothDays: 0,
  };
}

const ComparePage: React.FC = () => {
  const { system, toggleUnits } = useUnits();
  const { theme, toggleTheme } = useTheme();
  const [series, setSeries] = useState<Series[]>(() => [makeSeries(0)]);
  const [layout, setLayout] = useState<LayoutMode>('overlay');
  const [pointMode, setPointMode] = useState<'all' | 'percentile'>('all');
  // Which percentile layers the dials draw. Page-level, like the point mode:
  // every dial shows the same layers so they stay comparable.
  const [bands, setBands] = useState<BandKey[]>(DEFAULT_BANDS);

  const toggleBand = (k: BandKey) =>
    setBands((prev) => (prev.includes(k) ? prev.filter((b) => b !== k) : [...prev, k]));

  const dataMap = useArchiveTimelines(series);
  // One year-shuffle test per split chart, off the main thread.
  const periodTests = useComparePeriodTests(series, dataMap, system);

  const resolved: ResolvedSeries[] = useMemo(
    () =>
      series.map((s) => ({
        series: s,
        data: dataMap[s.id] ?? { rows: [], loading: true, noArchive: false },
      })),
    [series, dataMap]
  );

  // One shared value domain PER UNIT FAMILY, in display units. A dial only holds
  // series of a single family (overlay groups by family; separate is one series
  // each), so pooling by family means every dial of that family uses the same
  // [min,max] — directly comparable — and units never mix on one axis. Min and
  // max temp pool together since they share a unit.
  //
  // The extent covers the layers actually DRAWN rather than every raw day, so
  // switching layers off zooms the dial onto what is left: with the cloud and
  // the wide bands gone, half a degree between two periods fills a real slice
  // of the radius instead of disappearing inside a fifty-degree spread.
  const domainByFamily = useMemo(() => {
    const out = new Map<UnitFamily, [number, number]>();
    const byFamily = new Map<UnitFamily, TrackInput[]>();
    for (const { series: s, data } of resolved) {
      const fam = unitFamily(s.metric);
      const arr = byFamily.get(fam) ?? [];
      arr.push({ series: s, rows: data.rows });
      byFamily.set(fam, arr);
    }
    for (const [fam, inputs] of byFamily) {
      const tracks = buildDialTracks(
        inputs,
        (raw, metric) => convert(raw, metric, system),
        pointMode,
        bands
      );
      const ext = drawnExtent(tracks, pointMode);
      if (!ext) continue;
      const pad = (ext[1] - ext[0]) * 0.1 || 1;
      out.set(fam, [ext[0] - pad, ext[1] + pad]);
    }
    return out;
  }, [resolved, system, pointMode, bands]);

  const addSeries = () => setSeries((prev) => [...prev, makeSeries(prev.length)]);

  const updateSeries = (s: Series) =>
    setSeries((prev) => prev.map((p) => (p.id === s.id ? s : p)));

  const removeSeries = (id: string) =>
    setSeries((prev) => prev.filter((p) => p.id !== id));

  // Overlay groups series BY UNIT FAMILY: one dial per family present, holding
  // every series of that family. Min and max temp share a dial; series with a
  // different unit get their own. Family order follows first appearance.
  const overlayGroups = useMemo(() => {
    const groups: { family: UnitFamily; items: ResolvedSeries[] }[] = [];
    const byFamily = new Map<UnitFamily, ResolvedSeries[]>();
    for (const rs of resolved) {
      const fam = unitFamily(rs.series.metric);
      let arr = byFamily.get(fam);
      if (!arr) {
        arr = [];
        byFamily.set(fam, arr);
        groups.push({ family: fam, items: arr });
      }
      arr.push(rs);
    }
    return groups;
  }, [resolved]);

  return (
    <div className="cmp-page">
      <header className="cmp-header">
        <div className="cmp-header-titles">
          <h1>Compare Dials</h1>
          <p className="cmp-sub">
            Overlay or separate yearly weather dials. Archive (ERA5-Land) only.
          </p>
        </div>
        <div className="cmp-header-actions">
          <a className="cmp-back" href="/">
            ← Main app
          </a>
          <button type="button" className="cmp-units" onClick={toggleUnits}>
            {system === 'metric' ? '°C / km·h⁻¹' : '°F / mph'}
          </button>
          <button
            type="button"
            className="cmp-units"
            onClick={toggleTheme}
            aria-label="Toggle dark mode"
          >
            {theme === 'dark' ? '☀ Light' : '☾ Dark'}
          </button>
        </div>
      </header>

      <div className="cmp-body">
        <aside className="cmp-sidebar">
          <div className="cmp-controls-col">
            <div className="cmp-layout-toggle">
              <button
                type="button"
                className={layout === 'overlay' ? 'active' : ''}
                onClick={() => setLayout('overlay')}
              >
                Overlay
              </button>
              <button
                type="button"
                className={layout === 'separate' ? 'active' : ''}
                onClick={() => setLayout('separate')}
              >
                Separate
              </button>
            </div>

            <div className="cmp-layout-toggle">
              <button
                type="button"
                className={pointMode === 'all' ? 'active' : ''}
                onClick={() => setPointMode('all')}
              >
                All data
              </button>
              <button
                type="button"
                className={pointMode === 'percentile' ? 'active' : ''}
                onClick={() => setPointMode('percentile')}
              >
                Percentiles
              </button>
            </div>

            {/* Each percentile layer on its own switch. */}
            <div className="cmp-band-toggles">
              <div className="cmp-band-head">Layers</div>
              {BANDS_FOR_MODE[pointMode].map((k) => (
                <label key={k} className="cmp-check">
                  <input
                    type="checkbox"
                    checked={bands.includes(k)}
                    onChange={() => toggleBand(k)}
                  />
                  <span>{BAND_LABEL[k]}</span>
                </label>
              ))}
            </div>

            <button type="button" className="cmp-add-series" onClick={addSeries}>
              + Add chart
            </button>

            <p className="cmp-drag-hint">
              Overlay groups charts by metric — different units get their own
              dial. Switching layers off also zooms the dial in on what is left.
            </p>
          </div>

          {series.map((s, i) => (
            <SeriesEditor
              key={s.id}
              series={s}
              data={dataMap[s.id]}
              index={i}
              canRemove={series.length > 1}
              onChange={updateSeries}
              onRemove={() => removeSeries(s.id)}
            />
          ))}
        </aside>

        <main className="cmp-stage">
          {layout === 'overlay' ? (
            <div className="cmp-dial-grid">
              {overlayGroups.map((grp) => (
                <div className="cmp-dial-block" key={grp.family}>
                  <div className="cmp-dial-title">{FAMILY_NAME[grp.family]}</div>
                  <CompareRadialChart
                    series={grp.items}
                    axisMetric={grp.items[0].series.metric}
                    domain={domainByFamily.get(grp.family)}
                    pointMode={pointMode}
                    bands={bands}
                    width={overlayGroups.length > 1 ? 420 : 520}
                    height={overlayGroups.length > 1 ? 420 : 520}
                  />
                  <Legend
                    entries={grp.items}
                    markers={grp.items.flatMap((rs) =>
                      rs.series.markers.map((m) => ({ series: rs.series, marker: m }))
                    )}
                    system={system}
                    pointMode={pointMode}
                    bands={bands}
                  />
                  {grp.items.map(({ series: s }) =>
                    s.split ? (
                      <PeriodVerdict
                        key={s.id}
                        test={periodTests[s.id]?.result ?? null}
                        pending={periodTests[s.id]?.pending ?? false}
                        periods={seriesPeriods(s)}
                        metric={s.metric}
                        system={system}
                      />
                    ) : null
                  )}
                </div>
              ))}
            </div>
          ) : (
            <div className="cmp-dial-grid">
              {resolved.map((rs) => (
                <div className="cmp-dial-block" key={rs.series.id}>
                  <div className="cmp-dial-title" style={{ color: rs.series.color }}>
                    {rs.series.name} ·{' '}
                    {seriesPeriods(rs.series)
                      .map((p) => p.label)
                      .join(' vs ')}
                  </div>
                  <CompareRadialChart
                    series={[rs]}
                    axisMetric={rs.series.metric}
                    domain={domainByFamily.get(unitFamily(rs.series.metric))}
                    pointMode={pointMode}
                    bands={bands}
                    width={400}
                    height={400}
                  />
                  <Legend
                    entries={[rs]}
                    markers={rs.series.markers.map((m) => ({ series: rs.series, marker: m }))}
                    system={system}
                    pointMode={pointMode}
                    bands={bands}
                  />
                  {rs.series.split && (
                    <PeriodVerdict
                      test={periodTests[rs.series.id]?.result ?? null}
                      pending={periodTests[rs.series.id]?.pending ?? false}
                      periods={seriesPeriods(rs.series)}
                      metric={rs.series.metric}
                      system={system}
                    />
                  )}
                </div>
              ))}
            </div>
          )}
        </main>
      </div>
    </div>
  );
};

// --- legend -----------------------------------------------------------------
interface LegendProps {
  entries: ResolvedSeries[];
  markers: { series: Series; marker: { id: string; date: string; color: string } }[];
  system: ReturnType<typeof useUnits>['system'];
  pointMode: 'all' | 'percentile';
  bands: BandKey[];
}

const Legend: React.FC<LegendProps> = ({ entries, markers, system, pointMode, bands }) => {
  // Resolve each marker's value so the legend can show what its dashed ring sits at.
  const markerValue = (
    date: string,
    metric: MetricKey,
    rows: ResolvedSeries['data']['rows']
  ): string => {
    const dt = new Date(date + 'T00:00:00');
    const row = rows.find(
      (d) =>
        d.date.getFullYear() === dt.getFullYear() &&
        d.date.getMonth() === dt.getMonth() &&
        d.date.getDate() === dt.getDate() &&
        d[metric] !== undefined
    );
    if (!row) return '—';
    const v = convert(row[metric] as number, metric, system);
    return `${v.toFixed(1)}${unitLabel(metric, system)}`;
  };

  return (
    <div className="cmp-legend">
      {entries.map(({ series: s }) => {
        const periods = seriesPeriods(s);
        return (
          <React.Fragment key={s.id}>
            {periods.map((p) => (
              <React.Fragment key={p.half}>
                <div className="cmp-legend-item">
                  <span className="cmp-legend-line" style={{ background: p.color }} />
                  <span className="cmp-legend-text">
                    {s.name} · {METRIC_NAME[s.metric]} · {p.label}
                    {bands.includes('median') ? ' · median' : ''}
                  </span>
                </div>
                {pointMode === 'percentile' &&
                  BAND_SPECS.filter((spec) => bands.includes(spec.key)).map((spec) => (
                    <div className="cmp-legend-item cmp-legend-sub" key={spec.key}>
                      <span
                        className="cmp-legend-swatch"
                        style={{ background: p.color, opacity: spec.opacity }}
                      />
                      <span className="cmp-legend-text">{spec.label}</span>
                    </div>
                  ))}
                {pointMode === 'percentile' && bands.includes('outliers') && (
                  <div className="cmp-legend-item cmp-legend-sub">
                    <span className="cmp-legend-dot" style={{ background: p.color, opacity: 0.1 }} />
                    <span className="cmp-legend-text">{BAND_LABEL.outliers}</span>
                  </div>
                )}
              </React.Fragment>
            ))}
            {s.split && s.diffShade && periods.length === 2 && (
              <div className="cmp-legend-item cmp-legend-sub">
                <span
                  className="cmp-legend-swatch cmp-legend-split-swatch"
                  style={{
                    background: `linear-gradient(90deg, ${periods[0].color} 50%, ${periods[1].color} 50%)`,
                    opacity: 0.4,
                  }}
                />
                <span className="cmp-legend-text">
                  shaded in whichever period runs higher that day
                </span>
              </div>
            )}
          </React.Fragment>
        );
      })}
      {markers.map(({ series: s, marker }) => {
        const rs = entries.find((e) => e.series.id === s.id);
        const val = rs ? markerValue(marker.date, s.metric, rs.data.rows) : '—';
        return (
          <div key={marker.id} className="cmp-legend-item">
            <span className="cmp-legend-dash" style={{ borderColor: marker.color }} />
            <span className="cmp-legend-text">
              {marker.date} · {val}
            </span>
          </div>
        );
      })}
    </div>
  );
};

export default ComparePage;

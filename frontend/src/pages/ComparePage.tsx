import React, { useMemo, useState } from 'react';
import * as d3 from 'd3';
import CompareRadialChart, { type ResolvedSeries } from './CompareRadialChart';
import SeriesEditor from './SeriesEditor';
import { useArchiveTimelines } from './useArchiveTimelines';
import { useUnits } from '../hooks/useUnits';
import { useTheme } from '../hooks/useTheme';
import { convert, unitLabel } from '../utils/units';
import type { MetricKey } from '../utils/config';
import type { LayoutMode, Series } from './compareTypes';
import { SERIES_PALETTE } from './compareTypes';
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
// both °C/°F, so they pool together; precip (mm/in) and wind (m/s/mph) stand
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
  };
}

const ComparePage: React.FC = () => {
  const { system, toggleUnits } = useUnits();
  const { theme, toggleTheme } = useTheme();
  const [series, setSeries] = useState<Series[]>(() => [makeSeries(0)]);
  const [layout, setLayout] = useState<LayoutMode>('overlay');
  const [pointMode, setPointMode] = useState<'all' | 'percentile'>('all');

  const dataMap = useArchiveTimelines(series);

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
  const domainByFamily = useMemo(() => {
    const out = new Map<UnitFamily, [number, number]>();
    const valsByFamily = new Map<UnitFamily, number[]>();
    for (const { series: s, data } of resolved) {
      const fam = unitFamily(s.metric);
      const arr = valsByFamily.get(fam) ?? [];
      for (const d of data.rows) {
        const raw = d[s.metric];
        if (raw === undefined) continue;
        const yr = d.date.getFullYear();
        if (yr < s.startYear || yr > s.endYear) continue;
        arr.push(convert(raw, s.metric, system));
      }
      valsByFamily.set(fam, arr);
    }
    for (const [fam, arr] of valsByFamily) {
      if (arr.length === 0) continue;
      const ext = d3.extent(arr) as [number, number];
      const pad = (ext[1] - ext[0]) * 0.1 || 1;
      out.set(fam, [ext[0] - pad, ext[1] + pad]);
    }
    return out;
  }, [resolved, system]);

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
            {system === 'metric' ? '°C / m·s⁻¹' : '°F / mph'}
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

            <button type="button" className="cmp-add-series" onClick={addSeries}>
              + Add chart
            </button>

            <p className="cmp-drag-hint">
              Overlay groups charts by metric — different units get their own dial.
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
                  />
                </div>
              ))}
            </div>
          ) : (
            <div className="cmp-dial-grid">
              {resolved.map((rs) => (
                <div className="cmp-dial-block" key={rs.series.id}>
                  <div className="cmp-dial-title" style={{ color: rs.series.color }}>
                    {rs.series.name} · {rs.series.startYear}–{rs.series.endYear}
                  </div>
                  <CompareRadialChart
                    series={[rs]}
                    axisMetric={rs.series.metric}
                    domain={domainByFamily.get(unitFamily(rs.series.metric))}
                    pointMode={pointMode}
                    width={400}
                    height={400}
                  />
                  <Legend
                    entries={[rs]}
                    markers={rs.series.markers.map((m) => ({ series: rs.series, marker: m }))}
                    system={system}
                    pointMode={pointMode}
                  />
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
}

const Legend: React.FC<LegendProps> = ({ entries, markers, system, pointMode }) => {
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
      {entries.map(({ series: s }) => (
        <React.Fragment key={s.id}>
          <div className="cmp-legend-item">
            <span className="cmp-legend-line" style={{ background: s.color }} />
            <span className="cmp-legend-text">
              {s.name} · {METRIC_NAME[s.metric]} · {s.startYear}–{s.endYear}
              {pointMode === 'percentile' ? ' · median' : ''}
            </span>
          </div>
          {pointMode === 'percentile' && (
            <>
              <div className="cmp-legend-item cmp-legend-sub">
                <span
                  className="cmp-legend-swatch"
                  style={{ background: s.color, opacity: 0.32 }}
                />
                <span className="cmp-legend-text">25–75 percentile</span>
              </div>
              <div className="cmp-legend-item cmp-legend-sub">
                <span
                  className="cmp-legend-swatch"
                  style={{ background: s.color, opacity: 0.15 }}
                />
                <span className="cmp-legend-text">5–95 percentile</span>
              </div>
              <div className="cmp-legend-item cmp-legend-sub">
                <span
                  className="cmp-legend-swatch"
                  style={{ background: s.color, opacity: 0.08 }}
                />
                <span className="cmp-legend-text">1–99 percentile</span>
              </div>
              <div className="cmp-legend-item cmp-legend-sub">
                <span
                  className="cmp-legend-dot"
                  style={{ background: s.color, opacity: 0.1 }}
                />
                <span className="cmp-legend-text">outliers (&lt;1 / &gt;99)</span>
              </div>
            </>
          )}
        </React.Fragment>
      ))}
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

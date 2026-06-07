import React, { useEffect, useRef } from 'react';
import * as d3 from 'd3';
import type { WeatherDataPoint } from '../types';
import type { MetricKey } from '../utils/config';
import CONFIG from '../utils/config';
import { placeTooltip } from '../utils/tooltip';
import { useUnits } from '../hooks/useUnits';
import { convert, unitLabel, axisLabel, binWidth } from '../utils/units';
import './PeriodHistogramChart.css';

interface PeriodHistogramChartProps {
  // Same windowed (±CONFIG.chart.seasonalWindowDays, all years) subset the main
  // chart uses. We further restrict to historical archive rows and split into
  // 15-year periods.
  filteredData: WeatherDataPoint[];
  currentMetric: MetricKey;
  // Two-sided p-value of the oldest-vs-newest permutation test (same one the
  // SignificancePanel reports). Drives the significance bracket + stars drawn
  // between the bottom (oldest) and top (newest) panel medians. null while the
  // test is still running or when there isn't enough data.
  pValue?: number | null;
  width?: number;
  // Height of a single panel (each of the 3 periods gets one). Total SVG height
  // is derived from this plus the shared x-axis strip.
  panelHeight?: number;
}

export interface Period {
  start: number;
  end: number;
  label: string;
  // 0 = lightest (oldest), higher = darker (most recent)
  shade: number;
}

// Three rolling 15-year periods ending the *previous* full year. Computed from
// "now" so the windows advance automatically each year.
export function buildPeriods(): Period[] {
  const prevYear = new Date().getFullYear() - 1;
  const p1Start = prevYear - 14;        // most recent 15 years (e.g. 2011–2025)
  const p2Start = p1Start - 15;         // (e.g. 1995–2010)
  const p3Start = p2Start - 15;         // (e.g. 1980–1994)
  return [
    { start: p3Start, end: p2Start - 1, label: `${p3Start}–${p2Start - 1}`, shade: 0 },
    { start: p2Start, end: p1Start - 1, label: `${p2Start}–${p1Start - 1}`, shade: 1 },
    { start: p1Start, end: prevYear, label: `${p1Start}–${prevYear}`, shade: 2 },
  ];
}

// Three shades of the metric's base color, light → dark, for the three periods.
export function shadeFor(base: string, shade: number): string {
  const c = d3.color(base);
  if (!c) return base;
  // All periods are lightened toward white; oldest lightest, most recent least.
  const factors = [0.7, 0.5, 0.3]; // amount lightened
  const t = factors[shade] ?? 0;
  return (d3.interpolateRgb(base, '#ffffff')(t) as string);
}

// Darkened trend-line color used for the dashed summary-stat line (shared by the
// in-chart median lines and the legend swatch).
export function medianColorFor(metric: MetricKey): string {
  return (
    d3.color(CONFIG.getColorForElement(metric, 'trendLine'))?.darker(0.6).formatHex() ??
    CONFIG.getColorForElement(metric, 'trendLine')
  );
}

// All metrics summarize with the median.
export function statLabelFor(_metric: MetricKey): string {
  return 'Median';
}

// HTML legend rendered above the period histogram — matches the data chart's
// `.chart-legend` convention. Shows the dashed summary-stat line plus a color
// swatch for each of the three periods.
export const PeriodLegend: React.FC<{ metric: MetricKey }> = ({ metric }) => {
  const base = CONFIG.metricColors[metric].base;
  const medianColor = medianColorFor(metric);
  const periods = buildPeriods();
  return (
    <div className="chart-legend">
      <div className="chart-legend-item">
        <svg width={18} height={14} style={{ flex: '0 0 auto' }}>
          <line x1={0} x2={18} y1={7} y2={7} stroke={medianColor} strokeWidth={3} strokeDasharray="4,3" />
        </svg>
        <span>{statLabelFor(metric)}</span>
      </div>
      {periods.map((p) => (
        <div key={p.label} className="chart-legend-item">
          <svg width={14} height={14} style={{ flex: '0 0 auto' }}>
            <rect x={1} y={1} width={12} height={12} fill={shadeFor(base, p.shade)} />
          </svg>
          <span>{p.label}</span>
        </div>
      ))}
    </div>
  );
};

// left/right must match MainChart's vertical-mode margins (MARGIN_V in
// MainChart.tsx: left 55, right 20) so that on mobile, where this chart's
// x-axis sits directly under the main chart's, the two temp axes share the
// exact same pixel range and their ticks line up.
// top leaves room for both the significance bracket (a band above the top
// panel) and that panel's right-aligned year label which sits just below it.
const MARGIN = { top: 44, right: 20, bottom: 36, left: 55 };
const PANEL_GAP = 18;   // vertical gap between stacked panels (room for the centered year title)

// Conventional significance stars from a p-value (matches the SignificancePanel
// thresholds at the top end; "ns" = not significant).
function starsFor(p: number): string {
  if (p < 0.001) return '***';
  if (p < 0.01) return '**';
  if (p < 0.05) return '*';
  return 'ns';
}

const PeriodHistogramChart: React.FC<PeriodHistogramChartProps> = ({
  filteredData,
  currentMetric,
  pValue,
  width: propWidth,
  panelHeight: propPanelHeight,
}) => {
  const { system } = useUnits();
  const svgRef = useRef<SVGSVGElement>(null);
  const tooltipRef = useRef<HTMLDivElement>(null);
  // Bracket geometry stashed by the main render so the separate pValue-keyed
  // effect can place the stars without recomputing it (and without touching the
  // bracket lines, which the main render already drew).
  const bracketGeomRef = useRef<{ x0: number; x1: number; barY: number } | null>(null);

  const TOTAL_WIDTH = propWidth ?? 720;
  const panelHeight = propPanelHeight ?? 70;
  const width = TOTAL_WIDTH - MARGIN.left - MARGIN.right;

  // Most recent on top → oldest at the bottom (just above the shared x-axis).
  const N_PANELS = 3;
  const plotHeight = N_PANELS * panelHeight + (N_PANELS - 1) * PANEL_GAP;
  const TOTAL_HEIGHT = MARGIN.top + plotHeight + MARGIN.bottom;

  useEffect(() => {
    if (!svgRef.current) return;

    const svg = d3.select(svgRef.current);
    svg.selectAll('*').remove();

    const periods = buildPeriods();
    const baseColor = CONFIG.metricColors[currentMetric].base;
    // Same color as the rolling-median (trend) line on the main chart, darkened
    // a touch for contrast against the filled bars (see medianColorFor).
    const medianLineColor = medianColorFor(currentMetric);

    // Real observed rows only (no forecast); 'recent' is real data (was tagged
    // 'historical' before the recent tier got its own data_type).
    const historical = filteredData.filter((d) => d.data_type !== 'forecast');

    // Read a row's metric value already converted to the display system, so the
    // axis, bins, and medians are all computed in display units (clean ticks).
    const valueOf = (d: WeatherDataPoint) => {
      const v = d[currentMetric];
      return v == null ? v : convert(v, currentMetric, system);
    };
    const allValues = historical
      .map(valueOf)
      .filter((v): v is number => v !== null && v !== undefined);
    if (allValues.length === 0) return;

    // The temp axis (x) must match the main chart's exactly so the two x-axes
    // align on mobile. The main chart derives its domain from *all* filteredData
    // (including recent/forecast rows), so do the same here for the axis domain.
    const axisValues = filteredData
      .map(valueOf)
      .filter((v): v is number => v !== null && v !== undefined);

    const g = svg
      .append('g')
      .attr('transform', `translate(${MARGIN.left},${MARGIN.top})`);

    const tooltip = d3.select(tooltipRef.current);

    const [axisMin, axisMax] = d3.extent(axisValues) as [number, number];

    // Precipitation and wind can't be negative, so don't let the padded lower
    // bound dip below zero (otherwise dry-day distributions get phantom -2,-1
    // bins and axis ticks).
    const nonNegative = currentMetric === 'precipitation_sum' || currentMetric === 'wind_speed_10m_max';

    // Axis domain matches the main chart's tempScale exactly ([min-2, max+2]
    // with the same ≥0 floor) so the two x-axes line up on mobile.
    const domainLo = nonNegative ? Math.max(0, axisMin - 2) : axisMin - 2;
    const domainHi = axisMax + 2;

    // Shared temp axis (x) across all three panels.
    const tempScale = d3.scaleLinear().domain([domainLo, domainHi]).range([0, width]);

    // Adaptive-width bins, anchored to a unit grid so every period shares the
    // exact same bin edges (and they line up across metrics/locations). The
    // span passed to binWidth() is the padded axis span computed identically to
    // the top HistogramChart, so both charts choose the same width and land on
    // the same edges. Snap only the *bin* edges to the grid; the axis domain
    // stays continuous (above) to match the main chart.
    const BIN = binWidth(currentMetric, system, domainHi - domainLo);
    // Snap purely to the BIN grid (no Math.max with the padded domainLo, which
    // is off-grid — that shifted every edge by a fraction, e.g. a tooltip
    // reading 20.35–20.85 instead of 20.0–20.5). Matches HistogramChart so both
    // charts land on identical edges.
    const binLo = Math.floor(domainLo / BIN) * BIN;
    const binHi = Math.ceil(domainHi / BIN) * BIN;
    const thresholds = d3.range(binLo, binHi + BIN, BIN);
    const binGen = d3
      .bin<number, number>()
      .domain([binLo, binHi])
      .thresholds(thresholds);

    const statOf = (vals: number[]) => d3.median(vals) ?? null;

    const perPeriod = periods.map((p) => {
      const values = historical
        .filter((d) => d.year >= p.start && d.year <= p.end)
        .map(valueOf)
        .filter((v): v is number => v !== null && v !== undefined);
      return {
        period: p,
        bins: binGen(values),
        n: values.length,
        stat: values.length ? statOf(values) : null,
      };
    });

    const statLabel = statLabelFor(currentMetric);

    // Shared count scale so panel heights are directly comparable: domain is the
    // tallest single bin across all periods.
    const maxCount = d3.max(perPeriod, (pp) =>
      d3.max(pp.bins, (b) => b.length) ?? 0
    ) ?? 0;

    const unit = unitLabel(currentMetric, system);
    const tempAxisLabel = axisLabel(currentMetric, system);

    const barW = (d: d3.Bin<number, number>) =>
      Math.max(0, tempScale(d.x1 as number) - tempScale(d.x0 as number) - 1);

    // Render panels top → bottom in display order: most recent first (top).
    const displayOrder = [...perPeriod].reverse();

    // Capture the geometry of the top (newest) and bottom (oldest) panel
    // medians so we can connect them with a significance bracket afterwards.
    let topMedianX: number | null = null;
    let bottomMedianX: number | null = null;
    let bottomPanelBaselineY = 0;

    displayOrder.forEach((pp, idx) => {
      const panelTop = idx * (panelHeight + PANEL_GAP);
      const isTopPanel = idx === 0;
      const isBottomPanel = idx === displayOrder.length - 1;
      const color = shadeFor(baseColor, pp.period.shade);

      const panel = g
        .append('g')
        .attr('class', 'period-panel')
        .attr('transform', `translate(0,${panelTop})`);

      // Per-panel count scale (shared domain, panel-local range).
      const countScale = d3
        .scaleLinear()
        .domain([0, maxCount])
        .range([panelHeight, 0]);

      // Light gridline at the panel baseline.
      panel
        .append('line')
        .attr('class', 'panel-baseline')
        .attr('x1', 0)
        .attr('x2', width)
        .attr('y1', panelHeight)
        .attr('y2', panelHeight);

      const nonEmptyBins = pp.bins.filter((b) => b.length > 0);

      // Bars
      panel
        .selectAll('rect.period-bar')
        .data(nonEmptyBins)
        .enter()
        .append('rect')
        .attr('class', 'period-bar')
        .attr('x', (b) => tempScale(b.x0 as number) + 0.5)
        .attr('width', (b) => barW(b))
        .attr('y', panelHeight)
        .attr('height', 0)
        .attr('fill', color)
        .transition()
        .duration(500)
        .attr('y', (b) => countScale(b.length))
        .attr('height', (b) => panelHeight - countScale(b.length));

      // Transparent full-height hit areas, one per bin, so the tooltip triggers
      // anywhere in the bin's column — even for a 1-day bin that's only a sliver
      // tall. Appended after the bars so they capture the mouse.
      const showTip = (event: MouseEvent, b: d3.Bin<number, number>) => {
        tooltip
          .style('opacity', 1)
          .html(
            `<strong>${pp.period.label}</strong><br/>${(b.x0 as number).toFixed(1)}–${(b.x1 as number).toFixed(1)}${unit}<br/>${b.length} day${b.length === 1 ? '' : 's'}`
          );
        placeTooltip(tooltipRef.current, event);
      };
      panel
        .selectAll('rect.period-hit')
        .data(nonEmptyBins)
        .enter()
        .append('rect')
        .attr('class', 'period-hit')
        .attr('x', (b) => tempScale(b.x0 as number) + 0.5)
        .attr('width', (b) => barW(b))
        .attr('y', 0)
        .attr('height', panelHeight)
        .attr('fill', 'transparent')
        .style('cursor', 'pointer')
        .on('mouseover', showTip)
        .on('mousemove', showTip)
        .on('mouseout', () => tooltip.style('opacity', 0));

      // Per-panel y-axis (a couple of count ticks).
      panel
        .append('g')
        .attr('class', 'axis')
        .call(d3.axisLeft(countScale).ticks(2) as any);

      // Period label, right-aligned above the panel.
      panel
        .append('text')
        .attr('class', 'panel-label')
        .attr('x', width)
        .attr('y', -5)
        .style('text-anchor', 'end')
        .style('font-size', '12px')
        .style('font-weight', '500')
        .style('fill', 'var(--text-h)')
        .text(pp.period.label);

      // Summary-stat line — dashed, in the main chart's trend-line color, scoped
      // to its own panel and appended last so it sits in front of this panel's
      // bars. Median for most metrics; 90th percentile for precipitation.
      if (pp.stat !== null) {
        const mx = tempScale(pp.stat);
        // Record geometry for the significance bracket. mx is panel-local x
        // (panels share the same x range), so it's directly comparable; panel y
        // offsets are added when the bracket is drawn on `g`.
        if (isTopPanel) topMedianX = mx;
        if (isBottomPanel) {
          bottomMedianX = mx;
          bottomPanelBaselineY = panelTop + panelHeight;
        }
        panel
          .append('line')
          .attr('class', 'period-median')
          .attr('x1', mx)
          .attr('x2', mx)
          .attr('y1', 0)
          .attr('y2', panelHeight)
          .attr('stroke', medianLineColor)
          .attr('stroke-width', 3)
          .attr('stroke-dasharray', '4,3')
          .style('opacity', 0)
          .transition()
          .duration(500)
          .style('opacity', 1);

        // Wide transparent hit area over the median line so the tooltip is easy
        // to catch (the visible line is only ~2px wide).
        const showMedianTip = (event: MouseEvent) => {
          tooltip
            .style('opacity', 1)
            .html(
              `<strong>${pp.period.label} ${statLabel.toLowerCase()}</strong><br/>${(pp.stat as number).toFixed(1)}${unit}`
            );
          placeTooltip(tooltipRef.current, event);
        };
        panel
          .append('line')
          .attr('class', 'period-median-hit')
          .attr('x1', mx)
          .attr('x2', mx)
          .attr('y1', 0)
          .attr('y2', panelHeight)
          .attr('stroke', 'transparent')
          .attr('stroke-width', 12)
          .style('cursor', 'pointer')
          .on('mouseover', showMedianTip)
          .on('mousemove', showMedianTip)
          .on('mouseout', () => tooltip.style('opacity', 0));
      }
    });

    // Significance bracket — the scientific-paper style "⊓" over the top panel,
    // connecting the newest (top) and oldest (bottom) period medians along the
    // shared x-axis. The bracket *lines* are drawn here, with the bars, since
    // their geometry doesn't depend on the p-value — only the stars do, and
    // those are added by a separate pValue-keyed effect so the bracket itself
    // never flashes when the permutation worker result lands.
    void bottomPanelBaselineY;
    if (topMedianX != null && bottomMedianX != null) {
      const barY = -10;       // horizontal bar, in the top margin (negative y on g)
      const legBottomY = -4;  // legs drop to just above the top panel
      const x0 = Math.min(topMedianX, bottomMedianX);
      const x1 = Math.max(topMedianX, bottomMedianX);
      bracketGeomRef.current = { x0, x1, barY };

      const bracket = g.append('g').attr('class', 'sig-bracket');
      bracket
        .append('path')
        .attr('d', `M${x0},${legBottomY} L${x0},${barY} L${x1},${barY} L${x1},${legBottomY}`)
        .attr('fill', 'none');
    } else {
      bracketGeomRef.current = null;
    }

    // Shared x-axis under the bottom panel. Use d3's default tick count (no
    // .ticks() override) so it matches the main chart's temp axis exactly —
    // with the same domain and pixel range, the tick positions are identical.
    const xAxisG = g
      .append('g')
      .attr('class', 'axis')
      .attr('transform', `translate(0,${plotHeight})`)
      .call(d3.axisBottom(tempScale) as any);
    void xAxisG;

    g.append('text')
      .attr('x', width / 2)
      .attr('y', plotHeight + 30)
      .style('text-anchor', 'middle')
      .style('font-size', '12px')
      .style('fill', 'var(--chart-label)')
      .text(tempAxisLabel);

    // Shared "Count" label down the y-axis (the per-panel axes only show ticks).
    g.append('text')
      .attr('transform', 'rotate(-90)')
      .attr('y', -MARGIN.left + 12)
      .attr('x', -plotHeight / 2)
      .attr('dy', '1em')
      .style('text-anchor', 'middle')
      .style('font-size', '12px')
      .style('fill', 'var(--chart-label)')
      .text('Count');

  }, [filteredData, currentMetric, width, panelHeight, plotHeight, system]);

  // Significance stars — placed (and updated) on their own, keyed on pValue, so
  // the permutation worker result landing only adds/fades in the stars text. The
  // bracket lines themselves are drawn by the main render with the bars, so they
  // never flash. The stars fade in late, which is fine — the p-value genuinely
  // isn't known until the worker returns.
  useEffect(() => {
    if (!svgRef.current) return;
    const bracket = d3.select(svgRef.current).select<SVGGElement>('.sig-bracket');
    if (bracket.empty()) return;

    // Clear any prior stars so pValue flips don't stack.
    bracket.selectAll('.sig-stars').remove();

    const geom = bracketGeomRef.current;
    if (pValue == null || !geom) return;

    const stars = starsFor(pValue);
    bracket
      .append('text')
      .attr('class', `sig-stars ${stars === 'ns' ? 'sig-ns' : ''}`)
      .attr('x', (geom.x0 + geom.x1) / 2)
      .attr('y', geom.barY - 3)
      .style('text-anchor', 'middle')
      .text(stars);
    // Also re-runs after the main render (filteredData/metric rebuild the SVG and
    // the bracket lines, then this re-adds the stars onto the fresh bracket).
  }, [pValue, filteredData, currentMetric, width, panelHeight, plotHeight, system]);

  return (
    <div className="period-histogram-wrapper">
      <svg
        ref={svgRef}
        width={TOTAL_WIDTH}
        height={TOTAL_HEIGHT}
        className="period-histogram-svg"
      />
      <div ref={tooltipRef} className="chart-tooltip" />
    </div>
  );
};

export default PeriodHistogramChart;

import React, { useEffect, useRef } from 'react';
import * as d3 from 'd3';
import type { WeatherDataPoint } from '../types';
import type { MetricKey } from '../utils/config';
import CONFIG from '../utils/config';
import './PeriodHistogramChart.css';

interface PeriodHistogramChartProps {
  // Same windowed (±CONFIG.chart.seasonalWindowDays, all years) subset the main
  // chart uses. We further restrict to historical archive rows and split into
  // 15-year periods.
  filteredData: WeatherDataPoint[];
  currentMetric: MetricKey;
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
function shadeFor(base: string, shade: number): string {
  const c = d3.color(base);
  if (!c) return base;
  // All periods are lightened toward white; oldest lightest, most recent least.
  const factors = [0.7, 0.5, 0.3]; // amount lightened
  const t = factors[shade] ?? 0;
  return (d3.interpolateRgb(base, '#ffffff')(t) as string);
}

// left/right must match MainChart's vertical-mode margins (MARGIN_V in
// MainChart.tsx: left 55, right 20) so that on mobile, where this chart's
// x-axis sits directly under the main chart's, the two temp axes share the
// exact same pixel range and their ticks line up.
const MARGIN = { top: 18, right: 20, bottom: 36, left: 55 };
const PANEL_GAP = 18;   // vertical gap between stacked panels (room for the centered year title)

const PeriodHistogramChart: React.FC<PeriodHistogramChartProps> = ({
  filteredData,
  currentMetric,
  width: propWidth,
  panelHeight: propPanelHeight,
}) => {
  const svgRef = useRef<SVGSVGElement>(null);
  const tooltipRef = useRef<HTMLDivElement>(null);

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
    // Same color as the rolling-median (trend) line on the main chart.
    // The period-histogram median line reads faint against the filled bars, so
    // darken the metric's trend-line color a touch for better contrast here.
    const medianLineColor =
      d3.color(CONFIG.getColorForElement(currentMetric, 'trendLine'))?.darker(0.6).formatHex() ??
      CONFIG.getColorForElement(currentMetric, 'trendLine');

    // Restrict to historical archive rows only (no forecast).
    const historical = filteredData.filter((d) => d.data_type === 'historical');

    const valueOf = (d: WeatherDataPoint) => d[currentMetric];
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

    // Fixed 0.5-unit bins, anchored to a half-unit grid so every period shares
    // the exact same bin edges (and they line up across metrics/locations).
    // Snap only the *bin* edges to the grid; the axis domain stays continuous
    // (above) to match the main chart.
    const BIN = 0.5;
    const binLo = Math.max(domainLo, Math.floor(domainLo / BIN) * BIN);
    const binHi = Math.ceil(domainHi / BIN) * BIN;
    const thresholds = d3.range(binLo, binHi + BIN, BIN);
    const binGen = d3
      .bin<number, number>()
      .domain([binLo, binHi])
      .thresholds(thresholds);

    // Precipitation is dominated by dry days, so its median is uninformative
    // (often 0). For precip we summarize with the 90th percentile (the "wet
    // tail") instead; every other metric uses the median.
    const usesP90 = currentMetric === 'precipitation_sum';
    const statOf = (vals: number[]) =>
      usesP90 ? (d3.quantile(vals, 0.9) ?? null) : (d3.median(vals) ?? null);

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

    const statLabel = usesP90 ? '90th pct' : 'Median';

    // Shared count scale so panel heights are directly comparable: domain is the
    // tallest single bin across all periods.
    const maxCount = d3.max(perPeriod, (pp) =>
      d3.max(pp.bins, (b) => b.length) ?? 0
    ) ?? 0;

    const units: Record<MetricKey, string> = {
      max_temperature: '°C',
      min_temperature: '°C',
      precipitation_sum: 'mm',
      wind_speed_10m_max: 'm/s',
    };
    const tempLabels: Record<MetricKey, string> = {
      max_temperature: 'Daily Max Temp (°C)',
      min_temperature: 'Daily Min Temp (°C)',
      precipitation_sum: 'Daily Precipitation (mm)',
      wind_speed_10m_max: 'Daily Max Wind Speed (m/s)',
    };

    const barW = (d: d3.Bin<number, number>) =>
      Math.max(0, tempScale(d.x1 as number) - tempScale(d.x0 as number) - 1);

    // Render panels top → bottom in display order: most recent first (top).
    const displayOrder = [...perPeriod].reverse();

    displayOrder.forEach((pp, idx) => {
      const panelTop = idx * (panelHeight + PANEL_GAP);
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
            `<strong>${pp.period.label}</strong><br/>${(b.x0 as number).toFixed(1)}–${(b.x1 as number).toFixed(1)}${units[currentMetric]}<br/>${b.length} day${b.length === 1 ? '' : 's'}`
          )
          .style('left', event.clientX + 12 + 'px')
          .style('top', event.clientY - 28 + 'px');
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
              `<strong>${pp.period.label} ${statLabel.toLowerCase()}</strong><br/>${(pp.stat as number).toFixed(1)}${units[currentMetric]}`
            )
            .style('left', event.clientX + 12 + 'px')
            .style('top', event.clientY - 28 + 'px');
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
      .text(tempLabels[currentMetric]);

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

    // Single legend for the summary-stat line, top-right of the plot.
    const legendLabel = statLabel;
    const legend = g.append('g').attr('class', 'median-legend');
    legend
      .append('line')
      .attr('x1', 0)
      .attr('x2', 16)
      .attr('y1', 0)
      .attr('y2', 0)
      .attr('stroke', medianLineColor)
      .attr('stroke-width', 3)
      .attr('stroke-dasharray', '4,3');
    legend
      .append('text')
      .attr('x', 21)
      .attr('y', 0)
      .attr('dy', '0.32em')
      .style('font-size', '11px')
      .style('fill', 'var(--chart-label)')
      .text(legendLabel);
    // Right-align the legend, but clear of the right-aligned year labels: a
    // "YYYY–YYYY" label is ~64px, so leave room for it plus a gap.
    const legendW = (legend.node() as SVGGElement).getBBox().width;
    const YEAR_LABEL_CLEARANCE = 80;
    legend.attr('transform', `translate(${width - legendW - YEAR_LABEL_CLEARANCE},-6)`);
  }, [filteredData, currentMetric, width, panelHeight, plotHeight]);

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

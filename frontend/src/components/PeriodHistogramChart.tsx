import React, { useEffect, useRef } from 'react';
import * as d3 from 'd3';
import type { WeatherDataPoint } from '../types';
import type { MetricKey } from '../utils/config';
import CONFIG from '../utils/config';
import { placeTooltip } from '../utils/tooltip';
import { binPercentileLabel } from '../utils/dataProcessor';
import { useUnits } from '../hooks/useUnits';
import { convert, unitLabel, axisLabel, binWidth, axisPad, tickCount } from '../utils/units';
import { erasForYears, eraColor } from '../utils/eras';
import { useEraColorOverrides } from '../hooks/useEraColors';
import { useThemeMode } from '../hooks/useTheme';
import './PeriodHistogramChart.css';

interface PeriodHistogramChartProps {
  // Same windowed (±CONFIG.chart.seasonalWindowDays, all years) subset the main
  // chart uses. We further restrict to observed rows and split into the eras.
  filteredData: WeatherDataPoint[];
  currentMetric: MetricKey;
  // Two-sided p-value per bracket — every PAIR of eras, all three drawn. Null
  // while that test is still running, or when there isn't enough data for it.
  // `latestVsPrev` is also the one the prose reports (SignificancePanel); it is
  // bracketed here like the others, because a reader comparing three pairs
  // should see all three marked, not two.
  pValues?: Partial<Record<BracketKey, number | null>>;
  width?: number;
  // Height of a single panel (each of the 3 eras gets one). Total SVG height
  // is derived from this plus the shared x-axis strip.
  panelHeight?: number;
}

export interface Period {
  start: number;
  end: number;
  label: string;
  /** Index into the era ramp: 0 = oldest (pre-satellite), 2 = newest. */
  era: number;
}

/**
 * The three comparisons: every PAIR of the three eras, each drawn as its own
 * bracket above the topmost of the two panels it compares. Named here rather
 * than in usePermutationTest because that hook already imports this module (for
 * buildPeriods), so the dependency can only run one way.
 *   latestVsPrev   — 2000–now vs 1979–1999. Also the pair the prose reports.
 *   latestVsPresat — 2000–now vs 1950–1978.
 *   prevVsPresat   — 1979–1999 vs 1950–1978.
 */
export type BracketKey = 'latestVsPrev' | 'latestVsPresat' | 'prevVsPresat';

/**
 * The three periods this section compares: THE ERAS (utils/eras) — pre-satellite,
 * the first satellite stretch, and everything since MIDPOINT_YEAR — replacing the
 * rolling 15-year windows this used to build from "now". One definition, read by
 * the chart, by the three permutation tests and by the panel's sentence, so a
 * bracket, a bar colour and a number can never be talking about different years.
 *
 * `rows` sets only the two OUTER bounds — the first and last year on record,
 * which the outer labels read. Both cuts are fixed years, so the eras mean the
 * same thing on every cell and in every year; a rolling window did not, and the
 * bars silently re-cut themselves each January.
 */
export function buildPeriods(rows: WeatherDataPoint[], metric: MetricKey): Period[] {
  const eras = erasForYears(
    rows
      .filter((d) => d.data_type !== 'forecast' && d[metric] != null)
      .map((d) => d.year)
  );
  if (!eras) return [];
  return eras.map((e, i) => ({ start: e.from, end: e.to, label: e.label, era: i }));
}

/**
 * A period's bar colour: its step on the metric's ordinal era ramp, the same
 * one the main histogram paints that era with, so a bar here and a bar there
 * read as the same years.
 *
 * Deliberately eraColor and not eraInk(...).fill: in CONTOUR style every era's
 * `fill` is the one shared metric base, which works there because the eras are
 * overlaid and told apart by their outlines. These three panels are separate and
 * have no outlines, so a shared fill would make them — and their three legend
 * swatches — identical. The ramp step is what eraInk hands the shade style as
 * `fill` and the contour style as `stroke`; it is the era's colour either way.
 */
export function periodColor(metric: MetricKey, era: number, theme: 'light' | 'dark'): string {
  return eraColor(metric, era, theme);
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
export const PeriodLegend: React.FC<{
  metric: MetricKey;
  filteredData: WeatherDataPoint[];
}> = ({ metric, filteredData }) => {
  const theme = useThemeMode();
  // Swatches are inked at render time, so subscribing is all this needs (#73).
  useEraColorOverrides();
  const medianColor = medianColorFor(metric);
  const periods = buildPeriods(filteredData, metric);
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
            <rect x={1} y={1} width={12} height={12} fill={periodColor(metric, p.era, theme)} />
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
// top leaves room for the TWO latest-vs-* brackets stacked above the top panel
// — the third, prev-vs-pre-satellite, now sits above the MIDDLE panel (see the
// bracket block below) — plus the top panel's right-aligned year label, which
// sits just below the innermost bracket.
const MARGIN = { top: 56, right: 20, bottom: 36, left: 55 };
// Vertical gap between stacked panels. Every gap carries the panel below's
// right-aligned year label (13px of ink, ending 2px above the panel), and the
// FIRST gap also carries the prev-vs-pre-satellite bracket (MID_BRACKET_LIFT).
// 56 puts that bracket's ink 20px under the baseline of the panel above and its
// legs 18px over the panel below, so it reads as belonging to the panel it is
// captioning rather than to the bars above it. Both gaps stay the same so the
// three panels keep one rhythm.
const PANEL_GAP = 56;
// One bracket level: 6px of legs, a 1.2px bar, and the ~13px the 14px stars
// occupy above it (see .sig-stars). 24 leaves the next level's legs ~5px clear
// of the level below's stars, and the two levels now stacked above the top
// panel put the topmost ink at about y=-47 — so MARGIN.top must stay above
// that, hence 56.
const BRACKET_STEP = 24;
// How far the prev-vs-pre-satellite bracket is lifted off the MIDDLE panel: its
// legs stop at panelTop-18, 3px clear of the top of that panel's year label, and
// its stars reach panelTop-36. Deliberately less than a full BRACKET_STEP —
// nothing is stacked under it, and every pixel of lift pulls it towards the
// panel above, which is the one panel it is NOT about.
const MID_BRACKET_LIFT = 14;

// Significance tier of a p-value: 0 = not significant, 1 = p<0.05, 2 = p<0.01,
// 3 = p<0.001. The single source for both the in-chart stars and the section's
// prose conclusion, so the asterisks and the words can never disagree.
function significanceTier(p: number): 0 | 1 | 2 | 3 {
  if (p < 0.001) return 3;
  if (p < 0.01) return 2;
  if (p < 0.05) return 1;
  return 0;
}

// Conventional significance stars, by tier ("ns" = not significant).
const TIER_STARS = ['ns', '*', '**', '***'];
function starsFor(p: number): string {
  return TIER_STARS[significanceTier(p)];
}

// How confidently the conclusion headline may claim a change, by tier. Tier 0
// never gets a direction — a test that didn't reject says nothing about which
// way the metric moved — so it has its own phrasing in changeVerdict.
const TIER_CONFIDENCE = ['', 'Probably', 'Very likely', 'Definitely'];

// Which way a positive / negative change reads, per metric. Shared by the
// conclusion headline and the verdict panel so both name the direction alike.
export const METRIC_DIRECTION_UP: Record<MetricKey, string> = {
  max_temperature: 'warmer',
  min_temperature: 'warmer',
  precipitation_sum: 'wetter',
  wind_speed_10m_max: 'windier',
};
export const METRIC_DIRECTION_DOWN: Record<MetricKey, string> = {
  max_temperature: 'cooler',
  min_temperature: 'cooler',
  precipitation_sum: 'drier',
  wind_speed_10m_max: 'calmer',
};

// The big line of the section's conclusion headline, completing the quiet lead
// "<metric> on <date> in <city> has …". Confidence comes from the p-value's
// tier (same one the stars encode), direction from the sign of the median
// difference the permutation test measured.
export function changeVerdict(pValue: number, observedDiff: number, metric: MetricKey): string {
  const tier = significanceTier(pValue);
  if (tier === 0) return 'Possibly not changed over the decades';
  const direction =
    observedDiff >= 0 ? METRIC_DIRECTION_UP[metric] : METRIC_DIRECTION_DOWN[metric];
  return `${TIER_CONFIDENCE[tier]} gotten ${direction} over the decades`;
}

interface BracketGeom { x0: number; x1: number; barY: number }

const PeriodHistogramChart: React.FC<PeriodHistogramChartProps> = ({
  filteredData,
  currentMetric,
  pValues,
  width: propWidth,
  panelHeight: propPanelHeight,
}) => {
  const { system } = useUnits();
  const theme = useThemeMode();
  // The three panels are inked from the era ramp, so a swatch picked in the
  // settings menu's era-colour picker (#73) has to re-run the draw.
  const eraColors = useEraColorOverrides();
  const svgRef = useRef<SVGSVGElement>(null);
  const tooltipRef = useRef<HTMLDivElement>(null);
  // Bracket geometry stashed by the main render so the separate p-value-keyed
  // effect can place each bracket's stars without recomputing it (and without
  // touching the bracket lines, which the main render already drew).
  const bracketGeomRef = useRef<Partial<Record<BracketKey, BracketGeom>>>({});

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

    const periods = buildPeriods(filteredData, currentMetric);
    if (periods.length === 0) return;
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

    // Axis domain matches the main chart's tempScale exactly (same pad formula,
    // same ≥0 floor) so the two x-axes line up on mobile.
    const pad = axisPad(currentMetric, system, axisMax - axisMin);
    const domainLo = nonNegative ? Math.max(0, axisMin - pad) : axisMin - pad;
    const domainHi = axisMax + pad;

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

    // Tooltip decimals: bin edges land on the BIN grid, and one decimal can't
    // tell imperial precip's 0.05-in edges apart (0.05 and 0.10 both → "0.1").
    const dp = BIN < 0.1 ? 2 : 1;
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
        // Ascending copy, sorted once, for the bins' percentile tooltips. A copy
        // because `values` is what the bins and the median were computed from.
        sorted: values.slice().sort(d3.ascending),
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

    // Each panel's median x, in display order (0 = newest on top, 2 = oldest at
    // the bottom). The significance brackets join pairs of these afterwards;
    // panels share one x range, so the values are directly comparable.
    const medianX: (number | null)[] = displayOrder.map(() => null);

    // Top of a panel, in `g` coordinates, by display index (0 = newest on top).
    // The brackets are drawn on `g` too, so they position off the same helper.
    const panelTopOf = (idx: number) => idx * (panelHeight + PANEL_GAP);

    displayOrder.forEach((pp, idx) => {
      const panelTop = panelTopOf(idx);
      const color = periodColor(currentMetric, pp.period.era, theme);

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
            `<strong>${pp.period.label}</strong><br/>${(b.x0 as number).toFixed(dp)}–${(b.x1 as number).toFixed(dp)}${unit}<br/>${binPercentileLabel(b.x0 as number, b.x1 as number, pp.sorted)}`
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
        // Record geometry for the significance brackets. mx is panel-local x
        // (panels share the same x range), so it's directly comparable; panel y
        // offsets are added when the brackets are drawn on `g`.
        medianX[idx] = mx;
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
              `<strong>${pp.period.label} ${statLabel.toLowerCase()}</strong><br/>${(pp.stat as number).toFixed(dp)}${unit}`
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

    // Significance brackets — the scientific-paper "⊓" joining the medians of
    // the two panels being compared, one per PAIR of eras, so all three pairs
    // are marked. The panels share one x axis, so a bracket's legs land on the x
    // of each compared median however far apart the panels are vertically.
    //
    // A bracket sits above the TOPMOST panel of the pair it compares (Ita,
    // 2026-09-18, overruling the earlier "one band of results at the top"):
    // the two latest-vs-* pairs stack above the top panel, while
    // prev-vs-pre-satellite sits in the gap above the MIDDLE panel — the first
    // panel it actually compares — so a reader meets each bracket where its own
    // eras are instead of decoding a three-high band that spans everything. In
    // the stack above the top panel the widest span stays outermost, so no
    // bracket is drawn inside another's footprint.
    //
    // The bracket LINES are drawn here, with the bars, since their geometry
    // doesn't depend on any p-value; only the stars do, and those are added by a
    // separate effect keyed on the p-values, so a bracket never flashes when a
    // worker result lands. That effect reads barY back out of bracketGeomRef and
    // puts the stars 3px above it, so it follows a bracket wherever it is drawn.
    bracketGeomRef.current = {};
    // `lift` is how many px the bracket is raised off `panelTop`: 0 hugs the
    // panel, and a stack raises each level by BRACKET_STEP.
    const drawBracket = (
      key: BracketKey,
      x0: number,
      x1: number,
      panelTop: number,
      lift: number
    ) => {
      const barY = panelTop - 10 - lift;
      const legBottomY = panelTop - 4 - lift;
      bracketGeomRef.current[key] = { x0, x1, barY };
      g.append('g')
        .attr('class', `sig-bracket sig-bracket-${key}`)
        .append('path')
        .attr('d', `M${x0},${legBottomY} L${x0},${barY} L${x1},${barY} L${x1},${legBottomY}`)
        .attr('fill', 'none');
    };
    // A pair's horizontal span, or null when either median is missing (too
    // little data in that era). medianX is in DISPLAY order: 0 = latest (top),
    // 1 = previous, 2 = pre-satellite.
    const span = (a: number | null, b: number | null) =>
      a == null || b == null ? null : { x0: Math.min(a, b), x1: Math.max(a, b) };

    // The two pairs the top panel is in, stacked above it, narrowest first.
    const topPairs: Array<{ key: BracketKey; x0: number; x1: number }> = (
      [
        { key: 'latestVsPrev' as BracketKey, s: span(medianX[0], medianX[1]) },
        { key: 'latestVsPresat' as BracketKey, s: span(medianX[0], medianX[2]) },
      ].filter((p) => p.s != null) as Array<{
        key: BracketKey;
        s: { x0: number; x1: number };
      }>
    )
      .map((p) => ({ key: p.key, x0: p.s.x0, x1: p.s.x1 }))
      // Narrowest first → level 0, closest to the panel; widest last → outermost.
      .sort((m, n) => m.x1 - m.x0 - (n.x1 - n.x0));
    topPairs.forEach(({ key, x0, x1 }, level) =>
      drawBracket(key, x0, x1, panelTopOf(0), level * BRACKET_STEP)
    );

    // Previous vs pre-satellite: in the gap above the MIDDLE panel, lifted just
    // far enough to clear that panel's right-aligned year label (PANEL_GAP is
    // sized for exactly this).
    const prevPresat = span(medianX[1], medianX[2]);
    if (prevPresat) {
      drawBracket(
        'prevVsPresat',
        prevPresat.x0,
        prevPresat.x1,
        panelTopOf(1),
        MID_BRACKET_LIFT
      );
    }

    // Shared x-axis under the bottom panel. tickCount() computed from the same
    // domain the main chart uses (default count for temp/wind, precip capped at
    // a 1 mm/0.05 in step), so the tick positions stay identical between the
    // two charts' shared axes.
    const xAxisG = g
      .append('g')
      .attr('class', 'axis')
      .attr('transform', `translate(0,${plotHeight})`)
      .call(
        d3.axisBottom(tempScale)
          .ticks(tickCount(currentMetric, system, domainHi - domainLo)) as any
      );
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

  }, [filteredData, currentMetric, width, panelHeight, plotHeight, system, theme, eraColors]);

  // Significance stars — placed (and updated) on their own, keyed on pValue, so
  // the permutation worker result landing only adds/fades in the stars text. The
  // bracket lines themselves are drawn by the main render with the bars, so they
  // never flash. The stars fade in late, which is fine — the p-value genuinely
  // isn't known until the worker returns.
  // Read out as scalars: `pValues` is built inline by the caller, so a fresh
  // object every render — keying the effect on it would re-place the stars on
  // any unrelated App re-render.
  const pLatestVsPrev = pValues?.latestVsPrev ?? null;
  const pLatestVsPresat = pValues?.latestVsPresat ?? null;
  const pPrevVsPresat = pValues?.prevVsPresat ?? null;

  useEffect(() => {
    if (!svgRef.current) return;
    const svg = d3.select(svgRef.current);
    const entries: Array<[BracketKey, number | null]> = [
      ['latestVsPrev', pLatestVsPrev],
      ['latestVsPresat', pLatestVsPresat],
      ['prevVsPresat', pPrevVsPresat],
    ];
    for (const [key, p] of entries) {
      const bracket = svg.select<SVGGElement>(`.sig-bracket-${key}`);
      if (bracket.empty()) continue;
      // Clear any prior stars so a p-value flip doesn't stack them.
      bracket.selectAll('.sig-stars').remove();
      const geom = bracketGeomRef.current[key];
      if (p == null || !geom) continue;
      const stars = starsFor(p);
      bracket
        .append('text')
        .attr('class', `sig-stars ${stars === 'ns' ? 'sig-ns' : ''}`)
        .attr('x', (geom.x0 + geom.x1) / 2)
        .attr('y', geom.barY - 3)
        .style('text-anchor', 'middle')
        .text(stars);
    }
    // Also re-runs after the main render (filteredData/metric rebuild the SVG and
    // the bracket lines, then this re-adds the stars onto the fresh brackets).
  }, [
    pLatestVsPrev,
    pLatestVsPresat,
    pPrevVsPresat,
    filteredData,
    currentMetric,
    width,
    panelHeight,
    plotHeight,
    system,
    theme,
  ]);

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

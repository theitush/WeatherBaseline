import React, { useEffect, useRef } from 'react';
import * as d3 from 'd3';
import type { WeatherDataPoint } from '../types';
import type { MetricKey } from '../utils/config';
import CONFIG from '../utils/config';
import { comparablePool } from '../utils/dataProcessor';
import {
  bandQuantilePoints,
  valueAtTailFraction,
  probabilityOneSided,
  probabilityBetween,
} from '../utils/confidence';
import { resolveForecastMarker } from '../utils/forecastReference';
import { placeTooltip } from '../utils/tooltip';
import { useUnits } from '../hooks/useUnits';
import { convert, unitLabel, binWidth, axisPad } from '../utils/units';
import './HistogramChart.css';

export type Orientation = 'horizontal' | 'vertical';

interface HistogramChartProps {
  filteredData: WeatherDataPoint[];
  currentMetric: MetricKey;
  currentDate: string;
  fullData: WeatherDataPoint[];
  // Full daily record (every day, all years) — the all-time pool the top card's
  // verdict tier uses, so the forecast's single reference line matches the card.
  yearTimeline: WeatherDataPoint[];
  orientation?: Orientation;
  width?: number;
  height?: number;
}

// horizontal: temp on Y (shared with MainChart on the left), count on X, bars grow →
// vertical:   temp on X (shared with MainChart below), count on Y, bars grow ↓ from top
const MARGIN_H = { top: 20, right: 100, bottom: 40, left: 15 };
const MARGIN_V = { top: 20, right: 20, bottom: 10, left: 55 };

/** Value at cumulative probability `u` on the piecewise-linear CDF through the
 *  ascending (p, v) quantile points — the inverse CDF, clamped to the ends. */
function invCdf(points: { p: number; v: number }[], u: number): number {
  const n = points.length;
  if (u <= points[0].p) return points[0].v;
  if (u >= points[n - 1].p) return points[n - 1].v;
  for (let i = 0; i < n - 1; i++) {
    const a = points[i];
    const b = points[i + 1];
    if (u >= a.p && u <= b.p) {
      return b.p === a.p ? a.v : a.v + ((u - a.p) / (b.p - a.p)) * (b.v - a.v);
    }
  }
  return points[n - 1].v;
}

/**
 * A smooth predictive-density curve for a forecast's own 9-point CDF: draw
 * pseudo-samples by inverse-transform sampling (evenly spaced in probability
 * over [p01, p99], so their empirical density mirrors the forecast), then
 * Gaussian-KDE them. Returns {t, d} points over the support, padded by ~1
 * bandwidth so the curve tapers toward 0 at the tails — the caller scales `d`
 * onto the count axis.
 *
 * `axisSpan` (the padded value-axis width, display units) is used only to floor
 * the bandwidth of a DEGENERATE band — all quantiles equal (e.g. a bone-dry
 * precip forecast whose every quantile trace-clamps to 0mm). That's a genuine
 * point mass, so there's no spread to smooth; rather than draw nothing we emit a
 * narrow spike centred on the value, which at the 0mm floor clips to a half-spike
 * piled on the axis — the honest "≈certainly 0mm" shape.
 */
function forecastDensityCurve(
  points: { p: number; v: number }[],
  axisSpan: number
): { t: number; d: number }[] {
  const N = 300;
  const M = 90;
  const samples: number[] = [];
  const pLo = points[0].p;
  const pHi = points[points.length - 1].p;
  for (let i = 0; i < N; i++) {
    samples.push(invCdf(points, pLo + (pHi - pLo) * ((i + 0.5) / N)));
  }
  samples.sort((a, b) => a - b);
  const lo = samples[0];
  const hi = samples[N - 1];
  if (hi - lo < 1e-9) {
    // Point mass: emit a narrow Gaussian spike centred on the value. `d` is
    // rescaled to the count axis by the caller, so the absolute height is
    // irrelevant — only the shape matters. bw is a small slice of the axis so
    // the spike stays visibly narrow at any zoom.
    const bw = Math.max(axisSpan / 28, 1e-6);
    const gLo = lo - 4 * bw;
    const gHi = lo + 4 * bw;
    const out: { t: number; d: number }[] = [];
    for (let j = 0; j <= M; j++) {
      const t = gLo + ((gHi - gLo) * j) / M;
      const z = (t - lo) / bw;
      out.push({ t, d: Math.exp(-0.5 * z * z) });
    }
    return out;
  }

  const sd = d3.deviation(samples) ?? 0;
  const iqr = (d3.quantile(samples, 0.75) as number) - (d3.quantile(samples, 0.25) as number);
  const spread = Math.min(sd || Infinity, iqr / 1.349 || Infinity);
  const sigma = Number.isFinite(spread) ? spread : sd || (hi - lo) / 4;
  const bw = Math.max(0.9 * sigma * Math.pow(N, -0.2), (hi - lo) / 60);

  const gLo = lo - 1.2 * bw;
  const gHi = hi + 1.2 * bw;
  const inv2h2 = 1 / (2 * bw * bw);
  const norm = 1 / (N * bw * Math.sqrt(2 * Math.PI));
  const out: { t: number; d: number }[] = [];
  for (let j = 0; j <= M; j++) {
    const t = gLo + ((gHi - gLo) * j) / M;
    let s = 0;
    for (let k = 0; k < N; k++) {
      const z = t - samples[k];
      s += Math.exp(-z * z * inv2h2);
    }
    out.push({ t, d: s * norm });
  }
  return out;
}

const HistogramChart: React.FC<HistogramChartProps> = ({
  filteredData,
  currentMetric,
  currentDate,
  fullData,
  yearTimeline,
  orientation = 'horizontal',
  width: propWidth,
  height: propHeight,
}) => {
  const svgRef = useRef<SVGSVGElement>(null);
  const tooltipRef = useRef<HTMLDivElement>(null);

  const { system } = useUnits();

  const isVertical = orientation === 'vertical';
  const MARGIN = isVertical ? MARGIN_V : MARGIN_H;
  const TOTAL_WIDTH = propWidth ?? (isVertical ? 360 : 260);
  const TOTAL_HEIGHT = propHeight ?? (isVertical ? 180 : 400);

  const width = TOTAL_WIDTH - MARGIN.left - MARGIN.right;
  const height = TOTAL_HEIGHT - MARGIN.top - MARGIN.bottom;

  useEffect(() => {
    if (!svgRef.current || filteredData.length === 0) return;

    const svg = d3.select(svgRef.current);
    svg.selectAll('*').remove();

    // Unique per redraw so the confidence-shade clipPath id can't collide with
    // the sibling chart instance (horizontal + vertical share the document).
    const uid = Math.random().toString(36).slice(2, 8);

    const g = svg
      .append('g')
      .attr('transform', `translate(${MARGIN.left},${MARGIN.top})`);

    const tooltip = d3.select(tooltipRef.current);

    // Drop forecasts past the selected target date; forecast rows at/before it
    // are recent reanalysis-quality and kept. Shared with the prose verdict via
    // comparablePool so both percentages run off the identical pool.
    const values = comparablePool(filteredData, currentDate)
      .map((d) => d[currentMetric])
      .filter((v): v is number => v !== undefined)
      .map((v) => convert(v, currentMetric, system));

    if (values.length === 0) return;

    // Axis domain must match MainChart's tempScale EXACTLY so the shared
    // current-temp line lands at the same pixel in both charts. That means:
    //   (a) compute extent over the same rows MainChart uses — ALL filteredData
    //       incl. forecast (the bins/percentiles still exclude forecast above,
    //       but the *axis* range mustn't), and
    //   (b) apply the same ≥0 floor for precip/wind.
    // Previously the histogram dropped forecast rows and skipped the floor, so
    // the precip target line drifted relative to the main graph.
    const axisValues = filteredData
      .map((d) => d[currentMetric])
      .filter((v): v is number => v !== undefined)
      .map((v) => convert(v, currentMetric, system));
    const [minVal, maxVal] = d3.extent(axisValues) as [number, number];
    const nonNegative =
      currentMetric === 'precipitation_sum' || currentMetric === 'wind_speed_10m_max';
    const pad = axisPad(currentMetric, system, maxVal - minVal);
    const domLo = nonNegative ? Math.max(0, minVal - pad) : minVal - pad;
    const domHi = maxVal + pad;

    // Temp scale: vertical-orientation puts temp on X (left→right);
    // horizontal-orientation keeps temp on Y (bottom→top, original).
    const tempScale = d3
      .scaleLinear()
      .domain([domLo, domHi])
      .range(isVertical ? [0, width] : [height, 0]);

    // Adaptive-width bins anchored to a unit grid, rather than a fixed bin
    // *count*. A fixed count made narrow-range places (e.g. tropical tmin) get
    // sub-0.1° bins → jagged, sparse-looking bars. binWidth() picks a "nice"
    // width from the data span so Zanzibar gets enough bars and Moscow not too
    // many. The span is the padded axis span (domainHi−domainLo) computed the
    // SAME way as PeriodHistogramChart so both charts land on identical bin
    // edges and the shared current-temp line never drifts between them.
    const [domainLo, domainHi] = tempScale.domain() as [number, number];
    const BIN = binWidth(currentMetric, system, domainHi - domainLo);
    const binLo = Math.floor(domainLo / BIN) * BIN;
    const binHi = Math.ceil(domainHi / BIN) * BIN;
    const bins = d3
      .bin()
      .domain([binLo, binHi])
      .thresholds(d3.range(binLo, binHi + BIN, BIN))(values);

    // Count scale: horizontal mode → X (0→width); vertical mode → Y (0 at top → max at bottom, bars hang down)
    const countScale = d3
      .scaleLinear()
      .domain([0, d3.max(bins, (d) => d.length) as number])
      .range(isVertical ? [height, 0] : [0, width])
      .clamp(true);
    // Linear length used for bar sizing (always 0 → size).
    const countLen = d3
      .scaleLinear()
      .domain([0, d3.max(bins, (d) => d.length) as number])
      .range([0, isVertical ? height : width]);

    const unit = unitLabel(currentMetric, system);

    // Full-strength metric hue — used to ink the span brackets and their % labels
    // so they read as part of the metric's family rather than neutral grey chrome.
    const metricColor = CONFIG.metricColors[currentMetric]?.base ?? 'var(--chart-label)';

    // Bin edges land on the BIN grid; one decimal can't tell imperial precip's
    // 0.05-in edges apart (0.05 and 0.10 both round to "0.1").
    const dp = BIN < 0.1 ? 2 : 1;

    // Bars (animate count dimension from 0 on enter). The 1px gap on the temp
    // axis leaves thin white separators between bins, matching the period hists.
    const barSel = g.selectAll('.bar')
      .data(bins)
      .enter()
      .append('rect')
      .attr('class', 'bar')
      .attr('fill', CONFIG.getColorForElement(currentMetric, 'histogramBars'));

    if (isVertical) {
      // Bars grow upward from the bottom baseline: x is the temp bin span, y is baseline minus bar height.
      barSel
        .attr('x', (d) => tempScale(d.x0 as number) + 0.5)
        .attr('y', height)
        .attr('width', (d) => Math.max(0, tempScale(d.x1 as number) - tempScale(d.x0 as number) - 1))
        .attr('height', 0)
        .transition()
        .duration(500)
        .attr('y', (d) => height - countLen(d.length))
        .attr('height', (d) => countLen(d.length));
    } else {
      barSel
        .attr('x', 0)
        .attr('y', (d) => tempScale(d.x1 as number) + 0.5)
        .attr('width', 0)
        .attr('height', (d) => Math.max(0, tempScale(d.x0 as number) - tempScale(d.x1 as number) - 1))
        .transition()
        .duration(500)
        .attr('width', (d) => countLen(d.length));
    }

    // Transparent full-extent hit areas, one per non-empty bin, so the tooltip
    // triggers anywhere in the bin's row/column — a 1-day bar is only a sliver
    // and near-impossible to point at directly. Appended after the bars so they
    // capture the mouse (same approach as PeriodHistogramChart).
    const showTip = (event: MouseEvent, d: d3.Bin<number, number>) => {
      tooltip
        .style('opacity', 1)
        .html(
          `${(d.x0 as number).toFixed(dp)}–${(d.x1 as number).toFixed(dp)}${unit}<br/>${d.length} day${d.length === 1 ? '' : 's'}`
        );
      placeTooltip(tooltipRef.current, event);
    };
    const hitSel = g.selectAll('rect.bar-hit')
      .data(bins.filter((d) => d.length > 0))
      .enter()
      .append('rect')
      .attr('class', 'bar-hit')
      .attr('fill', 'transparent')
      .on('mouseover', showTip)
      .on('mousemove', showTip)
      .on('mouseout', () => tooltip.style('opacity', 0));

    if (isVertical) {
      hitSel
        .attr('x', (d) => tempScale(d.x0 as number) + 0.5)
        .attr('width', (d) => Math.max(0, tempScale(d.x1 as number) - tempScale(d.x0 as number) - 1))
        .attr('y', 0)
        .attr('height', height);
    } else {
      hitSel
        .attr('x', 0)
        .attr('width', width)
        .attr('y', (d) => tempScale(d.x1 as number) + 0.5)
        .attr('height', (d) => Math.max(0, tempScale(d.x0 as number) - tempScale(d.x1 as number) - 1));
    }

    // Count axis
    if (isVertical) {
      // Count axis on the left (top=0, bottom=max). We label inline rather than a full axis to keep it tidy.
      g.append('g')
        .attr('class', 'axis')
        .call(d3.axisLeft(countScale).ticks(3));
      g.append('text')
        .attr('transform', 'rotate(-90)')
        .attr('y', -MARGIN.left + 12)
        .attr('x', -height / 2)
        .attr('dy', '1em')
        .style('text-anchor', 'middle')
        .style('font-size', '12px')
        .style('fill', 'var(--chart-label)')
        .text('Count');
    } else {
      g.append('g')
        .attr('class', 'axis')
        .attr('transform', `translate(0,${height})`)
        .call(d3.axisBottom(countScale).ticks(4));
      g.append('text')
        .attr('transform', `translate(${width / 2},${height + 35})`)
        .style('text-anchor', 'middle')
        .style('font-size', '12px')
        .style('fill', 'var(--chart-label)')
        .text('Count');
    }

    // A line perpendicular to the temp axis at temp `t` (display units) — the
    // straight target line (history) and the forecast reference line share it.
    const perpLine = (t: number) => {
      const el = g.append('line');
      if (isVertical) {
        el.attr('x1', tempScale(t)).attr('x2', tempScale(t)).attr('y1', 0).attr('y2', height);
      } else {
        el.attr('x1', 0).attr('x2', width).attr('y1', tempScale(t)).attr('y2', tempScale(t));
      }
      return el;
    };

    // Historical climatology pool (display units) for the bracket %s and the
    // forecast reference line. EXCLUDES look-ahead forecast rows so a future
    // target's own forecast days can't inflate the counts (that's what made the
    // two brackets sum to >100%); on a settled past target there are none, so
    // this is the old pool unchanged.
    const histRowsNative = comparablePool(filteredData, currentDate)
      .filter((d) => d.data_type !== 'forecast')
      .map((d) => d[currentMetric])
      .filter((v): v is number => typeof v === 'number' && Number.isFinite(v));
    const histValues = histRowsNative.map((v) => convert(v, currentMetric, system));

    // Percentage labels for a pivot partition (display units): the share of the
    // HISTORICAL pool strictly below vs. at-or-above `pivot`, so the two slices
    // sum to exactly 100%. `exact` overrides with the verdict tier's canonical
    // percentage (5/10/20) instead of the day-fraction — on a forecast the
    // reference line is snapped to a data point, so counting days at/above it
    // lands 1–3% off the cutoff the top card actually compares to. The brackets
    // themselves are drawn by drawSpanPartition below.
    const fmtPct = (p: number) => (Number.isInteger(p) ? p.toFixed(0) : p.toFixed(1)) + '%';
    const pivotLabels = (
      pivot: number,
      exact?: { pct: number; isHighSide: boolean }
    ): { lower: string; higher: string } => {
      if (exact) {
        return {
          lower: fmtPct(exact.isHighSide ? 100 - exact.pct : exact.pct),
          higher: fmtPct(exact.isHighSide ? exact.pct : 100 - exact.pct),
        };
      }
      const total = histValues.length;
      if (total === 0) return { lower: fmtPct(0), higher: fmtPct(0) };
      return {
        lower: fmtPct((histValues.filter((v) => v < pivot).length / total) * 100),
        higher: fmtPct((histValues.filter((v) => v >= pivot).length / total) * 100),
      };
    };

    // One curly-brace bracket spanning temps [lo, hi], drawn to the side of the
    // temp axis and labelled at its middle. Ends are clamped to the DATA extent
    // (first/last non-empty bin) plus a few px, NOT the padded axis edge, so the
    // outermost brackets reach the last bars instead of hugging the plot corner.
    // A span shorter than `minSpan` is skipped — that's what collapses a
    // degenerate tail (e.g. rain's p20 sitting on the 0 floor) from three brackets
    // down to two. The cap radius shrinks with the span so short tail brackets
    // stay clean. `minSpan` is relaxable per-call: the lone middle-60% bracket
    // passes a smaller floor so a right-skewed precip band ([0, a few mm] against
    // a storm-stretched axis) still renders instead of vanishing.
    const BRACKET_W = 14;
    const EDGE_PAD = 4;
    const MIN_SPAN = 14;
    // Pixel span actually covered by bars (first→last non-empty bin edge). Clamp
    // bracket ends to this ± EDGE_PAD so they land on the data, not the axis
    // padding. For precip the common 0-floor bin runs to the very edge, so the low
    // end correctly clamps flush against it.
    const nonEmptyBins = bins.filter((d) => d.length > 0);
    const dataLoT = nonEmptyBins.length ? nonEmptyBins[0].x0! : domainLo;
    const dataHiT = nonEmptyBins.length
      ? nonEmptyBins[nonEmptyBins.length - 1].x1!
      : domainHi;
    const dataPxLo = Math.min(tempScale(dataLoT), tempScale(dataHiT));
    const dataPxHi = Math.max(tempScale(dataLoT), tempScale(dataHiT));
    const clampSpan = (v: number, max: number) =>
      Math.max(
        Math.max(0, dataPxLo - EDGE_PAD),
        Math.min(Math.min(max, dataPxHi + EDGE_PAD), v)
      );
    const drawSpanBracket = (lo: number, hi: number, label: string, minSpan = MIN_SPAN) => {
      if (!isVertical) {
        const rightX = width + 8;
        const yHi = clampSpan(tempScale(hi), height); // higher temp → smaller y
        const yLo = clampSpan(tempScale(lo), height);
        const span = yLo - yHi;
        if (span < minSpan) return false;
        const cap = Math.min(8, span / 4);
        const yMid = (yHi + yLo) / 2;
        g.append('path')
          .attr(
            'd',
            `M ${rightX} ${yHi}
             Q ${rightX + BRACKET_W * 0.5} ${yHi} ${rightX + BRACKET_W * 0.5} ${yHi + cap}
             L ${rightX + BRACKET_W * 0.5} ${yMid - cap}
             Q ${rightX + BRACKET_W * 0.5} ${yMid} ${rightX + BRACKET_W} ${yMid}
             Q ${rightX + BRACKET_W * 0.5} ${yMid} ${rightX + BRACKET_W * 0.5} ${yMid + cap}
             L ${rightX + BRACKET_W * 0.5} ${yLo - cap}
             Q ${rightX + BRACKET_W * 0.5} ${yLo} ${rightX} ${yLo}`
          )
          .attr('stroke', metricColor)
          .attr('stroke-width', 1.5)
          .attr('fill', 'none');
        g.append('text')
          .attr('x', rightX + BRACKET_W + 6)
          .attr('y', yMid)
          .attr('dy', '0.35em')
          .attr('text-anchor', 'start')
          .style('font-size', '12px')
          .style('fill', metricColor)
          .text(label);
      } else {
        const topY = -8;
        const xLo = clampSpan(tempScale(lo), width);
        const xHi = clampSpan(tempScale(hi), width);
        const span = xHi - xLo;
        if (span < minSpan) return false;
        const cap = Math.min(8, span / 4);
        const xMid = (xLo + xHi) / 2;
        g.append('path')
          .attr(
            'd',
            `M ${xLo} ${topY}
             Q ${xLo} ${topY - BRACKET_W * 0.5} ${xLo + cap} ${topY - BRACKET_W * 0.5}
             L ${xMid - cap} ${topY - BRACKET_W * 0.5}
             Q ${xMid} ${topY - BRACKET_W * 0.5} ${xMid} ${topY - BRACKET_W}
             Q ${xMid} ${topY - BRACKET_W * 0.5} ${xMid + cap} ${topY - BRACKET_W * 0.5}
             L ${xHi - cap} ${topY - BRACKET_W * 0.5}
             Q ${xHi} ${topY - BRACKET_W * 0.5} ${xHi} ${topY}`
          )
          .attr('stroke', metricColor)
          .attr('stroke-width', 1.5)
          .attr('fill', 'none');
        g.append('text')
          .attr('x', xMid)
          .attr('y', topY - BRACKET_W - 4)
          .attr('text-anchor', 'middle')
          .style('font-size', '12px')
          .style('fill', metricColor)
          .text(label);
      }
      return true;
    };

    // Partition the temp axis at the interior `pivots` (ascending) and draw one
    // span bracket per resulting slice, low→high, labelled by `segLabels`
    // (pivots.length + 1 of them). Slices too short to render are dropped by
    // drawSpanBracket, so a pivot on the axis floor yields fewer brackets.
    const drawSpanPartition = (pivots: number[], segLabels: string[]) => {
      const [dLo, dHi] = tempScale.domain() as [number, number];
      const bounds = [dLo, ...pivots, dHi];
      segLabels.forEach((label, i) => drawSpanBracket(bounds[i], bounds[i + 1], label));
    };

    // Like drawSpanPartition, but LABELS each slice by the pool's ACTUAL day-share
    // rather than a fixed number, and MERGES any slice too thin to draw into the
    // next one. This is what a partition whose pivots are climatology percentiles
    // needs: when a rain day's p20 (and maybe p80) sit on the 0 floor, the empty
    // bottom slice folds away and its share rolls into the neighbour, so the
    // visible brackets always sum to 100% — e.g. 80% / 20% (p20 at 0) or a single
    // 100% (near-always-dry) instead of a mislabeled 60%/20% or lone 20%.
    const drawSharePartition = (pivots: number[]) => {
      const [dLo, dHi] = tempScale.domain() as [number, number];
      const axisMax = isVertical ? width : height;
      const axisPx = (v: number) => clampSpan(tempScale(v), axisMax);
      const bounds = [dLo, ...pivots, dHi];
      // Keep a boundary only if it's ≥ MIN_SPAN pixels past the last kept cut, so
      // every surviving slice is actually drawable.
      const cuts = [bounds[0]];
      for (let i = 1; i < bounds.length - 1; i++) {
        if (Math.abs(axisPx(bounds[i]) - axisPx(cuts[cuts.length - 1])) >= MIN_SPAN) {
          cuts.push(bounds[i]);
        }
      }
      cuts.push(bounds[bounds.length - 1]);
      // If the final slice is thin, fold it back by dropping the penultimate cut.
      if (
        cuts.length >= 3 &&
        Math.abs(axisPx(cuts[cuts.length - 1]) - axisPx(cuts[cuts.length - 2])) < MIN_SPAN
      ) {
        cuts.splice(cuts.length - 2, 1);
      }
      const total = histValues.length;
      // Draw each slice, forcing the running total to exactly 100 (last gets the
      // remainder) so rounding can't make the labels miss 100.
      let acc = 0;
      for (let i = 0; i < cuts.length - 1; i++) {
        const isLast = i === cuts.length - 2;
        const pct = isLast
          ? 100 - acc
          : total
            ? Math.round(
                (histValues.filter((v) => v >= cuts[i] && v < cuts[i + 1]).length / total) * 100
              )
            : 0;
        acc += pct;
        drawSpanBracket(cuts[i], cuts[i + 1], `${pct}%`);
      }
    };

    // Target-day overlay.
    //   • FORECAST (a band is present): draw the forecast's own predictive
    //     density — a KDE of its 9-point CDF, half-height, spanning only its
    //     support — PLUS a single faint reference line at the exact climatology
    //     value the top card's verdict tier compares to (resolveForecastMarker
    //     is THE shared tier resolver the card runs off too), with the brackets
    //     pivoting on that line.
    //   • HISTORY (no band): the original straight "this is today" dashed line at
    //     the settled value, with the brackets pivoting on it.
    const targetDate = new Date(currentDate + 'T12:00:00');
    const currentRow = fullData.find(
      (d) =>
        d.date.getFullYear() === targetDate.getFullYear() &&
        d.date.getMonth() === targetDate.getMonth() &&
        d.date.getDate() === targetDate.getDate() &&
        d[currentMetric] !== undefined
    );

    if (currentRow) {
      const [domLo2, domHi2] = tempScale.domain() as [number, number];
      const band = currentRow.band?.[currentMetric];

      if (band) {
        // The forecast's own 9-point predictive CDF (display units) — the source
        // for the KDE overlay, the confidence shade, and the CQR exceedance test.
        const bandPoints = bandQuantilePoints(band, currentMetric, system);
        // Forecast KDE. A degenerate (point-mass) band renders as a narrow spike
        // rather than nothing — see forecastDensityCurve.
        const density = forecastDensityCurve(bandPoints, domHi2 - domLo2).filter(
          (pt) => pt.t >= domLo2 && pt.t <= domHi2
        );

        // The verdict tier + its climatology reference value: same tier the top
        // card fires (native, unit-agnostic), then the tier's cutoff value read
        // off the matching pool in DISPLAY units. Runs off the SAME historical
        // pool as the brackets. For one-sided (tail) tiers refValue is the
        // threshold the confidence test checks against (= the confidence-shade
        // edge below); mild tiers are two-sided and use loT/hiT instead, so
        // refValue is unused there.
        const allHistNative = comparablePool(yearTimeline, currentDate)
          .filter((d) => d.data_type !== 'forecast')
          .map((d) => d[currentMetric])
          .filter((v): v is number => typeof v === 'number' && Number.isFinite(v));
        const marker = resolveForecastMarker(band.mid, histRowsNative, allHistNative, true);
        const poolConv = marker
          ? (marker.tierUsesAllTime ? allHistNative : histRowsNative).map((v) =>
              convert(v, currentMetric, system)
            )
          : [];
        const refValue =
          marker == null
            ? 0
            : valueAtTailFraction(poolConv, marker.tierCutoff, marker.isHighSide);

        if (density.length >= 2) {
          // Peak → HALF the count axis so the curve reads as an overlay, not a
          // competing bar; it tapers to ~0 at the support ends.
          const maxD = d3.max(density, (pt) => pt.d) as number;
          const kdeLen = d3
            .scaleLinear()
            .domain([0, maxD])
            .range([0, (isVertical ? height : width) / 2]);

          // Confidence shade: fill the slice of the forecast density that lands in
          // the region the verdict claims, and print that region's probability —
          // the SAME CQR exceedance the card's bottom line states ("~80% chance
          // this day will be …"). One-sided tiers shade the tail past refValue;
          // mild tiers shade the two-sided [p20,p80] middle-60% band.
          // Skipped on a thin pool, matching the prose's n≥5 gate.
          if (marker && histValues.length >= 5) {
            const loT = valueAtTailFraction(poolConv, marker.tierCutoff, false);
            const hiT = valueAtTailFraction(poolConv, marker.tierCutoff, true);
            // Degenerate middle band: p20 == p80 (a bone-dry precip window, both on
            // the 0mm floor). The two-sided [p20,p80] region collapses to a point, so
            // there's nothing to hatch. Treat it as the one-sided "dry" claim it
            // really is: shade the dry spike up to the first populated bin's top edge
            // (the same range the fallback bracket labels ~99%) and grade it by the
            // forecast's probability of staying dry.
            const degenerate =
              marker.tierTwoSided && Math.abs(hiT - loT) < 1e-6 && nonEmptyBins.length > 0;
            const dryEdge = degenerate ? nonEmptyBins[0].x1! : hiT;
            const p = degenerate
              ? probabilityOneSided(bandPoints, dryEdge, false)
              : marker.tierTwoSided
                ? probabilityBetween(bandPoints, loT, hiT)
                : probabilityOneSided(bandPoints, refValue, marker.isHighSide);

            // Region bounds on the temp axis (display units), clamped to the drawn
            // support so the clip rect never spills past the curve.
            let regLo: number;
            let regHi: number;
            if (degenerate) {
              regLo = domLo2;
              regHi = dryEdge;
            } else if (marker.tierTwoSided) {
              regLo = loT;
              regHi = hiT;
            } else if (marker.isHighSide) {
              regLo = refValue;
              regHi = domHi2;
            } else {
              regLo = domLo2;
              regHi = refValue;
            }
            regLo = Math.max(domLo2, Math.min(domHi2, regLo));
            regHi = Math.max(domLo2, Math.min(domHi2, regHi));

            // Clip the full-support fill to the region — a rect in g-local coords,
            // so the fill edge lands exactly on the reference line's pixel.
            const clipId = `conf-shade-${uid}`;
            const hatchId = `conf-hatch-${uid}`;
            const defs = svg.append('defs');
            // Diagonal-hatch fill in the KDE-line ink so the claimed region reads
            // as a textured overlay, denser than a flat wash but not a solid block.
            defs
              .append('pattern')
              .attr('id', hatchId)
              .attr('patternUnits', 'userSpaceOnUse')
              .attr('width', 6)
              .attr('height', 6)
              .attr('patternTransform', 'rotate(45)')
              .append('line')
              .attr('x1', 0)
              .attr('y1', 0)
              .attr('x2', 0)
              .attr('y2', 6)
              .attr('stroke', 'var(--text-h)')
              .attr('stroke-width', 1.4)
              .attr('stroke-opacity', 0.5);
            const clipRect = defs.append('clipPath').attr('id', clipId).append('rect');
            if (isVertical) {
              clipRect
                .attr('x', tempScale(regLo))
                .attr('width', Math.max(0, tempScale(regHi) - tempScale(regLo)))
                .attr('y', 0)
                .attr('height', height);
            } else {
              clipRect
                .attr('x', 0)
                .attr('width', width)
                .attr('y', tempScale(regHi))
                .attr('height', Math.max(0, tempScale(regLo) - tempScale(regHi)));
            }

            const area = d3.area<{ t: number; d: number }>().curve(d3.curveBasis);
            if (isVertical) {
              area
                .x((pt) => tempScale(pt.t))
                .y0(height)
                .y1((pt) => height - kdeLen(pt.d));
            } else {
              area
                .y((pt) => tempScale(pt.t))
                .x0(0)
                .x1((pt) => kdeLen(pt.d));
            }
            g.append('path')
              .attr('class', 'forecast-conf-shade')
              .attr('clip-path', `url(#${clipId})`)
              .attr('fill', `url(#${hatchId})`)
              .attr('d', area(density) as string)
              .style('opacity', 0)
              .transition()
              .duration(500)
              .style('opacity', 1);

            // Label the shaded lobe with its probability, sitting on the OUTSIDE of
            // the KDE curve (the empty side, away from the hatched fill) right next
            // to the shaded region rather than buried inside the hatch. Anchor it at
            // the GEOMETRIC middle of the visibly-shaded extent: trim the near-zero
            // density tail (the KDE's padded shoulder), take the midpoint of what's
            // left, then step just past the curve at that point. Inked to match the
            // hatch exactly — KDE ink at the stripes' own opacity, no outline.
            // Rounded to 5% / capped at 95% to match the card.
            const regionPts = density.filter((pt) => pt.t >= regLo && pt.t <= regHi);
            if (regionPts.length) {
              const maxRegD = d3.max(regionPts, (pt) => pt.d) as number;
              // A degenerate KDE (every density NaN, e.g. a forecast tier that
              // hasn't been topped up yet) leaves nothing above the trim
              // threshold, and reduce() on an empty array throws — taking the
              // whole chart down with it. Fall back to the untrimmed region.
              const trimmed = regionPts.filter((pt) => pt.d >= 0.08 * maxRegD);
              const solid = trimmed.length ? trimmed : regionPts;
              const tMin = d3.min(solid, (pt) => pt.t) as number;
              const tMax = d3.max(solid, (pt) => pt.t) as number;
              const cT = (tMin + tMax) / 2;
              const centre = solid.reduce((a, b) =>
                Math.abs(b.t - cT) < Math.abs(a.t - cT) ? b : a
              );
              const chance = Math.min(95, Math.round(p * 20) * 5);
              // Nudge past the curve, on the far side from the axis-anchored fill.
              // Enough clearance that the glyphs don't graze the dashed KDE line.
              const PAD = 20;
              g.append('text')
                .attr('class', 'forecast-conf-label')
                .attr('x', isVertical ? tempScale(centre.t) : kdeLen(centre.d) + PAD)
                .attr('y', isVertical ? height - kdeLen(centre.d) - PAD : tempScale(centre.t))
                .attr('dy', isVertical ? '0' : '0.35em')
                .attr('text-anchor', isVertical ? 'middle' : 'start')
                .style('font-size', '12px')
                .style('fill', 'var(--text-h)')
                .style('fill-opacity', 0.5)
                .style('opacity', 0)
                .text(`~${chance}%`)
                .transition()
                .duration(500)
                .style('opacity', 1);
            }
          }

          // The KDE curve itself, on top of the shade.
          const line = d3.line<{ t: number; d: number }>().curve(d3.curveBasis);
          if (isVertical) {
            line.x((pt) => tempScale(pt.t)).y((pt) => height - kdeLen(pt.d));
          } else {
            line.x((pt) => kdeLen(pt.d)).y((pt) => tempScale(pt.t));
          }
          g.append('path')
            .attr('class', 'forecast-kde')
            .attr('fill', 'none')
            .attr('stroke', 'var(--text-h)')
            // Match the "today" marker line (MainChart's current-temp-line) so the
            // single dashed target-day legend entry reads true in both modes.
            .attr('stroke-width', 1.5)
            .attr('stroke-dasharray', '5,5')
            .attr('d', line(density))
            .style('opacity', 0)
            .transition()
            .duration(500)
            .style('opacity', 1);

          // Extend MainChart's value line to the KDE's median. band.mid is the
          // forecast median = the value the dot/line sits at, so a dashed segment at
          // that temperature — from the edge the two charts share, out to the density
          // curve at the median — reads as the value line continuing into, and
          // terminating at, the middle of the forecast's own distribution.
          //   • desktop (horizontal): the histogram abuts MainChart on the right, so
          //     start at this SVG's left edge (= MainChart's plot-right edge).
          //   • mobile (vertical): the histogram sits above MainChart sharing the temp
          //     X-axis, so start at this SVG's bottom edge (facing MainChart below).
          const medianT = convert(band.mid, currentMetric, system);
          if (medianT >= domLo2 && medianT <= domHi2) {
            // Density at the median temp, interpolated over the drawn curve.
            const densityAt = (t: number): number => {
              if (t <= density[0].t) return density[0].d;
              if (t >= density[density.length - 1].t) return density[density.length - 1].d;
              for (let i = 0; i < density.length - 1; i++) {
                const a = density[i];
                const b = density[i + 1];
                if (t >= a.t && t <= b.t) {
                  return b.t === a.t ? a.d : a.d + ((t - a.t) / (b.t - a.t)) * (b.d - a.d);
                }
              }
              return 0;
            };
            const connector = g.append('line')
              .attr('class', 'kde-median-connector')
              .attr('stroke', 'var(--text-h)')
              .attr('stroke-width', 1.5)
              .attr('stroke-dasharray', '5,5')
              .style('opacity', 0);
            if (isVertical) {
              connector
                .attr('x1', tempScale(medianT))
                .attr('x2', tempScale(medianT))
                .attr('y1', height + MARGIN.bottom) // SVG bottom edge, toward MainChart below
                .attr('y2', height - kdeLen(densityAt(medianT)));
            } else {
              connector
                .attr('x1', -MARGIN.left) // SVG left edge = MainChart's plot-right edge
                .attr('x2', kdeLen(densityAt(medianT)))
                .attr('y1', tempScale(medianT))
                .attr('y2', tempScale(medianT));
            }
            connector.transition().duration(500).style('opacity', 1);
          }
        }

        if (marker && marker.tierTwoSided) {
          // Middle 60% (mild): the verdict is graded against the [p20, p80] band,
          // so mark JUST that band — faint lines at p20 & p80 and a single span
          // bracket over the middle, labelled a fixed "60%". We deliberately don't
          // draw the bottom/top-20% brackets or count the exact enclosed day-share:
          // the band is 60% by construction, and snapping loT/hiT to data points
          // would make a counted label read 59%/62% instead. The forecast's OWN
          // chance of landing in the middle is the ~X% shade label drawn above.
          const loT = valueAtTailFraction(poolConv, marker.tierCutoff, false);
          const hiT = valueAtTailFraction(poolConv, marker.tierCutoff, true);
          for (const t of [loT, hiT]) {
            // Skip a boundary line pinned to the axis floor/ceiling (e.g. rain's
            // p20 at 0) — it would just trace the baseline.
            if (t <= domLo2 || t >= domHi2) continue;
            perpLine(t)
              .attr('class', 'forecast-ref-line')
              .attr('stroke', 'var(--text-tertiary)')
              .attr('stroke-width', 1)
              .attr('stroke-dasharray', '4,3')
              .style('opacity', 0.4);
          }
          // Relaxed minSpan so a floor-hugging precip band (p20 at 0mm, p80 a few
          // mm, against an axis stretched to storm days) still renders its bracket
          // instead of being skipped for being too short.
          const drewMild = drawSpanBracket(loT, hiT, '60%', 6);
          // Fully-degenerate band: a bone-dry window where p20 = p80 = 0mm on the
          // axis floor, so the middle-60% bracket collapses to zero span and the
          // "60%" label is meaningless anyway. Rather than draw nothing, fall back
          // to the real climatology split (same share-partition the settled view
          // uses): bracket the dry spike labelled with its ACTUAL day-share and the
          // wet remainder with its own — e.g. ~99% dry / ~1% wet — pivoting on the
          // top of the first populated bin.
          if (!drewMild && nonEmptyBins.length) {
            drawSharePartition([nonEmptyBins[0].x1!]);
          }
        } else if (marker) {
          perpLine(refValue)
            .attr('class', 'forecast-ref-line')
            .attr('stroke', 'var(--text-tertiary)')
            .attr('stroke-width', 1)
            .attr('stroke-dasharray', '4,3')
            .style('opacity', 0.4);
          // Partition at the reference line. Label the verdict side with the
          // tier's canonical % (5/10/20) — the exact figure the top card compares
          // to, not the ref line's snapped day-fraction. All-time has no canonical
          // %, so it keeps the honest day-fraction.
          const exact =
            marker.tier === 'alltime'
              ? undefined
              : { pct: marker.tierCutoff * 100, isHighSide: marker.isHighSide };
          const { lower, higher } = pivotLabels(refValue, exact);
          drawSpanPartition([refValue], [lower, higher]);
        }
      } else {
        // Settled history: straight dashed "this is today" line + the climatology
        // partition (share of days below vs. at-or-above it) in span brackets.
        const currentTemp = convert(currentRow[currentMetric] as number, currentMetric, system);
        perpLine(currentTemp)
          .attr('class', 'current-temp-line')
          .attr('stroke', 'var(--text-h)')
          // Same style as the forecast-KDE marker and MainChart's today line, so
          // the shared dashed target-day legend entry matches whichever draws.
          .attr('stroke-width', 1.5)
          .attr('stroke-dasharray', '5,5');
        drawSharePartition([currentTemp]);
      }
    }

    // Legend is rendered as an HTML element above the charts for both
    // mobile and desktop (see App.tsx).

  }, [filteredData, currentMetric, currentDate, fullData, yearTimeline, width, height, isVertical, system]);

  return (
    <div className="histogram-chart-wrapper">
      <svg
        ref={svgRef}
        width={TOTAL_WIDTH}
        height={TOTAL_HEIGHT}
        className="histogram-chart-svg"
      />
      <div ref={tooltipRef} className="chart-tooltip" />
    </div>
  );
};

export default HistogramChart;

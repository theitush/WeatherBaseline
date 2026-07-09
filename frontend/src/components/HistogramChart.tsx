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
 * onto the count axis. Empty when the band is degenerate (all quantiles equal,
 * e.g. a bone-dry precip forecast) where a curve would be a zero-width spike.
 */
function forecastDensityCurve(
  points: { p: number; v: number }[]
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
  if (hi - lo < 1e-9) return []; // no spread — nothing to draw as a curve

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

    // The two tails pivoting on `pivot` (display units). By default each is
    // labelled with the % of the HISTORICAL pool it holds: inclusive above
    // ("this hot or hotter"), strictly below — so they partition the pool and
    // sum to exactly 100%. ONE implementation, called with the settled target
    // value on history and with the verdict's reference line on forecasts.
    //
    // `exact` overrides the labels with the verdict tier's canonical percentage
    // (5/10/20/50) instead of the day-fraction: on a forecast the reference line
    // is snapped to a data point, so counting days at/above it lands 1–3% off
    // the cutoff the top card actually compares to. When set, the verdict side
    // reads exactly `exact.pct` and the other side reads its complement.
    const fmtPct = (p: number) => (Number.isInteger(p) ? p.toFixed(0) : p.toFixed(1)) + '%';
    const drawBrackets = (
      pivot: number,
      exact?: { pct: number; isHighSide: boolean }
    ) => {
      const total = histValues.length;
      if (total === 0) return;
      let pctHigher: string;
      let pctLower: string;
      if (exact) {
        pctHigher = fmtPct(exact.isHighSide ? exact.pct : 100 - exact.pct);
        pctLower = fmtPct(exact.isHighSide ? 100 - exact.pct : exact.pct);
      } else {
        pctHigher = fmtPct((histValues.filter((v) => v >= pivot).length / total) * 100);
        pctLower = fmtPct((histValues.filter((v) => v < pivot).length / total) * 100);
      }

      if (!isVertical) {
        const rightX = width + 8;
        const bw = 14;
        const yMid = tempScale(pivot);
        const yTop = 10;
        const yBottom = height - 10;

        g.append('path')
          .attr(
            'd',
            `M ${rightX} ${yTop}
             L ${rightX + bw * 0.5} ${yTop}
             Q ${rightX + bw * 0.8} ${yTop + 10} ${rightX + bw * 0.5} ${yTop + 18}
             L ${rightX + bw * 0.5} ${yMid - 20}
             Q ${rightX + bw * 0.8} ${yMid - 10} ${rightX + bw * 0.5} ${yMid - 4}`
          )
          .attr('stroke', 'var(--text-tertiary)')
          .attr('stroke-width', 1.5)
          .attr('fill', 'none');

        g.append('text')
          .attr('x', rightX + bw + 6)
          .attr('y', (yTop + yMid) / 2)
          .attr('dy', '0.35em')
          .attr('text-anchor', 'start')
          .style('font-size', '12px')
          .style('fill', 'var(--chart-label)')
          .text(pctHigher);

        g.append('path')
          .attr(
            'd',
            `M ${rightX + bw * 0.5} ${yMid + 4}
             Q ${rightX + bw * 0.8} ${yMid + 10} ${rightX + bw * 0.5} ${yMid + 20}
             L ${rightX + bw * 0.5} ${yBottom - 18}
             Q ${rightX + bw * 0.8} ${yBottom - 10} ${rightX + bw * 0.5} ${yBottom}
             L ${rightX} ${yBottom}`
          )
          .attr('stroke', 'var(--text-tertiary)')
          .attr('stroke-width', 1.5)
          .attr('fill', 'none');

        g.append('text')
          .attr('x', rightX + bw + 6)
          .attr('y', (yMid + yBottom) / 2)
          .attr('dy', '0.35em')
          .attr('text-anchor', 'start')
          .style('font-size', '12px')
          .style('fill', 'var(--chart-label)')
          .text(pctLower);
      } else {
        // Vertical mode: brackets above the bars. Lower temps LEFT, higher RIGHT.
        const topY = -8;
        const bw = 14;
        const xMid = tempScale(pivot);
        const xLeft = 10;
        const xRight = width - 10;

        g.append('path')
          .attr(
            'd',
            `M ${xLeft} ${topY}
             L ${xLeft} ${topY - bw * 0.5}
             Q ${xLeft + 10} ${topY - bw * 0.8} ${xLeft + 18} ${topY - bw * 0.5}
             L ${xMid - 20} ${topY - bw * 0.5}
             Q ${xMid - 10} ${topY - bw * 0.8} ${xMid - 4} ${topY - bw * 0.5}`
          )
          .attr('stroke', 'var(--text-tertiary)')
          .attr('stroke-width', 1.5)
          .attr('fill', 'none');

        g.append('text')
          .attr('x', (xLeft + xMid) / 2)
          .attr('y', topY - bw - 4)
          .attr('text-anchor', 'middle')
          .style('font-size', '12px')
          .style('fill', 'var(--chart-label)')
          .text(pctLower);

        g.append('path')
          .attr(
            'd',
            `M ${xMid + 4} ${topY - bw * 0.5}
             Q ${xMid + 10} ${topY - bw * 0.8} ${xMid + 20} ${topY - bw * 0.5}
             L ${xRight - 18} ${topY - bw * 0.5}
             Q ${xRight - 10} ${topY - bw * 0.8} ${xRight} ${topY - bw * 0.5}
             L ${xRight} ${topY}`
          )
          .attr('stroke', 'var(--text-tertiary)')
          .attr('stroke-width', 1.5)
          .attr('fill', 'none');

        g.append('text')
          .attr('x', (xMid + xRight) / 2)
          .attr('y', topY - bw - 4)
          .attr('text-anchor', 'middle')
          .style('font-size', '12px')
          .style('fill', 'var(--chart-label)')
          .text(pctHigher);
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
        // Forecast KDE (skipped only for a degenerate zero-spread band).
        const density = forecastDensityCurve(bandPoints).filter(
          (pt) => pt.t >= domLo2 && pt.t <= domHi2
        );

        // The verdict tier + its climatology reference value: same tier the top
        // card fires (native, unit-agnostic), then the tier's cutoff value read
        // off the matching pool in DISPLAY units. Runs off the SAME historical
        // pool as the brackets. Dead-centre mild has no side, so it pins to the
        // median; every other tier's refValue is the one-sided threshold its
        // confidence test checks against (= the confidence-shade edge below).
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
            : marker.tier === 'mildDead'
              ? d3.median(histValues) ?? convert(band.mid, currentMetric, system)
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
          // dead-centre mild shades the two-sided [p40,p60] band around the median.
          // Skipped on a thin pool, matching the prose's n≥5 gate.
          if (marker && histValues.length >= 5) {
            const loT = valueAtTailFraction(poolConv, marker.tierCutoff, false);
            const hiT = valueAtTailFraction(poolConv, marker.tierCutoff, true);
            const p = marker.tierTwoSided
              ? probabilityBetween(bandPoints, loT, hiT)
              : probabilityOneSided(bandPoints, refValue, marker.isHighSide);

            // Region bounds on the temp axis (display units), clamped to the drawn
            // support so the clip rect never spills past the curve.
            let regLo: number;
            let regHi: number;
            if (marker.tierTwoSided) {
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

            // Label the shaded lobe with its probability, at the GEOMETRIC middle
            // of the visibly-shaded extent: trim the near-zero density tail (the
            // KDE's padded shoulder), then take the midpoint of what's left so the
            // number sits in the heart of the hatch rather than out on the taper.
            // Inked in the hatch's own muted tone (KDE ink at the stripes' opacity),
            // with a thin KDE-ink outline so it stays legible over its own stripes.
            // Rounded to 5% / capped at 95% to match the card.
            const regionPts = density.filter((pt) => pt.t >= regLo && pt.t <= regHi);
            if (regionPts.length) {
              const maxRegD = d3.max(regionPts, (pt) => pt.d) as number;
              const solid = regionPts.filter((pt) => pt.d >= 0.08 * maxRegD);
              const tMin = d3.min(solid, (pt) => pt.t) as number;
              const tMax = d3.max(solid, (pt) => pt.t) as number;
              const cT = (tMin + tMax) / 2;
              const centre = solid.reduce((a, b) =>
                Math.abs(b.t - cT) < Math.abs(a.t - cT) ? b : a
              );
              const chance = Math.min(95, Math.round(p * 20) * 5);
              g.append('text')
                .attr('class', 'forecast-conf-label')
                .attr('x', isVertical ? tempScale(centre.t) : kdeLen(centre.d) / 2)
                .attr('y', isVertical ? height - kdeLen(centre.d) / 2 : tempScale(centre.t))
                .attr('dy', '0.35em')
                .attr('text-anchor', 'middle')
                .style('font-size', '12px')
                .style('fill', 'var(--text-h)')
                .style('fill-opacity', 0.7)
                .style('paint-order', 'stroke')
                .style('stroke', 'var(--text-h)')
                .style('stroke-width', '0.2px')
                .style('stroke-linejoin', 'round')
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
            .attr('stroke-width', 2)
            .attr('stroke-dasharray', '4,3')
            .attr('d', line(density))
            .style('opacity', 0)
            .transition()
            .duration(500)
            .style('opacity', 1);
        }

        if (marker) {
          perpLine(refValue)
            .attr('class', 'forecast-ref-line')
            .attr('stroke', 'var(--text-tertiary)')
            .attr('stroke-width', 1)
            .attr('stroke-dasharray', '4,3')
            .style('opacity', 0.4);
          // Label the verdict side with the tier's canonical % (5/10/20/50) — the
          // exact figure the top card compares to — not the ref line's snapped
          // day-fraction. Both mild tiers pin to the median → a clean 50/50.
          // All-time has no canonical %, so it keeps the honest day-fraction.
          const exactPct =
            marker.tier === 'alltime'
              ? undefined
              : marker.tier === 'mildDead' || marker.tier === 'mildOff'
                ? 50
                : marker.tierCutoff * 100;
          drawBrackets(
            refValue,
            exactPct === undefined
              ? undefined
              : { pct: exactPct, isHighSide: marker.isHighSide }
          );
        }
      } else {
        // Settled history: straight dashed line at the target value + brackets.
        const currentTemp = convert(currentRow[currentMetric] as number, currentMetric, system);
        perpLine(currentTemp)
          .attr('class', 'current-temp-line')
          .attr('stroke', 'var(--text-h)')
          .attr('stroke-width', 2)
          .attr('stroke-dasharray', '4,3');
        drawBrackets(currentTemp);
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

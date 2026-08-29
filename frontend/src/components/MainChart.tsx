import React, { useEffect, useRef } from 'react';
import * as d3 from 'd3';
import type { WeatherDataPoint, YearlyAggregate } from '../types';
import type { MetricKey } from '../utils/config';
import CONFIG from '../utils/config';
import { comparablePool, findRecords, isModelRow } from '../utils/dataProcessor';
import { placeTooltip } from '../utils/tooltip';
import { useUnits } from '../hooks/useUnits';
import { convert, unitLabel, axisLabel, axisPad, tickCount, valueDecimals } from '../utils/units';
import './MainChart.css';

export type Orientation = 'horizontal' | 'vertical';

interface MainChartProps {
  filteredData: WeatherDataPoint[];
  yearlyAggregates: YearlyAggregate[];
  currentMetric: MetricKey;
  currentDate: string;
  fullData: WeatherDataPoint[];
  orientation?: Orientation;
  width?: number;
  height?: number;
}

// horizontal: time on x, temp on y (desktop original)
// vertical:   temp on x, time on y (mobile rotated)
const MARGIN_H = { top: 20, right: 30, bottom: 40, left: 55 };
const MARGIN_V = { top: 8, right: 20, bottom: 40, left: 55 };

// "May 31st, 2026" — matches the radial dial's target-date label.
const MONTHS = ['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun',
  'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec'];
const ordinal = (n: number): string => {
  const s = ['th', 'st', 'nd', 'rd'];
  const v = n % 100;
  return n + (s[(v - 20) % 10] || s[v] || s[0]);
};
const fmtDate = (d: Date): string =>
  `${MONTHS[d.getMonth()]} ${ordinal(d.getDate())}, ${d.getFullYear()}`;

const MainChart: React.FC<MainChartProps> = ({
  filteredData,
  yearlyAggregates,
  currentMetric,
  currentDate,
  fullData,
  orientation = 'horizontal',
  width: propWidth,
  height: propHeight,
}) => {
  const svgRef = useRef<SVGSVGElement>(null);
  const tooltipRef = useRef<HTMLDivElement>(null);

  const { system } = useUnits();

  const isVertical = orientation === 'vertical';
  const MARGIN = isVertical ? MARGIN_V : MARGIN_H;
  const totalWidth = propWidth ?? 760;
  const totalHeight = propHeight ?? 400;
  const width = totalWidth - MARGIN.left - MARGIN.right;
  const height = totalHeight - MARGIN.top - MARGIN.bottom;

  useEffect(() => {
    if (!svgRef.current || filteredData.length === 0) return;

    // Convert a stored metric value to the active display system. The temp scale
    // lives in display units (so its axis produces clean imperial ticks), so
    // every value handed to tempScale must be converted first.
    const cv = (v: number) => convert(v, currentMetric, system);

    const svg = d3.select(svgRef.current);
    svg.selectAll('*').remove();

    const g = svg
      .append('g')
      .attr('transform', `translate(${MARGIN.left},${MARGIN.top})`);

    const tooltip = d3.select(tooltipRef.current);
    // Keep the tooltip on-screen near any edge; call after .html() (see util).
    const place = (event: { clientX: number; clientY: number }) =>
      placeTooltip(tooltipRef.current, event);

    const dateExtent = d3.extent(filteredData, (d) => d.date) as [Date, Date];
    const allValues = filteredData
      .map((d) => d[currentMetric])
      .filter((v): v is number => v !== undefined)
      .map((v) => cv(v));
    const [minVal, maxVal] = d3.extent(allValues) as [number, number];

    // Precipitation and wind can't be negative, so don't let the padded lower
    // bound dip below zero. This keeps the temp-axis domain identical to the
    // period-histogram chart's (see PeriodHistogramChart), which matters on
    // mobile where the two x-axes sit one above the other and must line up.
    const nonNegative =
      currentMetric === 'precipitation_sum' || currentMetric === 'wind_speed_10m_max';
    const pad = axisPad(currentMetric, system, maxVal - minVal);
    const tempLo = nonNegative ? Math.max(0, minVal - pad) : minVal - pad;
    const tempHi = maxVal + pad;

    // timeScale maps date → its axis pixel; tempScale maps temp → its axis pixel.
    // Orientation only changes which axis (x vs y) each one drives.
    const timeScale = d3
      .scaleTime()
      .domain(dateExtent)
      .range(isVertical ? [height, 0] : [0, width]);
    const tempScale = d3
      .scaleLinear()
      .domain([tempLo, tempHi])
      .range(isVertical ? [0, width] : [height, 0]);

    // tsv: temp-scale a *raw* (metric) value — converts to display units first.
    // Use this for every plotted value; tempScale itself stays bare for the axis.
    const tsv = (v: number) => tempScale(cv(v));

    // Value-axis tick count, capped for precip so the step stays ≥ 1 mm/0.05 in.
    // PeriodHistogramChart computes the same count from the same domain so the
    // two charts' shared axes keep identical tick positions.
    const nTicks = tickCount(currentMetric, system, tempHi - tempLo);

    // 'temp' values are raw metric numbers → route through tsv (convert + scale).
    const tx = (t: Date | number, kind: 'time' | 'temp') =>
      isVertical
        ? (kind === 'temp' ? tsv(t as number) : timeScale(t as Date))
        : (kind === 'time' ? timeScale(t as Date) : tsv(t as number));
    const ty = (t: Date | number, kind: 'time' | 'temp') =>
      isVertical
        ? (kind === 'time' ? timeScale(t as Date) : tsv(t as number))
        : (kind === 'temp' ? tsv(t as number) : timeScale(t as Date));

    // Grid
    g.append('g')
      .attr('class', 'grid')
      .attr('transform', `translate(0,${height})`)
      .call(
        (isVertical
          ? d3.axisBottom(tempScale).ticks(nTicks)
          : d3.axisBottom(timeScale)
        ).tickSize(-height).tickFormat(() => '') as any
      );

    g.append('g')
      .attr('class', 'grid')
      .call(
        (isVertical
          ? d3.axisLeft(timeScale)
          : d3.axisLeft(tempScale).ticks(nTicks)
        ).tickSize(-width).tickFormat(() => '') as any
      );

    // Year-axis ticks: d3's default round-year ticks (1960/1980/2000/2020…) plus
    // the domain's first year (1950), which d3 otherwise drops as a non-round
    // boundary. Pin it so the record's start is always labelled.
    const yearTicks = (() => {
      const start = timeScale.domain()[0];
      const defaults = timeScale.ticks(d3.timeYear.every(10)!);
      const startYear = d3.timeYear.floor(start);
      const hasStart = defaults.some((t) => +t === +startYear);
      return hasStart ? defaults : [startYear, ...defaults];
    })();

    // Axes
    g.append('g')
      .attr('class', 'axis')
      .attr('transform', `translate(0,${height})`)
      .call(
        (isVertical
          ? d3.axisBottom(tempScale).ticks(nTicks)
          : d3.axisBottom(timeScale)
              .tickValues(yearTicks)
              .tickFormat(d3.timeFormat('%Y') as any)
        ) as any
      );

    g.append('g').attr('class', 'axis').call(
      (isVertical
        ? d3.axisLeft(timeScale)
            .tickValues(yearTicks)
            .tickFormat(d3.timeFormat('%Y') as any)
        : d3.axisLeft(tempScale).ticks(nTicks)
      ) as any
    );

    // Axis label (the temp axis). "Daily" makes clear these are per-day values.
    const tempAxisLabel = axisLabel(currentMetric, system);
    if (isVertical) {
      g.append('text')
        .attr('x', width / 2)
        .attr('y', height + 32)
        .style('text-anchor', 'middle')
        .style('font-size', '12px')
        .style('fill', 'var(--chart-label)')
        .text(tempAxisLabel);
    } else {
      g.append('text')
        .attr('transform', 'rotate(-90)')
        .attr('y', -MARGIN.left + 10)
        .attr('x', -height / 2)
        .attr('dy', '1em')
        .style('text-anchor', 'middle')
        .style('font-size', '12px')
        .style('fill', 'var(--chart-label)')
        .text(tempAxisLabel);
    }

    // Pre-satellite era: dashed boundary at 1979 with a label.
    const satelliteDate = new Date(1979, 0, 1);
    if (satelliteDate > dateExtent[0]) {
      const boundaryPos = timeScale(satelliteDate);
      if (isVertical) {
        // Time runs along y (top = latest). Pre-1979 is the bottom band.
        g.append('line')
          .attr('class', 'satellite-era-line')
          .attr('x1', 0).attr('x2', width)
          .attr('y1', boundaryPos).attr('y2', boundaryPos)
          .attr('stroke', 'var(--chart-axis)')
          .attr('stroke-width', 0.75)
          .attr('stroke-dasharray', '3,4');
        g.append('text')
          .attr('class', 'satellite-era-label')
          .attr('x', width - 5)
          .attr('y', boundaryPos - 5)
          .style('text-anchor', 'end')
          .style('font-size', '11px')
          .style('font-style', 'italic')
          .style('fill', 'var(--text-tertiary)')
          .text('Satellites!');
      } else {
        // Time runs along x (left = earliest). Pre-1979 is the left band.
        g.append('line')
          .attr('class', 'satellite-era-line')
          .attr('x1', boundaryPos).attr('x2', boundaryPos)
          .attr('y1', 0).attr('y2', height)
          .attr('stroke', 'var(--chart-axis)')
          .attr('stroke-width', 0.75)
          .attr('stroke-dasharray', '3,4');
        g.append('text')
          .attr('class', 'satellite-era-label')
          .attr('x', boundaryPos)
          .attr('y', -5)
          .style('text-anchor', 'middle')
          .style('font-size', '11px')
          .style('font-style', 'italic')
          .style('fill', 'var(--text-tertiary)')
          .text('Satellites!');
      }
    }

    // Percentile bands
    const validAggs = yearlyAggregates.filter(
      (d) =>
        d.date &&
        (d.p10 !== undefined || d.moving10 !== null) &&
        (d.p90 !== undefined || d.moving90 !== null)
    );

    if (validAggs.length > 0) {
      const makeArea = (
        lo: (d: YearlyAggregate) => number,
        hi: (d: YearlyAggregate) => number
      ) => {
        if (isVertical) {
          return d3
            .area<YearlyAggregate>()
            .y((d) => timeScale(d.date))
            .x0((d) => tsv(lo(d)))
            .x1((d) => tsv(hi(d)))
            .curve(d3.curveMonotoneY);
        }
        return d3
          .area<YearlyAggregate>()
          .x((d) => timeScale(d.date))
          .y0((d) => tsv(lo(d)))
          .y1((d) => tsv(hi(d)))
          .curve(d3.curveMonotoneX);
      };

      const area90 = makeArea(
        (d) => (d.p10 ?? d.moving10) as number,
        (d) => (d.p90 ?? d.moving90) as number
      );
      const area75 = makeArea(
        (d) => (d.p25 ?? d.moving25) as number,
        (d) => (d.p75 ?? d.moving75) as number
      );

      g.append('path')
        .datum(validAggs)
        .attr('class', 'percentile-band-90')
        .attr('fill', CONFIG.getColorForElement(currentMetric, 'percentileBand90'))
        .attr('d', area90)
        .style('opacity', 0)
        .transition()
        .duration(500)
        .style('opacity', 1);

      g.append('path')
        .datum(validAggs)
        .attr('class', 'percentile-band-75')
        .attr('fill', CONFIG.getColorForElement(currentMetric, 'percentileBand75'))
        .attr('d', area75)
        .style('opacity', 0)
        .transition()
        .duration(500)
        .style('opacity', 1);

      const trendData = validAggs.filter((d) => d.movingMedian !== null);
      if (trendData.length > 0) {
        const line = isVertical
          ? d3
              .line<YearlyAggregate>()
              .y((d) => timeScale(d.date))
              .x((d) => tsv(d.movingMedian as number))
              .curve(d3.curveMonotoneY)
          : d3
              .line<YearlyAggregate>()
              .x((d) => timeScale(d.date))
              .y((d) => tsv(d.movingMedian as number))
              .curve(d3.curveMonotoneX);

        g.append('path')
          .datum(trendData)
          .attr('class', 'trend-line')
          .attr('fill', 'none')
          .attr('stroke', CONFIG.getColorForElement(currentMetric, 'trendLine'))
          .attr('stroke-width', 2.5)
          .attr('d', line)
          .style('opacity', 0)
          .transition()
          .duration(500)
          .style('opacity', 1);
      }
    }

    // Scatter points
    const unit = unitLabel(currentMetric, system);
    const vdp = valueDecimals(currentMetric, system);

    // 90% CI suffix for a model row's tooltip — the CatBoost lo–hi band in
    // display units. Empty for settled rows (no band). The dot already sits at
    // the band median (snapped at the source); this shows how wide the guess is.
    const ciLine = (d: WeatherDataPoint): string => {
      const b = d.band?.[currentMetric];
      if (!b) return '';
      return `<br/><span class="tt-ci">90% CI ${cv(b.lo).toFixed(vdp)}–${cv(b.hi).toFixed(vdp)}${unit}</span>`;
    };

    // Forecast rows are model guesses, not settled observations. They're drawn
    // as hollow (outlined) dots, and excluded from the record high/low markers
    // and the histogram (see HistogramChart) so they don't masquerade as records.
    // We also only show forecast dots up to (and including) the target date —
    // dots dated past the selected day are dropped, since the page is "how hot
    // was it on <date>", not a look-ahead at the rest of the forecast horizon.
    const targetDay = new Date(currentDate + 'T12:00:00');

    // Model rows — forecast tier, plus recent-tier precip/wind, which come from
    // the IFS historical-forecast API rather than era5_land — are marked like a
    // forecast point (hollow dot + "Forecast" tooltip). The rule itself lives in
    // dataProcessor.isModelRow, the SAME predicate that keeps these rows out of
    // the records and the climatology, so a hollow dot can never be counted as a
    // measured day. Note: only the forecast *tier* is dropped past the target day
    // below; recent rows are settled past data (never look-ahead), so they're
    // always plotted.
    const isForecastLike = (d: WeatherDataPoint) => isModelRow(d, currentMetric);

    const dotData = filteredData.filter(
      (d) =>
        d[currentMetric] !== undefined &&
        !(d.data_type === 'forecast' && d.date > targetDay)
    );
    const dotColor = CONFIG.getColorForElement(currentMetric, 'dataPoints');
    const dotSelection = g.selectAll('.data-point')
      .data(dotData)
      .enter()
      .append('circle')
      .attr('class', (d) => `data-point${isForecastLike(d) ? ' data-point-forecast' : ''}`)
      .attr('cx', (d) => tx(isVertical ? (d[currentMetric] as number) : d.date, isVertical ? 'temp' : 'time'))
      .attr('cy', (d) => ty(isVertical ? d.date : (d[currentMetric] as number), isVertical ? 'time' : 'temp'))
      .attr('r', (d) => (isForecastLike(d) ? 3.2 : 2.8))
      .attr('fill', (d) => (isForecastLike(d) ? 'var(--surface)' : dotColor))
      .attr('stroke', (d) => (isForecastLike(d) ? dotColor : 'none'))
      .attr('stroke-width', (d) => (isForecastLike(d) ? 1.3 : 0))
      .style('opacity', 0);

    dotSelection.transition().duration(500).style('opacity', 1);

    // Invisible larger hit-targets so the hover doesn't require pixel-perfect aim
    // on the 2px dots. Appended before the record stars / current-date marker so
    // those stay on top and keep their own (more specific) tooltips.
    g.selectAll('.data-point-hit')
      .data(dotData)
      .enter()
      .append('circle')
      .attr('class', 'data-point-hit')
      .attr('cx', (d) => tx(isVertical ? (d[currentMetric] as number) : d.date, isVertical ? 'temp' : 'time'))
      .attr('cy', (d) => ty(isVertical ? d.date : (d[currentMetric] as number), isVertical ? 'time' : 'temp'))
      .attr('r', 6)
      .attr('fill', 'transparent')
      .style('cursor', 'crosshair')
      .on('mouseover', (event, d) => {
        tooltip
          .style('opacity', 1)
          .html(
            `<strong>${fmtDate(d.date)}</strong><br/>${cv(d[currentMetric] as number).toFixed(vdp)}${unit}${isForecastLike(d) ? '<br/><em>Forecast</em>' : ''}${ciLine(d)}`
          );
        place(event);
      })
      .on('mouseout', () => tooltip.style('opacity', 0));

    // 5-point star path, outer radius 9, inner radius ~3.8
    const starPath = (cx: number, cy: number, outer = 9, inner = 3.8): string => {
      const pts: string[] = [];
      for (let i = 0; i < 10; i++) {
        const r = i % 2 === 0 ? outer : inner;
        const a = -Math.PI / 2 + (i * Math.PI) / 5;
        pts.push(`${cx + r * Math.cos(a)},${cy + r * Math.sin(a)}`);
      }
      return `M${pts.join(' L')} Z`;
    };

    // Record high (red) and record low (blue) markers. Use the SAME pool and the
    // SAME findRecords() the prose verdict uses, so the star and the "Nth Xest"
    // text can never disagree about which day is the record. findRecords itself
    // drops model rows (forecast tier + recent-tier precip/wind), so a star only
    // ever lands on an ERA observation — a hollow dot can't win one. Reused below
    // to test whether the TARGET day IS the record — then it's a shining star,
    // not the plain dot.
    const { hiRow: recordHiRow, loRow: recordLoRow } = findRecords(
      comparablePool(filteredData, currentDate),
      currentMetric
    );
    if (recordHiRow && recordLoRow) {
      // A record that falls on the target day is drawn as the shining target
      // star below — drop it here so two stars don't stack on the same point.
      const isTargetDay = (d: WeatherDataPoint) =>
        d.date.getFullYear() === targetDay.getFullYear() &&
        d.date.getMonth() === targetDay.getMonth() &&
        d.date.getDate() === targetDay.getDate();
      const recs: Array<{ d: WeatherDataPoint; color: string; label: string }> = [
        { d: recordHiRow, color: '#c0392b', label: 'Record high' },
        { d: recordLoRow, color: '#2f6fb8', label: 'Record low' },
      ].filter((r) => !isTargetDay(r.d));

      g.selectAll('.record-point')
        .data(recs)
        .enter()
        .append('path')
        .attr('class', 'record-point')
        .attr('d', (r) => {
          const cx = isVertical ? tsv(r.d[currentMetric] as number) : timeScale(r.d.date);
          const cy = isVertical ? timeScale(r.d.date) : tsv(r.d[currentMetric] as number);
          return starPath(cx, cy);
        })
        .attr('fill', (r) => r.color)
        .attr('stroke', 'var(--surface)')
        .attr('stroke-width', 1.5)
        .style('opacity', 0)
        .on('mouseover', (event, r) => {
          tooltip
            .style('opacity', 1)
            .html(
              `<strong>${r.label}</strong><br/>${fmtDate(r.d.date)}<br/>${cv(r.d[currentMetric] as number).toFixed(vdp)}${unit}${ciLine(r.d)}`
            );
          place(event);
        })
        .on('mouseout', () => tooltip.style('opacity', 0))
        .transition()
        .duration(500)
        .style('opacity', 1);
    }

    // Current date indicator
    const currentDateData = fullData.filter(
      (d) =>
        d.date.getFullYear() === targetDay.getFullYear() &&
        d.date.getMonth() === targetDay.getMonth() &&
        d.date.getDate() === targetDay.getDate() &&
        d[currentMetric] !== undefined
    );

    if (currentDateData.length > 0) {
      const currentTemp = currentDateData[0][currentMetric] as number;

      // Line is perpendicular to the temp axis: horizontal line in horizontal mode, vertical line in vertical mode.
      const lineEl = g.append('line').attr('class', 'current-temp-line')
        .attr('stroke', 'var(--text-h)')
        .attr('stroke-width', 1.5)
        .attr('stroke-dasharray', '5,5');
      if (isVertical) {
        lineEl
          .attr('x1', tsv(currentTemp)).attr('x2', tsv(currentTemp))
          .attr('y1', 0).attr('y2', height);
      } else {
        lineEl
          .attr('x1', 0).attr('x2', width)
          .attr('y1', tsv(currentTemp)).attr('y2', tsv(currentTemp));
      }

      // If the target day IS the record high/low in the visible pool, mark it as
      // a shining star (record color) instead of the plain dot — so the "most"
      // day reads as a record at a glance, not a generic point. Match by date,
      // since the record rows come from filteredData and the target from fullData.
      const sameDay = (a: WeatherDataPoint | null) =>
        !!a &&
        a.date.getFullYear() === targetDay.getFullYear() &&
        a.date.getMonth() === targetDay.getMonth() &&
        a.date.getDate() === targetDay.getDate();
      const targetRecordColor = sameDay(recordHiRow)
        ? '#c0392b'
        : sameDay(recordLoRow)
        ? '#2f6fb8'
        : null;

      const cx = isVertical ? tsv(currentTemp) : timeScale(currentDateData[0].date);
      const cy = isVertical ? timeScale(currentDateData[0].date) : tsv(currentTemp);

      const showTooltip = (event: MouseEvent) => {
        tooltip
          .style('opacity', 1)
          .html(
            `<strong>${fmtDate(currentDateData[0].date)}</strong><br/>${cv(currentTemp).toFixed(vdp)}${unit}<br/><em>Target date${isForecastLike(currentDateData[0]) ? ' · forecast' : ''}</em>${ciLine(currentDateData[0])}`
          );
        place(event);
      };

      if (targetRecordColor) {
        // Soft radial glow behind the star, then the star itself with a gentle
        // pulse (see .current-temp-star in MainChart.css).
        g.append('circle')
          .attr('class', 'current-temp-glow')
          .attr('cx', cx)
          .attr('cy', cy)
          .attr('r', 14)
          .attr('fill', targetRecordColor);
        g.append('path')
          .attr('class', 'current-temp-star')
          .attr('d', starPath(cx, cy, 11, 4.6))
          .attr('fill', targetRecordColor)
          .attr('stroke', 'var(--surface)')
          .attr('stroke-width', 1.5)
          .style('cursor', 'pointer')
          .on('mouseover', showTooltip)
          .on('mouseout', () => tooltip.style('opacity', 0));
      } else {
        g.selectAll('.current-temp-point')
          .data(currentDateData)
          .enter()
          .append('circle')
          .attr('class', 'current-temp-point')
          .attr('cx', cx)
          .attr('cy', cy)
          .attr('r', 5)
          .attr('fill', 'var(--text-h)')
          .attr('stroke', 'var(--surface)')
          .attr('stroke-width', 2)
          .on('mouseover', showTooltip)
          .on('mouseout', () => tooltip.style('opacity', 0));
      }

      // Target VALUE written next to the marker, horizontal (mirrors the gradient
      // bar's headline number). Replaces the old angled target-date text — the
      // date now lives in the legend's target-day entry instead.
      const td = currentDateData[0].date;
      const valueLabel = `${cv(currentTemp).toFixed(vdp)}${unit}`;
      const px = isVertical ? tsv(currentTemp) : timeScale(td);
      const py = isVertical ? timeScale(td) : tsv(currentTemp);
      const labelEl = g.append('text')
        .attr('class', 'current-temp-label')
        .style('font-size', '12px')
        .style('font-weight', '600')
        .style('fill', 'var(--text-h)')
        .text(valueLabel);
      if (isVertical) {
        // Mobile: the target day sits at the very top of the time axis — a label
        // above it would clip out of the tiny top margin. Place it level, beside
        // the marker. Default to the right; near the right edge (extreme weather)
        // flip left to keep the text on-screen.
        const estTextW = valueLabel.length * 9.3; // ~9px/char at 16.5px
        const flipLeft = px + 9 + estTextW > width;
        labelEl
          .attr('x', flipLeft ? px - 9 : px + 9)
          .attr('y', py + 4)
          .style('text-anchor', flipLeft ? 'end' : 'start');
      } else {
        // Desktop: horizontal, at the right edge just above the value line, sitting
        // up-and-left of the marker (end-anchored) so it clears the histogram.
        labelEl
          .attr('x', px)
          .attr('y', py - 7)
          .style('text-anchor', 'end');
      }
    }
  }, [filteredData, yearlyAggregates, currentMetric, currentDate, fullData, width, height, isVertical, system]);

  return (
    <div className="main-chart-wrapper">
      <svg
        ref={svgRef}
        width={totalWidth}
        height={totalHeight}
        className="main-chart-svg"
      />
      <div ref={tooltipRef} className="chart-tooltip" />
    </div>
  );
};

export default MainChart;

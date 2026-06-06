import React, { useEffect, useRef } from 'react';
import * as d3 from 'd3';
import type { WeatherDataPoint, YearlyAggregate } from '../types';
import type { MetricKey } from '../utils/config';
import CONFIG from '../utils/config';
import { placeTooltip } from '../utils/tooltip';
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

  const isVertical = orientation === 'vertical';
  const MARGIN = isVertical ? MARGIN_V : MARGIN_H;
  const totalWidth = propWidth ?? 760;
  const totalHeight = propHeight ?? 400;
  const width = totalWidth - MARGIN.left - MARGIN.right;
  const height = totalHeight - MARGIN.top - MARGIN.bottom;

  useEffect(() => {
    if (!svgRef.current || filteredData.length === 0) return;

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
      .filter((v): v is number => v !== undefined);
    const [minVal, maxVal] = d3.extent(allValues) as [number, number];

    // Precipitation and wind can't be negative, so don't let the padded lower
    // bound dip below zero. This keeps the temp-axis domain identical to the
    // period-histogram chart's (see PeriodHistogramChart), which matters on
    // mobile where the two x-axes sit one above the other and must line up.
    const nonNegative =
      currentMetric === 'precipitation_sum' || currentMetric === 'wind_speed_10m_max';
    const tempLo = nonNegative ? Math.max(0, minVal - 2) : minVal - 2;
    const tempHi = maxVal + 2;

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

    const tx = (t: Date | number, kind: 'time' | 'temp') =>
      isVertical
        ? (kind === 'temp' ? tempScale(t as number) : timeScale(t as Date))
        : (kind === 'time' ? timeScale(t as Date) : tempScale(t as number));
    const ty = (t: Date | number, kind: 'time' | 'temp') =>
      isVertical
        ? (kind === 'time' ? timeScale(t as Date) : tempScale(t as number))
        : (kind === 'temp' ? tempScale(t as number) : timeScale(t as Date));

    // Grid
    g.append('g')
      .attr('class', 'grid')
      .attr('transform', `translate(0,${height})`)
      .call(
        (isVertical
          ? d3.axisBottom(tempScale)
          : d3.axisBottom(timeScale)
        ).tickSize(-height).tickFormat(() => '') as any
      );

    g.append('g')
      .attr('class', 'grid')
      .call(
        (isVertical
          ? d3.axisLeft(timeScale)
          : d3.axisLeft(tempScale)
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
          ? d3.axisBottom(tempScale)
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
        : d3.axisLeft(tempScale)
      ) as any
    );

    // Axis label (the temp axis). "Daily" makes clear these are per-day values.
    const tempLabels: Record<MetricKey, string> = {
      max_temperature: 'Daily Max Temp (°C)',
      min_temperature: 'Daily Min Temp (°C)',
      precipitation_sum: 'Daily Precipitation (mm)',
      wind_speed_10m_max: 'Daily Max Wind Speed (m/s)',
    };
    if (isVertical) {
      g.append('text')
        .attr('x', width / 2)
        .attr('y', height + 32)
        .style('text-anchor', 'middle')
        .style('font-size', '12px')
        .style('fill', 'var(--chart-label)')
        .text(tempLabels[currentMetric]);
    } else {
      g.append('text')
        .attr('transform', 'rotate(-90)')
        .attr('y', -MARGIN.left + 10)
        .attr('x', -height / 2)
        .attr('dy', '1em')
        .style('text-anchor', 'middle')
        .style('font-size', '12px')
        .style('fill', 'var(--chart-label)')
        .text(tempLabels[currentMetric]);
    }

    // Pre-satellite era: light shading + dashed boundary at 1979 with a label.
    const satelliteDate = new Date(1979, 0, 1);
    if (satelliteDate > dateExtent[0]) {
      const boundaryPos = timeScale(satelliteDate);
      if (isVertical) {
        // Time runs along y (top = latest). Pre-1979 is the bottom band.
        g.append('rect')
          .attr('class', 'satellite-era-shade')
          .attr('x', 0)
          .attr('y', boundaryPos)
          .attr('width', width)
          .attr('height', height - boundaryPos)
          .attr('fill', 'var(--text-h)')
          .attr('opacity', 0.012);
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
        g.append('rect')
          .attr('class', 'satellite-era-shade')
          .attr('x', 0)
          .attr('y', 0)
          .attr('width', boundaryPos)
          .attr('height', height)
          .attr('fill', 'var(--text-h)')
          .attr('opacity', 0.012);
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
            .x0((d) => tempScale(lo(d)))
            .x1((d) => tempScale(hi(d)))
            .curve(d3.curveMonotoneY);
        }
        return d3
          .area<YearlyAggregate>()
          .x((d) => timeScale(d.date))
          .y0((d) => tempScale(lo(d)))
          .y1((d) => tempScale(hi(d)))
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
              .x((d) => tempScale(d.movingMedian as number))
              .curve(d3.curveMonotoneY)
          : d3
              .line<YearlyAggregate>()
              .x((d) => timeScale(d.date))
              .y((d) => tempScale(d.movingMedian as number))
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
    const units: Record<MetricKey, string> = {
      max_temperature: '°C',
      min_temperature: '°C',
      precipitation_sum: 'mm',
      wind_speed_10m_max: 'm/s',
    };
    const pointLabels: Record<MetricKey, string> = {
      max_temperature: 'Max Temp',
      min_temperature: 'Min Temp',
      precipitation_sum: 'Precipitation',
      wind_speed_10m_max: 'Max Wind Speed',
    };

    // Forecast rows are model guesses, not settled observations. They're drawn
    // as hollow (outlined) dots, and excluded from the record high/low markers
    // and the histogram (see HistogramChart) so they don't masquerade as records.
    // We also only show forecast dots up to (and including) the target date —
    // dots dated past the selected day are dropped, since the page is "how hot
    // was it on <date>", not a look-ahead at the rest of the forecast horizon.
    const targetDay = new Date(currentDate + 'T12:00:00');
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
      .attr('class', (d) => `data-point${d.data_type === 'forecast' ? ' data-point-forecast' : ''}`)
      .attr('cx', (d) => tx(isVertical ? (d[currentMetric] as number) : d.date, isVertical ? 'temp' : 'time'))
      .attr('cy', (d) => ty(isVertical ? d.date : (d[currentMetric] as number), isVertical ? 'time' : 'temp'))
      .attr('r', (d) => (d.data_type === 'forecast' ? 2.5 : 2))
      .attr('fill', (d) => (d.data_type === 'forecast' ? 'var(--surface)' : dotColor))
      .attr('stroke', (d) => (d.data_type === 'forecast' ? dotColor : 'none'))
      .attr('stroke-width', (d) => (d.data_type === 'forecast' ? 1 : 0))
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
            `<strong>${d.date.toDateString()}</strong><br/>${pointLabels[currentMetric]}: ${(d[currentMetric] as number).toFixed(1)}${units[currentMetric]}${d.data_type === 'forecast' ? '<br/><em>Forecast</em>' : ''}`
          );
        place(event);
      })
      .on('mouseout', () => tooltip.style('opacity', 0));

    // Record high (red) and record low (blue) markers — slightly larger than the target-date dot.
    // Forecast rows are excluded: a record should be a settled observation, not a model guess.
    const valid = filteredData.filter((d) => {
      const v = d[currentMetric];
      return typeof v === 'number' && Number.isFinite(v) && d.data_type !== 'forecast';
    });
    if (valid.length > 0) {
      let lo = valid[0];
      let hi = valid[0];
      for (const d of valid) {
        if ((d[currentMetric] as number) < (lo[currentMetric] as number)) lo = d;
        if ((d[currentMetric] as number) > (hi[currentMetric] as number)) hi = d;
      }
      const recs: Array<{ d: typeof lo; color: string; label: string }> = [
        { d: hi, color: '#c0392b', label: 'Record high' },
        { d: lo, color: '#2f6fb8', label: 'Record low' },
      ];
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

      g.selectAll('.record-point')
        .data(recs)
        .enter()
        .append('path')
        .attr('class', 'record-point')
        .attr('d', (r) => {
          const cx = isVertical ? tempScale(r.d[currentMetric] as number) : timeScale(r.d.date);
          const cy = isVertical ? timeScale(r.d.date) : tempScale(r.d[currentMetric] as number);
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
              `<strong>${r.label}</strong><br/>${r.d.date.toDateString()}<br/>${pointLabels[currentMetric]}: ${(r.d[currentMetric] as number).toFixed(1)}${units[currentMetric]}`
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
          .attr('x1', tempScale(currentTemp)).attr('x2', tempScale(currentTemp))
          .attr('y1', 0).attr('y2', height);
      } else {
        lineEl
          .attr('x1', 0).attr('x2', width)
          .attr('y1', tempScale(currentTemp)).attr('y2', tempScale(currentTemp));
      }

      g.selectAll('.current-temp-point')
        .data(currentDateData)
        .enter()
        .append('circle')
        .attr('class', 'current-temp-point')
        .attr('cx', (d) => isVertical ? tempScale(d[currentMetric] as number) : timeScale(d.date))
        .attr('cy', (d) => isVertical ? timeScale(d.date) : tempScale(d[currentMetric] as number))
        .attr('r', 5)
        .attr('fill', 'var(--text-h)')
        .attr('stroke', 'var(--surface)')
        .attr('stroke-width', 2)
        .on('mouseover', (event, d) => {
          tooltip
            .style('opacity', 1)
            .html(
              `<strong>${d.date.toDateString()}</strong><br/>${pointLabels[currentMetric]}: ${(d[currentMetric] as number).toFixed(1)}${units[currentMetric]}<br/><em>Target date${d.data_type === 'forecast' ? ' · forecast' : ''}</em>`
            );
          place(event);
        })
        .on('mouseout', () => tooltip.style('opacity', 0));
    }
  }, [filteredData, yearlyAggregates, currentMetric, currentDate, fullData, width, height, isVertical]);

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

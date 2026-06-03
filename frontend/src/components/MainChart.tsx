import React, { useEffect, useRef } from 'react';
import * as d3 from 'd3';
import type { WeatherDataPoint, YearlyAggregate } from '../types';
import type { MetricKey } from '../utils/config';
import CONFIG from '../utils/config';
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
  const totalWidth = propWidth ?? 720;
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

    const dateExtent = d3.extent(filteredData, (d) => d.date) as [Date, Date];
    const allValues = filteredData
      .map((d) => d[currentMetric])
      .filter((v): v is number => v !== undefined);
    const [minVal, maxVal] = d3.extent(allValues) as [number, number];

    // timeScale maps date → its axis pixel; tempScale maps temp → its axis pixel.
    // Orientation only changes which axis (x vs y) each one drives.
    const timeScale = d3
      .scaleTime()
      .domain(dateExtent)
      .range(isVertical ? [height, 0] : [0, width]);
    const tempScale = d3
      .scaleLinear()
      .domain([minVal - 2, maxVal + 2])
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

    // Axes
    g.append('g')
      .attr('class', 'axis')
      .attr('transform', `translate(0,${height})`)
      .call(
        (isVertical
          ? d3.axisBottom(tempScale)
          : d3.axisBottom(timeScale).tickFormat(d3.timeFormat('%Y') as any)
        ) as any
      );

    g.append('g').attr('class', 'axis').call(
      (isVertical
        ? d3.axisLeft(timeScale).tickFormat(d3.timeFormat('%Y') as any)
        : d3.axisLeft(tempScale)
      ) as any
    );

    // Axis label (the temp axis)
    const tempLabels: Record<MetricKey, string> = {
      max_temperature: 'Max Temp (°C)',
      min_temperature: 'Min Temp (°C)',
      precipitation_sum: 'Precipitation (mm)',
      wind_speed_10m_max: 'Max Wind Speed (m/s)',
    };
    if (isVertical) {
      g.append('text')
        .attr('x', width / 2)
        .attr('y', height + 32)
        .style('text-anchor', 'middle')
        .style('font-size', '12px')
        .style('fill', '#555')
        .text(tempLabels[currentMetric]);
    } else {
      g.append('text')
        .attr('transform', 'rotate(-90)')
        .attr('y', -MARGIN.left + 10)
        .attr('x', -height / 2)
        .attr('dy', '1em')
        .style('text-anchor', 'middle')
        .style('font-size', '12px')
        .style('fill', '#555')
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
          .attr('fill', '#000')
          .attr('opacity', 0.02);
        g.append('line')
          .attr('class', 'satellite-era-line')
          .attr('x1', 0).attr('x2', width)
          .attr('y1', boundaryPos).attr('y2', boundaryPos)
          .attr('stroke', '#999')
          .attr('stroke-width', 0.75)
          .attr('stroke-dasharray', '3,4');
        g.append('text')
          .attr('class', 'satellite-era-label')
          .attr('x', width - 5)
          .attr('y', boundaryPos - 5)
          .style('text-anchor', 'end')
          .style('font-size', '11px')
          .style('font-style', 'italic')
          .style('fill', '#777')
          .text('Satellites!');
      } else {
        // Time runs along x (left = earliest). Pre-1979 is the left band.
        g.append('rect')
          .attr('class', 'satellite-era-shade')
          .attr('x', 0)
          .attr('y', 0)
          .attr('width', boundaryPos)
          .attr('height', height)
          .attr('fill', '#000')
          .attr('opacity', 0.02);
        g.append('line')
          .attr('class', 'satellite-era-line')
          .attr('x1', boundaryPos).attr('x2', boundaryPos)
          .attr('y1', 0).attr('y2', height)
          .attr('stroke', '#999')
          .attr('stroke-width', 0.75)
          .attr('stroke-dasharray', '3,4');
        g.append('text')
          .attr('class', 'satellite-era-label')
          .attr('x', boundaryPos)
          .attr('y', -5)
          .style('text-anchor', 'middle')
          .style('font-size', '11px')
          .style('font-style', 'italic')
          .style('fill', '#777')
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

    const dotSelection = g.selectAll('.data-point')
      .data(filteredData.filter((d) => d[currentMetric] !== undefined))
      .enter()
      .append('circle')
      .attr('class', 'data-point')
      .attr('cx', (d) => tx(isVertical ? (d[currentMetric] as number) : d.date, isVertical ? 'temp' : 'time'))
      .attr('cy', (d) => ty(isVertical ? d.date : (d[currentMetric] as number), isVertical ? 'time' : 'temp'))
      .attr('r', 2)
      .attr('fill', CONFIG.getColorForElement(currentMetric, 'dataPoints'))
      .style('opacity', 0);

    dotSelection.transition().duration(500).style('opacity', 1);

    // Record high (red) and record low (blue) markers — slightly larger than the target-date dot.
    const valid = filteredData.filter((d) => {
      const v = d[currentMetric];
      return typeof v === 'number' && Number.isFinite(v);
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
        .attr('stroke', 'white')
        .attr('stroke-width', 1.5)
        .style('opacity', 0)
        .on('mouseover', (event, r) => {
          tooltip
            .style('opacity', 1)
            .html(
              `<strong>${r.label}</strong><br/>${r.d.date.toDateString()}<br/>${pointLabels[currentMetric]}: ${(r.d[currentMetric] as number).toFixed(1)}${units[currentMetric]}`
            )
            .style('left', event.clientX + 12 + 'px')
            .style('top', event.clientY - 28 + 'px');
        })
        .on('mouseout', () => tooltip.style('opacity', 0))
        .transition()
        .duration(500)
        .style('opacity', 1);
    }

    dotSelection
      .on('mouseover', (event, d) => {
        tooltip
          .style('opacity', 1)
          .html(
            `<strong>${d.date.toDateString()}</strong><br/>${pointLabels[currentMetric]}: ${(d[currentMetric] as number).toFixed(1)}${units[currentMetric]}`
          )
          .style('left', event.clientX + 12 + 'px')
          .style('top', event.clientY - 28 + 'px');
      })
      .on('mouseout', () => tooltip.style('opacity', 0));

    // Current date indicator
    const targetDate = new Date(currentDate + 'T12:00:00');
    const currentDateData = fullData.filter(
      (d) =>
        d.date.getFullYear() === targetDate.getFullYear() &&
        d.date.getMonth() === targetDate.getMonth() &&
        d.date.getDate() === targetDate.getDate() &&
        d[currentMetric] !== undefined
    );

    if (currentDateData.length > 0) {
      const currentTemp = currentDateData[0][currentMetric] as number;

      // Line is perpendicular to the temp axis: horizontal line in horizontal mode, vertical line in vertical mode.
      const lineEl = g.append('line').attr('class', 'current-temp-line')
        .attr('stroke', '#333')
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
        .attr('fill', '#333')
        .attr('stroke', 'white')
        .attr('stroke-width', 2)
        .on('mouseover', (event, d) => {
          tooltip
            .style('opacity', 1)
            .html(
              `<strong>${d.date.toDateString()}</strong><br/>${pointLabels[currentMetric]}: ${(d[currentMetric] as number).toFixed(1)}${units[currentMetric]}<br/><em>Target date</em>`
            )
            .style('left', event.clientX + 12 + 'px')
            .style('top', event.clientY - 28 + 'px');
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

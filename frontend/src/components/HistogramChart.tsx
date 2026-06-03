import React, { useEffect, useRef } from 'react';
import * as d3 from 'd3';
import type { WeatherDataPoint } from '../types';
import type { MetricKey } from '../utils/config';
import CONFIG from '../utils/config';
import './HistogramChart.css';

export type Orientation = 'horizontal' | 'vertical';

interface HistogramChartProps {
  filteredData: WeatherDataPoint[];
  currentMetric: MetricKey;
  currentDate: string;
  fullData: WeatherDataPoint[];
  orientation?: Orientation;
  width?: number;
  height?: number;
}

// horizontal: temp on Y (shared with MainChart on the left), count on X, bars grow →
// vertical:   temp on X (shared with MainChart below), count on Y, bars grow ↓ from top
const MARGIN_H = { top: 20, right: 100, bottom: 40, left: 15 };
const MARGIN_V = { top: 20, right: 20, bottom: 10, left: 55 };

const HistogramChart: React.FC<HistogramChartProps> = ({
  filteredData,
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
  const TOTAL_WIDTH = propWidth ?? (isVertical ? 360 : 300);
  const TOTAL_HEIGHT = propHeight ?? (isVertical ? 180 : 400);

  const width = TOTAL_WIDTH - MARGIN.left - MARGIN.right;
  const height = TOTAL_HEIGHT - MARGIN.top - MARGIN.bottom;

  useEffect(() => {
    if (!svgRef.current || filteredData.length === 0) return;

    const svg = d3.select(svgRef.current);
    svg.selectAll('*').remove();

    const g = svg
      .append('g')
      .attr('transform', `translate(${MARGIN.left},${MARGIN.top})`);

    const tooltip = d3.select(tooltipRef.current);

    const values = filteredData
      .map((d) => d[currentMetric])
      .filter((v): v is number => v !== undefined);

    if (values.length === 0) return;

    const [minVal, maxVal] = d3.extent(values) as [number, number];

    // Temp scale: vertical-orientation puts temp on X (left→right);
    // horizontal-orientation keeps temp on Y (bottom→top, original).
    const tempScale = d3
      .scaleLinear()
      .domain([minVal - 2, maxVal + 2])
      .range(isVertical ? [0, width] : [height, 0]);

    const bins = d3
      .bin()
      .domain(tempScale.domain() as [number, number])
      .thresholds(30)(values);

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

    const units: Record<MetricKey, string> = {
      max_temperature: '°C',
      min_temperature: '°C',
      precipitation_sum: 'mm',
      wind_speed_10m_max: 'm/s',
    };

    // Bars (animate count dimension from 0 on enter). The 1px gap on the temp
    // axis leaves thin white separators between bins, matching the period hists.
    const barSel = g.selectAll('.bar')
      .data(bins)
      .enter()
      .append('rect')
      .attr('class', 'bar')
      .attr('fill', CONFIG.getColorForElement(currentMetric, 'histogramBars'))
      .on('mouseover', (event, d) => {
        tooltip
          .style('opacity', 1)
          .html(
            `${(d.x0 as number).toFixed(1)}–${(d.x1 as number).toFixed(1)}${units[currentMetric]}<br/>${d.length} day${d.length === 1 ? '' : 's'}`
          )
          .style('left', event.clientX + 12 + 'px')
          .style('top', event.clientY - 28 + 'px');
      })
      .on('mouseout', () => tooltip.style('opacity', 0));

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
        .style('fill', '#555')
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
        .style('fill', '#555')
        .text('Count');
    }

    // Current date temperature line + brackets
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

      // Line is perpendicular to the temp axis.
      const tempLine = g.append('line')
        .attr('class', 'current-temp-line')
        .attr('stroke', '#333')
        .attr('stroke-width', 2)
        .attr('stroke-dasharray', '4,3');

      if (isVertical) {
        tempLine
          .attr('x1', tempScale(currentTemp)).attr('x2', tempScale(currentTemp))
          .attr('y1', 0).attr('y2', height);
      } else {
        tempLine
          .attr('x1', 0).attr('x2', width)
          .attr('y1', tempScale(currentTemp)).attr('y2', tempScale(currentTemp));
      }

      const higherCount = values.filter((v) => v > currentTemp).length;
      const total = values.length;
      const pctHigher = ((higherCount / total) * 100).toFixed(1);
      const pctLower = (100 - parseFloat(pctHigher)).toFixed(1);

      if (!isVertical) {
        // Brackets to the right of bars, paired with the horizontal current-temp line.
        const rightX = width + 8;
        const bw = 14;
        const yMid = tempScale(currentTemp);
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
          .attr('stroke', '#666')
          .attr('stroke-width', 1.5)
          .attr('fill', 'none');

        g.append('text')
          .attr('x', rightX + bw + 6)
          .attr('y', (yTop + yMid) / 2)
          .attr('dy', '0.35em')
          .attr('text-anchor', 'start')
          .style('font-size', '12px')
          .style('fill', '#555')
          .text(pctHigher + '%');

        g.append('path')
          .attr(
            'd',
            `M ${rightX + bw * 0.5} ${yMid + 4}
             Q ${rightX + bw * 0.8} ${yMid + 10} ${rightX + bw * 0.5} ${yMid + 20}
             L ${rightX + bw * 0.5} ${yBottom - 18}
             Q ${rightX + bw * 0.8} ${yBottom - 10} ${rightX + bw * 0.5} ${yBottom}
             L ${rightX} ${yBottom}`
          )
          .attr('stroke', '#666')
          .attr('stroke-width', 1.5)
          .attr('fill', 'none');

        g.append('text')
          .attr('x', rightX + bw + 6)
          .attr('y', (yMid + yBottom) / 2)
          .attr('dy', '0.35em')
          .attr('text-anchor', 'start')
          .style('font-size', '12px')
          .style('fill', '#555')
          .text(pctLower + '%');
      } else {
        // Vertical mode: brackets above the bars, paired with the vertical current-temp line.
        // Lower temps are to the LEFT of the line, higher temps to the RIGHT.
        const topY = -8;
        const bw = 14;
        const xMid = tempScale(currentTemp);
        const xLeft = 10;
        const xRight = width - 10;

        // Left bracket (lower%)
        g.append('path')
          .attr(
            'd',
            `M ${xLeft} ${topY}
             L ${xLeft} ${topY - bw * 0.5}
             Q ${xLeft + 10} ${topY - bw * 0.8} ${xLeft + 18} ${topY - bw * 0.5}
             L ${xMid - 20} ${topY - bw * 0.5}
             Q ${xMid - 10} ${topY - bw * 0.8} ${xMid - 4} ${topY - bw * 0.5}`
          )
          .attr('stroke', '#666')
          .attr('stroke-width', 1.5)
          .attr('fill', 'none');

        g.append('text')
          .attr('x', (xLeft + xMid) / 2)
          .attr('y', topY - bw - 4)
          .attr('text-anchor', 'middle')
          .style('font-size', '12px')
          .style('fill', '#555')
          .text(pctLower + '%');

        // Right bracket (higher%)
        g.append('path')
          .attr(
            'd',
            `M ${xMid + 4} ${topY - bw * 0.5}
             Q ${xMid + 10} ${topY - bw * 0.8} ${xMid + 20} ${topY - bw * 0.5}
             L ${xRight - 18} ${topY - bw * 0.5}
             Q ${xRight - 10} ${topY - bw * 0.8} ${xRight} ${topY - bw * 0.5}
             L ${xRight} ${topY}`
          )
          .attr('stroke', '#666')
          .attr('stroke-width', 1.5)
          .attr('fill', 'none');

        g.append('text')
          .attr('x', (xMid + xRight) / 2)
          .attr('y', topY - bw - 4)
          .attr('text-anchor', 'middle')
          .style('font-size', '12px')
          .style('fill', '#555')
          .text(pctHigher + '%');
      }
    }

    // Legend is rendered as an HTML element above the charts for both
    // mobile and desktop (see App.tsx).

  }, [filteredData, currentMetric, currentDate, fullData, width, height, isVertical]);

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

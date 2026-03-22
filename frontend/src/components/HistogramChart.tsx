import React, { useEffect, useRef } from 'react';
import * as d3 from 'd3';
import type { WeatherDataPoint } from '../types';
import type { MetricKey } from '../utils/config';
import CONFIG from '../utils/config';
import './HistogramChart.css';

interface HistogramChartProps {
  filteredData: WeatherDataPoint[];
  currentMetric: MetricKey;
  currentDate: string;
  fullData: WeatherDataPoint[];
}

const MARGIN = { top: 20, right: 70, bottom: 40, left: 40 };
const TOTAL_HEIGHT = 400;
const TOTAL_WIDTH = 280;

const HistogramChart: React.FC<HistogramChartProps> = ({
  filteredData,
  currentMetric,
  currentDate,
  fullData,
}) => {
  const svgRef = useRef<SVGSVGElement>(null);

  const width = TOTAL_WIDTH - MARGIN.left - MARGIN.right;
  const height = TOTAL_HEIGHT - MARGIN.top - MARGIN.bottom;

  useEffect(() => {
    if (!svgRef.current || filteredData.length === 0) return;

    const svg = d3.select(svgRef.current);
    svg.selectAll('*').remove();

    const g = svg
      .append('g')
      .attr('transform', `translate(${MARGIN.left},${MARGIN.top})`);

    const values = filteredData
      .map((d) => d[currentMetric])
      .filter((v): v is number => v !== undefined);

    if (values.length === 0) return;

    const [minVal, maxVal] = d3.extent(values) as [number, number];

    // Y scale (temperature axis, vertical)
    const yScale = d3
      .scaleLinear()
      .domain([minVal - 2, maxVal + 2])
      .range([height, 0]);

    // Build histogram bins
    const bins = d3
      .bin()
      .domain(yScale.domain() as [number, number])
      .thresholds(30)(values);

    // X scale (count axis, horizontal)
    const xScale = d3
      .scaleLinear()
      .domain([0, d3.max(bins, (d) => d.length) as number])
      .range([0, width]);

    // Bars
    g.selectAll('.bar')
      .data(bins)
      .enter()
      .append('rect')
      .attr('class', 'bar')
      .attr('x', 0)
      .attr('y', (d) => yScale(d.x1 as number))
      .attr('width', (d) => xScale(d.length))
      .attr('height', (d) => yScale(d.x0 as number) - yScale(d.x1 as number))
      .attr('fill', CONFIG.getColorForElement(currentMetric, 'histogramBars'));

    // X axis (count)
    g.append('g')
      .attr('class', 'axis')
      .attr('transform', `translate(0,${height})`)
      .call(d3.axisBottom(xScale).ticks(4));

    g.append('text')
      .attr('transform', `translate(${width / 2},${height + 35})`)
      .style('text-anchor', 'middle')
      .style('font-size', '12px')
      .style('fill', '#555')
      .text('Count');

    // Y axis (temperature)
    g.append('g')
      .attr('class', 'axis')
      .call(d3.axisLeft(yScale).ticks(6));

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

      g.append('line')
        .attr('class', 'current-temp-line')
        .attr('x1', 0)
        .attr('x2', width)
        .attr('y1', yScale(currentTemp))
        .attr('y2', yScale(currentTemp))
        .attr('stroke', '#333')
        .attr('stroke-width', 2)
        .attr('stroke-dasharray', '4,3');

      // Percentile brackets
      const higherCount = values.filter((v) => v > currentTemp).length;
      const total = values.length;
      const pctHigher = ((higherCount / total) * 100).toFixed(1);
      const pctLower = (100 - parseFloat(pctHigher)).toFixed(1);

      const rightX = width + 8;
      const bw = 14;
      const yMid = yScale(currentTemp);
      const yTop = 10;
      const yBottom = height - 10;

      // Upper bracket
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

      // Lower bracket
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
    }


  }, [filteredData, currentMetric, currentDate, fullData, width, height]);

  return (
    <div className="histogram-chart-wrapper">
      <svg
        ref={svgRef}
        width={TOTAL_WIDTH}
        height={TOTAL_HEIGHT}
        className="histogram-chart-svg"
      />
    </div>
  );
};

export default HistogramChart;

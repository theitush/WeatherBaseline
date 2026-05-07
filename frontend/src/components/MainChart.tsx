import React, { useEffect, useRef } from 'react';
import * as d3 from 'd3';
import type { WeatherDataPoint, YearlyAggregate } from '../types';
import type { MetricKey } from '../utils/config';
import CONFIG from '../utils/config';
import './MainChart.css';

interface MainChartProps {
  filteredData: WeatherDataPoint[];
  yearlyAggregates: YearlyAggregate[];
  currentMetric: MetricKey;
  currentDate: string;
  fullData: WeatherDataPoint[];
}

const MARGIN = { top: 20, right: 30, bottom: 40, left: 55 };

const MainChart: React.FC<MainChartProps> = ({
  filteredData,
  yearlyAggregates,
  currentMetric,
  currentDate,
  fullData,
}) => {
  const svgRef = useRef<SVGSVGElement>(null);
  const tooltipRef = useRef<HTMLDivElement>(null);

  const totalWidth = 720;
  const totalHeight = 400;
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

    // Scales
    const dateExtent = d3.extent(filteredData, (d) => d.date) as [Date, Date];
    const allValues = filteredData
      .map((d) => d[currentMetric])
      .filter((v): v is number => v !== undefined);
    const [minVal, maxVal] = d3.extent(allValues) as [number, number];

    const xScale = d3.scaleTime().domain(dateExtent).range([0, width]);
    const yScale = d3
      .scaleLinear()
      .domain([minVal - 2, maxVal + 2])
      .range([height, 0]);

    // Grid
    g.append('g')
      .attr('class', 'grid')
      .attr('transform', `translate(0,${height})`)
      .call(d3.axisBottom(xScale).tickSize(-height).tickFormat(() => ''));

    g.append('g')
      .attr('class', 'grid')
      .call(d3.axisLeft(yScale).tickSize(-width).tickFormat(() => ''));

    // Axes
    g.append('g')
      .attr('class', 'axis')
      .attr('transform', `translate(0,${height})`)
      .call(d3.axisBottom(xScale).tickFormat(d3.timeFormat('%Y') as any));

    g.append('g').attr('class', 'axis').call(d3.axisLeft(yScale));

    // Y-axis label
    const yLabels: Record<MetricKey, string> = {
      max_temperature: 'Max Apparent Temp (°C)',
      min_temperature: 'Min Apparent Temp (°C)',
      precipitation_sum: 'Precipitation (mm)',
      wind_speed_10m_max: 'Max Wind Speed (km/h)',
    };
    g.append('text')
      .attr('transform', 'rotate(-90)')
      .attr('y', -MARGIN.left + 10)
      .attr('x', -height / 2)
      .attr('dy', '1em')
      .style('text-anchor', 'middle')
      .style('font-size', '12px')
      .style('fill', '#555')
      .text(yLabels[currentMetric]);

    // Percentile bands (only draw if we have valid aggregate data)
    const validAggs = yearlyAggregates.filter(
      (d) =>
        d.date &&
        (d.p10 !== undefined || d.moving10 !== null) &&
        (d.p90 !== undefined || d.moving90 !== null)
    );

    if (validAggs.length > 0) {
      const area90 = d3
        .area<YearlyAggregate>()
        .x((d) => xScale(d.date))
        .y0((d) => yScale((d.p10 ?? d.moving10) as number))
        .y1((d) => yScale((d.p90 ?? d.moving90) as number))
        .curve(d3.curveMonotoneX);

      const area75 = d3
        .area<YearlyAggregate>()
        .x((d) => xScale(d.date))
        .y0((d) => yScale((d.p25 ?? d.moving25) as number))
        .y1((d) => yScale((d.p75 ?? d.moving75) as number))
        .curve(d3.curveMonotoneX);

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

      // Trend line (rolling median)
      const trendData = validAggs.filter((d) => d.movingMedian !== null);
      if (trendData.length > 0) {
        const line = d3
          .line<YearlyAggregate>()
          .x((d) => xScale(d.date))
          .y((d) => yScale(d.movingMedian as number))
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
      wind_speed_10m_max: 'km/h',
    };
    const pointLabels: Record<MetricKey, string> = {
      max_temperature: 'Max Apparent Temp',
      min_temperature: 'Min Apparent Temp',
      precipitation_sum: 'Precipitation',
      wind_speed_10m_max: 'Max Wind Speed',
    };

    const dotSelection = g.selectAll('.data-point')
      .data(filteredData.filter((d) => d[currentMetric] !== undefined))
      .enter()
      .append('circle')
      .attr('class', 'data-point')
      .attr('cx', (d) => xScale(d.date))
      .attr('cy', (d) => yScale(d[currentMetric] as number))
      .attr('r', 2)
      .attr('fill', CONFIG.getColorForElement(currentMetric, 'dataPoints'))
      .style('opacity', 0);

    dotSelection.transition().duration(500).style('opacity', 1);

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

      g.append('line')
        .attr('class', 'current-temp-line')
        .attr('x1', 0)
        .attr('x2', width)
        .attr('y1', yScale(currentTemp))
        .attr('y2', yScale(currentTemp))
        .attr('stroke', '#333')
        .attr('stroke-width', 1.5)
        .attr('stroke-dasharray', '5,5');

      g.selectAll('.current-temp-point')
        .data(currentDateData)
        .enter()
        .append('circle')
        .attr('class', 'current-temp-point')
        .attr('cx', (d) => xScale(d.date))
        .attr('cy', (d) => yScale(d[currentMetric] as number))
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
            .style('left', event.pageX + 12 + 'px')
            .style('top', event.pageY - 28 + 'px');
        })
        .on('mouseout', () => tooltip.style('opacity', 0));
    }
  }, [filteredData, yearlyAggregates, currentMetric, currentDate, fullData, width, height]);

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

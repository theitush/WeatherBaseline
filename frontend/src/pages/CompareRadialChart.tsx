import React, { useEffect, useRef } from 'react';
import * as d3 from 'd3';
import type { MetricKey } from '../utils/config';
import { useUnits } from '../hooks/useUnits';
import { convert, unitLabel, tickCount, valueDecimals } from '../utils/units';
import type { BandKey, Series, SeriesData } from './compareTypes';
import { DOY_COUNT, buildDialTracks, dayFraction } from './compareStats';
import type { BandPath, Pt } from './compareStats';
import { placeTooltip } from '../utils/tooltip';
import './CompareRadialChart.css';

// A single series resolved against its loaded data, ready to draw.
export interface ResolvedSeries {
  series: Series;
  data: SeriesData;
}

interface CompareRadialChartProps {
  /** Series to draw on this dial. ALL must share `axisMetric` (and thus a unit). */
  series: ResolvedSeries[];
  /** The metric whose unit/labels the dial axis is drawn in. */
  axisMetric: MetricKey;
  /**
   * Shared value domain [min, max] in DISPLAY units for the radius scale. Pooled
   * across every series on this dial so they're directly comparable, and taken
   * from the layers actually drawn. When omitted the dial auto-scales to its own
   * series.
   */
  domain?: [number, number];
  /**
   * 'all' draws every day as a faint dot. 'percentile' replaces the cloud with
   * per-track quantile bands around the day of the year, plus the days falling
   * outside the 1–99 band drawn faintly as outliers.
   */
  pointMode?: 'all' | 'percentile';
  /** Which percentile layers to draw. Anything absent is simply not drawn. */
  bands: BandKey[];
  width?: number;
  height?: number;
}

const MONTHS = ['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun',
  'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec'];

const CompareRadialChart: React.FC<CompareRadialChartProps> = ({
  series,
  axisMetric,
  domain,
  pointMode = 'all',
  bands,
  width: propWidth,
  height: propHeight,
}) => {
  const svgRef = useRef<SVGSVGElement>(null);
  const canvasRef = useRef<HTMLCanvasElement>(null);
  const tooltipRef = useRef<HTMLDivElement>(null);
  const { system } = useUnits();

  const totalWidth = propWidth ?? 420;
  const totalHeight = propHeight ?? 420;

  useEffect(() => {
    if (!svgRef.current || !canvasRef.current) return;

    const unit = unitLabel(axisMetric, system);

    const svg = d3.select(svgRef.current);
    svg.selectAll('*').remove();

    const cx = totalWidth / 2;
    const cy = totalHeight / 2;
    const labelPad = 24;
    const rOuter = Math.min(cx, cy) - labelPad;
    const rInner = rOuter * 0.12;

    const tooltip = d3.select(tooltipRef.current);
    // Shared viewport-aware placement: keeps the tooltip on-screen near any edge
    // (it overflowed off the right/bottom on mobile when placed by raw offset).
    const placeTip = (event: MouseEvent) => placeTooltip(tooltipRef.current, event);

    const g = svg.append('g').attr('transform', `translate(${cx},${cy})`);

    // ---- the drawable tracks (archive only), one per period ----------------
    const tracks = buildDialTracks(
      series.map(({ series: s, data }) => ({ series: s, rows: data.rows })),
      (raw, metric) => convert(raw, metric, system),
      pointMode,
      bands
    );
    const allPts = tracks.flatMap((t) => t.pts);

    // ---- radius scale: shared domain if given, else this dial's own extent --
    let vMin: number;
    let vMax: number;
    if (domain) {
      [vMin, vMax] = domain;
    } else if (allPts.length > 0) {
      const ext = d3.extent(allPts, (p) => p.val) as [number, number];
      const pad = (ext[1] - ext[0]) * 0.1 || 1;
      vMin = ext[0] - pad;
      vMax = ext[1] + pad;
    } else {
      vMin = 0;
      vMax = 1;
    }
    const rScale = d3.scaleLinear().domain([vMin, vMax]).range([rInner, rOuter]);

    // Jan 1 fixed at 12 o'clock, clockwise through the year. No rotation.
    const angle = (frac: number) => frac * 2 * Math.PI - Math.PI / 2;
    const polar = (frac: number, r: number): [number, number] => {
      const a = angle(frac);
      return [r * Math.cos(a), r * Math.sin(a)];
    };

    // ---- reference rings + value labels ------------------------------------
    // tickCount caps precip so ring steps never go below 1 mm / 0.05 in.
    const ringTicks = rScale.ticks(tickCount(axisMetric, system, vMax - vMin, 4));
    g.selectAll('.cmp-grid-ring')
      .data(ringTicks)
      .enter()
      .append('circle')
      .attr('class', 'cmp-grid-ring')
      .attr('r', (t) => rScale(t))
      .attr('fill', 'none')
      .attr('stroke', 'var(--chart-grid)')
      .attr('stroke-dasharray', '2,3');

    const spoke = (2 * Math.PI) / 12;
    const labelAngle = -Math.PI / 2 - 2 * spoke;
    g.selectAll('.cmp-ring-label')
      .data(ringTicks)
      .enter()
      .append('text')
      .attr('class', 'cmp-ring-label')
      .attr('x', (t) => rScale(t) * Math.cos(labelAngle))
      .attr('y', (t) => rScale(t) * Math.sin(labelAngle))
      .attr('dy', '0.32em')
      .style('text-anchor', 'middle')
      .style('font-size', '9px')
      .style('fill', 'var(--chart-label)')
      .text((t) => `${t}${unit}`);

    // ---- month rays + labels ------------------------------------------------
    for (let m = 0; m < 12; m++) {
      const frac = m / 12;
      const [x2, y2] = polar(frac, rOuter);
      g.append('line')
        .attr('class', 'cmp-month-ray')
        .attr('x1', polar(frac, rInner)[0])
        .attr('y1', polar(frac, rInner)[1])
        .attr('x2', x2)
        .attr('y2', y2)
        .attr('stroke', 'var(--chart-axis)')
        .attr('stroke-width', 0.5)
        .attr('opacity', 0.4);

      const [lx, ly] = polar((m + 0.5) / 12, rOuter + 13);
      g.append('text')
        .attr('class', 'cmp-month-label')
        .attr('x', lx)
        .attr('y', ly)
        .attr('dy', '0.32em')
        .style('text-anchor', 'middle')
        .style('font-size', '10px')
        .style('fill', 'var(--text-tertiary)')
        .text(MONTHS[m]);
    }

    // ---- per-track percentile bands (percentile mode only) -----------------
    // Widest first, so the palest sits underneath the tighter ones.
    const radialArea = d3
      .areaRadial<BandPath['points'][number]>()
      .angle((d) => d.frac * 2 * Math.PI)
      .innerRadius((d) => rScale(d.lo))
      .outerRadius((d) => rScale(d.hi))
      .curve(d3.curveCardinalClosed);

    for (const track of tracks) {
      for (const band of track.bands) {
        g.append('path')
          .datum(band.points)
          .attr('class', `cmp-band cmp-band-${band.key}`)
          .attr('fill', track.color)
          .attr('opacity', band.opacity)
          .attr('d', radialArea as never);
      }
    }

    // ---- per-track day cloud on CANVAS --------------------------------------
    // In 'all' mode this is every day; in 'percentile' mode just the outliers.
    const canvas = canvasRef.current;
    const dpr = window.devicePixelRatio || 1;
    canvas.width = totalWidth * dpr;
    canvas.height = totalHeight * dpr;
    const ctx = canvas.getContext('2d');
    if (ctx) {
      ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
      ctx.clearRect(0, 0, totalWidth, totalHeight);
      ctx.translate(cx, cy);
      const cloudPts: Pt[] =
        pointMode === 'percentile' ? tracks.flatMap((t) => t.outliers) : allPts;
      // Lighter cloud when overlaying several tracks so they don't muddy
      // together. Outliers (beyond 1–99) get a fixed 10% alpha.
      const cloudAlpha =
        pointMode === 'percentile' ? 0.1 : tracks.length > 1 ? 0.06 : 0.1;
      for (const p of cloudPts) {
        const [x, y] = polar(dayFraction(p.date), rScale(p.val));
        ctx.fillStyle = p.color;
        ctx.globalAlpha = cloudAlpha;
        ctx.beginPath();
        ctx.arc(x, y, 1.3, 0, 2 * Math.PI);
        ctx.fill();
      }
    }
    d3.select(canvas)
      .style('opacity', 0)
      .transition()
      .duration(400)
      .style('opacity', 1);

    // ---- difference shading: which half runs higher, day by day ------------
    // Drawn between the two median rings of one split series and BELOW them.
    // Two full-circle areas rather than clipped arcs: the "late higher" area
    // spans early→max(early,late) and so collapses to nothing wherever the
    // early half is on top, and the "early higher" area is the mirror. That
    // makes the crossings seamless — no gap at the day the two rings swap.
    type Diff = { frac: number; early: number; late: number };
    for (const { series: s } of series) {
      if (!s.split || !s.diffShade) continue;
      const mine = tracks.filter((t) => t.seriesId === s.id);
      const early = mine.find((t) => t.half === 'early');
      const late = mine.find((t) => t.half === 'late');
      if (!early || !late) continue;

      const diff: Diff[] = [];
      for (const [doy, e] of early.medianByDoy) {
        const l = late.medianByDoy.get(doy);
        if (l === undefined) continue;
        diff.push({ frac: doy / DOY_COUNT, early: e, late: l });
      }
      if (diff.length <= 8) continue;
      diff.sort((a, b) => a.frac - b.frac);
      // Repeat the first day at frac=1 so the ribbon closes across Dec 31→Jan 1.
      diff.push({ ...diff[0], frac: 1 });

      const shade = (inner: (d: Diff) => number, color: string, cls: string) =>
        g
          .append('path')
          .datum(diff)
          .attr('class', `cmp-diff-shade ${cls}`)
          .attr('fill', color)
          .attr('opacity', 0.75)
          .attr(
            'd',
            d3
              .areaRadial<Diff>()
              .angle((d) => d.frac * 2 * Math.PI)
              .innerRadius((d) => rScale(inner(d)))
              .outerRadius((d) => rScale(Math.max(d.early, d.late)))
              .curve(d3.curveLinear) as never
          );

      shade((d) => d.early, late.color, 'cmp-diff-late');
      shade((d) => d.late, early.color, 'cmp-diff-early');
    }

    // ---- median rings on top of the shading --------------------------------
    if (bands.includes('median')) {
      const radialLine = d3
        .lineRadial<{ frac: number; val: number }>()
        .angle((d) => d.frac * 2 * Math.PI)
        .radius((d) => rScale(d.val))
        .curve(d3.curveCardinalClosed);
      for (const track of tracks) {
        if (!track.median) continue;
        g.append('path')
          .datum(track.median)
          .attr('class', 'cmp-median')
          .attr('fill', 'none')
          .attr('stroke', track.color)
          .attr('stroke-width', 1.75)
          .attr('opacity', 0.9)
          .attr('d', radialLine as never);
      }
    }

    // ---- per-series date markers: dashed value ring + dot ------------------
    for (const { series: s, data } of series) {
      for (const marker of s.markers) {
        const targetDt = new Date(marker.date + 'T00:00:00');
        const row = data.rows.find(
          (d) =>
            d.date.getFullYear() === targetDt.getFullYear() &&
            d.date.getMonth() === targetDt.getMonth() &&
            d.date.getDate() === targetDt.getDate() &&
            d[s.metric as MetricKey] !== undefined
        );
        if (!row) continue;
        const val = convert(row[s.metric as MetricKey] as number, axisMetric, system);
        const tR = rScale(val);
        const [mx, my] = polar(dayFraction(row.date), tR);

        g.append('circle')
          .attr('class', 'cmp-marker-ring')
          .attr('r', tR)
          .attr('fill', 'none')
          .attr('stroke', marker.color)
          .attr('stroke-width', 1.5)
          .attr('stroke-dasharray', '5,5')
          .attr('opacity', 0.85);

        g.append('circle')
          .attr('class', 'cmp-marker-dot')
          .attr('cx', mx)
          .attr('cy', my)
          .attr('r', 5)
          .attr('fill', marker.color)
          .attr('stroke', 'var(--surface)')
          .attr('stroke-width', 2)
          .on('mousemove', (event: MouseEvent) => {
            tooltip
              .style('opacity', 1)
              .html(
                `<strong>${row.date.toDateString()}</strong><br/>` +
                  `${val.toFixed(valueDecimals(axisMetric, system))}${unit}<br/><em>${s.name}</em>`
              );
            placeTip(event);
          })
          .on('mouseout', () => tooltip.style('opacity', 0));
      }
    }
  }, [series, axisMetric, domain, pointMode, bands, totalWidth, totalHeight, system]);

  return (
    <div className="cmp-radial-wrapper" style={{ width: totalWidth, height: totalHeight }}>
      <canvas
        ref={canvasRef}
        className="cmp-radial-canvas"
        style={{ width: totalWidth, height: totalHeight }}
      />
      <svg ref={svgRef} width={totalWidth} height={totalHeight} className="cmp-radial-svg" />
      <div ref={tooltipRef} className="cmp-tooltip" />
    </div>
  );
};

export default CompareRadialChart;

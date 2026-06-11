import React, { useEffect, useRef } from 'react';
import * as d3 from 'd3';
import type { MetricKey } from '../utils/config';
import { useUnits } from '../hooks/useUnits';
import { convert, unitLabel } from '../utils/units';
import type { Series, SeriesData } from './compareTypes';
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
   * across every series on this dial so they're directly comparable. When
   * omitted the dial auto-scales to its own series.
   */
  domain?: [number, number];
  /**
   * 'all' draws every day as a faint dot. 'percentile' replaces the cloud with
   * per-series 1–99, 5–95 and 25–75 bands (around the day-of-year), plus the
   * dots that fall outside the 1–99 band drawn faintly as outliers.
   */
  pointMode?: 'all' | 'percentile';
  width?: number;
  height?: number;
}

const MONTHS = ['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun',
  'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec'];

// Day-of-year [0,1) for the angular position (leap day collapses onto ~Mar 1).
const dayFraction = (d: Date): number => {
  const start = Date.UTC(d.getFullYear(), 0, 1);
  const here = Date.UTC(d.getFullYear(), d.getMonth(), d.getDate());
  const len = Date.UTC(d.getFullYear() + 1, 0, 1) - start;
  return (here - start) / len;
};

const CompareRadialChart: React.FC<CompareRadialChartProps> = ({
  series,
  axisMetric,
  domain,
  pointMode = 'all',
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

    const cv = (v: number) => convert(v, axisMetric, system);
    const unit = unitLabel(axisMetric, system);

    const svg = d3.select(svgRef.current);
    svg.selectAll('*').remove();

    const cx = totalWidth / 2;
    const cy = totalHeight / 2;
    const labelPad = 24;
    const rOuter = Math.min(cx, cy) - labelPad;
    const rInner = rOuter * 0.12;

    const tooltip = d3.select(tooltipRef.current);
    const placeTip = (event: MouseEvent) => {
      const el = tooltipRef.current;
      if (!el) return;
      el.style.left = `${event.offsetX + 14}px`;
      el.style.top = `${event.offsetY + 14}px`;
    };

    const g = svg.append('g').attr('transform', `translate(${cx},${cy})`);

    // ---- gather every drawable point (archive only) across the series -------
    type Pt = { date: Date; val: number; color: string };
    const allPts: Pt[] = [];
    const perSeriesPts = new Map<string, Pt[]>();
    for (const { series: s, data } of series) {
      const pts: Pt[] = [];
      for (const d of data.rows) {
        const raw = d[s.metric as MetricKey];
        if (raw === undefined) continue;
        const yr = d.date.getFullYear();
        if (yr < s.startYear || yr > s.endYear) continue;
        const p = { date: d.date, val: cv(raw), color: s.color };
        pts.push(p);
        allPts.push(p);
      }
      perSeriesPts.set(s.id, pts);
    }

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
    const ringTicks = rScale.ticks(4);
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

    // ---- per-series percentile bands (percentile mode only) ----------------
    // Build, per series, the day-of-year quantile envelopes. Returns the set of
    // points that fall OUTSIDE the 1–99 band so the cloud can draw them as
    // faint outliers. Bands are nested radial areas, palest 1–99 outermost.
    type Band = { frac: number; lo: number; hi: number };
    const radialArea = d3
      .areaRadial<Band>()
      .angle((d) => d.frac * 2 * Math.PI)
      .innerRadius((d) => rScale(d.lo))
      .outerRadius((d) => rScale(d.hi))
      .curve(d3.curveCardinalClosed);

    const outlierPts: Pt[] = [];
    if (pointMode === 'percentile') {
      for (const { series: s } of series) {
        const pts = perSeriesPts.get(s.id) ?? [];
        if (pts.length === 0) continue;
        const byDoy = d3.group(pts, (p) => Math.floor(dayFraction(p.date) * 365));
        const band199: Band[] = [];
        const band595: Band[] = [];
        const band2575: Band[] = [];
        // thresholds[doy] = [p1, p99] for the outlier test below.
        const thresh = new Map<number, [number, number]>();
        for (const [doy, rows] of byDoy) {
          const vals = rows.map((r) => r.val).sort(d3.ascending);
          const p1 = d3.quantileSorted(vals, 0.01) as number;
          const p5 = d3.quantileSorted(vals, 0.05) as number;
          const p25 = d3.quantileSorted(vals, 0.25) as number;
          const p75 = d3.quantileSorted(vals, 0.75) as number;
          const p95 = d3.quantileSorted(vals, 0.95) as number;
          const p99 = d3.quantileSorted(vals, 0.99) as number;
          const frac = doy / 365;
          band199.push({ frac, lo: p1, hi: p99 });
          band595.push({ frac, lo: p5, hi: p95 });
          band2575.push({ frac, lo: p25, hi: p75 });
          thresh.set(doy, [p1, p99]);
        }
        if (band199.length <= 8) continue;
        band199.sort((a, b) => a.frac - b.frac);
        band595.sort((a, b) => a.frac - b.frac);
        band2575.sort((a, b) => a.frac - b.frac);

        g.append('path')
          .datum(band199)
          .attr('class', 'cmp-band cmp-band-199')
          .attr('fill', s.color)
          .attr('opacity', 0.08)
          .attr('d', radialArea as never);
        g.append('path')
          .datum(band595)
          .attr('class', 'cmp-band cmp-band-595')
          .attr('fill', s.color)
          .attr('opacity', 0.15)
          .attr('d', radialArea as never);
        g.append('path')
          .datum(band2575)
          .attr('class', 'cmp-band cmp-band-2575')
          .attr('fill', s.color)
          .attr('opacity', 0.32)
          .attr('d', radialArea as never);

        for (const p of pts) {
          const doy = Math.floor(dayFraction(p.date) * 365);
          const t = thresh.get(doy);
          if (t && (p.val < t[0] || p.val > t[1])) outlierPts.push(p);
        }
      }
    }

    // ---- per-series day cloud on CANVAS ------------------------------------
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
      const cloudPts = pointMode === 'percentile' ? outlierPts : allPts;
      // Lighter cloud when overlaying many series so they don't muddy together.
      // Outliers (beyond 1–99) get a fixed 10% alpha.
      const cloudAlpha =
        pointMode === 'percentile' ? 0.1 : series.length > 1 ? 0.06 : 0.1;
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

    // ---- per-series median ring --------------------------------------------
    for (const { series: s } of series) {
      const pts = perSeriesPts.get(s.id) ?? [];
      if (pts.length === 0) continue;
      const byDoy = d3.rollup(
        pts,
        (rows) => d3.median(rows, (p) => p.val) as number,
        (p) => Math.floor(dayFraction(p.date) * 365)
      );
      const medianPath = Array.from(byDoy, ([doy, val]) => ({ frac: doy / 365, val }))
        .sort((a, b) => a.frac - b.frac);
      if (medianPath.length <= 8) continue;
      const radialLine = d3
        .lineRadial<{ frac: number; val: number }>()
        .angle((d) => d.frac * 2 * Math.PI)
        .radius((d) => rScale(d.val))
        .curve(d3.curveCardinalClosed);
      g.append('path')
        .datum(medianPath)
        .attr('class', 'cmp-median')
        .attr('fill', 'none')
        .attr('stroke', s.color)
        .attr('stroke-width', 1.75)
        .attr('opacity', 0.9)
        .attr('d', radialLine as never);
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
        const val = cv(row[s.metric as MetricKey] as number);
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
                  `${val.toFixed(1)}${unit}<br/><em>${s.name}</em>`
              );
            placeTip(event);
          })
          .on('mouseout', () => tooltip.style('opacity', 0));
      }
    }
  }, [series, axisMetric, domain, pointMode, totalWidth, totalHeight, system]);

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

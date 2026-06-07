import React, { useEffect, useRef } from 'react';
import * as d3 from 'd3';
import type { WeatherDataPoint } from '../types';
import type { MetricKey } from '../utils/config';
import CONFIG from '../utils/config';
import { placeTooltip } from '../utils/tooltip';
import { useUnits } from '../hooks/useUnits';
import { convert, unitLabel } from '../utils/units';
import './YearRadialChart.css';

interface YearRadialChartProps {
  /** Entire location record (all years), used for the faint overlay cloud. */
  fullData: WeatherDataPoint[];
  currentMetric: MetricKey;
  currentDate: string;
  width?: number;
  height?: number;
}

// "Jun 5th" — short month + ordinal day for the top-of-spoke date label.
const ordinal = (n: number): string => {
  const s = ['th', 'st', 'nd', 'rd'];
  const v = n % 100;
  return n + (s[(v - 20) % 10] || s[v] || s[0]);
};

const MONTHS = ['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun',
  'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec'];
const MONTH_FULL = ['January', 'February', 'March', 'April', 'May', 'June',
  'July', 'August', 'September', 'October', 'November', 'December'];

// Day-of-year [0,1) for the angular position. Leap day (Feb 29) collapses onto
// the same slot as ~Mar 1; with thousands of overlaid points that's invisible.
const dayFraction = (d: Date): number => {
  const start = Date.UTC(d.getFullYear(), 0, 1);
  const here = Date.UTC(d.getFullYear(), d.getMonth(), d.getDate());
  const len = Date.UTC(d.getFullYear() + 1, 0, 1) - start;
  return (here - start) / len;
};

const YearRadialChart: React.FC<YearRadialChartProps> = ({
  fullData,
  currentMetric,
  currentDate,
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
    if (!svgRef.current || !canvasRef.current || fullData.length === 0) return;

    const cv = (v: number) => convert(v, currentMetric, system);
    const unit = unitLabel(currentMetric, system);
    const baseColor = CONFIG.metricColors[currentMetric].base;

    const svg = d3.select(svgRef.current);
    svg.selectAll('*').remove();

    const cx = totalWidth / 2;
    const cy = totalHeight / 2;
    // Leave a ring of margin for the month labels around the outside.
    const labelPad = 22;
    const rOuter = Math.min(cx, cy) - labelPad;
    const rInner = rOuter * 0.12; // small hole so the center isn't a pile-up

    const tooltip = d3.select(tooltipRef.current);
    const place = (event: { clientX: number; clientY: number }) =>
      placeTooltip(tooltipRef.current, event);

    const g = svg.append('g').attr('transform', `translate(${cx},${cy})`);

    // --- radius scale: raw value, padded 10% below min / above max ----------
    // Dial shows ONLY the settled long-run archive — no 'recent' (live-model
    // topped-up) days and no 'forecast'.
    const pts = fullData.filter(
      (d) => d[currentMetric] !== undefined && d.data_type === 'historical'
    );
    if (pts.length === 0) return;

    const vals = pts.map((d) => cv(d[currentMetric] as number));
    const [vMin, vMax] = d3.extent(vals) as [number, number];
    const pad = (vMax - vMin) * 0.1 || 1;
    const rScale = d3
      .scaleLinear()
      .domain([vMin - pad, vMax + pad])
      .range([rInner, rOuter]);

    // The whole dial is rotated so the TARGET day sits at 12 o'clock — its
    // day-of-year fraction is subtracted from every angle. Months therefore
    // don't sit at fixed clock positions; they rotate with the selected date.
    const targetDt = new Date(currentDate + 'T00:00:00');
    const targetFrac = dayFraction(targetDt);

    // angle: target day at top (12 o'clock), clockwise through the year.
    const angle = (frac: number) =>
      (frac - targetFrac) * 2 * Math.PI - Math.PI / 2;
    const polar = (frac: number, r: number): [number, number] => {
      const a = angle(frac);
      return [r * Math.cos(a), r * Math.sin(a)];
    };

    // --- the day cloud on CANVAS -------------------------------------------
    // ~27k dots (75 years × 365) are far too many SVG nodes to rebuild on every
    // metric switch without a multi-second stall. The cloud is purely visual
    // (no per-dot hover — tooltips are the 12 month wedges below), so we paint
    // it to a canvas layered behind the SVG: one draw call, no DOM to tear down,
    // so switching metrics is instant. The whole layer fades in via CSS opacity.
    const canvas = canvasRef.current;
    const dpr = window.devicePixelRatio || 1;
    canvas.width = totalWidth * dpr;
    canvas.height = totalHeight * dpr;
    const ctx = canvas.getContext('2d');
    if (ctx) {
      ctx.setTransform(dpr, 0, 0, dpr, 0, 0); // crisp on retina
      ctx.clearRect(0, 0, totalWidth, totalHeight);
      ctx.translate(cx, cy);
      ctx.fillStyle = baseColor;
      ctx.globalAlpha = 0.1;
      for (const d of pts) {
        const [x, y] = polar(dayFraction(d.date), rScale(cv(d[currentMetric] as number)));
        ctx.beginPath();
        ctx.arc(x, y, 1.4, 0, 2 * Math.PI);
        ctx.fill();
      }
    }
    // Fade the canvas layer in once (cheap — one element, not 27k).
    d3.select(canvas)
      .style('opacity', 0)
      .transition()
      .duration(500)
      .style('opacity', 1);

    // --- reference rings (a couple of value gridlines) ----------------------
    const ringTicks = rScale.ticks(4);
    g.selectAll('.radial-grid-ring')
      .data(ringTicks)
      .enter()
      .append('circle')
      .attr('class', 'radial-grid-ring')
      .attr('r', (t) => rScale(t))
      .attr('fill', 'none')
      .attr('stroke', 'var(--chart-grid)')
      .attr('stroke-dasharray', '2,3');

    // value labels on the rings, set on a quiet 10-o'clock diagonal so they
    // don't sit on the target spoke (which now runs straight up to the top).
    const labelAngle = -Math.PI / 2 - 0.45; // just left of vertical
    g.selectAll('.radial-ring-label')
      .data(ringTicks)
      .enter()
      .append('text')
      .attr('class', 'radial-ring-label')
      .attr('x', (t) => rScale(t) * Math.cos(labelAngle))
      .attr('y', (t) => rScale(t) * Math.sin(labelAngle))
      .attr('dy', '0.32em')
      .style('text-anchor', 'middle')
      .style('font-size', '9px')
      .style('fill', 'var(--chart-label)')
      .text((t) => `${t}${unit}`);

    // --- month rays + labels ------------------------------------------------
    for (let m = 0; m < 12; m++) {
      const frac = m / 12;
      const [x2, y2] = polar(frac, rOuter);
      g.append('line')
        .attr('class', 'radial-month-ray')
        .attr('x1', polar(frac, rInner)[0])
        .attr('y1', polar(frac, rInner)[1])
        .attr('x2', x2)
        .attr('y2', y2)
        .attr('stroke', 'var(--chart-axis)')
        .attr('stroke-width', 0.5)
        .attr('opacity', 0.4);

      // label sits just outside the ring, centred on the month's middle
      const [lx, ly] = polar((m + 0.5) / 12, rOuter + 12);
      g.append('text')
        .attr('class', 'radial-month-label')
        .attr('x', lx)
        .attr('y', ly)
        .attr('dy', '0.32em')
        .style('text-anchor', 'middle')
        .style('font-size', '10px')
        .style('fill', 'var(--text-tertiary)')
        .text(MONTHS[m]);
    }

    // --- median ring (day-of-year median across all years) ------------------
    // Bucket by day-of-year, take the median value in each bucket, draw a closed
    // radial curve. Smooths the seasonal cycle the day-cloud only hints at.
    const byDoy = d3.rollup(
      pts,
      (rows) => d3.median(rows, (d) => cv(d[currentMetric] as number)) as number,
      (d) => Math.floor(dayFraction(d.date) * 365)
    );
    const medianPath: Array<{ frac: number; val: number }> = Array.from(byDoy, ([doy, val]) => ({
      frac: doy / 365,
      val,
    })).sort((a, b) => a.frac - b.frac);

    if (medianPath.length > 8) {
      const radialLine = d3
        .lineRadial<{ frac: number; val: number }>()
        // lineRadial measures angle from 12 o'clock clockwise — subtract the
        // target fraction so the ring rotates with the rest of the dial.
        .angle((d) => (d.frac - targetFrac) * 2 * Math.PI)
        .radius((d) => rScale(d.val))
        .curve(d3.curveCardinalClosed);
      g.append('path')
        .datum(medianPath)
        .attr('class', 'radial-median')
        .attr('fill', 'none')
        .attr('stroke', baseColor)
        .attr('stroke-width', 1.75)
        .attr('opacity', 0.85)
        .attr('d', radialLine as any);
    }

    // --- per-month hover wedges (12 tooltips: median / min / max) -----------
    // Invisible pie slices over the canvas. One per calendar month, spanning the
    // month's day-of-year arc from the inner hole to the outer ring. Cheap (12
    // nodes) and gives the cloud a readable summary without per-dot hit-testing.
    const byMonth = d3.group(pts, (d) => d.date.getMonth());
    const monthArc = d3
      .arc<number>()
      .innerRadius(rInner)
      .outerRadius(rOuter)
      // Arc angles are clockwise from 12 o'clock; map the month's day-of-year
      // span through the same target-relative rotation as everything else.
      .startAngle((m) => (m / 12 - targetFrac) * 2 * Math.PI)
      .endAngle((m) => ((m + 1) / 12 - targetFrac) * 2 * Math.PI);

    g.selectAll('.radial-month-wedge')
      .data(d3.range(12))
      .enter()
      .append('path')
      .attr('class', 'radial-month-wedge')
      .attr('d', (m) => monthArc(m) as string)
      .attr('fill', 'transparent')
      .style('cursor', 'crosshair')
      .on('mousemove', (event, m) => {
        const rows = byMonth.get(m) ?? [];
        const mv = rows.map((d) => cv(d[currentMetric] as number));
        if (mv.length === 0) {
          tooltip.style('opacity', 0);
          return;
        }
        const med = d3.median(mv) as number;
        const lo = d3.min(mv) as number;
        const hi = d3.max(mv) as number;
        tooltip
          .style('opacity', 1)
          .html(
            `<strong>${MONTH_FULL[m]}</strong><br/>` +
            `Median ${med.toFixed(1)}${unit}<br/>` +
            `Min ${lo.toFixed(1)}${unit} · Max ${hi.toFixed(1)}${unit}`
          );
        place(event);
      })
      .on('mouseout', () => tooltip.style('opacity', 0));

    // --- target day: selected marker, dashed circumference ------------------
    const target = fullData.find(
      (d) =>
        d.date.getFullYear() === targetDt.getFullYear() &&
        d.date.getMonth() === targetDt.getMonth() &&
        d.date.getDate() === targetDt.getDate() &&
        d[currentMetric] !== undefined
    );

    if (target) {
      const tVal = cv(target[currentMetric] as number);
      const tFrac = dayFraction(target.date);
      const tR = rScale(tVal);
      const [tx, ty] = polar(tFrac, tR);

      // dashed circumference at the target's radius, in the theme foreground
      // (white on dark, black on light) so it always reads against the cloud —
      // matches the target dot and spoke.
      g.append('circle')
        .attr('class', 'radial-target-ring')
        .attr('r', tR)
        .attr('fill', 'none')
        .attr('stroke', 'var(--text-h)')
        .attr('stroke-width', 1.75)
        .attr('stroke-dasharray', '5,5')
        .attr('opacity', 0.9);

      // the selected point itself — dark fill (like the main chart's target dot)
      // so it reads against the same-colour cloud.
      g.append('circle')
        .attr('class', 'radial-target-point')
        .attr('cx', tx)
        .attr('cy', ty)
        .attr('r', 5.5)
        .attr('fill', 'var(--text-h)')
        .attr('stroke', 'var(--surface)')
        .attr('stroke-width', 2)
        .on('mouseover', (event) => {
          tooltip
            .style('opacity', 1)
            .html(
              `<strong>${target.date.toDateString()}</strong><br/>${tVal.toFixed(1)}${unit}<br/><em>Target date</em>`
            );
          place(event);
        })
        .on('mouseout', () => tooltip.style('opacity', 0));

      // Target date label sitting just above the dot, e.g. "Jun 7th, 2026".
      const dateLabel = `${MONTHS[targetDt.getMonth()]} ${ordinal(targetDt.getDate())}, ${targetDt.getFullYear()}`;
      g.append('text')
        .attr('class', 'radial-window-date')
        .attr('x', tx)
        .attr('y', ty - 11)
        .style('text-anchor', 'middle')
        .style('font-size', '11px')
        .style('font-weight', '600')
        .style('fill', 'var(--text-h)')
        .text(dateLabel);
    }
  }, [fullData, currentMetric, currentDate, totalWidth, totalHeight, system]);

  return (
    <div className="radial-chart-wrapper" style={{ width: totalWidth, height: totalHeight }}>
      <canvas
        ref={canvasRef}
        className="radial-chart-canvas"
        style={{ width: totalWidth, height: totalHeight }}
      />
      <svg
        ref={svgRef}
        width={totalWidth}
        height={totalHeight}
        className="radial-chart-svg"
      />
      <div ref={tooltipRef} className="chart-tooltip" />
    </div>
  );
};

export default YearRadialChart;

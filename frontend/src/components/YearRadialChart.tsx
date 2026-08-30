import React, { useEffect, useRef } from 'react';
import * as d3 from 'd3';
import type { WeatherDataPoint } from '../types';
import type { MetricKey } from '../utils/config';
import CONFIG from '../utils/config';
import { observedPool } from '../utils/dataProcessor';
import { placeTooltip } from '../utils/tooltip';
import { useUnits } from '../hooks/useUnits';
import { convert, unitLabel, tickCount, valueDecimals } from '../utils/units';
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
    // The dial shows OBSERVED days only — every settled ERA reading, model rows
    // out. That's dataProcessor.observedPool, the same predicate the records and
    // the climatology use, so the heading's "x% of all days since 1950" counts
    // exactly the dots drawn here. (It keeps recent-tier temperature, which is
    // settled ERA5-Land, where the old data_type === 'historical' test dropped
    // it — the section's sentence is about this cloud, so the two must agree.)
    const pts = observedPool(fullData, currentMetric).filter((d) => {
      const v = d[currentMetric];
      return typeof v === 'number' && Number.isFinite(v);
    });
    if (pts.length === 0) return;

    const vals = pts.map((d) => cv(d[currentMetric] as number));
    const [vMin, vMax] = d3.extent(vals) as [number, number];
    const pad = (vMax - vMin) * 0.1 || 1;
    const rScale = d3
      .scaleLinear()
      .domain([vMin - pad, vMax + pad])
      .range([rInner, rOuter]);

    // The dial is anchored so Jan 1 sits at 12 o'clock and the year runs
    // clockwise — months sit at fixed clock positions regardless of the
    // selected date. The target day's marker simply moves around the ring.
    const targetDt = new Date(currentDate + 'T00:00:00');
    const targetFrac = dayFraction(targetDt);

    // angle: Jan 1 at top (12 o'clock), clockwise through the year.
    const angle = (frac: number) =>
      frac * 2 * Math.PI - Math.PI / 2;
    const polar = (frac: number, r: number): [number, number] => {
      const a = angle(frac);
      return [r * Math.cos(a), r * Math.sin(a)];
    };

    // ±seasonalWindowDays comparison window around the target day, as a fraction of a turn.
    // Drives both the faint wedge and the brightened in-window dots on canvas.
    const WINDOW_DAYS = CONFIG.chart.seasonalWindowDays;
    const windowFrac = WINDOW_DAYS / 365;

    // Faint wedge straddling the TARGET day's position on the dial, behind
    // everything else, so the ±N-day window reads as a sector of the year.
    // Arc angles are clockwise from 12 o'clock, so the window is centred on the
    // target day's day-of-year fraction.
    const windowArc = d3
      .arc<unknown>()
      .innerRadius(rInner)
      .outerRadius(rOuter)
      .startAngle((targetFrac - windowFrac) * 2 * Math.PI)
      .endAngle((targetFrac + windowFrac) * 2 * Math.PI);
    g.append('path')
      .attr('class', 'radial-window-wedge')
      .attr('d', windowArc(null) as string)
      .attr('fill', 'var(--text-h)')
      .attr('opacity', 0.07);

    // --- percentile envelope (per day-of-year, ±WINDOW_DAYS) ----------------
    // Each ring point pools the days within ±WINDOW_DAYS of that day of the
    // year, across every year — which is EXACTLY the pool the top card's "is
    // this unusual for the date?" question runs on. So the band at the target
    // marker's angle is the card's comparison set, drawn; the dashed ring at the
    // marker's radius is the whole-year question this section's heading asks.
    // Bucketing by day-of-year first keeps this to one pass over the cloud plus
    // 365 merges of 2·WINDOW_DAYS+1 small buckets.
    const valuesByDoy = new Map<number, number[]>();
    for (const d of pts) {
      const doy = Math.floor(dayFraction(d.date) * 365);
      const v = cv(d[currentMetric] as number);
      const bucket = valuesByDoy.get(doy);
      if (bucket) bucket.push(v);
      else valuesByDoy.set(doy, [v]);
    }
    type RadialBand = { frac: number; lo: number; hi: number };
    const band1090: RadialBand[] = [];
    const band2575: RadialBand[] = [];
    const medianPath: Array<{ frac: number; val: number }> = [];
    for (let doy = 0; doy < 365; doy++) {
      const pool: number[] = [];
      for (let off = -WINDOW_DAYS; off <= WINDOW_DAYS; off++) {
        // The year wraps: late December's window reaches into early January.
        const bucket = valuesByDoy.get((doy + off + 365) % 365);
        if (bucket) for (const v of bucket) pool.push(v);
      }
      if (pool.length === 0) continue;
      pool.sort(d3.ascending);
      const frac = doy / 365;
      band1090.push({
        frac,
        lo: d3.quantileSorted(pool, 0.1) as number,
        hi: d3.quantileSorted(pool, 0.9) as number,
      });
      band2575.push({
        frac,
        lo: d3.quantileSorted(pool, 0.25) as number,
        hi: d3.quantileSorted(pool, 0.75) as number,
      });
      // The median comes off the SAME windowed pool as the band around it — a
      // bare per-day median (one value per year) is noisy enough to wander
      // outside its own 25th–75th ribbon, which reads as a drawing bug.
      medianPath.push({ frac, val: d3.quantileSorted(pool, 0.5) as number });
    }

    if (band1090.length > 8) {
      const bandArea = d3
        .areaRadial<RadialBand>()
        // areaRadial measures angle from 12 o'clock clockwise — Jan 1 anchored
        // at top, matching the rest of the dial.
        .angle((d) => d.frac * 2 * Math.PI)
        .innerRadius((d) => rScale(d.lo))
        .outerRadius((d) => rScale(d.hi))
        .curve(d3.curveCardinalClosed);
      // Palest 10–90 underneath, 25–75 over it — the main chart's nesting and,
      // via getColorForElement, its exact two band colours.
      for (const [datum, element, cls] of [
        [band1090, 'percentileBand90', 'radial-band-1090'],
        [band2575, 'percentileBand75', 'radial-band-2575'],
      ] as const) {
        g.append('path')
          .datum(datum)
          .attr('class', `radial-band ${cls}`)
          .attr('fill', CONFIG.getColorForElement(currentMetric, element))
          .attr('d', bandArea as never)
          .style('opacity', 0)
          .transition()
          .duration(500)
          .style('opacity', 1);
      }
    }

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
    // tickCount caps precip so ring steps never go below 1 mm / 0.05 in.
    const ringTicks = rScale.ticks(
      tickCount(currentMetric, system, (vMax + pad) - (vMin - pad), 4)
    );
    g.selectAll('.radial-grid-ring')
      .data(ringTicks)
      .enter()
      .append('circle')
      .attr('class', 'radial-grid-ring')
      .attr('r', (t) => rScale(t))
      .attr('fill', 'none')
      .attr('stroke', 'var(--chart-grid)')
      .attr('stroke-dasharray', '2,3');

    // value labels on the rings. Two month-spokes (2/12 turn) left of vertical,
    // so they sit clear of the Jan/Dec boundary at the top of the dial.
    const spoke = (2 * Math.PI) / 12;
    const labelAngle = -Math.PI / 2 - 2 * spoke; // two spokes left of vertical
    // Second set of labels on the far side of the dial: the spoke opposite the
    // first set, then one spoke back toward the top, so both sets read upright-ish
    // and the scale is legible without crossing the whole wheel.
    const labelAngle2 = labelAngle + Math.PI - spoke;
    g.selectAll('.radial-ring-label')
      .data(ringTicks.flatMap((t) => [
        { t, a: labelAngle },
        { t, a: labelAngle2 },
      ]))
      .enter()
      .append('text')
      .attr('class', 'radial-ring-label')
      .attr('x', (d) => rScale(d.t) * Math.cos(d.a))
      .attr('y', (d) => rScale(d.t) * Math.sin(d.a))
      .attr('dy', '0.32em')
      .style('text-anchor', 'middle')
      .style('font-size', '9px')
      .style('fill', 'var(--chart-label)')
      .text((d) => `${d.t}${unit}`);

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

    // --- median ring --------------------------------------------------------
    // The centre line of the envelope built above, drawn over both bands.
    // Smooths the seasonal cycle the day-cloud only hints at.
    if (medianPath.length > 8) {
      const radialLine = d3
        .lineRadial<{ frac: number; val: number }>()
        // lineRadial measures angle from 12 o'clock clockwise — Jan 1 anchored
        // at top, matching the rest of the dial.
        .angle((d) => d.frac * 2 * Math.PI)
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
      // Arc angles are clockwise from 12 o'clock; Jan 1 anchored at top, so the
      // month's day-of-year span maps directly.
      .startAngle((m) => (m / 12) * 2 * Math.PI)
      .endAngle((m) => ((m + 1) / 12) * 2 * Math.PI);

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
            `${lo.toFixed(1)}${unit} – ${hi.toFixed(1)}${unit}`
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
      // A model row carries its bias-corrected 9-quantile band, and the row's
      // value is already snapped to that band's median (AppContext), so the dot
      // is in the right place — what's missing is how wide the guess is. Drawn as
      // a q10→q90 segment along the day's own spoke, i.e. in the one direction
      // that means "value" on this chart. The dashed ring stays on the dot.
      const targetBand = target.band?.[currentMetric] ?? null;
      const vdp = valueDecimals(currentMetric, system);
      const ciLine = targetBand
        ? `<br/><span class="tt-ci">90% CI ${cv(targetBand.lo).toFixed(vdp)}–${cv(targetBand.hi).toFixed(vdp)}${unit}</span>`
        : '';
      if (targetBand) {
        const [q10x, q10y] = polar(tFrac, rScale(cv(targetBand.q10)));
        const [q90x, q90y] = polar(tFrac, rScale(cv(targetBand.q90)));
        g.append('line')
          .attr('class', 'radial-target-ci')
          .attr('x1', q10x)
          .attr('y1', q10y)
          .attr('x2', q90x)
          .attr('y2', q90y)
          .attr('stroke', 'var(--text-h)')
          .attr('stroke-width', 2)
          .attr('stroke-linecap', 'round')
          .attr('opacity', 0.75);
      }

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
      // so it reads against the same-colour cloud. A model row inverts to a
      // hollow dot, the same "this is a guess, not a measurement" mark the main
      // chart's forecast points wear.
      g.append('circle')
        .attr('class', `radial-target-point${targetBand ? ' radial-target-forecast' : ''}`)
        .attr('cx', tx)
        .attr('cy', ty)
        .attr('r', 5.5)
        .attr('fill', targetBand ? 'var(--surface)' : 'var(--text-h)')
        .attr('stroke', targetBand ? 'var(--text-h)' : 'var(--surface)')
        .attr('stroke-width', 2)
        .on('mouseover', (event) => {
          tooltip
            .style('opacity', 1)
            .html(
              `<strong>${target.date.toDateString()}</strong><br/>${tVal.toFixed(1)}${unit}<br/><em>Target date${targetBand ? ' · forecast' : ''}</em>${ciLine}`
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

      // Target VALUE label just below the marker (date label sits above it), so
      // both labels travel with the dot as it moves around the dial.
      g.append('text')
        .attr('class', 'radial-target-value')
        .attr('x', tx)
        .attr('y', ty + 16)
        .attr('dy', '0.32em')
        .style('text-anchor', 'middle')
        .style('font-size', '11px')
        .style('font-weight', '600')
        .style('fill', 'var(--text-h)')
        .text(`${tVal.toFixed(1)}${unit}`);
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

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

    // --- seasonal median (per day-of-year, ±WINDOW_DAYS) --------------------
    // Each ring point pools the days within ±WINDOW_DAYS of that day of the
    // year, across every year — which is EXACTLY the pool the top card's "is
    // this unusual for the date?" question runs on. Only the MEDIAN of that pool
    // is drawn: the cloud of dots IS the observed spread here, so shading a
    // percentile envelope over it re-states in ink what the reader can already
    // see, and washes out the dots it covers. Shading on this dial is reserved
    // for the one thing there are no dots for — the forecast band below.
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
      // A WINDOWED median, not a bare per-day one (one value per year): the bare
      // version is noisy enough to visibly wander, which reads as a drawing bug.
      medianPath.push({ frac: doy / 365, val: d3.quantileSorted(pool, 0.5) as number });
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
    // The centre line of the pool built above, drawn over the cloud. Smooths the
    // seasonal cycle the day-cloud only hints at.
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
      // is in the right place — what's missing is how wide the guess is.
      const targetBand = target.band?.[currentMetric] ?? null;
      const vdp = valueDecimals(currentMetric, system);
      const ciLine = targetBand
        ? `<br/><span class="tt-ci">90% CI ${cv(targetBand.lo).toFixed(vdp)}–${cv(targetBand.hi).toFixed(vdp)}${unit}</span>`
        : '';

      // Constant-value rings, in the theme foreground (white on dark, black on
      // light) so they always read against the cloud. A ring is the natural mark
      // for a value on this dial: every day outside it was more extreme than
      // that value, which is exactly what the section's heading counts.
      //
      // On a forecast day the uncertainty is a SHADED ANNULUS between q05 and
      // q95 — the SAME two ends the section's heading quotes while they stay in
      // a tail ("In the top 3-4% hottest days since 1950",
      // utils/verdictProse.bandTailPredicate), so the sentence and the ring
      // can't describe different forecasts. Once they reach past the median the
      // heading states the median's place in the pack instead and this ring is
      // the only thing showing the spread — all the more reason to draw it —
      // with the
      // thin dashed ring on the median still marking the value the
      // dot sits at: two more dashed rings read as two more gridlines, a filled
      // band reads as one interval. A flat wash, not the histogram's diagonal
      // hatch — stripes at a fixed 45° cut across a dial's radial geometry at a
      // different angle everywhere round the circle, so the texture reads as a
      // moiré rather than as one band. A settled day gets one ring.
      const targetRing = (
        r: number,
        strokeWidth: number,
        dash: string,
        opacity: number,
        cls: string
      ) =>
        g.append('circle')
          .attr('class', cls)
          .attr('r', r)
          .attr('fill', 'none')
          .attr('stroke', 'var(--text-h)')
          .attr('stroke-width', strokeWidth)
          .attr('stroke-dasharray', dash)
          .attr('opacity', opacity);

      if (targetBand) {
        // min/max, not lo/hi as given: the radial scale is always increasing,
        // but a metric drawn on a reversed/clamped domain must never hand
        // arc() an inner radius outside its outer one.
        const rLo = Math.min(rScale(cv(targetBand.lo)), rScale(cv(targetBand.hi)));
        const rHi = Math.max(rScale(cv(targetBand.lo)), rScale(cv(targetBand.hi)));
        const bandRing = d3
          .arc<unknown>()
          .innerRadius(rLo)
          .outerRadius(rHi)
          .startAngle(0)
          .endAngle(2 * Math.PI);
        g.append('path')
          .attr('class', 'radial-target-band')
          .attr('d', bandRing(null) as string)
          .attr('fill', 'var(--text-h)')
          .attr('opacity', 0.13)
          // A filled shape this large would otherwise swallow the month wedges'
          // hover (they are drawn beneath it); the rings never did, being stroke-only.
          .attr('pointer-events', 'none');
        targetRing(tR, 1, '3,3', 0.9, 'radial-target-ring radial-target-ring-mid');
      } else {
        targetRing(tR, 1.75, '5,5', 0.9, 'radial-target-ring');
      }

      // the selected point itself — a plain dark dot (like the main chart's
      // target dot) so it reads against the same-colour cloud. A forecast day
      // says so through its rings and its tooltip, not through a different dot.
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
              `<strong>${target.date.toDateString()}</strong><br/>${tVal.toFixed(1)}${unit}<br/><em>Target date${targetBand ? ' · forecast' : ''}</em>${ciLine}`
            );
          place(event);
        })
        .on('mouseout', () => tooltip.style('opacity', 0));

      // The date label belongs to the ±N-day WEDGE, not to the dot: it sits at
      // the wedge's outer end, out by the month ring, so the dot is left
      // carrying only its own value and the label stops moving up and down the
      // dial as the value changes. Naming the window here is what makes the
      // wedge self-explanatory — e.g. "Aug 30th, 2026 ±3 days".
      const dateLabel =
        `${MONTHS[targetDt.getMonth()]} ${ordinal(targetDt.getDate())}, ` +
        `${targetDt.getFullYear()} ±${WINDOW_DAYS} days`;
      const [dlx, dly] = polar(tFrac, rOuter + 12);
      const dateText = g
        .append('text')
        .attr('class', 'radial-window-date')
        .attr('x', dlx)
        .attr('y', dly)
        .attr('dy', '0.32em')
        .style('text-anchor', 'middle')
        .style('font-size', '11px')
        .style('font-weight', '600')
        .style('fill', 'var(--text-h)')
        // It can be pulled in over the day cloud (below), so give it a
        // surface-coloured halo rather than trusting it to land on empty space.
        .style('stroke', 'var(--surface)')
        .style('stroke-width', 3)
        .style('paint-order', 'stroke')
        .text(dateLabel);
      // Out east or west the dial keeps only ~20px of margin, far less than this
      // label is wide, so slide it back inside the box. It stays on the wedge's
      // arc, which is all the association it needs.
      const labelNode = dateText.node() as SVGTextElement;
      const firstBox = labelNode.getBBox();
      const overLeft = -cx + 4 - firstBox.x;
      const overRight = firstBox.x + firstBox.width - (cx - 4);
      if (overLeft > 0) dateText.attr('x', dlx + overLeft);
      else if (overRight > 0) dateText.attr('x', dlx - overRight);

      // A due-east or due-west date puts the dot, its value label and this one
      // all on the same horizontal line, so that clamp slides the label straight
      // onto the dot. The value label hangs below the dot, so lift this one
      // clear above it — the only side that is always free.
      const clamped = labelNode.getBBox();
      const dotZone = { x: tx - 9, y: ty - 9, w: 18, h: 35 };
      const hitsDot =
        clamped.x < dotZone.x + dotZone.w &&
        clamped.x + clamped.width > dotZone.x &&
        clamped.y < dotZone.y + dotZone.h &&
        clamped.y + clamped.height > dotZone.y;
      if (hitsDot) dateText.attr('y', ty - 20);

      // It now sits on the month ring, so drop any month name it lands on: this
      // label names that stretch of the year more precisely, and two labels in
      // one spot read as neither.
      const dateBox = labelNode.getBBox();
      g.selectAll<SVGTextElement, unknown>('.radial-month-label').each(function () {
        const b = this.getBBox();
        const hits =
          b.x < dateBox.x + dateBox.width + 3 &&
          b.x + b.width + 3 > dateBox.x &&
          b.y < dateBox.y + dateBox.height + 2 &&
          b.y + b.height + 2 > dateBox.y;
        if (hits) this.remove();
      });

      // Target VALUE label just below the marker — the one label that does
      // travel with the dot, because it is the dot's own reading.
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

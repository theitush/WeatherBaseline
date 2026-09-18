import React, { useEffect, useRef } from 'react';
import * as d3 from 'd3';
import type { MetricKey } from '../utils/config';
import { useUnits } from '../hooks/useUnits';
import { convert, unitLabel, tickCount, valueDecimals } from '../utils/units';
import type { ThemeMode } from '../utils/eras';
import type { BandKey, Series, SeriesData } from './compareTypes';
import { DOY_COUNT, buildDialTracks, dayFraction } from './compareStats';
import type { BandPath } from './compareStats';
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
   * from the full day cloud so nothing is clipped. When omitted the dial
   * auto-scales to its own series.
   */
  domain?: [number, number];
  /**
   * Which layers to draw over the cloud — the percentile envelopes and the
   * median ring. Anything absent is simply not drawn; the day cloud itself is
   * always there.
   */
  bands: BandKey[];
  /**
   * The theme being painted. Passed in rather than read here so the dial, the
   * legend and the editor's swatches all resolve the era ramps against the same
   * answer as the page header's own toggle.
   */
  theme: ThemeMode;
  width?: number;
  height?: number;
}

const MONTHS = ['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun',
  'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec'];

const CompareRadialChart: React.FC<CompareRadialChartProps> = ({
  series,
  axisMetric,
  domain,
  bands,
  theme,
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
      bands,
      theme
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

    // ---- per-track percentile bands ----------------------------------------
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
    // Every archive day in every period, always — the bands lie over it.
    const canvas = canvasRef.current;
    const dpr = window.devicePixelRatio || 1;
    canvas.width = totalWidth * dpr;
    canvas.height = totalHeight * dpr;
    const ctx = canvas.getContext('2d');
    if (ctx) {
      ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
      ctx.clearRect(0, 0, totalWidth, totalHeight);
      ctx.translate(cx, cy);
      // Lighter cloud when overlaying several tracks so they don't muddy
      // together.
      const cloudAlpha = tracks.length > 1 ? 0.06 : 0.1;
      for (const p of allPts) {
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

    // ---- difference shading: which period runs higher, day by day ----------
    // One ribbon per ADJACENT pair of a split series' median rings — two pairs
    // when the range carries all three eras — drawn between them and BELOW
    // them. Each pair is two full-circle areas rather than clipped arcs: the
    // "newer higher" area spans older→max(older,newer) and so collapses to
    // nothing wherever the older ring is on top, and the "older higher" area is
    // its mirror. That makes the crossings seamless — no gap at the day two
    // rings swap.
    //
    // Everything a series shades goes in ONE group that carries the opacity,
    // rather than a fade per path. With three rings the pairs' annuli genuinely
    // overlap wherever the middle ring is the highest or the lowest of the
    // three, and per-path alpha would stack there into a patch darker or
    // muddier than either color it is made of. Inside a group the paths
    // composite opaquely against one another first — the later simply wins —
    // and the group is faded once. A series with a single pair is unaffected:
    // its two areas never overlap.
    type Diff = { frac: number; older: number; newer: number };
    for (const { series: s } of series) {
      if (!s.split || !s.diffShade) continue;
      const mine = tracks.filter((t) => t.seriesId === s.id);
      if (mine.length < 2) continue;
      const shading = g.append('g').attr('class', 'cmp-diff-group').attr('opacity', 0.75);

      // Oldest pair first, so where two ribbons do meet the most recent
      // comparison is the one left on top.
      for (let i = 0; i + 1 < mine.length; i++) {
        const older = mine[i];
        const newer = mine[i + 1];
        const diff: Diff[] = [];
        for (const [doy, o] of older.medianByDoy) {
          const n = newer.medianByDoy.get(doy);
          if (n === undefined) continue;
          diff.push({ frac: doy / DOY_COUNT, older: o, newer: n });
        }
        if (diff.length <= 8) continue;
        diff.sort((a, b) => a.frac - b.frac);
        // Repeat the first day at frac=1 so the ribbon closes Dec 31→Jan 1.
        diff.push({ ...diff[0], frac: 1 });

        const shade = (inner: (d: Diff) => number, color: string, cls: string) =>
          shading
            .append('path')
            .datum(diff)
            .attr('class', `cmp-diff-shade ${cls}`)
            .attr('fill', color)
            .attr(
              'd',
              d3
                .areaRadial<Diff>()
                .angle((d) => d.frac * 2 * Math.PI)
                .innerRadius((d) => rScale(inner(d)))
                .outerRadius((d) => rScale(Math.max(d.older, d.newer)))
                .curve(d3.curveLinear) as never
            );

        shade((d) => d.older, newer.color, 'cmp-diff-newer');
        shade((d) => d.newer, older.color, 'cmp-diff-older');
      }
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
  }, [series, axisMetric, domain, bands, theme, totalWidth, totalHeight, system]);

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

import React from 'react';
import type { Selection } from 'd3';
import CONFIG, { type MetricKey } from '../utils/config';

export type LegendItem =
  | { type: 'rect'; color: string; label: string; op: number }
  | { type: 'wave'; color: string; label: string; op: number; w?: number }
  | { type: 'line'; color: string; label: string }
  | { type: 'dashed'; color: string; label: string }
  | { type: 'bell'; color: string; label: string }
  | { type: 'circle'; color: string; label: string }
  | { type: 'forecast'; color: string; label: string }
  | { type: 'target'; color: string; label: string }
  | { type: 'wedge'; color: string; label: string };

const MONTHS = ['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun',
  'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec'];
const ordinal = (n: number): string => {
  const s = ['th', 'st', 'nd', 'rd'];
  const v = n % 100;
  return n + (s[(v - 20) % 10] || s[v] || s[0]);
};

// Legend for the radial dial: only the marks it actually draws. The wedge label
// names the actual window, e.g. "Jun 6th ±3 days".
export const getRadialLegendData = (metric: MetricKey, currentDate: string): LegendItem[] => {
  const dt = new Date(currentDate + 'T00:00:00');
  const windowLabel = `${MONTHS[dt.getMonth()]} ${ordinal(dt.getDate())} ±${CONFIG.chart.seasonalWindowDays} days`;
  return [
    { type: 'circle', color: CONFIG.getColorForElement(metric, 'dataPoints'), label: 'Historical daily data' },
    { type: 'line', color: CONFIG.getColorForElement(metric, 'trendLine'), label: 'Median' },
    { type: 'wedge', color: 'var(--text-h)', label: windowLabel },
  ];
};

export const getLegendData = (
  metric: MetricKey,
  currentDate?: string,
  isForecast?: boolean,
): LegendItem[] => {
  const items: LegendItem[] = [];

  // First (top on mobile): the histogram bars — the settled climatological
  // distribution the whole chart is built on.
  items.push({
    type: 'rect',
    color: CONFIG.getColorForElement(metric, 'histogramBars'),
    label: 'Binned historical data',
    op: 1,
  });

  // Second: the target-day marker. A forecast day is drawn as a predictive-density
  // bell (the histogram's forecast KDE); a settled past day is the straight dashed
  // "this is today" line. Labelled with the selected date.
  if (currentDate) {
    items.push(
      isForecast
        ? { type: 'bell', color: 'var(--text-h)', label: `${fmtLegendDate(currentDate)} forecast` }
        : { type: 'dashed', color: 'var(--text-h)', label: fmtLegendDate(currentDate) },
    );
  }

  // The percentile bands read as waves rather than flat squares; each carries the
  // chart's own band alpha (0.2 / 0.4) so the legend and the plot match. The rolling
  // median is a thinner wave in the trend hue.
  items.push(
    { type: 'wave', color: CONFIG.getColorForElement(metric, 'percentileBand90'), label: '10th–90th pct', op: 1 },
    { type: 'wave', color: CONFIG.getColorForElement(metric, 'percentileBand75'), label: '25th–75th pct', op: 1 },
    { type: 'wave', color: CONFIG.getColorForElement(metric, 'trendLine'), label: 'Rolling median', op: 1, w: 2.5 },
    { type: 'circle', color: CONFIG.getColorForElement(metric, 'dataPoints'), label: 'Historical daily data' },
    { type: 'forecast', color: CONFIG.getColorForElement(metric, 'dataPoints'), label: 'Forecast' },
  );

  return items;
};

// "Jun 7th, 2026" — matches the date label MainChart writes beside the marker.
// Parsed at local noon so the day never shifts across a timezone boundary.
const fmtLegendDate = (dateStr: string): string => {
  const d = new Date(dateStr + 'T12:00:00');
  return `${MONTHS[d.getMonth()]} ${ordinal(d.getDate())}, ${d.getFullYear()}`;
};

// Draw a single legend swatch into a d3 selection (centered vertically on y=0).
export const drawLegendSwatch = (
  sel: Selection<SVGGElement, unknown, null, undefined>,
  item: LegendItem,
) => {
  if (item.type === 'rect') {
    sel.append('rect').attr('width', 12).attr('height', 12).attr('y', -6).attr('fill', item.color).attr('opacity', item.op);
  } else if (item.type === 'line') {
    sel.append('line').attr('x1', 0).attr('x2', 12).attr('y1', 0).attr('y2', 0).attr('stroke', item.color).attr('stroke-width', 2.5);
  } else if (item.type === 'dashed') {
    sel.append('line').attr('x1', 0).attr('x2', 12).attr('y1', 0).attr('y2', 0).attr('stroke', item.color).attr('stroke-width', 1.5).attr('stroke-dasharray', '3,2');
  } else if (item.type === 'circle') {
    sel.append('circle').attr('cx', 6).attr('cy', 0).attr('r', 2).attr('fill', item.color);
  } else if (item.type === 'forecast') {
    // Hollow/outlined dot — mirrors the forecast scatter dots in MainChart.
    sel.append('circle').attr('cx', 6).attr('cy', 0).attr('r', 2.5).attr('fill', 'var(--surface)').attr('stroke', item.color).attr('stroke-width', 1);
  } else if (item.type === 'target') {
    sel.append('circle').attr('cx', 6).attr('cy', 0).attr('r', 4).attr('fill', 'var(--text-h)').attr('stroke', 'var(--surface)').attr('stroke-width', 1.5);
  }
};

// React/HTML swatch — mirrors drawLegendSwatch visually for the inline mobile legend.
const Swatch: React.FC<{ item: LegendItem }> = ({ item }) => (
  <svg width={16} height={16} style={{ flex: '0 0 auto' }}>
    <g transform="translate(2, 8)">
      {item.type === 'rect' && (
        <rect width={12} height={12} y={-6} fill={item.color} opacity={item.op} />
      )}
      {item.type === 'wave' && (
        <path
          d="M0,0 Q3,-3 6,0 T12,0"
          fill="none"
          stroke={item.color}
          strokeOpacity={item.op}
          strokeWidth={item.w ?? 6}
          strokeLinecap="round"
        />
      )}
      {item.type === 'line' && (
        <line x1={0} x2={12} y1={0} y2={0} stroke={item.color} strokeWidth={2.5} />
      )}
      {item.type === 'dashed' && (
        <line x1={0} x2={12} y1={0} y2={0} stroke={item.color} strokeWidth={1.5} strokeDasharray="3,2" />
      )}
      {item.type === 'bell' && (
        <path
          d="M0,4 C2,4 4,-4 6,-4 C8,-4 10,4 12,4"
          fill="none"
          stroke={item.color}
          strokeWidth={1.5}
          strokeDasharray="2.5,3.5"
          strokeLinecap="round"
        />
      )}
      {item.type === 'circle' && (
        <circle cx={6} cy={0} r={4} fill={item.color} />
      )}
      {item.type === 'forecast' && (
        <circle cx={6} cy={0} r={4} fill="var(--surface)" stroke={item.color} strokeWidth={1.3} />
      )}
      {item.type === 'target' && (
        <circle cx={6} cy={0} r={4} fill="var(--text-h)" stroke="var(--surface)" strokeWidth={1.5} />
      )}
      {item.type === 'wedge' && (
        <rect width={12} height={12} y={-6} fill={item.color} opacity={0.18} />
      )}
    </g>
  </svg>
);

export const Legend: React.FC<{ metric: MetricKey; currentDate?: string; isForecast?: boolean }> = ({ metric, currentDate, isForecast }) => {
  const items = getLegendData(metric, currentDate, isForecast);
  return (
    <div className="chart-legend">
      {items.map((item, i) => (
        <React.Fragment key={item.label}>
          <div className="chart-legend-item">
            <Swatch item={item} />
            <span>{item.label}</span>
          </div>
          {/* Force the binned-data + target-day pair onto their own row on mobile;
              the break collapses (display:none) on desktop, keeping one flow row. */}
          {i === 1 && <div className="legend-break" aria-hidden="true" />}
        </React.Fragment>
      ))}
    </div>
  );
};

export const RadialLegend: React.FC<{ metric: MetricKey; currentDate: string }> = ({ metric, currentDate }) => {
  const items = getRadialLegendData(metric, currentDate);
  return (
    <div className="chart-legend">
      {items.map((item) => (
        <div key={item.label} className="chart-legend-item">
          <Swatch item={item} />
          <span>{item.label}</span>
        </div>
      ))}
    </div>
  );
};

export default Legend;

import React from 'react';
import type { Selection } from 'd3';
import CONFIG, { type MetricKey } from '../utils/config';

export type LegendItem =
  | { type: 'rect'; color: string; label: string; op: number }
  | { type: 'line'; color: string; label: string }
  | { type: 'dashed'; color: string; label: string }
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

export const getLegendData = (metric: MetricKey, currentDate?: string): LegendItem[] => [
  { type: 'rect', color: CONFIG.getColorForElement(metric, 'percentileBand90'), label: '10th–90th pct', op: 0.4 },
  { type: 'rect', color: CONFIG.getColorForElement(metric, 'percentileBand75'), label: '25th–75th pct', op: 0.8 },
  { type: 'line', color: CONFIG.getColorForElement(metric, 'trendLine'), label: 'Rolling median' },
  { type: 'circle', color: CONFIG.getColorForElement(metric, 'dataPoints'), label: 'Historical daily data' },
  { type: 'forecast', color: CONFIG.getColorForElement(metric, 'dataPoints'), label: 'Forecast' },
  // The dashed target-day marker: MainChart's "today" line and the histogram's
  // forecast-KDE / settled current-temp line all share this style. Labelled with
  // the selected date so it reads as "this is the day you picked".
  ...(currentDate
    ? [{ type: 'dashed' as const, color: 'var(--text-h)', label: fmtLegendDate(currentDate) }]
    : []),
];

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
  <svg width={14} height={14} style={{ flex: '0 0 auto' }}>
    <g transform="translate(1, 7)">
      {item.type === 'rect' && (
        <rect width={12} height={12} y={-6} fill={item.color} opacity={item.op} />
      )}
      {item.type === 'line' && (
        <line x1={0} x2={12} y1={0} y2={0} stroke={item.color} strokeWidth={2.5} />
      )}
      {item.type === 'dashed' && (
        <line x1={0} x2={12} y1={0} y2={0} stroke={item.color} strokeWidth={1.5} strokeDasharray="3,2" />
      )}
      {item.type === 'circle' && (
        <circle cx={6} cy={0} r={2} fill={item.color} />
      )}
      {item.type === 'forecast' && (
        <circle cx={6} cy={0} r={2.5} fill="var(--surface)" stroke={item.color} strokeWidth={1} />
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

export const Legend: React.FC<{ metric: MetricKey; currentDate?: string }> = ({ metric, currentDate }) => {
  const items = getLegendData(metric, currentDate);
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

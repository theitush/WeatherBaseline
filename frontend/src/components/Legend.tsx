import React from 'react';
import type { Selection } from 'd3';
import CONFIG, { type MetricKey } from '../utils/config';

export type LegendItem =
  | { type: 'rect'; color: string; label: string; op: number }
  | { type: 'line'; color: string; label: string }
  | { type: 'circle'; color: string; label: string }
  | { type: 'target'; color: string; label: string };

export const getLegendData = (metric: MetricKey): LegendItem[] => [
  { type: 'rect', color: CONFIG.getColorForElement(metric, 'percentileBand90'), label: '10th–90th pct', op: 0.4 },
  { type: 'rect', color: CONFIG.getColorForElement(metric, 'percentileBand75'), label: '25th–75th pct', op: 0.8 },
  { type: 'line', color: CONFIG.getColorForElement(metric, 'trendLine'), label: 'Rolling median' },
  { type: 'circle', color: CONFIG.getColorForElement(metric, 'dataPoints'), label: 'Historical data' },
  { type: 'target', color: 'var(--text-h)', label: 'Target date' },
];

// Draw a single legend swatch into a d3 selection (centered vertically on y=0).
export const drawLegendSwatch = (
  sel: Selection<SVGGElement, unknown, null, undefined>,
  item: LegendItem,
) => {
  if (item.type === 'rect') {
    sel.append('rect').attr('width', 12).attr('height', 12).attr('y', -6).attr('fill', item.color).attr('opacity', item.op);
  } else if (item.type === 'line') {
    sel.append('line').attr('x1', 0).attr('x2', 12).attr('y1', 0).attr('y2', 0).attr('stroke', item.color).attr('stroke-width', 2.5);
  } else if (item.type === 'circle') {
    sel.append('circle').attr('cx', 6).attr('cy', 0).attr('r', 2).attr('fill', item.color);
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
      {item.type === 'circle' && (
        <circle cx={6} cy={0} r={2} fill={item.color} />
      )}
      {item.type === 'target' && (
        <circle cx={6} cy={0} r={4} fill="var(--text-h)" stroke="var(--surface)" strokeWidth={1.5} />
      )}
    </g>
  </svg>
);

export const Legend: React.FC<{ metric: MetricKey }> = ({ metric }) => {
  const items = getLegendData(metric);
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

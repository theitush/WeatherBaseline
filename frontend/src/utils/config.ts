// Configuration and constants

export type MetricKey = 'max_temperature' | 'min_temperature' | 'precipitation_sum' | 'wind_speed_10m_max';

export type ElementType = 'trendLine' | 'percentileBand90' | 'percentileBand75' | 'dataPoints' | 'histogramBars';

export interface MetricColor {
  base: string;
  name: string;
}

export interface ActiveMetrics {
  max_temperature: boolean;
  min_temperature: boolean;
  precipitation_sum: boolean;
  wind_speed_10m_max: boolean;
}

export interface Margin {
  top: number;
  right: number;
  bottom: number;
  left: number;
}

export interface OpacityLevels {
  trendLine: number;
  percentileBand90: number;
  percentileBand75: number;
  dataPoints: number;
  histogramBars: number;
}

export interface Config {
  // ==========================================
  // 🎛️ EASY METRIC TOGGLE - CHANGE HERE ONLY!
  // ==========================================
  // Set to true/false to enable/disable metrics
  // This controls what data is downloaded and displayed
  ACTIVE_METRICS: ActiveMetrics;

  // Chart dimensions
  mainMargin: Margin;
  histMargin: Margin;

  mainWidth: number;
  mainHeight: number;
  histWidth: number;
  histHeight: number;

  // Base colors for different metrics (all available, only active ones used)
  metricColors: Record<MetricKey, MetricColor>;

  // Opacity levels for different chart elements
  opacityLevels: OpacityLevels;

  // Animation settings
  animations: {
    fadeOut: number;
    fadeIn: number;
    transition: number;
  };

  // Chart settings
  chart: {
    windowSize: number;
    histogramThresholds: number;
    tempMargin: number;
  };

  // Helper methods
  getColorForElement(metric: MetricKey, elementType: ElementType): string;
  hexToRgba(hex: string, opacity: number): string;
  getActiveMetrics(): MetricKey[];
  getActiveMetricsApiString(): string;
  isMetricActive(metric: MetricKey): boolean;
}

const CONFIG: Config = {
  // ==========================================
  // 🎛️ EASY METRIC TOGGLE - CHANGE HERE ONLY!
  // ==========================================
  // Set to true/false to enable/disable metrics
  // This controls what data is downloaded and displayed
  ACTIVE_METRICS: {
    max_temperature: true,      // ✅ Maximum temperature
    min_temperature: true,      // ✅ Minimum temperature
    precipitation_sum: false,   // ❌ Precipitation (commented out)
    wind_speed_10m_max: false   // ❌ Wind speed (commented out)
  },

  // Chart dimensions
  mainMargin: {top: 20, right: 30, bottom: 40, left: 50},
  histMargin: {top: 20, right: 100, bottom: 40, left: 15},

  get mainWidth() { return 800 - this.mainMargin.left - this.mainMargin.right; },
  get mainHeight() { return 400 - this.mainMargin.top - this.mainMargin.bottom; },
  get histWidth() { return 300 - this.histMargin.left - this.histMargin.right; },
  get histHeight() { return 400 - this.histMargin.top - this.histMargin.bottom; },

  // Base colors for different metrics (all available, only active ones used)
  // Derived from index.css OKLCH tokens (--hot / --cold). Keep these in sync
  // with the design tokens if either palette ever moves. Hex form is required
  // because d3 consumes the value.
  metricColors: {
    max_temperature: {
      base: '#b94a2a',     // oklch(55% 0.16 35) — oxide red, the "hot" signal
      name: 'Oxide'
    },
    min_temperature: {
      base: '#3c6f9a',     // oklch(50% 0.09 240) — slate blue, the "cold" signal
      name: 'Slate'
    },
    precipitation_sum: {
      base: '#6b6896',
      name: 'Muted Iris'
    },
    wind_speed_10m_max: {
      base: '#728c6e',
      name: 'Sage'
    }
  },

  // Opacity levels for different chart elements
  opacityLevels: {
    trendLine: 1.0,
    percentileBand90: 0.2,
    percentileBand75: 0.4,
    dataPoints: 0.2,
    histogramBars: 0.7
  },

  // Utility function to get color with opacity for a specific element
  getColorForElement(metric: MetricKey, elementType: ElementType): string {
    const baseColor = this.metricColors[metric]?.base;
    const opacity = this.opacityLevels[elementType];

    if (!baseColor || opacity === undefined) {
      console.warn(`Invalid metric "${metric}" or element type "${elementType}"`);
      return baseColor || '#000000';
    }

    if (opacity === 1.0) {
      return baseColor;
    }

    return this.hexToRgba(baseColor, opacity);
  },

  // Utility function to convert hex color to rgba
  hexToRgba(hex: string, opacity: number): string {
    // Remove # if present
    hex = hex.replace('#', '');

    // Parse hex values
    const r = parseInt(hex.substring(0, 2), 16);
    const g = parseInt(hex.substring(2, 4), 16);
    const b = parseInt(hex.substring(4, 6), 16);

    return `rgba(${r}, ${g}, ${b}, ${opacity})`;
  },

  // Animation settings
  animations: {
    fadeOut: 250,
    fadeIn: 250,
    transition: 500
  },

  // Chart settings
  chart: {
    windowSize: 5, // Moving average window
    histogramThresholds: 30,
    tempMargin: 2 // Temperature scale margin
  },

  // ==========================================
  // 🔧 HELPER FUNCTIONS FOR DYNAMIC METRICS
  // ==========================================

  // Get list of active metric names
  getActiveMetrics(): MetricKey[] {
    return Object.keys(this.ACTIVE_METRICS).filter(
      metric => this.ACTIVE_METRICS[metric as MetricKey]
    ) as MetricKey[];
  },

  // Get API parameter string for active metrics
  getActiveMetricsApiString(): string {
    const metricMap: Record<MetricKey, string> = {
      max_temperature: 'apparent_temperature_max',
      min_temperature: 'apparent_temperature_min',
      precipitation_sum: 'precipitation_sum',
      wind_speed_10m_max: 'wind_speed_10m_max'
    };

    return this.getActiveMetrics()
      .map(metric => metricMap[metric])
      .join(',');
  },

  // Check if a metric is active
  isMetricActive(metric: MetricKey): boolean {
    return this.ACTIVE_METRICS[metric] === true;
  }
};

export default CONFIG;

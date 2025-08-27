// Configuration and constants
const CONFIG = {
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
    histMargin: {top: 20, right: 140, bottom: 40, left: 15},
    
    get mainWidth() { return 720 - this.mainMargin.left - this.mainMargin.right; },
    get mainHeight() { return 400 - this.mainMargin.top - this.mainMargin.bottom; },
    get histWidth() { return 280 - this.histMargin.left - this.histMargin.right; },
    get histHeight() { return 400 - this.histMargin.top - this.histMargin.bottom; },
    
    // Base colors for different metrics (all available, only active ones used)
    metricColors: {
        max_temperature: {
            base: '#FF8C42',
            name: 'Orange'
        },
        min_temperature: {
            base: '#4A90E2', 
            name: 'Blue'
        },
        // Keeping these for easy re-enabling
        precipitation_sum: {
            base: '#B19CD9',
            name: 'Pastel Purple'
        },
        wind_speed_10m_max: {
            base: '#A8D8A8',
            name: 'Pastel Green'
        }
    },
    
    // Opacity levels for different chart elements
    opacityLevels: {
        trendLine: 1.0,
        percentileBand90: 0.5,
        percentileBand75: 0.7,
        dataPoints: 0.2,
        histogramBars: 0.7
    },
    
    // Utility function to get color with opacity for a specific element
    getColorForElement(metric, elementType) {
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
    hexToRgba(hex, opacity) {
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
    
    // Font sizes for consistent typography
    fontSizes: {
        axisLabels: 15,        // Axis titles (e.g., "Year", "Maximum Temperature", "Count")
        tickLabels: 12,        // Axis tick numbers
        currentTempDate: 15,   // Current temperature and date indicators
        brackets: 13           // Percentile bracket labels
    },
    
    // Spacing settings
    spacing: {
        histogramXAxisLabelDistance: 30  // Distance from histogram bottom to x-axis label
    },

    // Chart settings
    chart: {
        windowSize: 5, // Moving average window
        histogramThresholds: 35,
        tempMargin: 2 // Temperature scale margin
    },

    // ==========================================
    // 🔧 HELPER FUNCTIONS FOR DYNAMIC METRICS
    // ==========================================
    
    // Get list of active metric names
    getActiveMetrics() {
        return Object.keys(this.ACTIVE_METRICS).filter(metric => this.ACTIVE_METRICS[metric]);
    },
    
    // Get API parameter string for active metrics
    getActiveMetricsApiString() {
        const metricMap = {
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
    isMetricActive(metric) {
        return this.ACTIVE_METRICS[metric] === true;
    },

    // ==========================================
    // 🌡️ TEMPERATURE UNIT MANAGEMENT
    // ==========================================
    
    // Current temperature unit ('C' for Celsius, 'F' for Fahrenheit)
    temperatureUnit: 'C',
    
    // Set temperature unit
    setTemperatureUnit(unit) {
        if (unit === 'C' || unit === 'F') {
            this.temperatureUnit = unit;
            console.log(`🌡️ Temperature unit set to: ${unit === 'C' ? 'Celsius' : 'Fahrenheit'}`);
        } else {
            console.warn('Invalid temperature unit. Use "C" or "F"');
        }
    },
    
    // Get current temperature unit
    getTemperatureUnit() {
        return this.temperatureUnit;
    },
    
    // Convert Celsius value to Fahrenheit for display (label only)
    celsiusToFahrenheitLabel(celsius) {
        return (celsius * 9/5) + 32;
    },
    
    // Format temperature value for display with correct unit
    formatTemperatureForDisplay(celsiusValue, precision = 1) {
        if (this.temperatureUnit === 'F') {
            const fahrenheit = this.celsiusToFahrenheitLabel(celsiusValue);
            return `${fahrenheit.toFixed(precision)}°F`;
        } else {
            return `${celsiusValue.toFixed(precision)}°C`;
        }
    },
    
    // Get temperature unit symbol
    getTemperatureUnitSymbol() {
        return this.temperatureUnit === 'F' ? '°F' : '°C';
    },
    
    // Get axis label for temperature with current unit
    getTemperatureAxisLabel(baseLabel = 'Temperature') {
        const unit = this.getTemperatureUnitSymbol();
        if (baseLabel.includes('UTCI')) {
            return baseLabel.replace('°C', unit);
        }
        return `${baseLabel} (${unit})`;
    },
    
    // Auto-set temperature unit based on USA detection
    autoSetTemperatureUnit(isUSA) {
        const newUnit = isUSA ? 'F' : 'C';
        this.setTemperatureUnit(newUnit);
        return newUnit;
    }
};
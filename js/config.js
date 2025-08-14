// Configuration and constants
const CONFIG = {
    // Chart dimensions
    mainMargin: {top: 20, right: 30, bottom: 40, left: 50},
    histMargin: {top: 20, right: 100, bottom: 40, left: 0},
    
    get mainWidth() { return 800 - this.mainMargin.left - this.mainMargin.right; },
    get mainHeight() { return 400 - this.mainMargin.top - this.mainMargin.bottom; },
    get histWidth() { return 300 - this.histMargin.left - this.histMargin.right; },
    get histHeight() { return 400 - this.histMargin.top - this.histMargin.bottom; },
    
    // Color schemes for different metrics
    colorSchemes: {
        max_temperature: {
            primary: '#FF8C42',    // Base orange - used for all elements
            secondary: '#FF8C42',  // Same orange - median line (opacity = 1.0)
            points: '#FF8C42',     // Same orange - data points (opacity = 0.4)
            bands: '#FF8C42'       // Same orange - 90th percentile (opacity = 0.3)
        },
        min_temperature: {
            primary: '#4A90E2',    // Base blue - used for all elements
            secondary: '#4A90E2',  // Same blue - median line (opacity = 1.0)
            points: '#4A90E2',     // Same blue - data points (opacity = 0.4)
            bands: '#4A90E2'       // Same blue - 90th percentile (opacity = 0.3)
        },
        precipitation_sum: {
            primary: '#B19CD9',    // Pastel purple - used for all elements
            secondary: '#B19CD9',  // Same pastel purple - median line (opacity = 1.0)
            points: '#B19CD9',     // Same pastel purple - data points (opacity = 0.4)
            bands: '#B19CD9'       // Same pastel purple - 90th percentile (opacity = 0.3)
        },
        wind_speed_10m_max: {
            primary: '#A8D8A8',    // Pastel green - used for all elements
            secondary: '#A8D8A8',  // Same pastel green - median line (opacity = 1.0)
            points: '#A8D8A8',     // Same pastel green - data points (opacity = 0.4)
            bands: '#A8D8A8'       // Same pastel green - 90th percentile (opacity = 0.3)
        }
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
    }
};
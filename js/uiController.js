// UI controller for handling user interactions and updates
class UIController {
    constructor(dataProcessor, chartRenderer) {
        this.dataProcessor = dataProcessor;
        this.chartRenderer = chartRenderer;
        this.startYear = 1940; // Default to 1940 to show all available historical data
        this.endYear = 2025;
    }

    // Initialize year range controls
    initializeYearControls() {
        const availableYears = this.dataProcessor.getAvailableYears();
        const startSelect = d3.select("#start-year");
        
        // Clear existing options first
        startSelect.selectAll("option").remove();
        
        // Populate start year dropdown
        startSelect.selectAll("option")
            .data(availableYears.length > 0 ? availableYears : [1940])
            .enter()
            .append("option")
            .attr("value", d => d)
            .text(d => d);
        
        // Set default values
        if (availableYears.length > 0) {
            this.endYear = availableYears[availableYears.length - 1];
            this.startYear = Math.min(availableYears[0], 1940); // Use 1940 or earliest available year
        } else {
            // Before data is loaded, set defaults
            this.endYear = 2025;
            this.startYear = 1940;
        }
        
        startSelect.property("value", this.startYear);
        
        // Add event listener
        startSelect.on("change", () => {
            this.startYear = +startSelect.property("value");
            this.updateCharts();
            this.updateYearInfo();
        });
        
        // Set metric selector to match DataProcessor's default and add event listener
        const metricSelect = d3.select("#metric-select");
        metricSelect.property("value", this.dataProcessor.currentMetric);
        
        metricSelect.on("change", () => {
            const newMetric = metricSelect.property("value");
            this.dataProcessor.setCurrentMetric(newMetric);
            this.updateCharts(); // This will recalculate domains and update everything
        });
        
        this.updateYearInfo();
    }

    // Update year range information
    updateYearInfo() {
        const fullData = this.dataProcessor.getFullData();
        
        // Only show info if we have data loaded
        if (!fullData || fullData.length === 0) {
            d3.select("#year-info").text("");
            return;
        }
        
        const yearCount = this.endYear - this.startYear + 1;
        const dataPointCount = fullData
            .filter(d => d.year >= this.startYear && d.year <= this.endYear).length;
        
        d3.select("#year-info")
            .text(`${yearCount} years, ${dataPointCount} data points`);
    }

    // Update data info display
    updateDataInfo() {
        const yearRange = `${this.startYear}-${this.endYear}`;
        const totalPoints = this.dataProcessor.getFilteredData().length;
        
        const currentDateData = this.dataProcessor.getCurrentDateData();
        
        let infoText = `Showing data from ${yearRange} (${totalPoints} data points)`;
        
        if (currentDateData.length > 0) {
            const currentTemp = currentDateData[0][this.dataProcessor.currentMetric];
            const percentHigher = this.dataProcessor.calculateTemperaturePercentile(currentTemp).toFixed(1);
            infoText += `<br/>Current temperature (${this.dataProcessor.currentDate}): ${currentTemp}°C (${percentHigher}th percentile)`;
        }
        
        d3.select("#data-info").html(infoText);
    }

    // Main update function
    updateCharts() {
        this.dataProcessor.filterData(this.startYear, this.endYear);
        this.chartRenderer.updateDomains(this.startYear, this.endYear);
        this.chartRenderer.updateCharts();
        this.updateDataInfo();
    }

    // Get current year range
    getYearRange() {
        return {
            startYear: this.startYear,
            endYear: this.endYear
        };
    }

    // Set year range
    setYearRange(startYear, endYear) {
        this.startYear = startYear;
        this.endYear = endYear;
        d3.select("#start-year").property("value", startYear);
        this.updateYearInfo();
    }
}
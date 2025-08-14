// UI controller for handling user interactions and updates
class UIController {
    constructor(dataProcessor, chartRenderer) {
        this.dataProcessor = dataProcessor;
        this.chartRenderer = chartRenderer;
        this.startYear = 2015;
        this.endYear = 2025;
    }

    // Initialize year range controls
    initializeYearControls() {
        const availableYears = this.dataProcessor.getAvailableYears();
        const startSelect = d3.select("#start-year");
        
        // Populate start year dropdown
        startSelect.selectAll("option")
            .data(availableYears)
            .enter()
            .append("option")
            .attr("value", d => d)
            .text(d => d);
        
        // Set default values
        this.endYear = availableYears[availableYears.length - 1];
        this.startYear = availableYears[0];
        
        startSelect.property("value", this.startYear);
        
        // Add event listener
        startSelect.on("change", () => {
            this.startYear = +startSelect.property("value");
            this.updateCharts();
            this.updateYearInfo();
        });
        
        // Add metric selector event listener
        d3.select("#metric-select").on("change", () => {
            const newMetric = d3.select("#metric-select").property("value");
            this.dataProcessor.setCurrentMetric(newMetric);
            this.updateCharts(); // This will recalculate domains and update everything
        });
        
        this.updateYearInfo();
    }

    // Update year range information
    updateYearInfo() {
        const yearCount = this.endYear - this.startYear + 1;
        const dataPointCount = this.dataProcessor.getFullData()
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
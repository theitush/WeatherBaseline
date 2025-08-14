// Data processing and management module
class DataProcessor {
    constructor() {
        this.fullData = [];
        this.filteredData = [];
        this.yearlyAggregates = [];
        this.availableYears = [];
        this.currentDate = '2025-08-12';
        this.currentMetric = 'max_temperature';
    }

    // Load CSV data
    async loadCSVData(filename = 'example_data.csv') {
        try {
            const response = await fetch(filename);
            
            if (!response.ok) {
                throw new Error(`HTTP error! status: ${response.status}`);
            }
            
            const csvText = await response.text();
            console.log('CSV loaded, length:', csvText.length);
            
            const data = d3.csvParse(csvText, d => ({
                date: new Date(d.date),
                year: +d.year,
                max_temperature: +d.max_temperature,
                min_temperature: +d.min_temperature,
                data_type: d.data_type
            }));
            
            console.log('Parsed data rows:', data.length);
            console.log('First few rows:', data.slice(0, 3));
            
            this.fullData = data;
            this.availableYears = [...new Set(data.map(d => d.year))].sort();
            
            return data;
        } catch (error) {
            console.error('Error loading CSV data:', error);
            return [];
        }
    }

    // Calculate yearly aggregates
    calculateYearlyAggregates(data = this.filteredData) {
        if (!data || data.length === 0) {
            console.log('No data provided to calculateYearlyAggregates');
            return [];
        }
        
        const yearGroups = d3.group(data, d => d.year);
        console.log('Year groups:', yearGroups.size);
        const aggregates = [];
        
        yearGroups.forEach((values, year) => {
            const temps = values.map(d => d[this.currentMetric]).sort(d3.ascending);
            const targetDate = new Date(year, new Date(this.currentDate).getMonth(), new Date(this.currentDate).getDate());
            
            aggregates.push({
                year: year,
                date: targetDate,
                p10: d3.quantile(temps, 0.10),
                p25: d3.quantile(temps, 0.25),
                p50: d3.quantile(temps, 0.50),
                p75: d3.quantile(temps, 0.75),
                p90: d3.quantile(temps, 0.90)
            });
        });
        
        // Calculate moving averages (5-year window)
        aggregates.sort((a, b) => a.year - b.year);
        const windowSize = 5;
        
        aggregates.forEach((d, i) => {
            const start = Math.max(0, i - Math.floor(windowSize / 2));
            const end = Math.min(aggregates.length, start + windowSize);
            const window = aggregates.slice(start, end);
            
            d.movingMedian = d3.median(window, d => d.p50);
            d.moving10 = d3.median(window, d => d.p10);
            d.moving25 = d3.median(window, d => d.p25);
            d.moving75 = d3.median(window, d => d.p75);
            d.moving90 = d3.median(window, d => d.p90);
        });
        
        this.yearlyAggregates = aggregates;
        return aggregates;
    }

    // Filter data based on year range
    filterData(startYear, endYear) {
        this.filteredData = this.fullData.filter(d => d.year >= startYear && d.year <= endYear);
        console.log(`Filtered data: ${this.filteredData.length} rows for years ${startYear}-${endYear}`);
        this.yearlyAggregates = this.calculateYearlyAggregates(this.filteredData);
        console.log(`Yearly aggregates: ${this.yearlyAggregates ? this.yearlyAggregates.length : 'undefined'} items`);
        return this.filteredData;
    }

    // Get current date data
    getCurrentDateData(data = this.filteredData) {
        return data.filter(d => 
            d.date.toDateString() === new Date(this.currentDate).toDateString()
        );
    }

    // Calculate temperature percentile
    calculateTemperaturePercentile(currentTemp, data = this.filteredData) {
        const higherCount = data.filter(d => d[this.currentMetric] > currentTemp).length;
        const totalCount = data.length;
        return (higherCount / totalCount * 100);
    }

    // Get data extents
    getDataExtents() {
        if (this.filteredData.length === 0) return null;
        
        return {
            dateExtent: d3.extent(this.filteredData, d => d.date),
            tempExtent: d3.extent(this.filteredData, d => d[this.currentMetric])
        };
    }

    // Update current metric
    setCurrentMetric(metric) {
        this.currentMetric = metric;
    }

    // Get available years
    getAvailableYears() {
        return this.availableYears;
    }

    // Get full data
    getFullData() {
        return this.fullData;
    }

    // Get filtered data
    getFilteredData() {
        return this.filteredData;
    }

    // Get yearly aggregates
    getYearlyAggregates() {
        return this.yearlyAggregates;
    }
}
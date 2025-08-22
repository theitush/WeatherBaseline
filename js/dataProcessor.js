// Data processing and management module
class DataProcessor {
    constructor(apiDataFetcher = null) {
        this.fullData = [];
        this.filteredData = [];
        this.fullYearlyAggregates = []; // Aggregates calculated from all data
        this.yearlyAggregates = []; // Filtered aggregates for display
        this.availableYears = [];
        this.currentDate = '2025-08-12';
        this.currentMetric = 'max_temperature';
        this.apiDataFetcher = apiDataFetcher;
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
            
            const data = d3.csvParse(csvText, d => {
                const row = {
                    date: new Date(d.date),
                    year: +d.year,
                    data_type: d.data_type
                };
                
                // 🎛️ Only parse active metrics from CSV
                if (CONFIG.isMetricActive('max_temperature')) {
                    row.max_temperature = +d.max_temperature;
                }
                if (CONFIG.isMetricActive('min_temperature')) {
                    row.min_temperature = +d.min_temperature;
                }
                if (CONFIG.isMetricActive('precipitation_sum')) {
                    row.precipitation_sum = +d.precipitation_sum || 0;
                }
                if (CONFIG.isMetricActive('wind_speed_10m_max')) {
                    row.wind_speed_10m_max = +d.wind_speed_10m_max || 0;
                }
                
                return row;
            });
            
            console.log('Parsed data rows:', data.length);
            console.log('First few rows:', data.slice(0, 3));
            
            this.fullData = data;
            this.availableYears = [...new Set(data.map(d => d.year))].sort();
            
            // Calculate aggregates based on all data for rolling median calculations
            this.fullYearlyAggregates = this.calculateYearlyAggregates(this.fullData);
            
            return data;
        } catch (error) {
            console.error('Error loading CSV data:', error);
            return [];
        }
    }

    // Load data from API
    async loadApiData(latitude, longitude, targetDate = null, startYear = 1940, daysRange = 7) {
        if (!this.apiDataFetcher) {
            throw new Error('API data fetcher not configured. Initialize DataProcessor with ApiDataFetcher instance.');
        }

        try {
            // Use current date if not provided
            if (!targetDate) {
                const today = new Date();
                targetDate = today.toISOString().split('T')[0];
                this.currentDate = targetDate;
            } else {
                this.currentDate = targetDate;
            }

            const data = await this.apiDataFetcher.getTemperatureHistory(
                latitude, longitude, targetDate, startYear, daysRange
            );
            
            if (!data || data.length === 0) {
                throw new Error('No weather data received from the API. The location or date range might not be available.');
            }
            
            console.log(`Loaded ${data.length} records`);
            
            this.fullData = data;
            this.availableYears = [...new Set(data.map(d => d.year))].sort();
            
            // Calculate aggregates based on all data for rolling median calculations
            this.fullYearlyAggregates = this.calculateYearlyAggregates(this.fullData);
            
            return data;
        } catch (error) {
            console.error('Error loading API data:', error);
            // Re-throw the error so it reaches the UI error handler
            throw error;
        }
    }

    // Calculate yearly aggregates
    calculateYearlyAggregates(data = this.filteredData) {
        if (!data || data.length === 0) {
            console.log('No data provided to calculateYearlyAggregates');
            return [];
        }
        
        // 🎛️ Only calculate aggregates if the current metric is active
        if (!CONFIG.isMetricActive(this.currentMetric)) {
            console.log(`Metric ${this.currentMetric} is not active, skipping aggregates calculation`);
            return [];
        }
        
        const yearGroups = d3.group(data, d => d.year);
        console.log('Year groups:', yearGroups.size);
        const aggregates = [];
        
        yearGroups.forEach((values, year) => {
            // Filter out null/undefined values for the current metric
            const metricValues = values
                .map(d => d[this.currentMetric])
                .filter(v => v !== null && v !== undefined);
                
            if (metricValues.length === 0) return; // Skip if no valid data
            
            const temps = metricValues.sort(d3.ascending);
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
        
        // Calculate moving averages (±2 years window, 5 total) - only show after having 2 years before and after
        aggregates.sort((a, b) => a.year - b.year);
        const windowRadius = 2; // ±2 years around current year
        
        aggregates.forEach((d, i) => {
            // Only calculate rolling median if we have at least 2 years before and 2 years after (so 5 years total)
            if (i >= windowRadius && i < aggregates.length - windowRadius) {
                // Take ±2 years around current year (5 years total)
                const start = i - windowRadius;
                const end = i + windowRadius + 1;
                const window = aggregates.slice(start, end);
                
                d.movingMedian = d3.median(window, d => d.p50);
                d.moving10 = d3.median(window, d => d.p10);
                d.moving25 = d3.median(window, d => d.p25);
                d.moving75 = d3.median(window, d => d.p75);
                d.moving90 = d3.median(window, d => d.p90);
            } else {
                // Set to null for years that don't have enough surrounding data
                d.movingMedian = null;
                d.moving10 = null;
                d.moving25 = null;
                d.moving75 = null;
                d.moving90 = null;
            }
        });
        
        this.yearlyAggregates = aggregates;
        return aggregates;
    }

    // Filter data based on year range
    filterData(startYear, endYear) {
        this.filteredData = this.fullData.filter(d => d.year >= startYear && d.year <= endYear);
        console.log(`Filtered data: ${this.filteredData.length} rows for years ${startYear}-${endYear}`);
        
        // Filter the pre-calculated full aggregates instead of recalculating
        this.yearlyAggregates = this.fullYearlyAggregates.filter(d => d.year >= startYear && d.year <= endYear);
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

    // Generate temperature context message
    generateTemperatureContext(currentTemp, data = this.filteredData) {
        if (!currentTemp || !data || data.length === 0) return null;
        
        const percentile = this.calculateTemperaturePercentile(currentTemp, data);
        const percentileFromBottom = 100 - percentile;
        
        // Sort all temperatures to get rankings
        const allTemps = data.map(d => d[this.currentMetric]).sort((a, b) => a - b);
        const totalCount = allTemps.length;
        
        // Find exact ranking
        let rankingFromColdest = allTemps.findIndex(temp => temp >= currentTemp) + 1;
        let rankingFromHottest = totalCount - allTemps.lastIndexOf(currentTemp);
        
        // Random phrase arrays
        const normalPhrases = ["Pretty typical", "Normal range", "Average temp", "Nothing unusual", "Right on track", "Nothing special", "Just average", "Not exciting"];
        const coolPhrases = ["A bit cool", "Slightly chilly", "Cooler side", "Touch below normal", "Mildly cold", "A bit brisk", "Slightly frosty", "A bit nippy", 
                             "Somewhat chilly", "A bit fresh", "A bit crisp", "A bit brisk", "Sorta cool"];
        const warmPhrases = ["A bit warm", "Slightly toasty", "Warmer side", "Touch above normal", "Mildly hot", "A bit balmy", "Slightly sultry", "A bit steamy",
                             "Somewhat warm", "Sorta hot"];
        const coldPhrases = ["Unusually cold", "Quite chilly", "Pretty frigid", "Really cool", "Very cold", "Bitterly cold", "Chill af", "Nippy!"];
        const hotPhrases = ["Unusually hot", "Quite toasty", "Pretty scorching", "Really warm", "Very hot", "Hot af", "Sweltering", "Scorching"];
        const extremeColdPhrases = ["Exceptionally frigid!", "Bone-chilling!", "Historic freeze!", "Brutal cold!", "Arctic blast!"];
        const extremeHotPhrases = ["Scorching rare heat!", "Blazing anomaly!", "Infernal heat!", "Blistering hot!", "Record heat!"];
        
        // Get random phrase
        const getRandomPhrase = (arr) => {
            const phrase = arr[Math.floor(Math.random() * arr.length)];
            // Add seasonal context to non-normal phrases
            if (arr === extremeColdPhrases || arr === extremeHotPhrases) {
                return phrase + " (for the season)";
            } else if (arr !== normalPhrases) {
                return phrase + " for the season";
            }
            return phrase;
        };
        
        let context = {};
        
        if (percentileFromBottom <= 5) {
            // Bottom 5% - very extreme cold
            context.percentile = `${percentileFromBottom.toFixed(0)}th percentile`;
            context.description = getRandomPhrase(extremeColdPhrases);
            context.ranking = `${rankingFromColdest}${this.getOrdinalSuffix(rankingFromColdest)} coldest in dataset!`;
        } else if (percentile <= 5) {
            // Top 5% - very extreme hot
            context.percentile = `${percentile.toFixed(0)}th percentile`;
            context.description = getRandomPhrase(extremeHotPhrases);
            context.ranking = `${rankingFromHottest}${this.getOrdinalSuffix(rankingFromHottest)} hottest in dataset!`;
        } else if (percentileFromBottom <= 10) {
            // Bottom 10% - extreme cold
            context.percentile = `${percentileFromBottom.toFixed(0)}th percentile`;
            context.description = getRandomPhrase(coldPhrases);
        } else if (percentile <= 10) {
            // Top 10% - extreme hot
            context.percentile = `${percentile.toFixed(0)}th percentile`;
            context.description = getRandomPhrase(hotPhrases);
        } else if (percentileFromBottom <= 20) {
            // 10-20th percentile - a bit cool
            context.percentile = `${percentileFromBottom.toFixed(0)}th percentile`;
            context.description = getRandomPhrase(coolPhrases);
        } else if (percentile <= 20) {
            // 80-90th percentile - a bit warm
            context.percentile = `${percentile.toFixed(0)}th percentile`;
            context.description = getRandomPhrase(warmPhrases);
        } else {
            // 20-80th percentile - normal
            context.percentile = `${Math.min(percentile, percentileFromBottom).toFixed(0)}th percentile`;
            context.description = getRandomPhrase(normalPhrases);
        }
        
        return context;
    }
    
    // Helper function to get ordinal suffix (1st, 2nd, 3rd, etc.)
    getOrdinalSuffix(num) {
        const j = num % 10;
        const k = num % 100;
        if (j == 1 && k != 11) return "st";
        if (j == 2 && k != 12) return "nd";
        if (j == 3 && k != 13) return "rd";
        return "th";
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
        // 🎛️ Only allow setting active metrics
        if (!CONFIG.isMetricActive(metric)) {
            console.warn(`Cannot set metric ${metric} - it is not active in CONFIG.ACTIVE_METRICS`);
            // Fallback to first active metric
            const activeMetrics = CONFIG.getActiveMetrics();
            if (activeMetrics.length > 0) {
                metric = activeMetrics[0];
                console.log(`Falling back to first active metric: ${metric}`);
            } else {
                console.error('No active metrics available!');
                return;
            }
        }
        
        this.currentMetric = metric;
        // Recalculate full aggregates with new metric
        if (this.fullData.length > 0) {
            this.fullYearlyAggregates = this.calculateYearlyAggregates(this.fullData);
        }
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
// API data fetcher for Open-Meteo weather data
class ApiDataFetcher {
    constructor() {
        // Use local server endpoints to avoid CORS issues
        this.ARCHIVE_API_URL = '/api/archive';
        this.FORECAST_API_URL = '/api/forecast';
        this.API_DATE_FORMAT = '%Y-%m-%d'; // For display purposes
    }

    // Format date to YYYY-MM-DD string
    formatDate(date) {
        return date.toISOString().split('T')[0];
    }

    // Parse date from YYYY-MM-DD string
    parseDate(dateString) {
        return new Date(dateString + 'T00:00:00');
    }

    // Add days to a date
    addDays(date, days) {
        const result = new Date(date);
        result.setDate(result.getDate() + days);
        return result;
    }

    // Get temperature history for a specific date range across all available years
    async getTemperatureHistory(latitude, longitude, targetDate, startYear = 1940, daysRange = 7) {
        console.log(`🌡️ [API] Starting temperature data fetch for ${targetDate} ±${daysRange} days at ${latitude}, ${longitude}...`);
        
        // Parse the target date
        const targetDt = this.parseDate(targetDate);
        const currentDate = new Date();
        currentDate.setHours(0, 0, 0, 0); // Reset time for comparison
        const yesterday = this.addDays(currentDate, -1);

        // Validate target date
        const maxDate = this.addDays(currentDate, 3);
        if (targetDt > maxDate) {
            throw new Error(`${targetDate} should be within 3 days of today!`);
        }

        // Always fetch complete historical data from 1940-01-01
        const overallStartStr = '1940-01-01';
        const yesterdayStr = this.formatDate(yesterday);

        console.log(`📊 [API] Historical data request: ${overallStartStr} to ${yesterdayStr}`);

        const dataRows = [];

        // Make historical API request
        const historicalData = await this.fetchHistoricalData(
            latitude, longitude, overallStartStr, yesterdayStr, targetDt, daysRange
        );
        dataRows.push(...historicalData);

        // Get current year data and forecast if needed
        if (targetDt >= yesterday) {
            console.log(`🔮 [API] Forecast data request until ${targetDate}`);
            
            const forecastData = await this.fetchForecastData(
                latitude, longitude, yesterdayStr, targetDate
            );
            dataRows.push(...forecastData);
        }

        console.log(`✅ [API] Temperature history fetch complete: ${dataRows.length} data points`);
        
        // Process and return data
        return this.processDataRows(dataRows);
    }

    // Fetch historical data from archive API
    async fetchHistoricalData(latitude, longitude, startDate, endDate, targetDt, daysRange) {
        // 🎛️ Dynamic API request based on active metrics in CONFIG
        const activeMetricsString = CONFIG.getActiveMetricsApiString();
        console.log(`🔧 Active metrics for API: ${activeMetricsString}`);
        
        const params = new URLSearchParams({
            latitude: latitude.toString(),
            longitude: longitude.toString(),
            start_date: startDate,
            end_date: endDate,
            daily: activeMetricsString, // Dynamic based on CONFIG.ACTIVE_METRICS
            timezone: 'auto'
        });

        const url = `${this.ARCHIVE_API_URL}?${params}`;
        
        console.log(`🔄 [API CALL] Archive API: ${url}`);
        const startTime = Date.now();
        
        const response = await fetch(url, {
            method: 'GET',
            headers: {
                'Accept': 'application/json',
            }
        });
        
        const duration = Date.now() - startTime;
        console.log(`⏱️ [API CALL] Archive API completed in ${duration}ms`);
        
        if (response.ok) {
            console.log(`✅ [API CALL] Archive API successful (${response.status})`);
        } else {
            console.error(`❌ [API CALL] Archive API failed (${response.status})`);
        }
        
        if (!response.ok) {
            // Try to get detailed error from server
            let errorMessage = `HTTP error! status: ${response.status} (${response.statusText})`;
            let serverDetails = '';
            
            try {
                const errorData = await response.json();
                if (errorData.message) {
                    errorMessage = errorData.message;
                }
                if (errorData.technical) {
                    serverDetails = errorData.technical;
                }
                if (errorData.suggestion) {
                    errorMessage += ` ${errorData.suggestion}`;
                }
            } catch (e) {
                // If we can't parse error JSON, use default message
            }
            
            // Include the URL that failed in the error
            const fullError = new Error(`${errorMessage}`);
            fullError.httpStatus = response.status;
            fullError.url = url;
            fullError.serverDetails = serverDetails;
            throw fullError;
        }

        const data = await response.json();
        console.log(`📈 [API DATA] Archive API returned ${data.daily?.time?.length || 0} daily records`);
        
        // Log cache status information if available
        if (data._cacheStatus) {
            const cacheEmoji = {
                'HIT': '💾✅',
                'MISS_EMPTY': '💾❌', 
                'MISS_PARTIAL': '💾🔄',
                'PARTIAL': '💾⚠️'
            };
            console.log(`${cacheEmoji[data._cacheStatus] || '💾'} [CACHE STATUS] ${data._cacheStatus} - Data source: ${data._dataSource}`);
            if (data._cachedRecords) {
                console.log(`💾 [CACHE INFO] Using ${data._cachedRecords} cached records`);
            }
            if (data._newRecords) {
                console.log(`🆕 [CACHE INFO] Added ${data._newRecords} new records to cache`);
            }
            if (data._totalCachedRecords) {
                console.log(`📊 [CACHE INFO] Total cached records: ${data._totalCachedRecords}`);
            }
        }
        
        const dataRows = [];

        if (data.daily && data.daily.time) {
            const dates = data.daily.time;
            
            // 🎛️ Dynamically extract data based on active metrics
            const maxTemps = CONFIG.isMetricActive('max_temperature') ? data.daily.apparent_temperature_max : [];
            const minTemps = CONFIG.isMetricActive('min_temperature') ? data.daily.apparent_temperature_min : [];
            // Keep original code but make it conditional
            const precipitation = CONFIG.isMetricActive('precipitation_sum') ? (data.daily.precipitation_sum || []) : [];
            const windSpeed = CONFIG.isMetricActive('wind_speed_10m_max') ? (data.daily.wind_speed_10m_max || []) : [];

            // Create a row for each date
            for (let i = 0; i < dates.length; i++) {
                // Only require active temperature metrics to be non-null
                const hasRequiredData = (
                    (!CONFIG.isMetricActive('max_temperature') || (maxTemps[i] !== null && maxTemps[i] !== undefined)) &&
                    (!CONFIG.isMetricActive('min_temperature') || (minTemps[i] !== null && minTemps[i] !== undefined))
                );
                
                if (hasRequiredData) {
                    const dateDt = this.parseDate(dates[i]);
                    const year = dateDt.getFullYear();

                    // Check if this date is within the target range for this year
                    const targetDateThisYear = new Date(year, targetDt.getMonth(), targetDt.getDate());
                    const startRange = this.addDays(targetDateThisYear, -daysRange);
                    const endRange = this.addDays(targetDateThisYear, daysRange);

                    if (dateDt >= startRange && dateDt <= endRange) {
                        const row = {
                            date: dates[i],
                            data_type: 'historical'
                        };
                        
                        // 🎛️ Only include active metrics in the data row
                        if (CONFIG.isMetricActive('min_temperature')) {
                            row.min_temperature = minTemps[i];
                        }
                        if (CONFIG.isMetricActive('max_temperature')) {
                            row.max_temperature = maxTemps[i];
                        }
                        if (CONFIG.isMetricActive('precipitation_sum')) {
                            row.precipitation_sum = (precipitation.length > i && precipitation[i] !== null) ? precipitation[i] : 0;
                        }
                        if (CONFIG.isMetricActive('wind_speed_10m_max')) {
                            row.wind_speed_10m_max = (windSpeed.length > i && windSpeed[i] !== null) ? windSpeed[i] : 0;
                        }
                        
                        dataRows.push(row);
                    }
                }
            }
        }

        return dataRows;
    }

    // Fetch forecast data from forecast API
    async fetchForecastData(latitude, longitude, startDate, endDate) {
        // 🎛️ Dynamic API request based on active metrics in CONFIG
        const activeMetricsString = CONFIG.getActiveMetricsApiString();
        
        const params = new URLSearchParams({
            latitude: latitude.toString(),
            longitude: longitude.toString(),
            start_date: startDate,
            end_date: endDate,
            daily: activeMetricsString, // Dynamic based on CONFIG.ACTIVE_METRICS
            timezone: 'auto'
        });

        const url = `${this.FORECAST_API_URL}?${params}`;
        
        console.log(`🔄 [API CALL] Forecast API: ${url}`);
        const startTime = Date.now();
        
        const response = await fetch(url, {
            method: 'GET',
            headers: {
                'Accept': 'application/json',
            }
        });
        
        const duration = Date.now() - startTime;
        console.log(`⏱️ [API CALL] Forecast API completed in ${duration}ms`);
        
        if (response.ok) {
            console.log(`✅ [API CALL] Forecast API successful (${response.status})`);
        } else {
            console.error(`❌ [API CALL] Forecast API failed (${response.status})`);
        }
        
        if (!response.ok) {
            // Try to get detailed error from server
            let errorMessage = `HTTP error! status: ${response.status} (${response.statusText})`;
            let serverDetails = '';
            
            try {
                const errorData = await response.json();
                if (errorData.message) {
                    errorMessage = errorData.message;
                }
                if (errorData.technical) {
                    serverDetails = errorData.technical;
                }
                if (errorData.suggestion) {
                    errorMessage += ` ${errorData.suggestion}`;
                }
            } catch (e) {
                // If we can't parse error JSON, use default message
            }
            
            // Include the URL that failed in the error
            const fullError = new Error(`${errorMessage}`);
            fullError.httpStatus = response.status;
            fullError.url = url;
            fullError.serverDetails = serverDetails;
            throw fullError;
        }

        const data = await response.json();
        console.log(`📈 [API DATA] Forecast API returned ${data.daily?.time?.length || 0} daily records`);
        
        // Log cache status information if available
        if (data._cacheStatus) {
            const cacheEmoji = {
                'BYPASS': '🔄🌐'
            };
            console.log(`${cacheEmoji[data._cacheStatus] || '🔄'} [CACHE STATUS] ${data._cacheStatus} - Data source: ${data._dataSource} (forecast data not cached)`);
        }
        
        const dataRows = [];

        if (data.daily && data.daily.time) {
            const dates = data.daily.time;
            
            // 🎛️ Dynamically extract data based on active metrics
            const maxTemps = CONFIG.isMetricActive('max_temperature') ? data.daily.apparent_temperature_max : [];
            const minTemps = CONFIG.isMetricActive('min_temperature') ? data.daily.apparent_temperature_min : [];
            // Keep original code but make it conditional
            const precipitation = CONFIG.isMetricActive('precipitation_sum') ? data.daily.precipitation_sum : [];
            const windSpeed = CONFIG.isMetricActive('wind_speed_10m_max') ? data.daily.wind_speed_10m_max : [];

            // Create a row for each date
            for (let i = 0; i < dates.length; i++) {
                // Only require active temperature metrics to be non-null
                const hasRequiredData = (
                    (!CONFIG.isMetricActive('max_temperature') || (maxTemps[i] !== null && maxTemps[i] !== undefined)) &&
                    (!CONFIG.isMetricActive('min_temperature') || (minTemps[i] !== null && minTemps[i] !== undefined))
                );
                
                if (hasRequiredData) {
                    const row = {
                        date: dates[i],
                        data_type: 'forecast'
                    };
                    
                    // 🎛️ Only include active metrics in the data row
                    if (CONFIG.isMetricActive('min_temperature')) {
                        row.min_temperature = minTemps[i];
                    }
                    if (CONFIG.isMetricActive('max_temperature')) {
                        row.max_temperature = maxTemps[i];
                    }
                    if (CONFIG.isMetricActive('precipitation_sum')) {
                        row.precipitation_sum = precipitation[i] || 0;
                    }
                    if (CONFIG.isMetricActive('wind_speed_10m_max')) {
                        row.wind_speed_10m_max = windSpeed[i] || 0;
                    }
                    
                    dataRows.push(row);
                }
            }
        }

        console.log(`📊 [API DATA] Forecast API processed ${dataRows.length} matching records`);
        return dataRows;
    }

    // Process data rows and add computed fields
    processDataRows(dataRows) {
        return dataRows.map(row => ({
            ...row,
            date: this.parseDate(row.date),
            year: this.parseDate(row.date).getFullYear()
        }));
    }

    // Console-friendly function to fetch data with coordinates
    async fetchDataFromConsole(latitude = 32.0853, longitude = 34.7818, targetDate = null, startYear = 1940, daysRange = 7) {
        // Use current date if not provided
        if (!targetDate) {
            const today = new Date();
            targetDate = this.formatDate(today);
        }

        console.log(`🌡️  Fetching temperature data...`);
        console.log(`📍 Location: ${latitude}, ${longitude}`);
        console.log(`📅 Target Date: ${targetDate} ±${daysRange} days`);
        console.log(`📊 Historical Data: ${startYear} onwards`);
        console.log('');

        try {
            const data = await this.getTemperatureHistory(latitude, longitude, targetDate, startYear, daysRange);
            
            console.log(`✅ Successfully fetched ${data.length} data points`);
            console.log(`📈 Years covered: ${Math.min(...data.map(d => d.year))} - ${Math.max(...data.map(d => d.year))}`);
            
            // Show sample data
            console.log('\n📋 Sample data:');
            console.table(data.slice(0, 5).map(d => ({
                Date: d.date.toDateString(),
                Year: d.year,
                'Max °C': d.max_temperature,
                'Min °C': d.min_temperature,
                Type: d.data_type
            })));

            console.log('\n💾 Full dataset available in returned object');
            console.log('Usage: const data = await fetcher.fetchDataFromConsole(lat, lon, date);');

            return data;

        } catch (error) {
            console.error('❌ Error fetching data:', error);
            throw error;
        }
    }

    // Get data for common cities
    async getCityData(cityName, targetDate = null, startYear = 1940, daysRange = 7) {
        const cities = {
            'tel_aviv': { lat: 32.0853, lng: 34.7818, name: 'Tel Aviv, Israel' },
            'san_francisco': { lat: 37.7749, lng: -122.4194, name: 'San Francisco, CA' },
            'new_york': { lat: 40.7128, lng: -74.0060, name: 'New York, NY' },
            'london': { lat: 51.5074, lng: -0.1278, name: 'London, UK' },
            'paris': { lat: 48.8566, lng: 2.3522, name: 'Paris, France' },
            'tokyo': { lat: 35.6762, lng: 139.6503, name: 'Tokyo, Japan' },
            'sydney': { lat: -33.8688, lng: 151.2093, name: 'Sydney, Australia' },
            'toronto': { lat: 43.6532, lng: -79.3832, name: 'Toronto, Canada' },
            'berlin': { lat: 52.5200, lng: 13.4050, name: 'Berlin, Germany' }
        };

        const city = cities[cityName.toLowerCase()];
        if (!city) {
            const availableCities = Object.keys(cities).join(', ');
            throw new Error(`City "${cityName}" not found. Available cities: ${availableCities}`);
        }

        console.log(`🏙️  Fetching data for ${city.name}`);
        return await this.fetchDataFromConsole(city.lat, city.lng, targetDate, startYear, daysRange);
    }
}
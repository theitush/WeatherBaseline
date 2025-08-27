const express = require('express');
const cors = require('cors');
const fetch = require('node-fetch');
const path = require('path');
const CacheManager = require('./js/cacheManager');

const app = express();
const PORT = process.env.PORT || 3000;
const cacheManager = new CacheManager();

// Enable CORS for all routes
app.use(cors());
app.use(express.json());

// Serve static files from current directory
app.use(express.static(__dirname));

// Serve the main HTML file
app.get('/', (req, res) => {
    res.sendFile(path.join(__dirname, 'interactive_temperature.html'));
});

// Proxy endpoint for Open-Meteo Archive API with caching
app.get('/api/archive', async (req, res) => {
    try {
        const { latitude, longitude, start_date, end_date, daily, timezone } = req.query;
        
        // Initialize cache if needed
        await cacheManager.initialize();
        
        // Check cache first
        const cachedData = await cacheManager.getCachedData(latitude, longitude);
        
        if (cachedData && await cacheManager.isCacheCurrent(latitude, longitude, end_date)) {
            // Cache hit - filter and return cached data
            console.log(`💾 [CACHE HIT] Location ${latitude}, ${longitude} - serving ${cachedData.length} cached records`);
            const filteredData = filterDataByDateRange(cachedData, start_date, end_date);
            const responseData = formatApiResponse(filteredData, latitude, longitude, daily, null);
            responseData._cacheStatus = 'HIT';
            responseData._dataSource = 'CACHE';
            responseData._cachedRecords = cachedData.length;
            return res.json(responseData);
        }
        
        // Cache miss or outdated - fetch missing data
        const missingRange = await cacheManager.getMissingDateRange(latitude, longitude, end_date);
        
        if (!missingRange) {
            // This shouldn't happen if isCacheCurrent returned false, but just in case
            console.log(`💾 [CACHE PARTIAL] Location ${latitude}, ${longitude} - using existing cache`);
            const filteredData = filterDataByDateRange(cachedData, start_date, end_date);
            const responseData = formatApiResponse(filteredData, latitude, longitude, daily, null);
            responseData._cacheStatus = 'PARTIAL';
            responseData._dataSource = 'CACHE';
            return res.json(responseData);
        }
        
        const cacheStatusLabel = cachedData && cachedData.length > 0 ? 'MISS_PARTIAL' : 'MISS_EMPTY';
        console.log(`🔄 [CACHE ${cacheStatusLabel}] Location ${latitude}, ${longitude} - fetching missing data from ${missingRange.startDate} to ${missingRange.endDate}`);
        
        // 🎛️ Server-side metric configuration (mirrors CONFIG.ACTIVE_METRICS)
        // TODO: Consider moving to a shared config file if needed
        const ACTIVE_METRICS = {
            max_temperature: true,      // ✅ Maximum temperature
            min_temperature: true,      // ✅ Minimum temperature  
            precipitation_sum: false,   // ❌ Precipitation (commented out)
            wind_speed_10m_max: false   // ❌ Wind speed (commented out)
        };
        
        const metricMap = {
            max_temperature: 'apparent_temperature_max',
            min_temperature: 'apparent_temperature_min',
            precipitation_sum: 'precipitation_sum',
            wind_speed_10m_max: 'wind_speed_10m_max'
        };
        
        const dynamicDaily = Object.keys(ACTIVE_METRICS)
            .filter(metric => ACTIVE_METRICS[metric])
            .map(metric => metricMap[metric])
            .join(',');
            
        console.log(`🔧 Server fetching active metrics: ${dynamicDaily}`);
        
        // Fetch missing data from API
        const params = new URLSearchParams({
            latitude: latitude.toString(),
            longitude: longitude.toString(),
            start_date: missingRange.startDate,
            end_date: missingRange.endDate,
            daily: dynamicDaily, // Use dynamic metrics instead of hardcoded 'daily'
            timezone: 'auto'
        });
        
        const url = `https://archive-api.open-meteo.com/v1/archive?${params}`;
        console.log(`🌐 [API CALL] Archive API: ${url}`);
        const apiStartTime = Date.now();
        
        const response = await fetch(url, {
            method: 'GET',
            headers: {
                'Accept': 'application/json',
                'User-Agent': 'HowHotWasIt/1.0 Weather App'
            },
            timeout: 60000 // 60 second timeout
        });
        
        const apiDuration = Date.now() - apiStartTime;
        if (response.ok) {
            console.log(`✅ [API CALL] Archive API successful in ${apiDuration}ms (${response.status})`);
        } else {
            console.error(`❌ [API CALL] Archive API failed in ${apiDuration}ms (${response.status})`);
        }
        
        if (!response.ok) {
            // Try to get error details from the API response
            let errorDetails = '';
            try {
                const errorData = await response.json();
                errorDetails = JSON.stringify(errorData);
            } catch (e) {
                errorDetails = await response.text();
            }
            throw new Error(`Archive API returned status ${response.status}: ${response.statusText}. Details: ${errorDetails}`);
        }
        
        const apiData = await response.json();
        
        // Convert API response to our internal format
        const newDataRows = convertApiDataToRows(apiData);
        
        // Merge with existing cache
        const allData = await cacheManager.mergeWithCache(latitude, longitude, newDataRows);
        console.log(`💾 [CACHE UPDATE] Merged ${newDataRows.length} new records with existing cache (total: ${allData.length} records)`);
        
        // Filter and return requested data
        const filteredData = filterDataByDateRange(allData, start_date, end_date);
        const responseData = formatApiResponse(filteredData, latitude, longitude, daily, apiData);
        responseData._cacheStatus = cacheStatusLabel;
        responseData._dataSource = 'API+CACHE';
        responseData._newRecords = newDataRows.length;
        responseData._totalCachedRecords = allData.length;
        res.json(responseData);
        
    } catch (error) {
        console.error('Archive API Error:', error);
        
        res.status(500).json({
            error: 'Archive API Error',
            message: error.message,
            stack: error.stack,
            type: error.constructor.name
        });
    }
});

// Proxy endpoint for Open-Meteo Forecast API
app.get('/api/forecast', async (req, res) => {
    try {
        const { latitude, longitude, start_date, end_date, daily, timezone } = req.query;
        
        // 🎛️ Server-side metric configuration (mirrors CONFIG.ACTIVE_METRICS)
        const ACTIVE_METRICS = {
            max_temperature: true,      // ✅ Maximum temperature
            min_temperature: true,      // ✅ Minimum temperature  
            precipitation_sum: false,   // ❌ Precipitation (commented out)
            wind_speed_10m_max: false   // ❌ Wind speed (commented out)
        };
        
        const metricMap = {
            max_temperature: 'apparent_temperature_max',
            min_temperature: 'apparent_temperature_min',
            precipitation_sum: 'precipitation_sum',
            wind_speed_10m_max: 'wind_speed_10m_max'
        };
        
        const dynamicDaily = Object.keys(ACTIVE_METRICS)
            .filter(metric => ACTIVE_METRICS[metric])
            .map(metric => metricMap[metric])
            .join(',');
            
        console.log(`🔧 Forecast API fetching active metrics: ${dynamicDaily}`);
        
        // Build the URL with query parameters
        const params = new URLSearchParams({
            latitude: latitude.toString(),
            longitude: longitude.toString(),
            start_date,
            end_date,
            daily: dynamicDaily, // Use dynamic metrics
            timezone: 'auto'
        });
        
        const url = `https://api.open-meteo.com/v1/forecast?${params}`;
        console.log(`🌐 [API CALL] Forecast API: ${url}`);
        const apiStartTime = Date.now();
        
        const response = await fetch(url, {
            method: 'GET',
            headers: {
                'Accept': 'application/json',
                'User-Agent': 'HowHotWasIt/1.0 Weather App'
            },
            timeout: 60000 // 60 second timeout
        });
        
        const apiDuration = Date.now() - apiStartTime;
        if (response.ok) {
            console.log(`✅ [API CALL] Forecast API successful in ${apiDuration}ms (${response.status})`);
        } else {
            console.error(`❌ [API CALL] Forecast API failed in ${apiDuration}ms (${response.status})`);
        }
        
        if (!response.ok) {
            throw new Error(`Forecast API returned status ${response.status}: ${response.statusText}`);
        }
        
        const data = await response.json();
        console.log(`📈 [API DATA] Forecast API returned ${data.daily?.time?.length || 0} daily records`);
        data._cacheStatus = 'BYPASS';
        data._dataSource = 'API';
        res.json(data);
        
    } catch (error) {
        console.error('Forecast API Error:', error);
        
        res.status(500).json({
            error: 'Forecast API Error',
            message: error.message,
            stack: error.stack,
            type: error.constructor.name
        });
    }
});

// Health check endpoint
app.get('/api/health', (req, res) => {
    res.json({
        status: 'ok',
        timestamp: new Date().toISOString(),
        message: 'HowHotWasIt Weather Server is running'
    });
});

// Cache status endpoint
app.get('/api/cache-status', async (req, res) => {
    try {
        await cacheManager.initialize();
        const stats = cacheManager.getStats();
        res.json(stats);
    } catch (error) {
        res.status(500).json({
            error: 'Cache Status Error',
            message: error.message,
            stack: error.stack,
            type: error.constructor.name
        });
    }
});

// Helper functions for cache integration

// Convert Open-Meteo API response to our internal data row format
function convertApiDataToRows(apiData) {
    // 🎛️ Server-side metric configuration (should match client-side CONFIG.ACTIVE_METRICS)
    const ACTIVE_METRICS = {
        max_temperature: true,      // ✅ Maximum temperature
        min_temperature: true,      // ✅ Minimum temperature  
        precipitation_sum: false,   // ❌ Precipitation (commented out)
        wind_speed_10m_max: false   // ❌ Wind speed (commented out)
    };
    
    const rows = [];
    
    if (apiData.daily && apiData.daily.time) {
        const dates = apiData.daily.time;
        
        // 🎛️ Dynamically extract data based on active metrics
        const maxTemps = ACTIVE_METRICS.max_temperature ? apiData.daily.apparent_temperature_max : [];
        const minTemps = ACTIVE_METRICS.min_temperature ? apiData.daily.apparent_temperature_min : [];
        // Keep original code but make it conditional
        const precipitation = ACTIVE_METRICS.precipitation_sum ? (apiData.daily.precipitation_sum || []) : [];
        const windSpeed = ACTIVE_METRICS.wind_speed_10m_max ? (apiData.daily.wind_speed_10m_max || []) : [];
        
        for (let i = 0; i < dates.length; i++) {
            // Only require active temperature metrics to be non-null
            const hasRequiredData = (
                (!ACTIVE_METRICS.max_temperature || (maxTemps[i] !== null && maxTemps[i] !== undefined)) &&
                (!ACTIVE_METRICS.min_temperature || (minTemps[i] !== null && minTemps[i] !== undefined))
            );
            
            if (hasRequiredData) {
                const row = {
                    date: dates[i],
                    data_type: 'historical'
                };
                
                // 🎛️ Only include active metrics in the data row
                if (ACTIVE_METRICS.min_temperature) {
                    row.min_temperature = minTemps[i];
                }
                if (ACTIVE_METRICS.max_temperature) {
                    row.max_temperature = maxTemps[i];
                }
                if (ACTIVE_METRICS.precipitation_sum) {
                    row.precipitation_sum = (precipitation.length > i && precipitation[i] !== null) ? precipitation[i] : 0;
                }
                if (ACTIVE_METRICS.wind_speed_10m_max) {
                    row.wind_speed_10m_max = (windSpeed.length > i && windSpeed[i] !== null) ? windSpeed[i] : 0;
                }
                
                rows.push(row);
            }
        }
    }
    
    return rows;
}

// Filter data array by date range
function filterDataByDateRange(dataArray, startDate, endDate) {
    return dataArray.filter(row => {
        const rowDate = row.date;
        return rowDate >= startDate && rowDate <= endDate;
    });
}

// Format filtered data back to Open-Meteo API response format
function formatApiResponse(filteredData, latitude, longitude, daily, apiData) {
    // 🎛️ Server-side metric configuration (should match client-side CONFIG.ACTIVE_METRICS)
    const ACTIVE_METRICS = {
        max_temperature: true,      // ✅ Maximum temperature
        min_temperature: true,      // ✅ Minimum temperature  
        precipitation_sum: false,   // ❌ Precipitation (commented out)
        wind_speed_10m_max: false   // ❌ Wind speed (commented out)
    };
    
    const response = {
        latitude: parseFloat(latitude),
        longitude: parseFloat(longitude),
        generationtime_ms: 0.1, // Cached response
        utc_offset_seconds: apiData ? apiData.utc_offset_seconds : 0,
        timezone: apiData ? apiData.timezone : 'auto',
        timezone_abbreviation: apiData ? apiData.timezone_abbreviation : 'AUTO',
        elevation: apiData ? apiData.elevation : 0,
        daily_units: {},
        daily: {
            time: []
        }
    };
    
    // 🎛️ Dynamically build response structure based on active metrics
    if (ACTIVE_METRICS.max_temperature) {
        response.daily_units.apparent_temperature_max = '°C';
        response.daily.apparent_temperature_max = [];
    }
    if (ACTIVE_METRICS.min_temperature) {
        response.daily_units.apparent_temperature_min = '°C';
        response.daily.apparent_temperature_min = [];
    }
    if (ACTIVE_METRICS.precipitation_sum) {
        response.daily_units.precipitation_sum = 'mm';
        response.daily.precipitation_sum = [];
    }
    if (ACTIVE_METRICS.wind_speed_10m_max) {
        response.daily_units.wind_speed_10m_max = 'km/h';
        response.daily.wind_speed_10m_max = [];
    }
    
    response.daily_units.time = 'iso8601';
    
    // Sort by date to ensure chronological order
    const sortedData = filteredData.sort((a, b) => a.date.localeCompare(b.date));
    
    for (const row of sortedData) {
        response.daily.time.push(row.date);
        
        // 🎛️ Only include active metrics in response
        if (ACTIVE_METRICS.max_temperature) {
            response.daily.apparent_temperature_max.push(row.max_temperature);
        }
        if (ACTIVE_METRICS.min_temperature) {
            response.daily.apparent_temperature_min.push(row.min_temperature);
        }
        if (ACTIVE_METRICS.precipitation_sum) {
            response.daily.precipitation_sum.push(row.precipitation_sum);
        }
        if (ACTIVE_METRICS.wind_speed_10m_max) {
            response.daily.wind_speed_10m_max.push(row.wind_speed_10m_max);
        }
    }
    
    return response;
}

// Start server
app.listen(PORT, () => {
    console.log(`🌡️  HowHotWasIt Weather Server running on http://localhost:${PORT}`);
    console.log(`📊 View the app at: http://localhost:${PORT}`);
    console.log(`🔧 API endpoints available at: /api/archive and /api/forecast`);
    console.log(`💚 Health check available at: http://localhost:${PORT}/api/health`);
});
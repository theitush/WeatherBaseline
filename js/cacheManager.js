// Cache manager for historical weather data
const fs = require('fs').promises;
const path = require('path');

class CacheManager {
    constructor(cacheDir = 'cache') {
        this.cache = new Map(); // In-memory cache
        this.cacheDir = cacheDir;
        this.initialized = false;
    }

    // Initialize cache manager and load from disk
    async initialize() {
        if (this.initialized) return;

        try {
            // Ensure cache directory exists
            await fs.mkdir(this.cacheDir, { recursive: true });
            
            // Load existing cache from disk
            await this.loadFromDisk();
            
            this.initialized = true;
            console.log('Cache manager initialized');
        } catch (error) {
            console.error('Error initializing cache manager:', error);
            this.initialized = true; // Continue even if loading fails
        }
    }

    // Generate cache key for location
    generateLocationKey(latitude, longitude) {
        const lat = parseFloat(latitude).toFixed(2);
        const lng = parseFloat(longitude).toFixed(2);
        return `weather_hist_${lat}_${lng}`;
    }

    // Get CSV file path for location
    getCsvFilePath(latitude, longitude) {
        const key = this.generateLocationKey(latitude, longitude);
        return path.join(this.cacheDir, `${key}.csv`);
    }

    // Get cached data for location
    async getCachedData(latitude, longitude) {
        const key = this.generateLocationKey(latitude, longitude);
        
        // Check in-memory cache first
        if (this.cache.has(key)) {
            return this.cache.get(key);
        }
        
        // Load from CSV file
        try {
            const csvPath = this.getCsvFilePath(latitude, longitude);
            const csvContent = await fs.readFile(csvPath, 'utf8');
            const data = this.parseCsv(csvContent);
            
            // Cache in memory for future access
            this.cache.set(key, data);
            return data;
        } catch (error) {
            if (error.code !== 'ENOENT') {
                console.error('Error reading CSV cache:', error);
            }
            return null;
        }
    }

    // Get last date from cached data array
    getLastCachedDate(data) {
        if (!data || data.length === 0) return null;
        const lastEntry = data[data.length - 1];
        return lastEntry.date;
    }

    // Check if cache is current (has data up to the requested end date or yesterday)
    async isCacheCurrent(latitude, longitude, requestedEndDate = null) {
        const data = await this.getCachedData(latitude, longitude);
        if (!data) return false;

        const lastDate = this.getLastCachedDate(data);
        if (!lastDate) return false;

        // Use requested end date if provided, otherwise default to yesterday
        let targetEndDate;
        if (requestedEndDate) {
            targetEndDate = new Date(requestedEndDate);
        } else {
            targetEndDate = new Date();
            targetEndDate.setDate(targetEndDate.getDate() - 1);
        }
        targetEndDate.setHours(0, 0, 0, 0);

        const lastCachedDate = new Date(lastDate);
        lastCachedDate.setHours(0, 0, 0, 0);

        return lastCachedDate >= targetEndDate;
    }

    // Store data in cache
    async setCachedData(latitude, longitude, data) {
        const key = this.generateLocationKey(latitude, longitude);
        
        // Sort data by date to ensure chronological order
        const sortedData = [...data].sort((a, b) => new Date(a.date) - new Date(b.date));
        
        this.cache.set(key, sortedData);
        
        // Save to CSV file asynchronously
        this.saveToCsv(latitude, longitude, sortedData).catch(error => {
            console.error('Error saving cache to CSV:', error);
        });
    }

    // Merge new data with existing cache
    async mergeWithCache(latitude, longitude, newData) {
        const existingData = await this.getCachedData(latitude, longitude) || [];
        
        // Combine existing and new data
        const allData = [...existingData, ...newData];
        
        // Remove duplicates and sort by date
        const uniqueData = allData.filter((item, index, self) => 
            index === self.findIndex(other => other.date === item.date)
        ).sort((a, b) => new Date(a.date) - new Date(b.date));
        
        await this.setCachedData(latitude, longitude, uniqueData);
        return uniqueData;
    }

    // Get date range that needs to be fetched
    async getMissingDateRange(latitude, longitude, requestedEndDate = null) {
        const data = await this.getCachedData(latitude, longitude);
        
        // Use requested end date if provided, otherwise default to yesterday
        let targetEndDate;
        if (requestedEndDate) {
            targetEndDate = requestedEndDate;
        } else {
            const yesterday = new Date();
            yesterday.setDate(yesterday.getDate() - 1);
            targetEndDate = yesterday.toISOString().split('T')[0];
        }
        
        if (!data || data.length === 0) {
            // No cache - need everything from 1940
            return { startDate: '1940-01-01', endDate: targetEndDate };
        }
        
        const lastDate = this.getLastCachedDate(data);
        if (!lastDate) {
            return { startDate: '1940-01-01', endDate: targetEndDate };
        }
        
        const lastCachedDate = new Date(lastDate);
        const nextDay = new Date(lastCachedDate);
        nextDay.setDate(nextDay.getDate() + 1);
        
        const nextDayStr = nextDay.toISOString().split('T')[0];
        
        // Check if we need any new data
        if (nextDayStr > targetEndDate) {
            return null; // Cache is current
        }
        
        return { startDate: nextDayStr, endDate: targetEndDate };
    }

    // Load cache from disk (scan for CSV files)
    async loadFromDisk() {
        try {
            const files = await fs.readdir(this.cacheDir);
            const csvFiles = files.filter(file => file.endsWith('.csv') && file.startsWith('weather_hist_'));
            
            console.log(`Found ${csvFiles.length} CSV cache files`);
            
            // Don't load all CSV files into memory immediately
            // They'll be loaded on-demand in getCachedData
            this.cache = new Map();
            
        } catch (error) {
            if (error.code !== 'ENOENT') {
                console.error('Error scanning cache directory:', error);
            }
            this.cache = new Map();
        }
    }

    // Save data to CSV file
    async saveToCsv(latitude, longitude, data) {
        try {
            const csvPath = this.getCsvFilePath(latitude, longitude);
            
            let csvContent = 'date,min_temperature,max_temperature\n';
            for (const record of data) {
                csvContent += `${record.date},${record.min_temperature},${record.max_temperature}\n`;
            }
            
            await fs.writeFile(csvPath, csvContent);
        } catch (error) {
            console.error('Error saving CSV cache:', error);
        }
    }
    
    // Parse CSV content to data array
    parseCsv(csvContent) {
        const lines = csvContent.trim().split('\n');
        const data = [];
        
        // Skip header line
        for (let i = 1; i < lines.length; i++) {
            const [date, minTemp, maxTemp] = lines[i].split(',');
            data.push({
                date,
                min_temperature: parseFloat(minTemp),
                max_temperature: parseFloat(maxTemp)
            });
        }
        
        return data;
    }

    // Get cache statistics
    async getStats() {
        try {
            const files = await fs.readdir(this.cacheDir);
            const csvFiles = files.filter(file => file.endsWith('.csv') && file.startsWith('weather_hist_'));
            
            const stats = {
                totalLocations: csvFiles.length,
                locations: []
            };
            
            for (const file of csvFiles) {
                const key = file.replace('.csv', '');
                const [, , lat, lng] = key.split('_');
                
                const data = await this.getCachedData(lat, lng);
                if (data) {
                    const lastDate = this.getLastCachedDate(data);
                    stats.locations.push({
                        key,
                        dataPoints: data.length,
                        lastDate,
                        isCurrent: await this.isCacheCurrent(lat, lng)
                    });
                }
            }
            
            return stats;
        } catch (error) {
            console.error('Error getting cache stats:', error);
            return { totalLocations: 0, locations: [] };
        }
    }

    // Clear all cache
    async clearCache() {
        this.cache.clear();
        try {
            const files = await fs.readdir(this.cacheDir);
            const csvFiles = files.filter(file => file.endsWith('.csv') && file.startsWith('weather_hist_'));
            
            for (const file of csvFiles) {
                await fs.unlink(path.join(this.cacheDir, file));
            }
            
            console.log(`Cleared ${csvFiles.length} cache files`);
        } catch (error) {
            console.error('Error clearing cache:', error);
        }
    }
}

module.exports = CacheManager;
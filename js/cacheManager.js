// Cache manager for historical weather data
const fs = require('fs').promises;
const path = require('path');

class CacheManager {
    constructor(cacheDir = 'cache') {
        this.cache = new Map(); // In-memory cache
        this.cacheDir = cacheDir;
        this.cacheFile = path.join(cacheDir, 'weather_cache.json');
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

    // Get cached data for location
    getCachedData(latitude, longitude) {
        const key = this.generateLocationKey(latitude, longitude);
        return this.cache.get(key) || null;
    }

    // Get last date from cached data array
    getLastCachedDate(data) {
        if (!data || data.length === 0) return null;
        const lastEntry = data[data.length - 1];
        return lastEntry.date;
    }

    // Check if cache is current (has data up to yesterday)
    isCacheCurrent(latitude, longitude) {
        const data = this.getCachedData(latitude, longitude);
        if (!data) return false;

        const lastDate = this.getLastCachedDate(data);
        if (!lastDate) return false;

        const yesterday = new Date();
        yesterday.setDate(yesterday.getDate() - 1);
        yesterday.setHours(0, 0, 0, 0);

        const lastCachedDate = new Date(lastDate);
        lastCachedDate.setHours(0, 0, 0, 0);

        return lastCachedDate >= yesterday;
    }

    // Store data in cache
    setCachedData(latitude, longitude, data) {
        const key = this.generateLocationKey(latitude, longitude);
        
        // Sort data by date to ensure chronological order
        const sortedData = [...data].sort((a, b) => new Date(a.date) - new Date(b.date));
        
        this.cache.set(key, sortedData);
        
        // Save to disk asynchronously (don't wait for it)
        this.saveToDisk().catch(error => {
            console.error('Error saving cache to disk:', error);
        });
    }

    // Merge new data with existing cache
    mergeWithCache(latitude, longitude, newData) {
        const existingData = this.getCachedData(latitude, longitude) || [];
        
        // Combine existing and new data
        const allData = [...existingData, ...newData];
        
        // Remove duplicates and sort by date
        const uniqueData = allData.filter((item, index, self) => 
            index === self.findIndex(other => other.date === item.date)
        ).sort((a, b) => new Date(a.date) - new Date(b.date));
        
        this.setCachedData(latitude, longitude, uniqueData);
        return uniqueData;
    }

    // Get date range that needs to be fetched
    getMissingDateRange(latitude, longitude) {
        const data = this.getCachedData(latitude, longitude);
        
        const yesterday = new Date();
        yesterday.setDate(yesterday.getDate() - 1);
        const yesterdayStr = yesterday.toISOString().split('T')[0];
        
        if (!data || data.length === 0) {
            // No cache - need everything from 1940
            return { startDate: '1940-01-01', endDate: yesterdayStr };
        }
        
        const lastDate = this.getLastCachedDate(data);
        if (!lastDate) {
            return { startDate: '1940-01-01', endDate: yesterdayStr };
        }
        
        const lastCachedDate = new Date(lastDate);
        const nextDay = new Date(lastCachedDate);
        nextDay.setDate(nextDay.getDate() + 1);
        
        const nextDayStr = nextDay.toISOString().split('T')[0];
        
        // Check if we need any new data
        if (nextDayStr > yesterdayStr) {
            return null; // Cache is current
        }
        
        return { startDate: nextDayStr, endDate: yesterdayStr };
    }

    // Load cache from disk
    async loadFromDisk() {
        try {
            const data = await fs.readFile(this.cacheFile, 'utf8');
            const cacheData = JSON.parse(data);
            
            // Convert plain object back to Map
            this.cache = new Map(Object.entries(cacheData));
            
            console.log(`Loaded cache with ${this.cache.size} locations from disk`);
        } catch (error) {
            if (error.code !== 'ENOENT') {
                console.error('Error loading cache from disk:', error);
            }
            // If file doesn't exist, start with empty cache
            this.cache = new Map();
        }
    }

    // Save cache to disk
    async saveToDisk() {
        try {
            // Convert Map to plain object for JSON serialization
            const cacheData = Object.fromEntries(this.cache);
            
            await fs.writeFile(this.cacheFile, JSON.stringify(cacheData, null, 2));
        } catch (error) {
            console.error('Error saving cache to disk:', error);
        }
    }

    // Get cache statistics
    getStats() {
        const stats = {
            totalLocations: this.cache.size,
            locations: []
        };
        
        for (const [key, data] of this.cache.entries()) {
            const lastDate = this.getLastCachedDate(data);
            stats.locations.push({
                key,
                dataPoints: data.length,
                lastDate,
                isCurrent: this.isCacheCurrent(...key.split('_').slice(2, 4))
            });
        }
        
        return stats;
    }

    // Clear all cache
    async clearCache() {
        this.cache.clear();
        try {
            await fs.unlink(this.cacheFile);
        } catch (error) {
            // Ignore if file doesn't exist
        }
        console.log('Cache cleared');
    }
}

module.exports = CacheManager;
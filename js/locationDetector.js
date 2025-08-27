/**
 * Location detector that finds the closest available city based on user's IP location
 */
class LocationDetector {
    constructor() {
        this.availableCities = [];
        this.userLocation = null;
    }

    /**
     * Initialize with available cities from the cache mapping
     */
    async initialize() {
        try {
            const response = await fetch('cache_cities_mapping.json');
            const cityMapping = await response.json();
            
            // Convert mapping to array of cities with coordinates
            this.availableCities = Object.entries(cityMapping).map(([csvFile, cityName]) => {
                const coords = csvFile.match(/weather_hist_(-?\d+\.\d+)_(-?\d+\.\d+)\.csv/);
                if (coords) {
                    return {
                        name: cityName,
                        lat: parseFloat(coords[1]),
                        lon: parseFloat(coords[2]),
                        csvFile: csvFile
                    };
                }
                return null;
            }).filter(city => city !== null);

            console.log(`📍 Loaded ${this.availableCities.length} cities for location detection`);
        } catch (error) {
            console.error('❌ Error loading city mapping:', error);
        }
    }

    /**
     * Get user's location from IP using multiple fallback services
     */
    async getUserLocation() {
        const services = [
            {
                name: 'ipapi.co',
                url: 'https://ipapi.co/json/',
                parse: (data) => ({ lat: data.latitude, lon: data.longitude, city: data.city, country: data.country_name })
            },
            {
                name: 'ip-api.com',
                url: 'http://ip-api.com/json/',
                parse: (data) => ({ lat: data.lat, lon: data.lon, city: data.city, country: data.country })
            },
            {
                name: 'freegeoip.app',
                url: 'https://freegeoip.app/json/',
                parse: (data) => ({ lat: data.latitude, lon: data.longitude, city: data.city, country: data.country_name })
            }
        ];

        for (const service of services) {
            try {
                const controller = new AbortController();
                const timeoutId = setTimeout(() => controller.abort(), 5000);
                
                const response = await fetch(service.url, {
                    signal: controller.signal
                });
                
                clearTimeout(timeoutId);
                
                if (response.ok) {
                    const data = await response.json();
                    const location = service.parse(data);
                    
                    if (location.lat && location.lon) {
                        this.userLocation = location;
                        console.log(`🌍 Location detected: ${location.city}, ${location.country}`);
                        return location;
                    }
                }
            } catch (error) {
                continue;
            }
        }

        throw new Error('All IP geolocation services failed');
    }

    /**
     * Calculate distance between two points using Haversine formula
     * Returns distance in kilometers
     */
    calculateDistance(lat1, lon1, lat2, lon2) {
        const R = 6371; // Earth's radius in kilometers
        const dLat = this.toRadians(lat2 - lat1);
        const dLon = this.toRadians(lon2 - lon1);
        
        const a = Math.sin(dLat / 2) * Math.sin(dLat / 2) +
                  Math.cos(this.toRadians(lat1)) * Math.cos(this.toRadians(lat2)) *
                  Math.sin(dLon / 2) * Math.sin(dLon / 2);
        
        const c = 2 * Math.atan2(Math.sqrt(a), Math.sqrt(1 - a));
        return R * c;
    }

    /**
     * Convert degrees to radians
     */
    toRadians(degrees) {
        return degrees * (Math.PI / 180);
    }

    /**
     * Find the closest available city to user's location
     */
    findClosestCity(userLat, userLon) {
        if (!this.availableCities.length) {
            throw new Error('No available cities loaded');
        }

        let closestCity = null;
        let minDistance = Infinity;

        for (const city of this.availableCities) {
            const distance = this.calculateDistance(userLat, userLon, city.lat, city.lon);
            
            if (distance < minDistance) {
                minDistance = distance;
                closestCity = { ...city, distance };
            }
        }

        console.log(`🎯 Closest city: ${closestCity.name} (${Math.round(closestCity.distance)} km away)`);
        return closestCity;
    }

    /**
     * Check if user is from USA based on location data
     */
    isUserFromUSA() {
        if (!this.userLocation || !this.userLocation.country) {
            return false;
        }
        
        const country = this.userLocation.country.toLowerCase();
        return country.includes('united states') || 
               country.includes('usa') || 
               country === 'us' ||
               country === 'united states of america';
    }

    /**
     * Detect user location and find closest available city
     * Returns the closest city or null if detection fails
     */
    async detectClosestCity() {
        try {
            // Get user's location from IP
            const userLocation = await this.getUserLocation();
            
            // Find closest available city
            const closestCity = this.findClosestCity(userLocation.lat, userLocation.lon);
            
            return {
                userLocation,
                closestCity,
                distance: Math.round(closestCity.distance),
                isUSA: this.isUserFromUSA()
            };
            
        } catch (error) {
            console.error('❌ Location detection failed:', error.message);
            return null;
        }
    }

    /**
     * Get all available cities (for reference)
     */
    getAvailableCities() {
        return this.availableCities;
    }
}
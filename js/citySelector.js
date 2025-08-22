/**
 * City Selector Module
 * Handles city selection functionality for the temperature visualization app
 */
class CitySelector {
    constructor() {
        this.citySelect = document.getElementById('city-select');
        this.cities = [];
    }

    /**
     * Initialize city selector with cached cities from JSON
     * This version uses the limited cache_cities_mapping.json for alpha
     */
    async initialize() {
        try {
            const response = await fetch('cache_cities_mapping.json');
            const cityMapping = await response.json();
            
            // Extract coordinates from CSV filenames and map to city names
            this.cities = [];
            Object.entries(cityMapping).forEach(([csvFile, cityName]) => {
                const match = csvFile.match(/weather_hist_(-?\d+\.?\d*)_(-?\d+\.?\d*)\.csv/);
                if (match) {
                    this.cities.push({
                        name: cityName,
                        lat: parseFloat(match[1]),
                        lon: parseFloat(match[2])
                    });
                }
            });
            
            this.populateSelect();
            this.setDefaultCity();
            
        } catch (error) {
            console.error('Error loading city mapping:', error);
            this.showError();
        }
    }

    /**
     * Populate the select element with cities
     */
    populateSelect() {
        // Clear existing options except the first one
        this.citySelect.innerHTML = '<option value="">Select a city...</option>';
        
        // Sort cities alphabetically and populate select
        this.cities
            .sort((a, b) => a.name.localeCompare(b.name))
            .forEach(city => {
                const option = document.createElement('option');
                option.value = `${city.lat},${city.lon}`;
                option.textContent = city.name;
                this.citySelect.appendChild(option);
            });
    }

    /**
     * Set default city to Tel Aviv if available
     */
    setDefaultCity() {
        const telAvivCity = this.cities.find(city => city.name.includes('Tel Aviv'));
        if (telAvivCity) {
            this.citySelect.value = `${telAvivCity.lat},${telAvivCity.lon}`;
        }
    }

    /**
     * Show error when city loading fails
     */
    showError() {
        this.citySelect.innerHTML = '<option value="">Error loading cities</option>';
    }

    /**
     * Get current coordinates from selected city
     * @returns {Object} Object with latitude and longitude
     * @throws {Error} If no city is selected
     */
    getCurrentCoordinates() {
        const selectedValue = this.citySelect.value;
        if (!selectedValue) {
            throw new Error('Please select a city');
        }
        
        const [lat, lon] = selectedValue.split(',');
        return {
            latitude: parseFloat(lat),
            longitude: parseFloat(lon)
        };
    }

    /**
     * Get the name of the currently selected city
     * @returns {string} City name or empty string if none selected
     */
    getCurrentCityName() {
        const selectedValue = this.citySelect.value;
        if (!selectedValue) {
            return '';
        }
        
        const selectedOption = this.citySelect.options[this.citySelect.selectedIndex];
        return selectedOption.textContent;
    }

    /**
     * Add event listener for city selection changes
     * @param {Function} callback Function to call when city changes
     */
    onCityChange(callback) {
        this.citySelect.addEventListener('change', callback);
    }
}
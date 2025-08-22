/**
 * City Selector Module - Main Branch Version
 * Handles city selection functionality with full geocoding support
 */
class CitySelector {
    constructor() {
        this.cityInput = document.getElementById('city-search');
        this.suggestionsDiv = document.getElementById('city-suggestions');
        this.latInput = document.getElementById('latitude');
        this.lonInput = document.getElementById('longitude');
        this.searchTimeout = null;
        this.currentSuggestions = [];
    }

    /**
     * Initialize city selector with full geocoding functionality
     */
    async initialize() {
        // Set default city
        this.cityInput.value = 'Tel Aviv, Israel';
        
        this.setupEventListeners();
    }

    /**
     * Setup all event listeners for city search
     */
    setupEventListeners() {
        // Input event for city search
        this.cityInput.addEventListener('input', (e) => {
            const query = e.target.value.trim();
            
            if (query.length < 2) {
                this.suggestionsDiv.style.display = 'none';
                return;
            }
            
            // Debounce the search
            clearTimeout(this.searchTimeout);
            this.searchTimeout = setTimeout(() => this.searchCities(query), 300);
        });
        
        // Handle keyboard navigation
        this.cityInput.addEventListener('keydown', (e) => {
            if (e.key === 'ArrowDown' || e.key === 'ArrowUp' || e.key === 'Enter') {
                this.handleKeyboardNavigation(e);
            }
        });
        
        // Hide suggestions when clicking outside
        document.addEventListener('click', (e) => {
            if (!e.target.closest('.year-range-control')) {
                this.suggestionsDiv.style.display = 'none';
            }
        });
    }

    /**
     * Search cities using geocoding API
     * @param {string} query - Search query
     */
    async searchCities(query) {
        try {
            // Using Nominatim (OpenStreetMap) API - free and no API key required
            const response = await fetch(
                `https://nominatim.openstreetmap.org/search?format=json&addressdetails=1&limit=8&q=${encodeURIComponent(query)}&countrycodes=&featuretype=city`
            );
            
            if (!response.ok) {
                throw new Error('Search failed');
            }
            
            const results = await response.json();
            
            // Filter for cities, towns, villages
            const cities = results.filter(result => {
                const type = result.type || result.class;
                return type === 'city' || type === 'town' || type === 'village' || 
                       result.addresstype === 'city' || result.addresstype === 'town' || 
                       result.addresstype === 'village';
            });
            
            this.displaySuggestions(cities.slice(0, 6)); // Show max 6 suggestions
            
        } catch (error) {
            console.error('City search error:', error);
            this.suggestionsDiv.style.display = 'none';
        }
    }


    /**
     * Display city suggestions
     * @param {Array} cities - Array of city objects
     */
    displaySuggestions(cities) {
        this.currentSuggestions = cities;
        
        if (cities.length === 0) {
            this.suggestionsDiv.style.display = 'none';
            return;
        }
        
        this.suggestionsDiv.innerHTML = cities.map((city, index) => {
            const name = city.display_name.split(',')[0]; // Get city name
            const country = city.display_name.split(',').slice(-1)[0].trim(); // Get country
            const details = city.display_name.replace(name + ', ', '').replace(', ' + country, '');
            
            return `
                <div class="city-suggestion" data-index="${index}" onclick="citySelector.selectCity(${index})">
                    <div class="city-name">${name}</div>
                    <div class="city-details">${details}, ${country}</div>
                </div>
            `;
        }).join('');
        
        this.suggestionsDiv.style.display = 'block';
    }

    /**
     * Select a city from suggestions
     * @param {number} index - Index of the selected city
     */
    selectCity(index) {
        const city = this.currentSuggestions[index];
        
        this.cityInput.value = city.display_name;
        this.latInput.value = parseFloat(city.lat).toFixed(4);
        this.lonInput.value = parseFloat(city.lon).toFixed(4);
        
        this.suggestionsDiv.style.display = 'none';
    }

    /**
     * Handle keyboard navigation in suggestions
     * @param {Event} e - Keyboard event
     */
    handleKeyboardNavigation(e) {
        const suggestions = this.suggestionsDiv.querySelectorAll('.city-suggestion');
        
        if (suggestions.length === 0) return;
        
        let selectedIndex = Array.from(suggestions).findIndex(s => s.classList.contains('selected'));
        
        if (e.key === 'ArrowDown') {
            e.preventDefault();
            selectedIndex = selectedIndex < suggestions.length - 1 ? selectedIndex + 1 : 0;
        } else if (e.key === 'ArrowUp') {
            e.preventDefault();
            selectedIndex = selectedIndex > 0 ? selectedIndex - 1 : suggestions.length - 1;
        } else if (e.key === 'Enter') {
            e.preventDefault();
            if (selectedIndex >= 0) {
                this.selectCity(selectedIndex);
            }
            return;
        }
        
        // Update selection
        suggestions.forEach((s, i) => {
            s.classList.toggle('selected', i === selectedIndex);
            if (i === selectedIndex) {
                s.style.backgroundColor = '#e3f2fd';
            } else {
                s.style.backgroundColor = '';
            }
        });
    }

    /**
     * Get current coordinates from lat/lng inputs
     * @returns {Object} Object with latitude and longitude
     */
    getCurrentCoordinates() {
        return {
            latitude: parseFloat(this.latInput.value),
            longitude: parseFloat(this.lonInput.value)
        };
    }

    /**
     * Get the name of the currently selected city
     * @returns {string} City name from input field
     */
    getCurrentCityName() {
        return this.cityInput.value;
    }

    /**
     * Add event listener for city selection changes
     * @param {Function} callback Function to call when city changes
     */
    onCityChange(callback) {
        this.cityInput.addEventListener('input', callback);
        this.latInput.addEventListener('input', callback);
        this.lonInput.addEventListener('input', callback);
    }
}
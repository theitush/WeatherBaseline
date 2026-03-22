import React, { useState, useRef, useEffect } from 'react';
import { searchCities } from '../services/api';
import type { NominatimResult } from '../types';
import './LocationSelector.css';

interface LocationSelectorProps {
  cityName: string;
  latitude: number;
  longitude: number;
  onChange: (name: string, lat: number, lon: number) => void;
}

const LocationSelector: React.FC<LocationSelectorProps> = ({
  cityName,
  latitude,
  longitude,
  onChange,
}) => {
  const [cityInput, setCityInput] = useState(cityName);
  const [latInput, setLatInput] = useState(latitude.toFixed(4));
  const [lonInput, setLonInput] = useState(longitude.toFixed(4));
  const [suggestions, setSuggestions] = useState<NominatimResult[]>([]);
  const [showSuggestions, setShowSuggestions] = useState(false);
  const [selectedIndex, setSelectedIndex] = useState(-1);
  const searchTimeout = useRef<number | null>(null);
  const suggestionsRef = useRef<HTMLDivElement>(null);

  // Update inputs when props change
  useEffect(() => {
    setCityInput(cityName);
    setLatInput(latitude.toFixed(4));
    setLonInput(longitude.toFixed(4));
  }, [cityName, latitude, longitude]);

  // Handle city input change
  const handleCityInput = async (value: string) => {
    setCityInput(value);
    setSelectedIndex(-1);

    if (value.trim().length < 2) {
      setShowSuggestions(false);
      setSuggestions([]);
      return;
    }

    // Debounce the search
    if (searchTimeout.current) {
      clearTimeout(searchTimeout.current);
    }

    searchTimeout.current = setTimeout(async () => {
      const results = await searchCities(value);
      // Filter for cities, towns, villages
      const cities = results.filter((result) => {
        const type = result.type;
        return (
          type === 'city' ||
          type === 'town' ||
          type === 'village' ||
          type === 'administrative'
        );
      });
      setSuggestions(cities.slice(0, 6));
      setShowSuggestions(cities.length > 0);
    }, 300);
  };

  // Select a city from suggestions
  const selectCity = (city: NominatimResult) => {
    const lat = parseFloat(city.lat);
    const lon = parseFloat(city.lon);

    setCityInput(city.display_name);
    setLatInput(lat.toFixed(4));
    setLonInput(lon.toFixed(4));
    setShowSuggestions(false);
    setSuggestions([]);
    setSelectedIndex(-1);

    onChange(city.display_name, lat, lon);
  };

  // Handle keyboard navigation
  const handleKeyDown = (e: React.KeyboardEvent) => {
    if (suggestions.length === 0) return;

    if (e.key === 'ArrowDown') {
      e.preventDefault();
      setSelectedIndex((prev) => (prev < suggestions.length - 1 ? prev + 1 : 0));
    } else if (e.key === 'ArrowUp') {
      e.preventDefault();
      setSelectedIndex((prev) => (prev > 0 ? prev - 1 : suggestions.length - 1));
    } else if (e.key === 'Enter') {
      e.preventDefault();
      if (selectedIndex >= 0) {
        selectCity(suggestions[selectedIndex]);
      }
    } else if (e.key === 'Escape') {
      setShowSuggestions(false);
      setSelectedIndex(-1);
    }
  };

  // Handle lat/lon changes
  const handleLatChange = (value: string) => {
    setLatInput(value);
    const lat = parseFloat(value);
    if (!isNaN(lat)) {
      onChange(cityInput, lat, parseFloat(lonInput));
    }
  };

  const handleLonChange = (value: string) => {
    setLonInput(value);
    const lon = parseFloat(value);
    if (!isNaN(lon)) {
      onChange(cityInput, parseFloat(latInput), lon);
    }
  };

  // Close suggestions when clicking outside
  useEffect(() => {
    const handleClickOutside = (e: MouseEvent) => {
      if (suggestionsRef.current && !suggestionsRef.current.contains(e.target as Node)) {
        setShowSuggestions(false);
        setSelectedIndex(-1);
      }
    };

    document.addEventListener('click', handleClickOutside);
    return () => document.removeEventListener('click', handleClickOutside);
  }, []);

  return (
    <div className="location-selector">
      <div className="city-search-container" ref={suggestionsRef}>
        <label htmlFor="city-search">City:</label>
        <input
          type="text"
          id="city-search"
          value={cityInput}
          onChange={(e) => handleCityInput(e.target.value)}
          onKeyDown={handleKeyDown}
          placeholder="Search for a city..."
          autoComplete="off"
        />
        {showSuggestions && suggestions.length > 0 && (
          <div className="city-suggestions">
            {suggestions.map((city, index) => {
              const name = city.display_name.split(',')[0];
              const country = city.display_name.split(',').slice(-1)[0].trim();
              const details = city.display_name
                .replace(name + ', ', '')
                .replace(', ' + country, '');

              return (
                <div
                  key={index}
                  className={`city-suggestion ${index === selectedIndex ? 'selected' : ''}`}
                  onClick={() => selectCity(city)}
                  onMouseEnter={() => setSelectedIndex(index)}
                >
                  <div className="city-name">{name}</div>
                  <div className="city-details">
                    {details}, {country}
                  </div>
                </div>
              );
            })}
          </div>
        )}
      </div>

      <div className="coordinates">
        <div className="coordinate-input">
          <label htmlFor="latitude">Latitude:</label>
          <input
            type="number"
            id="latitude"
            value={latInput}
            onChange={(e) => handleLatChange(e.target.value)}
            step="0.0001"
          />
        </div>
        <div className="coordinate-input">
          <label htmlFor="longitude">Longitude:</label>
          <input
            type="number"
            id="longitude"
            value={lonInput}
            onChange={(e) => handleLonChange(e.target.value)}
            step="0.0001"
          />
        </div>
      </div>
    </div>
  );
};

export default LocationSelector;

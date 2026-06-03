import React, { useState, useRef, useEffect } from 'react';
import { searchCities } from '../services/api';
import { loadCells, snapToNearestCell, type SnappedCell } from '../services/cellIndex';
import type { NominatimResult } from '../types';
import './LocationSelector.css';

interface LocationSelectorProps {
  cityName: string;
  latitude: number;
  longitude: number;
  onChange: (name: string, lat: number, lon: number) => void;
}

/** A geocoder result paired with the curated cell it snaps to. */
interface Suggestion {
  place: NominatimResult;
  snapped: SnappedCell;
}

const LocationSelector: React.FC<LocationSelectorProps> = ({
  cityName,
  latitude,
  longitude,
  onChange,
}) => {
  const [cityInput, setCityInput] = useState(cityName);
  const [suggestions, setSuggestions] = useState<Suggestion[]>([]);
  const [showSuggestions, setShowSuggestions] = useState(false);
  const [selectedIndex, setSelectedIndex] = useState(-1);
  const searchTimeout = useRef<number | null>(null);
  const suggestionsRef = useRef<HTMLDivElement>(null);

  useEffect(() => {
    setCityInput(cityName);
  }, [cityName, latitude, longitude]);

  const handleCityInput = async (value: string) => {
    setCityInput(value);
    setSelectedIndex(-1);

    if (value.trim().length < 2) {
      setShowSuggestions(false);
      setSuggestions([]);
      return;
    }

    if (searchTimeout.current) {
      clearTimeout(searchTimeout.current);
    }

    searchTimeout.current = setTimeout(async () => {
      // Geocode anywhere, then snap each hit to the nearest cell we can serve.
      const [results, cells] = await Promise.all([searchCities(value), loadCells()]);
      const matched: Suggestion[] = [];
      for (const place of results) {
        const type = place.type;
        if (
          type !== 'city' &&
          type !== 'town' &&
          type !== 'village' &&
          type !== 'administrative'
        ) {
          continue;
        }
        const snapped = snapToNearestCell(parseFloat(place.lat), parseFloat(place.lon), cells);
        if (snapped) matched.push({ place, snapped });
        if (matched.length === 6) break;
      }
      setSuggestions(matched);
      setShowSuggestions(matched.length > 0);
    }, 300);
  };

  const selectSuggestion = (suggestion: Suggestion) => {
    const { place, snapped } = suggestion;

    setCityInput(place.display_name);
    setShowSuggestions(false);
    setSuggestions([]);
    setSelectedIndex(-1);

    // Emit the snapped CELL's coords (not the typed point) so loadCellTimeline
    // hits a built archive. The name stays the human-searched place.
    onChange(place.display_name, snapped.cell.lat, snapped.cell.lon);
  };

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
        selectSuggestion(suggestions[selectedIndex]);
      }
    } else if (e.key === 'Escape') {
      setShowSuggestions(false);
      setSelectedIndex(-1);
    }
  };

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
        <input
          type="text"
          id="city-search"
          value={cityInput}
          onChange={(e) => handleCityInput(e.target.value)}
          onKeyDown={handleKeyDown}
          placeholder="City"
          autoComplete="off"
        />
        {showSuggestions && suggestions.length > 0 && (
          <div className="city-suggestions">
            {suggestions.map((suggestion, index) => {
              const { place, snapped } = suggestion;
              const name = place.display_name.split(',')[0];
              const country = place.display_name.split(',').slice(-1)[0].trim();
              const details = place.display_name
                .replace(name + ', ', '')
                .replace(', ' + country, '');

              return (
                <div
                  key={index}
                  className={`city-suggestion ${index === selectedIndex ? 'selected' : ''}`}
                  onClick={() => selectSuggestion(suggestion)}
                  onMouseEnter={() => setSelectedIndex(index)}
                >
                  <div className="city-name">{name}</div>
                  <div className="city-details">
                    {details}, {country}
                  </div>
                  <div className="city-snap">
                    <span className="city-snap-arrow">↳</span>
                    <span className="city-snap-label">nearest data point</span>
                    <span className="city-snap-dist">{formatKm(snapped.distanceKm)}</span>
                  </div>
                </div>
              );
            })}
          </div>
        )}
      </div>
    </div>
  );
};

/** Distance read-out: whole km, or "<1 km" when the cell is essentially on top. */
function formatKm(km: number): string {
  if (km < 1) return '<1 km away';
  return `${Math.round(km)} km away`;
}

export default LocationSelector;

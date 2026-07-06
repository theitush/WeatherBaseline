import React, { useState, useRef, useEffect } from 'react';
import { searchCities } from '../services/api';
import { loadCells, snapToNearestCell, type SnappedCell } from '../services/cellIndex';
import { logSearchSelect } from '../services/tieredData';
import type { GeocodeResult } from '../types';
import { useUnits } from '../hooks/useUnits';
import { formatDistance } from '../utils/units';
import './LocationSelector.css';

interface LocationSelectorProps {
  cityName: string;
  latitude: number;
  longitude: number;
  onChange: (info: { name: string; lat: number; lon: number }) => void;
}

/** A geocoder result paired with the curated cell it snaps to. */
interface Suggestion {
  place: GeocodeResult;
  snapped: SnappedCell;
}

/**
 * Photon osm_value's we treat as "a place you'd search weather for". Covers
 * populated places (city→hamlet) and admin-area centroids; filters out streets,
 * POIs, shops, etc. that Photon also returns.
 */
const PLACE_TYPES = new Set([
  'city',
  'town',
  'village',
  'hamlet',
  'municipality',
  'administrative',
  'suburb',
]);

const LocationSelector: React.FC<LocationSelectorProps> = ({
  cityName,
  latitude,
  longitude,
  onChange,
}) => {
  const { system } = useUnits();
  const [cityInput, setCityInput] = useState(cityName);
  const [suggestions, setSuggestions] = useState<Suggestion[]>([]);
  const [showSuggestions, setShowSuggestions] = useState(false);
  const [selectedIndex, setSelectedIndex] = useState(-1);
  const searchTimeout = useRef<number | null>(null);
  const searchAbort = useRef<AbortController | null>(null);
  // The raw text that produced the currently-shown suggestions — captured so
  // selectSuggestion can log what was actually typed, not the cell name it
  // gets overwritten with on pick.
  const lastQueryRef = useRef('');
  const suggestionsRef = useRef<HTMLDivElement>(null);
  const inputRef = useRef<HTMLInputElement>(null);

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
      // Cancel any still-in-flight geocode so its late response can't clobber
      // results for the query the user is actually on now.
      searchAbort.current?.abort();
      const controller = new AbortController();
      searchAbort.current = controller;

      // Geocode anywhere, then snap each hit to the nearest cell we can serve.
      const [results, cells] = await Promise.all([
        searchCities(value, controller.signal),
        loadCells(),
      ]);
      if (controller.signal.aborted) return; // superseded by a newer keystroke
      lastQueryRef.current = value;
      // Several geocoder hits can snap to the SAME cell (e.g. two "Paris" results
      // landing on one grid point), which would show duplicate rows. De-dupe by
      // the snapped cell's coords, keeping the closest hit for each cell. Results
      // are pre-sorted by relevance, so the first hit per cell is also the one we
      // surface as "for …". (Same-named cells in different regions snap to
      // distinct coords, so this keeps them as separate rows.)
      const matched: Suggestion[] = [];
      const seenCells = new Set<string>();
      for (const place of results) {
        if (!PLACE_TYPES.has(place.type)) continue;
        const snapped = snapToNearestCell(parseFloat(place.lat), parseFloat(place.lon), cells);
        if (!snapped) continue;
        const cellKey = `${snapped.cell.lat},${snapped.cell.lon}`;
        if (seenCells.has(cellKey)) continue;
        seenCells.add(cellKey);
        matched.push({ place, snapped });
        if (matched.length === 6) break;
      }
      setSuggestions(matched);
      setShowSuggestions(matched.length > 0);
    }, 300);
  };

  // Wipe the field and any open suggestions, then refocus so the user can type a
  // fresh search straight away. Cancels any in-flight geocode so a late response
  // can't repopulate the box we just cleared. Does NOT change the loaded
  // location — clearing only resets the search input.
  const clearInput = () => {
    if (searchTimeout.current) clearTimeout(searchTimeout.current);
    searchAbort.current?.abort();
    setCityInput('');
    setSuggestions([]);
    setShowSuggestions(false);
    setSelectedIndex(-1);
    inputRef.current?.focus();
  };

  const selectSuggestion = (suggestion: Suggestion) => {
    const { place, snapped } = suggestion;

    // The chosen identity is the CELL, not the typed place: show the cell's own
    // name so people know exactly which data point they're looking at, and emit
    // the cell's grid coords (loadCellTimeline needs a built archive).
    setCityInput(snapped.cell.name);
    setShowSuggestions(false);
    setSuggestions([]);
    setSelectedIndex(-1);

    logSearchSelect({
      query: lastQueryRef.current,
      matched: place.display_name,
      servedName: snapped.cell.name,
      distanceKm: snapped.distanceKm,
    });

    onChange({
      name: snapped.cell.name,
      lat: snapped.cell.lat,
      lon: snapped.cell.lon,
    });
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
          ref={inputRef}
          type="text"
          id="city-search"
          value={cityInput}
          onChange={(e) => handleCityInput(e.target.value)}
          onKeyDown={handleKeyDown}
          placeholder="City"
          autoComplete="off"
        />
        {cityInput.length > 0 && (
          <button
            type="button"
            className="city-clear"
            aria-label="Clear search"
            onClick={clearInput}
          >
            ×
          </button>
        )}
        {showSuggestions && suggestions.length > 0 && (
          <div className="city-suggestions">
            {suggestions.map((suggestion, index) => {
              const { place, snapped } = suggestion;
              // The row's headline is the place the user searched (with its
              // distance to the data we'll actually serve); the cell that data
              // comes from appears below as context.
              const searched = place.display_name;

              return (
                <div
                  key={index}
                  className={`city-suggestion ${index === selectedIndex ? 'selected' : ''}`}
                  onClick={() => selectSuggestion(suggestion)}
                  onMouseEnter={() => setSelectedIndex(index)}
                >
                  <div className="city-suggestion-main">
                    <span className="city-name">{searched}</span>
                    <span className={`city-snap-dist ${distClass(snapped.distanceKm)}`}>
                      {formatDistance(snapped.distanceKm, system)}
                    </span>
                  </div>
                  <div className="city-details">{snapped.cell.name}</div>
                </div>
              );
            })}
          </div>
        )}
      </div>
    </div>
  );
};

/** Distance bucket → color class: green <10 km, yellow 10–20 km, red >20 km. */
function distClass(km: number): string {
  if (km < 10) return 'dist-near';
  if (km <= 20) return 'dist-mid';
  return 'dist-far';
}

export default LocationSelector;

# HowHotWasIt - React Rebuild Implementation Guide

This guide provides step-by-step instructions for rebuilding the HowHotWasIt app with React + TypeScript.

---

## Pre-flight: Git Cleanup & Backup

**IMPORTANT: Do this FIRST before touching any code.**

### Step 1: Create backup branch and archive old frontend

```bash
# Create backup branch from current state
git checkout -b vanilla-backup

# Commit current state if there are uncommitted changes
git add .
git commit -m "Backup vanilla JS version before React rebuild"

# Switch back to main
git checkout main

# Create archive folder and move old frontend files
mkdir -p old-vanilla
mv interactive_temperature.html old-vanilla/
mv js/ old-vanilla/

# Commit cleanup
git add .
git commit -m "Archive vanilla frontend, preparing for React rebuild"
```

**Result:**
- `vanilla-backup` branch preserves the entire old version
- `main` branch has old frontend files moved to `old-vanilla/`
- `server.js`, `package.json`, `node_modules/` remain untouched

---

## Phase 1: Project Setup

### Step 1: Initialize Vite React-TypeScript project

```bash
# Create new React app in a temp directory
npm create vite@latest temp-react -- --template react-ts

# Move the src files from temp into current directory
mv temp-react/src .
mv temp-react/index.html .
mv temp-react/vite.config.ts .
mv temp-react/tsconfig.json .
mv temp-react/tsconfig.node.json .

# Merge package.json dependencies (manual step - see below)
# Clean up temp directory
rm -rf temp-react
```

**Manual package.json merge:**
Add these to your existing `package.json`:

```json
{
  "name": "how-hot-was-it",
  "version": "2.0.0",
  "type": "module",
  "scripts": {
    "dev": "vite",
    "build": "tsc && vite build",
    "preview": "vite preview",
    "server": "node server.js",
    "start": "concurrently \"npm run server\" \"npm run dev\""
  },
  "dependencies": {
    "react": "^18.3.1",
    "react-dom": "^18.3.1",
    "d3": "^7.9.0",
    "date-fns": "^3.6.0",
    "express": "^4.21.2",
    "cors": "^2.8.5",
    "node-fetch": "^2.7.0"
  },
  "devDependencies": {
    "@types/react": "^18.3.0",
    "@types/react-dom": "^18.3.0",
    "@types/d3": "^7.4.3",
    "@vitejs/plugin-react": "^4.3.0",
    "typescript": "^5.5.3",
    "vite": "^5.4.0",
    "concurrently": "^9.1.0"
  }
}
```

### Step 2: Install dependencies

```bash
npm install
```

### Step 3: Configure Vite proxy

Edit `vite.config.ts`:

```typescript
import { defineConfig } from 'vite'
import react from '@vitejs/plugin-react'

export default defineConfig({
  plugins: [react()],
  server: {
    proxy: {
      '/api': 'http://localhost:3000'
    }
  }
})
```

### Step 4: Create folder structure

```bash
mkdir -p src/components/charts
mkdir -p src/hooks
mkdir -p src/services
mkdir -p src/types
mkdir -p src/utils
```

### Step 5: Commit initial setup

```bash
git add .
git commit -m "Initialize React + TypeScript project with Vite"
```

---

## Phase 2: Data Layer

### Step 1: Create TypeScript types

**File: `src/types/weather.ts`**

```typescript
export interface WeatherDataPoint {
  date: Date;
  year: number;
  data_type: 'historical' | 'forecast';
  max_temperature?: number;
  min_temperature?: number;
}

export interface YearlyAggregate {
  year: number;
  date: Date;
  p10: number;
  p25: number;
  p50: number;  // median
  p75: number;
  p90: number;
  movingMedian: number | null;
  moving10: number | null;
  moving25: number | null;
  moving75: number | null;
  moving90: number | null;
}

export interface TemperatureContext {
  percentile: string;      // "12th percentile"
  description: string;     // "A bit warm for the season"
  ranking?: string;        // "3rd hottest in dataset!"
}

export type MetricType = 'max_temperature' | 'min_temperature';

export interface City {
  name: string;
  lat: number;
  lon: number;
}
```

**File: `src/types/api.ts`**

```typescript
export interface WeatherApiResponse {
  latitude: number;
  longitude: number;
  daily: {
    time: string[];
    apparent_temperature_max: number[];
    apparent_temperature_min: number[];
  };
  _cacheStatus?: 'HIT' | 'MISS_PARTIAL' | 'MISS_EMPTY';
  _dataSource?: 'CACHE' | 'API+CACHE' | 'API';
  _cachedRecords?: number;
}

export interface NominatimResult {
  place_id: number;
  display_name: string;
  lat: string;
  lon: string;
  address?: {
    city?: string;
    country?: string;
  };
}
```

### Step 2: Port config.ts

**File: `src/services/config.ts`**

Port the entire `old-vanilla/js/config.js` file, converting to TypeScript:

```typescript
interface MetricColor {
  base: string;
  name: string;
}

interface ActiveMetrics {
  max_temperature: boolean;
  min_temperature: boolean;
  precipitation_sum: boolean;
  wind_speed_10m_max: boolean;
}

export const CONFIG = {
  ACTIVE_METRICS: {
    max_temperature: true,
    min_temperature: true,
    precipitation_sum: false,
    wind_speed_10m_max: false
  } as ActiveMetrics,

  mainMargin: { top: 20, right: 30, bottom: 40, left: 50 },
  histMargin: { top: 20, right: 100, bottom: 40, left: 15 },

  get mainWidth() { return 800 - this.mainMargin.left - this.mainMargin.right; },
  get mainHeight() { return 400 - this.mainMargin.top - this.mainMargin.bottom; },
  get histWidth() { return 300 - this.histMargin.left - this.histMargin.right; },
  get histHeight() { return 400 - this.histMargin.top - this.histMargin.bottom; },

  metricColors: {
    max_temperature: { base: '#FF8C42', name: 'Orange' },
    min_temperature: { base: '#4A90E2', name: 'Blue' },
    precipitation_sum: { base: '#B19CD9', name: 'Pastel Purple' },
    wind_speed_10m_max: { base: '#A8D8A8', name: 'Pastel Green' }
  } as Record<string, MetricColor>,

  opacityLevels: {
    trendLine: 1.0,
    percentileBand90: 0.5,
    percentileBand75: 0.7,
    dataPoints: 0.2,
    histogramBars: 0.7
  },

  getColorForElement(metric: string, elementType: string): string {
    const baseColor = this.metricColors[metric]?.base;
    const opacity = this.opacityLevels[elementType as keyof typeof this.opacityLevels];

    if (!baseColor || opacity === undefined) {
      console.warn(`Invalid metric "${metric}" or element type "${elementType}"`);
      return baseColor || '#000000';
    }

    if (opacity === 1.0) {
      return baseColor;
    }

    return this.hexToRgba(baseColor, opacity);
  },

  hexToRgba(hex: string, opacity: number): string {
    hex = hex.replace('#', '');
    const r = parseInt(hex.substring(0, 2), 16);
    const g = parseInt(hex.substring(2, 4), 16);
    const b = parseInt(hex.substring(4, 6), 16);
    return `rgba(${r}, ${g}, ${b}, ${opacity})`;
  },

  animations: {
    fadeOut: 250,
    fadeIn: 250,
    transition: 500
  },

  chart: {
    windowSize: 5,
    histogramThresholds: 30,
    tempMargin: 2
  },

  getActiveMetrics(): string[] {
    return Object.keys(this.ACTIVE_METRICS).filter(
      (metric) => this.ACTIVE_METRICS[metric as keyof ActiveMetrics]
    );
  },

  getActiveMetricsApiString(): string {
    const metricMap: Record<string, string> = {
      max_temperature: 'apparent_temperature_max',
      min_temperature: 'apparent_temperature_min',
      precipitation_sum: 'precipitation_sum',
      wind_speed_10m_max: 'wind_speed_10m_max'
    };

    return this.getActiveMetrics()
      .map((metric) => metricMap[metric])
      .join(',');
  },

  isMetricActive(metric: string): boolean {
    return this.ACTIVE_METRICS[metric as keyof ActiveMetrics] === true;
  }
};
```

### Step 3: Create API service

**File: `src/services/api.ts`**

```typescript
import { WeatherApiResponse, NominatimResult } from '../types/api';
import { WeatherDataPoint } from '../types/weather';
import { CONFIG } from './config';

class ApiService {
  private baseUrl = '/api';

  async getWeatherHistory(
    latitude: number,
    longitude: number,
    targetDate: Date,
    startYear: number = 1940,
    daysRange: number = 7
  ): Promise<WeatherDataPoint[]> {
    // Calculate date range (±7 days from target date)
    const targetMonth = targetDate.getMonth() + 1; // JS months are 0-indexed
    const targetDay = targetDate.getDate();

    const startDate = new Date(targetDate);
    startDate.setDate(startDate.getDate() - daysRange);

    const endDate = new Date(targetDate);
    endDate.setDate(endDate.getDate() + daysRange);

    // Format dates as YYYY-MM-DD
    const formatDate = (date: Date) => {
      const year = startYear; // Start from historical beginning
      const month = String(date.getMonth() + 1).padStart(2, '0');
      const day = String(date.getDate()).padStart(2, '0');
      return `${year}-${month}-${day}`;
    };

    const currentYear = new Date().getFullYear();
    const endYear = currentYear;

    const params = new URLSearchParams({
      latitude: latitude.toString(),
      longitude: longitude.toString(),
      start_date: formatDate(startDate),
      end_date: `${endYear}-${String(endDate.getMonth() + 1).padStart(2, '0')}-${String(endDate.getDate()).padStart(2, '0')}`,
      daily: CONFIG.getActiveMetricsApiString(),
      timezone: 'auto'
    });

    const response = await fetch(`${this.baseUrl}/archive?${params}`);

    if (!response.ok) {
      const errorData = await response.json();
      throw new Error(errorData.message || 'Failed to fetch weather data');
    }

    const data: WeatherApiResponse = await response.json();
    return this.transformApiResponse(data);
  }

  private transformApiResponse(apiData: WeatherApiResponse): WeatherDataPoint[] {
    const dataPoints: WeatherDataPoint[] = [];

    if (!apiData.daily || !apiData.daily.time) {
      return dataPoints;
    }

    const { time, apparent_temperature_max, apparent_temperature_min } = apiData.daily;

    for (let i = 0; i < time.length; i++) {
      const date = new Date(time[i]);
      const year = date.getFullYear();

      dataPoints.push({
        date,
        year,
        data_type: 'historical',
        max_temperature: apparent_temperature_max?.[i],
        min_temperature: apparent_temperature_min?.[i]
      });
    }

    return dataPoints;
  }

  async searchCity(query: string): Promise<NominatimResult[]> {
    const params = new URLSearchParams({
      q: query,
      format: 'json',
      limit: '5'
    });

    const response = await fetch(
      `https://nominatim.openstreetmap.org/search?${params}`,
      {
        headers: {
          'User-Agent': 'HowHotWasIt/2.0'
        }
      }
    );

    if (!response.ok) {
      throw new Error('Failed to search cities');
    }

    return response.json();
  }
}

export const api = new ApiService();
```

### Step 4: Port dataProcessor.ts

**File: `src/services/dataProcessor.ts`**

Port the entire `old-vanilla/js/dataProcessor.js` file. Key sections:

```typescript
import * as d3 from 'd3';
import { WeatherDataPoint, YearlyAggregate, TemperatureContext, MetricType } from '../types/weather';
import { CONFIG } from './config';

export class DataProcessor {
  private fullData: WeatherDataPoint[] = [];
  private filteredData: WeatherDataPoint[] = [];
  private fullYearlyAggregates: YearlyAggregate[] = [];
  private yearlyAggregates: YearlyAggregate[] = [];
  private availableYears: number[] = [];
  private currentDate: string = new Date().toISOString().split('T')[0];
  private currentMetric: MetricType = 'max_temperature';

  setFullData(data: WeatherDataPoint[]) {
    this.fullData = data;
    this.availableYears = [...new Set(data.map(d => d.year))].sort();
    this.fullYearlyAggregates = this.calculateYearlyAggregates(this.fullData);
  }

  setCurrentDate(date: string) {
    this.currentDate = date;
  }

  setCurrentMetric(metric: MetricType) {
    if (!CONFIG.isMetricActive(metric)) {
      console.warn(`Cannot set metric ${metric} - it is not active`);
      return;
    }
    this.currentMetric = metric;
    if (this.fullData.length > 0) {
      this.fullYearlyAggregates = this.calculateYearlyAggregates(this.fullData);
    }
  }

  calculateYearlyAggregates(data: WeatherDataPoint[]): YearlyAggregate[] {
    if (!data || data.length === 0) {
      return [];
    }

    if (!CONFIG.isMetricActive(this.currentMetric)) {
      return [];
    }

    const yearGroups = d3.group(data, d => d.year);
    const aggregates: YearlyAggregate[] = [];

    yearGroups.forEach((values, year) => {
      const metricValues = values
        .map(d => d[this.currentMetric])
        .filter(v => v !== null && v !== undefined) as number[];

      if (metricValues.length === 0) return;

      const temps = metricValues.sort(d3.ascending);
      const targetDate = new Date(year, new Date(this.currentDate).getMonth(), new Date(this.currentDate).getDate());

      aggregates.push({
        year,
        date: targetDate,
        p10: d3.quantile(temps, 0.10)!,
        p25: d3.quantile(temps, 0.25)!,
        p50: d3.quantile(temps, 0.50)!,
        p75: d3.quantile(temps, 0.75)!,
        p90: d3.quantile(temps, 0.90)!,
        movingMedian: null,
        moving10: null,
        moving25: null,
        moving75: null,
        moving90: null
      });
    });

    // Calculate moving averages (±2 years window)
    aggregates.sort((a, b) => a.year - b.year);
    const windowRadius = 2;

    aggregates.forEach((d, i) => {
      if (i >= windowRadius && i < aggregates.length - windowRadius) {
        const start = i - windowRadius;
        const end = i + windowRadius + 1;
        const window = aggregates.slice(start, end);

        d.movingMedian = d3.median(window, d => d.p50)!;
        d.moving10 = d3.median(window, d => d.p10)!;
        d.moving25 = d3.median(window, d => d.p25)!;
        d.moving75 = d3.median(window, d => d.p75)!;
        d.moving90 = d3.median(window, d => d.p90)!;
      }
    });

    return aggregates;
  }

  calculateTemperaturePercentile(currentTemp: number, data: WeatherDataPoint[]): number {
    const higherCount = data.filter(d => (d[this.currentMetric] ?? 0) > currentTemp).length;
    return (higherCount / data.length) * 100;
  }

  generateTemperatureContext(currentTemp: number, data: WeatherDataPoint[]): TemperatureContext | null {
    if (!currentTemp || !data || data.length === 0) return null;

    const percentile = this.calculateTemperaturePercentile(currentTemp, data);
    const percentileFromBottom = 100 - percentile;

    const allTemps = data
      .map(d => d[this.currentMetric])
      .filter(t => t !== null && t !== undefined)
      .sort((a, b) => (a as number) - (b as number)) as number[];
    const totalCount = allTemps.length;

    const rankingFromColdest = allTemps.findIndex(temp => temp >= currentTemp) + 1;
    const rankingFromHottest = totalCount - allTemps.lastIndexOf(currentTemp);

    // Phrase arrays (ported from original)
    const normalPhrases = ["Pretty typical", "Normal range", "Average temp", "Nothing unusual"];
    const coolPhrases = ["A bit cool", "Slightly chilly", "Cooler side", "Touch below normal"];
    const warmPhrases = ["A bit warm", "Slightly toasty", "Warmer side", "Touch above normal"];
    const coldPhrases = ["Unusually cold", "Quite chilly", "Pretty frigid", "Really cool"];
    const hotPhrases = ["Unusually hot", "Quite toasty", "Pretty scorching", "Really warm"];
    const extremeColdPhrases = ["Exceptionally frigid!", "Bone-chilling!", "Historic freeze!"];
    const extremeHotPhrases = ["Scorching rare heat!", "Blazing anomaly!", "Infernal heat!"];

    const getRandomPhrase = (arr: string[]) => {
      const phrase = arr[Math.floor(Math.random() * arr.length)];
      if (arr === extremeColdPhrases || arr === extremeHotPhrases) {
        return phrase + " (for the season)";
      } else if (arr !== normalPhrases) {
        return phrase + " for the season";
      }
      return phrase;
    };

    const context: TemperatureContext = {
      percentile: '',
      description: ''
    };

    if (percentileFromBottom <= 5) {
      context.percentile = `${percentileFromBottom.toFixed(0)}th percentile`;
      context.description = getRandomPhrase(extremeColdPhrases);
      context.ranking = `${rankingFromColdest}${this.getOrdinalSuffix(rankingFromColdest)} coldest in dataset!`;
    } else if (percentile <= 5) {
      context.percentile = `${percentile.toFixed(0)}th percentile`;
      context.description = getRandomPhrase(extremeHotPhrases);
      context.ranking = `${rankingFromHottest}${this.getOrdinalSuffix(rankingFromHottest)} hottest in dataset!`;
    } else if (percentileFromBottom <= 10) {
      context.percentile = `${percentileFromBottom.toFixed(0)}th percentile`;
      context.description = getRandomPhrase(coldPhrases);
    } else if (percentile <= 10) {
      context.percentile = `${percentile.toFixed(0)}th percentile`;
      context.description = getRandomPhrase(hotPhrases);
    } else if (percentileFromBottom <= 20) {
      context.percentile = `${percentileFromBottom.toFixed(0)}th percentile`;
      context.description = getRandomPhrase(coolPhrases);
    } else if (percentile <= 20) {
      context.percentile = `${percentile.toFixed(0)}th percentile`;
      context.description = getRandomPhrase(warmPhrases);
    } else {
      context.percentile = `${Math.min(percentile, percentileFromBottom).toFixed(0)}th percentile`;
      context.description = getRandomPhrase(normalPhrases);
    }

    return context;
  }

  private getOrdinalSuffix(num: number): string {
    const j = num % 10;
    const k = num % 100;
    if (j === 1 && k !== 11) return "st";
    if (j === 2 && k !== 12) return "nd";
    if (j === 3 && k !== 13) return "rd";
    return "th";
  }

  getYearlyAggregates(): YearlyAggregate[] {
    return this.fullYearlyAggregates;
  }

  getFullData(): WeatherDataPoint[] {
    return this.fullData;
  }
}
```

### Step 5: Create utility helpers

**File: `src/utils/dateHelpers.ts`**

```typescript
import { format, addDays, subDays } from 'date-fns';

export const formatDate = (date: Date): string => {
  return format(date, 'yyyy-MM-dd');
};

export const getDateRange = (targetDate: Date, daysRange: number = 7) => {
  return {
    startDate: subDays(targetDate, daysRange),
    endDate: addDays(targetDate, daysRange)
  };
};
```

**File: `src/hooks/useDebounce.ts`**

```typescript
import { useState, useEffect } from 'react';

export function useDebounce<T>(value: T, delay: number = 500): T {
  const [debouncedValue, setDebouncedValue] = useState<T>(value);

  useEffect(() => {
    const handler = setTimeout(() => {
      setDebouncedValue(value);
    }, delay);

    return () => {
      clearTimeout(handler);
    };
  }, [value, delay]);

  return debouncedValue;
}
```

### Step 6: Create data fetching hooks

**File: `src/hooks/useWeatherData.ts`**

```typescript
import { useState, useEffect } from 'react';
import { WeatherDataPoint, YearlyAggregate, MetricType, City } from '../types/weather';
import { api } from '../services/api';
import { DataProcessor } from '../services/dataProcessor';

export function useWeatherData(
  city: City | null,
  date: Date,
  metric: MetricType
) {
  const [data, setData] = useState<WeatherDataPoint[]>([]);
  const [aggregates, setAggregates] = useState<YearlyAggregate[]>([]);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<Error | null>(null);

  useEffect(() => {
    if (!city) {
      setData([]);
      setAggregates([]);
      return;
    }

    const fetchData = async () => {
      setLoading(true);
      setError(null);

      try {
        const result = await api.getWeatherHistory(
          city.lat,
          city.lon,
          date,
          1940,
          7
        );

        const processor = new DataProcessor();
        processor.setFullData(result);
        processor.setCurrentDate(date.toISOString().split('T')[0]);
        processor.setCurrentMetric(metric);

        const aggs = processor.getYearlyAggregates();

        setData(result);
        setAggregates(aggs);
      } catch (err) {
        setError(err as Error);
        console.error('Failed to fetch weather data:', err);
      } finally {
        setLoading(false);
      }
    };

    fetchData();
  }, [city, date, metric]);

  return { data, aggregates, loading, error };
}
```

**File: `src/hooks/useCitySearch.ts`**

```typescript
import { useState, useEffect } from 'react';
import { api } from '../services/api';
import { NominatimResult } from '../types/api';
import { useDebounce } from './useDebounce';

export function useCitySearch(query: string) {
  const [results, setResults] = useState<NominatimResult[]>([]);
  const [loading, setLoading] = useState(false);
  const debouncedQuery = useDebounce(query, 500);

  useEffect(() => {
    if (!debouncedQuery || debouncedQuery.length < 2) {
      setResults([]);
      return;
    }

    const search = async () => {
      setLoading(true);
      try {
        const data = await api.searchCity(debouncedQuery);
        setResults(data);
      } catch (err) {
        console.error('City search failed:', err);
        setResults([]);
      } finally {
        setLoading(false);
      }
    };

    search();
  }, [debouncedQuery]);

  return { results, loading };
}
```

### Step 7: Commit data layer

```bash
git add .
git commit -m "Add data layer: types, API service, dataProcessor, hooks"
```

---

## Phase 3: Core Components

### Step 1: Create basic layout components

**File: `src/components/LoadingState.tsx`**

```typescript
import React from 'react';

export const LoadingState: React.FC = () => {
  return (
    <div style={{ padding: '2rem', textAlign: 'center' }}>
      <p>Loading weather data...</p>
    </div>
  );
};
```

**File: `src/components/Header.tsx`**

```typescript
import React from 'react';

interface HeaderProps {
  children: React.ReactNode;
}

export const Header: React.FC<HeaderProps> = ({ children }) => {
  return (
    <header style={{ padding: '1rem', borderBottom: '1px solid #ddd' }}>
      <h1>How Hot Was It?</h1>
      <div style={{ display: 'flex', gap: '1rem', marginTop: '1rem' }}>
        {children}
      </div>
    </header>
  );
};
```

### Step 2: Create control components

**File: `src/components/CitySearch.tsx`**

```typescript
import React, { useState } from 'react';
import { useCitySearch } from '../hooks/useCitySearch';
import { City } from '../types/weather';

interface CitySearchProps {
  onCitySelect: (city: City) => void;
}

export const CitySearch: React.FC<CitySearchProps> = ({ onCitySelect }) => {
  const [query, setQuery] = useState('');
  const [showDropdown, setShowDropdown] = useState(false);
  const { results, loading } = useCitySearch(query);

  const handleSelect = (result: any) => {
    const city: City = {
      name: result.display_name,
      lat: parseFloat(result.lat),
      lon: parseFloat(result.lon)
    };
    onCitySelect(city);
    setQuery(result.display_name);
    setShowDropdown(false);
  };

  return (
    <div style={{ position: 'relative' }}>
      <input
        type="text"
        value={query}
        onChange={(e) => {
          setQuery(e.target.value);
          setShowDropdown(true);
        }}
        placeholder="Search for a city..."
        style={{ padding: '0.5rem', width: '300px' }}
      />
      {showDropdown && results.length > 0 && (
        <ul
          style={{
            position: 'absolute',
            top: '100%',
            left: 0,
            right: 0,
            background: 'white',
            border: '1px solid #ddd',
            listStyle: 'none',
            padding: 0,
            margin: 0,
            maxHeight: '200px',
            overflow: 'auto',
            zIndex: 1000
          }}
        >
          {results.map((result) => (
            <li
              key={result.place_id}
              onClick={() => handleSelect(result)}
              style={{
                padding: '0.5rem',
                cursor: 'pointer',
                borderBottom: '1px solid #eee'
              }}
            >
              {result.display_name}
            </li>
          ))}
        </ul>
      )}
      {loading && <span style={{ marginLeft: '0.5rem' }}>Searching...</span>}
    </div>
  );
};
```

**File: `src/components/DatePicker.tsx`**

```typescript
import React from 'react';
import { formatDate } from '../utils/dateHelpers';

interface DatePickerProps {
  value: Date;
  onChange: (date: Date) => void;
}

export const DatePicker: React.FC<DatePickerProps> = ({ value, onChange }) => {
  const handleChange = (e: React.ChangeEvent<HTMLInputElement>) => {
    const newDate = new Date(e.target.value);
    onChange(newDate);
  };

  return (
    <input
      type="date"
      value={formatDate(value)}
      onChange={handleChange}
      style={{ padding: '0.5rem' }}
    />
  );
};
```

**File: `src/components/MetricToggle.tsx`**

```typescript
import React from 'react';
import { MetricType } from '../types/weather';

interface MetricToggleProps {
  value: MetricType;
  onChange: (metric: MetricType) => void;
}

export const MetricToggle: React.FC<MetricToggleProps> = ({ value, onChange }) => {
  return (
    <div>
      <label style={{ marginRight: '1rem' }}>
        <input
          type="radio"
          value="max_temperature"
          checked={value === 'max_temperature'}
          onChange={(e) => onChange(e.target.value as MetricType)}
        />
        Max Temperature
      </label>
      <label>
        <input
          type="radio"
          value="min_temperature"
          checked={value === 'min_temperature'}
          onChange={(e) => onChange(e.target.value as MetricType)}
        />
        Min Temperature
      </label>
    </div>
  );
};
```

### Step 3: Create stats panel

**File: `src/components/StatsPanel.tsx`**

```typescript
import React from 'react';
import { TemperatureContext } from '../types/weather';

interface StatsPanelProps {
  context: TemperatureContext | null;
}

export const StatsPanel: React.FC<StatsPanelProps> = ({ context }) => {
  if (!context) return null;

  return (
    <div style={{ padding: '1rem', background: '#f5f5f5', borderRadius: '4px' }}>
      <h3>{context.description}</h3>
      <p>{context.percentile}</p>
      {context.ranking && <p>{context.ranking}</p>}
    </div>
  );
};
```

### Step 4: Commit core components

```bash
git add .
git commit -m "Add core UI components: Header, CitySearch, DatePicker, MetricToggle, StatsPanel"
```

---

## Phase 4: D3 Chart Components

### Step 1: Create TimeSeriesChart

**File: `src/components/charts/TimeSeriesChart.tsx`**

This is a complex file. Key structure:

```typescript
import React, { useEffect, useRef } from 'react';
import * as d3 from 'd3';
import { WeatherDataPoint, YearlyAggregate, MetricType } from '../../types/weather';
import { CONFIG } from '../../services/config';

interface TimeSeriesChartProps {
  data: WeatherDataPoint[];
  aggregates: YearlyAggregate[];
  selectedDate: Date;
  metric: MetricType;
}

export const TimeSeriesChart: React.FC<TimeSeriesChartProps> = ({
  data,
  aggregates,
  selectedDate,
  metric
}) => {
  const svgRef = useRef<SVGSVGElement>(null);

  useEffect(() => {
    if (!svgRef.current || data.length === 0 || aggregates.length === 0) return;

    // Clear previous chart
    d3.select(svgRef.current).selectAll('*').remove();

    const margin = CONFIG.mainMargin;
    const width = CONFIG.mainWidth;
    const height = CONFIG.mainHeight;

    const svg = d3.select(svgRef.current)
      .attr('width', width + margin.left + margin.right)
      .attr('height', height + margin.top + margin.bottom)
      .append('g')
      .attr('transform', `translate(${margin.left},${margin.top})`);

    // Scales
    const xScale = d3.scaleLinear()
      .domain(d3.extent(aggregates, d => d.year) as [number, number])
      .range([0, width]);

    const tempExtent = d3.extent(data, d => d[metric] ?? 0) as [number, number];
    const yScale = d3.scaleLinear()
      .domain(tempExtent)
      .range([height, 0]);

    // Axes
    svg.append('g')
      .attr('transform', `translate(0,${height})`)
      .call(d3.axisBottom(xScale).tickFormat(d3.format('d')));

    svg.append('g')
      .call(d3.axisLeft(yScale));

    // Percentile bands (90th)
    const band90 = d3.area<YearlyAggregate>()
      .defined(d => d.moving10 !== null && d.moving90 !== null)
      .x(d => xScale(d.year))
      .y0(d => yScale(d.moving10!))
      .y1(d => yScale(d.moving90!));

    svg.append('path')
      .datum(aggregates)
      .attr('fill', CONFIG.getColorForElement(metric, 'percentileBand90'))
      .attr('d', band90);

    // Percentile bands (75th)
    const band75 = d3.area<YearlyAggregate>()
      .defined(d => d.moving25 !== null && d.moving75 !== null)
      .x(d => xScale(d.year))
      .y0(d => yScale(d.moving25!))
      .y1(d => yScale(d.moving75!));

    svg.append('path')
      .datum(aggregates)
      .attr('fill', CONFIG.getColorForElement(metric, 'percentileBand75'))
      .attr('d', band75);

    // Median trend line
    const line = d3.line<YearlyAggregate>()
      .defined(d => d.movingMedian !== null)
      .x(d => xScale(d.year))
      .y(d => yScale(d.movingMedian!));

    svg.append('path')
      .datum(aggregates)
      .attr('fill', 'none')
      .attr('stroke', CONFIG.getColorForElement(metric, 'trendLine'))
      .attr('stroke-width', 2)
      .attr('d', line);

    // Scatter points
    svg.selectAll('circle')
      .data(data)
      .join('circle')
      .attr('cx', d => xScale(d.year))
      .attr('cy', d => yScale(d[metric] ?? 0))
      .attr('r', 2)
      .attr('fill', CONFIG.getColorForElement(metric, 'dataPoints'));

  }, [data, aggregates, selectedDate, metric]);

  return <svg ref={svgRef}></svg>;
};
```

### Step 2: Create HistogramChart

**File: `src/components/charts/HistogramChart.tsx`**

```typescript
import React, { useEffect, useRef } from 'react';
import * as d3 from 'd3';
import { WeatherDataPoint, MetricType } from '../../types/weather';
import { CONFIG } from '../../services/config';

interface HistogramChartProps {
  data: WeatherDataPoint[];
  selectedTemp: number | null;
  metric: MetricType;
}

export const HistogramChart: React.FC<HistogramChartProps> = ({
  data,
  selectedTemp,
  metric
}) => {
  const svgRef = useRef<SVGSVGElement>(null);

  useEffect(() => {
    if (!svgRef.current || data.length === 0) return;

    d3.select(svgRef.current).selectAll('*').remove();

    const margin = CONFIG.histMargin;
    const width = CONFIG.histWidth;
    const height = CONFIG.histHeight;

    const svg = d3.select(svgRef.current)
      .attr('width', width + margin.left + margin.right)
      .attr('height', height + margin.top + margin.bottom)
      .append('g')
      .attr('transform', `translate(${margin.left},${margin.top})`);

    const temps = data.map(d => d[metric] ?? 0);
    const tempExtent = d3.extent(temps) as [number, number];

    const yScale = d3.scaleLinear()
      .domain(tempExtent)
      .range([height, 0]);

    const histogram = d3.bin<number, number>()
      .domain(yScale.domain() as [number, number])
      .thresholds(CONFIG.chart.histogramThresholds);

    const bins = histogram(temps);

    const xScale = d3.scaleLinear()
      .domain([0, d3.max(bins, d => d.length) ?? 0])
      .range([0, width]);

    // Axes
    svg.append('g')
      .attr('transform', `translate(0,${height})`)
      .call(d3.axisBottom(xScale));

    svg.append('g')
      .call(d3.axisLeft(yScale));

    // Histogram bars
    svg.selectAll('rect')
      .data(bins)
      .join('rect')
      .attr('x', 0)
      .attr('y', d => yScale(d.x1 ?? 0))
      .attr('width', d => xScale(d.length))
      .attr('height', d => yScale(d.x0 ?? 0) - yScale(d.x1 ?? 0))
      .attr('fill', CONFIG.getColorForElement(metric, 'histogramBars'));

    // Selected temp marker
    if (selectedTemp !== null) {
      svg.append('line')
        .attr('x1', 0)
        .attr('x2', width)
        .attr('y1', yScale(selectedTemp))
        .attr('y2', yScale(selectedTemp))
        .attr('stroke', 'red')
        .attr('stroke-width', 2);
    }

  }, [data, selectedTemp, metric]);

  return <svg ref={svgRef}></svg>;
};
```

### Step 3: Commit chart components

```bash
git add .
git commit -m "Add D3 chart components: TimeSeriesChart, HistogramChart"
```

---

## Phase 5: Main App Component

**File: `src/components/App.tsx`**

```typescript
import React, { useState } from 'react';
import { Header } from './Header';
import { CitySearch } from './CitySearch';
import { DatePicker } from './DatePicker';
import { MetricToggle } from './MetricToggle';
import { LoadingState } from './LoadingState';
import { StatsPanel } from './StatsPanel';
import { TimeSeriesChart } from './charts/TimeSeriesChart';
import { HistogramChart } from './charts/HistogramChart';
import { useWeatherData } from '../hooks/useWeatherData';
import { City, MetricType } from '../types/weather';
import { DataProcessor } from '../services/dataProcessor';
import styles from './App.module.css';

export const App: React.FC = () => {
  const [city, setCity] = useState<City | null>(null);
  const [selectedDate, setSelectedDate] = useState<Date>(new Date());
  const [metric, setMetric] = useState<MetricType>('max_temperature');

  const { data, aggregates, loading, error } = useWeatherData(city, selectedDate, metric);

  // Calculate context
  const context = React.useMemo(() => {
    if (!data.length || !city) return null;

    const processor = new DataProcessor();
    processor.setFullData(data);
    processor.setCurrentDate(selectedDate.toISOString().split('T')[0]);
    processor.setCurrentMetric(metric);

    const currentDayData = data.find(
      d => d.date.toDateString() === selectedDate.toDateString()
    );

    if (!currentDayData || !currentDayData[metric]) return null;

    return processor.generateTemperatureContext(currentDayData[metric]!, data);
  }, [data, selectedDate, metric, city]);

  return (
    <div className={styles.app}>
      <Header>
        <CitySearch onCitySelect={setCity} />
        <DatePicker value={selectedDate} onChange={setSelectedDate} />
        <MetricToggle value={metric} onChange={setMetric} />
      </Header>

      {loading && <LoadingState />}
      {error && <div>Error: {error.message}</div>}

      {city && data.length > 0 && (
        <>
          <main className={styles.chartsContainer}>
            <TimeSeriesChart
              data={data}
              aggregates={aggregates}
              selectedDate={selectedDate}
              metric={metric}
            />
            <HistogramChart
              data={data}
              selectedTemp={
                data.find(d => d.date.toDateString() === selectedDate.toDateString())?.[metric] ?? null
              }
              metric={metric}
            />
          </main>
          <StatsPanel context={context} />
        </>
      )}
    </div>
  );
};
```

**File: `src/components/App.module.css`**

```css
.app {
  min-height: 100vh;
  background: var(--color-bg);
}

.chartsContainer {
  display: grid;
  grid-template-columns: 2fr 1fr;
  gap: 2rem;
  padding: 1rem;
  max-width: 1400px;
  margin: 0 auto;
}

@media (max-width: 768px) {
  .chartsContainer {
    grid-template-columns: 1fr;
  }
}
```

**File: `src/main.tsx`**

```typescript
import React from 'react';
import ReactDOM from 'react-dom/client';
import { App } from './components/App';
import './index.css';

ReactDOM.createRoot(document.getElementById('root')!).render(
  <React.StrictMode>
    <App />
  </React.StrictMode>
);
```

**File: `src/index.css`**

```css
:root {
  --color-primary: #4A90E2;
  --color-secondary: #FF8C42;
  --color-text: #333;
  --color-bg: #fafafa;
  --spacing-sm: 0.5rem;
  --spacing-md: 1rem;
  --spacing-lg: 2rem;
  --breakpoint-tablet: 768px;
  --breakpoint-desktop: 1024px;
}

* {
  box-sizing: border-box;
}

body {
  margin: 0;
  font-family: -apple-system, BlinkMacSystemFont, 'Segoe UI', 'Roboto', 'Oxygen', sans-serif;
  background: var(--color-bg);
  color: var(--color-text);
  -webkit-font-smoothing: antialiased;
  -moz-osx-font-smoothing: grayscale;
}

h1, h2, h3, h4, h5, h6 {
  margin: 0;
  font-weight: 600;
}
```

---

## Phase 6: Testing & Launch

### Step 1: Start the development servers

```bash
# In one terminal - start backend
npm run server

# In another terminal - start Vite dev server
npm run dev
```

### Step 2: Test all functionality

Open http://localhost:5173 and verify:

- [ ] City search works
- [ ] Date picker updates charts
- [ ] Metric toggle switches between max/min
- [ ] Charts render correctly
- [ ] Stats panel shows context
- [ ] No console errors

### Step 3: Final commit

```bash
git add .
git commit -m "Complete React rebuild - feature parity achieved"
```

---

## Troubleshooting

### Issue: "Cannot find module 'd3'"
```bash
npm install d3 @types/d3
```

### Issue: API calls fail with CORS
Check that:
1. `server.js` is running on port 3000
2. Vite proxy is configured correctly in `vite.config.ts`

### Issue: Charts not rendering
- Check browser console for D3 errors
- Verify data is being fetched (React DevTools)
- Check SVG dimensions are not 0

---

## Next Steps (Future)

After achieving feature parity:

1. **Mobile layout** - Rotated histogram for mobile
2. **Client caching** - IndexedDB for offline support
3. **URL state** - Shareable links with encoded parameters
4. **Deployment** - Deploy to Vercel/Netlify

---

**END OF IMPLEMENTATION GUIDE**

# HowHotWasIt - React Rebuild Technical Specification

## 1. Project Overview

### 1.1 Core Objective
Rebuild the vanilla JavaScript temperature visualization app as a modern React + TypeScript application while maintaining **exact** feature parity with the current implementation.

### 1.2 Key Constraints
- **NO backend changes** - server.js remains untouched
- **Fixed ±7 day window** - no slider, always 7 days before/after selected date
- **Fixed date range** - 1940 to present (no year range filtering)
- **Exact data logic** - port calculations from dataProcessor.js verbatim
- **No premature optimization** - keep it simple, mobile layout deferred to Phase 2

---

## 2. Tech Stack

| Category | Technology | Version | Rationale |
|----------|-----------|---------|-----------|
| **Framework** | React | 18.x | Modern hooks, minimal boilerplate |
| **Language** | TypeScript | 5.x | Type safety, IDE support |
| **Build Tool** | Vite | 5.x | Fast HMR, modern dev experience |
| **Visualization** | D3.js | 7.x | Same as current (no migration cost) |
| **Date Handling** | date-fns | 3.x | Lightweight, tree-shakeable |
| **Styling** | CSS Modules | - | Scoped styles, no runtime overhead |
| **HTTP Client** | fetch (native) | - | No external dependency needed |

### 2.1 Dependency List
```json
{
  "dependencies": {
    "react": "^18.3.0",
    "react-dom": "^18.3.0",
    "d3": "^7.9.0",
    "date-fns": "^3.6.0"
  },
  "devDependencies": {
    "@types/react": "^18.3.0",
    "@types/react-dom": "^18.3.0",
    "@types/d3": "^7.4.0",
    "@vitejs/plugin-react": "^4.3.0",
    "typescript": "^5.5.0",
    "vite": "^5.4.0"
  }
}
```

---

## 3. Architecture

### 3.1 Project Structure
```
how-hot-was-it/
├── src/
│   ├── components/
│   │   ├── App.tsx                    # Root component
│   │   ├── Header.tsx                 # Title + controls
│   │   ├── CitySearch.tsx             # Nominatim autocomplete
│   │   ├── DatePicker.tsx             # Date selection input
│   │   ├── MetricToggle.tsx           # Max/Min temp toggle
│   │   ├── LoadingState.tsx           # Skeleton loader
│   │   ├── ErrorBoundary.tsx          # Error handling
│   │   ├── StatsPanel.tsx             # Context text + rankings
│   │   ├── charts/
│   │   │   ├── TimeSeriesChart.tsx    # Main scatter + bands
│   │   │   ├── HistogramChart.tsx     # Distribution chart
│   │   │   └── Legend.tsx             # Shared legend component
│   │   └── App.module.css             # Component styles
│   ├── hooks/
│   │   ├── useWeatherData.ts          # Data fetching + caching
│   │   ├── useCitySearch.ts           # Nominatim search
│   │   └── useDebounce.ts             # Input debouncing
│   ├── services/
│   │   ├── api.ts                     # API client (fetch wrapper)
│   │   ├── dataProcessor.ts           # Port of js/dataProcessor.js
│   │   └── config.ts                  # Port of js/config.js
│   ├── types/
│   │   ├── weather.ts                 # WeatherData, Aggregate, etc.
│   │   └── api.ts                     # API request/response types
│   ├── utils/
│   │   ├── dateHelpers.ts             # Date calculations
│   │   └── colorHelpers.ts            # Hex to RGBA, etc.
│   ├── main.tsx                       # React entry point
│   ├── index.css                      # Global styles
│   └── vite-env.d.ts                  # Vite type declarations
├── index.html                          # HTML entry point
├── vite.config.ts                      # Vite configuration
├── tsconfig.json                       # TypeScript config
├── package.json
└── README.md
```

### 3.2 Data Flow
```
User Action (City/Date change)
    ↓
App Component (state: city, date, metric)
    ↓
useWeatherData hook
    ↓
api.ts (GET /api/archive + /api/forecast)
    ↓
dataProcessor.ts (calculate aggregates, percentiles)
    ↓
Charts (TimeSeriesChart + HistogramChart)
    ↓
D3 renders SVG
```

---

## 4. API Integration

### 4.1 Backend Endpoints
| Endpoint | Method | Purpose | Response |
|----------|--------|---------|----------|
| `/api/archive` | GET | Historical data (1940-yesterday) | Open-Meteo format + cache metadata |
| `/api/forecast` | GET | Today + future (7 days) | Open-Meteo format |
| `/api/health` | GET | Server status check | `{ status: 'ok' }` |

### 4.2 Query Parameters
```typescript
interface ArchiveParams {
  latitude: number;
  longitude: number;
  start_date: string;  // YYYY-MM-DD (±7 days from target across all years)
  end_date: string;    // YYYY-MM-DD
  daily: string;       // "apparent_temperature_max,apparent_temperature_min"
  timezone: 'auto';
}
```

### 4.3 Response Format (Open-Meteo + Cache Metadata)
```typescript
interface WeatherApiResponse {
  latitude: number;
  longitude: number;
  daily: {
    time: string[];                      // ["1940-03-15", "1940-03-16", ...]
    apparent_temperature_max: number[];  // [12.3, 15.6, ...]
    apparent_temperature_min: number[];  // [4.2, 6.8, ...]
  };
  // Cache metadata (server adds these)
  _cacheStatus?: 'HIT' | 'MISS_PARTIAL' | 'MISS_EMPTY';
  _dataSource?: 'CACHE' | 'API+CACHE' | 'API';
  _cachedRecords?: number;
}
```

### 4.4 Data Fetching Strategy
- **Single request per date/location**: Backend handles merging archive + forecast
- **±7 days across ALL years**: If user picks March 15, 2025, fetch March 8-22 for every year 1940-2025
- **Example**:
  - User selects: `2025-03-15`, Chicago (41.88, -87.63)
  - Request: `/api/archive?latitude=41.88&longitude=-87.63&start_date=1940-03-08&end_date=2025-03-22&daily=apparent_temperature_max,apparent_temperature_min&timezone=auto`
  - Backend returns ~85 years × 15 days = ~1275 data points

---

## 5. Data Processing (Port from dataProcessor.js)

### 5.1 Core Calculations

#### Yearly Aggregates (Lines 107-174 in dataProcessor.js)
For each year in the dataset:
1. Group all days in the ±7 day window
2. Extract temperature values for current metric (max or min)
3. Calculate percentiles: **p10, p25, p50 (median), p75, p90**
4. Calculate **5-year rolling median** (±2 years around current year)
   - Only show rolling median if ≥2 years before AND ≥2 years after
   - `movingMedian = median([year-2, year-1, year, year+1, year+2].p50)`

#### Percentile Context (Lines 202-274 in dataProcessor.js)
Given current day's temperature:
- **Ranking**: Position in sorted list (e.g., "3rd coldest")
- **Percentile**: % of days hotter/colder
- **Description**: Randomized phrase based on percentile:
  - Top/Bottom 5%: "Exceptionally frigid!" / "Blazing anomaly!"
  - Top/Bottom 10%: "Unusually cold" / "Quite toasty"
  - 10-20%: "A bit cool" / "A bit warm"
  - 20-80%: "Pretty typical" / "Nothing unusual"

### 5.2 TypeScript Types
```typescript
// types/weather.ts

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
```

---

## 6. Component Specifications

### 6.1 App.tsx (Root Component)
**State:**
```typescript
const [city, setCity] = useState<{ name: string; lat: number; lon: number } | null>(null);
const [selectedDate, setSelectedDate] = useState<Date>(new Date());
const [metric, setMetric] = useState<MetricType>('max_temperature');
```

**Layout:**
```tsx
<div className={styles.app}>
  <Header>
    <CitySearch onCitySelect={setCity} />
    <DatePicker value={selectedDate} onChange={setSelectedDate} />
    <MetricToggle value={metric} onChange={setMetric} />
  </Header>

  {city && (
    <main className={styles.chartsContainer}>
      <TimeSeriesChart {...chartProps} />
      <HistogramChart {...chartProps} />
    </main>
  )}

  <StatsPanel context={context} />
</div>
```

**Responsive Grid (CSS Modules):**
```css
/* App.module.css */
.chartsContainer {
  display: grid;
  grid-template-columns: 2fr 1fr;
  gap: 2rem;
  padding: 1rem;
}

@media (max-width: 768px) {
  .chartsContainer {
    grid-template-columns: 1fr;
  }
}
```

---

### 6.2 TimeSeriesChart.tsx (Main Graph)

**Props:**
```typescript
interface TimeSeriesChartProps {
  data: WeatherDataPoint[];
  aggregates: YearlyAggregate[];
  selectedDate: Date;
  metric: MetricType;
}
```

**D3 Layers (bottom to top):**
1. **90th percentile band** (p10-p90, `movingMedian ± moving90`)
2. **75th percentile band** (p25-p75, `movingMedian ± moving75`)
3. **Median trend line** (`movingMedian`)
4. **Scatter points** (all daily temps, opacity 0.2)
5. **Selected day marker** (red dot with tooltip)

**Implementation Notes:**
- Use `useRef` for SVG container
- Use `useEffect` to trigger D3 render on prop changes
- Smooth transitions: `transition().duration(500)`
- Axes: X = years (1940-2025), Y = temperature (°C)
- Colors from `config.ts` (orange for max, blue for min)

---

### 6.3 HistogramChart.tsx (Distribution)

**Props:**
```typescript
interface HistogramChartProps {
  data: WeatherDataPoint[];
  selectedTemp: number;
  metric: MetricType;
}
```

**D3 Elements:**
1. **Histogram bins** (30 thresholds, opacity 0.7)
2. **Percentile lines** (p10, p25, p50, p75, p90 - dashed)
3. **Selected temp marker** (vertical line + label)

**Axes:**
- X = frequency (count of days)
- Y = temperature (°C) - **shared scale with TimeSeriesChart**

---

### 6.4 CitySearch.tsx (Nominatim Autocomplete)

**API:**
```typescript
// Nominatim geocoding API (free, no key needed)
const response = await fetch(
  `https://nominatim.openstreetmap.org/search?q=${query}&format=json&limit=5`
);
```

**Features:**
- Debounced input (500ms)
- Dropdown with top 5 results
- Display: `{name}, {country}` (e.g., "Chicago, United States")
- On select: Store `{ name, lat, lon }`

---

### 6.5 StatsPanel.tsx (Context + Rankings)

**Display:**
```tsx
<div className={styles.statsPanel}>
  <h3>{context.description}</h3>
  <p>{context.percentile}</p>
  {context.ranking && <p>{context.ranking}</p>}

  <ul>
    <li>Coldest year: {coldestYear} ({coldestTemp}°C)</li>
    <li>Hottest year: {hottestYear} ({hottestTemp}°C)</li>
  </ul>
</div>
```

---

## 7. Styling Guidelines

### 7.1 CSS Architecture
- **CSS Modules** for component styles (scoped, no class name collisions)
- **Mobile-first approach**: Base styles for mobile, `@media (min-width: 768px)` for desktop
- **CSS Variables** for theme (colors, spacing, breakpoints)

### 7.2 Global Styles (index.css)
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
  font-family: -apple-system, BlinkMacSystemFont, 'Segoe UI', 'Roboto', sans-serif;
  background: var(--color-bg);
  color: var(--color-text);
}
```

### 7.3 NO Legacy Style Porting
- Start fresh with modern CSS (Flexbox/Grid)
- Do NOT copy old vanilla CSS (different layout paradigm)

---

## 8. Key Decisions Summary

| Decision | Choice | Rationale |
|----------|--------|-----------|
| **Styling** | CSS Modules | Scoped, no runtime overhead |
| **Date Window** | Fixed ±7 days | Simplifies UX, no slider needed |
| **Year Range** | 1940-present, fixed | No filtering UI needed |
| **State Management** | React hooks (no Redux) | Simple enough for local state |
| **API Strategy** | Single request/location | Backend handles merging |
| **Mobile Layout** | Desktop-first (Phase 2 later) | Focus on parity first |
| **Chart Library** | D3.js v7 | Already in use, no migration |
| **Deployment** | TBD (Vercel later) | Local dev first |

---

## 9. Vite Configuration

### 9.1 Proxy Setup (Development)
```typescript
// vite.config.ts
import { defineConfig } from 'vite';
import react from '@vitejs/plugin-react';

export default defineConfig({
  plugins: [react()],
  server: {
    proxy: {
      '/api': 'http://localhost:3000'
    }
  }
});
```

**Note:** This proxy only works in development. For production, you'd either:
1. Deploy backend + frontend together (same origin)
2. Configure CORS + env vars (`VITE_API_URL`)

---

## 10. Testing Checklist

**Before declaring "feature parity achieved":**

- [ ] City search returns correct coordinates
- [ ] Date picker updates charts correctly
- [ ] Metric toggle switches between max/min
- [ ] Charts display percentile bands (90th, 75th)
- [ ] Trend line shows 5-year rolling median
- [ ] Histogram aligns with time series Y-axis
- [ ] Selected day marker appears on both charts
- [ ] Stats panel shows correct percentile text
- [ ] Coldest/hottest years are accurate
- [ ] Loading states appear during fetch
- [ ] Error messages display on API failures
- [ ] Responsive layout works on mobile
- [ ] Smooth transitions on metric change
- [ ] No console errors

---

## 11. Future Enhancements (NOT in Scope)

- ❌ Mobile-specific layout (rotated histogram)
- ❌ Client-side caching (IndexedDB)
- ❌ Year range filtering slider
- ❌ Precipitation/wind metrics (currently disabled in config)
- ❌ Download chart as PNG
- ❌ Share URL with encoded state

---

## 12. File Size Estimates

| File | Lines of Code (est.) |
|------|---------------------|
| `dataProcessor.ts` | ~350 (port from JS) |
| `TimeSeriesChart.tsx` | ~200 (D3 logic) |
| `HistogramChart.tsx` | ~150 (D3 logic) |
| `useWeatherData.ts` | ~80 |
| `CitySearch.tsx` | ~100 |
| `App.tsx` | ~150 |
| **Total** | **~1500 LOC** |

---

## 13. Browser Support

- Chrome 90+
- Firefox 88+
- Safari 14+
- Edge 90+

---

**END OF SPEC**

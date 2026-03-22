# React Migration Implementation Plan

## Goal
Migrate vanilla JavaScript frontend to React with TypeScript, maintaining desktop functionality with mobile-ready structure for future implementation.

## Progress Tracker

### ✅ Phase 1: Setup & Infrastructure (COMPLETED)
- [x] Initialize React + Vite + TypeScript project
- [x] Install dependencies (react, react-dom, d3, @types/d3)
- [x] Configure Vite to build to ../dist directory
- [x] Create project structure (/src with components, hooks, services, utils, types, context)
- [x] Migrate config.js to TypeScript config

### 🔄 Phase 2: Core Utilities & Services (IN PROGRESS)
- [ ] **Step 1: Migrate dataProcessor.js** → `/src/utils/dataProcessor.ts`
  - Data aggregation functions
  - Yearly statistics calculation (percentiles: 10th, 25th, 50th, 75th, 90th)
  - Rolling median with ±2 year window
  - Temperature context generation
  - Filter by year range
  - **REVIEW POINT** ✋ - Test utility functions before proceeding

- [ ] **Step 2: Migrate apiDataFetcher.js** → `/src/services/api.ts`
  - API service for archive and forecast endpoints
  - Error handling
  - Type definitions for API responses
  - **REVIEW POINT** ✋ - Test API service before proceeding

- [ ] **Step 3: Create TypeScript type definitions** → `/src/types/index.ts`
  - WeatherData interface
  - Location interface
  - ChartData interface
  - **REVIEW POINT** ✋ - Review type definitions

### 📦 Phase 3: State Management
- [ ] **Step 4: Set up React Context** → `/src/context/AppContext.tsx`
  - Global state for location, date, metrics
  - Loading states
  - Error handling
  - **REVIEW POINT** ✋ - Test context provider

### 🎨 Phase 4: UI Components (Build & Test One-by-One)
- [ ] **Step 5: App Shell** → `/src/App.tsx`
  - Basic layout structure
  - Context provider wrapper
  - Desktop-focused layout (1360px max width)
  - **REVIEW POINT** ✋ - Test app shell renders

- [ ] **Step 6: LoadingOverlay Component** → `/src/components/LoadingOverlay.tsx`
  - Loading spinner
  - Overlay styles
  - **REVIEW POINT** ✋ - Test loading overlay

- [ ] **Step 7: LocationSelector Component** → `/src/components/LocationSelector.tsx`
  - Migrate citySelector.js functionality
  - Autocomplete with Nominatim API
  - Keyboard navigation
  - Lat/lon inputs
  - **REVIEW POINT** ✋ - Test city search and selection

- [ ] **Step 8: DateSelector Component** → `/src/components/DateSelector.tsx`
  - Date picker input
  - Validation
  - **REVIEW POINT** ✋ - Test date selection

- [ ] **Step 9: MetricSelector Component** → `/src/components/MetricSelector.tsx`
  - Toggle between max/min temperature
  - Dynamic based on active metrics
  - **REVIEW POINT** ✋ - Test metric switching

- [ ] **Step 10: TemperatureContext Component** → `/src/components/TemperatureContext.tsx`
  - Display current temperature percentile ranking
  - Context text generation
  - **REVIEW POINT** ✋ - Test context display

### 📊 Phase 5: D3 Chart Components (Most Complex)
- [ ] **Step 11: Create useResizeObserver Hook** → `/src/hooks/useResizeObserver.ts`
  - Monitor container size
  - Trigger re-renders on resize
  - **REVIEW POINT** ✋ - Test hook with simple component

- [ ] **Step 12: ChartContainer Component** → `/src/components/ChartContainer.tsx`
  - Wrapper for both charts
  - Responsive SVG containers
  - **REVIEW POINT** ✋ - Test empty chart containers render

- [ ] **Step 13: MainChart Component** → `/src/components/MainChart.tsx`
  - Migrate chartRenderer.js main chart logic
  - D3 integration with React refs
  - Percentile bands (10-90th, 25-75th)
  - Rolling median trend line
  - Scatter plot with tooltips
  - Current temperature indicators
  - Interactive legend
  - **REVIEW POINT** ✋ - Test main chart renders with sample data

- [ ] **Step 14: HistogramChart Component** → `/src/components/HistogramChart.tsx`
  - Migrate histogram logic from chartRenderer.js
  - D3 histogram generation
  - Current temperature indicator
  - **REVIEW POINT** ✋ - Test histogram renders with sample data

### 🎨 Phase 6: Styling
- [ ] **Step 15: Extract and Migrate CSS**
  - Convert embedded CSS to CSS modules or styled-components
  - Desktop-focused styles (1360px container)
  - Loading overlay styles
  - Modal styles
  - **REVIEW POINT** ✋ - Test all components have correct styling

### 🧪 Phase 7: Integration & Testing
- [ ] **Step 16: Wire Everything Together**
  - Connect all components in App.tsx
  - Implement data flow: location → fetch → process → render
  - Test complete user flow
  - **REVIEW POINT** ✋ - Test complete application flow

- [ ] **Step 17: Desktop Testing**
  - Test on 1024px viewport
  - Test on 1366px viewport
  - Test on 1920px viewport
  - Verify all features work
  - **REVIEW POINT** ✋ - Final desktop QA

### 🚀 Phase 8: Build & Deploy
- [ ] **Step 18: Production Build**
  - Run `npm run build`
  - Verify dist/ folder created
  - Check bundle size (target < 500KB)
  - **REVIEW POINT** ✋ - Review build output

- [ ] **Step 19: Backend Integration**
  - Test server serves React build
  - Verify API endpoints work
  - Test routing
  - **REVIEW POINT** ✋ - Final integration test

## Technical Decisions Made

### Build & Tooling
- **Framework**: React 18
- **Build Tool**: Vite 6
- **Language**: TypeScript
- **D3 Version**: D3 v7 (matching vanilla version)

### Architecture
- **State Management**: React Context API
- **D3 Integration**: React owns the DOM, D3 for calculations and rendering
- **API Calls**: Fetch API wrapped in service layer
- **Styling**: CSS modules (decision pending final review)

### File Structure
```
frontend/
├── src/
│   ├── components/       # React components
│   ├── hooks/           # Custom React hooks
│   ├── services/        # API services
│   ├── utils/           # Utility functions (dataProcessor, config)
│   ├── types/           # TypeScript type definitions
│   ├── context/         # React Context providers
│   ├── App.tsx          # Main app component
│   └── main.tsx         # Entry point
├── vite.config.ts       # Vite configuration
└── package.json
```

### Component Hierarchy (Planned)
```
App
├── AppProvider (Context)
│   ├── LocationSelector
│   ├── DateSelector
│   ├── MetricSelector
│   ├── TemperatureContext
│   ├── ChartContainer
│   │   ├── MainChart (D3)
│   │   └── HistogramChart (D3)
│   └── LoadingOverlay
```

## Current Status
**Currently on**: Phase 2, Step 1 - Migrating dataProcessor.js

**Next QA Checkpoint**: After dataProcessor.ts is complete

---

## Notes
- Mobile support is planned but NOT implemented yet
- Focus on desktop (1024px+) functionality
- Structure code to be mobile-ready for future enhancement
- Each component should be reviewed before proceeding to next

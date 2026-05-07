# HowHotWasIt - Weather Data Visualization

A web application for visualizing historical and current weather data using the Open-Meteo API.

## Features

- **Real-time Weather Data**: Fetches data from Open-Meteo API via server proxy
- **Historical Analysis**: View data from 1950 to present
- **Multiple Metrics**: 
  - Maximum/Minimum Apparent Temperature
  - Precipitation Sum  
  - Maximum Wind Speed
- **Interactive Visualization**: D3.js charts with percentile bands and trend lines
- **Default Location**: Tel Aviv, Israel (32.0853, 34.7818)

## Quick Start

You need **two terminals** for development: one for the backend, one for the Vite dev server (hot-reload).

### Terminal 1 — Backend (Node 18)
```bash
npm install
npm run dev
```
The backend script auto-switches to Node 18 via nvm. Node 20+ has a TLS issue under WSL2 that breaks outbound calls to the Open-Meteo API, so we pin to 18.

### Terminal 2 — Frontend (Node 22)
```bash
cd frontend && npm install   # first time only
cd ..
npm run dev:frontend
```
This script auto-switches to Node 22 (required by Vite 6) and starts the dev server.

### Open Your Browser
- **Development:** http://localhost:5173 (Vite, hot-reload, proxies `/api/*` to the backend)
- **Production build:** http://localhost:3000 (backend serves the built `dist/` — run `npm run build` in `frontend/` first)

## How to Use

1. **Enter Location**: Set latitude and longitude (defaults to Tel Aviv)
2. **Choose Date**: Select target date (defaults to today)
3. **Fetch Data**: Click "Fetch Data" to load weather information
4. **Explore Metrics**: Switch between temperature, precipitation, and wind data
5. **Adjust Time Range**: Use the year selector to filter data

## API Endpoints

- `GET /api/archive` - Historical weather data proxy
- `GET /api/forecast` - Forecast data proxy  
- `GET /api/health` - Server health check

## Technology Stack

- **Frontend**: HTML5, CSS3, JavaScript (ES6), D3.js
- **Backend**: Node.js, Express.js
- **Data Source**: Open-Meteo API
- **Server**: CORS-enabled Express proxy

## File Structure

```
├── server.js              # Express server with API proxy
├── package.json           # Node.js dependencies
├── interactive_temperature.html  # Main application
├── js/
│   ├── apiDataFetcher.js  # API client
│   ├── dataProcessor.js   # Data processing
│   ├── chartRenderer.js   # D3.js visualizations
│   ├── uiController.js    # User interface logic
│   └── config.js          # Configuration & colors
└── README_server.md       # This file
```

## Development

The server automatically serves static files and handles CORS issues by proxying requests to the Open-Meteo API.

- **Port**: 3000 (configurable via PORT environment variable)
- **Hot reload**: Restart server after changes
- **Logging**: Console logs show API requests and errors

## License

MIT License
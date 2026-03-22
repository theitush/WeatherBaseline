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

### 1. Install Dependencies
```bash
npm install
```

### 2. Start the Server
```bash
npm start
```

### 3. Open Your Browser
Visit: http://localhost:3000

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
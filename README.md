# HowHotWasIt - Temperature History App

A comprehensive weather visualization app that includes both a Python script and a web application for retrieving and visualizing historical temperature data using the Open-Meteo API.

## Quick Start

**Web App:**
```bash
npm install
npm start
# Open http://localhost:3000
```

**Python Script:**
```bash
pip install -r requirements.txt
python temperature_history.py 2024-01-15 40.7128 -74.0060
```

## Features

### Web Application
- Interactive weather visualization with charts
- Real-time data fetching with caching
- Historical temperature trends and comparisons
- Responsive design for desktop and mobile
- Temperature forecast integration

### Python Script
- Fetches min and max temperatures for a specific date ±7 days (configurable)
- Covers all available historical years (1940 to present)
- Provides comprehensive statistics and summaries
- Supports JSON output for further analysis
- Handles API errors gracefully
- Validates input coordinates and dates

## Installation

### Web Application Setup

1. Clone or download the project files
2. Install Node.js dependencies:

```bash
npm install
```

3. Start the web server:

```bash
npm start
```

4. Open your browser and go to `http://localhost:3000`

### Python Script Setup

1. Install Python dependencies:

```bash
pip install -r requirements.txt
```

## Usage

### Web Application

1. Start the server with `npm start`
2. Open `http://localhost:3000` in your browser
3. Click on the map or enter coordinates to select a location
4. Choose a date to see historical temperature data
5. View interactive charts showing temperature trends over time

### Python Script - Basic Usage

```bash
python temperature_history.py <date> <latitude> <longitude>
```

### Python Script - Examples

**Get temperature history for New York City on January 15th:**
```bash
python temperature_history.py 2024-01-15 40.7128 -74.0060
```

**Get temperature history for London on July 4th with 10-day range:**
```bash
python temperature_history.py 2024-07-04 51.5074 -0.1278 --days 10
```

**Save results to a JSON file:**
```bash
python temperature_history.py 2024-06-21 48.8566 2.3522 --output paris_temps.json
```

### Python Script - Command Line Arguments

- `date`: Target date in YYYY-MM-DD format (required)
- `latitude`: Latitude coordinate between -90 and 90 (required)
- `longitude`: Longitude coordinate between -180 and 180 (required)
- `--days`: Number of days before and after target date (default: 7, max: 30)
- `--output`: Output file to save results as JSON (optional)

## Web Application API

The web app runs a Node.js/Express server with these endpoints:

- `GET /` - Main application interface
- `GET /api/archive` - Historical weather data with caching
- `GET /api/forecast` - Weather forecast data
- `GET /api/health` - Server health check
- `GET /api/cache-status` - Cache statistics

## Output

### Web Application
- Interactive temperature charts and graphs
- Historical temperature trends with year-over-year comparisons
- Responsive design that works on desktop and mobile
- Real-time data loading with progress indicators
- Cached data for improved performance

### Python Script Output

The script provides:

1. **Real-time progress**: Shows data retrieval progress for each year
2. **Summary statistics**:
   - Overall minimum and maximum temperatures
   - Average minimum and maximum temperatures
   - Years with extreme temperatures
3. **Detailed table**: Year-by-year breakdown of temperature data
4. **JSON export**: Optional structured data output

### Sample Output

```
Fetching temperature data for 2024-01-15 ±7 days...
Location: 40.7128, -74.0060
Years: 1940 to 2023
--------------------------------------------------
1940: Min: -12.3°C, Max: 8.7°C (15 days)
1941: Min: -15.2°C, Max: 7.9°C (15 days)
...

============================================================
TEMPERATURE HISTORY SUMMARY
============================================================
Years with data: 84
Overall minimum temperature: -18.5°C
Overall maximum temperature: 15.2°C
Average minimum temperature: -8.3°C
Average maximum temperature: 6.1°C

Coldest year: 1985 (Min: -18.5°C)
Hottest year: 2007 (Max: 15.2°C)

Detailed data:
------------------------------------------------------------
Year   Min Temp   Max Temp   Avg Min    Avg Max   
------------------------------------------------------------
1940   -12.3      8.7        -5.2       2.1      
1941   -15.2      7.9        -6.8       1.8      
...
```

## API Information

This script uses the [Open-Meteo Historical Weather API](https://open-meteo.com/en/docs/historical-weather-api), which provides:

- Free access to historical weather data
- Global coverage from 1940 to present
- High accuracy ERA5 reanalysis data
- No API key required
- Rate limiting: 10,000 requests per day

## Error Handling

The script handles various error conditions:

- Invalid date formats
- Out-of-range coordinates
- API request failures
- Missing or incomplete data
- Network timeouts

## Data Format

The JSON output contains structured data for each year:

```json
{
  "1940": {
    "year": 1940,
    "date_range": "1940-01-08 to 1940-01-22",
    "min_temperature": -12.3,
    "max_temperature": 8.7,
    "avg_min": -5.2,
    "avg_max": 2.1,
    "data_points": 15
  }
}
```

## Limitations

- Historical data availability varies by location
- Some remote areas may have limited historical coverage
- API rate limits apply (10,000 requests per day)
- Data quality depends on the ERA5 reanalysis dataset

## Troubleshooting

**"No data available" for some years:**
- Historical data coverage varies by location
- Some years may have incomplete data
- This is normal for remote or less-monitored areas

**API request failures:**
- Check your internet connection
- The API may be temporarily unavailable
- You may have exceeded rate limits

**Invalid date format:**
- Ensure dates are in YYYY-MM-DD format
- Use leading zeros for single-digit months and days

## License

This script is provided as-is for educational and personal use. The Open-Meteo API is free to use with appropriate rate limiting. 
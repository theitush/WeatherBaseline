#!/usr/bin/env python3
"""
Temperature History Script
Gets min and max temperatures for a specific date ±7 days across all available previous years
using the Open-Meteo API, including current year data and forecasts.
"""

import requests
import pandas as pd
from datetime import datetime, timedelta


def get_temperature_history(latitude: float, longitude: float, target_date: str, start_year: int = 2020, days_range: int = 7) -> pd.DataFrame:
    """
    Get temperature history for a specific date range across all available years,
    including current year data and forecasts.
    
    Args:
        latitude: Latitude coordinate
        longitude: Longitude coordinate
        target_date: Target date in YYYY-MM-DD format
        start_year: Start year for historical data (default: 2020)
        days_range: Number of days before and after target date (default: 7)
        
    Returns:
        pandas DataFrame with daily temperature data for each date
    """
    print(f"Fetching temperature data for {target_date} ±{days_range} days at {latitude}, {longitude}...")

    # Parse the target date
    API_DATE_FORMAT = "%Y-%m-%d"
    target_dt = datetime.strptime(target_date, API_DATE_FORMAT)
    current_date = datetime.now().replace(hour=0, minute=0, second=0, microsecond=0) # to make it comparable to target_dt
    yesterday = current_date-timedelta(days=1)

    assert target_dt <= current_date + timedelta(days=3), f'{target_date} should be within 3 days of today!'
    
    # Calculate the overall date range for historical data (excluding current year)
    overall_start_date = target_dt.replace(year=start_year) - timedelta(days=days_range)
    overall_start_str = datetime.strftime(overall_start_date, API_DATE_FORMAT)
    yesterday_str = datetime.strftime(yesterday, API_DATE_FORMAT)
        
    print(f"Making historical API call for date range: {overall_start_str} to {yesterday_str}")
    
    data_rows = []
    
    # Make historical API request
    params = {
        "latitude": latitude,
        "longitude": longitude,
        "start_date": overall_start_str,
        "end_date": yesterday_str,
        "daily": "temperature_2m_max,temperature_2m_min",
        "timezone": "auto"
    }
        
    try:
        response = requests.get("https://archive-api.open-meteo.com/v1/archive", params=params, timeout=60)
        response.raise_for_status()
        
        data = response.json()
        
        if "daily" in data and data["daily"]["time"]:
            # Extract temperature data
            dates = data["daily"]["time"]
            max_temps = data["daily"]["temperature_2m_max"]
            min_temps = data["daily"]["temperature_2m_min"]
            
            # Create a row for each date
            for i, date in enumerate(dates):
                if max_temps[i] is not None and min_temps[i] is not None:
                    # Parse the date to extract the year
                    date_dt = datetime.strptime(date, API_DATE_FORMAT)
                    year = date_dt.year
                    
                    # Only include data for years we're interested in
                    # Check if this date is within the target range for this year
                    target_date_this_year = target_dt.replace(year=year)
                    start_range = target_date_this_year - timedelta(days=days_range)
                    end_range = target_date_this_year + timedelta(days=days_range)
                    
                    if start_range <= date_dt <= end_range:
                        data_rows.append({
                            "date": date,
                            "min_temperature": min_temps[i],
                            "max_temperature": max_temps[i],
                            "data_type": "historical"
                        })
                        
    except Exception as e:
        print(f"Error fetching historical data: {e}")

    # Now get current year data and forecast
    if target_dt >= yesterday:        
        # Get current year data (historical + forecast)
        print(f"Making forecast API call for forecast data untill {target_dt}")
        
        params = {
            "latitude": latitude,
            "longitude": longitude,
            "start_date": datetime.strftime(yesterday, API_DATE_FORMAT),
            "end_date": datetime.strftime(target_dt, API_DATE_FORMAT),
            "daily": "temperature_2m_max,temperature_2m_min",
            "timezone": "auto"
        }
        
        try:
            response = requests.get("https://api.open-meteo.com/v1/forecast", params=params, timeout=60)
            response.raise_for_status()
            
            data = response.json()
            
            if "daily" in data and data["daily"]["time"]:
                # Extract temperature data
                dates = data["daily"]["time"]
                max_temps = data["daily"]["temperature_2m_max"]
                min_temps = data["daily"]["temperature_2m_min"]
                
                # Create a row for each date
                for i, date in enumerate(dates):
                    if max_temps[i] is not None and min_temps[i] is not None:
                        date_dt = datetime.strptime(date, "%Y-%m-%d")
                        data_rows.append({
                            "date": date,
                            "min_temperature": min_temps[i],
                            "max_temperature": max_temps[i],
                            "data_type": 'forcast'
                        })
                        
        except Exception as e:
            print(f"Error fetching current year data: {e}")
    
    df = pd.DataFrame(data_rows)
    df['date'] = pd.to_datetime(df['date'])
    df['year'] = df['date'].dt.year

    return df

def calculate_yearly_aggregates(data: pd.DataFrame, date: str, metric: str, window_size: int = 5) -> pd.DataFrame:
    
    # Calculate yearly averages and percentiles
    yearly_aggs = data.groupby('year')[metric].agg([
        ('10th', lambda x: x.quantile(0.10)),
        ('25th', lambda x: x.quantile(0.25)),
        ('50th', lambda x: x.quantile(0.5)),
        ('75th', lambda x: x.quantile(0.75)),
        ('90th', lambda x: x.quantile(0.90))
    ]).reset_index()
    dt = datetime.strptime(date, "%Y-%m-%d")
    month_name = dt.strftime("%B")
    day_num = dt.day
    yearly_aggs['date'] = pd.to_datetime(yearly_aggs['year'].astype(str) + '-' + month_name + '-' + str(day_num))
    yearly_aggs['moving_median'] = yearly_aggs['50th'].rolling(window=window_size).median()
    yearly_aggs['moving_10th'] = yearly_aggs['10th'].rolling(window=window_size).median()
    yearly_aggs['moving_25th'] = yearly_aggs['25th'].rolling(window=window_size).median()
    yearly_aggs['moving_75th'] = yearly_aggs['75th'].rolling(window=window_size).median()
    yearly_aggs['moving_90th'] = yearly_aggs['90th'].rolling(window=window_size).median()
    return yearly_aggs
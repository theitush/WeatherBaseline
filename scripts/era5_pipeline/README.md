# ERA5-Land daily pipeline

Downloads ERA5-Land daily min/max temperature and total precipitation from the
Copernicus CDS for ~5,000 cities (GeoNames cities5000) from 1950 to present.

## Layout

```
scripts/era5_pipeline/
  requirements.txt        Python deps
  setup_venv.sh           creates .venv and installs deps
  .cdsapirc               CDS key (gitignored)
  download_cities.py      one-shot: fetch cities5000.zip → data/era5/cities.csv
  era5.py                 shared helpers (request schema, interp, units)
  benchmark.py            compare bbox strategies on 10 cities × 1 year
  fetch_era5.py           main resumable pipeline
  state.json              tracks completed years (gitignored)

data/era5/                output (gitignored)
  cities.csv              geonameid,name,country,lat,lon
  weather_hist_{lat}_{lon}.csv     per-city daily timeseries
```

Per-city CSV schema:
```
date,min_temperature,max_temperature,precipitation_mm
1950-01-02,-5.10,1.30,0.000
```

Temperatures in °C, precipitation in mm. Filename uses lat/lon rounded to 2dp
(matching the existing `backend/cacheManager.js` convention).

## One-time setup

1. Accept the ERA5-Land licence on your CDS account:
   https://cds.climate.copernicus.eu/datasets/derived-era5-land-daily-statistics
   (Show Terms → Accept). Without this all requests return 403.

2. Create the venv and install deps:
   ```bash
   bash scripts/era5_pipeline/setup_venv.sh
   ```

3. Build the city list:
   ```bash
   source scripts/era5_pipeline/.venv/bin/activate
   python scripts/era5_pipeline/download_cities.py
   ```

## Benchmark (run this first!)

Compares per-city bbox vs global vs regional bbox strategies on 10 cities for
one year. Tells us which is fastest given current CDS queue load.

```bash
source scripts/era5_pipeline/.venv/bin/activate
python scripts/era5_pipeline/benchmark.py --year 2020 --strategies A,C
```

Output: `benchmark_results.json` with per-request timings.

Strategy keys:
- **A** per-city: ~30 small requests, lightweight each
- **B** global: 3 fat requests, multi-GB
- **C** regional: ~12 medium requests

CDS free-tier limit is ~2 concurrent active requests; the benchmark respects this.

## Full pull

After picking a strategy:

```bash
python scripts/era5_pipeline/fetch_era5.py \
    --start-year 1950 --end-year 2025 \
    --max-concurrent 2
```

Resumable: completed years are tracked in `state.json`. Re-running skips them.

Pipeline per year:
1. Submit 3 CDS requests (tmin, tmax, precip).
2. Open each downloaded NetCDF with xarray.
3. Bilinear `ds.interp` to all city lat/lons; nearest-neighbour fallback for
   NaN points (coastal cells outside ERA5-Land).
4. K→°C, m→mm.
5. Append the year's rows to each `weather_hist_{lat}_{lon}.csv`.
6. Delete the source NetCDF.
7. Mark year done.

ERA5-Land has a ~6-day lag, so the most recent days will be missing for the
current year.

## Notes

- CDS request schema verified against the dataset page and the
  `brunomartinsmv/ear5-daily-statistics-data-download` reference.
- `daily_statistic` accepts one value per request, so each year requires three
  separate requests (`daily_minimum`, `daily_maximum`, `daily_sum`).
- ERA5-Land is land-only; ocean cells are NaN. Nearest-neighbour fallback
  handles cities right on the coast.

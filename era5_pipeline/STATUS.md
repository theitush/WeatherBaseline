# ERA5 pipeline — status & next steps

## Where we are

Built the scaffolding for a resumable ERA5-Land daily pipeline (1950→present, 3 vars: tmin, tmax, precip) for ~5,000 GeoNames cities. Output: per-city CSV at `data/era5/weather_hist_{lat:.2f}_{lon:.2f}.csv`, schema `date,min_temperature,max_temperature,precipitation_mm` (°C, mm).

Files in place:
- `download_cities.py` — fetches cities5000 → `data/era5/cities.csv`
- `era5.py` — CDS request schema, xarray interp helpers, unit conversion
- `benchmark.py` — A/B/C bbox strategy comparison
- `fetch_era5.py` — main pipeline (year loop, state.json resumability)
- `.cdsapirc` in place; venv set up; CDS licence accepted

## Benchmark results (year 2020, target=tmin)

| Strategy | Requests | Wall time | Total size | Notes |
|---|---|---|---|---|
| A per-city (0.5° bbox × 3 cities) | 3 | 2409s (~40m) | 0.29 MB | Tiny payloads, but queue still serialized |
| C regional (4 continental bboxes) | 4 | 4879s (~81m) | 196 MB | Queue waits grew to 3216s for last region |
| B global (1 request, no bbox) | TBD | TBD | TBD | **see benchmark_results.json** |

Key finding: **running time is similar across bbox sizes** (~15–35 min per request). The bottleneck is **queue time**, which scales with number of requests. Bbox size barely affects CDS worker throughput.

## Conclusion (provisional)

For the full 1950–2025 pull:
- **A doesn't scale**: 5000 cities × 3 targets × 76 years = 1.14M requests → rate-limited in hours.
- **C costs more bytes than B** for the same year coverage and 4× the requests.
- **B (global)** = 3 × 76 = 228 requests total. Fewest queue hits wins.

Decision pending the B benchmark: confirm a single global (year, target) downloads in a sane time and size (estimated 250–500 MB per request).

## Cell selection: GHSL instead of GeoNames

Decided to replace the GeoNames cities5000 list with a population-ranked
selection of actual ERA5-Land 0.1deg grid cells, via `select_cells.py`:
download GHS-POP -> sum population into the 0.1deg grid -> rank land cells ->
take the top N (default 10K) -> bin into 6.4deg zarr tiles.

Why:
- Each selected cell IS an ERA5-Land cell centre -> the zarr fetch reads it
  directly. No interp window, no bilinear interp, no coastal-NaN fallback.
- Uniform, reproducible: "top-N most-populated 0.1deg land cells" beats the
  GeoNames gazetteer's uneven national coverage.

Run it to turn estimates into exact numbers:
  pip install rasterio
  python select_cells.py --ghsl <wgs84-GHS-POP.tif> --top-n 10000
It prints the distinct-tile count and the resulting request budget
(tiles x years x 4 time-chunks x vars) vs the 500K/month quota.

### Dense per-country coverage (--region)

The global top-N gives uneven national coverage: a small country only gets the
handful of cells that rank globally. `--region lat_lo,lat_hi,lon_lo,lon_hi[,floor]`
adds EVERY populated cell in a bbox (>= floor people, default 100) on top of the
top-N, deduped on (lat,lon). Repeatable for multiple countries.

Current cells.csv was built with full Israel coverage:
  python select_cells.py --top-n 10000 \
    --ghsl GHS_POP_E2025_GLOBE_R2023A_4326_30ss_V1_0.tif \
    --region 29.4,33.4,34.2,35.9,100
-> 10,381 cells (Israel 44 -> 425). Costs ZERO extra download requests: every
Israel cell falls in tiles 8_5 / 9_5, already fetched by the global selection,
so the tile count (337) and request budget are unchanged. Re-sync the frontend
copy after regenerating:  cp data/era5/cells.csv frontend/public/cells.csv

## Variables & quota notes
- "request" = one HTTP range fetch of one zarr chunk. NOT per .sel()/city.
  Per-CITY fetching re-pulls shared tiles -> ~1.1M reqs. Per-TILE fetching
  (bin cities into 6.4deg tiles, fetch each once, interp all cities in it)
  is the scalable path.
- Derived metrics are free: tmin/tmax both from `t2m`; 5 wind metrics
  (E/W/N/S components + speed) all from `u10`+`v10`. Cost scales with STORED
  variables (t2m, tp, u10, v10 = 4), not derived metrics.
- Wind speed must be computed hourly THEN resampled: mean(sqrt(u^2+v^2)) !=
  sqrt(mean(u)^2+mean(v)^2). `tp` is accumulated -> daily SUM, watch the
  ERA5 accumulation convention.
- Rough budget: ~500-700 tiles x 76 yrs x 4 chunks x 4 vars ~= 600-730K reqs
  -- OVER the 500K/month quota (4 chunks/yr confirmed, see Open Questions).
  Mitigate: split across 2 months, or cut years/vars.
- No server-side aggregation: EarthDataHub is static zarr storage. resample/
  min/max run locally; you download hourly chunks and aggregate yourself.

## Open Questions
- lets try this first! 
- is there an easier way to get the data? coz 228 reqs may still take months... 
- csv vs parquet? storage size concerns...
- ~~confirm tp/u10/v10 exist in the no-antartica store + their chunk layout~~
  CONFIRMED 2026-06-02 against the live store: t2m/tp/u10/v10 all present,
  float32, 64x64 spatial chunks (6.4deg tiles). Time chunks are 2880h = 120
  days, so a year crosses **4** chunks (boundaries unaligned to Jan 1) -- NOT 3.
  select_cells.py's budget code already uses time_chunks=4, so it's correct;
  this note's "3 time-chunks/year" was the stale bit. Also: the store's latitude
  axis is 1472 cells (90 -> ~-57.1deg), not the full 1801 to -90 -- era5_grid()
  builds the full grid, but no populated top-N cell is below ~-57deg.
- UPDATE 2026-08-24: EarthDataHub's July 2026 revamp moved the ERA5 collection
  to Zarr v3 stores with new chunking. Hourly ERA5-Land now lives at
  `era5/era5-land-v0.zarr`, chunked 1440h (60 days) x 50 lat x 100 lon
  (5x10deg tiles, ~29 MB raw); a year crosses up to 7 time-chunks. Same 0.1deg
  grid and 1472x3600 no-Antarctica crop, same variables/units/stepTypes. The
  old `reanalysis-era5-land-no-antartica-v0.zarr` (Zarr v2, 2880x64x64) is
  FROZEN at 2026-05-31 -- monthly updates land only in the new stores, so any
  top-up on pre-migration code silently no-ops. Pipeline + cells.csv tile ids
  re-derived accordingly; 8727 cells now bin to 342 tiles (was 399).
- pick GHS-POP epoch (2020 vs 2025) and confirm WGS84 product
- is 10K the right N? 5K populated cells may already beat the GeoNames list

## How to continue

### 1. compare to this zarr method
this zarr stuff (https://earthdatahub.destine.eu/collections/era5/datasets/era5-land-daily) might be quicker and easier?
example code:
```python
import xarray as xr
ds = xr.open_zarr("https://.../era5-land-daily.zarr", chunks=None, storage_options={...})
# 5k cities at once, all years, in one .sel() + .interp()
result = ds.sel(time=slice("1950","2026")).interp(latitude=city_lats, longitude=city_lons)
result.to_pandas().to_parquet("...")
```
so do a small test (same 3 cities and metric we did in the benchmarks) and see if it makes sense.. 

### 2. Validate the global file
Open the kept `.nc` with xarray, interp to a few cities, sanity-check °C values for NYC/London/Tokyo against known 2020 norms. Confirms our `interp_cities` pipeline is correct on real global data before doing the long pull.

### 3. Wire winning strategy into fetch_era5.py
Currently `area = None` in `fetch_year` (already global). If B wins, leave it. If C wins (unlikely given the numbers), update `fetch_era5.py` to loop over `regional_bboxes()` and merge frames across regions per target.

### 4. Run the full pull
```bash
python era5_pipeline/fetch_era5.py --start-year 1950 --end-year 2025 --max-concurrent 2
```
Resumable via `state.json`. Expect days-to-weeks given CDS queue behaviour. Consider running it on a small year range first (e.g. 2018–2020) end-to-end to confirm the full path works (download → interp → CSV append) before committing to the full 76-year run.

## Known caveats
- ERA5-Land has a ~6-day lag; current-year data will be incomplete.
- ERA5-Land is land-only; coastal/island cities may hit NaN — `interp_cities` has nearest-neighbour fallback.
- CDS free tier: ~2 concurrent active, ~20 queued.
- CDS maintenance windows can stall queues for hours.

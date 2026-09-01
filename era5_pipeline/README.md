# era5_pipeline/ — building and maintaining the ERA5-Land archive

The site's `archive` tier is one gzipped CSV per grid cell, 1950→present, served
straight from R2 to the browser. This folder is everything that produces and
maintains it: **which** 0.1° cells exist (`select_cells.py`), what each one is
**called** (`build_cells.py` and friends), the **download** that fills them from
the EarthDataHub Zarr store (`download_cells.py`), and the **R2** plumbing that
ships and verifies the result. It is a batch pipeline run by hand, not a service
— nothing here is deployed, and the site never calls it.

Current scope: **8,620 cells in 341 tiles**, schema
`date,tmax_C,tmin_C,precip_mm,wind_max_ms` (°C, mm, m/s), keyed
`archive/archive_{lat}_{lon}.csv.gz`.

**R2 is the source of truth, always** — for this pipeline as much as for the
frontend. `data/era5-land/` on disk is a cache from whichever runs happened on
this machine (it currently holds more files than there are live cells: dropped
cells linger locally, and the resume logic reads R2, not it). Run with
`--upload-r2` so a resume sees the real state.

Everything Python here runs in `.venv` (Python 3.12) — this is the one virtualenv
for the whole repo, including `../debias/`, `../analytics/` and the notebook
kernels. Set it up with `./setup_venv.sh`, and invoke it by path rather than
activating it.

## Where the data comes from

Hourly **ERA5-Land** as an ARCO Zarr store on
[EarthDataHub](https://earthdatahub.destine.eu/) —
`https://data.earthdatahub.destine.eu/era5/era5-land-v0.zarr`, credential
`~/.netrc`. The CDS API path is **superseded** — no script imports `cdsapi`
any more, and `.cdsapirc` / the `cdsapi` pin in `requirements.txt` are leftovers
of it. CDS is still where `../debias/data/geo.grib` (the geopotential field
behind each cell's elevation) was fetched by hand, once.

Three properties of the store shape the whole downloader:

- **Chunks are 1440 h × 50 lat × 100 lon** — 60 days over a 5°×10° tile. A "tile"
  here *is* one spatial chunk, and `tile_id` in `cells.csv` encodes its index, so
  one fetch serves every cell in it. A calendar year straddles ~7 time chunks and
  the boundaries don't align to Jan 1, which is why the downloader fetches
  multi-year **spans** rather than years — year-by-year refetches every boundary
  chunk.
- **Only stored variables cost anything.** We fetch `t2m`, `tp`, `u10`, `v10`;
  tmax/tmin and wind speed are derived locally for free. There is no server-side
  aggregation — the hourly array streams through RAM and is resampled here, so
  RAM (~3 GB per variable per 20-year span) is the binding constraint, not disk.
- **It is land-only** — ocean gridpoints are NaN, which is the root of the whole
  snap story below.

Two lossiness notes worth knowing before chasing a small discrepancy: the v3
store is BitRound-quantised (shipped 1950–2023 temperatures sit on a 0.25 K
grid), and ERA5-Land lags real time by ~6 days — the `recent` and `forecast`
tiers, written by the Worker from Open-Meteo, cover the gap and are not this
pipeline's business.

## Scripts — the production path, in order

| file | what it does |
|---|---|
| `select_cells.py` | Defines the cell list from **GHS-POP**: sums the population raster into the ERA5-Land 0.1° grid, ranks land cells, takes the top N, bins each into its Zarr tile, and prints the request budget. `--region lat_lo,lat_hi,lon_lo,lon_hi[,floor]` adds every populated cell in a bbox on top (used for full Israel coverage). Writes `../data/cells.csv`. **A deliberate upstream action** — it regenerates the curated list from scratch; the rest of the pipeline operates on the existing file. |
| `build_cells.py` | Orchestrates the naming rebuild in the one correct order — `apply_coastal_snap.py` → `name_cells.py` → `name_coord_cells.py` — so no step is forgotten. Each step is idempotent. Does **not** run `select_cells.py`. See the naming warning below before running it. |
| `name_cells.py` | Derives every cell's `name`: a KD-tree join against the GeoNames cities500 gazetteer, admin-1 region spliced in for cross-region clashes, Photon reverse-geocoding for cells whose nearest gazetteer city is far, and the same-metro dedupe folded in. Cached, so a warm rerun is instant. |
| `name_coord_cells.py` | Backfills the handful of cells still labelled bare `"lat, lon"` via Nominatim, and seeds the revgeo cache so `name_cells.py` reproduces the answer next time. |
| `disambiguate_dupes.py` | The dedupe pass on its own: refines same-name cells to sub-district ("Pudong, Shanghai" vs "Minhang, Shanghai"), with a compass-bearing backstop that guarantees global uniqueness. |
| `fetch_geonames_aux.py` | Caches GeoNames' `countryInfo` / `admin1Codes` dumps next to the gazetteer so the naming scripts stop re-fetching them. |
| `download_cells.py` | **The pipeline.** Fetches each tile's span once, buckets hours into whole **solar-local** days (with a one-day halo; short edge buckets are dropped rather than written), derives the four daily metrics, merges by date onto the cell's current archive and uploads. Batched, parallel (`--var-workers`, `--parallel-tiles`), and resumable off **row counts per year** — an absent year, an interior hole and a nearly-empty year all read as incomplete. That same rule *is* the monthly top-up: rerun it and every tile that has fallen behind the store merges in its last days. |
| `r2_upload.py` | The one uploader, used both as a CLI seed and as the library `download_cells.py` pushes through. Sets `Content-Type: text/csv` + `Content-Encoding: gzip` and the per-tier `Cache-Control`. |
| `cell_keys.py` | **The one place** a lat/lon becomes an object key or filename. Exists because Python's `f"{-0.0:.1f}"` keeps the sign and JS's `toFixed(1)` does not — eight real cells (Canary Wharf, Tottenham, Gao…) were uploaded to keys no browser ever requested. Never build a key with a bare `:.1f`; import this. |
| `r2_verify_prefix.py` | Proves an uploaded prefix matches a local directory byte-for-byte using ETags — one listing plus local md5sums, no downloads. Exits non-zero on any mismatch or extra object. |
| `run_with_r2env.py` | Runs a script with `r2.env` loaded, so `--upload-r2` works without `set -a; source r2.env` shell gymnastics (a subprocess that doesn't inherit the vars is the classic silent failure). |

### Typical runs

```bash
cd era5_pipeline
set -a; source r2.env; set +a          # or: .venv/bin/python run_with_r2env.py <script> ...

# monthly top-up — same command as a full run; complete tiles are skipped
.venv/bin/python download_cells.py --start-year 1950 --batch-years 20 \
    --parallel-tiles 2 --upload-r2

# one tile, one year (this is the shape a test or a repair should take)
.venv/bin/python download_cells.py --tile 11_26 --year 2026 --upload-r2

./topup_progress.sh                     # live console (hardcoded to the 2026 top-up log)
```

`VM_RUN.md` is the runbook for doing the long pull on a throwaway VM.

## R2 maintenance

| file | what it does |
|---|---|
| `r2_set_cors.py` | Applies the CORS policy the browser needs to read tier files cross-origin — the allowed origins are the list in the script; `--show` prints the live policy. Without it every tier reads as empty. `r2-cors.json` is the same list in wrangler's format, for `wrangler r2 bucket cors set` (see `../DEPLOY.md`). |
| `r2_set_cache_control.py` | Backfills per-tier `Cache-Control` on objects uploaded before the uploader set it — a metadata-only server-side copy, body untouched, safe to re-run. |
| `backfill_cache_control.py` | The one-shot threaded version of the same for the whole `archive` tier, with progress and an ETA. Skips objects that are already correct. |
| `prune_orphan_archives.py` | Lists (and with `--delete` removes) `archive/` objects whose cell is no longer in `cells.csv` — the leftovers of a drop or a move. Matches on rounded float tuples, so `-0.0` can't manufacture a false orphan. Dry-run by default. |

## Audits and one-off repairs

ERA5-Land being land-only means a cell's nearest gridpoint can be ocean.
`resolve_land_indices` snaps to the nearest land in the tile window — for years
with no distance cap, which is how "Flying Fish Cove, Christmas Island" shipped
West Java's climate from 350 km away. These scripts found, measured and fixed
that family of bugs; they are kept as the record and for the next `cells.csv`
change, not run routinely.

| file | what it did |
|---|---|
| `audit_coastal_snap.py` → `apply_coastal_snap.py` | Finding F1: all-blank coastal archives (a tight ~63 KB cluster on R2). The audit builds `coastal_snap_map.json`, the apply moves each cell onto its land gridpoint or drops it as a duplicate / no-land case. |
| `find_noland_cells.py` | Cells whose whole tile window is ocean (atolls like Male). The downloader correctly refuses to write them, but their absence made the resume check refetch the tile forever — so they are dropped from `cells.csv`. `--remove` does it. |
| `audit_snap_distances.py` | Measures, for every cell, where the snap actually lands and how far it moved — the data the 25 km cap was chosen from. Caches per-tile land masks so reruns are free. Output: `snap_audit.csv`. |
| `build_snap_rewrite_plan.py` → `verify_snap_rewrite.py` → `apply_snap_rewrite.py` | The 2026-08 rewrite: coordinates now point at the gridpoint the data actually comes from. Plan (`snap_rewrite_plan.csv`, the manifest) → verify against real bytes *before* touching R2 → apply in idempotent phases (`--copy`, `--write-csv`, `--deprecate`/`--delete-old`). Full write-up in `SNAP_REWRITE.md`. |
| `rename_snapped_cells.py` | Re-applies the naming rule at the 121 pins the rewrite moved — targeted, because a full `name_cells.py` rerun would undo the dedupe pass on 3,498 untouched cells. |
| `benchmark_zarr.py` | The measurement that chose the Zarr store over the CDS API, with `benchmark_zarr_results*.json` kept as the decision record. The two files straddle the `f5d84851` v3 migration: `benchmark_zarr_results.json` is the current `era5-land-v0.zarr` (re-measured 2026-09-01), `_prev.json` the frozen v2 `reanalysis-era5-land-no-antartica-v0.zarr` (2026-06-06). Same year, cities and method, and identical tmin/tmax to the last decimal — only the timings moved (97s → 120s wall, but two months and a different network apart, so treat that as two samples, not a controlled comparison). |

## Tests

`pytest` (from this directory; `pytest.ini` excludes the `integration` marker by
default — those hit the real store and R2 and need `~/.netrc` + `r2.env`).

Each file pins a bug that reached production once:

- `test_cell_keys.py` — the `-0.0` key mismatch between Python and JS.
- `test_land_snap.py` — nearest-land snap for coastal all-NaN archives.
- `test_local_day_bounds.py` — partial edge days at a span boundary, which merge
  over complete ones (Austin's 2025-12-31 tmax moved 20.4 → 15.9 that way).
- `test_merge_base.py` — a partial-history run must never replace 76 years in R2
  with the months it just fetched.

## Docs

- `VM_RUN.md` — running the full archive pull on a throwaway VM: sizing, RAM
  limits, resume, uploading straight to R2.
- `SNAP_REWRITE.md` — the 2026-08-25 coordinate rewrite: the audit, the 25 km
  cap, the per-action counts, what was verified.
- `STATUS.md` — historical: the CDS-era benchmarks and the reasoning that moved
  the pipeline to the Zarr store. Its "how to continue" section describes scripts
  that no longer exist; read it as a decision record, not instructions.
- `../ARCHITECTURE.md` — where the tiers meet and why the grid is ERA5-Land 0.1°.

## Files on disk

Tracked here: the scripts, the two runbooks, and the small artifacts that are
decisions rather than output — `coastal_snap_map.json`, `snap_rewrite_plan.csv`
(the coordinate remap table), `mover_provenance.csv` (per-mover verification
that the new gridpoint reproduces the shipped archive), `r2-cors.json`,
`benchmark_zarr_results*.json`.

Not tracked (see `.gitignore`): `.venv/`, `.cdsapirc` and `r2.env` (credentials
— `R2_ACCOUNT_ID`, `R2_ACCESS_KEY_ID`, `R2_SECRET_ACCESS_KEY`), the GHS-POP
raster and its PDF, `snap_audit.csv` + `snap_audit_masks/`, and per-run artefacts
(`topup_*.log`, `*.pid`, `gap_*.txt`, worklists). The pipeline's actual output
lives outside this folder in `../data/era5-land/` — a local cache; R2 holds the
real thing. `../data/cells.csv` is the one data file in git, and ships to the
browser as a static asset.

## Rules that aren't obvious from the code

- **Never run `download_cells.py` without an exact tile × year scope and explicit
  approval.** A careless full run is a very large number of requests against a
  metered store.
- **Never re-run `name_cells.py` over the whole grid** to fix a few names. A full
  rebuild is *not* idempotent — it drifts ~570 names and regresses precise ones
  ("Barcelona" → "Sant Martí"). Patch targeted pins, as
  `rename_snapped_cells.py` and `name_coord_cells.py` do.
- **Re-run `../debias/make_cell_elevation.py` after any `cells.csv` change** —
  elevation is a model feature and must come from ERA5-Land's own geopotential.
- **A VM is rsync'd, not a git checkout.** Diff its scripts against local HEAD
  before running anything there.
- **Nothing here deploys.** Shipping data is an upload plus, for `cells.csv`, a
  Pages deploy — see `../DEPLOY.md`.

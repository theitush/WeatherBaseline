# WeatherBaseline

**[www.weatherbaseline.com](https://www.weatherbaseline.com)** — how hot was it,
really?

Pick a place and a date and the site answers two questions: what the weather did
that day, and how that compares with every other version of that day since 1950.
"28.4 °C" means little on its own; "warmer than 94% of August 30ths on record
here" is the number that carries the meaning.

The historical record is **ERA5-Land**, ECMWF's reanalysis: a modern physics
model run backwards over the observational record (stations, balloons, ships,
satellites) to reconstruct a gap-free estimate of what the weather actually did,
on a fixed 0.1° grid (~11 km), daily, 1950→present. A searched city snaps to the
nearest grid-cell centre rather than being interpolated, so the value shown is a
real cell.

A reanalysis cannot cover the present — ERA5-Land lags real time by days for
temperature and by up to a month for precipitation and wind. Those days, and the
few ahead, come from **ECMWF's IFS HRES** forecast instead, passed through a
debiasing model that maps the raw forecast onto the distribution the ERA5-Land
record would have shown. The chart marks which points are reanalysis and which
are forecast.

## How it runs

Four pieces, all on Cloudflare, deployed manually (`git push` does not ship
anything — see [`DEPLOY.md`](DEPLOY.md)):

| Piece | What it does |
|---|---|
| **Frontend** (`frontend/`) | React + Vite, hosted on Cloudflare Pages. Fetches the data files **directly from R2** — reads never touch the Worker. |
| **Data plane** (R2, public at `data.weatherbaseline.com`) | Per-cell `.csv.gz` files in three tiers — `archive/` (ERA5-Land, edge-cached for a day), `recent/` and `forecast/` (volatile, `no-store`) — plus the static `debias-vN/` correction tables. |
| **Worker** (`worker/`) | The whole control plane: `/api/ensure-fresh` tops up the `recent`/`forecast` tiers from Open-Meteo on demand, `/api/geo` gives a starting location, `/api/health` is liveness. |
| **Pages Functions** (`functions/`) | Crawler-only rewrite that injects social-card meta tags. |

[`ARCHITECTURE.md`](ARCHITECTURE.md) has the full design, including why the grid
is ERA5-Land 0.1° and where the tier seams sit.

Three supporting projects sit alongside the app:

- **`era5_pipeline/`** — builds and maintains the archive: selects the ~8.6k
  populated 0.1° cells, names them, pulls daily ERA5-Land values from the
  EarthDataHub Zarr store, and uploads per-cell tier files to R2. Resumable;
  the R2 copy is the source of truth, on-disk data is a cache.
- **`debias/`** — the study behind the forecast correction. Pulls matched
  IFS-HRES and ERA5-Land history, trains per-cell quantile models, and bakes
  them into the static `debias-vN/` tables the frontend reads. Notebooks are
  kept with their outputs as the write-up; the models and data slices are not
  in git (regenerable, hundreds of MB).
- **`analytics/`** — small scripts that query Cloudflare's zone analytics and
  the Worker's own D1 hit table. Entirely optional (see below).

## Quick start

Needs **Node 22** and a Cloudflare account that owns the `weather-baseline` R2
bucket — dev runs all code locally but reads and writes the **real** R2 data, so
there is no second data implementation to keep in sync.

```bash
cd worker && npx wrangler login   # first time only
cd frontend && npm install        # first time only
```

Two terminals from the repo root:

```bash
npm run dev            # Worker on :8787 (wrangler dev --remote, bound to live R2)
npm run dev:frontend   # Vite on :5173
```

Then open <http://localhost:5173>. Vite proxies `/api/*` to the local Worker;
data files load straight from R2 (`VITE_DATA_BASE`, committed in
`frontend/.env`). `npm run dev:all` runs both in one terminal.

Two things that look like bugs and aren't: `wrangler dev` needs `--remote`
(plain local Miniflare would give you an empty, separate R2 store), and
`/api/geo` locally geolocates the dev tunnel's egress rather than you — the
frontend only uses it as a best-effort first guess.

Production build smoke test:

```bash
cd frontend && VITE_API_BASE=<worker-origin> npm run build   # → ../dist
```

### Python

Everything Python — pipeline, debias study, analytics, notebook kernels — runs
from one virtualenv, `era5_pipeline/.venv` (Python 3.12), and is invoked by
explicit path rather than by activating it:

```bash
python3.12 -m venv era5_pipeline/.venv
era5_pipeline/.venv/bin/pip install -r era5_pipeline/requirements.txt
era5_pipeline/.venv/bin/python era5_pipeline/download_cells.py --help
```

Credentials live in gitignored env files, never in the repo: R2 S3 keys in
`era5_pipeline/r2.env`, the Copernicus key in `.cdsapirc`, the Cloudflare
analytics token in `analytics/cloudflare.env`.

### Analytics is optional

The Worker records a row per page view in D1 and serves a dashboard behind
`DASHBOARD_TOKEN`. Both are optional: with no D1 binding and no token
configured the code is inert — nothing is recorded, the dashboard is closed, and
the site works exactly the same. A fork gets no analytics unless it deliberately
provisions them.

## Data and attribution

- **ERA5-Land** — Copernicus Climate Change Service (C3S) / ECMWF, generated
  using Copernicus Climate Change Service information. Distributed under the
  [Copernicus licence](https://apps.ecmwf.int/datasets/licences/copernicus/);
  neither the Commission nor ECMWF is responsible for any use of it here. This
  project reads the Zarr build of the store published via
  [EarthDataHub](https://earthdatahub.destine.eu/).
- **Open-Meteo** — the `recent` and `forecast` tiers, and the IFS-HRES history
  used in the debias study, come through [Open-Meteo](https://open-meteo.com/),
  licensed [CC BY 4.0](https://creativecommons.org/licenses/by/4.0/).
- **GHS-POP** (Global Human Settlement Layer, European Commission JRC) — used
  once, to rank grid cells by population and pick which ones to store.
- **GeoNames** ([CC BY 4.0](https://creativecommons.org/licenses/by/4.0/)) and
  **Photon** / OpenStreetMap (data © OpenStreetMap contributors,
  [ODbL](https://opendatacommons.org/licenses/odbl/)) — used to give each grid
  cell a human-readable name.

The curated cell list, `data/cells.csv`, is the one data file in git; it ships to
the browser as a static asset so the app can turn coordinates into place names
without a round trip.

## Licence

MIT — see [`LICENSE`](LICENSE). The licence covers this repository's code; the
datasets above carry their own terms.

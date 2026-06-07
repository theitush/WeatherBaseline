# HowHotWasIt — v2 architecture (data & serving)

Status: **shipped** (on `main`, deployed). Grid decision **RESOLVED
2026-06-03** — see "✅ GRID DECISION" below. Replaced the original v1 Node
fetch-everything (`/api/archive`) model; the control plane is now the
Cloudflare Worker in `worker/src/`, which both prod and local dev run.

## ✅ GRID DECISION (resolved 2026-06-03)

**Canonical grid = ERA5-Land 0.1°.** We query Open-Meteo per cell and let each
endpoint snap to its own grid via `cell_selection=nearest` — that is good enough;
no regridding or recalculation on our side.

- **Archive + recent temp** → `models=era5_land` (exact 0.1° match, invisible seam).
- **Recent precip/wind** → `historical-forecast` API (IFS family). Same single-source,
  24h-TTL logic as recent temp; just a different model because `era5_land` returns
  `null` for precip/wind. This is **intentional, not provisional** — the earlier
  "rejected provisional hack" framing is retired.
- **Forecast (all 4)** → `models=ecmwf_ifs` (IFS HRES). Snaps to its own ~9 km grid
  (~2.7 km offset from our 0.1° point at mid-latitudes) on either grid choice, so
  the forecast tier never matches the storage grid regardless — accepted.

**DEFERRED (much later): cross-model bias.** The three sources sit on three physical
grids/models (era5_land 0.1°, historical-forecast ~0.0625°, IFS HRES O1280), so
precip/wind carry a model bias at the archive↔recent seam and forecast carries one
at the recent↔forecast seam. Quantifying and bias-correcting this is a **future
task**, not a blocker for shipping v2.

The original decision write-up (G1 vs G2) is kept below for history.

---

## (historical) ⛔ OPEN DECISION: the grid

The whole v2 design assumed archive + recent could BOTH be ERA5-Land 0.1° so the
seam is invisible. While wiring `recent` we hit a hard wall, confirmed against
Open-Meteo's docs + live API on 2026-06-03:

**ERA5-Land (the only 0.1° model) serves TEMPERATURE ONLY via Open-Meteo — it
returns `null` for precipitation_sum and wind_speed_10m_max.** (CDS's
`derived-era5-land-daily-statistics` also *rejects* accumulated precip; the
producer's pipeline only gets precip/wind by pulling raw hourly zarr and
aggregating locally — not feasible behind an on-demand gate.)

Open-Meteo model/grid/variable matrix (verified 2026-06-03):

| Model | Grid | Temp | Precip | Wind | Coverage |
|---|---|---|---|---|---|
| ECMWF IFS (HRES) | 9 km (~0.09°) | ✓ | ✓ | ✓ | 2017→present + forecast |
| ERA5 | 0.25° (~25 km) | ✓ | ✓ | ✓ | 1940→present |
| **ERA5-Land** | **0.1° (~11 km)** | ✓ | **✗** | **✗** | 1950→present |
| ERA5-Ensemble | 0.5° | ✓ | ✓ | ✓ | 1940→present |
| CERRA | 5 km | ✓ | ✓ | ✓ | Europe, 1985→Jun 2021 |

Decision required (user: **everything must be on ONE grid, all tiers, all
metrics**):

- **Option G1 — ERA5 0.25° for all tiers + all metrics.** One model family end to
  end (ERA5 archive+recent, IFS its forecast arm), all 4 metrics, all instant via
  API. Truly seamless. Cost: 25 km not 11 km; **the ERA5-Land 0.1° zarr pipeline
  + the archive files currently downloading become unused.**
- **Option G2 — keep ERA5-Land 0.1°, temperature-only forever.** Finer grid, but
  precip/wind cannot exist; also note there is **no 0.1° forecast model**, so even
  the forecast tier's grid is unresolved under G2.

RESOLUTION (2026-06-03): chose **ERA5-Land 0.1°** (was Option G2, accepting the
split-source recent as intentional rather than rewriting to a single grid). The
split-grid recent in `worker/src/ensureFresh.js` is the shipping design. The residual
cross-model bias (IFS 9km ≠ ERA5-Land 0.1° ≠ historical-forecast — three physical
grids; `cell_selection=nearest` only makes each pick deterministic) is a **deferred
task**, see "✅ GRID DECISION" above.

---

Original plan (pre-grid-wall) follows; the seam reasoning below assumed
archive+recent both era5_land 0.1°, which the wall above breaks for precip/wind.

## Goal

Serve a full daily weather timeline per location — ~1950 to a few days into the
future — as **fast and simple** as possible, with **minimal server** and the
**Open-Meteo call budget as the binding constraint** (not compute, storage, or
traffic). Historical weather is static and read-only, so the heavy 99% needs no
server at all; only the recent tail does any live work.

## The timeline has three zones

Each calendar day belongs to exactly one *source*, decided purely by its age
(Open-Meteo gives **no flag** distinguishing settled vs. forecast — only the
date relative to today).

```
1950 ─────────────────── ~6 months ago ──── ~5 days ago ── today ── +3d
│                              │                  │                   │
└────── ARCHIVE ───────────────┤                  │                   │
        ERA5-Land 0.1°          │                  │                   │
        (pre-built, immutable)  └──── RECENT ──────┤                   │
                                     ERA5-Land 0.1° └──── FORECAST ─────┘
                                     (lazy append)       model, ~2–9km
                                                         (lazy rewrite)
```

| Zone | Span | Source | Resolution | Mutability |
|---|---|---|---|---|
| **archive** | 1950 → ~6mo ago | ERA5-Land zarr pull (our pipeline) | 0.1° | immutable |
| **recent** | ~6mo ago → ~5 days ago | Open-Meteo Historical Weather API, **`models=era5_land`** | 0.1° (same grid!) | append-only |
| **forecast** | ~5 days ago → +3 days | Open-Meteo **Forecast API** | model (2–9km) | rewritten |

### Why these exact sources

- **Archive and recent are BOTH ERA5-Land at 0.1°.** The recent tier MUST pass
  `models=era5_land` to the Historical Weather API — the default ("Best match")
  can return ERA5 at 0.25° (~25km) or another model, which would put a
  resolution *and* grid discontinuity at the 6-month seam. Forcing `era5_land`
  makes archive↔recent the same model on the same cell centres: the seam is
  effectively invisible.
- **ERA5-Land has a ~6-day publish lag** (measured 2026-06-02: the most recent
  settled day was 6 days back, uniform across NYC/London/Tokyo/Sydney/Nairobi —
  a global publish frontier, not per-cell) and arrives *already final* — there is
  no preliminary/revising state to wait out. So a day is either "not published
  yet" (forecast owns it) or "published & final" (cache once, never touch).
  This is why **recent is append-only**. (ERA5T→final consolidation
  months later can nudge a value negligibly; it's absorbed on the next archive
  rebuild — we do not chase it.)
- **The only real resolution discontinuity is the ~6-day forecast↔recent
  boundary**, always near "today", and it self-heals: each day, as it crosses
  the publish frontier, its ERA5-Land value supersedes the forecast guess.

## Storage — R2, three files per cell (Layout 3)

Files are keyed by **snapped lat_lon** on the fixed 0.1° ERA5-Land grid
(`round(coord*10)/10`), matching the existing `weather_hist_{lat}_{lon}`
convention. Per cell:

- `archive_{lat}_{lon}.csv.gz`  — immutable; long CDN TTL; written once by the pull.
- `recent_{lat}_{lon}.csv.gz`   — append-only; ~daily writes; short TTL.
- `forecast_{lat}_{lon}.csv.gz` — rewritten; 12h TTL; smallest, most volatile.

Schema (all tiers): `date,tmax_C,tmin_C,precip_mm,wind_max_ms` (keep all 4
metrics). `.csv.gz` — browsers
auto-gunzip via `Content-Encoding: gzip`.

Three files instead of one so the **immutable archive is cached forever** and
only the tiny volatile files get rewritten — minimizing both R2 writes and
Open-Meteo calls. Reads go **direct to R2 / CDN, never through a Worker**, so
file reads don't consume the Worker request budget.

## Serving — Option A (gate), for now

The frontend calls a thin **"ensure-fresh"** backend endpoint before reading.
This keeps the freshness thresholds in one place (server-side) and the frontend
dumb. Chosen over Option B (frontend self-checks `Last-Modified`, calls backend
only when stale) for simplicity; **revisit at ~100K views/day** — see Scaling.

Backend `ensure-fresh(cell)`:
1. forecast file `Last-Modified` older than **12h** → 1 Forecast API call
   (`past_days=9&forecast_days=3`) → rewrite `forecast_*.csv.gz`.
2. recent file `Last-Modified` older than **24h** → 1 Historical Weather API
   call (`models=era5_land`) for the day(s) that newly crossed the ~6-day
   frontier → **append** to `recent_*.csv.gz` (append-by-date, last-wins, so a
   skipped run self-heals without making re-fetch the normal path).
3. The backend **never reads or serves the archive**.

The forecast call spans **−9 to +3 days from today** in one request
(`past_days` and `forecast_days` combine into one continuous daily array — one
call, not two). `past_days=9` is deliberately wider than the measured ~6-day
ERA5-Land lag so forecast always **overlaps** recent by ~3 days — no gap at the
boundary even if the lag slips to 7–8; the overlap is harmless because the
frontend merge prefers recent.

### Open-Meteo call budget (the real bottleneck)

Per **active** cell per day, independent of view count:

| | calls/refresh | cadence | calls/cell/day |
|---|---|---|---|
| forecast | 1 | 12h | 2 |
| recent | 1 | 24h | 1 |
| **total** | | | **≤ 3** |

Cells nobody views cost zero. If the budget is ever hit, the levers are: widen
the 12h/24h windows, or cap distinct cells refreshed per day.

## Frontend

1. Snap clicked location to the 0.1° grid → build the three filenames.
2. Call backend `ensure-fresh(cell)` → wait for "ready".
3. Fetch `archive`, `recent`, `forecast` `.csv.gz` directly from R2/CDN.
4. **Merge by date, last-wins, in priority order:**

   ```
   archive (era5_land)  ─┐
   recent  (era5_land)  ─┼─► recent overrides forecast on overlap;
   forecast (model)     ─┘   forecast only fills dates recent/archive don't reach
   ```

   So a day shown as "forecast" is replaced by its real ERA5-Land value once it
   ages past the 5-day frontier and the next 24h append picks it up.

The original v1 `/api/archive` fetch-and-cache model (1940→now per location) is
**retired** — its job shrank to the thin tail-only `ensure-fresh` Worker.

## Scaling note — A → B later

Under A, the 12h/24h thresholds live in the backend, so moving to **B** when
traffic grows is a frontend-only change: read each file's `Last-Modified`,
compare to the thresholds, and call `ensure-fresh` **only when stale** instead
of on every view. No data, format, or storage change. Free-tier ceilings
(Cloudflare Workers, 100K req/day): **A ≈ 100K views/day, B ≈ 1M views/day**
(R2 egress is free; storage/ops are roomy). Switch when A approaches its wall.

## Producer gap (separate from serving)

The pipeline that builds the `archive` files isn't finished — see
`scripts/era5_pipeline/STATUS.md`. `download_cells.py` currently writes plain
`.csv` keyed by `cell_id` for only 9 test cells × 1 year. To feed this
architecture it needs to:

1. emit `archive_{lat}_{lon}.csv.gz` (gzip + snapped-lat_lon naming, not `cell_id`),
2. run the full 1950–2025 pull over all 337 tiles / 10K cells,
3. upload the results to R2.

## Open items

_(both confirmed 2026-06-02 against the live API/store)_

- ~~Confirm the ERA5-Land availability lag~~ **Confirmed ~6 days** (not 5),
  uniform across 5 globally-spread cells via Open-Meteo `models=era5_land` —
  a global publish frontier. `past_days` bumped 7→9 to keep a ~3-day
  forecast↔recent overlap with margin if the lag slips to 7–8.
- ~~Confirm `tp/u10/v10` exist~~ **Confirmed** in the no-Antarctica zarr store:
  `t2m/tp/u10/v10` all present, `float32`, 64×64 spatial chunks (6.4° tiles).
  Two corrections to assumptions:
  - Time chunks are **2880 h = 120 days**, so a year crosses **4** of them
    (boundaries unaligned to Jan 1) — the "4-time-chunk/year" figure is right;
    STATUS.md's "3 time-chunks/year" was stale (its budget code already uses 4).
  - The store's latitude axis is **1472 cells (90° → ~−57.1°)**, not the full
    1801 to −90° — it omits the deep south. `select_cells.py:era5_grid()` still
    builds the full 1801-cell grid; cells below ~−57° have no data here (no
    populated top-N cell is that far south, so selection is unaffected).

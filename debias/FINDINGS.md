# Bias study — findings

> Living log of confirmed findings from the ERA5-Land baseline vs IFS-HRES
> forecast bias study. **Nothing is added here without explicit sign-off.**

---

## Finding 1 — Empty archive data at some coastal cells (ERA5-Land land/ocean snap bug)

**Severity:** data-integrity bug in the live archive (R2). Affected cells render
a meaningless climatology in the app.

### What we observed
Two pilot cells had completely degenerate archive data in R2 (bucket
`weather-baseline`):

| City | Cell (snapped 0.1°) | tmax/tmin/wind | precip |
|------|---------------------|----------------|--------|
| Edinburgh | 56.0, -3.2 | all empty | all `0.0` |
| Wellington | -41.3, 174.8 | all empty | all `0.0` |

All 27,879 daily rows (back to 1950) exist but carry no usable values. Verified
directly against R2 (not just the local copy).

### Root cause
ERA5-Land is a **land-only** reanalysis: grid cells over water are `NaN` by
design. The grid is 0.1° (~11 km). Both cities sit **on the coastline**
(Edinburgh on the Firth of Forth, Wellington on its harbour), so the snapped
0.1° gridpoint lands **just offshore — on an ocean cell with no data.**

The download pipeline (`era5_pipeline/download_cells.py`) selects the
gridpoint with `method="nearest"`, which returns the *geometrically* nearest
cell even when that cell is an ocean `NaN`. It does not fall back to the nearest
cell that actually has land data. So it extracted the empty ocean cell and wrote
blank rows.

**The city coordinates in `cells.csv` are correct.** This is purely an
extraction-snap problem: a coastal point's nearest grid cell can be water.

### Verified fix path (data exists, one cell away)
Probing the EarthDataHub zarr store directly (auth via `~/.netrc`, `trust_env`),
the real land data sits one grid cell (~11 km) away and is fully populated:

| City | Nearest LAND cell | Offset | Sample (2020-06-14..16 hourly t2m) |
|------|-------------------|--------|-------------------------------------|
| Edinburgh | 56.1, -3.2 | 1 cell | 11.1 .. 17.1 °C, all finite |
| Wellington | -41.2, 174.8 | 1 cell | 5.9 .. 13.4 °C, all finite |

A **nearest-land snap** (build a land mask from finite t2m on a mid-record day;
for any NaN cell, fall back to the closest finite neighbour) recovers real data.

### Scope / open question
This is unlikely to be limited to these two cells — **any coastal city whose
snapped 0.1° point lands offshore is affected.** Blast radius across the full
~10K cell list is **not yet measured** (audit pending sign-off).

### How it was found
The bias-study notebook's data-integrity cell (Section 0) flags any (cell, var)
whose baseline has near-zero variance and drops it from the stats. That auto-flag
surfaced Edinburgh and Wellington.

---

## Finding 2 — Clipped boundary day: partial local-day aggregation at the archive frontier

**Severity:** data-integrity bug in the archive. The last local day of every
east-of-UTC cell (and the first day of west-of-UTC cells) is computed from an
incomplete set of hours and written as if complete. Silently wrong — looks like
a valid value.

### Root cause
ERA5-Land publishes hourly data on a single **UTC** clock; the store ends at a
hard UTC hour (currently ~2026-04-30 23:00 UTC). We compute daily
tmax/tmin/precip/wind over the **local solar day** by shifting the UTC time axis
by the cell's solar offset before `resample("1D")`
(`download_cells.py` ~L499–512).

`xarray`'s `resample("1D").max()` aggregates over **whatever hours fall in each
bucket — even just a few.** There is **no completeness guard**: no hour count, no
"drop buckets with < 24 hours," no trim of the partial boundary bucket. So when
the local-day shift pushes the last bucket past the UTC data frontier, the daily
value is built from a **truncated day** and written as a normal row.

- **East of UTC (offset > 0):** the local day runs ahead of UTC, so the trailing
  bucket loses its late hours → clipped tmax/tmin, under-counted precip.
- **West of UTC (offset < 0):** same artifact on the *first* day (1950 — low
  impact).
- The precip de-accumulation (`tp_incr`, L473–479) also drops the first step,
  compounding the edge.

### Evidence
The clipped day leaks one row **past** the true UTC frontier for east cells:

| Cell | Solar offset | Archive tail | Boundary row |
|------|--------------|--------------|--------------|
| London | +0 | ends 2026-04-30 (correct) | — |
| Beijing | ~+8 | has a **2026-05-01** row | `tmax=15.5°C` |
| Singapore | ~+7 | has a **2026-05-01** row | `tmax=27.1°C` |

Beijing's late-April real tmax is ~24–28°C; the trailing **2026-05-01 tmax of
15.5°C** is an early-morning-only value — the bucket held just the first few
local hours (which map to the last available UTC hours of Apr 30), so the "daily
max" is really a pre-dawn temperature. The error on a clipped boundary day is
easily several °C and is whatever direction the dropped hours mattered (tmax
clipped low, tmin can be clipped high, precip under-summed).

This is the same family as the earlier local-day archive fix, but at the
*frontier* rather than off-UTC bucketing — and it was baked into the archive by
the local-day rerun, so every cell carries a wrong final boundary day.

### Fix path (not yet applied)
After the shifted `resample("1D")`, **drop incomplete buckets**: also compute
`.count()` per bucket and mask/trim any day with fewer than 24 hours (equiv.:
drop the trailing partial local day east of UTC and the leading one west of it).
A few lines at `download_cells.py` ~L508–513. Then re-pull affected cells with
`--overwrite --upload-r2`.

### Scope
Affects **every cell** (each has one clipped boundary day). The live frontier day
is re-clipped on each archive extend; the rolling `recent` tier comes from
Open-Meteo (which handles local days itself) so it is not subject to this — the
bug is in our own archive extraction only.

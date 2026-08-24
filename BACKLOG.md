# Backlog

Items that are scoped and researched but not started. Each carries enough
measured evidence to be picked up cold.

---

## Perceived heat & perceived cold (apparent temperature)

**Status:** UX prototype COMMITTED on branch `felt-lens` (f758a316 + follow-ups),
deliberately kept OFF `main`: the lens defaults ON with invented humidity, so on
`main` any routine Pages deploy would ship fabricated numbers as the landing
experience. Merge only after the archive rerun and the felt-variable debias run
below. The compare page is explicitly OUT OF SCOPE for the lens (decided
2026-08-24) — it always shows measured air temperature and its axis says so.

Add two metrics that shadow the two we already ship: an apparent max alongside
`tmax_C`, an apparent min alongside `tmin_C`. Humidity is never displayed as its
own number — the gap between actual and apparent *is* the humidity readout, in
units people feel.

### Design settled so far

- **Shadow, don't switch.** `apparent_max` pairs with tmax, `apparent_min` pairs
  with tmin. This beats a single year-round `feels_like` that flips between
  indices at a threshold — no threshold to defend, and the irrelevant one simply
  sits at ~0 (see the complementarity table below).
- **Both indices apply to BOTH metrics (revised 2026-08-24).** The pairing above
  is about which index is usually *material* per metric, not which is
  *applicable*, and reading it as the latter drops two real cases: a windy −8 °C
  winter **day**, whose high would get no adjustment at all, and a muggy 27 °C
  tropical **night**, which is exactly when heat becomes dangerous (measured in
  the prototype: Delhi 2025-06-20 tmin 27.1 °C → felt 33.3 °C). The two indices
  are defined on disjoint ranges — heat index at/above 26.7 °C (80 °F), wind
  chill at/below 10 °C with V ≥ 4.8 km/h — so they can never both be active for
  one value. "Run both, take whichever is in range" is therefore a single
  well-defined function of (T, dewpoint, wind), not a threshold to defend.
  Between 10 and 26.7 °C neither applies and apparent = air temperature.
- **Known floor:** NWS heat index is undefined below 80 °F, so a humid night at
  25–26 °C gets no bump even though it plainly feels worse than a dry one at the
  same temperature. Steadman's apparent temperature would cover that band. Live
  with it, or revisit the index choice specifically for the tmin slot.
- **The two indices are SETTLED (2026-08-24):**
  - heat — **NWS heat index** (Rothfusz), from temperature + RH
  - cold — **wind chill** (JAG/TI 2001), from temperature + 10 m wind

  Both are computable from `t2m, d2m, u10, v10` and nothing else — no radiation.
  Wind chill is valid for T ≤ 10 °C and V ≥ 4.8 km/h; ERA5-Land `u10`/`v10` are
  already at the correct 10 m reference height. See the footnote on rejected
  alternatives before reopening this.
- **Clamp each index to its own direction.** Each can return a value on the wrong
  side of air temperature outside its valid range, which renders as "it felt 2.8°
  cooler than it was" — a formula artifact, not a perception. Heat index may only
  push UP, wind chill only DOWN: `max(T, heat_index)` and `min(T, wind_chill)`
  respectively, applied per the range gate above. Not an edge case: NWS HI falls
  below air temperature on 99% of Madrid days and 90% of Phoenix days, since dry
  air sits under its valid range. In the UI this is a feature — Phoenix's dry
  heat shows *no gap at all*, which is the "but it's a dry heat" argument settled
  on screen.
- ⚠️ **Heat numbers in this document were measured with humidex**, before the
  index decision. The structure holds — which cities, which traps, the
  complementarity — since both indices are monotone in T and moisture. The
  magnitudes shrink: humidex ran +2.7 to +7.7 °C hotter on the hottest decile
  (Chicago +7.7, Singapore +6.4, Tokyo +4.4, Phoenix +2.7). Re-measure before
  quoting any specific figure to users.
- RH for display, if ever wanted, is `100 · es(Td)/es(T)` with Magnus
  `es(T) = 6.112·exp(17.67·T/(T+243.5))` — verified against Open-Meteo's own
  `relative_humidity_2m` to ≤0.5 pp at every hour. It must be evaluated at the
  temperature it is shown next to: at Tel Aviv's Tmax hour RH was 32% while the
  daily *mean* RH was 58%.

### UX — resolved 2026-08-24 by a local prototype

Question 1 below ("permanent slots vs. conditional") is answered: **neither — it's
a lens.** A settings toggle rewrites what Max/Min Temperature *mean*, so charts,
histograms, percentiles, records and the prose verdict all recompute against felt
climatology. "Top 5% hottest" then means top 5% of *felt* days. No new metric
buttons, no new card slots, and precipitation/wind are untouched.

Making it unmistakable without shouting — four signals, quietest first:

1. The card's lead sentence changes verb: "…max temperature in Tel Aviv **is**"
   → "**felt like**". Prose carries it; no badge, no colour.
2. A hairline ghost tick on the record spectrum marks the measured air
   temperature, labelled `30.7° actual`. The gap between the two ticks *is* the
   humidity (or the wind), read out in degrees. Hidden below 0.5 °C, so a dry
   calm day self-explains as "it felt like what it was".
3. Chart axes switch to "Felt Max Temp (°C)", so a chart read on its own still
   says what it's measuring. **"Felt", not "apparent"** — apparent temperature is
   the correct term (WMO, BoM) but reads as "seeming/ostensible", the wrong
   connotation for a number we assert is real. Keep the technical name for the
   tooltip and FAQ, where the indices can be named.
4. The settings toggle stays lit while on, unlike the theme/units buttons, which
   are symmetric A/B flips.

Tried and dropped: an `≈` marker on the metric pills. Too cryptic to earn the
space once the axis label was doing the same job.

**Architecture the prototype settled on:** both readings — air and apparent — are
computed for every row ONCE at load (`computeApparent`), and the toggle is a pure
re-projection of rows already in memory (`projectLens`): zero network requests in
either direction, verified. In the shipped version the apparent columns arrive in
the tier CSVs and `computeApparent` simply disappears; the projection stays.
Rows carry `air_max`/`air_min` + `apparent_max`/`apparent_min`, and
`max_temperature`/`min_temperature` are the *displayed* projection of one pair —
which is why no chart, statistic or verdict needed a per-component change. Bands
are carried in both forms (`air_band`/`apparent_band`) and swapped alongside.
The lens **defaults ON**: what a day felt like is the question people arrive with.

**Prototype status:** committed on branch `felt-lens`,
`frontend/src/services/feelsLike.ts` + `hooks/useFeelsLike.ts` + wiring. Wind is
real-ish (stored `wind_max_ms` × an invented 0.6 mean-from-max factor);
**dewpoint is INVENTED** from the diurnal range, because the archive rerun below
hasn't happened. It gets the archetypes right (tropics muggy, desert clamped to
zero gap) and reads several degrees too dry for a continental summer. No number
in it means anything — do not tune thresholds against it. In the shipped version
all of this mock plumbing is deleted: `apparent_max` / `apparent_min` are just
two more columns in the tier CSVs, fetched with the page like every other metric.

The lens state is pinned in the URL as a trailing `felt`/`air` segment on the
temperature metrics (`/lat,lon/date/tmax/felt`) so a shared link reproduces the
sharer's numbers; the segment trails the metric because the Worker's analytics
derive the metric from the token position and the crawler middleware reads only
the first three segments. Arrival hits and in-app metric/lens changes therefore
log the lens state with no worker changes.

### Still open

1. ~~Permanent card slots vs. conditional surfacing~~ — answered above.
2. **Felt-variable debias run.** The forecast/recent CQR bands are trained on
   air temperature. The prototype translates them by the felt−air delta (delta
   treated as known) — acceptable for judging UX, not for shipping: the real
   version needs its own quantile-debias training on `apparent_max` /
   `apparent_min` (same pipeline as [scripts/bias_study], new target variables),
   plus hourly forecast inputs in the Worker's ensure-fresh path so the index is
   formed before the daily aggregation on the live tiers too. Acknowledged
   2026-08-24; not yet scoped or costed.
### Why the gap earns its slot

Full-year 2025, humidex vs tmax and wind chill vs tmin:

| city | heat: days >3 °C | heat gap, hottest decile | cold: days >3 °C | cold gap, coldest decile |
|---|---|---|---|---|
| Lagos | 100% | +12.3 | 0% | 0.0 |
| Singapore | 100% | +11.2 | 0% | 0.0 |
| Delhi | 62% | +5.7 | 0% | 1.1 |
| Tel Aviv | 56% | +6.5 | 0% | 0.2 |
| Tokyo | 45% | +9.3 | 18% | 3.2 |
| Chicago | 30% | +8.4 | 53% | 9.2 |
| London | 16% | +3.2 | 19% | 3.2 |
| Phoenix | 13% | +0.3 | 1% | 2.0 |
| Moscow | 12% | +2.6 | 45% | 5.4 |
| Calgary | 2% | −0.0 | 44% | 6.9 |
| Reykjavik | 1% | +1.5 | 43% | 3.7 |

The two partition cleanly — nearly every city needs exactly one. Chicago is the
rare city that needs both. Judge the metric on the **decile** column, not the
median: this is a percentile-ranking product, so users arrive on extreme days,
which is exactly where the gap is 6–12 °C. It also quantifies "but it's a dry
heat" honestly — Phoenix's hot-decile gap is +0.3 °C, Tokyo's is +9.3 at a lower
actual temperature.

### Traps — measured, do not re-propose

`max(f(x,y)) ≠ f(max x, max y)`. A nonlinear composite has to be computed
**before** the daily aggregation, not after. Combining each variable's daily
extreme synthesises an hour that never happened, and the error flatters the
headline in both directions.

- **`humidex(tmax, max dewpoint)`** — worst heat estimator tested. Biased high
  *everywhere*: +2.4 Phoenix, +2.5 Madrid, +2.3 Tokyo, p95 up to 6.5. Max
  dewpoint lands pre-dawn (shallow nocturnal boundary layer); by afternoon deep
  mixing entrains dry air aloft. On the Tel Aviv reference day Td peaked at
  01:00, coincident with the day's *minimum* temperature.
- **`wct(tmin, wind_max_ms)`** — computable from what we already store, and the
  worst cold estimator. Biased −1.0 to −3.1 °C (overstates cold), p95 to 6.4.
  The coldest hour is the windiest hour **0–5% of the time**: tmin happens
  *because* the night went calm and clear and radiated.
- **"Just use a fixed hottest hour."** The modal Tmax hour spans 14:00–17:00 and
  concentration varies wildly — Nairobi 93% within ±1 h, Chicago only 48%,
  Reykjavik 51%. More decisively it saves nothing; see the chunking note below.

Fallback quality if a full hourly pass is ruled out (pairs with stored tmax):

| estimator | bias range | p95 range |
|---|---|---|
| Td mean 12:00–18:00 local | +0.23 … −0.41 | 0.40 – 1.72 |
| Td @ 14:00 | +0.39 … −0.34 | 0.34 – 1.59 |
| Td mean 24 h | +0.61 … −0.54 | 1.17 – 1.99 |
| Td max 12:00–18:00 | +0.84 … −0.07 | 0.78 – 2.66 |

Afternoon-mean dewpoint is the sweet spot and degrades gracefully in the
diffuse-Tmax cities where a fixed hour fails. `solar_offset_hours` /
`shift_time` in `download_cells.py` already bucket by local hour.

---

## Archive rerun for hourly-derived metrics

**Status:** year range DECIDED 2026-08-24 — **full history 1950–2026** (~54 h,
17.5 TB at `--parallel-tiles 4`). Full history is the whole point of the app; the
1991–2020 row in the cost table below is kept for reference only. Still needs an
exact tile×year scope + explicit approval before any run, per the standing rule.

Both new metrics need hourly inputs we currently discard after reducing to daily.

### Do it in ONE pass

| goal | variables to pull |
|---|---|
| perceived heat alone | `t2m, d2m` (2) |
| perceived cold alone | `t2m, u10, v10` (3) |
| **both, one pass** | **`t2m, d2m, u10, v10` (4)** |
| both, separate passes | 5 var-pulls + a second full traversal of ~93k chunks |

Separate passes buy `t2m` twice and walk the whole store twice. A 4-variable
pass also yields Steadman apparent temperature for free, should it ever be
wanted for something other than the shadow metrics.

`d2m` is confirmed present in the store (checked 2026-08-24). ERA5-Land ships
dewpoint, not RH — RH is always derived.

### Cost, measured not estimated

Chunks are `(2880, 64, 64)` float32 = 120 days of hourly, **atomic** — zarr
cannot read a partial chunk, which is why hour-selection saves exactly zero
bytes. Timed on land tile `10_14` (315 cells, 82% land): 47.2 MB in 2.1 s,
22.9 MB/s effective.

399 tiles × 233 time-chunks over the full 1950–2026 record:

| scope | volume | wall time @ `--parallel-tiles 4` |
|---|---|---|
| 1 variable, full history | 4.4 TB | ~13 h |
| **4 variables, full history** | **17.5 TB** | **~54 h** |
| 4 variables, 1991–2020 normals | 6.8 TB | ~21 h |

⚠️ **Measured against the RETIRED store.** Those numbers were timed before the
July 2026 revamp; the pipeline now reads `era5/era5-land-v0.zarr`, chunked
`(1440, 50, 100)` = 60 days × 5°×10°, ~28.8 MB raw. Re-derived on the new grid:
342 tiles × ~469 time-chunks × 4 variables ≈ **635K chunk requests, ~18 TB** —
over the 500K/month EarthDataHub quota, so a full-history rerun splits across
two quota months. Bytes and wall time land in the same place; the request count
is the constraint that changed.

### It also heals the partial boundary days

Until 2026-08-25 every fetched span wrote its edge local days from a partial
handful of hours (fixed in `download_cells.py`: one-day halo + drop anything
short of 24 h). The rows still carrying that artifact are the ones no run has
rewritten since — the `--batch-years 20` span boundaries (1969-12-31,
1989-12-31, 2009-12-31 for a west-of-UTC cell, the 1970/1990/2010 Jan 1s for an
east-of-UTC one) and the year boundaries of older top-ups. Measured on Austin:
a partial 2025-12-31 read tmax 15.9 °C where the whole day was 20.4 °C. The
2026 top-up repaired 2025-12-31 and 2026-05-31 for every cell; the rest need a
span that covers them, which a full-history rerun does for free.

### It is additive, not a re-download

`tp` is never re-pulled and existing archives keep their `tmax_C` / `tmin_C` /
`precip_mm` / `wind_max_ms`. `write_cell` merges the new columns by date, so
nothing already shipped is at risk. Per the standing rule, this still needs an
exact tile×year scope and explicit approval before any run.

### Live-tier wrinkle

`models=era5_land` returns **null hourly wind** (verified — the same limitation
its daily block has, already documented in `worker/src/ensureFresh.js`).
`ecmwf_ifs` returns temp, wind and dewpoint fine.

So recent-tier wind chill would join era5_land temperature to IFS wind at
*hourly* resolution — more fragile than the daily-level join we do today.
Probable fix: compute recent-tier wind chill entirely from IFS so T and V are
self-consistent, accepting that its temperature differs slightly from the
displayed era5_land `tmin_C`. Decide deliberately rather than discover it at the
seam.

Perceived heat has no such problem: `dew_point_2m` and `relative_humidity_2m`
both return real values under `models=era5_land`, hourly and daily, so humidity
comes from the same model as temperature on every tier. (`apparent_temperature_max`
*is* null under era5_land while working under ecmwf_ifs — so Open-Meteo's own
feels-like cannot span our tiers, which is a second reason to compute the index
ourselves.)

---

## Footnote — rejected index alternatives

**Humidex** is a Canadian thing, and essentially Canada-only. It is
`T + 0.5555·(e − 10)`: linear in vapour pressure, which is itself exponential in
dewpoint, so it runs away in the tropics with no upper anchor — 40.6 on a 29 °C
Singapore day where heat index says 34.3. It is also officially dimensionless;
Environment Canada quotes it without units and states it is not a temperature,
which disqualifies it from a slot that shadows tmax in °C and writes "felt
like X°".

**UTCI** is the complicated European one (Copernicus / ECMWF). It is the most
rigorous index available and the wrong tool here, because it needs mean radiant
temperature and therefore radiation:

- ERA5-Land carries `ssrd`, `strd`, `ssr`, `str`, `fal` but **no `fdir`**, so the
  direct/diffuse split has to be estimated from a clearness-index model — and
  UTCI is sensitive to it.
- The pull goes from 4 variables to ~8: ~35 TB, ~107 h at `--parallel-tiles 4`.
- Open-Meteo's `era5_land` returns **null for all radiation** (verified), so the
  recent tier would need a three-way cross-model hourly join. The forecast tier
  is fine — `ecmwf_ifs` splits direct/diffuse properly.
- Ready-made UTCI does exist (CDS `derived-utci-historical`, hourly, 1940–present,
  Tmrt included) but only at 0.25°, which breaks the canonical 0.1° grid.
- It models a person standing in direct sun, so its daily max is effectively a
  clear-sky-noon number and is not comparable to our existing tmax series.

**Steadman apparent temperature** (Australia, UK) folds wind into the heat side,
which would make the actual↔apparent gap a humidity+wind mixture and break the
premise that the gap reads as humidity.

Heat index wins on being the most widely recognised of the four, an actual
temperature rather than an index number, and computable from variables we are
already pulling.

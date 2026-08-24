# Backlog

Items that are scoped and researched but not started. Each carries enough
measured evidence to be picked up cold.

---

## Perceived heat & perceived cold (apparent temperature)

**Status:** BLOCKED on UX clarity. Research done 2026-08-24, nothing implemented.

Add two metrics that shadow the two we already ship: an apparent max alongside
`tmax_C`, an apparent min alongside `tmin_C`. Humidity is never displayed as its
own number — the gap between actual and apparent *is* the humidity readout, in
units people feel.

### Design settled so far

- **Shadow, don't switch.** `apparent_max` pairs with tmax, `apparent_min` pairs
  with tmin. This beats a single year-round `feels_like` that flips between
  indices at a threshold — no threshold to defend, and the irrelevant one simply
  sits at ~0 (see the complementarity table below).
- **The two indices are SETTLED (2026-08-24):**
  - heat — **NWS heat index** (Rothfusz), from temperature + RH
  - cold — **wind chill** (JAG/TI 2001), from temperature + 10 m wind

  Both are computable from `t2m, d2m, u10, v10` and nothing else — no radiation.
  Wind chill is valid for T ≤ 10 °C and V ≥ 4.8 km/h; ERA5-Land `u10`/`v10` are
  already at the correct 10 m reference height. See the footnote on rejected
  alternatives before reopening this.
- **Clamp both.** Each index can return a value on the wrong side of air
  temperature outside its valid range, which renders as "it felt 2.8° cooler
  than it was" — a formula artifact, not a perception. Store
  `apparent_max = max(tmax, heat_index)` and `apparent_min = min(tmin, wind_chill)`.
  Not an edge case: NWS HI falls below air temperature on 99% of Madrid days and
  90% of Phoenix days, since dry air sits under its valid range.
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

### Open UX questions (what's actually blocking)

1. Do both metrics occupy permanent card slots everywhere, or surface
   conditionally when the gap is material? The gap is ~0 on a median day but
   6–12 °C on the extreme days people actually look up.
2. 
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

**Status:** BLOCKED on the same UX clarity — question 3 above sets the year range.

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

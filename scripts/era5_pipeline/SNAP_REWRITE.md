# Snap rewrite (2026-08-25): coordinates now point at the data source

## Why

`resolve_land_indices` snaps ocean-nearest cells to the nearest land in the
tile window with no distance cap. The archive at `archive_<lat>_<lon>` was
therefore always the **land gridpoint's** climate while `<lat>_<lon>` said
somewhere else — invisibly for coastal cities (one gridpoint), catastrophically
for sub-grid islands (Christmas Island shipped West Java, 350 km away; see
NEXT_SESSION_snap_audit.md and commit `86289345`).

USER DECISION (firm): every legitimately snapped cell's `cells.csv` coordinate
MOVES to its resolved land gridpoint — the UI's geocode→coordinate distance
must be honest. Names stay verbatim. Over-cap cells whose data belongs to a
different landmass are dropped or merged, not relabeled.

## The audit

`audit_snap_distances.py` (2026-08-25, all 341 tiles): **227 snapped cells**,
median 11.1 km, 203 ≤ 15 km, clean gap 22.1→26.9 km, **14 over the 25 km cap**
— every one a sub-grid island serving another landmass's climate. Cap chosen:
**25 km** (sits in the natural gap). Raw output: `snap_audit.csv`; per-tile
land masks cached in `snap_audit_masks/`.

## The plan

`build_snap_rewrite_plan.py` → **`snap_rewrite_plan.csv`** (the manifest — one
row per snapped cell). Actions:

| action | n | meaning |
|---|---|---|
| move | 120 | coords → land gridpoint; 4-tier R2 key rename |
| move_repull | 1 | San Andrés: solar offset flips −5h→−6h → archive re-pulled, not renamed |
| drop_dup_existing | 101 | destination is an existing cell's coord; archives are duplicates → merge |
| drop_dup_moved | 1 | St Peter Port & St Helier resolve to the same gridpoint; St Helier keeps it |
| drop_decision | 4 | St Kitts pile-up (The Valley/Marigot/Philipsburg/Gustavia → one unclaimed St Kitts gridpoint); all drop, Basseterre represents St Kitts |

`cells.csv`: 8726 → **8620** rows.

Survivor naming on merges: **higher population wins** ("Barcelona, Spain"
over "Nou Barris, Spain"), EXCEPT (a) over-cap merges never rename — Fajardo
absorbs St Croix + Charlotte Amalie and stays Fajardo (anything else recreates
the West-Java-as-Flying-Fish-Cove bug), and (b) five explicit overrides where
the population rule picked a verbose name and no other cell carries the clean
one (Vladivostok, Santa Marta, Esmeraldas, Şalālah, Errahma — table in
`build_snap_rewrite_plan.py`). Survivor takes max(population) of the pair.

Seven over-cap cells are **deliberate rename-keeps** (unclaimed destination,
honest UI distance): Mata-Utu 391 km (data = Savai'i, Samoa), San Andrés
206 km (Nicaragua coast), Road Town 116 km (Puerto Rico), Pago Pago 92 km
(Upolu), Cockburn Town 80 km (East Caicos), Espargos 67 km (Boa Vista),
Saint-Pierre 27 km (Burin Peninsula).

## Verification (before any R2 write)

`verify_snap_rewrite.py` — all three passes ran green on 2026-08-25:
- `--dups`: every dropped cell's archive compared row-by-row against its
  survivor's / destination-group's archive. **99/101 merge pairs are exact
  duplicates** (within half the 3-decimal storage quantum — build batches
  differ by ~1e-7 float noise in the 1950s extension rows). The 2 exceptions:
  **St Croix and Charlotte Amalie are NOT Fajardo's data** (diffs to 5.75 °C;
  identical to each other) — the old 64x64 tiling snapped them to some third
  gridpoint, and neither the v3 nor the legacy v2 store has land at St Croix
  itself. They are mislabeled foreign data with a Fajardo-sourced 2026 tail;
  dropped on the Christmas Island precedent, not as a dedupe.
- `--store`: the 7 over-cap keeps + 1 St Kitts representative re-derived from
  the DestinE store at the destination gridpoint (tmax/tmin, local-day
  bucketing, Christmas-Island method): **8/8 exact, max |d| = 0.0000 °C**.
- `--movers`: because the audit replays TODAY'S v3 tiling while 1950-2025
  history was built under the old 64x64 tiling (whose snap could differ — see
  St Croix), every mover was re-derived at its destination for 1990 + 2024
  winter/summer samples: **121/121 exact, max |d| = 0.0000 °C**. Written to
  `mover_provenance.csv`. No extra re-pulls needed; San Andrés (offset flip)
  stays the only rebuild.

## Execution

`apply_snap_rewrite.py` (phases, idempotent, see its docstring):
`--copy` → `--write-csv` → San Andrés re-pull
(`download_cells.py --tile 15_27 --cells "San Andrés, Colombia" --overwrite
--upload-r2`; the `--cells` flag was added for this) → elevation regen
(`bias_study/make_cell_elevation.py`) → frontend deploy → `--delete-old --yes`
→ `--status`.

Frontend safety net shipped with this change: a URL-seeded load now snaps its
coords to the nearest cell in cells.csv (AppContext) instead of fetching raw
URL coords — old permalinks to moved/merged cells keep working. The runtime
land-snap in the pipeline is now a no-op for every moved cell (their nearest
gridpoint IS land), so a future over-cap snap can only be a genuinely new
broken case.

## Downstream: everything keyed by the OLD coordinates

**The manifest (`snap_rewrite_plan.csv`) is the remap table.** Before joining
anything historical, map `old_base` → `new_base` and drop the rows of dropped
cells (their data was a duplicate of the survivor's key).

- **HRES historical forecasts (bias study): MUST be re-pulled at the NEW
  coordinates for all 121 moved cells before any debias retrain.** The cached
  pulls sampled Open-Meteo at the old coords; for over-cap keeps the old
  ERA5↔HRES pairing was outright wrong (Mata-Utu's fit compared Savai'i ERA5
  against Wallis HRES). Open-Meteo volume rules apply — quote and get
  approval first.
- Per-cell debias R2 tables: renamed with the cell (content still valid — fit
  on the archive series, which is unchanged). San Andrés's is slightly stale
  (re-bucketed archive) until the next debias bake.
- `qn8727_s0` fits / cached feathers: joined by old coords — remap via the
  manifest; regenerate at next retrain anyway.
- `cell_elevation.csv`: regenerated (ERA5-Land grib, never the OM API).

## Status

- [x] audit run (2026-08-25)
- [x] plan built + reviewed
- [x] verification --dups / --store / --movers (all green, see above)
- [x] --copy: 121 archive + 121 debias + 15 forecast copied, ETag-verified,
      0 failures (recent absent everywhere — Worker regenerates on demand)
- [x] --write-csv: 8620 kept / 106 dropped / 121 moved / 55 renamed; CRLF
      intact, untouched rows byte-verbatim
- [x] elevation regen: 8620 rows
- [x] frontend: URL-snap fallback in AppContext + new cells.csv deployed to
      Pages (deploy 1371490e); live /cells.csv verified
- [x] San Andrés re-pull (offset -5h -> -6h): 27,970 days rebuilt + uploaded
      (needed --batch-years 5 --var-workers 2 — the 20-yr window fetch dropped
      the connection twice)
- [x] **Worker allowlist** — a step the original plan missed: the Worker bakes
      a cells.csv allowlist into `worker/src/cellKeys.js` at deploy time and
      404s /api/ensure-fresh for unknown coords, so EVERY moved cell needs a
      Worker redeploy (`node scripts/gen-cell-keys.mjs` + `wrangler deploy`)
      alongside the Pages deploy. Done 2026-08-25 (8620 keys).
- [x] old keys retired via `--deprecate --yes` (USER CHOICE over deletion,
      2026-08-25): all 491 old-key objects moved to the `deprecated/` prefix
      (ETag-verified copy before each original was removed; moved 491 /
      leftovers 0). The live tiers are clean; the bytes remain recoverable —
      restoring = copying back out of `deprecated/`.

**Deploy incident (2026-08-25, resolved):** the Pages deploy shipped months of
committed-but-undeployed frontend work (prod deploys are manual), including
`f7851ae2` which parsed the future 9-level debias schema (d25/d75) unguarded —
site-wide "~NaN% chance" against the live 7-level tables. Fixed by restoring
the probit q25/q75 fallback in ci.ts (dual-schema client) and redeploying.
Details in memory `project_nine_level_retrain`.

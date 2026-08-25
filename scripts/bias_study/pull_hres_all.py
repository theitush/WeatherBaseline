"""Pull the full ~2-yr IFS-HRES forecast history for EVERY cell, to its own R2 dir.

This is the bias-study *acquisition* job: the forecast side of the archive↔forecast
bias model. For each cell in data/cells.csv it fetches the settled IFS-HRES daily
series (tmax/tmin/precip/wind_max) from the historical-forecast API at the IDENTICAL
snapped 0.1deg point + cell_selection=nearest the prod Worker uses — so the bias we
later measure is the bias users actually see (see ensureFresh.js FORECAST_MODEL).

It is a long-running, network-bound, resumable, run-once job — built to run on a
throwaway GCP VM (see HRES_VM_RUN.md) exactly like the era5 archive pull.

OUTPUT — its OWN R2 prefix, separate from the live serving tiers:
  hres-forecast/hres_{lat}_{lon}.csv.gz
  columns: date,tmax_C,tmin_C,precip_mm,wind_max_ms
  (the actual HRES cell center lat/lon/elevation the API returned is recorded in
   the resume ledger per cell, as a bias-model feature — the grid offset between
   our 0.1deg point and HRES's O1280 cell is itself part of the bias.)

RESUME — R2-mirrored ledger at <r2-prefix>/.hres_progress.json (same pattern as
the era5 --overwrite ledger). A recreated/rebooted box pulls the ledger back and
skips cells already done. A NEW --r2-prefix is therefore the safe, resumable way
to rebuild the entire dataset without replacing the previous one.

RATE — Open-Meteo bills weighted, FRACTIONAL calls, not HTTP requests:
  weight = nLocations * (nDays / 14) * (nVariables / 10)      [nDays floored at 14]
At 4 vars, one location, ~2.4yr that is (880/14)*(4/10) = ~25 calls/cell, so the
full 8.7k-cell grid is ~220k weighted calls. Free tier caps are 600/min, 5k/hour,
10k/day, 300k/month (per IP); the Standard plan ($29/mo, cancel when done) lifts
the daily cap with a 1M/month budget. NOTE --rate paces REQUESTS, not weighted
calls — check the cost with --dry-run before assuming a rate keeps you under a cap.

Auth — R2 S3 token in env (reuses era5_pipeline/r2.env):
  R2_ACCOUNT_ID R2_ACCESS_KEY_ID R2_SECRET_ACCESS_KEY  [R2_BUCKET=weather-baseline]
And OPTIONALLY a paid Open-Meteo key (Standard $29/mo, key-based not IP-based):
  OPENMETEO_API_KEY=...        # absent => free tier (single IP, --rate 6)

RESUME is two-layered so it works from a FRESH VM with an empty local dir: on
start it lists what's ALREADY in the selected R2 prefix (*.csv.gz) and skips those
cells, then merges the ledger on top. So you can run a normal pull on any box, any
number of times, and it only fetches the cells R2 doesn't have yet. --overwrite
re-pulls cells already in R2, but does not preserve that skip set across a restart;
use a new --r2-prefix for a large resumable rebuild.

TOP-UP (--append) — the cheap way to keep the dataset current. Skipping is
all-or-nothing and --overwrite re-pulls all ~28 months (~53 quota-units/cell), so
neither extends the tail. --append fetches ONLY each cell's missing days: it reads
the cell's existing series (local file, else the R2 object), then requests
[last_date - --resettle-days + 1 .. today - --lag] and merges by date, new rows
winning. A ~2-month top-up costs ~5 units/cell instead of 53. Cells with no data
yet fall back to a full-window pull, and cells already at the target end date are
left untouched (no API call). Rerun it monthly; it is idempotent.

--end pins that target to a FIXED date instead of today - --lag. On the free tier
a full-grid top-up spans several days, and a drifting target smears the dataset's
end date across the whole run (every cell stops at whatever "today - lag" was when
its turn came). Pass --end so a multi-day, resumable run lands every cell on the
same last day. --dry-run prices a run without touching the API.

The --resettle-days overlap exists because the historical-forecast API's most
recent days are still firming up as later runs land — re-fetching the tail
overwrites those seam days with settled values instead of freezing the first
value we happened to see.

STOPS GRACEFULLY on rate-limit exhaustion: a 429 / daily-quota error saves the
ledger and exits 2 ("resume later") instead of hammering. On the free tier it
pulls ~a day's worth, hits the wall, stops clean; rerun tomorrow to continue.

Usage (from scripts/bias_study/, with the era5_pipeline venv):
  source ../era5_pipeline/.venv/bin/activate
  source ../era5_pipeline/r2.env
  python pull_hres_all.py --only Chicago        # one-cell smoke test (by name)
  python pull_hres_all.py --limit 20            # first 20 cells
  python pull_hres_all.py --rate 6              # FULL grid, FREE tier pace
  OPENMETEO_API_KEY=xxx python pull_hres_all.py # FULL grid, Standard plan (fast)
  python pull_hres_all.py --append --rate 6     # top up every cell's tail
  python pull_hres_all.py --append --end 2026-08-01 --dry-run
                                               # price a top-up to a fixed day
  python pull_hres_all.py --r2-prefix hres-forecast-ifs-hres --years 99
                                               # fresh, full, resumable rebuild
"""
from __future__ import annotations

import argparse
import csv
import gzip
import io
import json
import os
import sys
import threading
import time
from collections import deque
from datetime import date, timedelta
from pathlib import Path

import requests


class RateLimitHit(Exception):
    """Raised when the API signals quota/rate exhaustion (429 or daily limit)."""

# Reuse the era5 pipeline's R2 client (ledger get/put + upload with serve headers).
HERE = Path(__file__).resolve().parent
sys.path.insert(0, str(HERE.parent / "era5_pipeline"))
from r2_upload import R2Uploader  # noqa: E402

CELLS_CSV = HERE.parent.parent / "data" / "cells.csv"
DEFAULT_R2_PREFIX = "hres-forecast"

FREE_HOST = "https://historical-forecast-api.open-meteo.com/v1/forecast"
PAID_HOST = "https://customer-historical-forecast-api.open-meteo.com/v1/forecast"
VARS = {
    "temperature_2m_max": "tmax_C",
    "temperature_2m_min": "tmin_C",
    "precipitation_sum": "precip_mm",
    "wind_speed_10m_max": "wind_max_ms",
}
HRES_FIELDS = ",".join(VARS)
SCHEMA = ["date", "tmax_C", "tmin_C", "precip_mm", "wind_max_ms"]
# Must match the live forecast tier; omitting this makes Open-Meteo select its
# location-dependent "Best Match" model instead of IFS HRES.
HRES_MODEL = "ecmwf_ifs"

# End a few days behind today so the historical-forecast values are fully settled.
END_LAG_DAYS = 10
# Hard floor: the historical-forecast archive only has native 9km IFS-HRES from
# ~here (IFS Cycle 49R1). Earlier dates return nulls / a coarser fallback model,
# NOT the HRES prod serves — so never request before this, whatever --years says.
HRES_ARCHIVE_START = date(2024, 3, 1)


# Open-Meteo bills FRACTIONAL weighted calls, not requests:
#   weight = nLocations * (nDays / 14) * (nVariables / 10)
# with nDays floored at 14 — data sits in 14-day compressed chunks, so a shorter
# window is the same work server-side. Neither factor is rounded up: 1 variable
# really is 0.1, and their own worked example (20yr x 10 loc x 1 var = 260.7)
# only reproduces under exact fractional arithmetic.
# https://openmeteo.substack.com/p/weather-data-for-multiple-locations
QUOTA_CHUNK_DAYS = 14
QUOTA_VARS_PER_CALL = 10


def quota_units(days: int, locations: int = 1) -> float:
    """Weighted API calls one request costs. Fractional: our 4-variable request
    over <=14 days is 0.4 calls, so a tail top-up is ~60x cheaper than the
    full-window re-pull (0.4 vs ~25 calls/cell)."""
    return (locations
            * max(days, QUOTA_CHUNK_DAYS) / QUOTA_CHUNK_DAYS
            * len(VARS) / QUOTA_VARS_PER_CALL)


def snap(coord: float) -> float:
    """Round to the canonical 0.1deg grid, matching worker cellStore.snap."""
    return round(coord * 10) / 10


class RateLimiter:
    """Token-window limiter: at most `per_min` acquisitions in any 60s window."""

    def __init__(self, per_min: float):
        self.per_min = max(1.0, per_min)
        self._times: deque[float] = deque()
        self._lock = threading.Lock()

    def acquire(self) -> None:
        while True:
            with self._lock:
                now = time.monotonic()
                while self._times and now - self._times[0] >= 60.0:
                    self._times.popleft()
                if len(self._times) < self.per_min:
                    self._times.append(now)
                    return
                wait = 60.0 - (now - self._times[0]) + 0.01
            time.sleep(wait)


def _looks_like_daily_quota(text: str) -> bool:
    """Open-Meteo signals daily-quota exhaustion via a 'reason' mentioning the
    daily limit (vs. a bare per-minute 429, which is transient and retryable)."""
    t = text.lower()
    return "daily" in t or "minutely" not in t and "limit" in t and "exceeded" in t


def fetch_hres(host, apikey, slat, slon, start, end, limiter, max_429=3):
    """Return (rows, meta) for the snapped point.

    rows: list of dicts in SCHEMA order. meta: the actual HRES cell the API used
    (its center lat/lon + DEM elevation) — recorded as a bias-model feature.

    Raises RateLimitHit when the daily quota is exhausted (caller stops the run);
    transient per-minute 429s are retried with backoff up to max_429.
    """
    params = {
        "latitude": slat, "longitude": slon,
        "start_date": start, "end_date": end,
        "daily": HRES_FIELDS, "wind_speed_unit": "ms",
        "models": HRES_MODEL,
        "timezone": "auto", "cell_selection": "nearest",
    }
    if apikey:
        params["apikey"] = apikey
    last = None
    n_429 = 0
    for attempt in range(6):
        if attempt:
            time.sleep(min(2 ** attempt, 30))
        limiter.acquire()
        r = requests.get(host, params=params, timeout=90,
                         headers={"User-Agent": "HowHotWasIt-biasstudy/1.0"})
        last = r
        if r.ok:
            j = r.json()
            daily = j.get("daily", {})
            times = daily.get("time", [])
            rows = []
            for i, d in enumerate(times):
                row = {"date": d}
                for fld, col in VARS.items():
                    v = daily.get(fld, [None] * len(times))[i]
                    row[col] = "" if v is None else v
                rows.append(row)
            meta = {
                "hres_lat": j.get("latitude"),
                "hres_lon": j.get("longitude"),
                "hres_elevation": j.get("elevation"),
            }
            return rows, meta
        if r.status_code == 429:
            # Daily-quota exhaustion => stop the whole run. A plain per-minute 429
            # is transient: back off and retry a few times.
            if _looks_like_daily_quota(r.text):
                raise RateLimitHit(r.text[:200])
            n_429 += 1
            if n_429 >= max_429:
                # Repeated 429s with the limiter already pacing us => treat as
                # quota exhaustion rather than spin forever.
                raise RateLimitHit(f"persistent 429: {r.text[:200]}")
            continue
        # Other 4xx is a hard per-cell error (bad params); don't burn retries.
        if r.status_code < 500:
            raise RuntimeError(f"{r.status_code} {r.text[:200]}")
    raise RuntimeError(f"HRES failed after retries (last {last.status_code if last else '?'})")


def write_local_gz(path: Path, rows) -> None:
    path.parent.mkdir(parents=True, exist_ok=True)
    buf = io.StringIO()
    w = csv.DictWriter(buf, fieldnames=SCHEMA)
    w.writeheader()
    w.writerows(rows)
    with gzip.open(path, "wt", newline="") as f:
        f.write(buf.getvalue())


def read_existing(gz: Path, r2_key: str, up: R2Uploader) -> list[dict]:
    """Return a cell's already-pulled rows — from the local mirror if it's there,
    else from R2 (one Class B GET) so --append works on a fresh box. Empty list
    when the cell has no data yet or its object is unreadable: the caller then
    falls back to a full-window pull, which is the correct repair either way."""
    raw = gz.read_bytes() if gz.exists() else up.get_bytes(r2_key)
    if not raw:
        return []
    try:
        text = gzip.decompress(raw).decode()
    except Exception:  # noqa: BLE001 - truncated/corrupt object => re-pull whole
        return []
    return [row for row in csv.DictReader(io.StringIO(text)) if row.get("date")]


def merge_rows(old: list[dict], new: list[dict]) -> list[dict]:
    """Union old and new rows by date, date-sorted, NEW winning on collision —
    the re-fetched tail carries settled values that supersede what we first saw."""
    by_date = {r["date"]: r for r in old}
    by_date.update({r["date"]: r for r in new})
    return [by_date[d] for d in sorted(by_date)]


def load_ledger(up: R2Uploader, ledger_key: str) -> dict:
    """Pull the resume ledger from R2 (so a fresh box knows what's done)."""
    raw = up.get_bytes(ledger_key)
    if not raw:
        return {"done": {}}
    try:
        return json.loads(raw.decode())
    except Exception:  # noqa: BLE001 - corrupt ledger => start clean, R2 is idempotent
        return {"done": {}}


def save_ledger(up: R2Uploader, ledger: dict, ledger_key: str,
                local_ledger: Path) -> None:
    """Write the ledger to R2 (authoritative resume) AND mirror it locally."""
    blob = json.dumps(ledger).encode()
    up.put_bytes(blob, ledger_key, "application/json")
    local_ledger.parent.mkdir(parents=True, exist_ok=True)
    local_ledger.write_bytes(blob)


def read_cells():
    """Yield (name, slat, slon) for each row in cells.csv, snapped."""
    with open(CELLS_CSV, newline="") as f:
        for row in csv.DictReader(f):
            yield row["name"], snap(float(row["lat"])), snap(float(row["lon"]))


def main() -> int:
    ap = argparse.ArgumentParser(description=__doc__,
                                 formatter_class=argparse.RawDescriptionHelpFormatter)
    ap.add_argument("--years", type=float, default=2.5,
                    help="lookback length; clamped to the HRES archive start "
                         f"({HRES_ARCHIVE_START}). Default 2.5 => the full archive.")
    ap.add_argument("--rate", type=float, default=None,
                    help="max API calls/min (default: 540 with a key, else 6)")
    ap.add_argument("--only", help="substring match on cell name (smoke test)")
    ap.add_argument("--limit", type=int, help="only the first N cells")
    ap.add_argument("--overwrite", action="store_true",
                    help="re-pull cells that already exist in R2 (e.g. to fix a "
                         "wrong window) instead of skipping them")
    ap.add_argument("--append", action="store_true",
                    help="top-up mode: fetch only each cell's missing tail and "
                         "merge by date (~10x cheaper than --overwrite)")
    ap.add_argument("--r2-prefix", default=DEFAULT_R2_PREFIX,
                    help="R2 folder for cell files and the resume ledger "
                         f"(default {DEFAULT_R2_PREFIX!r}); use a new prefix "
                         "for a separately tracked, resumable rebuild")
    ap.add_argument("--resettle-days", type=int, default=14,
                    help="with --append, also re-fetch this many days already on "
                         "disk, so the unsettled seam gets settled values (14)")
    ap.add_argument("--end",
                    help="pin the window end to this YYYY-MM-DD instead of "
                         "today - --lag (which drifts with the calendar). Use it "
                         "to top every cell up to one fixed date, e.g. "
                         "--end 2026-08-01; --lag is then ignored.")
    ap.add_argument("--dry-run", action="store_true",
                    help="print the per-cell window and total quota cost, make "
                         "no API calls and write nothing (R2 or disk)")
    ap.add_argument("--lag", type=int, default=END_LAG_DAYS,
                    help=f"end the window this many days before today "
                         f"(default {END_LAG_DAYS}; the era5-land archive we join "
                         f"against lags ~6, so below ~7 buys nothing)")
    ap.add_argument("--ledger-every", type=int, default=1,
                    help="flush the R2 ledger every N cells (default 1: after "
                         "every cell, so a kill never loses a cell's bias meta)")
    args = ap.parse_args()
    if args.append and args.overwrite:
        sys.exit("--append and --overwrite are mutually exclusive")
    r2_prefix = args.r2_prefix.strip("/")
    if not r2_prefix or ".." in Path(r2_prefix).parts:
        sys.exit("--r2-prefix must be a non-empty relative R2 folder")
    out_dir = HERE / "data" / r2_prefix
    ledger_key = f"{r2_prefix}/.hres_progress.json"
    local_ledger = out_dir / ".hres_progress.json"

    apikey = os.environ.get("OPENMETEO_API_KEY") or None
    host = PAID_HOST if apikey else FREE_HOST
    rate = args.rate if args.rate is not None else (540.0 if apikey else 6.0)

    if args.end:
        try:
            end = date.fromisoformat(args.end)
        except ValueError:
            sys.exit("--end must be a YYYY-MM-DD date")
        if end >= date.today():
            sys.exit(f"--end {end} is not in the past; the historical-forecast "
                     f"archive has nothing there yet")
        settled = date.today() - timedelta(days=args.lag)
        if end > settled:
            print(f"NOTE: --end {end} is inside the {args.lag}-day settling "
                  f"window (settled through {settled}); those last days may "
                  f"still firm up. Re-run later with the same --end to resettle.")
    else:
        end = date.today() - timedelta(days=args.lag)
    start = end - timedelta(days=round(365.25 * args.years))
    # Never request before the archive floor — earlier dates aren't real HRES.
    if start < HRES_ARCHIVE_START:
        start = HRES_ARCHIVE_START
    s, e = start.isoformat(), end.isoformat()

    cells = list(read_cells())
    if args.only:
        cells = [c for c in cells if args.only.lower() in c[0].lower()]
        if not cells:
            sys.exit(f"no cell name matches {args.only!r}")
    if args.limit:
        cells = cells[: args.limit]

    days = (end - start).days + 1
    tier = "Standard (key)" if apikey else "FREE tier (single IP)"
    print(f"window {s} .. {e}  ({days} days)   tier: {tier}")
    if args.append:
        print(f"APPEND: per-cell tail only, re-fetching the last "
              f"{args.resettle_days} days for settling  @ {rate:.0f}/min")
    else:
        print(f"{len(cells)} cells x ~{quota_units(days):.2f} weighted calls = "
              f"~{len(cells) * quota_units(days):,.0f} API calls  @ {rate:.0f}/min")
    print(f"listing R2 prefix {r2_prefix!r} / loading ledger…", flush=True)

    up = R2Uploader()
    # Two-layer resume so a FRESH box with an empty local dir is correct:
    #   1) what R2 already HAS (authoritative — survives a wiped ledger),
    #   2) the ledger (adds the per-cell meta for cells we pulled here).
    ledger = load_ledger(up, ledger_key)
    done = ledger["done"]
    in_r2 = {
        k.split("/")[-1].removeprefix("hres_").removesuffix(".csv.gz")
        for k in up.list_sizes(f"{r2_prefix}/")
        if k.endswith(".csv.gz")
    }
    if args.overwrite:
        # Re-pull everything in range, replacing existing R2 objects + ledger
        # entries (the ledger is rebuilt for these cells as they're re-fetched).
        skip = set()
        print(f"OVERWRITE: re-pulling all selected cells "
              f"({len(in_r2)} currently in R2 will be replaced)\n")
    elif args.append:
        # Every selected cell is visited; the per-cell tail check (not this set)
        # decides whether it needs an API call at all.
        skip = set()
        print(f"APPEND: topping up all selected cells "
              f"({len(in_r2)} currently in R2)\n")
    else:
        skip = set(done) | in_r2
        print(f"resume: {len(in_r2)} cells already in R2, {len(done)} in ledger "
              f"-> {len(skip)} to skip\n")

    limiter = RateLimiter(rate)
    out_dir.mkdir(parents=True, exist_ok=True)
    n_todo = sum(1 for _, sla, slo in cells
                 if f"{sla:.1f}_{slo:.1f}" not in skip)
    n_ok = n_skip = n_fail = n_current = 0
    units = 0
    t_start = time.time()
    stopped = False
    print(f"{n_todo} cells to {'check' if args.append else 'fetch'} this run "
          f"(ledger flush every {args.ledger_every} cell"
          f"{'s' if args.ledger_every != 1 else ''})\n", flush=True)

    for idx, (name, slat, slon) in enumerate(cells):
        key = f"{slat:.1f}_{slon:.1f}"
        if key in skip:
            n_skip += 1
            continue
        gz = out_dir / f"hres_{key}.csv.gz"
        r2_key = f"{r2_prefix}/hres_{key}.csv.gz"
        # progress = cells visited so far this run (ok + fail + up-to-date), out
        # of every cell this run will visit — so the counter reaches n_todo even
        # when --append finds most cells current
        nth = n_ok + n_fail + n_current + 1
        tag = f"[{nth}/{n_todo}] {name[:28]:28s} {key:14s}"

        # --append: fetch this cell's tail only. No existing data (new cell, or an
        # unreadable object) => fall through to the full window, which is both the
        # first pull and the repair.
        have, cell_start = [], s
        if args.append:
            have = read_existing(gz, r2_key, up)
            have_end = max((r["date"] for r in have), default=None)
            if have_end and have_end >= e:
                n_current += 1
                print(f"  {tag} up to date ({have_end})", flush=True)
                continue
            if have_end:
                tail = date.fromisoformat(have_end) - timedelta(
                    days=max(0, args.resettle_days - 1))
                cell_start = max(tail, start).isoformat()

        cell_days = (date.fromisoformat(e) - date.fromisoformat(cell_start)).days + 1
        if args.dry_run:
            units += quota_units(cell_days)
            n_ok += 1
            print(f"  {tag} would fetch {cell_start}..{e}  "
                  f"({cell_days} days, {quota_units(cell_days):.2f} calls)", flush=True)
            continue

        print(f"  {tag} fetching {cell_start}..{e}…", flush=True)
        t_cell = time.time()
        try:
            rows, meta = fetch_hres(host, apikey, slat, slon, cell_start, e, limiter)
        except RateLimitHit as ex:
            print(f"\n  rate/quota limit reached at cell {nth} ({key}): {ex}")
            print("  stopping cleanly — rerun the same command to continue.")
            stopped = True
            break
        except Exception as ex:  # noqa: BLE001 - log, keep going, retry on rerun
            n_fail += 1
            print(f"  {tag} FAIL: {ex}", flush=True)
            continue
        units += quota_units(cell_days)

        n_new = len(rows)
        rows = merge_rows(have, rows) if have else rows
        write_local_gz(gz, rows)
        up.upload_file(gz, r2_key)
        done[key] = {"name": name, "rows": len(rows),
                     "end": rows[-1]["date"] if rows else None, **meta}
        skip.add(key)
        n_ok += 1

        dt = time.time() - t_cell
        cmin = n_ok / max(1e-9, (time.time() - t_start) / 60)
        hl = meta.get("hres_lat")
        hlon = meta.get("hres_lon")
        hloc = f"HRES@{hl:.3f},{hlon:.3f}" if hl is not None and hlon is not None else "HRES@?"
        span = f"{len(rows)} rows (+{n_new} fetched)" if have else f"{len(rows)} rows"
        print(f"  {tag} OK  {span}  {hloc}  "
              f"{dt:.1f}s  ({cmin:.0f} cells/min)", flush=True)
        if n_ok % args.ledger_every == 0 and not args.dry_run:
            save_ledger(up, ledger, ledger_key, local_ledger)
            print(f"  {tag} ledger flushed to R2 "
                  f"({len(done)} cells recorded)", flush=True)

    if not args.dry_run:
        save_ledger(up, ledger, ledger_key, local_ledger)
    print(f"\n{'DRY RUN — nothing written. ' if args.dry_run else ''}"
          f"done. ok={n_ok} skip={n_skip} fail={n_fail}"
          f"{f' up-to-date={n_current}' if args.append else ''}  "
          f"~{units:,.1f} weighted API calls  "
          f"({(time.time() - t_start) / 60:.1f} min)")
    remaining = len(cells) - n_skip - n_ok - n_current
    if stopped or remaining > 0:
        print(f"{remaining} cells remaining — rerun the same command to continue.")
        return 2
    if n_fail:
        print("re-run the same command to retry the failed cells (idempotent).")
        return 1
    return 0


if __name__ == "__main__":
    raise SystemExit(main())

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

RESUME — R2-mirrored ledger at hres-forecast/.hres_progress.json (same pattern as
the era5 --overwrite ledger). A recreated/rebooted box pulls the ledger back and
skips cells already done. Rerun the same command after any interruption.

RATE — the Open-Meteo Standard plan ($29/mo, cancel when done) lifts the 10k/day
cap; the binding limit is then 600 calls/min. At ~53 weighted calls/cell (4 vars,
~2yr => ceil(4/10)*ceil(730/14)=53) the whole 10k-cell grid is ~550k calls, well
inside Standard's 1M/mo, finishing in ~1 day at the default --rate 540 calls/min.
On the FREE tier instead, pass --rate 6 (stays under 10k/day) — ~2 months.

Auth — R2 S3 token in env (reuses era5_pipeline/r2.env):
  R2_ACCOUNT_ID R2_ACCESS_KEY_ID R2_SECRET_ACCESS_KEY  [R2_BUCKET=weather-baseline]
And OPTIONALLY a paid Open-Meteo key (Standard $29/mo, key-based not IP-based):
  OPENMETEO_API_KEY=...        # absent => free tier (single IP, --rate 6)

RESUME is two-layered so it works from a FRESH VM with an empty local dir: on
start it lists what's ALREADY in R2 (hres-forecast/*.csv.gz) and skips those
cells, then merges the ledger on top. So you can run this on any box, any number
of times, and it only fetches the cells R2 doesn't have yet. Pass --overwrite to
re-pull cells already in R2 (e.g. to fix a wrong date window) instead of skipping.

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
OUT_DIR = HERE / "data" / "hres-forecast"      # local mirror of the R2 prefix
R2_PREFIX = "hres-forecast"
LEDGER_KEY = f"{R2_PREFIX}/.hres_progress.json"
LOCAL_LEDGER = OUT_DIR / ".hres_progress.json"  # local mirror of the R2 ledger

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

# End a few days behind today so the historical-forecast values are fully settled.
END_LAG_DAYS = 10
# Hard floor: the historical-forecast archive only has native 9km IFS-HRES from
# ~here (IFS Cycle 49R1). Earlier dates return nulls / a coarser fallback model,
# NOT the HRES prod serves — so never request before this, whatever --years says.
HRES_ARCHIVE_START = date(2024, 3, 1)


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


def load_ledger(up: R2Uploader) -> dict:
    """Pull the resume ledger from R2 (so a fresh box knows what's done)."""
    raw = up.get_bytes(LEDGER_KEY)
    if not raw:
        return {"done": {}}
    try:
        return json.loads(raw.decode())
    except Exception:  # noqa: BLE001 - corrupt ledger => start clean, R2 is idempotent
        return {"done": {}}


def save_ledger(up: R2Uploader, ledger: dict) -> None:
    """Write the ledger to R2 (authoritative resume) AND mirror it locally."""
    blob = json.dumps(ledger).encode()
    up.put_bytes(blob, LEDGER_KEY, "application/json")
    LOCAL_LEDGER.parent.mkdir(parents=True, exist_ok=True)
    LOCAL_LEDGER.write_bytes(blob)


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
    ap.add_argument("--ledger-every", type=int, default=1,
                    help="flush the R2 ledger every N cells (default 1: after "
                         "every cell, so a kill never loses a cell's bias meta)")
    args = ap.parse_args()

    apikey = os.environ.get("OPENMETEO_API_KEY") or None
    host = PAID_HOST if apikey else FREE_HOST
    rate = args.rate if args.rate is not None else (540.0 if apikey else 6.0)

    end = date.today() - timedelta(days=END_LAG_DAYS)
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
    calls_per_cell = -(-len(VARS) // 10) * -(-days // 14)
    tier = "Standard (key)" if apikey else "FREE tier (single IP)"
    print(f"window {s} .. {e}  ({days} days)   tier: {tier}")
    print(f"{len(cells)} cells x ~{calls_per_cell} calls = "
          f"~{len(cells) * calls_per_cell:,} API calls  @ {rate:.0f}/min")
    print("listing what's already in R2 / loading ledger…", flush=True)

    up = R2Uploader()
    # Two-layer resume so a FRESH box with an empty local dir is correct:
    #   1) what R2 already HAS (authoritative — survives a wiped ledger),
    #   2) the ledger (adds the per-cell meta for cells we pulled here).
    ledger = load_ledger(up)
    done = ledger["done"]
    in_r2 = {
        k.split("/")[-1].removeprefix("hres_").removesuffix(".csv.gz")
        for k in up.list_sizes(f"{R2_PREFIX}/")
        if k.endswith(".csv.gz")
    }
    if args.overwrite:
        # Re-pull everything in range, replacing existing R2 objects + ledger
        # entries (the ledger is rebuilt for these cells as they're re-fetched).
        skip = set()
        print(f"OVERWRITE: re-pulling all selected cells "
              f"({len(in_r2)} currently in R2 will be replaced)\n")
    else:
        skip = set(done) | in_r2
        print(f"resume: {len(in_r2)} cells already in R2, {len(done)} in ledger "
              f"-> {len(skip)} to skip\n")

    limiter = RateLimiter(rate)
    OUT_DIR.mkdir(parents=True, exist_ok=True)
    n_todo = sum(1 for _, sla, slo in cells
                 if f"{sla:.1f}_{slo:.1f}" not in skip)
    n_ok = n_skip = n_fail = 0
    t_start = time.time()
    stopped = False
    print(f"{n_todo} cells to fetch this run "
          f"(ledger flush every {args.ledger_every} cell"
          f"{'s' if args.ledger_every != 1 else ''})\n", flush=True)

    for idx, (name, slat, slon) in enumerate(cells):
        key = f"{slat:.1f}_{slon:.1f}"
        if key in skip:
            n_skip += 1
            continue
        gz = OUT_DIR / f"hres_{key}.csv.gz"
        r2_key = f"{R2_PREFIX}/hres_{key}.csv.gz"
        # progress = cells processed so far this run (ok + fail), out of the to-do count
        nth = n_ok + n_fail + 1
        tag = f"[{nth}/{n_todo}] {name[:28]:28s} {key:14s}"
        print(f"  {tag} fetching…", flush=True)
        t_cell = time.time()
        try:
            rows, meta = fetch_hres(host, apikey, slat, slon, s, e, limiter)
        except RateLimitHit as ex:
            print(f"\n  rate/quota limit reached at cell {nth} ({key}): {ex}")
            print("  stopping cleanly — rerun the same command to continue.")
            stopped = True
            break
        except Exception as ex:  # noqa: BLE001 - log, keep going, retry on rerun
            n_fail += 1
            print(f"  {tag} FAIL: {ex}", flush=True)
            continue

        write_local_gz(gz, rows)
        up.upload_file(gz, r2_key)
        done[key] = {"name": name, "rows": len(rows), **meta}
        skip.add(key)
        n_ok += 1

        dt = time.time() - t_cell
        cmin = n_ok / max(1e-9, (time.time() - t_start) / 60)
        hl = meta.get("hres_lat")
        hlon = meta.get("hres_lon")
        hloc = f"HRES@{hl:.3f},{hlon:.3f}" if hl is not None and hlon is not None else "HRES@?"
        print(f"  {tag} OK  {len(rows)} rows  {hloc}  "
              f"{dt:.1f}s  ({cmin:.0f} cells/min)", flush=True)
        if n_ok % args.ledger_every == 0:
            save_ledger(up, ledger)
            print(f"  {tag} ledger flushed to R2 "
                  f"({len(done)} cells recorded)", flush=True)

    save_ledger(up, ledger)
    print(f"\ndone. ok={n_ok} skip={n_skip} fail={n_fail}  "
          f"({(time.time() - t_start) / 60:.1f} min)")
    remaining = len(cells) - n_skip - n_ok
    if stopped or remaining > 0:
        print(f"{remaining} cells remaining — rerun the same command to continue.")
        return 2
    if n_fail:
        print("re-run the same command to retry the failed cells (idempotent).")
        return 1
    return 0


if __name__ == "__main__":
    raise SystemExit(main())

"""Benchmark 3 bbox strategies on 10 cities for 1 year.

Strategies:
  A. per-city: one ~0.5° bbox request per (city, target). 10 cities × 3 targets = 30 requests.
  B. global:   one request per target, no bbox. 3 requests, multi-GB downloads.
  C. regional: continental bboxes covering all 10 cities. ~4 boxes × 3 targets = ~12 requests.

For each strategy we record:
  - total wall time (submission → all downloads done)
  - total bytes transferred
  - per-request queue+download time

Concurrency is capped at MAX_CONCURRENT (default 2; CDS free-tier limit).

Usage:
  source .venv/bin/activate
  python benchmark.py --year 2020 [--strategies A,B,C]

Output: benchmark_results.json
"""
from __future__ import annotations

import argparse
import json
import time
from pathlib import Path

import cdsapi

from era5 import DATASET, TARGETS, RequestSpec

HERE = Path(__file__).resolve().parent
TMP = HERE / ".bench_tmp"
OUT_JSON = HERE / "benchmark_results.json"

MAX_CONCURRENT = 2

# Diverse cities (lat, lon, name). Trim with --n-cities for faster benchmarks.
CITIES = [
    (40.71, -74.01, "New York"),
    (51.52, -0.09, "London"),
    (35.68, 139.69, "Tokyo"),
    (32.09, 34.78, "Tel Aviv"),
    (34.05, -118.24, "Los Angeles"),
    (30.04, 31.24, "Cairo"),
    (55.75, 37.62, "Moscow"),
    (13.75, 100.49, "Bangkok"),
    (28.61, 77.21, "Delhi"),
    (52.52, 13.40, "Berlin"),
]


def per_city_bbox(lat: float, lon: float, pad: float = 0.5) -> list[float]:
    # CDS area: [N, W, S, E]
    return [lat + pad, lon - pad, lat - pad, lon + pad]


def regional_bboxes() -> list[list[float]]:
    """Four boxes covering all 10 cities (over-broad is fine for the test).

    NA-west  : LA                          → [50, -130, 30, -110]
    NA-east  : NYC                         → [50,  -80, 30,  -70]
    Eurasia  : London, Berlin, TA, Cairo,  → [60,   -5, 25,   50]
               Moscow, Delhi
    Asia-Pac : Bangkok, Tokyo              → [40,   95, 10,  145]
    """
    return [
        [50, -130, 30, -110],
        [50, -80, 30, -70],
        [60, -5, 25, 50],
        [40, 95, 10, 145],
    ]


def run_jobs(jobs: list[tuple[str, RequestSpec]]) -> list[dict]:
    """Submit all jobs upfront, then poll CDS every 15s.

    Avoids holding open HTTP connections. CDS lets you queue ~20 requests on
    the free tier and runs ~2 at a time. Submitting all of them at once keeps
    the queue full so we don't waste slot time."""
    client = cdsapi.Client(wait_until_complete=False, quiet=True)

    remotes: dict[str, dict] = {}
    t_submit = time.time()
    print(f"  submitting {len(jobs)} requests...")
    for label, spec in jobs:
        try:
            r = client.retrieve(DATASET, spec.to_cds())
            req_id = getattr(r, "request_id", None)
            remotes[label] = {
                "spec": spec,
                "remote": r,
                "submitted_at": time.time(),
                "queue_to_running_s": None,
                "running_to_done_s": None,
                "last_state": None,
                "first_seen_running": None,
                "done": False,
                "ok": False,
                "size_mb": 0.0,
                "error": None,
                "request_id": req_id,
            }
            print(f"    submitted [{label}] id={req_id}")
        except Exception as e:  # noqa: BLE001
            print(f"    FAILED to submit [{label}]: {e!r}")
            remotes[label] = {
                "spec": spec, "remote": None, "submitted_at": time.time(),
                "done": True, "ok": False, "error": repr(e), "size_mb": 0.0,
                "queue_to_running_s": None, "running_to_done_s": None,
                "last_state": "submit_failed", "first_seen_running": None,
                "request_id": None,
            }
    print(f"  all submitted in {time.time() - t_submit:.1f}s; polling every 15s...")

    poll_interval = 15
    while True:
        pending = [l for l, r in remotes.items() if not r["done"]]
        if not pending:
            break
        for label in pending:
            entry = remotes[label]
            r = entry["remote"]
            try:
                r.update()
                # cdsapi 0.7.x: status is a method
                status_attr = getattr(r, "status", None)
                state = status_attr() if callable(status_attr) else (status_attr or "?")
            except Exception as e:  # noqa: BLE001
                state = f"err:{e!r}"
            now = time.time()
            elapsed = now - entry["submitted_at"]

            if state != entry["last_state"]:
                print(f"  [{label}] {entry['last_state']} -> {state} (@ {elapsed:.0f}s)")
                entry["last_state"] = state
                if state == "running" and entry["first_seen_running"] is None:
                    entry["first_seen_running"] = now
                    entry["queue_to_running_s"] = elapsed

            if state in ("successful", "completed"):
                dest = TMP / f"{label}.nc"
                try:
                    r.download(str(dest))
                    entry["size_mb"] = dest.stat().st_size / 1e6
                    if entry["first_seen_running"]:
                        entry["running_to_done_s"] = now - entry["first_seen_running"]
                    entry["ok"] = True
                    print(
                        f"  [{label}] DOWNLOADED {entry['size_mb']:.1f}MB "
                        f"(queue={entry['queue_to_running_s']}, "
                        f"run={entry['running_to_done_s']}, total={elapsed:.0f}s)"
                    )
                except Exception as e:  # noqa: BLE001
                    entry["error"] = repr(e)
                    print(f"  [{label}] download failed: {e!r}")
                entry["done"] = True
            elif state == "failed":
                entry["error"] = str(getattr(r, "reply", "failed"))
                entry["done"] = True
                print(f"  [{label}] FAILED: {entry['error']}")

        if any(not r["done"] for r in remotes.values()):
            time.sleep(poll_interval)

    return [
        {
            "label": label,
            "year": e["spec"].year,
            "target": e["spec"].target,
            "area": e["spec"].area,
            "ok": e["ok"],
            "size_mb": e["size_mb"],
            "queue_to_running_s": e["queue_to_running_s"],
            "running_to_done_s": e["running_to_done_s"],
            "error": e["error"],
        }
        for label, e in remotes.items()
    ]


def strategy_per_city(year: int, cities, targets) -> list[tuple[str, RequestSpec]]:
    jobs = []
    for lat, lon, name in cities:
        slug = name.replace(" ", "_")
        for tgt in targets:
            jobs.append(
                (f"A_{slug}_{tgt}", RequestSpec(year, tgt, area=per_city_bbox(lat, lon)))
            )
    return jobs


def strategy_global(year: int, cities, targets) -> list[tuple[str, RequestSpec]]:
    return [(f"B_global_{tgt}", RequestSpec(year, tgt, area=None)) for tgt in targets]


def strategy_regional(year: int, cities, targets) -> list[tuple[str, RequestSpec]]:
    jobs = []
    for i, bbox in enumerate(regional_bboxes()):
        for tgt in targets:
            jobs.append((f"C_region{i}_{tgt}", RequestSpec(year, tgt, area=bbox)))
    return jobs


STRATEGIES = {
    "A": ("per_city", strategy_per_city),
    "B": ("global", strategy_global),
    "C": ("regional", strategy_regional),
}


def main() -> int:
    ap = argparse.ArgumentParser()
    ap.add_argument("--year", type=int, default=2020)
    ap.add_argument("--strategies", default="A,C", help="comma list of A|B|C")
    ap.add_argument(
        "--n-cities",
        type=int,
        default=3,
        help="number of cities to include (for A and C); default 3 to keep the bench short",
    )
    ap.add_argument(
        "--targets",
        default="tmin",
        help=f"comma list of targets to test; subset of {','.join(TARGETS)}. "
        "Default tmin: one request per (city|region) is enough to measure queue+size.",
    )
    args = ap.parse_args()

    cities = CITIES[: args.n_cities]
    targets = [t.strip() for t in args.targets.split(",") if t.strip()]
    for t in targets:
        if t not in TARGETS:
            print(f"unknown target {t}; valid: {list(TARGETS)}")
            return 2
    print(f"Benchmarking with {len(cities)} cities, targets={targets}")

    TMP.mkdir(parents=True, exist_ok=True)

    results = {"year": args.year, "max_concurrent": MAX_CONCURRENT, "strategies": {}}
    for key in args.strategies.split(","):
        key = key.strip().upper()
        if key not in STRATEGIES:
            print(f"unknown strategy {key}")
            continue
        name, builder = STRATEGIES[key]
        print(f"\n=== Strategy {key}: {name} ===")
        jobs = builder(args.year, cities, targets)
        print(f"  {len(jobs)} requests")
        t0 = time.time()
        recs = run_jobs(jobs)
        wall = time.time() - t0
        total_mb = sum(r.get("size_mb", 0) for r in recs)
        ok = sum(1 for r in recs if r["ok"])
        print(
            f"  wall={wall:.1f}s ok={ok}/{len(recs)} total_size={total_mb:.1f}MB"
        )
        results["strategies"][key] = {
            "name": name,
            "n_requests": len(jobs),
            "wall_s": wall,
            "total_mb": total_mb,
            "n_ok": ok,
            "records": recs,
        }

    OUT_JSON.write_text(json.dumps(results, indent=2, default=str))
    print(f"\nWrote {OUT_JSON}")
    return 0


if __name__ == "__main__":
    raise SystemExit(main())

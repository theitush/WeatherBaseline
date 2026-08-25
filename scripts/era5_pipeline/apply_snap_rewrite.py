#!/usr/bin/env python3
"""Execute snap_rewrite_plan.csv: R2 key renames, drops, and the cells.csv rewrite.

Run AFTER verify_snap_rewrite.py passes. Phased and idempotent — each phase can
be re-run safely; nothing is deleted until --delete-old, which is the last R2
step and requires --yes.

  --copy       server-side copy every mover's four tier objects old->new key
               (archive/recent/forecast/debias). ETag-verified. recent/forecast
               may legitimately not exist (the Worker writes them on demand) —
               skipped with a note. archive/debias must exist — hard error.
  --write-csv  rewrite data/cells.csv (and copy to frontend/public/cells.csv):
               drop merged/decision rows, move mover coordinates to the land
               gridpoint, recompute tile fields, apply survivor renames and
               max-population. CRLF preserved; untouched rows byte-identical.
  --delete-old delete movers' OLD keys and dropped cells' keys (all four tiers,
               only objects that exist). Requires --yes. Old permalinks to
               moved cells then 404 until the client's cells.csv refreshes —
               the URL-snap fallback in the frontend covers this.
  --deprecate  the non-destructive alternative to --delete-old (USER CHOICE
               2026-08-25): server-side copy each old object to
               deprecated/{tier}/... (ETag-verified), then delete the
               original key. The live namespaces come up clean while every
               byte stays recoverable under the deprecated/ prefix. Requires
               --yes for the post-copy delete of the originals.
  --status     HEAD every old/new key and summarize state.

Auth: R2 S3 credentials from env, or loaded automatically from r2.env next to
this script (same variables r2_upload.py documents).

Ordering used for the 2026-08 rewrite: --copy, --write-csv, San Andrés re-pull
(download_cells.py --tile 15_27 --cells "San Andrés, Colombia" --overwrite
--upload-r2 — its solar offset flips -5h -> -6h so the archive content must be
re-bucketed, a key copy is not enough), elevation regen, frontend deploy,
--delete-old --yes, --status.
"""
from __future__ import annotations

import argparse
import csv
import os
import shutil
import sys
from collections import defaultdict
from pathlib import Path

from r2_upload import R2Uploader

SCRIPT_DIR = Path(__file__).resolve().parent


def _load_r2_env() -> None:
    """Fill missing R2_* vars from r2.env so no shell sourcing is needed."""
    env_file = SCRIPT_DIR / "r2.env"
    if not env_file.exists():
        return
    for line in env_file.read_text().splitlines():
        if "=" in line and not line.lstrip().startswith("#"):
            k, v = line.split("=", 1)
            os.environ.setdefault(k.strip(), v.strip())
PLAN_CSV = SCRIPT_DIR / "snap_rewrite_plan.csv"
CELLS_CSV = SCRIPT_DIR.parent.parent / "data" / "cells.csv"
FRONTEND_CELLS_CSV = SCRIPT_DIR.parent.parent / "frontend" / "public" / "cells.csv"

TIERS = ("archive", "recent", "forecast", "debias")
OPTIONAL_TIERS = {"recent", "forecast"}  # Worker writes these on demand


def key_for(tier: str, base: str) -> str:
    return f"{tier}/{tier}_{base}.csv.gz"


def load_plan() -> list[dict]:
    with PLAN_CSV.open() as f:
        plan = list(csv.DictReader(f))
    movers = [r for r in plan if r["action"] in ("move", "move_repull")]
    drops = [r for r in plan if r["action"].startswith("drop")]
    # A mover's destination key must never be a key some other plan row is
    # vacating — copy-then-delete would race. Land destinations can't equal
    # ocean-snapped origins, but assert rather than assume.
    old_bases = {r["old_base"] for r in plan}
    dest_bases = [r["new_base"] for r in movers]
    assert not old_bases & set(dest_bases), "mover destination collides with a vacated key"
    assert len(dest_bases) == len(set(dest_bases)), "two movers share a destination"
    return plan


def head_etag(up: R2Uploader, key: str) -> str | None:
    try:
        return up.client.head_object(Bucket=up.bucket, Key=key)["ETag"]
    except Exception:  # noqa: BLE001 — R2 surfaces 404 as ClientError
        return None


def do_copy(up: R2Uploader, plan: list[dict]) -> int:
    movers = [r for r in plan if r["action"] in ("move", "move_repull")]
    stats = defaultdict(int)
    failures = 0
    for i, r in enumerate(movers, 1):
        for tier in TIERS:
            old_key = key_for(tier, r["old_base"])
            new_key = key_for(tier, r["new_base"])
            old_etag = head_etag(up, old_key)
            if old_etag is None:
                if tier in OPTIONAL_TIERS:
                    stats[f"{tier}:absent"] += 1
                    continue
                print(f"  FAIL {r['name']}: required {old_key} missing")
                failures += 1
                continue
            new_etag = head_etag(up, new_key)
            if new_etag == old_etag:
                stats[f"{tier}:already"] += 1
                continue
            if new_etag is not None:
                # A different object already at the destination — never clobber
                # silently; the plan said this gridpoint is unclaimed.
                print(f"  FAIL {r['name']}: {new_key} exists with different content")
                failures += 1
                continue
            up.client.copy_object(
                Bucket=up.bucket, Key=new_key,
                CopySource={"Bucket": up.bucket, "Key": old_key},
            )
            if head_etag(up, new_key) != old_etag:
                print(f"  FAIL {r['name']}: post-copy ETag mismatch on {new_key}")
                failures += 1
                continue
            stats[f"{tier}:copied"] += 1
        if i % 20 == 0:
            print(f"  ... {i}/{len(movers)} movers")
    print(f"[copy] {len(movers)} mover(s): "
          + ", ".join(f"{k}={v}" for k, v in sorted(stats.items())))
    print(f"[copy] {failures} failure(s)")
    return failures


def do_write_csv(plan: list[dict]) -> int:
    drops = {r["name"] for r in plan if r["action"].startswith("drop")}
    movers = {r["name"]: r for r in plan if r["action"] in ("move", "move_repull")}
    # Survivor rename/population, keyed by the surviving row's CURRENT name.
    # Multiple drops can merge into one survivor (Fajardo absorbs two) — the
    # survivor takes the max population any of them computed.
    survivor: dict[str, dict] = {}
    for r in plan:
        if not r["action"].startswith("drop"):
            continue
        s = survivor.setdefault(r["merge_into"], {"name": r["survivor_name"], "pop": 0})
        assert s["name"] == r["survivor_name"], f"conflicting survivor names for {r['merge_into']}"
        s["pop"] = max(s["pop"], int(r["survivor_population"]))

    with CELLS_CSV.open(newline="") as f:
        text_rows = f.read().split("\r\n")
    header = text_rows[0]
    fields = header.split(",")
    out_lines = [header]
    kept = dropped = moved = renamed = untouched = 0
    seen_coords: dict[tuple, str] = {}
    for line in text_rows[1:]:
        if not line:
            continue
        row = next(csv.DictReader([line], fieldnames=fields))
        name = row["name"]
        if name in drops:
            dropped += 1
            continue
        touched = False
        if name in movers:
            m = movers[name]
            row["lat"], row["lon"] = m["new_lat"], m["new_lon"]
            row["tile_id"] = m["new_tile_id"]
            row["tile_lat"], row["tile_lon"] = m["new_tile_lat"], m["new_tile_lon"]
            moved += 1
            touched = True
        if name in survivor:
            s = survivor[name]
            if s["name"] != name:
                row["name"] = s["name"]
                renamed += 1
            row["population"] = str(max(int(row["population"] or 0), s["pop"]))
            touched = True
        coord = (row["lat"], row["lon"])
        assert coord not in seen_coords, \
            f"coordinate collision after rewrite: {row['name']} vs {seen_coords[coord]}"
        seen_coords[coord] = row["name"]
        if touched:
            buf: list[str] = []
            csv.DictWriter(_ListWriter(buf), fieldnames=fields,
                           lineterminator="").writerow(row)
            out_lines.append("".join(buf))
        else:
            # Untouched rows pass through byte-verbatim — no re-serialization
            # drift (quoting, float formatting) can creep into 8.4K rows.
            untouched += 1
            out_lines.append(line)
        kept += 1

    out_text = "\r\n".join(out_lines) + "\r\n"
    CELLS_CSV.write_text(out_text, newline="")
    shutil.copyfile(CELLS_CSV, FRONTEND_CELLS_CSV)
    print(f"[write-csv] kept {kept} (dropped {dropped}, moved {moved}, "
          f"renamed {renamed}, untouched {untouched}) -> {CELLS_CSV}")
    print(f"[write-csv] copied to {FRONTEND_CELLS_CSV}")
    return 0


class _ListWriter:
    """File-like shim so csv can write one row into a list as a single string."""

    def __init__(self, sink: list[str]):
        self.sink = sink

    def write(self, s: str) -> None:
        self.sink.append(s)


def do_delete_old(up: R2Uploader, plan: list[dict], yes: bool) -> int:
    targets = []
    for r in plan:
        if r["action"] in ("move", "move_repull") or r["action"].startswith("drop"):
            for tier in TIERS:
                targets.append((r["name"], key_for(tier, r["old_base"])))
    existing = [(n, k) for n, k in targets if head_etag(up, k) is not None]
    print(f"[delete-old] {len(existing)} existing object(s) across "
          f"{len(plan)} plan row(s) would be deleted")
    if not yes:
        print("[delete-old] dry run — pass --yes to delete")
        return 0
    for n, k in existing:
        up.client.delete_object(Bucket=up.bucket, Key=k)
    # Confirm they're gone.
    leftovers = [(n, k) for n, k in existing if head_etag(up, k) is not None]
    for n, k in leftovers:
        print(f"  FAIL still present: {k} ({n})")
    print(f"[delete-old] deleted {len(existing) - len(leftovers)}, "
          f"{len(leftovers)} leftover(s)")
    return len(leftovers)


def do_deprecate(up: R2Uploader, plan: list[dict], yes: bool) -> int:
    """Move every retired old-key object under deprecated/ instead of deleting."""
    targets = []
    for r in plan:
        if r["action"] in ("move", "move_repull") or r["action"].startswith("drop"):
            for tier in TIERS:
                targets.append((r["name"], key_for(tier, r["old_base"])))
    existing = [(n, k, head_etag(up, k)) for n, k in targets]
    existing = [(n, k, e) for n, k, e in existing if e is not None]
    print(f"[deprecate] {len(existing)} object(s) to move under deprecated/")
    if not yes:
        print("[deprecate] dry run — pass --yes to move them")
        return 0
    failures = 0
    moved = kept = 0
    for n, k, etag in existing:
        dep_key = f"deprecated/{k}"
        if head_etag(up, dep_key) != etag:
            up.client.copy_object(
                Bucket=up.bucket, Key=dep_key,
                CopySource={"Bucket": up.bucket, "Key": k},
            )
            if head_etag(up, dep_key) != etag:
                print(f"  FAIL copy mismatch: {dep_key} ({n}) — original kept")
                failures += 1
                kept += 1
                continue
        up.client.delete_object(Bucket=up.bucket, Key=k)
        moved += 1
    leftovers = [(n, k) for n, k, _ in existing if head_etag(up, k) is not None]
    print(f"[deprecate] moved {moved}, kept-in-place {kept}, "
          f"originals still present {len(leftovers)}")
    return failures + len(leftovers) - kept


def do_status(up: R2Uploader, plan: list[dict]) -> int:
    counts = defaultdict(int)
    for r in plan:
        mover = r["action"] in ("move", "move_repull")
        for tier in TIERS:
            old_there = head_etag(up, key_for(tier, r["old_base"])) is not None
            counts[f"{tier}:old-present" if old_there else f"{tier}:old-gone"] += 1
            if mover:
                new_there = head_etag(up, key_for(tier, r["new_base"])) is not None
                counts[f"{tier}:new-present" if new_there else f"{tier}:new-absent"] += 1
    for k in sorted(counts):
        print(f"  {k:24s} {counts[k]}")
    return 0


def main() -> int:
    ap = argparse.ArgumentParser(description=__doc__)
    ap.add_argument("--copy", action="store_true")
    ap.add_argument("--write-csv", action="store_true")
    ap.add_argument("--delete-old", action="store_true")
    ap.add_argument("--deprecate", action="store_true")
    ap.add_argument("--status", action="store_true")
    ap.add_argument("--yes", action="store_true",
                    help="confirm --delete-old / --deprecate")
    args = ap.parse_args()
    if not (args.copy or args.write_csv or args.delete_old or args.deprecate
            or args.status):
        ap.error("pick a phase: --copy / --write-csv / --deprecate / "
                 "--delete-old / --status")

    plan = load_plan()
    failures = 0
    if args.copy or args.delete_old or args.deprecate or args.status:
        _load_r2_env()
        up = R2Uploader()
    else:
        up = None
    if args.copy:
        failures += do_copy(up, plan)
    if args.write_csv:
        failures += do_write_csv(plan)
    if args.deprecate:
        failures += do_deprecate(up, plan, args.yes)
    if args.delete_old:
        failures += do_delete_old(up, plan, args.yes)
    if args.status:
        failures += do_status(up, plan)
    return 1 if failures else 0


if __name__ == "__main__":
    sys.exit(main())

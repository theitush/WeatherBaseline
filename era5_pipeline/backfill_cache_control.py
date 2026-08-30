#!/usr/bin/env python3
"""One-shot: stamp the correct Cache-Control onto archive objects already in R2.

`r2_upload.py` now uploads archive files with `Cache-Control: public, no-cache`
(so a freshly-extended archive is revalidated and never served stale — see the
CACHE_CONTROL note there). But objects uploaded before that change carry no
Cache-Control at all, so the edge/browser caches them heuristically and a client
can keep a short, stale archive after a trailing-year top-up. Re-uploading every
cell just to fix a header would re-transfer ~gigabytes; instead we do a
metadata-only server-side copy (CopyObject onto the same key with
MetadataDirective=REPLACE), which rewrites the header without moving the bytes.

The work is thousands of independent, latency-bound S3 round-trips (one HEAD, and
a CopyObject only where the header is wrong), so it runs across a thread pool and
prints running progress with an ETA. boto3 clients are thread-safe for distinct
calls, so the pool shares one R2Uploader.

Idempotent: skips objects that already have the target header. Safe to re-run.

    # dry run — HEAD every object, report which would change, touch nothing
    era5_pipeline/.venv/bin/python era5_pipeline/backfill_cache_control.py --dry-run

    # apply (32 workers)
    era5_pipeline/.venv/bin/python era5_pipeline/backfill_cache_control.py --workers 32

Needs the same R2 creds as r2_upload.py (R2_ACCOUNT_ID / R2_ACCESS_KEY_ID /
R2_SECRET_ACCESS_KEY, from an R2 Object Read & Write S3 API token).
"""
import argparse
import sys
import time
from concurrent.futures import ThreadPoolExecutor, as_completed
from datetime import datetime

from botocore.exceptions import ClientError

from r2_upload import CACHE_CONTROL, R2Uploader

# recent/forecast are no-store and rewritten constantly by the Worker, so their
# header is always current — only the producer-written archive tier needs a
# backfill. Kept as a tuple so it's obvious how to widen it if that changes.
PREFIXES = ("archive/",)

CONTENT_TYPE = "text/csv; charset=utf-8"
CONTENT_ENCODING = "gzip"

# HEAD/copy under heavy concurrency can draw a transient 429/503 from R2; retry a
# few times with backoff before giving up on an object.
_RETRY_STATUSES = {"429", "500", "502", "503", "SlowDown", "InternalError"}
_MAX_ATTEMPTS = 5

_T0 = time.time()


def log(msg: str) -> None:
    """Timestamped log: wall-clock time + elapsed seconds since start."""
    now = datetime.now().strftime("%H:%M:%S")
    print(f"[{now} | +{time.time() - _T0:6.1f}s] {msg}", flush=True)


def _is_transient(err: ClientError) -> bool:
    resp = err.response or {}
    code = str(resp.get("Error", {}).get("Code", ""))
    http = str(resp.get("ResponseMetadata", {}).get("HTTPStatusCode", ""))
    return code in _RETRY_STATUSES or http in _RETRY_STATUSES


def _with_retry(fn):
    """Call fn(), retrying transient R2 errors with exponential backoff."""
    for attempt in range(1, _MAX_ATTEMPTS + 1):
        try:
            return fn()
        except ClientError as e:
            if attempt == _MAX_ATTEMPTS or not _is_transient(e):
                raise
            time.sleep(0.5 * 2 ** (attempt - 1))  # 0.5, 1, 2, 4s


def list_keys(up: R2Uploader, prefix: str) -> list[str]:
    """Every object key under `prefix`, gathered before processing so we can show
    a total and an ETA."""
    keys: list[str] = []
    paginator = up.client.get_paginator("list_objects_v2")
    for page in paginator.paginate(Bucket=up.bucket, Prefix=prefix):
        for obj in page.get("Contents", []):
            keys.append(obj["Key"])
        log(f"  listing {prefix} … {len(keys)} objects so far")
    return keys


def process_key(up: R2Uploader, key: str, target: str, dry_run: bool) -> str:
    """HEAD one object; rewrite its Cache-Control if wrong. Returns the outcome:
    'skip' (already correct), 'would' (dry-run, needs change), or 'changed'."""
    head = _with_retry(lambda: up.client.head_object(Bucket=up.bucket, Key=key))
    if head.get("CacheControl") == target:
        return "skip"
    if dry_run:
        return "would"
    # Server-side copy onto itself, replacing metadata — no byte transfer.
    # ContentType/Encoding must be restated or REPLACE would drop them.
    _with_retry(lambda: up.client.copy_object(
        Bucket=up.bucket,
        Key=key,
        CopySource={"Bucket": up.bucket, "Key": key},
        MetadataDirective="REPLACE",
        ContentType=CONTENT_TYPE,
        ContentEncoding=CONTENT_ENCODING,
        CacheControl=target,
    ))
    return "changed"


def _fmt_eta(done: int, total: int, elapsed: float) -> str:
    if done == 0:
        return "?"
    remaining = (elapsed / done) * (total - done)
    m, s = divmod(int(remaining), 60)
    return f"{m}m{s:02d}s"


def backfill(up: R2Uploader, prefix: str, dry_run: bool, workers: int) -> tuple[int, int, int]:
    """Rewrite Cache-Control on every object under `prefix`, in parallel.
    Returns (changed, errors, seen)."""
    target = CACHE_CONTROL[prefix.rstrip("/")]
    log(f"== {prefix} (target: {target!r}) — listing objects …")
    keys = list_keys(up, prefix)
    total = len(keys)
    if not total:
        log(f"   no objects under {prefix}")
        return 0, 0, 0

    verb = "checking (dry-run)" if dry_run else "rewriting"
    log(f"   {verb} {total} objects with {workers} workers …")

    changed = errors = done = 0
    # progress cadence: ~40 updates over the run, but at least every 200 objects.
    step = max(1, min(200, total // 40))
    with ThreadPoolExecutor(max_workers=workers) as ex:
        futs = {ex.submit(process_key, up, k, target, dry_run): k for k in keys}
        for fut in as_completed(futs):
            key = futs[fut]
            try:
                outcome = fut.result()
                if outcome in ("changed", "would"):
                    changed += 1
            except Exception as e:  # noqa: BLE001 - report and keep going
                errors += 1
                log(f"   ERROR {key}: {e}")
            done += 1
            if done % step == 0 or done == total:
                elapsed = time.time() - _T0
                rate = done / elapsed if elapsed else 0
                tag = "would change" if dry_run else "changed"
                log(f"   {done}/{total}  ({tag} {changed}, err {errors})  "
                    f"{rate:.0f}/s  ETA {_fmt_eta(done, total, elapsed)}")
    return changed, errors, total


def main() -> int:
    ap = argparse.ArgumentParser(description=__doc__)
    ap.add_argument("--dry-run", action="store_true", help="HEAD every object, list changes, touch nothing")
    ap.add_argument("--workers", type=int, default=32, help="parallel HEAD/copy round-trips (default: 32)")
    args = ap.parse_args()

    up = R2Uploader()
    total_changed = total_errors = total_seen = 0
    for prefix in PREFIXES:
        changed, errors, seen = backfill(up, prefix, args.dry_run, args.workers)
        verb = "would rewrite" if args.dry_run else "rewrote"
        log(f"   {verb} {changed} / {seen} objects ({errors} errors)\n")
        total_changed += changed
        total_errors += errors
        total_seen += seen
    tail = "to change" if args.dry_run else "changed"
    log(f"done in {time.time() - _T0:.1f}s: {total_changed} / {total_seen} objects "
        f"{tail}, {total_errors} errors")
    return 1 if total_errors else 0


if __name__ == "__main__":
    sys.exit(main())

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

Idempotent: skips objects that already have the target header. Safe to re-run.

    # dry run — list what would change, touch nothing
    scripts/era5_pipeline/.venv/bin/python scripts/era5_pipeline/backfill_cache_control.py --dry-run

    # apply
    scripts/era5_pipeline/.venv/bin/python scripts/era5_pipeline/backfill_cache_control.py

Needs the same R2 creds as r2_upload.py (R2_ACCOUNT_ID / R2_ACCESS_KEY_ID /
R2_SECRET_ACCESS_KEY, from an R2 Object Read & Write S3 API token).
"""
import argparse
import sys

from r2_upload import CACHE_CONTROL, R2Uploader

# recent/forecast are no-store and rewritten constantly by the Worker, so their
# header is always current — only the producer-written archive tier needs a
# backfill. Kept as a tuple so it's obvious how to widen it if that changes.
PREFIXES = ("archive/",)

CONTENT_TYPE = "text/csv; charset=utf-8"
CONTENT_ENCODING = "gzip"


def backfill(prefix: str, dry_run: bool) -> tuple[int, int]:
    """Rewrite Cache-Control on every object under `prefix`. Returns (changed, seen)."""
    up = R2Uploader()
    target = CACHE_CONTROL[prefix.rstrip("/")]
    paginator = up.client.get_paginator("list_objects_v2")
    changed = seen = 0
    for page in paginator.paginate(Bucket=up.bucket, Prefix=prefix):
        for obj in page.get("Contents", []):
            key = obj["Key"]
            seen += 1
            # HEAD to see the current header — skip objects already correct so a
            # re-run is cheap and only touches what's actually stale.
            head = up.client.head_object(Bucket=up.bucket, Key=key)
            if head.get("CacheControl") == target:
                continue
            changed += 1
            if dry_run:
                print(f"would set  {key}  (was {head.get('CacheControl')!r})")
                continue
            # Server-side copy onto itself, replacing metadata — no byte transfer.
            # ContentType/Encoding must be restated or REPLACE would drop them.
            up.client.copy_object(
                Bucket=up.bucket,
                Key=key,
                CopySource={"Bucket": up.bucket, "Key": key},
                MetadataDirective="REPLACE",
                ContentType=CONTENT_TYPE,
                ContentEncoding=CONTENT_ENCODING,
                CacheControl=target,
            )
            if changed % 200 == 0:
                print(f"  … {changed} rewritten", flush=True)
    return changed, seen


def main() -> int:
    ap = argparse.ArgumentParser(description=__doc__)
    ap.add_argument("--dry-run", action="store_true", help="list changes, touch nothing")
    args = ap.parse_args()

    total_changed = total_seen = 0
    for prefix in PREFIXES:
        print(f"== {prefix} (target: {CACHE_CONTROL[prefix.rstrip('/')]!r}) ==")
        changed, seen = backfill(prefix, args.dry_run)
        verb = "would rewrite" if args.dry_run else "rewrote"
        print(f"   {verb} {changed} / {seen} objects\n")
        total_changed += changed
        total_seen += seen
    print(f"done: {total_changed} / {total_seen} objects {'to change' if args.dry_run else 'changed'}")
    return 0


if __name__ == "__main__":
    sys.exit(main())

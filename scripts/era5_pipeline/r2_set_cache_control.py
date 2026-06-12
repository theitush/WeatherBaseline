"""Backfill Cache-Control metadata on existing tier objects in R2.

New writes get the right Cache-Control from r2_upload.py / the Worker's
cellStore.js, but objects uploaded before that change have none — and with the
data served via the custom domain (data.weatherbaseline.com), Cloudflare's edge
default-caches .gz files for ~2h when the origin sends no Cache-Control. This
rewrites each object's metadata in place (S3 CopyObject onto itself with
MetadataDirective=REPLACE) to the per-tier policy in r2_upload.CACHE_CONTROL:
no-store for the volatile recent/forecast tiers, a day for archive.

The copy is metadata-only and atomic; body bytes and the key are unchanged.
Content-Type/Encoding are re-asserted from each object's existing HEAD (REPLACE
would otherwise drop them). Safe to re-run.

Auth: same R2 S3 API token env vars as r2_upload.py (source r2.env first).

Usage (from scripts/era5_pipeline/):
  set -a; source r2.env; set +a
  .venv/bin/python r2_set_cache_control.py --tiers recent forecast   # volatile first
  .venv/bin/python r2_set_cache_control.py --tiers archive --workers 32
"""
from __future__ import annotations

import argparse
import os
import sys
from concurrent.futures import ThreadPoolExecutor, as_completed

from r2_upload import CACHE_CONTROL, DEFAULT_BUCKET, R2Uploader, TIERS


def rewrite(client, bucket: str, key: str, cache_control: str) -> bool:
    """Set Cache-Control on one object; returns False if already set."""
    head = client.head_object(Bucket=bucket, Key=key)
    if head.get("CacheControl") == cache_control:
        return False
    client.copy_object(
        Bucket=bucket,
        Key=key,
        CopySource={"Bucket": bucket, "Key": key},
        MetadataDirective="REPLACE",
        ContentType=head.get("ContentType", "text/csv; charset=utf-8"),
        ContentEncoding=head.get("ContentEncoding", "gzip"),
        CacheControl=cache_control,
        Metadata=head.get("Metadata", {}),
    )
    return True


def main() -> int:
    ap = argparse.ArgumentParser(description="Backfill Cache-Control on R2 tier objects.")
    ap.add_argument("--bucket", default=os.environ.get("R2_BUCKET", DEFAULT_BUCKET))
    ap.add_argument("--tiers", nargs="+", choices=TIERS, default=list(TIERS))
    ap.add_argument("--workers", type=int, default=16)
    args = ap.parse_args()
    client = R2Uploader(bucket=args.bucket).client

    for tier in args.tiers:
        keys = [
            o["Key"]
            for page in client.get_paginator("list_objects_v2").paginate(
                Bucket=args.bucket, Prefix=f"{tier}/"
            )
            for o in page.get("Contents", [])
        ]
        cc = CACHE_CONTROL[tier]
        done = skipped = 0
        with ThreadPoolExecutor(max_workers=args.workers) as ex:
            futs = {ex.submit(rewrite, client, args.bucket, k, cc): k for k in keys}
            for fut in as_completed(futs):
                if fut.result():
                    done += 1
                else:
                    skipped += 1
                if (done + skipped) % 1000 == 0:
                    print(f"  {tier}: {done + skipped}/{len(keys)}", flush=True)
        print(f"{tier}: {done} rewritten, {skipped} already set ('{cc}')")
    return 0


if __name__ == "__main__":
    raise SystemExit(main())

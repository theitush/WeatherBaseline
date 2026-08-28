"""Upload tier .csv.gz files to the Cloudflare R2 bucket over the S3 API.

One uploader for BOTH paths:
  - local test seed (a few hundred files from data/era5-land/, run as a CLI), and
  - the VM producer (download_cells.py imports upload_file / R2Uploader to push
    each archive_*.csv.gz to R2 as it's written).

Auth — set these env vars (an R2 "Object Read & Write" S3 API token):
  R2_ACCESS_KEY_ID       access key id
  R2_SECRET_ACCESS_KEY   secret access key
  R2_ACCOUNT_ID          Cloudflare account id (forms the S3 endpoint)
  R2_BUCKET              bucket name (default: weather-baseline)

The endpoint is https://<account-id>.r2.cloudflarestorage.com . Objects are
written with Content-Type: text/csv and Content-Encoding: gzip so the public
r2.dev URL serves a browser-gunzippable file — matching how the Worker/Express
static route sets the same headers. Keys mirror the tier layout: {tier}/{name},
with {name} = {tier}_{lat}_{lon}.csv.gz built ONLY via cell_keys.py (it drops
the sign of a -0.0 axis so Python keys match the JS readers' `toFixed(1)`).

CLI usage (local test, from era5_pipeline/):
  source .venv/bin/activate
  python r2_upload.py --tiers recent forecast        # fast volatile-only seed
  python r2_upload.py --tiers archive recent forecast
  python r2_upload.py --dir ../../data/era5-land --workers 16

Importable usage (producer):
  from r2_upload import R2Uploader
  up = R2Uploader()                 # reads env
  up.upload_file(path, "archive/archive_32.1_34.8.csv.gz")
"""
from __future__ import annotations

import argparse
import os
import sys
from concurrent.futures import ThreadPoolExecutor, as_completed
from pathlib import Path

import boto3
from botocore.config import Config

DEFAULT_BUCKET = "weather-baseline"
TIERS = ("archive", "recent", "forecast")
# Tiers this CLI can upload but that aren't part of the default era5-land set:
# the static M3_base bias-correction tables (one .csv.gz per cell), which live
# under debias/data/, not data/era5-land/, so you upload them
# explicitly with `--dir .../debias/data --tiers debias-v9`.
#
# The debias prefix is VERSIONED. A regen (IFS cycle cutover, cells.csv change,
# retrain) is baked into a NEW `debias-vN/` dir, uploaded under that same
# prefix, and the frontend's pointer flips to it in one line
# (frontend/src/services/ci.ts DEBIAS_PREFIX). A prefix is never overwritten,
# so shipping and rolling back are both a frontend redeploy — no R2 writes to
# the live set, no edge-cache purge, no mixed-schema window. Add the next
# version here before uploading it; leave the retired ones until they are
# moved to deprecated/.
#   debias     7-level qn8727_s0 bake (2026-07-05), retired 2026-08-28
#   debias-v9  9-level qn8620_s0_q9 bake (2026-08-26)
DEBIAS_TIERS = ("debias", "debias-v9")
EXTRA_TIERS = DEBIAS_TIERS
UPLOADABLE_TIERS = TIERS + EXTRA_TIERS

# Cache-Control per tier, stored as object metadata so R2 serves it as the
# origin header. The data domain (data.weatherbaseline.com) sits behind
# Cloudflare's cache and .gz is default-cacheable, so without an explicit header
# the edge/browser would serve stale copies after a refresh.
#
# recent/forecast are rewritten constantly -> no-store. archive USED to get a
# fixed day (max-age=86400), but the trailing-year top-up now rewrites the
# archive's tail on a monthly rerun AND deletes the cell's `recent` object once
# the archive reaches past it (see run_tile). That makes the archive the SOLE
# source for those newly-covered days: a client still holding yesterday's shorter
# archive finds no recent to fall back on and shows a gap. So archive is
# `no-cache` -> the browser/edge may keep the (large) body but must revalidate it
# via ETag on each use, so a freshly-extended archive is picked up immediately
# while an unchanged one costs only a 304. Keep in sync with worker/src/cellStore.js.
# The debias tiers are unlike archive: a versioned prefix is written once and
# never rewritten (a regen gets a new prefix, see DEBIAS_TIERS), so they're safe
# to cache hard. max-age=86400 lets the edge/browser hold them for a day; a
# pointer flip in the frontend changes the URL, so no purge is ever needed.
# See make_debias_tables.py.
CACHE_CONTROL = {
    "archive": "public, no-cache",
    "recent": "no-store",
    "forecast": "no-store",
    **{tier: "public, max-age=86400" for tier in DEBIAS_TIERS},
}


def cache_control_for(key: str) -> str | None:
    """Cache-Control for an object key, by its tier prefix (None = unknown)."""
    return CACHE_CONTROL.get(key.split("/", 1)[0])


class R2Uploader:
    """Thin wrapper over a boto3 S3 client pointed at R2.

    Reusable across threads (boto3 clients are thread-safe for distinct calls).
    Created once and shared so the VM producer can upload concurrently with its
    tile fetches without re-handshaking TLS per file.
    """

    def __init__(self, bucket: str | None = None):
        account_id = os.environ.get("R2_ACCOUNT_ID")
        access_key = os.environ.get("R2_ACCESS_KEY_ID")
        secret_key = os.environ.get("R2_SECRET_ACCESS_KEY")
        missing = [
            n
            for n, v in [
                ("R2_ACCOUNT_ID", account_id),
                ("R2_ACCESS_KEY_ID", access_key),
                ("R2_SECRET_ACCESS_KEY", secret_key),
            ]
            if not v
        ]
        if missing:
            raise SystemExit(
                f"missing R2 credentials in env: {', '.join(missing)}\n"
                "set them from an R2 Object Read & Write S3 API token."
            )
        self.bucket = bucket or os.environ.get("R2_BUCKET", DEFAULT_BUCKET)
        self.client = boto3.client(
            "s3",
            endpoint_url=f"https://{account_id}.r2.cloudflarestorage.com",
            aws_access_key_id=access_key,
            aws_secret_access_key=secret_key,
            # R2 wants the modern signature; auto region.
            config=Config(signature_version="s3v4", region_name="auto"),
        )

    def upload_file(self, path: Path, key: str) -> None:
        """Upload one .csv.gz file under `key`, with the serve-it-raw headers."""
        extra = {
            "ContentType": "text/csv; charset=utf-8",
            "ContentEncoding": "gzip",
        }
        if cc := cache_control_for(key):
            extra["CacheControl"] = cc
        self.client.upload_file(str(path), self.bucket, key, ExtraArgs=extra)

    def put_bytes(self, data: bytes, key: str, content_type: str) -> None:
        """Upload raw bytes under `key` (used for the small overwrite ledger)."""
        self.client.put_object(
            Bucket=self.bucket, Key=key, Body=data, ContentType=content_type
        )

    def get_bytes(self, key: str) -> bytes | None:
        """Fetch an object's bytes, or None if it doesn't exist."""
        try:
            return self.client.get_object(Bucket=self.bucket, Key=key)["Body"].read()
        except self.client.exceptions.NoSuchKey:
            return None
        except Exception as e:  # noqa: BLE001 - 404 surfaces as ClientError on R2
            if "NoSuchKey" in str(e) or "404" in str(e):
                return None
            raise

    def delete_object(self, key: str) -> None:
        """Delete an object; a missing key is a no-op."""
        self.client.delete_object(Bucket=self.bucket, Key=key)

    def list_sizes(self, prefix: str) -> dict[str, int]:
        """Map every object key under `prefix` to its byte size, in one listing.

        Sizes come straight from the ListObjectsV2 response — no GET, no download.
        Used by the producer's resume to learn, cheaply, which cell archives R2
        already has and roughly how complete each is (a full-history archive is
        far larger than one interrupted mid-fetch).
        """
        sizes: dict[str, int] = {}
        paginator = self.client.get_paginator("list_objects_v2")
        for page in paginator.paginate(Bucket=self.bucket, Prefix=prefix):
            for obj in page.get("Contents", []):
                sizes[obj["Key"]] = obj["Size"]
        return sizes

    def read_coverage(self, key: str, column: str | None = None):
        """Download one archive object; return (per-year row counts, newest date).

        Used by the producer's resume to decide which years still need fetching.
        Returns the number of daily rows present in EACH year — not just the set of
        years — so resume can tell a COMPLETE year (~365/366 rows) from one that's
        present but nearly empty: e.g. a lone stray 2025 row left by old code, which
        a year-set check wrongly reads as "have 2025" and never refills. It also
        still distinguishes a tiny-but-complete desert cell from a genuinely partial
        one, and a caught-up trailing year from one lagging the store.

        `column` (download_cells.COMPLETENESS_COLUMN) narrows "present" to rows
        carrying that column — an archive that predates it reads as empty, which
        is what makes a column backfill resumable from R2 on a fresh box. Reads
        only the needed columns out of the gzip, so the parse stays cheap. Returns
        ({year: row_count}, datetime.date | None); ({}, None) if nothing is covered.
        """
        body = self.client.get_object(Bucket=self.bucket, Key=key)["Body"].read()
        return coverage_from_archive_bytes(body, column)


def coverage_from_archive_bytes(body: bytes, column: str | None = None):
    """(per-year covered-row counts, newest date) for one gzip archive body.

    The parsing half of `R2Uploader.read_coverage`, separated so it can be tested
    without R2. Delegates the "which rows count" rule to download_cells'
    covered_dates so the R2 and local halves of the resume can never disagree.
    """
    import gzip
    import io

    from download_cells import covered_dates

    with gzip.open(io.BytesIO(body), "rt") as fh:
        text = fh.read()
    dates = covered_dates(io.StringIO(text), column)
    if dates.empty:
        return {}, None
    counts = {int(y): int(n) for y, n in dates.dt.year.value_counts().items()}
    return counts, dates.max().date()


def _iter_tier_files(data_dir: Path, tiers):
    """Yield (local_path, r2_key) for every .csv.gz under the given tiers."""
    for tier in tiers:
        tdir = data_dir / tier
        if not tdir.is_dir():
            print(f"skip {tier} (no dir at {tdir})", file=sys.stderr)
            continue
        for f in sorted(tdir.glob("*.csv.gz")):
            yield f, f"{tier}/{f.name}"


def main() -> int:
    ap = argparse.ArgumentParser(description="Upload tier files to R2 (S3 API).")
    ap.add_argument(
        "--dir",
        default=str(Path(__file__).resolve().parents[2] / "data" / "era5-land"),
        help="root containing archive/ recent/ forecast/ (default: data/era5-land)",
    )
    ap.add_argument(
        "--tiers", nargs="+", default=list(TIERS), choices=UPLOADABLE_TIERS,
        help="which tiers to upload (default: the era5-land tiers; the "
             "debias-vN tiers are opt-in and live under a different --dir)",
    )
    ap.add_argument("--bucket", default=None, help="override R2_BUCKET")
    ap.add_argument("--workers", type=int, default=16, help="parallel uploads")
    args = ap.parse_args()

    data_dir = Path(args.dir).resolve()
    up = R2Uploader(bucket=args.bucket)
    jobs = list(_iter_tier_files(data_dir, args.tiers))
    if not jobs:
        print("nothing to upload.")
        return 0

    print(f"uploading {len(jobs)} files to R2 bucket '{up.bucket}' "
          f"({args.workers} workers)...")
    done = 0
    errors = 0
    with ThreadPoolExecutor(max_workers=args.workers) as ex:
        futs = {ex.submit(up.upload_file, p, k): k for p, k in jobs}
        for fut in as_completed(futs):
            key = futs[fut]
            try:
                fut.result()
            except Exception as e:  # noqa: BLE001 - report and keep going
                errors += 1
                print(f"  ERROR {key}: {e}", file=sys.stderr)
            done += 1
            if done % 50 == 0 or done == len(jobs):
                print(f"  {done}/{len(jobs)}")

    print(f"done. {len(jobs) - errors} uploaded, {errors} failed.")
    return 1 if errors else 0


if __name__ == "__main__":
    raise SystemExit(main())

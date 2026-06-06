#!/usr/bin/env bash
# Upload the repo's on-disk tier files to the REAL R2 bucket (weather-baseline)
# via wrangler --remote. This is the one-time push of your local data so the
# deployed frontend can read real archive/recent/forecast straight from R2's
# public URL.
#
# Requires wrangler auth (one of):
#   npx wrangler login                                  # OAuth, browser
#   export CLOUDFLARE_API_TOKEN=... CLOUDFLARE_ACCOUNT_ID=...   # API token
#
# Usage (from worker/):
#   npm run upload                     # all tiers (archive is ~527 files, slow)
#   TIERS="recent forecast" npm run upload   # just the volatile tiers
#
# Keys mirror production: {tier}/{filename}.csv.gz, with Content-Type/Encoding
# set so the public r2.dev URL serves a browser-gunzippable file. Idempotent
# (put overwrites); safe to re-run after an interruption.
#
# NOTE: one wrangler call per object is fine for these ~567 files but too slow
# for the full 10K production pull — that path will use rclone/aws s3 against the
# R2 S3 API (see ARCHITECTURE.md producer-gap notes).
set -euo pipefail

HERE="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
WORKER_DIR="$(dirname "$HERE")"
REPO_DIR="$(dirname "$WORKER_DIR")"
DATA_DIR="$REPO_DIR/data/era5-land"
BUCKET="weather-baseline"   # must match bucket_name in wrangler.toml

TIERS="${TIERS:-archive recent forecast}"

cd "$WORKER_DIR"

total=0
for tier in $TIERS; do
  dir="$DATA_DIR/$tier"
  if [ ! -d "$dir" ]; then
    echo "skip $tier (no dir at $dir)"
    continue
  fi
  count=$(find "$dir" -name '*.csv.gz' | wc -l | tr -d ' ')
  echo "uploading $tier ($count files) to R2 bucket '$BUCKET'..."
  i=0
  for f in "$dir"/*.csv.gz; do
    [ -e "$f" ] || continue
    key="$tier/$(basename "$f")"
    npx wrangler r2 object put "$BUCKET/$key" \
      --file "$f" \
      --content-type "text/csv; charset=utf-8" \
      --content-encoding "gzip" \
      --remote >/dev/null
    i=$((i + 1))
    total=$((total + 1))
    if [ $((i % 25)) -eq 0 ]; then echo "  $tier: $i/$count"; fi
  done
  echo "  $tier: done ($i)"
done

echo "uploaded $total objects to R2 bucket '$BUCKET'."

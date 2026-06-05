#!/usr/bin/env bash
# Seed the LOCAL (Miniflare) R2 bucket from the repo's on-disk tier files, so
# `wrangler dev --local` serves the same archive/recent/forecast data you have
# locally — no Cloudflare account or real bucket needed.
#
# wrangler r2 object put --local writes into the same .wrangler/state that
# `wrangler dev --local` reads, keyed by the bucket_name in wrangler.toml. Keys
# mirror the production layout: {tier}/{filename}.csv.gz.
#
# Usage (from the worker/ dir):
#   npm run seed                      # all tiers
#   TIERS="recent forecast" npm run seed   # just the volatile ones (fast)
#
# Re-runnable: put is idempotent (overwrites). The archive tier is ~527 files so
# the full seed takes a few minutes (one wrangler call per object); seed only
# recent+forecast if you just need ensure-fresh to have something to merge into.
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
  echo "seeding $tier ($count files)..."
  i=0
  for f in "$dir"/*.csv.gz; do
    [ -e "$f" ] || continue
    key="$tier/$(basename "$f")"
    npx wrangler r2 object put "$BUCKET/$key" \
      --file "$f" \
      --content-type "text/csv; charset=utf-8" \
      --content-encoding "gzip" \
      --local >/dev/null
    i=$((i + 1))
    total=$((total + 1))
    if [ $((i % 25)) -eq 0 ]; then echo "  $tier: $i/$count"; fi
  done
  echo "  $tier: done ($i)"
done

echo "seeded $total objects into local R2 bucket '$BUCKET'."

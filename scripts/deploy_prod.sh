#!/usr/bin/env bash
# Deploy HowHotWasIt to production — Worker + frontend (Cloudflare Pages) — in one
# go. Encodes the exact steps from DEPLOY.md so you don't have to remember them.
#
#   bash scripts/deploy_prod.sh
#
# Needs: wrangler logged in (`cd worker && npx wrangler login`, opens a browser
# once) and Node 22 active (the project builds on 22).
set -euo pipefail
cd "$(dirname "$0")/.."            # repo root

# No VITE_API_BASE: the Worker is routed on the site's own origin at
# /api/* (a dashboard-managed route, see DEPLOY.md), so the frontend calls
# /api/* same-origin. Setting it would only pin the bundle to workers.dev.

node_major="$(node -v | sed 's/v\([0-9]*\).*/\1/')"
if [ "$node_major" != "22" ]; then
  echo "⚠  Node $(node -v) detected — this project builds on Node 22."
  echo "   If the build fails, switch with:  nvm use 22"
  echo
fi

echo "▶ 1/2  Deploying the Worker…"
( cd worker && npx wrangler deploy )

echo
echo "▶ 2/2  Building the frontend and deploying to Cloudflare Pages…"
( cd frontend && npm run build )
# pages deploy runs from the repo root so it picks up functions/ (link previews);
# `npm run build` writes to repo-root dist/ (vite outDir is ../dist).
npx wrangler pages deploy dist --project-name weather-baseline --branch main --commit-dirty=true

echo
echo "============================================================"
echo "✅ Deployed — Worker + frontend are live with metric capture."
echo "============================================================"
echo "Smoke-test: https://www.weatherbaseline.com — chart draws, console clean."
echo "            curl -s https://www.weatherbaseline.com/api/health   # JSON, not HTML"
echo "Then switch a metric and check the private /dashboard."
